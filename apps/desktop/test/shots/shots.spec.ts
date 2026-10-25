/**
 * The README's and the website's screenshots: not a test, though Playwright runs it
 * (playwright.shots.config.ts, so the E2E suite never does). Made in the Linux E2E container by
 * scripts/dev/shots.mjs, on Xvfb, so no window opens on your desktop.
 *
 * Each launch has a throwaway profile (in the run's temp folder, removed when it ends) and real
 * public pages. Chord runs at 2× (--force-device-scale-factor), its window 1440 × 900 CSS pixels
 * at the screen's top left, so a picture is 2880 × 1800. A picture is the whole window as the
 * screen shows it: the shell, the pages over it and the caption buttons, from desktopCapturer's
 * copy of the screen cropped to the window, taken once two copies in a row agree (loads, fonts
 * and animations done). Duet's answer comes from demo-claude.mjs.
 *
 * Writes test-results/shots/<name>.png. The screen must hold the window at 2×: shots.mjs sets
 * CHORD_E2E_SCREEN for that.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appDir, dispatch, isOverlay, isSettings, isShell, launch, pageWhere, runAction, type ChordGlobal } from '../e2e/a11y-kit';
import { failOnMainErrors } from '../e2e/main-errors';

failOnMainErrors();

const outDir = resolve(appDir, 'test-results', 'shots');
const demoClaude = resolve(import.meta.dirname, 'demo-claude.mjs');
/** The window, in CSS pixels. */
const SIZE = { width: 1440, height: 900 };
const SCALE = 2;

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
  html: 'https://developer.mozilla.org/en-US/docs/Web/HTML',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeAll(() => {
  // Xvfb's screen, copied by desktopCapturer, and xdotool for the pointer: this needs X11.
  if (process.platform !== 'linux' || !process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']) {
    throw new Error('The screenshots are made in the Linux container, on X11: node scripts/dev/shots.mjs');
  }
  mkdirSync(outDir, { recursive: true });
});

/** Every page finished loading, or 30 s gone by: a page that never stops still draws. */
async function pagesLoaded(app: ElectronApplication): Promise<void> {
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
    if (!(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((c) => !c.isDestroyed() && c.isLoading())))) return;
  }
}

/** Every tab's site icon in, or 20 s gone by: a tab without one shows its monogram. */
async function iconsLoaded(shell: Page): Promise<void> {
  const missing = () =>
    shell.evaluate(async () => {
      const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
      return Object.values(state.nodes)
        .filter((n) => n.kind === 'tab' && !n.favicon)
        .map((n) => n.url);
    });
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(250)) if (!(await missing()).length) return;
  console.log(`[shots] No site icon for ${(await missing()).join(', ')}`);
}

/**
 * The window titled `title` as the screen shows it, in device pixels, once two copies of the
 * screen 300 ms apart agree (at most 8 s: a caret blinks), to test-results/shots/<name>.png.
 */
async function capture(app: ElectronApplication, title: string, name: string): Promise<void> {
  const png = await app.evaluate(
    async ({ BaseWindow, desktopCapturer, screen }, t) => {
      const win = BaseWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === t);
      if (!win) throw new Error(`No window titled ${t}`);
      const bounds = win.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      const scale = display.scaleFactor;
      const full = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
      const crop = { x: Math.round((bounds.x - display.bounds.x) * scale), y: Math.round((bounds.y - display.bounds.y) * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) };
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > full.width || crop.y + crop.height > full.height) {
        throw new Error(`${t} (${JSON.stringify(crop)}) isn't all on the screen (${full.width} × ${full.height})`);
      }
      const look = async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
        const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        if (!source) throw new Error('desktopCapturer found no screen');
        const size = source.thumbnail.getSize();
        // Full size, pixel for pixel: a smaller copy would be a scaled one.
        if (size.width !== full.width || size.height !== full.height) throw new Error(`The screen came back at ${size.width} × ${size.height}, not ${full.width} × ${full.height}`);
        return source.thumbnail.crop(crop);
      };
      let last = await look();
      for (const end = Date.now() + 8000; Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 300));
        const next = await look();
        const same = next.toBitmap().equals(last.toBitmap());
        last = next;
        if (same) break;
      }
      return last.toPNG().toString('base64');
    },
    title,
  );
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'));
}

/** A tab by its address. */
async function tabFor(shell: Page, url: string) {
  return shell.evaluate(async (u) => {
    const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab' && n.url === u);
    if (!tab) throw new Error(`No tab at ${u}`);
    return tab;
  }, url);
}

/** Playwright's mouse, which the page it's given thinks is the pointer, rested where nothing hovers. */
const rest = (page: Page) => page.mouse.move(SIZE.width - 10, SIZE.height - 10);

async function session(appearance: 'light' | 'dark') {
  // Duet's stand-in keeps its session files here; no Codex (a path that doesn't exist).
  const config = mkdtempSync(join(tmpdir(), 'chord-shots-claude-'));
  const app = await launch(
    { CHORD_APPEARANCE: appearance, CHORD_HOME_URL: PAGES.chord, CHORD_DUET_CLAUDE: demoClaude, CHORD_DUET_CODEX: join(config, 'no-codex'), CLAUDE_CONFIG_DIR: config },
    { args: [`--force-device-scale-factor=${SCALE}`] },
  );
  const shell = await pageWhere(app, isShell);
  await shell.evaluate(() => document.fonts.ready);

  // The window at the screen's top left, which must hold it at 2×.
  const screenSize = await app.evaluate(({ BaseWindow, screen }, size) => {
    BaseWindow.getAllWindows()
      .find((w) => w.getTitle() === 'Chord')
      ?.setBounds({ x: 0, y: 0, ...size });
    const { size: s, scaleFactor } = screen.getPrimaryDisplay();
    return { width: Math.round(s.width * scaleFactor), height: Math.round(s.height * scaleFactor), scaleFactor };
  }, SIZE);
  if (screenSize.scaleFactor !== SCALE || screenSize.width < SIZE.width * SCALE || screenSize.height < SIZE.height * SCALE) {
    throw new Error(`The screen is ${screenSize.width} × ${screenSize.height} at ${screenSize.scaleFactor}×: it needs to hold ${SIZE.width} × ${SIZE.height} at ${SCALE}× (scripts/dev/shots.mjs sets CHORD_E2E_SCREEN)`);
  }
  // The system's pointer, off the window: Xvfb starts it in the middle of the screen, over the page.
  execFileSync('xdotool', ['mousemove', String(screenSize.width - 1), String(screenSize.height - 1)]);

  // Three chords, each with its own colors; back to the first to fill it.
  // Personal in Aurora, three colors; Work in Sea Glass; Music in Citrus.
  const { windowId, state } = await shell.evaluate(() => (window as unknown as ChordGlobal).chord.state.snapshot());
  const personal = state.windows[windowId]!.activeChordId;
  await dispatch(shell, { t: 'chord.theme', chordId: personal, theme: { stops: [swatch.mint, swatch.periwinkle, swatch.orchid] } });
  await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: '◆', theme: { stops: [swatch.mint, swatch.sky], grain: 0.2, appearance: 'auto' } });
  await dispatch(shell, { t: 'chord.create', windowId, name: 'Music', icon: '♪', theme: { stops: [swatch.honey, swatch.tangerine], grain: 0.2, appearance: 'auto' } });
  await dispatch(shell, { t: 'chord.activate', windowId, chordId: personal });

  // Pinned tabs, a folder of two, and Today tabs; the Chord article on screen.
  for (const url of [PAGES.github, PAGES.mdn, PAGES.hn]) await dispatch(shell, { t: 'tab.open', windowId, url, background: true, pinned: true });
  for (const url of [PAGES.fifths, PAGES.arpeggio, PAGES.electron, PAGES.webdev]) await dispatch(shell, { t: 'tab.open', windowId, url, background: true });
  await pagesLoaded(app);
  const fifths = await tabFor(shell, PAGES.fifths);
  await dispatch(shell, { t: 'tab.activate', windowId, nodeId: fifths.id });
  await runAction(shell, 'folder.new');
  await sleep(500);
  // A new folder opens with its name selected for typing, as it does for you.
  await shell.keyboard.press('Control+A');
  await shell.keyboard.type('Theory');
  await shell.keyboard.press('Enter');
  await sleep(300);
  const folder = await shell.evaluate(async () => {
    const { state: s } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    return Object.values(s.nodes).find((n) => n.kind === 'folder');
  });
  if (!folder) throw new Error('folder.new made no folder');
  const arpeggio = await tabFor(shell, PAGES.arpeggio);
  await dispatch(shell, { t: 'node.move', nodeId: arpeggio.id, section: 'pinned', index: 1, parentId: folder.id });
  const article = await tabFor(shell, PAGES.chord);
  await dispatch(shell, { t: 'tab.activate', windowId, nodeId: article.id });
  // The keyboard goes to the page, as after a click there: no focus ring left in the sidebar.
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.focus(), PAGES.chord);
  await rest(shell);
  await pagesLoaded(app);
  await iconsLoaded(shell);
  return { app, shell, windowId, article };
}

test('light: the window, Duet beside the article, and split view', async () => {
  const { app, shell, windowId, article } = await session('light');
  try {
    await capture(app, 'Chord', 'chord-light');

    await runAction(shell, 'duet.toggle');
    const panel = shell.getByRole('complementary', { name: 'Duet' });
    await panel.getByRole('button', { name: 'Use this' }).first().click();
    await panel.getByRole('button', { name: 'Got it' }).click();
    const input = panel.getByRole('textbox', { name: 'Message Duet' });
    await input.fill('What’s a chord, in one line?');
    await input.press('Enter');
    await panel.getByText('In the article').waitFor({ timeout: 20_000 });
    await rest(shell);
    await capture(app, 'Chord', 'duet');
    await runAction(shell, 'duet.toggle');
    await panel.waitFor({ state: 'hidden' });

    await dispatch(shell, { t: 'split.add', windowId, withId: article.id, url: PAGES.html });
    await rest(shell);
    await pagesLoaded(app);
    await iconsLoaded(shell);
    await capture(app, 'Chord', 'split-view');
  } finally {
    await app.close();
  }
});

test('dark: the window, the command bar, and Settings → Appearance', async () => {
  const { app, shell } = await session('dark');
  try {
    await capture(app, 'Chord', 'chord-dark');

    await runAction(shell, 'tab.new');
    const overlay = await pageWhere(app, isOverlay);
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('wiki', { delay: 60 });
    const results = overlay.getByRole('listbox', { name: 'Results' }).getByRole('option');
    // The search, Wikipedia's search, three open tabs, then the search engine's suggestions.
    await results.nth(5).waitFor({ timeout: 15_000 });
    await capture(app, 'Chord', 'command-bar');
    await overlay.keyboard.press('Escape');

    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
    await rest(settings);
    await capture(app, 'Chord Settings', 'themes');
  } finally {
    await app.close();
  }
});
