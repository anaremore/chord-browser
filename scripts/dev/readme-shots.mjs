// The README's screenshots, on Windows: a throwaway profile, real public pages, and Chord's
// own window rendered by itself (PrintWindow through capture-window.ps1); the screen is never
// copied. The window material is forced solid, so nothing of the desktop shows through Mica,
// and the window sits off-screen while it's captured.
// Usage (from apps/desktop, after a build):
//   node ../../scripts/dev/readme-shots.mjs [out-dir]   (default: ../../docs/images)
/* global document, window -- used inside Playwright page callbacks */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const outDir = resolve(process.argv[2] ?? '../../docs/images');
mkdirSync(outDir, { recursive: true });
const appDir = process.cwd();
const captureScript = resolve(import.meta.dirname, 'capture-window.ps1');
const demoClaude = resolve(import.meta.dirname, 'readme-duet.mjs');
const SIZE = { width: 1440, height: 900 };

const swatch = { lilac: { l: 0.72, c: 0.12, h: 300 }, periwinkle: { l: 0.72, c: 0.12, h: 270 }, orchid: { l: 0.72, c: 0.13, h: 330 }, mint: { l: 0.72, c: 0.1, h: 165 }, sky: { l: 0.72, c: 0.11, h: 235 }, honey: { l: 0.72, c: 0.13, h: 85 }, tangerine: { l: 0.72, c: 0.15, h: 55 } };
const PAGES = {
  github: 'https://github.com/anaremore/chord-browser',
  mdn: 'https://developer.mozilla.org/en-US/',
  hn: 'https://news.ycombinator.com/',
  fifths: 'https://en.wikipedia.org/wiki/Circle_of_fifths',
  arpeggio: 'https://en.wikipedia.org/wiki/Arpeggio',
  electron: 'https://www.electronjs.org/docs/latest',
  webdev: 'https://web.dev/',
  chord: 'https://en.wikipedia.org/wiki/Chord_(music)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(appearance) {
  const config = mkdtempSync(join(tmpdir(), 'chord-shots-claude-'));
  const profile = mkdtempSync(join(tmpdir(), 'chord-shots-'));
  const env = {
    ...process.env,
    CHORD_USER_DATA: profile,
    CHORD_APPEARANCE: appearance,
    CHORD_HOME_URL: PAGES.chord,
    CHORD_DUET_CLAUDE: demoClaude,
    CHORD_DUET_CODEX: join(config, 'no-codex'),
    CLAUDE_CONFIG_DIR: config,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Off-screen windows keep painting only if Chromium doesn't treat them as covered.
  const app = await electron.launch({ args: [appDir, '--no-first-run', '--disable-features=CalculateNativeWinOcclusion'], env, cwd: appDir });
  // Chord's main process owns its windows (app.process() is Playwright's launcher).
  const chordPid = await app.evaluate(() => process.pid);
  let shell;
  for (let i = 0; i < 200 && !shell; i++) {
    shell = app.windows().find((p) => p.url().includes('shell'));
    if (!shell) await sleep(100);
  }
  if (!shell) throw new Error('no shell');
  await shell.evaluate(() => document.fonts.ready);
  // Solid material (Reduce transparency), so the capture holds Chord's pixels only; then off-screen.
  await app.evaluate(({ BaseWindow, nativeTheme }, size) => {
    Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { get: () => true, configurable: true });
    nativeTheme.emit('updated');
    const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === 'Chord');
    w?.setBounds({ x: -size.width - 200, y: 40, ...size });
  }, SIZE);

  const snap = () => shell.evaluate(() => window.chord.state.snapshot());
  const dispatch = (command) => shell.evaluate((c) => window.chord.state.dispatch(c), command);
  const run = (action) => shell.evaluate((a) => window.chord.action.run(a), action);
  const tabFor = async (url) => {
    const { state } = await snap();
    return Object.values(state.nodes).find((n) => n.kind === 'tab' && n.url === url);
  };
  const capture = (name) => {
    const file = join(outDir, `${name}.png`);
    // This Chord's window only: another Chord (the one you browse with) has the same title.
    execFileSync('pwsh', ['-NoProfile', '-File', captureScript, '-Title', 'Chord', '-ProcessId', String(chordPid), '-Out', file], { stdio: 'inherit' });
  };

  // Three chords, each with its own colors; back to the first to fill it.
  let { windowId, state } = await snap();
  const personal = state.windows[windowId].activeChordId;
  // Personal in Aurora, three colors; Work in Sea Glass; Music in Citrus.
  await dispatch({ t: 'chord.theme', chordId: personal, theme: { stops: [swatch.mint, swatch.periwinkle, swatch.orchid] } });
  await dispatch({ t: 'chord.create', windowId, name: 'Work', icon: '◆', theme: { stops: [swatch.mint, swatch.sky], grain: 0.2, appearance: 'auto' } });
  await dispatch({ t: 'chord.create', windowId, name: 'Music', icon: '♪', theme: { stops: [swatch.honey, swatch.tangerine], grain: 0.2, appearance: 'auto' } });
  await dispatch({ t: 'chord.activate', windowId, chordId: personal });
  await sleep(500);

  // Pinned tabs, a folder of two, and Today tabs; the Chord article on screen.
  for (const url of [PAGES.github, PAGES.mdn, PAGES.hn]) await dispatch({ t: 'tab.open', windowId, url, background: true, pinned: true });
  for (const url of [PAGES.fifths, PAGES.arpeggio, PAGES.electron, PAGES.webdev]) await dispatch({ t: 'tab.open', windowId, url, background: true });
  await sleep(4000);
  const fifths = await tabFor(PAGES.fifths);
  await dispatch({ t: 'tab.activate', windowId, nodeId: fifths.id });
  await run('folder.new');
  await sleep(500);
  // A new folder opens with its name selected for typing, as it does for you.
  await shell.keyboard.press('Control+A');
  await shell.keyboard.type('Theory');
  await shell.keyboard.press('Enter');
  await sleep(300);
  ({ state } = await snap());
  const folder = Object.values(state.nodes).find((n) => n.kind === 'folder');
  if (folder) {
    const arpeggio = await tabFor(PAGES.arpeggio);
    await dispatch({ t: 'node.move', nodeId: arpeggio.id, section: 'pinned', index: 1, parentId: folder.id });
  }
  const article = await tabFor(PAGES.chord);
  await dispatch({ t: 'tab.activate', windowId, nodeId: article.id });
  // The keyboard goes to the page, as after a click there: no focus ring left in the sidebar.
  await shell.evaluate(() => document.activeElement?.blur());
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.focus(), PAGES.chord);
  await shell.mouse.move(SIZE.width - 10, SIZE.height - 10);
  await sleep(5000);
  // Quit, then remove the throwaway profile and Duet's stand-in config.
  const close = async () => {
    await app.close();
    for (const dir of [profile, config]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };
  return { app, close, shell, snap, dispatch, run, tabFor, capture, windowId, article };
}

// Light: the window, Duet beside the article, and split view.
{
  const s = await session('light');
  try {
    s.capture('chord-light');

    await s.run('duet.toggle');
    const panel = s.shell.getByRole('complementary', { name: 'Duet' });
    await panel.getByRole('button', { name: 'Use this' }).first().click();
    await panel.getByRole('button', { name: 'Got it' }).click();
    const input = panel.getByRole('textbox', { name: 'Message Duet' });
    await input.fill('What’s a chord, in one line?');
    await input.press('Enter');
    await panel.getByText('In the article').waitFor({ timeout: 20_000 });
    await sleep(2500);
    s.capture('duet');
    await s.run('duet.toggle');
    await sleep(800);

    await s.dispatch({ t: 'split.add', windowId: s.windowId, withId: s.article.id, url: 'https://developer.mozilla.org/en-US/docs/Web/HTML' });
    await s.shell.mouse.move(SIZE.width - 10, SIZE.height - 10);
    await sleep(5000);
    s.capture('split-view');
  } finally {
    await s.close();
  }
}

// Dark: the window, the command bar, and Settings → Appearance.
{
  const s = await session('dark');
  try {
    s.capture('chord-dark');

    await s.run('tab.new');
    const overlay = s.app.windows().find((p) => p.url().includes('overlay'));
    await sleep(600);
    await overlay.keyboard.type('wiki', { delay: 60 });
    await sleep(1500);
    s.capture('command-bar');
    await overlay.keyboard.press('Escape');
    await sleep(500);

    await s.run('app.settings');
    let settings;
    for (let i = 0; i < 100 && !settings; i++) {
      settings = s.app.windows().find((p) => p.url().includes('settings'));
      if (!settings) await sleep(100);
    }
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await sleep(1500);
    await settings.screenshot({ path: join(outDir, 'themes.png') });
  } finally {
    await s.close();
  }
}
console.log(`screenshots in ${outDir}`);
