// Spike S11, step 3: what each way of blocking costs Electron's main process
// while a heavy page loads. Runs in Electron (through run.mjs, on a virtual
// display in the Linux container; never on a desktop).
//
// Modes:
//   none           no blocking: the baseline.
//   engine-main    (a) Ghostery's engine in main, through session.webRequest.onBeforeRequest.
//   engine-worker  (a') the same listener, matching in a worker thread.
//   dnr            (b) the lists as declarativeNetRequest rules in an extension, matched by Chromium.
// Lifecycle phases of (b), each a launch of its own on one profile:
//   dnr-first      a fresh profile: are manifest rulesets on? enable them from the control page; sites turned off
//                  two ways (allowAllRequests, and allow with topDomains), checked from the page and from a frame.
//   dnr-relaunch   the same profile again: what loading the extension costs main, and whether everything is kept.
//   dnr-replaced   a list update in place: removed, rewritten, loaded and turned on again; then removed (blocking off).
//   dnr-newfolder  a list update as a new folder (a new extension ID): a fresh install.
//
// Never waits on anyone: errors are written as results and end the run; no window is ever shown.
import { app, BaseWindow, BrowserWindow, session, WebContentsView } from 'electron';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { fixtureRequests, pageUrl, startServer } from './fixture.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split(/=(.*)/s)));
const mode = args.mode ?? 'none';
const port = Number(args.port ?? 47411);
const loads = Number(args.loads ?? 15);
const warmup = Number(args.warmup ?? 3);
const busy = 'busy' in args;
const here = import.meta.dirname;
const build = join(here, 'results', 'build');
const results = { mode, busy, electron: process.versions.electron, chrome: process.versions.chrome, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString() };

let finished = false;
function finish(extra = {}, code = 0) {
  if (finished) return;
  finished = true;
  Object.assign(results, extra);
  writeFileSync(args.out, JSON.stringify(results, null, 2));
  app.exit(code);
}
const fatal = (kind) => (error) => finish({ ok: false, fatal: kind, error: String(error?.stack ?? error) }, 1);
process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));
setTimeout(() => finish({ ok: false, fatal: 'timeout' }, 1), 10 * 60_000).unref();
for (const method of ['show', 'showInactive', 'focus', 'maximize', 'setFullScreen']) {
  BaseWindow.prototype[method] = function () {};
  if (Object.hasOwn(BrowserWindow.prototype, method)) BrowserWindow.prototype[method] = function () {};
}

app.setPath('userData', args['user-data']);
// Every host is this machine: the fixture server answers for all of them.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1, EXCLUDE localhost');

const require = createRequire(join(here, '..', '..', 'apps', 'desktop', 'package.json'));
const { FiltersEngine, Request } = require('@ghostery/adblocker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (x, d = 3) => (x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d);
const cpuMs = (from) => {
  const now = process.threadCpuUsage();
  return from ? (now.user - from.user + now.system - from.system) / 1000 : now;
};

/** Main's own costs over a stretch of time: thread CPU, event-loop utilization and delay. */
function meter() {
  const cpu = process.threadCpuUsage();
  const elu = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const t = performance.now();
  return () => {
    delay.disable();
    const used = performance.eventLoopUtilization(elu);
    return {
      wallMs: round(performance.now() - t, 1),
      mainCpuMs: round(cpuMs(cpu), 1),
      elu: round(used.utilization, 3),
      delayP50Ms: round(delay.percentile(50) / 1e6, 2),
      delayP99Ms: round(delay.percentile(99) / 1e6, 2),
      delayMaxMs: round(delay.max / 1e6, 2),
    };
  };
}

/** Per-request time in the webRequest listener (ms), for the engine modes. */
const callbackTimes = [];
let callbackMark = 0;

async function engineInMain(ses) {
  const t0 = performance.now();
  const bytes = readFileSync(join(build, 'engine.bin'));
  const readMs = performance.now() - t0;
  const t1 = performance.now();
  const engine = FiltersEngine.deserialize(bytes);
  results.startup = { readMs: round(readMs, 2), deserializeMs: round(performance.now() - t1, 2), engineBytes: bytes.length };
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const t = performance.now();
    const { match } = engine.match(Request.fromRawDetails({ url: details.url, sourceUrl: details.referrer, type: details.resourceType }));
    callbackTimes.push(performance.now() - t);
    callback(match ? { cancel: true } : {});
  });
}

async function engineInWorker(ses) {
  const t0 = performance.now();
  const cpu = cpuMs();
  const worker = new Worker(join(here, 'worker.mjs'), { workerData: { engine: join(build, 'engine.bin') } });
  const ready = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  results.startup = { readyMs: round(performance.now() - t0, 1), workerDeserializeMs: round(ready.deserializeMs, 2), mainCpuMs: round(cpuMs(cpu), 1) };
  const waiting = new Map();
  let nextId = 1;
  worker.on('message', ({ id, match }) => {
    const callback = waiting.get(id);
    waiting.delete(id);
    callback?.(match ? { cancel: true } : {});
  });
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const t = performance.now();
    const id = nextId++;
    waiting.set(id, callback);
    worker.postMessage({ id, url: details.url, sourceUrl: details.referrer, type: details.resourceType });
    callbackTimes.push(performance.now() - t);
  });
}

/**
 * A page on the session that asks for a listed address: 'loaded' when the
 * server saw the request, 'blocked' when it didn't (a failed fetch alone
 * could be anything).
 */
async function makeProbe(ses, host = 'probe.s11.test') {
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await view.webContents.loadURL(`http://${host}:${port}/probe`);
  let n = 0;
  const check = async (target, url) => {
    const token = `${url}?probe=${++n}-${Math.random().toString(36).slice(2)}`;
    await target.executeJavaScript(`fetch(${JSON.stringify(token)}, { mode: 'no-cors', cache: 'no-store' }).then(() => 'loaded', () => 'failed')`);
    await sleep(30);
    return server.state.paths.has(token.replace(/^http:\/\//, '').replace(`:${port}`, '')) ? 'loaded' : 'blocked';
  };
  return {
    check: (url = `http://securepubads.g.doubleclick.net:${port}/tag/js/gpt.js`) => check(view.webContents, url),
    /** The same, from inside a third-party iframe on the page. */
    checkInFrame: async (url = `http://securepubads.g.doubleclick.net:${port}/tag/js/gpt.js`) => {
      await view.webContents.executeJavaScript(
        `new Promise((done) => { const f = document.createElement('iframe'); f.src = 'http://frame.s11-other.test:${port}/probe'; f.onload = done; document.body.appendChild(f); })`,
      );
      const frame = view.webContents.mainFrame.frames.find((f) => f.url.includes('s11-other.test'));
      return frame ? check(frame, url) : 'no frame';
    },
    close: () => view.webContents.close(),
  };
}

/** How long until a probe comes back blocked (null if it never does within the limit). */
async function untilBlocked(probe, url, limitMs = 15_000) {
  const t = performance.now();
  while (performance.now() - t < limitMs) {
    if ((await probe.check(url)) === 'blocked') return round(performance.now() - t, 1);
    await sleep(20);
  }
  return null;
}

/** The blocker's control page: an extension page main runs declarativeNetRequest calls in. No preload, no IPC. */
async function control(ses, extensionId, code) {
  const t = performance.now();
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  await view.webContents.loadURL(`chrome-extension://${extensionId}/control.html`);
  const opened = performance.now() - t;
  const result = await view.webContents.executeJavaScript(code);
  view.webContents.close();
  return { result, openMs: round(opened, 1), totalMs: round(performance.now() - t, 1) };
}

const ENABLE = `chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['easylist', 'easyprivacy'] }).then(() => chrome.declarativeNetRequest.getEnabledRulesets())`;
const ENABLED = `chrome.declarativeNetRequest.getEnabledRulesets()`;
const DYNAMIC = `chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.map((r) => r.id))`;

async function loadBlocker(ses, name = 'blocker') {
  const folder = join(args['user-data'], name);
  if (!existsSync(folder)) cpSync(join(build, 'extension'), folder, { recursive: true });
  const t = performance.now();
  const ext = await ses.extensions.loadExtension(folder, { allowFileAccess: false });
  return { ext, loadMs: round(performance.now() - t, 1) };
}

/** Add one block rule for a new host to a copy's easyprivacy ruleset, as a list update would change it. */
function addRule(folder, host) {
  const file = join(folder, 'rules', 'easyprivacy.json');
  const rules = JSON.parse(readFileSync(file, 'utf8'));
  rules.push({ id: rules.length + 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: [host] } });
  writeFileSync(file, JSON.stringify(rules));
}

async function dnr(ses) {
  const m = meter();
  const { ext, loadMs } = await loadBlocker(ses);
  const probe = await makeProbe(ses);
  const activeAfterLoadMs = await untilBlocked(probe, undefined, 5000);
  results.startup = { loadMs, activeAfterLoadMs, main: m() };
  if (activeAfterLoadMs === null) {
    // Not on by themselves: turned on from the control page, as S9 found Electron needs.
    const m2 = meter();
    results.startup.enable = await control(ses, ext.id, ENABLE);
    results.startup.activeAfterEnableMs = await untilBlocked(probe);
    results.startup.enableMain = m2();
  }
  probe.close();
}

/**
 * The lifecycle phases of (b): what a first launch, a relaunch, a list update
 * and turning blocking off and on do to the rules. The probe pages load after
 * the extension does, so allowAllRequests rules apply to them.
 */
async function lifecycle(ses) {
  const out = {};
  const AD = `http://securepubads.g.doubleclick.net:${port}/tag/js/gpt.js`;
  const NEW = `http://brand-new-tracker.s11.test:${port}/t.js`;
  // Two ways to turn a site off: allowAllRequests on its pages (what Chrome would use), and
  // allow rules on requests whose top-level frame is the site (topDomains).
  const SITE_OFF = `chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2], addRules: [
    { id: 1, priority: 4, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['off.s11.test'], resourceTypes: ['main_frame'] } },
    { id: 2, priority: 4, action: { type: 'allow' }, condition: { topDomains: ['off2.s11.test'] } },
  ] }).then(() => 'ok', (e) => String(e))`;
  /** Is blocking on (an ad is blocked on one site) and off on the sites turned off (it loads there)? */
  const state = async () => {
    const on = await makeProbe(ses, 'probe.s11.test');
    const off = await makeProbe(ses, 'off.s11.test');
    const off2 = await makeProbe(ses, 'off2.s11.test');
    const result = {
      ad: await on.check(AD),
      newHost: await on.check(NEW),
      adInFrame: await on.checkInFrame(AD),
      allowAllRequestsSite: await off.check(AD),
      allowAllRequestsSiteFrame: await off.checkInFrame(AD),
      topDomainsSite: await off2.check(AD),
      topDomainsSiteFrame: await off2.checkInFrame(AD),
    };
    on.close();
    off.close();
    off2.close();
    return result;
  };
  if (mode === 'dnr-first') {
    const { ext, loadMs } = await loadBlocker(ses);
    const probe = await makeProbe(ses);
    out.loadMs = loadMs;
    out.activeAfterLoadMs = await untilBlocked(probe, AD, 3000);
    out.enabledAtLoad = (await control(ses, ext.id, ENABLED)).result;
    const m = meter();
    out.enable = await control(ses, ext.id, ENABLE);
    out.activeAfterEnableMs = await untilBlocked(probe, AD, 15_000);
    out.enableMain = m();
    probe.close();
    const m2 = meter();
    out.siteOff = await control(ses, ext.id, SITE_OFF);
    out.siteOffMain = m2();
    out.state = await state();
  } else if (mode === 'dnr-relaunch') {
    // Main's cost of loading the extension and its indexed rules, with nothing else going on:
    // 800 ms idle first, then 800 ms from loadExtension.
    const idle = meter();
    await sleep(800);
    out.idleMain = idle();
    const m = meter();
    const { ext, loadMs } = await loadBlocker(ses);
    await sleep(800 - loadMs);
    out.loadMain = m();
    out.loadMs = loadMs;
    const probe = await makeProbe(ses);
    out.activeAfter800Ms = (await probe.check(AD)) === 'blocked';
    probe.close();
    out.state = await state();
    out.enabled = (await control(ses, ext.id, ENABLED)).result;
    out.dynamicRules = (await control(ses, ext.id, DYNAMIC)).result;
  } else if (mode === 'dnr-replaced') {
    // A list update: the extension removed, new rules written in place (one more host blocked),
    // the old index deleted, loaded again, and the rulesets turned on from the control page.
    // (Turning them off and on while loaded fails: Chromium checks the new files against the old checksums.)
    const folder = join(args['user-data'], 'blocker');
    const loaded = await loadBlocker(ses);
    await sleep(800);
    out.before = await state();
    const m = meter();
    const t = performance.now();
    ses.extensions.removeExtension(loaded.ext.id);
    addRule(folder, 'brand-new-tracker.s11.test');
    rmSync(join(folder, '_metadata'), { recursive: true, force: true });
    const again = await loadBlocker(ses);
    out.enabledAfterReload = (await control(ses, again.ext.id, ENABLED)).result;
    out.enable = await control(ses, again.ext.id, ENABLE);
    const probe = await makeProbe(ses);
    out.newRuleActiveAfterMs = await untilBlocked(probe, NEW, 10_000);
    out.updateTookMs = round(performance.now() - t, 1);
    out.updateMain = m();
    probe.close();
    out.afterUpdate = await state();
    // Turning blocking off by removing the extension: nothing is blocked at once.
    ses.extensions.removeExtension(again.ext.id);
    out.afterRemove = await state();
  } else if (mode === 'dnr-newfolder') {
    // A list update as a new folder (a new extension ID): a fresh install.
    cpSync(join(build, 'extension'), join(args['user-data'], 'blocker-2'), { recursive: true });
    addRule(join(args['user-data'], 'blocker-2'), 'brand-new-tracker.s11.test');
    const m = meter();
    const { ext, loadMs } = await loadBlocker(ses, 'blocker-2');
    const probe = await makeProbe(ses);
    out.loadMs = loadMs;
    out.newRuleActiveAfterLoadMs = await untilBlocked(probe, NEW, 15_000);
    out.loadMain = m();
    probe.close();
    out.state = await state();
    out.dynamicRules = (await control(ses, ext.id, DYNAMIC)).result;
  }
  return out;
}

async function measureLoads(ses) {
  const win = new BaseWindow({ show: false, width: 1280, height: 900 });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  const contents = view.webContents;
  const runs = [];
  let busyTimer;
  if (busy) {
    // Main kept busy 20 ms of every 50, as if it were laying out or animating.
    busyTimer = setInterval(() => {
      const end = performance.now() + 20;
      while (performance.now() < end);
    }, 50);
  }
  for (let i = 0; i < warmup + loads; i++) {
    await contents.loadURL('about:blank');
    await sleep(300);
    const before = server.state.hits;
    const firstHosts = i === 0 ? new Map() : null;
    if (firstHosts) server.state.hosts = firstHosts;
    callbackMark = callbackTimes.length;
    const m = meter();
    const t = performance.now();
    let loadedAt = null;
    contents.once('did-finish-load', () => (loadedAt = performance.now()));
    contents.loadURL(`${pageUrl(port)}?n=${i}`).catch(() => {});
    while (loadedAt === null && performance.now() - t < 30_000) await sleep(10);
    while (performance.now() - server.state.lastHitAt < 600 && performance.now() - t < 30_000) await sleep(20);
    const settledAt = Math.max(server.state.lastHitAt, loadedAt ?? 0);
    const main = m();
    const callbacks = callbackTimes.slice(callbackMark);
    const run = {
      loadMs: round(loadedAt - t, 1),
      settledMs: round(settledAt - t, 1),
      requestsServed: server.state.hits - before,
      ...main,
      callbacks: callbacks.length,
      callbackTotalMs: round(sum(callbacks), 2),
      callbackP50Us: round((pct(callbacks, 50) ?? 0) * 1000, 1),
      callbackP99Us: round((pct(callbacks, 99) ?? 0) * 1000, 1),
      callbackMaxUs: round((callbacks.length ? Math.max(...callbacks) : 0) * 1000, 1),
    };
    if (i === 0) results.firstLoad = { ...run, hostsServed: Object.fromEntries(firstHosts) };
    if (i >= warmup) runs.push(run);
  }
  clearInterval(busyTimer);
  const stat = (key) => ({ p50: round(pct(runs.map((r) => r[key]), 50), 2), p90: round(pct(runs.map((r) => r[key]), 90), 2) });
  results.loads = {
    count: runs.length,
    ...Object.fromEntries(['loadMs', 'settledMs', 'requestsServed', 'mainCpuMs', 'elu', 'delayP50Ms', 'delayP99Ms', 'delayMaxMs', 'callbacks', 'callbackTotalMs', 'callbackP50Us', 'callbackP99Us', 'callbackMaxUs'].map((k) => [k, stat(k)])),
    runs,
  };
  const metrics = app.getAppMetrics();
  const byType = {};
  for (const p of metrics) byType[p.type] = (byType[p.type] ?? 0) + p.memory.workingSetSize;
  const mem = process.memoryUsage();
  results.memory = {
    mainRssMB: round(mem.rss / 2 ** 20, 1),
    mainHeapUsedMB: round(mem.heapUsed / 2 ** 20, 1),
    mainExternalMB: round(mem.external / 2 ** 20, 1),
    workingSetMBByProcessType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, round(v / 1024, 1)])),
  };
  win.destroy();
}

let server;
app.whenReady().then(async () => {
  server = await startServer(port);
  const ses = session.fromPartition('persist:s11');
  results.fixtureRequests = fixtureRequests(port).length;
  if (mode.startsWith('dnr-')) {
    results.lifecycle = await lifecycle(ses);
    return finish({ ok: true });
  }
  if (mode === 'engine-main') await engineInMain(ses);
  else if (mode === 'engine-worker') await engineInWorker(ses);
  else if (mode === 'dnr') await dnr(ses);
  await measureLoads(ses);
  finish({ ok: true });
});
