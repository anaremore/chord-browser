// Interface size (Settings → Appearance, DESIGN.md §10) at 100%, 125% and 150%, on Windows:
// the browser window with a real page and the command bar, and the Settings window. A
// throwaway profile; each capture is Chord's own window rendered by itself (PrintWindow
// through capture-window.ps1), never the screen, off-screen with a solid material.
// Usage (from apps/desktop, after a build):
//   node ../../scripts/dev/qa-ui-scale.mjs [out-dir]   (default: ../../.qa/interface-size)
/* global window -- used inside Playwright page callbacks */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const outDir = resolve(process.argv[2] ?? '../../.qa/interface-size');
mkdirSync(outDir, { recursive: true });
const appDir = process.cwd();
const captureScript = resolve(import.meta.dirname, 'capture-window.ps1');
const SIZE = { width: 1280, height: 820 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'chord-qa-'));
const env = { ...process.env, CHORD_USER_DATA: profile, CHORD_HOME_URL: 'https://en.wikipedia.org/wiki/Chord_(music)' };
delete env.ELECTRON_RUN_AS_NODE;
// Off-screen windows keep painting only if Chromium doesn't treat them as covered.
const app = await electron.launch({ args: [appDir, '--no-first-run', '--disable-features=CalculateNativeWinOcclusion'], env, cwd: appDir });
try {
  // Chord's main process owns its windows (app.process() is Playwright's launcher).
  const chordPid = await app.evaluate(() => process.pid);
  const find = async (part) => {
    for (let i = 0; i < 200; i++) {
      const page = app.windows().find((p) => p.url().includes(part));
      if (page) return page;
      await sleep(100);
    }
    throw new Error(`no ${part}`);
  };
  const shell = await find('shell');
  const place = (title, x) =>
    app.evaluate(
      ({ BaseWindow, nativeTheme }, { title, x, size }) => {
        Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { get: () => true, configurable: true });
        nativeTheme.emit('updated');
        BaseWindow.getAllWindows()
          .find((w) => w.getTitle() === title)
          ?.setBounds({ x, y: 40, ...size });
      },
      { title, x, size: SIZE },
    );
  await place('Chord', -SIZE.width - 200);
  await shell.evaluate(() => window.chord.action.run('app.settings'));
  const settings = await find('settings');
  await place('Chord Settings', -2 * SIZE.width - 400);
  const capture = (title, name) =>
    execFileSync('pwsh', ['-NoProfile', '-File', captureScript, '-Title', title, '-ProcessId', String(chordPid), '-Out', join(outDir, `${name}.png`)], { stdio: 'inherit' });

  for (const scale of [1, 1.25, 1.5]) {
    await settings.evaluate((uiScale) => window.chord.settings.set({ uiScale }), scale);
    await sleep(2500);
    const pct = Math.round(scale * 100);
    capture('Chord', `window-${pct}`);
    capture('Chord Settings', `settings-window-${pct}`);
    await shell.evaluate(() => window.chord.action.run('tab.new'));
    await sleep(800);
    capture('Chord', `command-bar-${pct}`);
    // The command bar is the overlay's: Esc goes there.
    await (await find('overlay')).keyboard.press('Escape');
    await sleep(400);
  }
} finally {
  await app.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
