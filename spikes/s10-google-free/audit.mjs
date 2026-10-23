// Spike S10: which hosts does Chord itself contact? (docs/decisions/S10-google-free.md)
//
// Runs the development build with Chromium's net log in two sessions on a
// fresh profile, and lists every host each one contacted:
//   A. first launch with the defaults (its first tab is the home page);
//   B. a local page only: type in the command bar, and leave a misspelled
//      textarea focused so spellcheck runs.
// In session B, --spell <lang> first picks a spelling language in Settings,
// and --google-free first turns Google-free mode on.
//
// Usage, from apps/desktop after `pnpm build`:
//   node ../../spikes/s10-google-free/audit.mjs [--seconds 40] [--spell nl] [--google-free]
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Node 24 runs TypeScript files directly; the Google-free test reads net logs the same way.
import { contactedHosts } from '../../apps/desktop/test/e2e/netlog.ts';

process.on('uncaughtException', (e) => {
  console.error(e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e);
  process.exit(1);
});

const appDir = resolve('.');
const require = createRequire(join(appDir, 'package.json'));
const { _electron: electron } = require('@playwright/test');
const args = process.argv.slice(2);
const googleFree = args.includes('--google-free');
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 40;
/** A spelling language for session B, set in Settings (one Windows doesn't check itself makes Chromium download a dictionary). */
const spell = args.includes('--spell') ? args[args.indexOf('--spell') + 1] : null;

const page = `<!doctype html><title>Local page</title><p>Nothing here talks to the network.</p>
<textarea id="t" autofocus spellcheck="true">Thsi sentense has speling misteaks.</textarea>
<script>document.getElementById('t').focus();</script>`;
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

async function session(name, env, prepare) {
  const profile = mkdtempSync(join(tmpdir(), 'chord-s10-'));
  const log = join(profile, 'netlog.json');
  const childEnv = { ...process.env, CHORD_USER_DATA: profile, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (prepare) await prepare(profile, childEnv);
  const app = await electron.launch({ args: [appDir, '--no-first-run', `--log-net-log=${log}`], env: childEnv, cwd: appDir });
  let shell;
  for (let i = 0; i < 100 && !shell; i++) {
    shell = app.windows().find((w) => w.url().startsWith('chord://shell') || w.url().includes('/shell/index.html'));
    if (!shell) await new Promise((r) => setTimeout(r, 100));
  }
  if (name === 'B' && (spell || googleFree)) {
    await shell.evaluate(() => globalThis.chord.action.run('app.settings'));
    let settings;
    for (let i = 0; i < 100 && !settings; i++) {
      settings = app.windows().find((w) => w.url().startsWith('chord://settings') || w.url().includes('/settings/index.html'));
      if (!settings) await new Promise((r) => setTimeout(r, 100));
    }
    await settings.waitForTimeout(500);
    if (googleFree) await settings.evaluate(() => globalThis.chord.settings.set({ googleFree: true }));
    if (spell) await settings.evaluate((language) => globalThis.chord.settings.set({ spellcheck: { language } }), spell);
    await shell.bringToFront();
    // Reload the local page so its textarea checks spelling in the new language.
    const tab = app.windows().find((w) => w.url().startsWith(origin));
    await tab?.reload();
  }
  if (name === 'B') {
    // Type a search: suggestions are fetched as you type.
    await shell.evaluate(() => globalThis.chord.overlay.open('new'));
    const overlay = app.windows().find((w) => w.url().includes('overlay'));
    await overlay.waitForTimeout(500);
    await overlay.keyboard.type('weather tomorrow', { delay: 80 });
    await overlay.waitForTimeout(2000);
    await overlay.keyboard.press('Escape');
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await app.close();
  const hosts = contactedHosts(log);
  console.log(`\n${name}${googleFree && name === 'B' ? ' (Google-free mode)' : ''}: ${hosts.size} hosts`);
  for (const [host, how] of [...hosts].sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${host}\n    ${[...how].slice(0, 6).join('\n    ')}`);
  return hosts;
}

await session('A', {});
await session('B', { CHORD_HOME_URL: `${origin}/` });
server.close();
