// The Widevine player prototype, run on castLabs ECS. Two modes:
//
//   --mode probe --out <dir> --profile <dir> [--quick] [--cdm-timeout ms]
//     Installs the CDM (components.whenReady), asks EME what Widevine offers,
//     plays Shaka's Widevine test streams, tries picture-in-picture and
//     fullscreen, takes captures and measures memory and CPU. Writes probe.json.
//
//   --mode serve --profile <dir> --out <dir>
//     What Chord would run: reads {path, secret} from stdin, connects to the
//     host's control channel, and does what it's told (open a window in one of
//     the three styles, navigate, follow bounds, play, pause, …). Its pages are
//     locked to the services (shared/allowlist.mjs); everything else goes back
//     to the host as an `open` message.
import '../shared/guard.mjs';
import { deadline } from '../shared/guard.mjs';
import electron from 'electron';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLock, testLock } from '../shared/allowlist.mjs';
import { hostRectReader } from '../shared/follow.mjs';
import { connect, now, readLaunchLine } from '../shared/channel.mjs';
import { chromiumUserAgent } from '../shared/user-agent.mjs';

const { app, BaseWindow, BrowserWindow, WebContentsView, nativeImage, screen, session } = electron;
const components = electron.components; // ECS only
const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const opt = (name, fallback = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const flag = (name) => argv.includes(`--${name}`);
const mode = opt('mode', 'probe');
const out = opt('out', join(process.cwd(), 'player-out'));
const profile = opt('profile');
if (profile) app.setPath('userData', profile);
mkdirSync(out, { recursive: true });
deadline(Number(opt('timeout', '600000')), `player ${mode}`);
const started = now();
// Read (and removed from the environment) before Chromium starts any child process.
const launchLine = mode === 'serve' ? readLaunchLine() : null;
const log = (...a) => console.log(`[player ${mode}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;
const safe = (fn) => {
  try {
    return fn();
  } catch (error) {
    return `error: ${error.message}`;
  }
};
const once = (emitter, event, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    emitter.once(event, () => (clearTimeout(timer), resolve(true)));
  });

const ANGEL = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd';
const SINTEL = 'https://storage.googleapis.com/shaka-demo-assets/sintel-widevine/dash.mpd';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

/** The test pages, from 127.0.0.1 (a secure context, as EME needs). */
function servePages(dir) {
  const server = createServer((req, res) => {
    const { pathname: path, searchParams } = new URL(req.url, 'http://x');
    // The navigation-lock tests: a server redirect and a meta refresh, to wherever ?to= says.
    if (path === '/redirect') {
      res.writeHead(302, { location: searchParams.get('to') ?? '/' });
      return res.end();
    }
    if (path === '/meta') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(`<!doctype html><meta http-equiv="refresh" content="0; url=${encodeURI(searchParams.get('to') ?? '/')}">`);
    }
    const file = normalize(join(dir, path === '/' ? 'probe.html' : path.slice(1)));
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) total += e.isDirectory() ? dirSize(join(dir, e.name)) : e.isFile() ? statSync(join(dir, e.name)).size : 0;
  return total;
}

/** Where the component updater put the CDM, and how big it is. */
function findCdm(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (/widevine/i.test(e.name)) found.push({ path: path.slice(root.length), bytes: dirSize(path), versions: readdirSync(path).filter((n) => /^\d/.test(n)) });
      else walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Linux: a process's proportional set size (shared pages split between their users), which sums correctly. */
function pssMB(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/**
 * Memory and CPU of every process of this app over `seconds`. CPU is from each process's
 * cumulative CPU time (percent of one core); memory is the working set (RSS), private bytes
 * on Windows and PSS on Linux.
 */
async function measure(seconds) {
  const a = app.getAppMetrics();
  const ta = now();
  await sleep(seconds * 1000);
  const b = app.getAppMetrics();
  const elapsed = (now() - ta) / 1000;
  const before = new Map(a.map((p) => [p.pid, p.cpu.cumulativeCPUUsage]));
  const list = b.map((p) => {
    const c0 = before.get(p.pid);
    const cpu = c0 != null && p.cpu.cumulativeCPUUsage != null ? ((p.cpu.cumulativeCPUUsage - c0) / elapsed) * 100 : null;
    return { type: p.type, name: p.serviceName ?? p.name ?? null, cpu: cpu == null ? null : round(cpu), wsMB: round(p.memory.workingSetSize / 1024), privateMB: p.memory.privateBytes ? round(p.memory.privateBytes / 1024) : null, pssMB: pssMB(p.pid) };
  });
  const sum = (k) => round(list.reduce((s, p) => s + (p[k] ?? 0), 0));
  return { seconds: round(elapsed), processes: list, totalCpu: sum('cpu'), totalWsMB: sum('wsMB'), totalPrivateMB: sum('privateMB'), totalPssMB: sum('pssMB') };
}

/** A capture of a WebContents, and how dark its middle is (DRM video may capture as black). */
async function capture(contents, name) {
  const image = await contents.capturePage();
  writeFileSync(join(out, name), image.toPNG());
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(height * 0.3); y < height * 0.7; y += 4)
    for (let x = Math.floor(width * 0.3); x < width * 0.7; x += 4) {
      const i = (y * width + x) * 4;
      sum += (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      n++;
    }
  return { file: name, width, height, middleMeanLuma: n ? round(sum / n) : null };
}

async function probe() {
  const result = { mode, platform: process.platform, arch: process.arch, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, argv: argv.slice(2) };
  app.userAgentFallback = chromiumUserAgent(app.userAgentFallback, app.getName());
  await app.whenReady();
  result.appReadyMs = round(now() - started);
  result.hasComponentsApi = Boolean(components);
  if (components) {
    result.componentsBefore = safe(() => components.status());
    result.updatesEnabled = safe(() => components.updatesEnabled);
    const timeout = Number(opt('cdm-timeout', '90000'));
    const t = now();
    const outcome = await Promise.race([
      components.whenReady().then(
        () => 'ready',
        (e) => `rejected: ${e?.message ?? e}`,
      ),
      sleep(timeout).then(() => `timeout after ${timeout} ms`),
    ]);
    result.cdm = { outcome, ms: round(now() - t), status: safe(() => components.status()) };
  }
  result.cdmFiles = findCdm(app.getPath('userData'));
  log('cdm', JSON.stringify(result.cdm));

  const base = await servePages(join(here, 'page'));
  const win = new BrowserWindow({ width: 960, height: 540, useContentSize: true, backgroundColor: '#000000', show: true, title: 'Widevine probe', webPreferences: { sandbox: true, contextIsolation: true } });
  result.permissionsAsked = [];
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    result.permissionsAsked.push(permission);
    callback(true);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', JSON.stringify(d)));
  await win.loadURL(`${base}/probe.html`);
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  result.shakaLoaded = await js('typeof shaka !== "undefined" && shaka.Player.version');
  result.eme = await js('probe.eme()');
  log('eme', JSON.stringify(result.eme.robustness.avc1));
  const write = () => writeFileSync(join(out, 'probe.json'), JSON.stringify(result, null, 2));

  result.angel = await js(`probe.play(${JSON.stringify(ANGEL)}, { seconds: 6, title: 'Angel One' })`);
  log('angel', result.angel.ok, result.angel.videoWidth, result.angel.videoHeight, result.angel.errors.join('; '));
  result.angel.capture = await capture(win.webContents, 'angel-one.png');
  write();
  if (flag('quick')) {
    // --linger: stay open, idle, so a net log shows what the component updater does later on its own.
    if (opt('linger')) await sleep(Number(opt('linger')) * 1000);
    return finish(result, write);
  }

  result.pip = await js('probe.pip()', true);
  log('pip', JSON.stringify(result.pip));

  const entered = once(win, 'enter-html-full-screen', 8000);
  result.fullscreen = await js('probe.fullscreen()', true);
  result.fullscreen.event = await entered;
  await sleep(1500);
  result.fullscreen.windowFullScreen = win.isFullScreen();
  result.fullscreen.bounds = win.getBounds();
  result.fullscreen.display = screen.getDisplayMatching(win.getBounds()).bounds;
  result.fullscreen.capture = await capture(win.webContents, 'fullscreen.png');
  const left = once(win, 'leave-html-full-screen', 8000);
  await js('document.exitFullscreen().then(() => true, (e) => e.name)', true);
  result.fullscreen.left = await left;
  await sleep(1500);
  log('fullscreen', JSON.stringify(result.fullscreen));

  // Idle: the page open, its video paused.
  await js('document.querySelector("video").pause()');
  await sleep(3000);
  result.metricsIdle = await measure(10);
  write();

  result.sintel = {};
  for (const [label, pick] of [
    ['avc 1280', { width: 1280, codec: 'avc1' }],
    ['avc 1920', { width: 1920, codec: 'avc1' }],
    ['avc 3840', { width: 3840, codec: 'avc1' }],
    ['vp9 1920', { width: 1920, codec: 'vp9' }],
    ['vp9 3840', { width: 3840, codec: 'vp9' }],
  ]) {
    result.sintel[label] = await js(`probe.play(${JSON.stringify(SINTEL)}, { seconds: 6, pick: ${JSON.stringify(pick)}, title: 'Sintel' })`);
    log('sintel', label, result.sintel[label].ok, result.sintel[label].videoWidth, result.sintel[label].videoHeight, (result.sintel[label].errors ?? []).join('; '));
    if (label === 'avc 1920') {
      result.sintel[label].capture = await capture(win.webContents, 'sintel-1080.png');
      result.metricsPlaying1080 = await measure(10);
      result.sintel[label].after = await js('probe.state()');
    }
    write();
  }
  result.cdmFilesAfter = findCdm(app.getPath('userData'));
  return finish(result, write);
}

function finish(result, write) {
  result.totalMs = round(now() - started);
  write();
  log('done');
  setTimeout(() => app.exit(0), 200);
}

// ---------------------------------------------------------------- serve mode

/** Keys Chord owns even while the player has focus; they're sent to Chord instead of the page. */
const FORWARD = new Set(['t', 'w', 'n', 'l', 'k', 'e', 's', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', 'tab']);

function applyLock(ses, lock, handoff, blocked) {
  // The backstop: anything that still reaches the network. A page cancelled here shows an
  // error page, so the navigation events below stop pages first, leaving the service's page as it was.
  ses.webRequest.onBeforeRequest((d, done) => {
    if (d.resourceType === 'mainFrame') {
      if (lock.page(d.url)) return done({});
      handoff(d.url, 'navigation (network)');
      return done({ cancel: true });
    }
    if (d.resourceType === 'subFrame') {
      if (lock.frame(d.url)) return done({});
      blocked.push({ url: d.url, why: 'frame' });
      return done({ cancel: true });
    }
    done({});
  });
  const allowed = new Set(['mediaKeySystem', 'fullscreen', 'pointerLock']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'openExternal') {
      handoff(details.externalURL ?? '', 'external');
      return callback(false);
    }
    callback(allowed.has(permission) && lock.page(details.requestingUrl ?? wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && lock.page(origin));
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    handoff(item.getURL(), 'download');
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    // Links, forms, scripts and meta refreshes (will-navigate), and server redirects (will-redirect).
    const stop = (event, why) => {
      if (lock.page(event.url)) return;
      event.preventDefault();
      handoff(event.url, why);
    };
    contents.on('will-navigate', (event) => stop(event, 'navigation'));
    contents.on('will-redirect', (event) => event.isMainFrame && stop(event, 'redirect'));
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || lock.frame(event.url)) return;
      event.preventDefault();
      blocked.push({ url: event.url, why: 'frame' });
    });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (lock.page(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, webPreferences: { session: ses, sandbox: true, contextIsolation: true } } };
      handoff(url, `popup (${disposition})`);
      return { action: 'deny' };
    });
  });
}

async function serve() {
  const launch = await launchLine;
  app.userAgentFallback = chromiumUserAgent(app.userAgentFallback, app.getName());
  await app.whenReady();
  const tReady = now();
  const peer = await connect({ path: launch.path }, launch.secret);
  log('connected');
  if (components && !launch.skipCdm) await Promise.race([components.whenReady().catch(() => {}), sleep(60_000)]);
  const lock = launch.test ? testLock(launch.test.pages, launch.test.frames) : makeLock();
  const handoffs = [];
  const blocked = [];
  const handoff = (url, why) => {
    handoffs.push({ url, why });
    peer.send('open', { url, why, at: now() });
  };
  const ses = session.fromPartition('persist:player');
  // No spellcheck dictionaries from Google's CDN (ECS downloads one on first use otherwise).
  ses.setSpellCheckerEnabled(false);
  applyLock(ses, lock, handoff, blocked);
  const base = await servePages(join(here, 'page'));

  let win = null; // BrowserWindow, or BaseWindow in the frameless style
  let content = null; // the webContents showing the service
  let bar = null; // the frameless style's own top bar
  let fullScreen = false;
  const js = (code, gesture = false) => content.executeJavaScript(code, gesture);

  peer.handle('window', async ({ style, bounds, panel, activation, appUserModelId }) => {
    if (activation && process.platform === 'darwin') app.setActivationPolicy(activation);
    if (appUserModelId && process.platform === 'win32') app.setAppUserModelId(appUserModelId);
    const webPreferences = { session: ses, sandbox: true, contextIsolation: true };
    if (style === 'frameless') {
      // (a) A window of its own, styled like Chord: Chord's bar on top, the service below.
      win = new BaseWindow({ ...bounds, frame: false, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 }, backgroundColor: '#f3eefe', title: 'Netflix · Chord', show: false });
      bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      const view = new WebContentsView({ webPreferences });
      win.contentView.addChildView(bar);
      win.contentView.addChildView(view);
      const layout = () => {
        const { width, height } = win.getContentBounds();
        bar.setBounds({ x: 0, y: 0, width, height: 40 });
        view.setBounds({ x: 6, y: 40, width: width - 12, height: height - 46 });
      };
      layout();
      win.on('resize', layout);
      await bar.webContents.loadURL(`${base}/bar.html`);
      content = view.webContents;
      win.show();
    } else {
      // (b) glued over Chord's content area, or (c) about to become its child window: no frame, no taskbar entry.
      win = new BrowserWindow({
        ...bounds,
        frame: false,
        show: false,
        skipTaskbar: true,
        // Resizable, or X11 window managers won't let a fullscreen request fill the screen (frameless with no thick frame: no edges to drag).
        resizable: true,
        movable: false,
        minimizable: false,
        maximizable: false,
        hasShadow: false,
        roundedCorners: false,
        thickFrame: false,
        backgroundColor: '#000000',
        ...(panel ? { type: 'panel' } : {}),
        webPreferences,
      });
      content = win.webContents;
      // A panel shows on every Space and floats; take both back, keep the non-activating part.
      if (panel === 'reset') {
        win.setVisibleOnAllWorkspaces(false);
        win.setAlwaysOnTop(false);
      }
      win.showInactive();
    }
    content.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      if (!FORWARD.has(input.key.toLowerCase())) return;
      event.preventDefault();
      peer.send('key', { key: input.key, control: input.control, meta: input.meta, shift: input.shift, alt: input.alt, at: now() });
    });
    const media = async () => {
      const state = await js('window.probe ? probe.state() : { title: document.title }').catch(() => null);
      peer.send('media', { ...state, at: now() });
    };
    content.on('media-started-playing', media);
    content.on('media-paused', media);
    content.on('enter-html-full-screen', () => {
      fullScreen = true;
      peer.send('fullscreen', { on: true, at: now() });
    });
    content.on('leave-html-full-screen', () => {
      fullScreen = false;
      peer.send('fullscreen', { on: false, at: now() });
    });
    win.on('focus', () => peer.send('focus', { focused: true, at: now() }));
    win.on('blur', () => peer.send('focus', { focused: false, at: now() }));
    return { readyMs: round(tReady - started), pid: process.pid };
  });

  peer.handle('navigate', async ({ url, local }) => {
    const target = local ? `${base}/${local}` : url;
    if (!local && !lock.page(target)) {
      handoff(target, 'navigate');
      return { ok: false };
    }
    await content.loadURL(target).catch((e) => log('load', e.code ?? e.message));
    return { ok: true, url: content.getURL() };
  });

  // Glue: follow the host's content area. Ignored while the page is fullscreen.
  peer.handle('bounds', ({ seq, x, y, width, height, visible }) => {
    const tGot = now();
    if (!fullScreen) {
      if (visible === false) win.hide();
      else {
        win.setBounds({ x, y, width, height });
        if (!win.isVisible()) win.showInactive();
      }
    }
    return { seq, tGot, tApplied: now() };
  });
  // Glue by polling the host's rectangle from the OS (shared/follow.mjs), every intervalMs.
  let follower = null;
  peer.handle('follow', ({ handle, area, koffiPath, intervalMs = 8 }) => {
    const read = hostRectReader(koffiPath, handle);
    const first = read?.();
    if (!first) return { ok: false };
    const toDip = (r) => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r);
    const r0 = toDip(first);
    const d = { x: area.x - r0.x, y: area.y - r0.y, w: area.width - r0.width, h: area.height - r0.height };
    let last = '';
    let reads = 0;
    let moves = 0;
    clearInterval(follower);
    follower = setInterval(() => {
      if (fullScreen || !win.isVisible()) return;
      const raw = read();
      reads++;
      if (!raw) return;
      const key = `${raw.x},${raw.y},${raw.width},${raw.height}`;
      if (key === last) return;
      last = key;
      const r = toDip(raw);
      win.setBounds({ x: Math.round(r.x + d.x), y: Math.round(r.y + d.y), width: Math.round(r.width + d.w), height: Math.round(r.height + d.h) });
      moves++;
    }, intervalMs);
    peer.handle('follow-stats', () => ({ reads, moves }));
    return { ok: true, offset: d };
  });
  peer.handle('above', ({ mediaSourceId }) => {
    win.moveAbove(mediaSourceId);
    return true;
  });
  peer.handle('handles', () => ({ native: win.getNativeWindowHandle().toString('hex'), mediaSourceId: win.getMediaSourceId(), pid: process.pid }));
  peer.handle('focus', () => {
    win.show();
    win.focus();
    content.focus();
    return { focused: win.isFocused() };
  });
  peer.handle('state', async () => ({
    bounds: win.getBounds(),
    contentBounds: win.getContentBounds(),
    visible: win.isVisible(),
    focused: win.isFocused(),
    contentFocused: content.isFocused(),
    fullScreen: win.isFullScreen(),
    visibleOnAllWorkspaces: safe(() => win.isVisibleOnAllWorkspaces()),
    url: content.getURL(),
    page: await js('window.probe ? probe.state() : null').catch(() => null),
    frames: content.mainFrame.framesInSubtree.map((f) => f.url),
    handoffs,
    blocked,
  }));
  peer.handle('play', () => js('document.querySelector("video").play().then(() => true)', true));
  peer.handle('pause', () => js('(document.querySelector("video").pause(), true)'));
  peer.handle('mute', ({ muted }) => {
    content.setAudioMuted(Boolean(muted));
    return content.isAudioMuted();
  });
  peer.handle('media', () => js('window.probe ? probe.state() : { title: document.title }'));
  peer.handle('fullscreen', ({ on }) => (on ? js('probe.fullscreen()', true) : js('document.exitFullscreen().then(() => true, (e) => e.name)', true)));
  peer.handle('navtest', ({ action }) => js(`window.navtest[${JSON.stringify(action)}]()`, true));
  peer.handle('hang', ({ ms }) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
    return true;
  });
  peer.handle('metrics', ({ seconds }) => measure(seconds ?? 5));
  peer.handle('ping', () => now());
  // A key sent into the page by Electron (the same route as a real key, minus the OS): for Linux, where the image has no XTest.
  peer.handle('inject', ({ keyCode, modifiers }) => {
    content.focus();
    content.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    content.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    return true;
  });
  peer.handle('capture', async ({ name }) => {
    if (bar) {
      // Stack the bar's capture over the service's, for one picture of the window.
      const top = await bar.webContents.capturePage();
      const bottom = await content.capturePage();
      const a = top.getSize();
      const b = bottom.resize({ width: a.width - Math.round((12 * a.width) / win.getContentBounds().width) });
      const width = a.width;
      const bs = b.getSize();
      const topBitmap = top.toBitmap();
      const bottomBitmap = b.toBitmap();
      const buffer = Buffer.alloc(width * (a.height + bs.height) * 4);
      topBitmap.copy(buffer, 0);
      const bg = topBitmap.subarray(0, 4);
      const margin = Math.floor((width - bs.width) / 2);
      for (let y = 0; y < bs.height; y++) {
        const row = (a.height + y) * width * 4;
        for (let x = 0; x < width; x++) bg.copy(buffer, row + x * 4);
        bottomBitmap.copy(buffer, row + margin * 4, y * bs.width * 4, (y + 1) * bs.width * 4);
      }
      const image = nativeImage.createFromBitmap(buffer, { width, height: a.height + bs.height });
      writeFileSync(join(out, name), image.toPNG());
      return { file: name };
    }
    return capture(content, name);
  });
  peer.handle('close', () => {
    setTimeout(() => app.exit(0), 50);
    return true;
  });
  peer.on('close', () => app.exit(0));
  peer.send('ready', { at: now() });
}

app.on('window-all-closed', () => {});
// Not awaited: Electron emits ready only after the entry module (and any top-level await) has finished.
void (mode === 'probe' ? probe() : serve());
