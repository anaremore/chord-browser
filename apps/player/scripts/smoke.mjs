// Chord Player's smoke test, per OS in CI (.github/workflows/player.yml):
// this script stands in for Chord. It unpacks the packaged zip the way Chord
// does (@chord/player-protocol's extractZip), starts the player on the
// control channel with a fresh profile, opens a Widevine test page
// (test-page.mjs, served here; the CDM, the stream and the licence come from
// the network), and checks it plays: the video advances and has a size, the
// player reports it playing, and pause and play answer. It captures the
// player's own window into <out>/player-window.png.
//
//   node apps/player/scripts/smoke.mjs --zip <chord-player-…zip> --out <folder>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executableIn, extractZip, LAUNCH_ENV, listen, newAddress, newSecret, playerEnv, PROTOCOL, PROTOCOL_MIN } from '../../../packages/player-protocol/src/index.ts';
import { artworkPng, watchPage } from './test-page.mjs';

const args = process.argv.slice(2);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const zip = resolve(opt('zip') ?? '');
const out = resolve(opt('out') ?? '.');
const log = (message) => console.log(`[smoke] ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never stuck: the whole test has five minutes.
setTimeout(() => {
  console.error('[smoke] Timed out');
  process.exit(3);
}, 300_000).unref();

const work = mkdtempSync(join(tmpdir(), 'chord-player-smoke-'));
let child;
const cleanup = () => {
  try {
    child?.kill();
  } catch {
    // gone already
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
};

try {
  log(`Unpacking ${zip}`);
  const folder = join(work, 'app');
  const unpacked = await extractZip(zip, folder, { maxBytes: 2 * 1024 ** 3 });
  log(`${unpacked.entries} files, ${(unpacked.bytes / 1e6).toFixed(1)} MB`);

  const art = artworkPng();
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/watch') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(watchPage());
    }
    if (path === '/art.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(art);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const origin = `http://www.netflix.com:${port}`;

  const address = newAddress();
  const secret = newSecret();
  const peers = [];
  const heard = { media: [], status: [], links: [], bye: false };
  const channel = await listen(address, secret, [PROTOCOL_MIN, PROTOCOL], (peer, hello) => {
    log(`Player ${hello.app} on ECS ${hello.ecs} (protocol ${hello.protocol}) connected`);
    peer.handle('media', (m) => heard.media.push(m));
    peer.handle('status', (m) => heard.status.push(m.cdm));
    peer.handle('link', (m) => heard.links.push(m.url));
    peer.handle('artwork', () => {});
    peer.handle('bye', () => (heard.bye = true));
    peers.push(peer);
  });

  const launch = JSON.stringify({ path: address.path, secret, profile: join(work, 'profile'), test: { hostResolverRules: 'MAP www.netflix.com 127.0.0.1', secureOrigins: [origin] } });
  const env = playerEnv(process.env);
  if (process.platform === 'win32') env[LAUNCH_ENV] = launch;
  const exe = join(folder, ...executableIn(process.platform).split('/'));
  log(`Starting ${exe}`);
  const started = Date.now();
  child = spawn(exe, [], { env, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => log(`Player exited (${code ?? signal})`));
  if (process.platform !== 'win32') child.stdin.end(`${launch}\n`);
  else child.stdin.end();

  while (!peers.length) {
    if (child.exitCode !== null) throw new Error('The player exited before connecting');
    if (Date.now() - started > 30_000) throw new Error('The player never connected');
    await sleep(100);
  }
  const peer = peers[0];
  log(`Channel open in ${Date.now() - started} ms`);

  const opened = await peer.request('open', { url: `${origin}/watch` }, 90_000);
  if (!opened.ok) throw new Error(`The player refused the page: ${opened.why}`);
  log(`Widevine: ${heard.status.join(' → ')}`);

  let state;
  const playUntil = Date.now() + 90_000;
  for (;;) {
    state = await peer.request('debug');
    if (state.video && state.video.currentTime > 3 && state.video.width > 0 && !state.video.paused) break;
    if (Date.now() > playUntil) throw new Error(`It never played: ${JSON.stringify(state)}`);
    await sleep(500);
  }
  log(`Playing: ${state.video.width}×${state.video.height}, ${state.video.currentTime.toFixed(1)} s in, ${state.video.frames ?? '?'} frames`);
  const lastMedia = () => heard.media.at(-1);
  if (!lastMedia()?.playing || lastMedia().title !== 'Angel One') throw new Error(`Chord wasn't told it plays: ${JSON.stringify(lastMedia())}`);

  writeFileSync(join(out, 'player-window.png'), Buffer.from(await peer.request('test', { do: 'capture' }), 'base64'));

  await peer.request('pause');
  await sleep(500);
  if (lastMedia()?.playing !== false) throw new Error('Pause didn’t reach the page');
  await peer.request('play');
  await sleep(1000);
  if (!lastMedia()?.playing) throw new Error('Play didn’t reach the page');
  log('Pause and play work');

  await peer.request('close');
  const quitBy = Date.now() + 15_000;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > quitBy) throw new Error('The player didn’t quit when asked');
    await sleep(100);
  }
  channel.close();
  server.close();
  address.cleanup();
  log('Passed');
} catch (error) {
  console.error(`[smoke] Failed: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
