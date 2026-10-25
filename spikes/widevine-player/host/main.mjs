// A stand-in for Chord on stock Electron: a BaseWindow with a sidebar and a
// content area, which starts the Widevine player (ECS) over the control
// channel and measures how each way of showing it behaves.
//
//   electron host --scenarios channel,navlock,glue,frameless,child
//     --player-exe <ECS electron> --player-app <spikes/widevine-player/player>
//     --player-profile <dir> --out <dir> [--koffi <koffi package dir>] [--node <node>]
//
// Writes <out>/host.json, captures, and sampler files.
import '../shared/guard.mjs';
import { deadline } from '../shared/guard.mjs';
import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_ENV, listen, newAddress, newSecret, now } from '../shared/channel.mjs';

const { app, BaseWindow, WebContentsView, nativeImage, screen } = electron;
const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const opt = (name, fallback = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const out = opt('out');
const playerExe = opt('player-exe');
const playerApp = opt('player-app');
const playerProfile = opt('player-profile');
const koffiPath = opt('koffi');
const nodeExe = opt('node');
const scenarios = opt('scenarios', 'channel,navlock,glue,frameless,child').split(',');
mkdirSync(out, { recursive: true });
deadline(Number(opt('timeout', '900000')), 'host');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
const log = (...a) => console.log('[host]', ...a);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const wayland = isLinux && (process.env.XDG_SESSION_TYPE === 'wayland' || (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY));
const ANGEL = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd';
const PLAYING = `probe.html?play=${encodeURIComponent(ANGEL)}&title=${encodeURIComponent('Angel One')}`;
const playerLog = createWriteStream(join(out, 'player-serve.log'), { flags: 'a' });

const results = { platform: process.platform, arch: process.arch, wayland, electron: process.versions.electron, envKeys: Object.keys(process.env).sort(), scenarios: {} };
const save = () => writeFileSync(join(out, 'host.json'), JSON.stringify(results, null, 2));
import { win32 } from '../shared/win32.mjs';
const w = isWin && koffiPath ? win32(koffiPath) : null;
if (isWin) app.setAppUserModelId('com.chord.spike.host');

// ------------------------------------------------------------------ helpers

/** The environment for the player: the host's, without what Electron and Chromium add to their own process. */
function playerEnv() {
  const env = { ...process.env };
  // With these inherited from the host, the player's zygote died at once on Linux.
  for (const key of Object.keys(env)) if (/^(CHROME_|ELECTRON_|GOOGLE_|ORIGINAL_XDG_|NODE_OPTIONS|FC_FONTATIONS)/.test(key)) delete env[key];
  if (env.DBUS_SESSION_BUS_ADDRESS === 'disabled:') delete env.DBUS_SESSION_BUS_ADDRESS;
  return env;
}

/** Starts a player over a fresh channel; resolves once both ends are authenticated. */
async function startPlayer(launch = {}) {
  // The scenarios' pages come from the player's own 127.0.0.1 server, so the lock allows that host (the real list is checked by itself).
  launch = { test: { pages: ['127.0.0.1'], frames: ['127.0.0.1'] }, ...launch };
  const address = newAddress();
  const secret = newSecret();
  let gotPeer;
  const peerReady = new Promise((r) => (gotPeer = r));
  const inbox = [];
  const server = await listen(address, secret, (peer) => {
    for (const t of ['open', 'key', 'media', 'focus', 'fullscreen', 'ready']) peer.handle(t, (m) => inbox.push({ ...m, tHost: now() }));
    gotPeer(peer);
  });
  const t0 = now();
  const line = JSON.stringify({ path: address.path, secret, ...launch });
  const env = playerEnv();
  if (isWin) env[LAUNCH_ENV] = line; // Electron's main process has no stdin on Windows
  const child = spawn(playerExe, [playerApp, '--mode', 'serve', '--profile', playerProfile, '--out', out, '--enable-logging=stderr'], { stdio: ['pipe', 'pipe', 'pipe'], env });
  child.stdout.pipe(playerLog, { end: false });
  child.stderr.pipe(playerLog, { end: false });
  child.stdin.end(isWin ? '' : `${line}\n`);
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const peer = await Promise.race([peerReady, sleep(45_000).then(() => null), exited.then(() => null)]);
  if (!peer) throw new Error('player did not connect');
  const connectedMs = now() - t0;
  // The player says ready once its handlers are in place (after the CDM check).
  const readyBy = now() + 60_000;
  while (!inbox.some((m) => m.t === 'ready') && now() < readyBy) await sleep(20);
  const readyMs = now() - t0;
  return {
    readyMs,
    peer,
    child,
    inbox,
    connectedMs,
    waitFor: async (test, ms = 8000) => {
      const start = now();
      while (now() - start < ms) {
        const hit = inbox.find(test);
        if (hit) return hit;
        await sleep(20);
      }
      return null;
    },
    async stop() {
      const t = now();
      await peer.request('close', {}, 3000).catch(() => {});
      const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
      if (code === 'timeout') child.kill();
      server.close();
      address.cleanup();
      return { exitMs: round(now() - t), code };
    },
  };
}

/** The Chord stand-in: a BaseWindow with a frame view (sidebar, content area). */
async function makeHost(bounds = { x: 40, y: 40, width: 900, height: 600 }) {
  const win = new BaseWindow({ ...bounds, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 }, backgroundColor: '#efe7ff', title: 'Chord (stand-in)', show: false });
  const frame = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(frame);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    frame.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', layout);
  await frame.webContents.loadFile(join(here, 'frame.html'));
  const keys = [];
  frame.webContents.on('before-input-event', (_e, input) => input.type === 'keyDown' && keys.push({ key: input.key, t: now() }));
  win.show();
  await sleep(400);
  return { win, frame, keys };
}

/** The player's place: the content area, inside the sidebar and an 8 px inset. */
function playerArea(win, contentBounds = win.getContentBounds()) {
  return { x: contentBounds.x + 232, y: contentBounds.y + 8, width: contentBounds.width - 240, height: contentBounds.height - 16 };
}

/** A window's handle as the OS samplers want it. */
function handleOf(buffer, mediaSourceId) {
  if (isMac) return Number(mediaSourceId.split(':')[1]);
  return buffer.length === 4 ? buffer.readUInt32LE(0) : Number(buffer.readBigUInt64LE(0));
}

/** Runs tools/sampler.mjs with a plan; resolves with its result (or null where there's no sampler). */
async function sample(name, plan) {
  if (!nodeExe || wayland || (!koffiPath && !isMac)) return null;
  const file = join(out, `sampler-${name}.json`);
  const planFile = join(out, `plan-${name}.json`);
  writeFileSync(planFile, JSON.stringify({ koffi: koffiPath, out: file, ...plan }));
  const child = spawn(nodeExe, [join(here, '../tools/sampler.mjs'), planFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.pipe(playerLog, { end: false });
  const code = await new Promise((r) => child.once('exit', r));
  if (code !== 0) return { error: err.slice(-800) };
  return JSON.parse(readFileSync(file, 'utf8'));
}

const percentile = (list, p) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))] : null);

/**
 * How far the player strayed from its place over the host during [from, to]: the player's
 * edges against the host's, compared with where they were at rest just before.
 */
function trail(samples, from, to) {
  if (!samples?.length) return null;
  const rows = samples.filter((r) => r[0] >= from && r[0] <= to);
  const before = samples.filter((r) => r[0] < from).at(-1) ?? rows[0];
  if (!before || rows.length < 2) return { note: 'no samples in range' };
  const rel = (r) => [r[5] - r[1], r[6] - r[2], r[3] - r[7], r[4] - r[8]];
  const rest = rel(before);
  const episodes = [];
  let open = null;
  let misaligned = 0;
  let maxPx = 0;
  let hostChanges = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const end = rows[i + 1]?.[0] ?? to;
    if (i > 0 && r.slice(1, 5).join() !== rows[i - 1].slice(1, 5).join()) hostChanges++;
    const px = Math.max(...rel(r).map((v, k) => Math.abs(v - rest[k])));
    if (px > 0) {
      maxPx = Math.max(maxPx, px);
      misaligned += end - r[0];
      open ??= r[0];
    } else if (open !== null) {
      episodes.push(r[0] - open);
      open = null;
    }
  }
  if (open !== null) episodes.push(to - open);
  return {
    windowMs: round(to - from),
    hostChanges,
    misalignedMs: round(misaligned),
    misalignedPct: round((misaligned / (to - from)) * 100),
    episodes: episodes.length,
    medianEpisodeMs: round(percentile(episodes, 0.5)),
    p95EpisodeMs: round(percentile(episodes, 0.95)),
    maxEpisodeMs: round(Math.max(0, ...episodes)),
    maxPx,
  };
}

/** Glue: the player follows the host's content area, by the host's window events. */
function glue(host, peer, { useWillMove = false, onFocus = true, follow = false } = {}) {
  const acks = [];
  let seq = 0;
  const frameOffset = (() => {
    const wb = host.win.getBounds();
    const cb = host.win.getContentBounds();
    return { x: cb.x - wb.x, y: cb.y - wb.y, w: cb.width - wb.width, h: cb.height - wb.height };
  })();
  const send = (why, area = playerArea(host.win), visible = true) => {
    const s = ++seq;
    const tSend = now();
    peer
      .request('bounds', { seq: s, ...area, visible })
      .then((r) => acks.push({ seq: s, why, tSend, tGot: r.tGot, tApplied: r.tApplied, tAck: now() }))
      .catch(() => {});
  };
  // With follow, the player polls the host's rectangle itself; only visibility and z-order come over the channel.
  if (!follow) host.win.on('move', () => send('move'));
  if (!follow) host.win.on('resize', () => send('resize'));
  if (useWillMove && !follow)
    host.win.on('will-move', (_e, b) => send('will-move', playerArea(host.win, { x: b.x + frameOffset.x, y: b.y + frameOffset.y, width: b.width + frameOffset.w, height: b.height + frameOffset.h })));
  host.win.on('minimize', () => send('minimize', undefined, false));
  host.win.on('restore', () => send('restore'));
  host.win.on('hide', () => send('hide', undefined, false));
  host.win.on('show', () => send('show'));
  // Raise the player above the host when the host comes forward; again a moment later, once the activation has settled.
  const above = () => peer.request('above', { mediaSourceId: host.win.getMediaSourceId() }).catch(() => {});
  if (onFocus) host.win.on('focus', () => (above(), setTimeout(above, 150)));
  return {
    acks,
    send,
    summary(from = 0, to = Infinity) {
      const list = acks.filter((a) => a.tSend >= from && a.tSend <= to && (a.why === 'move' || a.why === 'will-move' || a.why === 'resize'));
      const oneWay = list.map((a) => a.tApplied - a.tSend);
      return { updates: list.length, oneWayMedianMs: round(percentile(oneWay, 0.5)), oneWayP95Ms: round(percentile(oneWay, 0.95)), oneWayMaxMs: round(Math.max(0, ...oneWay)) };
    },
  };
}

/** Moves the host by its own setPosition / setSize, as a stand-in for a drag where real input isn't available. */
async function programmaticDrag(win, { steps = 50, interval = 16, d = [5, 3] } = {}) {
  const [x0, y0] = win.getPosition();
  for (let i = 1; i <= steps; i++) {
    win.setPosition(x0 + d[0] * i, y0 + d[1] * i);
    await sleep(interval);
  }
  for (let i = steps - 1; i >= 0; i--) {
    win.setPosition(x0 + d[0] * i, y0 + d[1] * i);
    await sleep(interval);
  }
}
async function programmaticResize(win, { steps = 30, interval = 16, d = [6, 4] } = {}) {
  const [w0, h0] = win.getSize();
  for (let i = 1; i <= steps; i++) {
    win.setSize(w0 + d[0] * i, h0 + d[1] * i);
    await sleep(interval);
  }
  for (let i = steps - 1; i >= 0; i--) {
    win.setSize(w0 + d[0] * i, h0 + d[1] * i);
    await sleep(interval);
  }
}

/** A point of the host's window in the coordinates real input uses (physical pixels on Windows). */
function inputPoint(win, x, y) {
  const cb = win.getContentBounds();
  const p = { x: cb.x + x, y: cb.y + y };
  return isWin ? Object.values(screen.dipToScreenPoint(p)) : [p.x, p.y];
}

/** macOS: what kind of app a process is (Foreground, UIElement, BackgroundOnly), and which app is in front. */
function macApps(pids) {
  if (!isMac) return null;
  const run = (args) => spawnSync('lsappinfo', args, { encoding: 'utf8' }).stdout.trim();
  const info = {};
  for (const [label, pid] of Object.entries(pids)) {
    const asn = run(['find', `pid=${pid}`]);
    info[label] = { asn, type: run(['info', '-only', 'ApplicationType', asn]) };
  }
  info.front = run(['info', '-only', 'pid', run(['front'])]);
  return info;
}

function taskbar() {
  if (!isWin) return null;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, '../tools/taskbar.ps1')], { encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: (r.stdout + r.stderr).slice(0, 400) };
  }
}

function printWindow(hwnd, name, points = []) {
  if (!isWin) return null;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, '../tools/printwindow.ps1'), '-Hwnd', String(hwnd), '-Out', join(out, name), '-Points', points.map((p) => p.join(',')).join(';')], { encoding: 'utf8' });
  try {
    return { file: name, ...JSON.parse(r.stdout) };
  } catch {
    return { error: (r.stdout + r.stderr).slice(0, 400) };
  }
}

/**
 * One picture of approach (b): the host's capture with the player's pasted at its place.
 * Two captures put together at the measured offset, not a capture of the screen.
 */
function compose(hostFile, playerFile, x, y, name, dipWidth) {
  try {
    const a = nativeImage.createFromPath(join(out, hostFile));
    const b = nativeImage.createFromPath(join(out, playerFile));
    const { width, height } = a.getSize();
    const scale = width / dipWidth;
    const bs = b.getSize();
    const base = Buffer.from(a.toBitmap());
    const top = b.toBitmap();
    const ox = Math.round(x * scale);
    const oy = Math.round(y * scale);
    for (let row = 0; row < bs.height && oy + row < height; row++) {
      const n = Math.min(bs.width, width - ox) * 4;
      top.copy(base, ((oy + row) * width + ox) * 4, row * bs.width * 4, row * bs.width * 4 + n);
    }
    writeFileSync(join(out, name), nativeImage.createFromBitmap(base, { width, height }).toPNG());
    return name;
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function captureHost(host, name) {
  const image = await host.frame.webContents.capturePage();
  writeFileSync(join(out, name), image.toPNG());
  return name;
}

/** The host's keys reach it while the player's main thread is stuck? (Windows: attached input queues.) */
async function hangTest(host, p, hostHwnd) {
  if (!isWin || !w) return null;
  host.win.focus();
  host.frame.webContents.focus();
  await sleep(300);
  const sidebar = inputPoint(host.win, 100, 300);
  const samplerRun = sample('hang', { host: hostHwnd, player: hostHwnd, durationMs: 4200, actions: [{ at: 100, do: 'click', abs: sidebar }, { at: 1100, do: 'keys', keys: ['A'] }, { at: 1150, do: 'mark', label: 'key sent' }] });
  await sleep(600);
  const tHang = now();
  const hang = p.peer.request('hang', { ms: 2500 }, 8000).catch(() => null);
  const s = await samplerRun;
  await hang;
  const sent = s?.events?.find((e) => e[1] === 'keys')?.[0];
  const got = host.keys.find((k) => k.key.toLowerCase() === 'a' && k.t >= (sent ?? 0) - 5);
  return { hangStartedAt: round(tHang), keySentAt: round(sent), hostGotKeyAt: round(got?.t), hostKeyLatencyMs: sent && got ? round(got.t - sent) : null, samplerError: s?.error ?? null };
}

// ---------------------------------------------------------------- scenarios

async function scenarioChannel() {
  const r = {};
  const host = await makeHost();
  const p = await startPlayer();
  r.connectMs = round(p.connectedMs);
  r.readyMs = round(p.readyMs);
  const pings = [];
  for (let i = 0; i < 200; i++) {
    const t = now();
    await p.peer.request('ping');
    pings.push(now() - t);
  }
  r.pingMedianMs = round(percentile(pings, 0.5));
  r.pingP95Ms = round(percentile(pings, 0.95));
  r.window = await p.peer.request('window', { style: 'glued', bounds: playerArea(host.win) });
  glue(host, p.peer);
  await p.peer.request('navigate', { local: PLAYING });
  const playing = await p.waitFor((m) => m.t === 'media' && m.paused === false, 30_000);
  r.nowPlayingCard = playing && { title: playing.title, paused: playing.paused, muted: playing.muted, latencyMs: round(playing.tHost - playing.at) };
  const tPause = now();
  await p.peer.request('pause');
  const paused = await p.waitFor((m) => m.t === 'media' && m.paused === true && m.tHost > tPause);
  r.pause = { ok: Boolean(paused), roundTripToCardMs: paused ? round(paused.tHost - tPause) : null };
  const tPlay = now();
  await p.peer.request('play');
  const resumed = await p.waitFor((m) => m.t === 'media' && m.paused === false && m.tHost > tPlay);
  r.play = { ok: Boolean(resumed), roundTripToCardMs: resumed ? round(resumed.tHost - tPlay) : null };
  r.mute = await p.peer.request('mute', { muted: true });
  r.media = await p.peer.request('media');
  const tFocus = now();
  r.bringToFront = await p.peer.request('focus');
  r.bringToFront.ms = round(now() - tFocus);
  r.close = await p.stop();
  host.win.destroy();
  return r;
}

async function scenarioNavlock() {
  const r = { tests: {} };
  const host = await makeHost();
  const p = await startPlayer({ test: { pages: ['127.0.0.1'], frames: ['127.0.0.1'] } });
  await p.peer.request('window', { style: 'glued', bounds: playerArea(host.win) });
  glue(host, p.peer);
  const expectations = {
    link: { handoff: 'https://example.com/link' },
    targetBlank: { handoff: 'https://example.org/blank' },
    popupBlocked: { handoff: 'https://example.net/popup' },
    popupAllowed: { handoff: null },
    redirect: { handoff: 'https://example.com/redirected' },
    meta: { handoff: 'https://example.com/meta' },
    form: { handoff: 'https://example.com/form' },
    assign: { handoff: 'https://www.wikipedia.org/' },
    frameBlocked: { handoff: null, blockedFrame: 'https://example.com/frame' },
    frameAllowed: { handoff: null },
    mailto: { handoff: 'mailto:someone@example.com' },
    customScheme: { handoff: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' },
    download: { handoff: '/probe.js' },
    httpLink: { handoff: 'http://neverssl.com/' },
  };
  for (const [action, expected] of Object.entries(expectations)) {
    await p.peer.request('navigate', { local: 'navlock.html' });
    const before = p.inbox.length;
    const t = now();
    await p.peer.request('navtest', { action }).catch((e) => e.message);
    await sleep(1500);
    const state = await p.peer.request('state');
    const handoffs = p.inbox.slice(before).filter((m) => m.t === 'open');
    const handed = handoffs.map((m) => m.url);
    const stayed = /navlock\.html|\/meta\?/.test(state.url);
    const handedOk = expected.handoff === null ? handed.length === 0 : handed.some((u) => u.includes(expected.handoff));
    const frameOk = expected.blockedFrame ? state.blocked.some((b) => b.url === expected.blockedFrame) : true;
    r.tests[action] = { pass: stayed && handedOk && frameOk, url: state.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), handedToChord: handoffs.map((m) => `${m.why}: ${m.url}`), handoffMs: handoffs[0] ? round(handoffs[0].tHost - t) : null, frames: state.frames.length };
  }
  r.allPass = Object.values(r.tests).every((t) => t.pass);
  r.close = await p.stop();
  host.win.destroy();
  return r;
}

async function scenarioGlue(variant) {
  const r = { variant };
  const host = await makeHost();
  const p = await startPlayer();
  const opts = { style: 'glued', bounds: playerArea(host.win) };
  if (variant === 'panel') opts.panel = true;
  if (variant === 'panel-reset') opts.panel = 'reset';
  if (['accessory', 'panel', 'panel-reset', 'follow'].includes(variant) && isMac) opts.activation = 'accessory';
  r.window = await p.peer.request('window', opts);
  const g = glue(host, p.peer, { useWillMove: variant === 'will-move', onFocus: variant !== 'owned', follow: variant === 'follow' });
  await p.peer.request('navigate', { local: PLAYING });
  await p.waitFor((m) => m.t === 'media' && m.paused === false, 30_000);
  await sleep(1000);
  const handles = await p.peer.request('handles');
  const hostHandle = handleOf(host.win.getNativeWindowHandle(), host.win.getMediaSourceId());
  const playerHandle = handleOf(Buffer.from(handles.native, 'hex'), handles.mediaSourceId);
  if (variant === 'owned' && w) r.setOwner = String(w.setOwner(playerHandle, hostHandle));
  if (variant === 'follow') r.follow = await p.peer.request('follow', { handle: hostHandle, area: playerArea(host.win), koffiPath, intervalMs: 8 });
  r.state0 = await p.peer.request('state');

  // Wayland: the compositor places windows; neither the host nor the player can.
  if (wayland) {
    const before = host.win.getBounds();
    host.win.setPosition(before.x + 120, before.y + 80);
    await sleep(500);
    r.wayland = { hostBefore: before, hostAfterSetPosition: host.win.getBounds(), playerAsked: playerArea(host.win), playerState: (await p.peer.request('state')).bounds };
    r.close = await p.stop();
    host.win.destroy();
    return r;
  }

  // One sampler run: a real drag where real input works, then the host's own moves and resizes.
  const start = now();
  const dragFrom = inputPoint(host.win, 110, 18);
  const realDrag = isWin || isMac;
  const actions = [];
  if (realDrag) {
    actions.push({ at: 300, do: 'press', abs: dragFrom });
    for (let i = 1; i <= 60; i++) actions.push({ at: 300 + i * 8, do: 'moveBy', d: [4, 2] });
    for (let i = 1; i <= 60; i++) actions.push({ at: 800 + i * 8, do: 'moveBy', d: [-4, -2] });
    actions.push({ at: 1350, do: 'release' });
  }
  const samplerRun = sample(`glue-${variant}`, { host: hostHandle, player: playerHandle, durationMs: 6200, actions });
  await sleep(1800);
  const tProg = now();
  await programmaticDrag(host.win);
  const tProgEnd = now();
  await sleep(300);
  const tResize = now();
  await programmaticResize(host.win);
  const tResizeEnd = now();
  const s = await samplerRun;
  const pressedAt = s?.events?.find((e) => e[1] === 'press')?.[0];
  const releasedAt = s?.events?.find((e) => e[1] === 'release')?.[0];
  r.realDrag = realDrag && s?.samples ? { ...trail(s.samples, pressedAt, releasedAt + 200), glue: g.summary(pressedAt, releasedAt + 200), hostMoved: s.samples.some((row) => row[0] > pressedAt && row[0] < releasedAt && row[1] !== s.samples[0][1]) } : null;
  r.programmaticDrag = { ...(s?.samples ? trail(s.samples, tProg, tProgEnd + 200) : {}), glue: g.summary(tProg, tProgEnd + 200) };
  r.programmaticResize = { ...(s?.samples ? trail(s.samples, tResize, tResizeEnd + 200) : {}), glue: g.summary(tResize, tResizeEnd + 200) };
  r.samplerError = s?.error ?? null;
  r.clockCheck = { hostAtSamplerSpawn: round(start), firstSample: s?.samples?.[0]?.[0] ?? null, firstEvent: s?.events?.[0]?.[0] ?? null };
  r.samplerReadsPerSecond = s?.readsPerSecond ?? (s?.samples ? null : undefined);

  // Minimize, restore, hide, show.
  host.win.minimize();
  await sleep(800);
  r.minimized = { playerVisible: (await p.peer.request('state')).visible };
  host.win.restore();
  await sleep(800);
  r.restored = { playerVisible: (await p.peer.request('state')).visible };
  host.win.hide();
  await sleep(500);
  r.hidden = { playerVisible: (await p.peer.request('state')).visible };
  host.win.show();
  await sleep(800);

  // Z-order: bring the host forward; the glue then puts the player back above it.
  host.win.focus();
  await sleep(700);
  const z = await sample(`zorder-${variant}`, { host: hostHandle, player: playerHandle, durationMs: 30, zorder: true });
  r.zorderAfterHostFocus = z?.zorder ?? z?.error ?? null;

  // Keys: give the player focus, press Chord's shortcut, see whether it comes back to the host.
  r.focus = await p.peer.request('focus');
  await sleep(300);
  r.appsWhilePlayerFocused = macApps({ host: process.pid, player: handles.pid });
  r.osFocus = w ? w.focus() : null;
  const tKey = now();
  if (isWin) await sample(`keys-${variant}`, { host: hostHandle, player: playerHandle, durationMs: 200, actions: [{ at: 10, do: 'keys', keys: ['CONTROL', 'T'] }] });
  else if (isMac) await sample(`keys-${variant}`, { host: hostHandle, player: playerHandle, durationMs: 200, actions: [{ at: 10, do: 'keys', keys: ['META', 'T'] }] });
  let forwarded = await p.waitFor((m) => m.t === 'key' && m.tHost > tKey, 1500);
  r.shortcut = { route: isLinux ? 'sendInputEvent (no XTest)' : 'OS input', forwarded: Boolean(forwarded), key: forwarded?.key ?? null, latencyMs: forwarded ? round(forwarded.tHost - forwarded.at) : null };
  if (!forwarded) {
    const t2 = now();
    await p.peer.request('inject', { keyCode: 'T', modifiers: [isMac ? 'meta' : 'control'] });
    forwarded = await p.waitFor((m) => m.t === 'key' && m.tHost > t2, 1500);
    r.shortcutInjected = { forwarded: Boolean(forwarded), latencyMs: forwarded ? round(forwarded.tHost - forwarded.at) : null };
  }

  // Taskbar, Alt+Tab, Cmd+Tab.
  if (w) r.altTab = { player: w.inAltTab(playerHandle), host: w.inAltTab(hostHandle) };
  if (isWin) r.taskbar = taskbar();
  r.apps = macApps({ host: process.pid, player: handles.pid });

  // Fullscreen from the page.
  const tFs = now();
  r.fullscreen = { request: await p.peer.request('fullscreen', { on: true }).catch((e) => e.message) };
  const fsOn = await p.waitFor((m) => m.t === 'fullscreen' && m.on && m.tHost > tFs, 6000);
  await sleep(1500);
  const fsState = await p.peer.request('state');
  r.fullscreen.entered = Boolean(fsOn);
  r.fullscreen.bounds = fsState.bounds;
  r.fullscreen.display = screen.getDisplayMatching(host.win.getBounds()).bounds;
  r.fullscreen.capture = await p.peer.request('capture', { name: `glue-${variant}-fullscreen.png` }).catch((e) => e.message);
  await p.peer.request('fullscreen', { on: false }).catch(() => {});
  await sleep(1500);
  g.send('after fullscreen');
  await sleep(500);
  r.fullscreen.backInPlace = JSON.stringify((await p.peer.request('state')).bounds) === JSON.stringify(playerArea(host.win));

  if (variant === 'follow') r.followStats = await p.peer.request('follow-stats').catch((e) => e.message);
  r.hang = await hangTest(host, p, hostHandle);
  r.captures = { host: await captureHost(host, `glue-${variant}-host.png`), player: await p.peer.request('capture', { name: `glue-${variant}-player.png` }).catch((e) => e.message) };
  r.captures.composite = compose(`glue-${variant}-host.png`, `glue-${variant}-player.png`, 232, 8, `glue-${variant}-composite.png`, host.win.getContentBounds().width);
  r.close = await p.stop();
  r.totalMs = round(now() - start);
  host.win.destroy();
  return r;
}

async function scenarioFrameless() {
  const r = {};
  const p = await startPlayer();
  r.window = await p.peer.request('window', { style: 'frameless', bounds: { x: 80, y: 60, width: 900, height: 580 } });
  await p.peer.request('navigate', { local: PLAYING });
  await p.waitFor((m) => m.t === 'media' && m.paused === false, 30_000);
  await sleep(1500);
  r.capture = await p.peer.request('capture', { name: 'frameless.png' });
  const handles = await p.peer.request('handles');
  if (w) r.altTab = w.inAltTab(handleOf(Buffer.from(handles.native, 'hex')));
  if (isWin) r.taskbar = taskbar();
  r.apps = macApps({ player: handles.pid });
  r.close = await p.stop();
  if (isWin) {
    // The same, under the host's AppUserModelID: does Windows group it with "Chord"?
    const host = await makeHost();
    const p2 = await startPlayer();
    await p2.peer.request('window', { style: 'frameless', bounds: { x: 120, y: 100, width: 700, height: 420 }, appUserModelId: 'com.chord.spike.host' });
    await sleep(1500);
    r.sharedAppUserModelId = { taskbar: taskbar() };
    r.sharedAppUserModelId.close = await p2.stop();
    host.win.destroy();
  }
  return r;
}

/** (c) Windows: SetParent. Linux X11: XReparentWindow. */
async function scenarioChild() {
  const r = {};
  if (!(isWin && w) && !(isLinux && !wayland && koffiPath)) return { skipped: 'Windows with koffi, or Linux X11 with koffi, only' };
  const host = await makeHost();
  const p = await startPlayer();
  await p.peer.request('window', { style: 'child', bounds: playerArea(host.win) });
  await p.peer.request('navigate', { local: PLAYING });
  await p.waitFor((m) => m.t === 'media' && m.paused === false, 30_000);
  await sleep(1000);
  const handles = await p.peer.request('handles');
  const hostHandle = handleOf(host.win.getNativeWindowHandle());
  const playerHandle = handleOf(Buffer.from(handles.native, 'hex'));
  const scale = screen.getDisplayMatching(host.win.getBounds()).scaleFactor;
  const area = () => {
    const a = playerArea(host.win);
    const cb = host.win.getContentBounds();
    return [Math.round((a.x - cb.x) * scale), Math.round((a.y - cb.y) * scale), Math.round(a.width * scale), Math.round(a.height * scale)];
  };
  let x11 = null;
  let styleBefore = null;
  if (isWin) {
    r.before = { dpi: [w.dpi(hostHandle), w.dpi(playerHandle)], hostChildren: w.children(hostHandle).map((c) => `${c.class} pid=${c.pid === process.pid ? 'host' : c.pid === handles.pid ? 'player' : c.pid}`) };
    styleBefore = w.style(playerHandle);
    const t = now();
    r.adopt = w.adopt(playerHandle, hostHandle, ...area());
    r.adoptMs = round(now() - t);
    r.styleBefore = `0x${styleBefore.toString(16)}`;
    host.win.on('resize', () => w.move(playerHandle, ...area(), w.SWP.ASYNCWINDOWPOS));
  } else {
    const { createRequire } = await import('node:module');
    const koffi = createRequire(import.meta.url)(koffiPath);
    const lib = koffi.load('libX11.so.6');
    x11 = {
      open: lib.func('void *XOpenDisplay(const char *name)'),
      reparent: lib.func('int XReparentWindow(void *dpy, unsigned long w, unsigned long parent, int x, int y)'),
      move: lib.func('int XMoveResizeWindow(void *dpy, unsigned long w, int x, int y, unsigned int width, unsigned int height)'),
      map: lib.func('int XMapRaised(void *dpy, unsigned long w)'),
      flush: lib.func('int XFlush(void *dpy)'),
    };
    x11.dpy = x11.open(null);
    const [x, y, wd, ht] = area();
    const t = now();
    r.adopt = { reparent: x11.reparent(x11.dpy, playerHandle, hostHandle, x, y), map: x11.map(x11.dpy, playerHandle) };
    x11.move(x11.dpy, playerHandle, x, y, wd, ht);
    x11.flush(x11.dpy);
    r.adoptMs = round(now() - t);
    // In the first run the child ended up at the parent's (0, 0) shortly after; put it back once settled.
    await sleep(500);
    x11.move(x11.dpy, playerHandle, x, y, wd, ht);
    x11.flush(x11.dpy);
    host.win.on('resize', () => {
      x11.move(x11.dpy, playerHandle, ...area());
      x11.flush(x11.dpy);
    });
  }
  await sleep(1000);
  r.after = { playerState: await p.peer.request('state') };
  if (isWin) {
    r.after.ancestorIsHost = w.f.GetAncestor(playerHandle, 2) === hostHandle;
    r.after.hostChildren = w.children(hostHandle).map((c) => `${c.class} pid=${c.pid === process.pid ? 'host' : c.pid === handles.pid ? 'player' : c.pid}`);
    r.after.altTab = w.inAltTab(playerHandle);
    const [ax, ay, aw, ah] = area();
    const wr = w.rect(hostHandle);
    const cr = w.rect(playerHandle);
    const off = [cr.left - wr.left, cr.top - wr.top];
    const mid = [off[0] + Math.round(aw / 2), off[1] + Math.round(ah / 2)];
    r.composite = printWindow(hostHandle, 'child-composite.png', [mid, [off[0] - 100, mid[1]]]);
    // A Chord popover over the player: does the host's own view draw above a foreign child window?
    const overlay = new WebContentsView();
    overlay.setBackgroundColor('#ff0000');
    host.win.contentView.addChildView(overlay);
    overlay.setBounds({ x: 232 + 60, y: 60, width: 220, height: 140 });
    await sleep(600);
    const origin = screen.dipToScreenPoint({ x: host.win.getContentBounds().x, y: host.win.getContentBounds().y });
    const overlayMid = [origin.x - wr.left + Math.round((232 + 60 + 110) * scale), origin.y - wr.top + Math.round((60 + 70) * scale)];
    r.overlay = { ...printWindow(hostHandle, 'child-overlay.png', [overlayMid]), note: 'red at the point means the host view is drawn above the player' };
    host.win.contentView.removeChildView(overlay);
  }
  r.captureHostFrame = await captureHost(host, 'child-host-frame.png');

  // Drags and resizes: a child window moves with its parent by itself.
  const samplerActions = [];
  if (isWin) {
    samplerActions.push({ at: 300, do: 'press', abs: inputPoint(host.win, 110, 18) });
    for (let i = 1; i <= 60; i++) samplerActions.push({ at: 300 + i * 8, do: 'moveBy', d: [4, 2] });
    for (let i = 1; i <= 60; i++) samplerActions.push({ at: 800 + i * 8, do: 'moveBy', d: [-4, -2] });
    samplerActions.push({ at: 1350, do: 'release' });
  }
  const samplerRun = sample('child', { host: hostHandle, player: playerHandle, durationMs: 6200, actions: samplerActions });
  await sleep(1800);
  const tProg = now();
  await programmaticDrag(host.win);
  const tProgEnd = now();
  await sleep(300);
  const tResize = now();
  await programmaticResize(host.win);
  const tResizeEnd = now();
  const s = await samplerRun;
  const pressedAt = s?.events?.find((e) => e[1] === 'press')?.[0];
  const releasedAt = s?.events?.find((e) => e[1] === 'release')?.[0];
  r.realDrag = pressedAt ? trail(s.samples, pressedAt, releasedAt + 200) : null;
  r.programmaticDrag = s?.samples ? trail(s.samples, tProg, tProgEnd + 200) : s;
  r.programmaticResize = s?.samples ? trail(s.samples, tResize, tResizeEnd + 200) : null;

  // Focus and keys: click into the player, type, press Chord's shortcut.
  if (isWin) {
    const [ax, ay, aw, ah] = area();
    const cb = host.win.getContentBounds();
    const mid = Object.values(screen.dipToScreenPoint({ x: cb.x + (ax + aw / 2) / scale, y: cb.y + (ay + ah / 2) / scale }));
    const t = now();
    const s2 = await sample('child-keys', { host: hostHandle, player: playerHandle, durationMs: 900, actions: [{ at: 50, do: 'click', abs: mid }, { at: 300, do: 'keys', keys: ['A'] }, { at: 350, do: 'keys', keys: ['B'] }, { at: 500, do: 'keys', keys: ['CONTROL', 'T'] }] });
    const st = await p.peer.request('state');
    const fwd = await p.waitFor((m) => m.t === 'key' && m.tHost > t, 1500);
    r.input = {
      osFocusAfterClick: s2?.focus ?? null,
      foregroundIsHost: s2?.focus?.active === hostHandle,
      playerWindowFocused: st.focused,
      playerContentFocused: st.contentFocused,
      pageKeysSeen: st.page?.keysSeen ?? null,
      shortcutForwarded: Boolean(fwd),
      hostFrameKeys: host.keys.filter((k) => k.t > t).map((k) => k.key),
    };
  }

  // Minimize and restore the host.
  host.win.minimize();
  await sleep(800);
  r.minimized = { playerVisible: (await p.peer.request('state')).visible, ...(isWin ? { childVisible: w.f.IsWindowVisible(playerHandle) } : {}) };
  host.win.restore();
  await sleep(800);

  // Fullscreen as a child window.
  const tFs = now();
  r.fullscreen = { request: await p.peer.request('fullscreen', { on: true }).catch((e) => e.message) };
  r.fullscreen.entered = Boolean(await p.waitFor((m) => m.t === 'fullscreen' && m.on && m.tHost > tFs, 6000));
  await sleep(1500);
  r.fullscreen.playerThinks = (await p.peer.request('state')).bounds;
  if (isWin) {
    r.fullscreen.childRect = w.rect(playerHandle);
    r.fullscreen.hostRect = w.rect(hostHandle);
    r.fullscreen.composite = printWindow(hostHandle, 'child-fullscreen.png');
  }
  await p.peer.request('fullscreen', { on: false }).catch(() => {});
  await sleep(1200);

  r.hang = await hangTest(host, p, hostHandle);
  if (isWin) {
    w.release(playerHandle, styleBefore);
    await sleep(500);
    r.released = { parent: w.f.GetParent(playerHandle), state: await p.peer.request('state').catch((e) => e.message) };
  }
  r.close = await p.stop();
  host.win.destroy();
  return r;
}

// ---------------------------------------------------------------------- run

app.on('window-all-closed', () => {});
// Not awaited at the top level: Electron emits ready only after the entry module has finished.
void main();
async function main() {
await app.whenReady();
results.display = screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor, refreshRate: d.displayFrequency }));
const glueVariants = ['move', ...(isWin || isMac ? ['will-move', 'follow'] : []), ...(isWin ? ['owned'] : []), ...(isMac ? ['accessory', 'panel', 'panel-reset'] : [])];
for (const name of scenarios) {
  const runs = name === 'glue' ? glueVariants.map((v) => [`glue:${v}`, () => scenarioGlue(v)]) : [[name, { channel: scenarioChannel, navlock: scenarioNavlock, frameless: scenarioFrameless, child: scenarioChild }[name]]];
  for (const [label, run] of runs) {
    log('scenario', label);
    const t = now();
    try {
      results.scenarios[label] = await run();
    } catch (error) {
      results.scenarios[label] = { error: error.stack ?? String(error) };
      log('failed', label, error.message);
    }
    results.scenarios[label].ms = round(now() - t);
    save();
  }
}
log('done');
playerLog.end();
setTimeout(() => app.exit(0), 300);
}
