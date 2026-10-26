/**
 * The accessibility audit (ROADMAP.md M1.6): axe on every Chord surface, in
 * light and dark, across the capture matrix's chord themes (DESIGN.md §12).
 * Serious and critical problems fail; so does text over the tint whose
 * contrast, computed from the theme tokens, is under WCAG AA (a11y-kit.ts).
 *
 * Also here: the screen-reader structure of the sidebar, the command bar,
 * Settings and Duet (aria snapshots), Windows High Contrast (forced colors,
 * with captures), reduced motion both ways, and reduced transparency.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  audit,
  capturesDir,
  closedPort,
  dispatch,
  expectClean,
  fakeClaude,
  fixtureExtension,
  clickLink,
  isArchive,
  isMini,
  isOverlay,
  isPopover,
  isPreview,
  isSettings,
  isShell,
  launch,
  leavePlaying,
  newPage,
  pageWhere,
  runAction,
  setTheme,
  settle,
  startSite,
  tabIdByTitle,
  where,
  THEMES,
  turnOnSidebarPeek,
  type Finding,
  type ThemeName,
} from './a11y-kit';
import { ARTWORK_PNG, mediaPage } from '../fixtures/media';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const APPEARANCES = ['light', 'dark'] as const;

let site: Awaited<ReturnType<typeof startSite>>;
test.beforeAll(async () => {
  site = await startSite({
    '/': '<title>First page</title><h1>First</h1><p>A chord is three notes played together.</p>',
    '/second': '<title>Second page</title><p>Another page.</p>',
    '/third': '<title>Third page</title><p>And one more.</p>',
    '/article': '<title>Article</title><h1>Chords</h1><p>Chords are three notes played together, and they sound full.</p>',
    // A pinned page whose link goes to another site (localhost): it opens in Peek.
    '/pinned': '<title>Pinned</title><p><a id="out" href="http://localhost:{port}/other">Elsewhere</a></p>',
    '/other': '<title>Other</title><p>Another site.</p>',
    '/other2': '<title>Other 2</title><p>More of it.</p>',
    // Pages that play sound: what the Now playing card shows (with artwork), and one without Media Session.
    '/song': mediaPage({
      title: 'Song page',
      track: { title: 'Chord Song', artist: 'The Notes', album: 'Triads', artwork: `data:image/png;base64,${ARTWORK_PNG.toString('base64')}` },
    }),
    '/radio': mediaPage({ title: 'Radio' }),
    // A page that shares what Chord's picker gives it.
    '/meet':
      '<title>Meet</title><button id="share">Share</button><script>document.getElementById("share").onclick = () => ' +
      'navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(() => { document.title = "Sharing"; });</script>',
  });
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

const today = (shell: Page) => shell.getByRole('tree', { name: 'Today' });
const pinned = (shell: Page) => shell.getByRole('tree', { name: 'Pinned' });

/** Opens a tab and waits for its row. */
async function openTab(shell: Page, path: string, title: string): Promise<void> {
  const { windowId } = await where(shell);
  await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}${path}` });
  await expect(today(shell).getByRole('treeitem', { name: title, exact: true })).toBeVisible();
}

/** The tab view's contents in the first window (index 1 in its view tree). */
const navigate = (app: ElectronApplication, url: string) =>
  app.evaluate(({ BaseWindow, WebContentsView }, u) => {
    const tab = BaseWindow.getAllWindows().find((w) => w.getTitle() !== 'Chord Settings')!.contentView.children[1];
    if (tab instanceof WebContentsView) void tab.webContents.loadURL(u).catch(() => {});
  }, url);

for (const mode of APPEARANCES) {
  test.describe(`${mode}`, () => {
    test(`the browser window: sidebar, toolbar, toasts, minimal bar and peek, split view, previews, error and crash pages, archive (${mode})`, async () => {
      test.setTimeout(180_000);
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode, CHORD_LOAD_EXTENSION: fixtureExtension });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        await expect(today(shell)).toContainText('First page');
        await openTab(shell, '/second', 'Second page');
        await openTab(shell, '/third', 'Third page');
        // A pinned tab inside a folder, and one beside it: the tree's levels.
        const second = await tabIdByTitle(shell, 'Second page');
        await dispatch(shell, { t: 'tab.pin', nodeId: second });
        await runAction(shell, 'folder.new');
        await expect(pinned(shell).getByRole('treeitem', { name: 'Second page', exact: true })).toBeVisible();
        await shell.keyboard.press('Escape');
        await expect(shell.locator('[data-placement="sidebar"]')).toBeVisible({ timeout: 20_000 });

        for (const theme of ['dusk', 'graphite', 'coral', 'aurora'] satisfies ThemeName[]) {
          await setTheme(shell, theme);
          findings.push(...(await audit(shell, `sidebar, ${theme}`, { appearance: mode })));
        }

        // A toast (Clear archives Today, with Undo), and the chord icon picker.
        await runAction(shell, 'today.clear');
        const toast = shell.getByRole('group').filter({ hasText: /Archived \d tabs?/ });
        await expect(toast).toBeVisible();
        findings.push(...(await audit(shell, 'toast', { appearance: mode })));
        await toast.getByRole('button', { name: 'Undo' }).click();
        await expect(today(shell).getByRole('treeitem', { name: 'First page', exact: true })).toBeVisible();
        await shell.getByRole('button', { name: 'Change icon' }).click();
        await expect(shell.getByRole('dialog', { name: 'Chord icon' })).toBeVisible();
        findings.push(...(await audit(shell, 'icon picker', { appearance: mode })));
        await shell.keyboard.press('Escape');

        // Hover preview of a pinned tab.
        await pinned(shell).getByRole('treeitem', { name: 'Second page', exact: true }).hover();
        const preview = await pageWhere(app, isPreview);
        await expect(preview.getByRole('tooltip')).toBeVisible();
        findings.push(...(await audit(preview, 'hover preview', { appearance: mode })));
        await shell.mouse.move(600, 400);

        // Split view: two panes and the divider between them.
        const { windowId, tabId } = await where(shell);
        await dispatch(shell, { t: 'split.add', windowId, withId: tabId, url: `${site.origin}/article` });
        await expect(shell.getByRole('separator', { name: 'Resize split panes' })).toBeVisible();
        findings.push(...(await audit(shell, 'split view', { appearance: mode })));
        await runAction(shell, 'split.separate');
        await expect(shell.getByRole('separator', { name: 'Resize split panes' })).toHaveCount(0);

        // The minimal bar, and the sidebar peeking over the page (turned on in Settings: it's off by default).
        await turnOnSidebarPeek(app, shell);
        // Docked and peeking, the sidebar should look the same (design QA: test-results/captures).
        await shell.screenshot({ path: resolve(capturesDir, `sidebar-docked-${mode}.png`) });
        await runAction(shell, 'view.toggleSidebar');
        await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
        findings.push(...(await audit(shell, 'minimal bar', { appearance: mode })));
        await shell.mouse.move(2, 300);
        await expect(shell.locator('[data-peek]')).toBeVisible();
        // Into the sidebar, which keeps it: the test's real cursor sits mid-window, over the page.
        await shell.mouse.move(60, 300, { steps: 3 });
        findings.push(...(await audit(shell, 'peek', { appearance: mode })));
        await expect(shell.locator('[data-peek]')).toBeVisible();
        await shell.waitForTimeout(400);
        await shell.screenshot({ path: resolve(capturesDir, `sidebar-peek-${mode}.png`) });
        await shell.mouse.move(700, 400);
        await runAction(shell, 'view.toggleSidebar');

        // A page that can't load.
        await navigate(app, `http://127.0.0.1:${await closedPort()}/`);
        await expect(shell.getByRole('alert')).toContainText('can’t be reached');
        findings.push(...(await audit(shell, 'error page', { appearance: mode })));
        await navigate(app, `${site.origin}/third`);
        await expect(shell.getByRole('alert')).toBeHidden();

        // A page that keeps crashing (Chord reloads it twice, then explains).
        // The tab on screen (the window's view 1), which other tabs of the site mustn't stand in for.
        const crashes = () => app.evaluate(() => (globalThis as { crashes?: number }).crashes ?? 0);
        await app.evaluate(({ BaseWindow, WebContentsView }) => {
          const counter = globalThis as { crashes?: number; crashing?: number };
          const view = BaseWindow.getAllWindows().find((w) => w.getTitle() !== 'Chord Settings')!.contentView.children[1];
          if (!(view instanceof WebContentsView)) throw new Error('No tab on screen');
          counter.crashes = 0;
          counter.crashing = view.webContents.id;
          view.webContents.on('render-process-gone', () => void counter.crashes!++);
        });
        const page = (check: 'ready' | 'crash') =>
          app.evaluate(({ webContents }, what) => {
            const c = webContents.fromId((globalThis as { crashing?: number }).crashing!);
            if (!c) return false;
            if (what === 'ready') return !c.isCrashed() && !c.isLoading();
            c.forcefullyCrashRenderer();
            return true;
          }, check);
        for (let i = 1; i <= 3; i++) {
          await expect.poll(() => page('ready'), { timeout: 10_000 }).toBe(true);
          expect(await page('crash')).toBe(true);
          await expect.poll(crashes).toBe(i);
        }
        await expect(shell.getByRole('alert')).toContainText('This page stopped working.');
        findings.push(...(await audit(shell, 'crash page', { appearance: mode })));

        // The archive page.
        await runAction(shell, 'app.history');
        const archive = await pageWhere(app, isArchive);
        await expect(archive.getByRole('heading', { name: 'Archive' })).toBeVisible();
        findings.push(...(await audit(archive, 'archive', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`the command bar, panels and popovers (${mode})`, async () => {
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode, CHORD_LOAD_EXTENSION: fixtureExtension });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        const overlay = await pageWhere(app, isOverlay);
        await expect(today(shell)).toContainText('First page');
        await openTab(shell, '/second', 'Second page');
        await setTheme(shell, 'aurora');

        // New tab, with tabs, actions and the search row.
        await runAction(shell, 'tab.new');
        await expect(overlay.getByRole('combobox')).toBeFocused();
        await overlay.keyboard.type('se');
        await expect(overlay.getByRole('option').first()).toBeVisible();
        findings.push(...(await audit(overlay, 'command bar', { appearance: mode })));
        await overlay.keyboard.press('Escape');
        // Editing the address, and "Split with…".
        await runAction(shell, 'address.edit');
        await expect(overlay.getByRole('dialog', { name: 'Edit address' })).toBeVisible();
        findings.push(...(await audit(overlay, 'command bar (address)', { appearance: mode })));
        await overlay.keyboard.press('Escape');
        await runAction(shell, 'split.with');
        await expect(overlay.getByRole('option').first()).toBeVisible();
        findings.push(...(await audit(overlay, 'command bar (split with)', { appearance: mode })));
        await overlay.keyboard.press('Escape');

        // The downloads panel and the extensions list.
        await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('downloads'));
        await expect(overlay.getByRole('dialog', { name: 'Downloads' })).toBeVisible();
        findings.push(...(await audit(overlay, 'downloads', { appearance: mode })));
        await overlay.keyboard.press('Escape');
        // Taking a screenshot: the capture bar over the page.
        await runAction(shell, 'page.screenshot');
        const capture = overlay.getByRole('dialog', { name: 'Take a screenshot' });
        await expect(capture).toBeVisible();
        findings.push(...(await audit(overlay, 'screenshot capture', { appearance: mode })));
        await overlay.keyboard.press('Escape');
        await expect(capture).toHaveCount(0);
        await expect(shell.locator('[data-placement="sidebar"]')).toBeVisible({ timeout: 20_000 });
        await shell.locator('[data-placement="sidebar"]').getByRole('button', { name: 'Extensions' }).click();
        await expect(overlay.getByRole('dialog', { name: 'Extensions' })).toBeVisible();
        findings.push(...(await audit(overlay, 'extensions list', { appearance: mode })));
        await overlay.keyboard.press('Escape');

        // Find in page, and a permission prompt.
        const popover = await pageWhere(app, isPopover);
        await runAction(shell, 'view.find');
        await expect(popover.getByRole('search', { name: 'Find in page' })).toBeVisible();
        await popover.keyboard.type('chord');
        findings.push(...(await audit(popover, 'find', { appearance: mode })));
        await popover.keyboard.press('Escape');
        const tab = await pageWhere(app, (url) => url === `${site.origin}/second`);
        await tab.evaluate(() => void Notification.requestPermission());
        await expect(popover.getByRole('alertdialog')).toBeVisible();
        findings.push(...(await audit(popover, 'permission prompt', { appearance: mode })));
        await popover.getByRole('alertdialog').getByRole('button', { name: 'Block' }).click();
        // The Effects card (DESIGN.md §7.15), with a preset on and your CSS in it.
        await runAction(shell, 'effects.open');
        const effects = popover.getByRole('dialog', { name: /^Effects on / });
        await expect(effects).toBeVisible();
        await effects.getByRole('button', { name: 'Reading width' }).click();
        await effects.getByLabel('Your CSS').fill('h1 { letter-spacing: 0.01em }');
        await expect(effects.getByRole('button', { name: 'Remove all Effects on this site' })).toBeVisible();
        findings.push(...(await audit(popover, 'Effects card', { appearance: mode })));
        await effects.getByRole('button', { name: 'Close Effects' }).click();
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`Settings, every section (${mode})`, async () => {
      test.setTimeout(120_000);
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode, CHORD_LOAD_EXTENSION: fixtureExtension });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        await expect(today(shell)).toContainText('First page');
        await setTheme(shell, 'coral');
        // A site with a permission answered, so Site permissions lists one.
        const popover = await pageWhere(app, isPopover);
        const tab = await pageWhere(app, (url) => url.startsWith(site.origin));
        await tab.evaluate(() => void Notification.requestPermission());
        await popover.getByRole('alertdialog').getByRole('button', { name: 'Allow' }).click();

        await runAction(shell, 'app.settings');
        const settings = await pageWhere(app, isSettings);
        const nav = settings.getByRole('navigation', { name: 'Settings sections' });
        for (const name of ['General', 'Appearance', 'Motion', 'Privacy', 'Effects', 'Site permissions', 'Extensions', 'Import', 'Duet', 'Keyboard shortcuts', 'About']) {
          await nav.getByRole('button', { name }).click();
          await expect(settings.getByRole('heading', { level: 1 }).first()).toBeVisible();
          await settings.waitForTimeout(250);
          findings.push(...(await audit(settings, `Settings → ${name}`, { appearance: mode })));
          // Native parts are drawn for the theme's appearance, so a select's list of options reads in every theme.
          const schemes = await settings.locator('select').evaluateAll((els) => els.map((el) => getComputedStyle(el).colorScheme));
          expect(schemes.every((scheme) => scheme === mode), `Settings → ${name}, each select's color-scheme: ${schemes.join(', ')}`).toBe(true);
          if (name === 'About') await settings.getByRole('heading', { name: 'Chord', level: 1 }).locator('..').screenshot({ path: resolve(capturesDir, `settings-about-${mode}.png`) });
          if (name === 'Appearance') {
            // The theme editor with its color wheel, and importing a theme.
            await settings.getByRole('button', { name: 'Create theme' }).click();
            await expect(settings.getByRole('slider', { name: 'Color 1' })).toBeVisible();
            findings.push(...(await audit(settings, 'Settings → Appearance → theme editor', { appearance: mode })));
            await settings.getByRole('button', { name: 'Cancel' }).click();
            await settings.getByRole('main').getByRole('button', { name: 'Import' }).click();
            await settings.getByRole('textbox', { name: 'Theme code' }).fill('not a theme');
            findings.push(...(await audit(settings, 'Settings → Appearance → import', { appearance: mode })));
            await settings.getByRole('button', { name: 'Cancel' }).click();
          }
          if (name === 'Keyboard shortcuts') {
            // Recording a new key.
            await settings.locator('[data-action="view.find"]').getByRole('button', { name: /^Add another key/ }).click();
            await expect(settings.getByText('Press keys…')).toBeVisible();
            findings.push(...(await audit(settings, 'Settings → Keyboard shortcuts (recording)', { appearance: mode })));
            await settings.keyboard.press('Escape');
          }
        }
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`first run, every step (${mode})`, async () => {
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode }, { firstRun: true });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        const welcome = shell.getByRole('dialog', { name: 'Welcome to Chord' });
        await expect(welcome.getByRole('heading', { name: 'Hi, I’m Chord.' })).toBeVisible();
        findings.push(...(await audit(shell, 'first run: welcome', { appearance: mode })));
        await welcome.getByRole('button', { name: /Make your first chord/ }).click();
        await expect(welcome.getByRole('textbox', { name: 'Chord name' })).toBeFocused();
        findings.push(...(await audit(shell, 'first run: name', { appearance: mode })));
        await welcome.getByRole('button', { name: /Work/ }).click();
        await welcome.getByRole('button', { name: /^Next/ }).click();
        await expect(welcome.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
        findings.push(...(await audit(shell, 'first run: colors', { appearance: mode })));
        await welcome.getByRole('button', { name: /Looks good/ }).click();
        await welcome.getByRole('textbox', { name: 'A site you open every day' }).fill('git');
        findings.push(...(await audit(shell, 'first run: pins', { appearance: mode })));
        await welcome.getByRole('button', { name: /^Next/ }).click();
        await expect(welcome.getByRole('heading', { name: 'Three things to know' })).toBeVisible();
        findings.push(...(await audit(shell, 'first run: tips', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`Duet: setup, chat, citations, approval cards and menus (${mode})`, async () => {
      const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
      const app = await launch({
        CHORD_HOME_URL: `${site.origin}/article`,
        CHORD_APPEARANCE: mode,
        CHORD_DUET_CLAUDE: fakeClaude,
        CHORD_DUET_CODEX: resolve(config, 'no-codex'),
        CLAUDE_CONFIG_DIR: config,
      });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        await expect(today(shell)).toContainText('Article');
        await setTheme(shell, 'dusk');
        await runAction(shell, 'duet.toggle');
        const panel = shell.getByRole('complementary', { name: 'Duet' });
        await expect(panel.getByText('Meet Duet.')).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: intro and setup', { appearance: mode })));
        await panel.getByRole('button', { name: 'Use this' }).first().click();
        await expect(panel.getByRole('button', { name: 'Got it' })).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: ready, first use', { appearance: mode })));
        await panel.getByRole('button', { name: 'Got it' }).click();

        const input = panel.getByRole('textbox', { name: 'Message Duet' });
        await input.fill('Summarize this page');
        await input.press('Enter');
        await expect(panel.getByRole('button', { name: /^Source 1: “/ })).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: a reply with citations', { appearance: mode })));
        await panel.getByRole('button', { name: /Read “Article”/ }).click();
        findings.push(...(await audit(shell, 'Duet: tool activity', { appearance: mode })));

        await panel.getByRole('button', { name: 'Chats' }).click();
        await expect(panel.getByRole('menu', { name: 'Chats' })).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: Chats menu', { appearance: mode })));
        await shell.keyboard.press('Escape');
        await panel.getByRole('button', { name: /Claude Code · / }).click();
        await expect(panel.getByRole('menu', { name: 'Model' })).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: model menu', { appearance: mode })));
        await shell.keyboard.press('Escape');
        await panel.getByRole('button', { name: 'Attach a tab' }).click();
        findings.push(...(await audit(shell, 'Duet: attach a tab', { appearance: mode })));
        await shell.keyboard.press('Escape');

        await input.fill('list my tabs');
        await input.press('Enter');
        await expect(panel.getByRole('group', { name: 'Duet is asking' })).toBeVisible();
        findings.push(...(await audit(shell, 'Duet: approval card', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`a mini window, Peek, a move with a route offer, and Settings → Links (${mode})`, async () => {
      // A link from another app, Chord not running: it opens in a mini window of its own (DESIGN.md §7.9).
      const findings: Finding[] = [];
      const linked = await launch({ CHORD_HOME_URL: `${site.origin}/pinned`, CHORD_APPEARANCE: mode }, { args: ['--single-argument', `${site.other}/other2`] });
      try {
        const bar = await pageWhere(linked, isMini);
        await expect(bar.getByTestId('mini-host')).toContainText('localhost');
        findings.push(...(await audit(bar, 'mini window bar', { appearance: mode })));
      } finally {
        await linked.close();
      }

      const app = await launch({ CHORD_HOME_URL: `${site.origin}/pinned`, CHORD_APPEARANCE: mode });
      try {
        // Peek: a pinned tab's link to another site.
        const shell = await pageWhere(app, isShell);
        const overlay = await pageWhere(app, isOverlay);
        await setTheme(shell, 'graphite');
        await runAction(shell, 'tab.pin');
        await expect(pinned(shell)).toContainText('Pinned');
        await clickLink(app, `${site.origin}/pinned`, '#out');
        const peek = overlay.getByRole('dialog', { name: /^Peek/ });
        await expect(peek).toBeVisible();
        findings.push(...(await audit(overlay, 'Peek', { appearance: mode })));
        await peek.getByRole('button', { name: 'Close Peek' }).click();
        await expect(peek).toBeHidden();

        // Moving a site's pages to the same chord twice: the move's toast offers a route on a second line.
        const { windowId, chordId: personal } = await where(shell);
        await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'W', theme: { stops: THEMES.coral, grain: 0.2, appearance: 'auto' } });
        await dispatch(shell, { t: 'chord.activate', windowId, chordId: personal });
        const work = await shell.evaluate(async () => {
          const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { chords: Record<string, { id: string; name: string }> } }> } } }).chord.state.snapshot();
          return Object.values(state.chords).find((c) => c.name === 'Work')!.id;
        });
        for (const path of ['/other', '/other2']) {
          await dispatch(shell, { t: 'tab.open', windowId, url: `${site.other}${path}` });
          await expect(today(shell).getByRole('treeitem').first()).toContainText(path === '/other' ? 'Other' : 'Other 2');
          const nodeId = await tabIdByTitle(shell, path === '/other' ? 'Other' : 'Other 2');
          await shell.evaluate(([n, c]) => (window as unknown as { chord: { sidebar: { moveToChord(n: string, c: string): Promise<void> } } }).chord.sidebar.moveToChord(n!, c!), [nodeId, work]);
        }
        const offer = shell.getByRole('group').filter({ hasText: 'Always open localhost here?' });
        await expect(offer).toBeVisible();
        findings.push(...(await audit(shell, 'move with a route offer', { appearance: mode })));
        await offer.getByRole('button', { name: 'Always' }).click();

        // Settings → General → Links, with the route just made.
        await runAction(shell, 'app.settings');
        const settings = await pageWhere(app, isSettings);
        await expect(settings.getByRole('combobox', { name: 'Chord for localhost' })).toBeVisible();
        findings.push(...(await audit(settings, 'Settings → Links', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`a tab's speaker, the Now playing card, and the minimal bar's speaker (${mode})`, async () => {
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        await expect(today(shell)).toContainText('First page');
        const card = shell.getByRole('group', { name: 'Now playing' });
        // A tab left playing: its row's speaker, and the card with its track and artwork.
        await leavePlaying(app, shell, `${site.origin}/song`);
        await expect(card).toContainText('Chord Song');
        await expect(card.locator('img')).toBeVisible();
        for (const theme of ['dusk', 'graphite', 'coral', 'aurora'] satisfies ThemeName[]) {
          await setTheme(shell, theme);
          findings.push(...(await audit(shell, `now playing, ${theme}`, { appearance: mode })));
        }
        // Two left playing (the newest in full, the other as a row), one muted and one paused.
        await leavePlaying(app, shell, `${site.origin}/radio`);
        await expect(card.getByRole('button', { name: /^Go to tab: / })).toHaveCount(2);
        await card.getByRole('button', { name: 'Mute tab' }).click();
        await card.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(card.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
        findings.push(...(await audit(shell, 'now playing: two tabs, muted, paused', { appearance: mode })));
        // The tab on screen plays (muted), in the minimal bar.
        await card.getByRole('button', { name: 'Play', exact: true }).click();
        await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
        await card.getByRole('button', { name: 'Go to tab: Radio' }).click();
        await expect(today(shell).getByRole('treeitem', { name: 'Radio', exact: true })).toHaveAttribute('aria-current', 'page');
        await runAction(shell, 'view.toggleSidebar');
        await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
        await expect(shell.getByRole('button', { name: 'Unmute tab' })).toBeVisible();
        findings.push(...(await audit(shell, 'minimal bar, playing', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`the share picker, presenting mode's indicator and a shared tab's edge (${mode})`, async () => {
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/meet`, CHORD_APPEARANCE: mode });
      const findings: Finding[] = [];
      try {
        const shell = await pageWhere(app, isShell);
        const popover = await pageWhere(app, isPopover);
        const meet = await pageWhere(app, (url) => url === `${site.origin}/meet`);
        await expect(today(shell)).toContainText('Meet');
        const { windowId } = await where(shell);
        await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/second`, background: true });
        await expect(today(shell).getByRole('treeitem', { name: 'Second page', exact: true })).toBeVisible();
        // The picker: tabs, the asking one first.
        await meet.locator('#share').click();
        const picker = popover.getByRole('alertdialog', { name: /^Choose what to share with/ });
        await expect(picker.getByRole('option', { name: /Second page/ })).toBeVisible();
        findings.push(...(await audit(popover, 'share picker', { appearance: mode })));
        await picker.getByRole('option', { name: /Second page/ }).click();
        await picker.getByRole('button', { name: 'Share', exact: true }).click();
        await expect.poll(() => meet.title()).toBe('Sharing');
        // Presenting mode's card, in each theme; the shared tab's row and its frame's edge.
        const card = shell.getByRole('group', { name: 'Presenting mode' });
        await expect(card).toBeVisible();
        await dispatch(shell, { t: 'tab.activate', windowId, nodeId: await tabIdByTitle(shell, 'Second page') });
        await expect(shell.locator('[data-region="page"][data-shared]')).toHaveCount(1);
        for (const theme of ['dusk', 'graphite', 'coral', 'aurora'] satisfies ThemeName[]) {
          await setTheme(shell, theme);
          findings.push(...(await audit(shell, `presenting, ${theme}`, { appearance: mode })));
        }
        // The minimal bar's chip.
        await runAction(shell, 'view.toggleSidebar');
        await expect(shell.getByRole('button', { name: 'Turn off presenting mode' })).toBeVisible();
        findings.push(...(await audit(shell, 'minimal bar, presenting', { appearance: mode })));
      } finally {
        await app.close();
      }
      expectClean(findings);
    });

    test(`a private window (${mode})`, async () => {
      const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: mode });
      try {
        const shell = await pageWhere(app, isShell);
        await expect(today(shell)).toContainText('First page');
        await runAction(shell, 'window.newPrivate');
        const privateShell = await newPage(app, isShell, [shell]);
        await expect(privateShell.getByText('This window is private.')).toBeVisible();
        // A private window is always dark (DESIGN.md §3.4).
        expectClean(await audit(privateShell, 'private window', { appearance: 'dark' }));
      } finally {
        await app.close();
      }
    });
  });
}

/* ---------- What a screen reader is told (aria snapshots), and what it hears ---------- */

test('screen readers get the structure: the sidebar tree, the command bar combobox, Settings and Duet, and polite announcements', async () => {
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/article`, CHORD_DUET_CLAUDE: fakeClaude, CHORD_DUET_CODEX: resolve(config, 'no-codex'), CLAUDE_CONFIG_DIR: config });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(today(shell)).toContainText('Article');
    await openTab(shell, '/second', 'Second page');
    await openTab(shell, '/third', 'Third page');
    await dispatch(shell, { t: 'tab.pin', nodeId: await tabIdByTitle(shell, 'Second page') });
    // "New folder with this tab" puts Third (on screen) in a folder, named right away.
    await runAction(shell, 'folder.new');
    await shell.getByRole('textbox', { name: 'Folder name' }).press('Enter');

    // The sidebar: two trees with levels, positions and the tab on screen; the chords are tabs.
    const sidebar = shell.getByRole('navigation', { name: 'Sidebar' });
    await expect(sidebar).toMatchAriaSnapshot(`
      - button "Hide sidebar" [expanded]
      - button /Address.+127/
      - tree "Pinned":
        - treeitem "Second page" [level=1]
        - treeitem "New folder" [expanded] [level=1]
        - treeitem "Third page" [level=2] [selected]
      - button "New tab ${process.platform === 'darwin' ? '⌘T' : 'Ctrl+T'}"
      - tree "Today":
        - treeitem "Article" [level=1]
      - region "Notifications"
      - tablist "Chords":
        - tab "Personal" [selected]
      - button "New chord"
    `);
    const third = pinned(shell).getByRole('treeitem', { name: 'Third page' });
    await expect(third).toHaveAttribute('aria-posinset', '1');
    await expect(third).toHaveAttribute('aria-setsize', '1');
    await expect(pinned(shell).getByRole('treeitem', { name: 'New folder' })).toHaveAttribute('aria-setsize', '2');
    // The trees say how they work.
    await expect(pinned(shell)).toHaveAccessibleDescription(/Arrow keys move between rows/);
    // Each tree is one Tab stop: the row last focused (here the folder, just named), else the tab on screen, else the first row.
    for (const tree of [pinned(shell), today(shell)]) await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(pinned(shell).getByRole('treeitem', { name: 'New folder' })).toHaveAttribute('tabindex', '0');
    await expect(today(shell).getByRole('treeitem', { name: 'Article' })).toHaveAttribute('tabindex', '0');

    // The command bar: a modal dialog, a combobox that owns a listbox, and the active option followed by aria-activedescendant.
    await runAction(shell, 'tab.new');
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('pa');
    const dialog = overlay.getByRole('dialog', { name: 'New tab' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toMatchAriaSnapshot(`
      - combobox "Search or enter address" [expanded]: pa
      - listbox "Results":
        - option [selected]
    `);
    const field = overlay.getByRole('combobox');
    await expect(field).toHaveAttribute('aria-controls', 'command-results');
    for (const step of [0, 1, 2]) {
      if (step) await overlay.keyboard.press('ArrowDown');
      const active = await field.getAttribute('aria-activedescendant');
      await expect(overlay.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');
      await expect(overlay.getByRole('option', { selected: true })).toHaveCount(1);
    }
    await overlay.keyboard.press('Escape');

    // Settings: a navigation of sections, one level-1 heading per section, and rows read with their descriptions.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await expect(settings.getByRole('navigation', { name: 'Settings sections' })).toMatchAriaSnapshot(`
      - button "General"
      - button "Appearance"
      - button "Motion"
      - button "Privacy"
      - button "Site permissions"
      - button "Extensions"
      - button "Duet"
      - button "Keyboard shortcuts"
      - button "About"
    `);
    await expect(settings.getByRole('navigation').getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await expect(settings.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('General');
    await expect(settings.getByRole('switch', { name: 'Search suggestions' })).toHaveAccessibleDescription(/suggests ways to finish it/);
    const engines = settings.getByRole('radiogroup', { name: 'Search engine' });
    await expect(engines.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(engines.getByRole('radio', { checked: true })).toHaveAttribute('tabindex', '0');
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.getTitle() === 'Chord Settings')?.close());

    // Duet: a labelled panel with a conversation log that isn't read word by word, and an announcement when a reply is done.
    await runAction(shell, 'duet.toggle');
    const panel = shell.getByRole('complementary', { name: 'Duet' });
    await panel.getByRole('button', { name: 'Use this' }).first().click();
    await panel.getByRole('button', { name: 'Got it' }).click();
    await expect(panel).toMatchAriaSnapshot(`
      - button "Chats" [expanded=false]
      - button "Close Duet"
      - button "Reads this tab" [expanded=false]
      - textbox "Message Duet"
    `);
    const input = panel.getByRole('textbox', { name: 'Message Duet' });
    await input.fill('Summarize this page');
    await input.press('Enter');
    await expect(panel.getByRole('button', { name: /^Source 1: “/ })).toBeVisible();
    const log = panel.getByRole('log', { name: 'Duet conversation' });
    await expect(log).toHaveAttribute('aria-live', 'off');
    await expect(log).toHaveAttribute('aria-busy', 'false');
    const announcer = shell.getByTestId('announcer');
    await expect(announcer).toHaveText('Duet finished answering.');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');

    // A chord switch is announced.
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'W', theme: { stops: THEMES.coral, grain: 0.2, appearance: 'auto' } });
    await expect(announcer).toHaveText('Work chord, 0 pinned, 0 today');
  } finally {
    await app.close();
  }
});

/* ---------- Windows High Contrast (forced colors) ---------- */

/** The system color a CSS system-color keyword resolves to here, for comparing computed styles. */
const systemColor = (page: Page, keyword: string) =>
  page.evaluate((k) => {
    const probe = document.createElement('div');
    probe.style.setProperty('color', k);
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, keyword);

test('Windows High Contrast: tints off; focus, selection, the active tab, switches and the split focus ring in system colors (with captures)', async () => {
  test.setTimeout(120_000);
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: 'dark' });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(today(shell)).toContainText('First page');
    await openTab(shell, '/second', 'Second page');
    await setTheme(shell, 'aurora');
    await shell.emulateMedia({ forcedColors: 'active' });
    expect(await shell.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const highlight = await systemColor(shell, 'Highlight');

    // Tints and grain are off.
    await expect(shell.locator('[data-sidebar] > [aria-hidden]').first()).toBeHidden();
    // The tab on screen wears the selection color; a focused row gets a ring in the text color.
    const active = today(shell).getByRole('treeitem', { selected: true });
    await expect.poll(() => active.locator('[data-activate]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(highlight);
    await today(shell).getByRole('treeitem', { name: 'First page', exact: true }).focus();
    const focused = today(shell).getByRole('treeitem', { name: 'First page', exact: true }).locator('[data-activate]');
    expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    const canvasText = await systemColor(shell, 'CanvasText');
    await expect.poll(() => focused.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(canvasText);
    await settle(shell);
    await shell.screenshot({ path: resolve(capturesDir, `forced-colors-sidebar-${process.platform}.png`) });

    // Split view: the focused pane's ring is the selection color.
    const { tabId } = await where(shell);
    await dispatch(shell, { t: 'split.add', windowId: (await where(shell)).windowId, withId: tabId, url: `${site.origin}/third` });
    const ring = shell.locator('[data-pane][data-focused]');
    await expect(ring).toBeVisible();
    await expect.poll(() => ring.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(highlight);
    expect(await ring.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await settle(shell);
    await shell.screenshot({ path: resolve(capturesDir, `forced-colors-split-${process.platform}.png`) });
    await runAction(shell, 'split.separate');

    // The command bar: the selected result is the selection color.
    await overlay.emulateMedia({ forcedColors: 'active' });
    await runAction(shell, 'tab.new');
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('page');
    const option = overlay.getByRole('option', { selected: true });
    await expect(option).toBeVisible();
    const overlayHighlight = await systemColor(overlay, 'Highlight');
    await expect.poll(() => option.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(overlayHighlight);
    await settle(overlay);
    await overlay.screenshot({ path: resolve(capturesDir, `forced-colors-command-bar-${process.platform}.png`) });
    await overlay.keyboard.press('Escape');

    // Settings: a switch that's on, and the chosen option of a segmented control.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.emulateMedia({ forcedColors: 'active' });
    const on = settings.getByRole('switch', { name: 'Search suggestions' });
    await expect(on).toHaveAttribute('aria-checked', 'true');
    const settingsHighlight = await systemColor(settings, 'Highlight');
    await expect.poll(() => on.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(settingsHighlight);
    const chosen = settings.getByRole('radiogroup', { name: 'Archive Today tabs after' }).getByRole('radio', { checked: true });
    await expect.poll(() => chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(settingsHighlight);
    await settle(settings);
    await settings.screenshot({ path: resolve(capturesDir, `forced-colors-settings-${process.platform}.png`) });
  } finally {
    await app.close();
  }
});

/* ---------- Reduced motion, both ways, and reduced transparency ---------- */

test('reduced motion follows the OS both ways (stubbed in main), unless Settings says not to', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    let shell = await pageWhere(app, isShell);
    await expect(today(shell)).toContainText('First page');
    const animationSettings = (reduce: boolean) =>
      app.evaluate(({ systemPreferences }, r) => {
        const real = (globalThis as { realAnimationSettings?: typeof systemPreferences.getAnimationSettings }).realAnimationSettings ?? systemPreferences.getAnimationSettings.bind(systemPreferences);
        (globalThis as { realAnimationSettings?: typeof real }).realAnimationSettings = real;
        systemPreferences.getAnimationSettings = () => ({ ...real(), prefersReducedMotion: r });
      }, reduce);
    const reload = async () => {
      await shell.reload();
      shell = await pageWhere(app, isShell);
      await expect(today(shell)).toContainText('First page');
    };
    const sidebarTransition = () => shell.evaluate(() => getComputedStyle(document.querySelector('nav')!).transitionDuration);
    const reduced = () => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'));

    // The OS asks for less motion: transitions go instant.
    await animationSettings(true);
    await reload();
    expect(await reduced()).toBe(true);
    expect(await sidebarTransition()).toMatch(/^0s(, 0s)*$/);

    // The OS animates: so does Chord (this machine may have animations off; the stub says on).
    await animationSettings(false);
    await reload();
    expect(await reduced()).toBe(false);
    expect(await sidebarTransition()).not.toMatch(/^0s(, 0s)*$/);

    // Settings → Motion → "Follow system motion settings" off: the OS's preference is ignored.
    await animationSettings(true);
    await reload();
    expect(await reduced()).toBe(true);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation').getByRole('button', { name: 'Motion' }).click();
    await settings.getByRole('switch', { name: 'Follow system motion settings' }).click();
    await expect.poll(reduced).toBe(false);
  } finally {
    await app.close();
  }
});

test('reduce transparency (stubbed in main) makes the window solid, and turning it off brings the material back', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(today(shell)).toContainText('First page');
    const material = () => shell.evaluate(() => document.documentElement.dataset['material']);
    const setReduced = async (reduce: boolean) => {
      await app.evaluate(({ nativeTheme }, r) => {
        Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { configurable: true, get: () => r });
        nativeTheme.emit('updated');
      }, reduce);
      // A round trip to main: IPC keeps order, so the change main sent first has been applied.
      await shell.evaluate(() => (window as unknown as { chord: { system: { info(): Promise<unknown> } } }).chord.system.info());
    };
    const base = () => shell.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar]')!).backgroundColor);
    // The material without reduce transparency: measured with it off, since the OS may have it on
    // (the macOS CI runners do, so the window starts solid there).
    await setReduced(false);
    const before = await material();

    await setReduced(true);
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['material'])).toBe('solid');
    // Solid: the window's own background is opaque, so nothing shows through the tint.
    await expect.poll(base).not.toMatch(/rgba\(0, 0, 0, 0\)|\/ 0\)$/);

    await setReduced(false);
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['material'])).toBe(before);
  } finally {
    await app.close();
  }
});
