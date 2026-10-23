// Spike S7: automatic picture-in-picture in Electron 45 / Chromium 156.
// A Chord-shaped app (BaseWindow + one WebContentsView per tab) plays a local
// test video and measures what Chord can do when you switch away from it.
// Audio is muted at the WebContents level, so nothing is heard.
//
// Nothing here waits on the user: main-process errors are written to the
// results and end the run (Electron would otherwise show a modal error box).
// The PiP window is Chromium's, owned by this process; it is captured with
// PrintWindow and read through UI Automation (pipwin.ps1), never by copying
// the screen or moving the mouse.
//
// Run through run.mjs. Args: <results.json> <video file> <captures dir> [youtube]
import { app, BaseWindow, WebContentsView } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [outFile, videoFile, capturesDir, ...flags] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const results = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch, steps: {} };
const finish = (code) => {
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  app.exit(code);
};
const fatal = (kind, error) => {
  results.fatal = { kind, error: String(error?.stack ?? error) };
  try {
    finish(1);
  } catch {
    app.exit(1);
  }
};
process.on('uncaughtException', (e) => fatal('uncaughtException', e));
process.on('unhandledRejection', (e) => fatal('unhandledRejection', e));
app.on('web-contents-created', (_e, contents) => contents.on('will-prevent-unload', (event) => event.preventDefault()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps1 = join(import.meta.dirname, 'pipwin.ps1');
/** Async on purpose: PrintWindow and UI Automation need this process's UI thread free to answer. */
const pwsh = (...args) =>
  new Promise((done) =>
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-File', ps1, ...args], { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) return done({ error: String(stderr || error.message).slice(0, 500) });
      try {
        done(JSON.parse(stdout));
      } catch {
        done({ error: `unparsable: ${stdout.slice(0, 300)}` });
      }
    }),
  );

/** MSAA through Windows PowerShell 5.1 (msaa.ps1): Chromium names the PiP window's buttons there. */
const msaa = (hwnd, invoke) =>
  new Promise((done) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'msaa.ps1'), '-Hwnd', hwnd, ...(invoke ? ['-Invoke', invoke] : [])],
      { windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) return done({ error: String(stderr || error.message).slice(0, 500) });
        try {
          done(JSON.parse(stdout));
        } catch {
          done({ error: `unparsable: ${stdout.slice(0, 300)}` });
        }
      },
    ),
  );

// ---------- Pages ----------

const track = `<script>
window.__log = [];
for (const v of document.querySelectorAll('video')) {
  v.addEventListener('enterpictureinpicture', () => __log.push('enter:' + v.id));
  v.addEventListener('leavepictureinpicture', () => __log.push('leave:' + v.id + ':paused=' + v.paused));
  v.addEventListener('pause', () => __log.push('pause:' + v.id));
}
document.addEventListener('visibilitychange', () => __log.push('visibility:' + document.visibilityState));
</script>`;
const video = (id, attrs) => `<video id="${id}" src="/video.webm" loop ${attrs}></video>`;
const pages = {
  '/one': `<title>One</title>${video('v', 'autoplay width="640" height="360"')}${track}`,
  '/muted': `<title>Muted</title>${video('v', 'autoplay muted width="640" height="360"')}${track}`,
  '/multi': `<title>Multi</title>${video('small', 'autoplay muted width="160" height="90"')}${video('big', 'autoplay width="640" height="360"')}${video('paused', 'width="800" height="450"')}${track}`,
  '/disabled': `<title>Disabled</title>${video('v', 'autoplay disablepictureinpicture width="640" height="360"')}${track}`,
  '/mediasession': `<title>Media Session</title>${video('v', 'autoplay width="640" height="360"')}${track}<script>
    window.__ms = {};
    for (const action of ['enterpictureinpicture', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack']) {
      try { navigator.mediaSession.setActionHandler(action, () => __log.push('ms:' + action)); __ms[action] = 'ok'; } catch (e) { __ms[action] = e.name; }
    }
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'S7 test', artist: 'Chord' });
  </script>`,
  '/docpip': `<title>Document PiP</title><p>Document PiP probe</p>`,
  '/blank': `<title>Blank</title><p>Another tab</p>`,
};
const server = createServer((req, res) => {
  if (req.url === '/video.webm') {
    res.writeHead(200, { 'content-type': 'video/webm' });
    res.end(readFileSync(videoFile));
    return;
  }
  const body = pages[req.url ?? ''];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ? `<!doctype html><style>body{margin:0;background:#222;color:#ddd;font:14px system-ui} video{display:block;margin:8px}</style>${body}` : 'not found');
});

// ---------- Helpers ----------

const PICK = `(() => {
  const playing = [...document.querySelectorAll('video')].filter((v) => !v.paused && !v.ended && v.readyState >= 2);
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  return playing.sort((a, b) => area(b) - area(a))[0] ?? null;
})()`;
const REQUEST = `(async () => {
  const v = ${PICK};
  if (!v) return 'no playing video';
  try { await v.requestPictureInPicture(); return 'entered:' + v.id; } catch (e) { return 'error:' + e.name + ': ' + e.message; }
})()`;
const EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => 'exited', (e) => 'error:' + e.name) : 'not in pip'`;
const iso = (contents, code, gesture) => contents.executeJavaScriptInIsolatedWorld(999, [{ code }], gesture).catch((e) => `threw: ${e.message}`);
const state = (contents) =>
  contents.executeJavaScript(
    `({ pip: document.pictureInPictureElement?.id ?? null, visibility: document.visibilityState, log: window.__log ?? [], videos: [...document.querySelectorAll('video')].map((v) => ({ id: v.id, time: Math.round(v.currentTime * 100) / 100, paused: v.paused, muted: v.muted })) })`,
  );
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
};

let win;
let origin;
let views;
/** Show one view in the window, as Chord's showTab does: the other is removed. */
function show(view) {
  for (const v of views) if (v !== view) win.contentView.removeChildView(v);
  if (view) {
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 560 });
  }
}
async function load(view, path) {
  await view.webContents.loadURL(`${origin}${path}`);
  if (!['/docpip', '/blank'].includes(path)) {
    await until(() => view.webContents.executeJavaScript(`[...document.querySelectorAll('video[autoplay]')].every((v) => v.currentTime > 0.3)`));
  }
}
const ownHwnd = () => '0x' + win.getNativeWindowHandle().readBigUInt64LE(0).toString(16).toUpperCase();
async function pipWindow() {
  const list = await pwsh('list', '-ProcessId', String(process.pid));
  if (!Array.isArray(list)) return { error: list.error };
  const own = ownHwnd().toLowerCase();
  return list.find((w) => w.hwnd.toLowerCase() !== own) ?? null;
}
/** Two captures of the PiP window a second apart: different fingerprints mean the video is still being drawn. */
async function rendering(label) {
  const w = await pipWindow();
  if (!w || w.error) return { window: w };
  const a = await pwsh('capture', '-Hwnd', w.hwnd, '-Out', join(capturesDir, `${label}-a.png`));
  await sleep(1000);
  const b = await pwsh('capture', '-Hwnd', w.hwnd, '-Out', join(capturesDir, `${label}-b.png`));
  return { window: w, a, b, drawing: a.fingerprint !== undefined && a.fingerprint !== b.fingerprint };
}
/** Records which events a WebContents and the window emit while `work` runs. */
async function eventsDuring(contents, work) {
  const seen = [];
  const emit = contents.emit;
  contents.emit = function (name, ...rest) {
    if (!['console-message', 'ipc-message'].includes(name)) seen.push(`webContents:${String(name)}`);
    return emit.call(this, name, ...rest);
  };
  const onFocus = () => seen.push('window:focus');
  const onRestore = () => seen.push('window:restore');
  win.on('focus', onFocus);
  win.on('restore', onRestore);
  try {
    await work();
    await sleep(1500);
  } finally {
    contents.emit = emit;
    win.off('focus', onFocus);
    win.off('restore', onRestore);
  }
  return [...new Set(seen)];
}
async function step(name, fn) {
  try {
    results.steps[name] = await fn();
  } catch (error) {
    results.steps[name] = { threw: String(error?.stack ?? error) };
  }
  writeFileSync(outFile, JSON.stringify(results, null, 2));
}

// ---------- The run ----------

// In an ES module main, top-level await on `ready` deadlocks: Electron waits for the module first.
async function run() {

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  win = new BaseWindow({ width: 900, height: 560, x: 40, y: 40, title: 'Chord S7 spike' });
  const a = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  const b = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  views = [a, b];
  for (const v of views) v.webContents.setAudioMuted(true);
  const audible = [];
  a.webContents.on('audio-state-changed', (e) => audible.push(e.audible));
  const mediaEvents = [];
  a.webContents.on('media-started-playing', () => mediaEvents.push('started'));
  a.webContents.on('media-paused', () => mediaEvents.push('paused'));
  await load(b, '/blank');
  show(a);
  await load(a, '/one');

  await step('1-no-user-gesture', async () => ({ request: await iso(a.webContents, REQUEST, false), state: await state(a.webContents) }));

  await step('2-gesture-isolated-world-attached', async () => {
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(700);
    const pip = await pipWindow();
    const controls = pip && !pip.error ? await pwsh('uia', '-Hwnd', pip.hwnd) : null;
    const render = await rendering('2-attached');
    return { request, pip, controls, render, state: await state(a.webContents) };
  });

  await step('3-switch-away-while-in-pip', async () => {
    show(b);
    await sleep(800);
    const s1 = await state(a.webContents);
    await sleep(1000);
    const s2 = await state(a.webContents);
    const render = await rendering('3-detached');
    return { before: s1, after: s2, timeAdvanced: s2.videos[0].time > s1.videos[0].time, render };
  });

  await step('4-back-to-tab-button', async () => {
    const pip = await pipWindow();
    if (!pip || pip.error) return { pip };
    const controls = await msaa(pip.hwnd);
    results.pipControls = controls;
    const back = Array.isArray(controls) ? controls.find((c) => /back to tab|return to tab/i.test(c.name ?? '')) : null;
    if (!back) return { pip, note: 'no back-to-tab control found' };
    let invoked;
    const events = await eventsDuring(a.webContents, async () => {
      invoked = await msaa(pip.hwnd, back.name);
    });
    return { button: back.name, invoked, events, state: await state(a.webContents), pipAfter: await pipWindow() };
  });

  await step('5-request-while-detached', async () => {
    show(b);
    await iso(a.webContents, EXIT, false);
    // The tab is off screen now, like a tab you've switched away from.
    await sleep(500);
    const before = await state(a.webContents);
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(700);
    const render = await rendering('5-requested-detached');
    return { before, request, render, state: await state(a.webContents) };
  });

  await step('6-close-button', async () => {
    const pip = await pipWindow();
    if (!pip || pip.error) return { pip };
    const controls = await msaa(pip.hwnd);
    const close = Array.isArray(controls) ? controls.find((c) => /^close/i.test(c.name ?? '')) : null;
    if (!close) return { controls, note: 'no close control found' };
    let invoked;
    const events = await eventsDuring(a.webContents, async () => {
      invoked = await msaa(pip.hwnd, close.name);
    });
    return { button: close.name, invoked, events, state: await state(a.webContents), pipAfter: await pipWindow() };
  });

  await step('7-return-exits', async () => {
    show(a);
    await a.webContents.executeJavaScript(`document.querySelector('video').play()`);
    await sleep(300);
    await iso(a.webContents, REQUEST, true);
    show(b);
    await sleep(500);
    show(a);
    const exit = await iso(a.webContents, EXIT, false);
    await sleep(500);
    return { exit, state: await state(a.webContents), pipAfter: await pipWindow() };
  });

  await step('8-muted-video', async () => {
    show(a);
    await load(a, '/muted');
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(500);
    const s = await state(a.webContents);
    await iso(a.webContents, EXIT, false);
    return { request, state: s };
  });

  await step('9-several-videos', async () => {
    await load(a, '/multi');
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(500);
    const s = await state(a.webContents);
    await iso(a.webContents, EXIT, false);
    return { request, state: s };
  });

  await step('10-disablePictureInPicture', async () => {
    await load(a, '/disabled');
    // Ask the video directly: the picker would pick it too (it doesn't check the attribute).
    const request = await iso(
      a.webContents,
      `document.querySelector('video').requestPictureInPicture().then(() => 'entered', (e) => 'error:' + e.name + ': ' + e.message)`,
      true,
    );
    return { request, attributeVisibleToIsolatedWorld: await iso(a.webContents, `document.querySelector('video').disablePictureInPicture`, false) };
  });

  await step('11-media-session-auto-pip', async () => {
    await load(a, '/mediasession');
    const support = await a.webContents.executeJavaScript('window.__ms');
    show(b);
    await sleep(3000);
    const s = await state(a.webContents);
    show(a);
    // Enter PiP ourselves, with the page's Media Session actions set: which buttons does the window gain?
    await iso(a.webContents, REQUEST, true);
    await sleep(700);
    const pip = await pipWindow();
    const controls = pip && !pip.error ? await pwsh('uia', '-Hwnd', pip.hwnd) : null;
    await iso(a.webContents, EXIT, false);
    return { support, afterSwitchingAway: s, browserTriggeredEnter: s.log.includes('ms:enterpictureinpicture'), controlsWithMediaSession: controls };
  });

  await step('12-document-pip', async () => {
    await load(a, '/docpip');
    const present = await a.webContents.executeJavaScript(`'documentPictureInPicture' in window`);
    const request = present
      ? await iso(a.webContents, `documentPictureInPicture.requestWindow({ width: 320, height: 180 }).then((w) => { w.document.body.innerHTML = '<p style="color:white;background:#246;font:24px system-ui;margin:0;height:100vh">Document PiP</p>'; return 'opened:' + typeof w; }, (e) => 'error:' + e.name + ': ' + e.message)`, true)
      : 'not exposed';
    await sleep(800);
    const list = await pwsh('list', '-ProcessId', String(process.pid));
    const docWindow = Array.isArray(list) ? list.find((w) => w.hwnd.toLowerCase() !== ownHwnd().toLowerCase()) : null;
    const shot = docWindow ? await pwsh('capture', '-Hwnd', docWindow.hwnd, '-Out', join(capturesDir, '12-document-pip.png')) : null;
    await a.webContents.executeJavaScript('documentPictureInPicture.window?.close()');
    return { present, request, windows: list, shot };
  });

  await step('13-window-minimized', async () => {
    await load(a, '/one');
    win.minimize();
    await sleep(1000);
    const before = await state(a.webContents);
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(700);
    const render = await rendering('13-minimized');
    const s = await state(a.webContents);
    await iso(a.webContents, EXIT, false);
    win.restore();
    await sleep(500);
    return { before, request, render, state: s };
  });

  await step('14-window-blurred', async () => {
    win.blur();
    await sleep(500);
    const request = await iso(a.webContents, REQUEST, true);
    await sleep(500);
    const s = await state(a.webContents);
    await iso(a.webContents, EXIT, false);
    return { request, state: s };
  });

  if (flags.includes('youtube')) {
    await step('15-youtube', async () => {
      show(a);
      await a.webContents.loadURL('https://www.youtube.com/watch?v=aqz-KE-bpKQ').catch((e) => e.message);
      const playing = await until(() => a.webContents.executeJavaScript(`[...document.querySelectorAll('video')].some((v) => !v.paused && v.currentTime > 1)`), 25_000);
      const page = await a.webContents.executeJavaScript(
        `({ title: document.title, videos: [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, muted: v.muted, w: v.getBoundingClientRect().width, disablePiP: v.disablePictureInPicture, time: v.currentTime })), pipButton: Boolean(document.querySelector('.ytp-pip-button')), ad: Boolean(document.querySelector('.ad-showing')) })`,
      );
      const request = playing ? await iso(a.webContents, REQUEST, true) : 'nothing playing';
      await sleep(1500);
      const pip = await pipWindow();
      const controls = pip && !pip.error ? await pwsh('uia', '-Hwnd', pip.hwnd) : null;
      show(b);
      await sleep(1500);
      const render = await rendering('15-youtube');
      const after = await a.webContents.executeJavaScript(
        `({ pip: Boolean(document.pictureInPictureElement), videos: [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, time: v.currentTime })), playerClass: document.querySelector('.html5-video-player')?.className ?? null })`,
      );
      show(a);
      const exit = await iso(a.webContents, EXIT, false);
      return { playing, page, request, pip, controls, render, after, exit };
    });
  }

  results.audibleEvents = audible;
  results.mediaEvents = mediaEvents;
  finish(0);
}
void app.whenReady().then(run);
