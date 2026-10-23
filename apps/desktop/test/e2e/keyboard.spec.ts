/**
 * Keyboard only (DESIGN.md §1 principle 7, §10, ROADMAP.md M1.6): every key
 * flow from the first run to Duet and split view, with real focus and no
 * pointer. Keys inside Chord's own pages are pressed as keys. Reserved
 * shortcuts (⌘T, ⌘L, F6…) go through Electron's input pipeline from main
 * (`pressReal`, which before-input-event sees, as with a real key), or through
 * the shortcut registry (`runAction`) where a press would need OS focus.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeClaude, focusedView, isOverlay, isSettings, isShell, launch, pageWhere, pressReal, runAction, setReducedMotion, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

/** ⌘ on macOS, Ctrl elsewhere: the modifier Chord's own shortcuts use. */
const MOD = process.platform === 'darwin' ? 'meta' : 'control';

/**
 * Which view has the keyboard, as main sees it. Headless Weston never
 * activates a window, so no view there ever has OS focus: the check is
 * skipped (the shell's own focus is still checked, element by element).
 */
const keyboardIn = async (app: Parameters<typeof focusedView>[0], expected: string) => {
  if (process.env['XDG_SESSION_TYPE'] === 'wayland') return;
  await expect.poll(() => focusedView(app)).toBe(expected);
};

let site: Site;
test.beforeAll(async () => {
  site = await startSite({
    '/': '<title>First page</title><p>One</p>',
    '/second': '<title>Second page</title><p>Two</p>',
    '/third': '<title>Third page</title><p>Three</p>',
    '/article': '<title>Article</title><h1>Chords</h1><p>Chords are three notes played together, and they sound full.</p>',
  });
});
test.afterAll(() => site.server.close());

const today = (shell: Page) => shell.getByRole('tree', { name: 'Today' });
const pinned = (shell: Page) => shell.getByRole('tree', { name: 'Pinned' });
const row = (tree: Locator, name: string) => tree.getByRole('treeitem', { name, exact: true });

/** Press Tab (or Shift+Tab) until `target` has focus; fails after `max` presses. */
async function tabTo(page: Page, target: Locator, { back = false, max = 25 } = {}): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  await expect(target).toBeFocused();
}

/** Open a tab from the command bar, the way a keyboard does (⌘T, type, ↵). */
async function openFromCommandBar(shell: Page, overlay: Page, path: string, title: string): Promise<void> {
  await runAction(shell, 'tab.new');
  await expect(overlay.getByRole('combobox')).toBeFocused();
  await overlay.keyboard.type(`${site.origin}${path}`);
  await overlay.keyboard.press('Enter');
  await expect(overlay.getByRole('dialog')).toBeHidden();
  await expect(row(today(shell), title)).toBeVisible();
}

// With motion reduced each card is there at once, so a key that moves on must not also press the next card's button.
for (const reduced of [false, true]) {
  test(`first run, keyboard only: name a chord, pick its colors with arrow keys, pin a site, and start browsing${reduced ? ' (reduced motion)' : ''}`, async () => {
    const app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, { firstRun: true });
    try {
      const shell = await pageWhere(app, isShell);
      await setReducedMotion(app, shell, reduced);
      const welcome = shell.getByRole('dialog', { name: 'Welcome to Chord' });
      // Each step starts on its main button or field.
      await expect(welcome.getByRole('button', { name: /Make your first chord/ })).toBeFocused();
      await shell.keyboard.press('Enter');
      const name = welcome.getByRole('textbox', { name: 'Chord name' });
      await expect(name).toBeFocused();
      await shell.keyboard.type('Studio');
      await shell.keyboard.press('Enter');

      // Colors: each radio group is one Tab stop; arrow keys pick (and the sidebar re-themes).
      const done = welcome.getByRole('button', { name: /Looks good/ });
      await expect(done).toBeFocused();
      const swatches = welcome.getByRole('radiogroup', { name: 'One color' });
      await tabTo(shell, swatches.getByRole('radio').first(), { back: true });
      await expect(swatches.locator('[tabindex="0"]')).toHaveCount(1);
      await shell.keyboard.press('ArrowRight');
      await expect(swatches.getByRole('radio', { name: 'Tangerine' })).toBeFocused();
      await expect(swatches.getByRole('radio', { name: 'Tangerine' })).toHaveAttribute('aria-checked', 'true');
      await shell.keyboard.press('End');
      await expect(swatches.getByRole('radio', { name: 'Graphite' })).toHaveAttribute('aria-checked', 'true');
      const presets = welcome.getByRole('radiogroup', { name: 'Theme' });
      await tabTo(shell, presets.getByRole('radio').first(), { back: true });
      await shell.keyboard.press('ArrowRight');
      await expect(presets.getByRole('radio', { name: 'Sea Glass' })).toHaveAttribute('aria-checked', 'true');
      // ↵ anywhere but a field is the step's main action.
      await shell.keyboard.press('Enter');

      // Pins: type a site, ↵ pins it; ↵ on the empty field goes on.
      const pin = welcome.getByRole('textbox', { name: 'A site you open every day' });
      await expect(pin).toBeFocused();
      await shell.keyboard.type(`${site.origin}/second`);
      await shell.keyboard.press('Enter');
      await expect(row(pinned(shell), 'Second page')).toBeVisible();
      await shell.keyboard.press('Enter');

      // Three things to know, then the command bar opens to start browsing.
      await expect(welcome.getByRole('button', { name: /Start browsing/ })).toBeFocused();
      await shell.keyboard.press('Enter');
      const overlay = await pageWhere(app, isOverlay);
      await expect(overlay.getByRole('combobox')).toBeFocused();
      await overlay.keyboard.press('Escape');
      await expect(welcome).toBeHidden();
      await expect(shell.getByRole('tablist', { name: 'Chords' }).getByRole('tab', { name: 'Studio' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await app.close();
    }
  });
}

test('tabs, keyboard only: F6 into the tree, move, reorder with Space and arrows, pin, fold a folder, and close', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await openFromCommandBar(shell, overlay, '/second', 'Second page');
    await openFromCommandBar(shell, overlay, '/third', 'Third page');

    // ⇧F6 from the page goes back to the sidebar, onto the tab on screen.
    await pressReal(app, `${site.origin}/third`, 'F6', ['shift']);
    await expect(row(today(shell), 'Third page')).toBeFocused();
    await keyboardIn(app, 'shell');
    // The tree is one Tab stop; arrows move within it.
    await expect(today(shell).locator('[tabindex="0"]')).toHaveCount(1);
    await shell.keyboard.press('ArrowDown');
    await expect(row(today(shell), 'Second page')).toBeFocused();
    await shell.keyboard.press('End');
    await expect(row(today(shell), 'First page')).toBeFocused();
    await shell.keyboard.press('Home');
    await expect(row(today(shell), 'Third page')).toBeFocused();

    // Reorder: Space picks Third up, ↓ moves it, Space drops it. Screen readers hear each step.
    const titles = () => today(shell).getByRole('treeitem').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')));
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText('Picked up Third page');
    await shell.keyboard.press('ArrowDown');
    await expect.poll(titles).toEqual(['Second page', 'Third page', 'First page']);
    await expect(row(today(shell), 'Third page')).toBeFocused();
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText('Dropped Third page, 2 of 3');

    // ↵ opens the focused tab.
    await shell.keyboard.press('ArrowDown');
    await shell.keyboard.press('Enter');
    await expect(row(today(shell), 'First page')).toHaveAttribute('aria-selected', 'true');

    // Pin it (⌘D, through the registry), then put it in a folder, named as it's made.
    await runAction(shell, 'tab.pin');
    await expect(row(pinned(shell), 'First page')).toBeVisible();
    await runAction(shell, 'folder.new');
    const folderName = shell.getByRole('textbox', { name: 'Folder name' });
    await expect(folderName).toBeFocused();
    await shell.keyboard.type('Reading');
    await shell.keyboard.press('Enter');
    const folder = pinned(shell).getByRole('treeitem', { name: 'Reading' });
    await expect(folder).toBeFocused();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(row(pinned(shell), 'First page')).toHaveAttribute('aria-level', '2');
    // ← folds, → unfolds, → again goes in.
    await shell.keyboard.press('ArrowLeft');
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(row(pinned(shell), 'First page')).toHaveCount(0);
    await shell.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await shell.keyboard.press('ArrowRight');
    await expect(row(pinned(shell), 'First page')).toBeFocused();

    // Delete closes a Today tab, and the keyboard stays in the list, on its neighbor.
    await shell.keyboard.press('End');
    await expect(row(today(shell), 'Third page')).toBeFocused();
    await shell.keyboard.press('Delete');
    await expect(row(today(shell), 'Third page')).toHaveCount(0);
    await expect(row(today(shell), 'Second page')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('chords, keyboard only: make one from the footer, name it, and switch with the arrow keys', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await pressReal(app, `${site.origin}/`, 'F6', ['shift']);
    await expect(row(today(shell), 'First page')).toBeFocused();

    // Tab to New chord; ↵ makes one and its name is typed at once; ↵ again and the keyboard is back on the button.
    const newChord = shell.getByRole('button', { name: 'New chord' });
    await tabTo(shell, newChord);
    await shell.keyboard.press('Enter');
    const name = shell.getByRole('textbox', { name: 'Chord name' });
    await expect(name).toBeFocused();
    await shell.keyboard.type('Work');
    await shell.keyboard.press('Enter');
    await expect(newChord).toBeFocused();

    // The switcher is one Tab stop, on the chord you're in; ← → switch chords.
    const chords = shell.getByRole('tablist', { name: 'Chords' });
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await shell.keyboard.press('Shift+Tab');
    await expect(chords.getByRole('tab', { name: 'Work' })).toBeFocused();
    await shell.keyboard.press('ArrowLeft');
    await expect(chords.getByRole('tab', { name: 'Personal' })).toBeFocused();
    await expect(chords.getByRole('tab', { name: 'Personal' })).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByTestId('announcer')).toHaveText('Personal chord, 0 pinned, 1 today');
    // ⌘2 (through the registry) goes to the second chord.
    await runAction(shell, 'chord.goto2');
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
  }
});

test('the command bar, keyboard only: ↑ ↓ move the active result, ↵ opens it, and Esc gives the keyboard back where it was', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await openFromCommandBar(shell, overlay, '/second', 'Second page');

    // ⌘T from the page: the bar takes the keyboard; the active result moves with the arrows.
    await pressReal(app, `${site.origin}/second`, 'T', [MOD]);
    const field = overlay.getByRole('combobox');
    await expect(field).toBeFocused();
    await overlay.keyboard.type('first');
    const selected = overlay.getByRole('option', { selected: true });
    await expect(selected).toContainText('First page');
    const before = await field.getAttribute('aria-activedescendant');
    await overlay.keyboard.press('ArrowDown');
    await expect(field).not.toHaveAttribute('aria-activedescendant', before!);
    await overlay.keyboard.press('ArrowUp');
    await expect(field).toHaveAttribute('aria-activedescendant', before!);
    // ↵ switches to the tab; the page has the keyboard.
    await overlay.keyboard.press('Enter');
    await expect(overlay.getByRole('dialog')).toBeHidden();
    await expect(row(today(shell), 'First page')).toHaveAttribute('aria-selected', 'true');
    await keyboardIn(app, `${site.origin}/`);

    // From the sidebar: ⌘L opens it on the address; Esc puts the keyboard back on the row it came from.
    await pressReal(app, `${site.origin}/`, 'F6', ['shift']);
    await expect(row(today(shell), 'First page')).toBeFocused();
    await pressReal(app, 'chord://shell', 'L', [MOD]);
    await expect(overlay.getByRole('dialog', { name: 'Edit address' })).toBeVisible();
    await expect(field).toBeFocused();
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByRole('dialog')).toBeHidden();
    await keyboardIn(app, 'shell');
    await expect(row(today(shell), 'First page')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('Settings, keyboard only: change a setting, then put it back with its ↺, and the keyboard stays on the setting', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    const nav = settings.getByRole('navigation', { name: 'Settings sections' });

    // A segmented choice: one Tab stop, arrows choose.
    const archiveAfter = settings.getByRole('radiogroup', { name: 'Archive Today tabs after' });
    await tabTo(settings, archiveAfter.getByRole('radio', { checked: true }));
    await settings.keyboard.press('ArrowRight');
    await expect(archiveAfter.getByRole('radio', { name: 'A day' })).toHaveAttribute('aria-checked', 'true');
    await expect(archiveAfter.getByRole('radio', { name: 'A day' })).toBeFocused();
    // Its ↺ shows, just before it; ↵ on it puts the default back and the keyboard on the setting.
    await settings.keyboard.press('Shift+Tab');
    const reset = settings.getByRole('button', { name: 'Reset Archive Today tabs after to default' });
    await expect(reset).toBeFocused();
    await settings.keyboard.press('Enter');
    await expect(archiveAfter.getByRole('radio', { name: '12 hours' })).toHaveAttribute('aria-checked', 'true');
    await expect(archiveAfter.getByRole('radio', { name: '12 hours' })).toBeFocused();
    await expect(reset).toHaveCount(0);

    // Another section, from the navigation: a switch, Space to flip, ↺ to undo.
    await tabTo(settings, nav.getByRole('button', { name: 'Motion' }), { back: true, max: 40 });
    await settings.keyboard.press('Enter');
    await expect(settings.getByRole('heading', { level: 1, name: 'Motion' })).toBeVisible();
    const follow = settings.getByRole('switch', { name: 'Follow system motion settings' });
    await tabTo(settings, follow);
    await settings.keyboard.press('Space');
    await expect(follow).toHaveAttribute('aria-checked', 'false');
    await settings.keyboard.press('Shift+Tab');
    await expect(settings.getByRole('button', { name: 'Reset Follow system motion settings to default' })).toBeFocused();
    await settings.keyboard.press('Enter');
    await expect(follow).toHaveAttribute('aria-checked', 'true');
    await expect(follow).toBeFocused();
  } finally {
    await app.close();
  }
});

test('Duet, keyboard only: open it, set it up, ask, answer its question from the keyboard, and use its menus', async () => {
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  // Claude answers late, so Duet opens before it has found it (as on a slow machine).
  const env = { CHORD_HOME_URL: `${site.origin}/article`, CHORD_DUET_CLAUDE: fakeClaude, CHORD_DUET_CODEX: resolve(config, 'no-codex'), CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_SLOW_VERSION: '2000' };
  const app = await launch(env);
  try {
    const shell = await pageWhere(app, isShell);
    await expect(row(today(shell), 'Article')).toBeVisible();
    // ⌘E (page-first, through the registry): the panel opens with the keyboard on its first step,
    // and the keyboard follows when "Use this" arrives.
    await runAction(shell, 'duet.toggle');
    const panel = shell.getByRole('complementary', { name: 'Duet' });
    await expect(panel.getByRole('button', { name: 'Use this' }).first()).toBeFocused({ timeout: 15_000 });
    await shell.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Got it' })).toBeFocused();
    await shell.keyboard.press('Enter');
    const input = panel.getByRole('textbox', { name: 'Message Duet' });
    await expect(input).toBeFocused();

    // Ask; the reply is announced once, when it's done.
    await shell.keyboard.type('Summarize this page');
    await shell.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: /^Source 1: “/ })).toBeVisible();
    await expect(shell.getByTestId('announcer')).toHaveText('Duet finished answering.');

    // Duet asks before reading more: the question is announced, and ⌘↵ / Ctrl+↵ in the message field allows it once.
    await shell.keyboard.type('list my tabs');
    await shell.keyboard.press('Enter');
    await expect(panel.getByRole('group', { name: 'Duet is asking' })).toBeVisible();
    await expect(shell.getByTestId('announcer')).toContainText('Duet is asking');
    await shell.keyboard.press('ControlOrMeta+Enter');
    await expect(panel.getByText(/I can see \d+ tabs\./)).toBeVisible();
    await expect(panel.getByText('Allowed', { exact: true })).toBeVisible();

    // What Duet can read: one Tab stop, arrows choose.
    const scope = panel.getByRole('radiogroup', { name: 'What Duet can read' });
    await tabTo(shell, scope.getByRole('radio', { checked: true }), { back: true });
    await shell.keyboard.press('ArrowRight');
    await expect(scope.getByRole('radio', { name: 'This chord' })).toHaveAttribute('aria-checked', 'true');

    // The Chats menu: ↵ opens it on its first item, ↓ moves, Esc closes it and the keyboard is back on its button.
    const chats = panel.getByRole('button', { name: 'Chats' });
    await tabTo(shell, chats, { back: true });
    await shell.keyboard.press('Enter');
    const menu = panel.getByRole('menu', { name: 'Chats' });
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await shell.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
    await shell.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(chats).toBeFocused();

    // Close Duet from the keyboard: the panel goes, and the keyboard goes back to the page.
    await shell.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Close Duet' })).toBeFocused();
    await shell.keyboard.press('Enter');
    await expect(panel).toBeHidden();
    await keyboardIn(app, `${site.origin}/article`);
  } finally {
    await app.close();
  }
});

test('split view, keyboard only: Split with… from the command bar, move between panes, resize from the keyboard, and separate', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await openFromCommandBar(shell, overlay, '/second', 'Second page');

    // ⇧⌘\ / Ctrl+Shift+\ from the page: pick a tab to put beside this one.
    await pressReal(app, `${site.origin}/second`, '\\', [MOD, 'shift']);
    await expect(overlay.getByRole('dialog', { name: 'Split with' })).toBeVisible();
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('First page');
    await expect(overlay.getByRole('option', { selected: true })).toContainText('First page');
    await overlay.keyboard.press('Enter');
    const split = row(today(shell), 'Split: Second page + First page');
    await expect(split).toBeVisible();
    const divider = shell.getByRole('separator', { name: 'Resize split panes' });
    await expect(divider).toBeVisible();

    // ⌘⌥[ / ⌘⌥] (through the registry) move between panes: the new one has focus, on the right.
    const focusedPane = () => shell.locator('[data-pane][data-focused]').getAttribute('data-pane');
    const right = await focusedPane();
    await runAction(shell, 'split.focusPrevious');
    await expect.poll(focusedPane).not.toBe(right);
    await runAction(shell, 'split.focusNext');
    await expect.poll(focusedPane).toBe(right);

    // The divider: F6 from the page to the top bar, then Tab reaches it; arrows resize.
    await pressReal(app, `${site.origin}/second`, 'F6');
    await keyboardIn(app, 'shell');
    await tabTo(shell, divider);
    const size = Number(await divider.getAttribute('aria-valuenow'));
    await shell.keyboard.press('ArrowRight');
    await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(size);

    // Separate it from the command bar's actions (no network: actions only).
    await runAction(shell, 'tab.new');
    await overlay.keyboard.type('@actions separate');
    await expect(overlay.getByRole('option', { selected: true })).toHaveText(/^Separate split tabs/);
    await overlay.keyboard.press('Enter');
    await expect(divider).toHaveCount(0);
    await expect(split).toHaveCount(0);
    await expect(row(today(shell), 'First page')).toBeVisible();
    await expect(row(today(shell), 'Second page')).toBeVisible();
  } finally {
    await app.close();
  }
});
