// Design QA on Windows: drives Chord like a person and captures the real,
// composited window at each step (Mica, caption buttons, every view).
// Usage (from apps/desktop, after a build):
//   node ../../scripts/dev/qa-windows.mjs <out-dir> [light|dark]
/* global document, window -- used inside Playwright page callbacks */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const outDir = resolve(process.argv[2] ?? 'qa');
const appearance = process.argv[3] ?? 'dark';
mkdirSync(outDir, { recursive: true });
const appDir = process.cwd();
const captureScript = resolve(import.meta.dirname, 'capture-window.ps1');

const env = { ...process.env, CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-qa-')), CHORD_APPEARANCE: appearance };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Opens the command bar through the shell's own API rather than injecting OS
// keystrokes, which would go to whatever window has focus on a shared desktop.
const openBar = (shell, mode) =>
  shell.evaluate((m) => window.chord.overlay.open(m), mode);

const capture = (name) => {
  const file = join(outDir, `${appearance}-${name}.png`);
  execFileSync('pwsh', ['-NoProfile', '-File', captureScript, '-Title', 'Chord', '-Out', file], { stdio: 'inherit' });
};

const app = await electron.launch({ args: [appDir], env, cwd: appDir });
try {
  const find = async (match) => {
    for (let i = 0; i < 100; i++) {
      const page = app.windows().find((p) => match(p.url()));
      if (page) return page;
      await sleep(100);
    }
    throw new Error(`no page; have ${app.windows().map((p) => p.url())}`);
  };
  const shell = await find((u) => u.includes('shell'));
  const overlay = await find((u) => u.includes('overlay'));
  await shell.evaluate(() => document.fonts.ready);
  await sleep(2500);
  capture('1-start');

  for (const [query, wait] of [
    ['github.com', 2500],
    ['en.wikipedia.org/wiki/Chord_(music)', 2500],
    ['pasta al limone', 2500],
  ]) {
    await openBar(shell, 'new');
    await sleep(250);
    if (query === 'github.com') capture('2-command-bar-empty');
    await overlay.keyboard.type(query, { delay: 15 });
    await sleep(200);
    if (query === 'github.com') capture('3-command-bar-typed');
    await overlay.keyboard.press('Enter');
    await sleep(wait);
  }
  capture('4-tabs');

  await openBar(shell, 'edit');
  await sleep(300);
  capture('5-edit-address');
  await overlay.keyboard.press('Escape');
  await sleep(300);

  await openBar(shell, 'new');
  await overlay.keyboard.type('wiki', { delay: 15 });
  await sleep(250);
  capture('6-switch-to-tab');
  await overlay.keyboard.press('Escape');
} finally {
  await app.close();
}
console.log('captures in', outDir);
