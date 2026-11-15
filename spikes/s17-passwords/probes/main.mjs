// Spike S17 M0: Electron's half of the probes (questions 1-3, 5-7). Started by run.mjs, one
// probe per launch, on a virtual display only (the Linux container or CI), never a desktop.
//
//   electron main.mjs --probe=world|card|frames|preload --out=<json> --port=<n> --user-data=<dir> [...]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BaseWindow, ipcMain, session, WebContentsView } from 'electron';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const probe = arg('probe');
const out = arg('out');
const port = Number(arg('port'));
const here = import.meta.dirname;
const spike = join(here, '..');
const chordPreloads = join(spike, '..', '..', 'apps', 'desktop', 'out', 'preload');
const result = { probe, platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, ok: false, steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
  console.log(`[probe ${probe}] ${name}: ${JSON.stringify(value).slice(0, 400)}`);
};
const finish = (error) => {
  if (error) result.error = String(error?.stack ?? error);
  else result.ok = true;
  writeFileSync(out, JSON.stringify(result, null, 2));
  app.exit(error ? 1 : 0);
};
process.on('unhandledRejection', finish);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', arg('user-data'));
// Every *.test name is this machine, so login.test, other.test and adN.test are different sites.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');
const url = (path, host = 'login.test') => `http://${host}:${port}${path}`;

// ----- The agent, served to the preload over passwords:agent -----
const scan = readFileSync(join(spike, 'agent', 'scan.js'), 'utf8');
const agent = readFileSync(join(spike, 'agent', 'agent.js'), 'utf8');
const agentSource = `(function (chordPasswords) {\n${scan}\n${agent}\n})(globalThis.chordPasswords);`;
const events = [];
const on = (type, payload, e) => events.push({ type, payload, at: Date.now(), wc: e?.sender?.id, origin: e?.senderFrame?.origin, top: e?.senderFrame ? e.senderFrame === e.sender.mainFrame : null });
ipcMain.handle('passwords:agent', (e) => {
  on('agent-asked', null, e);
  return agentSource;
});
ipcMain.on('passwords:from-agent', (e, type, payload) => on(type, payload, e));
ipcMain.on('passwords:woke', (e, payload) => on('woke', payload, e));
ipcMain.on('passwords:preload-ran', (e, payload) => on('preload-ran', payload, e));
const waitFor = async (pred, ms = 5000, since = 0) => {
  const end = Date.now() + ms;
  for (;;) {
    const hit = events.slice(since).find(pred);
    if (hit) return hit;
    if (Date.now() > end) return null;
    await sleep(20);
  }
};
let nextId = 1;
const ask = async (wc, op, extra = {}) => {
  const id = nextId++;
  wc.send('passwords:to-agent', { id, op, ...extra });
  const hit = await waitFor((e) => e.type === 'reply' && e.payload.id === id, 5000);
  return hit ? hit.payload.result : { error: 'no reply' };
};
const load = (wc, target) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const done = () => resolve(performance.now() - t0);
    wc.once('did-finish-load', done);
    wc.loadURL(target).catch(() => {});
  });

function makeSession(name, { sentinel = true, chord = false, fat = false } = {}) {
  const ses = session.fromPartition(`persist:${name}`);
  if (chord) {
    // Chord's own, as built (preload/page.ts, and the extension library's preload), registered as main/index.ts does.
    ses.registerPreloadScript({ type: 'frame', id: 'chord-page', filePath: join(chordPreloads, 'page.cjs') });
    if (existsSync(join(chordPreloads, 'extensions.cjs'))) ses.registerPreloadScript({ type: 'frame', id: 'crx-mv2-preload', filePath: join(chordPreloads, 'extensions.cjs') });
  }
  if (sentinel) ses.registerPreloadScript({ type: 'frame', id: 'chord-s17-sentinel', filePath: fat ? arg('fat-preload') : join(here, 'preload.cjs') });
  return ses;
}
const pageView = (ses, extra = {}) => new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, ...extra } });

// ======================= Questions 1, 2 and 7 =======================
async function world() {
  const win = new BaseWindow({ width: 1200, height: 900, show: true, title: 'S17 world' });
  const ses = makeSession('s17-world', { chord: arg('chord') === '1' });
  const view = pageView(ses);
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 900 });
  const wc = view.webContents;
  const typeofs = '[typeof chordPasswords, typeof __chordAgent, typeof chordScan, typeof window.reactState]';

  // 1. The sign-in page: does the sentinel wake the agent in 4440, and who sees what?
  let mark = events.length;
  await load(wc, url('/login'));
  let woke = await waitFor((e) => e.type === 'woke', 3000, mark);
  if (!woke) {
    // React renders after DOMContentLoaded, so the password field may not be there yet: focus wakes it.
    await wc.executeJavaScript("document.getElementById('user').focus()");
    woke = await waitFor((e) => e.type === 'woke', 3000, mark);
  }
  const hello = await waitFor((e) => e.type === 'hello', 3000, mark);
  step('1-woke', woke && { ...woke.payload, origin: woke.origin, top: woke.top });
  step('1-hello', hello && { ...hello.payload, origin: hello.origin, top: hello.top });
  step('1-agent-sees', await ask(wc, 'whoami'));
  step('1-main-world-sees', await wc.executeJavaScript(typeofs));
  step('1-world-4400-sees', await wc.executeJavaScriptInIsolatedWorld(4400, [{ code: typeofs }]));
  step('1-world-999-sees', await wc.executeJavaScriptInIsolatedWorld(999, [{ code: typeofs }]));
  step('1-world-4440-sees', await wc.executeJavaScriptInIsolatedWorld(4440, [{ code: typeofs }]));
  step('1-scan', await ask(wc, 'scan'));

  // 2a. Fill the React-controlled form in the top frame, as §11.6 does.
  step('2-fill-top', await ask(wc, 'fill', { values: { user: 'ada@example.com', pass: 'spike-only-1' }, realm: 'mine' }));
  await sleep(100);
  // The page's own view (test fixture values only): matches, as booleans; no value is logged.
  step('2-top-page-saw', await wc.executeJavaScript("({ react: reactState.user === 'ada@example.com' && reactState.pass === 'spike-only-1', dom: document.getElementById('user').value === 'ada@example.com', events: seen.events.join(' ') })"));

  // 7. The page's requests, from the isolated world.
  for (const read of [false, true]) {
    await wc.executeJavaScript('pageSaw = []');
    await ask(wc, 'resources-clear');
    step(`7-page-got${read ? '-body-read' : ''}`, await wc.executeJavaScript(`tryRequests(${JSON.stringify(url('', 'other.test'))}, ${read})`));
    await sleep(1500);
    step(`7-agent-saw${read ? '-body-read' : ''}`, await ask(wc, 'resources'));
    step(`7-page-observer-saw${read ? '-body-read' : ''}`, await wc.executeJavaScript('pageSaw'));
    step(`7-agent-timeline${read ? '-body-read' : ''}`, await ask(wc, 'timeline'));
  }

  // 1b. A strict page: CSP with only 'self' scripts and Trusted Types.
  mark = events.length;
  await load(wc, url('/csp'));
  await wc.executeJavaScript("document.getElementById('user') && document.getElementById('user').focus()");
  step('1-csp-woke', (await waitFor((e) => e.type === 'woke', 3000, mark))?.payload ?? null);
  step('1-csp-agent', await ask(wc, 'whoami'));
  step('1-csp-fill', await ask(wc, 'fill', { values: { user: 'ada@example.com' }, realm: 'mine' }));
  step('1-csp-page-saw', await wc.executeJavaScript("reactState.user === 'ada@example.com'"));

  // 1c. A page with no sign-in field stays asleep; a focus on its email field wakes it.
  mark = events.length;
  await load(wc, url('/plain'));
  await sleep(1500);
  step('1-plain-asleep', !(await waitFor((e) => e.type === 'woke', 10, mark)));
  await wc.executeJavaScript("document.getElementById('q').focus()");
  await sleep(300);
  step('1-plain-search-focus-asleep', !(await waitFor((e) => e.type === 'woke', 10, mark)));
  await wc.executeJavaScript("document.getElementById('news').focus()");
  step('1-plain-email-focus-woke', (await waitFor((e) => e.type === 'woke', 3000, mark))?.payload?.why ?? null);

  // 1d. The feature off: unregister the sentinel at run time, then on again, no restart.
  ses.unregisterPreloadScript('chord-s17-sentinel');
  mark = events.length;
  await load(wc, url('/login'));
  await wc.executeJavaScript("document.getElementById('user').focus()");
  await sleep(1500);
  step('1-unregistered-asleep', !(await waitFor((e) => e.type === 'woke', 10, mark)));
  ses.registerPreloadScript({ type: 'frame', id: 'chord-s17-sentinel', filePath: join(here, 'preload.cjs') });
  mark = events.length;
  await load(wc, url('/login'));
  await wc.executeJavaScript("document.getElementById('user').focus()");
  step('1-reregistered-woke', !!(await waitFor((e) => e.type === 'woke', 3000, mark)));

  // 2b. Frames: same origin, srcdoc, another site, sandboxed without allow-same-origin.
  mark = events.length;
  await load(wc, url('/frames'));
  await sleep(800);
  const frameWoke = await waitFor((e) => e.type === 'woke', 2000, mark);
  step('2-frames-woke', frameWoke?.payload ?? null);
  if (frameWoke) {
    step('2-frames', await ask(wc, 'frames'));
    step('2-listen-frames', await ask(wc, 'listen-frames'));
    const inner = wc.mainFrame.frames.find((f) => f.url === url('/inner'));
    const innerSaw = () => inner.executeJavaScript("({ react: reactState.user === 'ada@example.com' && reactState.pass === 'spike-only-2', dom: document.getElementById('pass').value === 'spike-only-2', events: seen.events.join(' ') })");
    step('2-fill-same-mine', await ask(wc, 'fill', { frame: 'same', values: { user: 'ada@example.com', pass: 'spike-only-2' }, realm: 'mine' }));
    await sleep(100);
    step('2-same-page-saw-mine', await innerSaw());
    await inner.executeJavaScript("seen.events = []; document.getElementById('user').value = ''");
    step('2-fill-same-own', await ask(wc, 'fill', { frame: 'same', values: { user: 'ada@example.com', pass: 'spike-only-2' }, realm: 'own' }));
    await sleep(100);
    step('2-same-page-saw-own', await innerSaw());
    step('2-fill-cross', await ask(wc, 'fill', { frame: 'cross', values: { user: 'x' }, realm: 'mine' }));
    step('2-fill-sandboxed', await ask(wc, 'fill', { frame: 'sandboxed', values: { user: 'x' }, realm: 'mine' }));
    // Focus in the same-origin frame reaches the top frame's agent, with the field's place in the tab.
    mark = events.length;
    await inner.executeJavaScript("document.getElementById('user').focus()");
    const rect = await waitFor((e) => e.type === 'rect', 2000, mark);
    const truth = await wc.executeJavaScript("(() => { const f = document.getElementById('same'); const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop }; })()");
    const innerRect = await inner.executeJavaScript("(() => { const r = document.getElementById('user').getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
    step('2-frame-focus-rect', rect && { agent: rect.payload.rect, expected: { x: truth.x + innerRect.x, y: truth.y + innerRect.y } });
    // Does the preload (and so the agent) run in a frame of its own? Not without nodeIntegrationInSubFrames.
    step('2-agent-in-subframes', events.filter((e) => e.type === 'hello' && e.top === false).length);
  }
  win.close();
}

// ======================= Question 3 =======================
function xdo(...args) {
  return execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
}
async function card() {
  // The system pointer and keys come from xdotool, on X11 only (Wayland and CI's Windows and macOS runners skip them).
  const wayland = process.argv.includes('--wayland') || process.platform !== 'linux';
  const SIDEBAR = 240;
  const CARD = { width: 280, height: 120 };
  const win = new BaseWindow({ x: 0, y: 0, width: 1400, height: 900, frame: false, show: true, title: 'S17 card' });
  const ses = makeSession('s17-card');
  const sidebar = new WebContentsView();
  sidebar.setBackgroundColor('#334');
  const panes = [pageView(ses), pageView(ses)];
  const popover = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  popover.setBackgroundColor('#00000000');
  win.contentView.addChildView(sidebar);
  win.contentView.addChildView(panes[0]);
  let split = false;
  const layout = () => {
    const [w, h] = win.getContentSize();
    sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR, height: h });
    const n = split ? 2 : 1;
    const pw = Math.floor((w - SIDEBAR) / n);
    panes.forEach((p, i) => p.setBounds({ x: SIDEBAR + i * pw, y: 0, width: i < n ? pw : 0, height: i < n ? h : 0 }));
  };
  layout();
  win.on('resize', layout);
  win.contentView.addChildView(popover);
  popover.setVisible(false);
  await popover.webContents.loadURL(url('/card'));

  // Placing the card: the field's rect is in its page's CSS pixels; × zoom gives the view's pixels.
  let open = null;
  const placements = [];
  const place = (e) => {
    const pane = panes.find((p) => p.webContents.id === e.wc);
    if (!pane) return;
    const { rect } = e.payload;
    const z = pane.webContents.getZoomFactor();
    const b = pane.getBounds();
    const [w, h] = win.getContentSize();
    let x = Math.round(b.x + rect.x * z);
    let y = Math.round(b.y + (rect.y + rect.h) * z + 4);
    if (y + CARD.height > h) y = Math.round(b.y + rect.y * z - CARD.height - 4);
    x = Math.max(SIDEBAR, Math.min(x, w - CARD.width));
    popover.setBounds({ x, y, ...CARD });
    popover.setVisible(true);
    open = { pane, rect, z, index: 0 };
    placements.push({ why: e.payload.why, lagMs: Date.now() - e.payload.t, x, y });
  };
  let seen = events.length;
  const pump = setInterval(() => {
    for (; seen < events.length; seen++) {
      const e = events[seen];
      if (e.type === 'rect') place(e);
    }
  }, 4);

  // Keys while the card is open: main takes the four it needs; the page never sees them.
  const routed = [];
  for (const p of panes) {
    p.webContents.on('before-input-event', (event, input) => {
      if (!open || input.type !== 'keyDown') return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(input.key)) return;
      event.preventDefault();
      routed.push(input.key);
      if (input.key === 'ArrowDown') open.index = Math.min(2, open.index + 1);
      if (input.key === 'ArrowUp') open.index = Math.max(0, open.index - 1);
      void popover.webContents.executeJavaScript(`highlight(${open.index})`);
      if (input.key === 'Enter') void ask(p.webContents, 'fill', { values: { user: 'ada@example.com' }, realm: 'mine' });
      if (input.key === 'Enter' || input.key === 'Escape') {
        popover.setVisible(false);
        open = null;
      }
    });
  }

  const screenOf = (pane, cssX, cssY) => {
    const c = win.getContentBounds();
    const b = pane.getBounds();
    const z = pane.webContents.getZoomFactor();
    return [Math.round(c.x + b.x + cssX * z), Math.round(c.y + b.y + cssY * z)];
  };
  // Checks a placement with the system pointer: the field's centre lands on the field, and a point just under
  // its bottom-left corner lands on the card.
  const check = async (label, pane) => {
    const wc = pane.webContents;
    const mark = events.length;
    await ask(wc, 'report');
    const rectEvent = await waitFor((e) => e.type === 'rect' && e.wc === wc.id, 2000, mark);
    await sleep(60);
    const { rect } = rectEvent.payload;
    const out = { zoom: wc.getZoomFactor(), pane: pane.getBounds(), card: popover.getBounds(), rect };
    out.cardUnderField = Math.abs(out.card.x - Math.max(SIDEBAR, out.pane.x + rect.x * out.zoom)) <= 1 && Math.abs(out.card.y - (out.pane.y + (rect.y + rect.h) * out.zoom + 4)) <= 1;
    if (!wayland) {
      const [fx, fy] = screenOf(pane, rect.x + rect.w / 2, rect.y + rect.h / 2);
      xdo('mousemove', String(fx), String(fy), 'click', '1');
      await sleep(150);
      const clicks = await wc.executeJavaScript('seen.clicks.slice(-1)[0] || null');
      out.fieldClickHit = clicks?.id ?? null;
      const before = await popover.webContents.executeJavaScript('log.length');
      const [cx, cy] = screenOf(pane, rect.x + 10, rect.y + rect.h + 10);
      xdo('mousemove', String(cx), String(cy), 'mousedown', '1');
      await sleep(150);
      out.cardPointHit = (await popover.webContents.executeJavaScript(`log.slice(${before})`)).includes('mousedown');
      xdo('mouseup', '1');
      out.pageAfterCardPress = await wc.executeJavaScript("({ hasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.id, blurs: seen.blurs })");
      out.popoverFocused = popover.webContents.isFocused();
      // Back to the page for the next check.
      wc.focus();
      await wc.executeJavaScript("document.getElementById('user').focus()");
      await sleep(100);
    }
    step(`3-${label}`, out);
    return out;
  };

  const a = panes[0].webContents;
  await load(a, url('/login'));
  if (!wayland) {
    const id = xdo('search', '--sync', '--name', 'S17 card').split('\n')[0];
    xdo('windowactivate', '--sync', id);
  }
  a.focus();
  await a.executeJavaScript("document.getElementById('user').focus()");
  await waitFor((e) => e.type === 'hello', 3000);
  await check('initial', panes[0]);

  // Keys, with the card open and the field focused.
  if (!wayland) {
    await a.executeJavaScript("seen.keys = []; document.getElementById('user').focus()");
    await ask(a, 'report');
    await sleep(100);
    xdo('key', '--delay', '40', 'Down', 'Down', 'Up');
    await sleep(150);
    const highlighted = await popover.webContents.executeJavaScript("[...document.querySelectorAll('.row')].findIndex((r) => r.classList.contains('on'))");
    xdo('key', 'Return');
    await sleep(200);
    xdo('type', '--delay', '40', 'zz');
    await sleep(200);
    step('3-keys', {
      routedToMain: routed.slice(),
      highlighted,
      page: await a.executeJavaScript("({ keys: seen.keys.slice(), active: document.activeElement.id, hasFocus: document.hasFocus(), filledThenTyped: reactState.user === 'ada@example.comzz' })"),
      cardOpenAfterEnter: popover.getVisible?.() ?? null,
    });
  }
  // Electron's own synthetic keys: do they pass through before-input-event?
  await ask(a, 'report');
  await sleep(100);
  const routedBefore = routed.length;
  a.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  a.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await sleep(150);
  step('3-sendInputEvent-reaches-before-input-event', routed.length > routedBefore);
  if (open) {
    popover.setVisible(false);
    open = null;
  }

  // Zoom, scroll, window resize, split view.
  a.setZoomFactor(1.5);
  await sleep(300);
  await check('zoom-150', panes[0]);
  a.setZoomFactor(0.8);
  await sleep(300);
  await check('zoom-80', panes[0]);
  a.setZoomFactor(1);
  await a.executeJavaScript('window.scrollBy(0, 120)');
  await sleep(200);
  await check('scrolled', panes[0]);
  win.setContentSize(1100, 760);
  await sleep(400);
  await check('resized', panes[0]);
  split = true;
  win.contentView.addChildView(panes[1]);
  win.contentView.addChildView(popover); // back on top
  layout();
  await load(panes[1].webContents, url('/login'));
  panes[1].webContents.focus();
  await panes[1].webContents.executeJavaScript("document.getElementById('user').focus()");
  await sleep(300);
  await check('split-right', panes[1]);

  // Clicking the card takes focus from the page (each check above). Two ways to give it back:
  // 'refocus-later': main focuses the page again once the press is over; 'swallow': the card's
  // before-mouse-event takes the press in main (the card never gets it), then the page is focused.
  if (!wayland) {
    const b = panes[1].webContents;
    for (const variant of ['plain', 'refocus-later', 'swallow']) {
      const listeners = [];
      if (variant === 'refocus-later') {
        const f = () => setTimeout(() => b.focus(), 0);
        popover.webContents.on('focus', f);
        listeners.push(['focus', f]);
      }
      if (variant === 'swallow') {
        const f = (event, mouse) => {
          if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') {
            event.preventDefault();
            if (mouse.type === 'mouseUp') b.focus();
          }
        };
        popover.webContents.on('before-mouse-event', f);
        listeners.push(['before-mouse-event', f]);
      }
      b.focus();
      await b.executeJavaScript("document.getElementById('user').focus(); seen.blurs = 0; seen.focuses = 0");
      await ask(b, 'report');
      await sleep(150);
      const before = await popover.webContents.executeJavaScript('log.length');
      const c = popover.getBounds();
      const cb = win.getContentBounds();
      xdo('mousemove', String(cb.x + c.x + 40), String(cb.y + c.y + 20), 'click', '1');
      await sleep(300);
      step(`3-card-click-${variant}`, {
        page: await b.executeJavaScript("({ hasFocus: document.hasFocus(), active: document.activeElement.id, fieldBlurs: seen.blurs, fieldFocuses: seen.focuses })"),
        popoverFocused: popover.webContents.isFocused(),
        cardSaw: await popover.webContents.executeJavaScript(`log.slice(${before})`),
      });
      for (const [type, f] of listeners) popover.webContents.off(type, f);
    }
  }
  clearInterval(pump);
  step('3-placements', { count: placements.length, lagMs: placements.map((p) => p.lagMs), whys: placements.map((p) => p.why) });
  win.close();
}

// ======================= Question 5 =======================
function linuxMemory(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { privateKB: kb('RssAnon') + kb('VmSwap'), cpuTicks: Number(stat[11]) + Number(stat[12]) };
  } catch {
    return null;
  }
}
function memory() {
  return app.getAppMetrics().map((m) => {
    const linux = process.platform === 'linux' ? linuxMemory(m.pid) : null;
    return { pid: m.pid, type: m.type, privateKB: linux?.privateKB ?? m.memory.privateBytes ?? m.memory.workingSetSize, cpuTicks: linux?.cpuTicks ?? null, cpuSeconds: m.cpu?.cumulativeCPUUsage ?? null };
  });
}
async function collectGarbage(wc) {
  try {
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
    wc.debugger.detach();
  } catch {
    // Some builds refuse; the numbers are then without it.
  }
}
async function frames() {
  const subframes = arg('subframes') === '1';
  const ads = Number(arg('ads', 30));
  const loads = Number(arg('loads', 3));
  const win = new BaseWindow({ width: 1280, height: 900, show: true, title: 'S17 frames' });
  const ses = makeSession('s17-frames', { chord: true, sentinel: arg('sentinel', '1') === '1' });
  const view = pageView(ses, { nodeIntegrationInSubFrames: subframes, additionalArguments: arg('report') === '1' ? ['--chord-s17-report'] : [] });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  const wc = view.webContents;
  const times = [];
  for (let i = 0; i < loads; i++) times.push(await load(wc, url(`/news?ads=${ads}`, 'news.test')));
  await sleep(3000);
  const ran = events.filter((e) => e.type === 'preload-ran');
  step('5-condition', { subframes, ads, chordPreloads: existsSync(join(chordPreloads, 'page.cjs')) });
  step('5-load-ms', times);
  step('5-frames-in-tree', wc.mainFrame.framesInSubtree.length);
  step('5-preload-runs', { total: ran.length, subframe: ran.filter((e) => e.top === false).length, msSum: ran.reduce((a, e) => a + e.payload.ms, 0) });
  step('5-memory', memory());
  win.close();
}

// ======================= Question 6 =======================
async function preload() {
  const mode = arg('mode'); // none | chord | chord+sentinel | chord+fat
  const target = arg('url', '/plain');
  const win = new BaseWindow({ width: 1280, height: 900, show: true, title: 'S17 preload' });
  const ses = makeSession(`s17-preload`, { chord: mode !== 'none', sentinel: mode.includes('sentinel') || mode.includes('fat'), fat: mode.includes('fat') });
  const view = pageView(ses, { additionalArguments: ['--chord-s17-report'] });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  const wc = view.webContents;
  const times = [];
  for (let i = 0; i < Number(arg('loads', 20)); i++) times.push(await load(wc, url(target)));
  if (target === '/login') {
    await wc.executeJavaScript("document.getElementById('user').focus()");
    await waitFor((e) => e.type === 'hello', 3000);
  }
  await sleep(3000);
  await collectGarbage(wc);
  await sleep(500);
  const pid = wc.getOSProcessId();
  step('6-condition', { mode, target });
  step('6-load-ms', times);
  step('6-preload-ms', events.filter((e) => e.type === 'preload-ran').map((e) => e.payload.ms));
  step('6-woke', events.filter((e) => e.type === 'woke').map((e) => e.payload));
  step('6-page-memory', memory().find((m) => m.pid === pid));
  win.close();
}

app.whenReady().then(async () => {
  try {
    await { world, card, frames, preload }[probe]();
    finish();
  } catch (error) {
    finish(error);
  }
});
