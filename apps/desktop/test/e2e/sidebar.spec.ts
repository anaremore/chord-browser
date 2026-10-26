/**
 * The sidebar (ROADMAP.md M1.2): folders, Favorites, resizing, Clear Today,
 * the keyboard, moving tabs between chords, and peeking in minimal mode (and its switch in Settings).
 * Native menus can't be clicked from a test, so menu items are reached the
 * way the command bar reaches them: through the action registry.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { closeSettings } from './a11y-kit';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title>',
    '/second': '<title>Second page</title>',
    '/third': '<title>Third page</title>',
    '/fourth': '<title>Fourth page</title>',
    '/login': `<title>Login</title><script>document.cookie = 'account=alex; path=/; max-age=3600'; document.title = 'Signed in';</script>`,
    '/whoami': `<title>Whoami</title><script>document.title = document.cookie.includes('account=alex') ? 'Alex' : 'Signed out';</script>`,
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  // A fresh profile per launch: tests never touch a developer's real data.
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** The window's views, bottom to top: [shell, page, popover, overlay] normally. */
const views = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.contentView.children.map((v) => ({ ...v.getBounds(), url: 'webContents' in v ? (v as { webContents: { getURL(): string } }).webContents.getURL() : '' })));

let site: { server: Server; origin: string };
/** A second site (another port), for "a tab on the same site". */
let other: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
  other = await startSite();
});
test.afterAll(() => {
  site.server.close();
  other.server.close();
});

/** Shell, command bar, and a few tabs opened through it (the newest is active, at the top of Today). */
async function setUp(app: ElectronApplication, paths: string[], origin = () => site.origin) {
  const shell = await pageWhere(app, isShell);
  const overlay = await pageWhere(app, isOverlay);
  const today = shell.getByRole('tree', { name: 'Today' });
  await expect(today).toContainText('First page');
  for (const path of paths) {
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await overlay.keyboard.type(`${origin()}${path}`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('treeitem').first()).toContainText(new RegExp(path.slice(1), 'i'));
  }
  return { shell, overlay, today, pinned: shell.getByRole('tree', { name: 'Pinned' }) };
}

/**
 * Where a row is once it has stopped moving. Rows glide into place (after
 * "New folder" they spring for about 700 ms), so a box read mid-glide sends a
 * drag somewhere the row no longer is. Settled means the same box on four
 * reads 100 ms apart; two reads in the same frame would match while it moves.
 */
async function settledBox(target: Locator) {
  let last: Awaited<ReturnType<Locator['boundingBox']>> = null;
  let same = 0;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        same = box && last && box.x === last.x && box.y === last.y && box.width === last.width && box.height === last.height ? same + 1 : 0;
        last = box;
        return same;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
  return last!;
}

/** Drag with the mouse the way a hand does: pick up, travel, settle, let go. */
async function drag(shell: Page, from: Locator, to: { x: number; y: number }) {
  const a = await settledBox(from);
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 4 });
  await shell.mouse.move(to.x, to.y, { steps: 12 });
  await shell.waitForTimeout(200);
  await shell.mouse.move(to.x + 1, to.y, { steps: 2 });
  await shell.mouse.up();
  // A new drag can't start while this drop's animation settles.
  await shell.waitForTimeout(600);
}

const point = async (target: Locator, dy: number, dx = 0) => {
  const b = await settledBox(target);
  return { x: b.x + b.width / 2 + dx, y: b.y + dy };
};

test('folders: made around a tab, dragged into, folded, renamed and deleted with Undo, all from the keyboard too', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, today, pinned } = await setUp(app, ['/second', '/third']);

    // The command bar offers the sidebar's actions.
    const overlay = await pageWhere(app, isOverlay);
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    for (const [typed, title] of [
      ['new folder', 'New folder with this tab'],
      ['favorites', 'Add this tab to Favorites'],
      ['tidy', 'Clear Today'],
    ]) {
      await overlay.getByRole('combobox').fill(typed!);
      await expect(overlay.getByRole('option').filter({ hasText: title! })).toHaveCount(1);
    }
    await overlay.keyboard.press('Escape');

    // "New folder with this tab": the active tab (Third) goes into a new folder in Pinned, named right away.
    await runAction(shell, 'folder.new');
    const name = shell.getByRole('textbox', { name: 'Folder name' });
    await expect(name).toBeFocused();
    await name.fill('Reading');
    await name.press('Enter');
    const folder = pinned.getByRole('treeitem', { name: 'Reading' });
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(pinned.getByRole('treeitem', { name: 'Third page', exact: true })).toHaveAttribute('data-parent', /.+/);

    // Drag Second (in Today) into the folder, just above Third: it's pinned there.
    const third = pinned.getByRole('treeitem').filter({ hasText: 'Third page' });
    const dropAt = await point(third, 6);
    await drag(shell, today.getByRole('treeitem').filter({ hasText: 'Second page' }), dropAt);
    await expect(pinned.getByRole('treeitem'))
      .toHaveCount(3)
      .catch(async (error: Error) => {
        // Where things were at the drop, to tell a missed target from a wrong landing.
        const lists = `Pinned:\n${await pinned.ariaSnapshot()}\nToday:\n${await today.ariaSnapshot()}`;
        throw new Error(`${error.message}\nDropped at ${JSON.stringify(dropAt)}; Third page now at ${JSON.stringify(await third.boundingBox())}\n${lists}`);
      });
    await expect(pinned.getByRole('treeitem').nth(1)).toContainText('Second page');
    await expect(pinned.getByRole('treeitem', { name: 'Second page', exact: true })).toHaveAttribute('data-parent', /.+/);
    await expect(today.getByRole('treeitem')).toHaveCount(1);

    // Clicking folds it: its tabs leave the list until it opens again.
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(pinned.getByRole('treeitem')).toHaveCount(1);

    // The keyboard: → opens, ↓ goes in, ← goes back up to the folder, ← folds.
    await folder.focus();
    await shell.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await shell.keyboard.press('ArrowRight');
    await expect(pinned.getByRole('treeitem', { name: 'Second page', exact: true })).toBeFocused();
    await shell.keyboard.press('ArrowDown');
    await expect(pinned.getByRole('treeitem', { name: 'Third page', exact: true })).toBeFocused();
    await shell.keyboard.press('ArrowLeft');
    await expect(folder).toBeFocused();
    await shell.keyboard.press('ArrowLeft');
    await expect(folder).toHaveAttribute('aria-expanded', 'false');

    // F2 renames.
    await shell.keyboard.press('F2');
    await expect(name).toBeFocused();
    await name.fill('Later');
    await name.press('Enter');
    const later = pinned.getByRole('treeitem', { name: 'Later' });
    await expect(later).toBeVisible();

    // Delete removes the folder and what's in it; Undo brings it all back.
    await later.focus();
    await shell.keyboard.press('Delete');
    await expect(shell.getByRole('tree', { name: 'Pinned' })).toHaveCount(0);
    await expect(shell.getByText('Deleted folder “Later”')).toBeVisible();
    await shell.getByRole('button', { name: 'Undo' }).click();
    await expect(pinned.getByRole('treeitem', { name: 'Later' })).toBeVisible();
    await pinned.getByRole('treeitem', { name: 'Later' }).click();
    await expect(pinned.getByRole('treeitem')).toHaveCount(3);
  } finally {
    await app.close();
  }
});

test('a row moves with the keyboard: Space picks it up, arrows move it, Space drops it, Esc puts it back', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, today } = await setUp(app, ['/second', '/third']);
    const titles = () => today.locator('[data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')));
    expect(await titles()).toEqual(['Third page', 'Second page', 'First page']);

    // First page, up two places.
    await today.getByRole('treeitem', { name: 'First page', exact: true }).focus();
    await shell.keyboard.press('Space');
    await expect(today.getByRole('treeitem').filter({ hasText: 'First page' })).toHaveAttribute('data-dragging', 'true');
    await shell.keyboard.press('ArrowUp');
    await expect.poll(titles).toEqual(['Third page', 'First page', 'Second page']);
    await shell.keyboard.press('ArrowUp');
    await expect.poll(titles).toEqual(['First page', 'Third page', 'Second page']);
    await shell.keyboard.press('Space');
    await expect(today.getByRole('treeitem').filter({ hasText: 'First page' })).not.toHaveAttribute('data-dragging', 'true');
    // Picking it up didn't open it.
    await expect(today.getByRole('treeitem', { name: 'First page', exact: true })).not.toHaveAttribute('aria-current', 'page');

    // Esc puts a row back where it was.
    await today.getByRole('treeitem', { name: 'Second page', exact: true }).focus();
    await shell.keyboard.press('Space');
    await shell.keyboard.press('ArrowUp');
    await expect.poll(titles).toEqual(['First page', 'Second page', 'Third page']);
    await shell.keyboard.press('Escape');
    await expect.poll(titles).toEqual(['First page', 'Third page', 'Second page']);

    // Enter opens the focused row.
    await shell.keyboard.press('Enter');
    await expect(today.getByRole('treeitem', { name: 'Second page', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});

test('Favorites: added by action or by dragging, shared by chords, and a favorite switches to its tab or opens it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    // First page on one site, Second on another.
    const { shell, today } = await setUp(app, ['/second'], () => other.origin);
    const favorites = shell.getByRole('list', { name: 'Favorites' });

    // "Add this tab to Favorites" on the active tab (Second).
    await runAction(shell, 'tab.favorite');
    await expect(favorites.getByRole('listitem')).toHaveCount(1);
    await expect(favorites.getByRole('button', { name: 'Second page' })).toHaveAttribute('aria-current', 'page');
    // The new row pushed the lists down; let them settle before picking one up.
    await shell.waitForTimeout(600);

    // Dragging First onto the row adds it after Second.
    const tile = favorites.getByRole('listitem').first();
    const box = (await tile.boundingBox())!;
    await drag(shell, today.getByRole('treeitem').filter({ hasText: 'First page' }), { x: box.x + box.width - 4, y: box.y + box.height / 2 });
    await expect(favorites.getByRole('listitem')).toHaveCount(2);
    await expect(favorites.getByRole('listitem').nth(1).getByRole('button')).toHaveAccessibleName('First page');

    // A favorite switches to this chord's tab on that site…
    await favorites.getByRole('button', { name: 'First page' }).click();
    await expect(today.getByRole('treeitem', { name: 'First page', exact: true })).toHaveAttribute('aria-current', 'page');
    // …and, with none open, opens one.
    await today.getByRole('treeitem').filter({ hasText: 'First page' }).hover();
    await today.locator('[aria-label="Close First page"]').click();
    await expect(today.getByRole('treeitem')).toHaveCount(1);
    await favorites.getByRole('button', { name: 'First page' }).click();
    await expect(today.getByRole('treeitem').first()).toContainText('First page');
    await expect(today.getByRole('treeitem', { name: 'First page', exact: true })).toHaveAttribute('aria-current', 'page');

    // Every chord shares them.
    await shell.getByRole('button', { name: 'New chord' }).click();
    await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    await expect(favorites.getByRole('listitem')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

/**
 * Motion on whatever the OS says (CI's Windows and macOS machines ask for
 * reduced motion), as frame-snapshot.spec.ts does: main's reading is
 * replaced and announced, and the shell's own media query follows.
 */
async function motionOn(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(({ nativeTheme, systemPreferences }) => {
    systemPreferences.getAnimationSettings = () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false });
    nativeTheme.emit('updated');
  });
  await shell.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(false);
}

test('the active highlight glides to the tab you switch to, from Pinned into Today too, and just appears with tab moves off', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, today, pinned } = await setUp(app, ['/second', '/third']);
    await motionOn(app, shell);
    // The pill on the row on screen: whether it's gliding there (a running animation of its own).
    const gliding = () =>
      shell.evaluate(() => {
        const pill = document.querySelector('[role="treeitem"][aria-current="page"] [data-pill]');
        return pill ? pill.getAnimations().some((a) => a.playState === 'running') : null;
      });
    const quick = { intervals: [16, 16, 16, 32, 64, 100] };
    await today.getByRole('treeitem', { name: 'First page', exact: true }).click();
    await expect.poll(gliding, quick).toBe(true);
    // From Pinned to Today: another list, read where they both are now.
    await runAction(shell, 'tab.pin');
    await expect(pinned.getByRole('treeitem', { name: 'First page', exact: true })).toBeVisible();
    await today.getByRole('treeitem', { name: 'Third page', exact: true }).click();
    await expect.poll(gliding, quick).toBe(true);
    // "Animate tab moves" off: it's just there.
    await runAction(shell, 'app.settings');
    await (await pageWhere(app, isSettings)).evaluate(() => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ motion: { tabMoves: false } }));
    await shell.bringToFront();
    await today.getByRole('treeitem', { name: 'Second page', exact: true }).click();
    await expect(today.getByRole('treeitem', { name: 'Second page', exact: true })).toHaveAttribute('aria-current', 'page');
    await shell.waitForTimeout(50);
    expect(await gliding()).toBe(false);
  } finally {
    await app.close();
  }
});

test('Clear archives every Today tab, and Undo brings them back where they were', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, today } = await setUp(app, ['/second', '/third']);
    const titles = () => today.locator('[data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('title')));
    const before = await titles();
    await shell.getByRole('separator').first().hover();
    await shell.getByRole('button', { name: 'Clear' }).click();
    await expect(today.getByRole('treeitem')).toHaveCount(0);
    await expect(shell.getByText('Archived 3 tabs')).toBeVisible();
    await shell.getByRole('button', { name: 'Undo' }).click();
    await expect(today.getByRole('treeitem')).toHaveCount(3);
    expect(await titles()).toEqual(before);
    // The tab you were on is shown again.
    await expect(today.getByRole('treeitem', { name: 'Third page', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});

test('a private window has no Favorites, makes no folders, and Clear closes its tabs rather than archiving them', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, overlay } = await setUp(app, ['/second']);
    await runAction(shell, 'tab.favorite');
    await expect(shell.getByRole('list', { name: 'Favorites' }).getByRole('listitem')).toHaveCount(1);

    await runAction(shell, 'window.newPrivate');
    const another = async (match: (url: string) => boolean, known: Page) => {
      const find = () => app.windows().find((p) => match(p.url()) && p !== known);
      await expect.poll(() => Boolean(find()), { timeout: 20_000 }).toBe(true);
      return find()!;
    };
    const privateShell = await another(isShell, shell);
    const privateOverlay = await another(isOverlay, overlay);
    await expect(privateShell.getByText('This window is private.')).toBeVisible();
    for (const path of ['/third', '/fourth']) {
      if (!(await privateOverlay.getByRole('dialog').isVisible())) {
        await privateShell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
      }
      await expect(privateOverlay.getByRole('dialog')).toBeVisible();
      await privateOverlay.keyboard.type(`${site.origin}${path}`);
      await privateOverlay.keyboard.press('Enter');
      await expect(privateShell.getByRole('tree', { name: 'Today' }).getByRole('treeitem').first()).toContainText(path === '/third' ? 'Third' : 'Fourth');
    }
    const today = privateShell.getByRole('tree', { name: 'Today' });

    // Favorites are kept and shared, so a private window neither shows them nor adds to them.
    await expect(privateShell.getByRole('list', { name: 'Favorites' })).toHaveCount(0);
    await runAction(privateShell, 'tab.favorite');
    await runAction(privateShell, 'folder.new');
    await expect(privateShell.getByRole('textbox', { name: 'Folder name' })).toHaveCount(0);
    await expect(privateShell.getByRole('tree', { name: 'Pinned' })).toHaveCount(0);
    await expect(shell.getByRole('list', { name: 'Favorites' }).getByRole('listitem')).toHaveCount(1);

    // Clear closes; Undo still brings them back.
    await runAction(privateShell, 'today.clear');
    await expect(today.getByRole('treeitem')).toHaveCount(0);
    await expect(privateShell.getByText('Closed 2 tabs')).toBeVisible();
    await privateShell.getByRole('button', { name: 'Undo' }).click();
    await expect(today.getByRole('treeitem')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('the sidebar resizes from its edge, catches at the default width, and the page follows', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('First page');
    const handle = shell.getByRole('separator', { name: 'Sidebar width' });
    const pageX = async () => (await views(app))[1]!.x;
    await expect.poll(pageX).toBe(248);

    const box = (await handle.boundingBox())!;
    const y = box.y + 200;
    const grab = box.x + box.width / 2;
    await shell.mouse.move(grab, y);
    await shell.mouse.down();
    await shell.mouse.move(grab + 60, y, { steps: 8 });
    await shell.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '308');
    await expect.poll(pageX).toBe(308);

    // Within 8 px of 248 it catches there.
    const now = (await handle.boundingBox())!;
    await shell.mouse.move(now.x + now.width / 2, y);
    await shell.mouse.down();
    await shell.mouse.move(now.x + now.width / 2 - 55, y, { steps: 8 });
    await shell.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '248');

    // Never past 400; a double-click goes back to 248.
    await handle.focus();
    for (let i = 0; i < 8; i++) await shell.keyboard.press('Shift+ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '400');
    await handle.dblclick();
    await expect(handle).toHaveAttribute('aria-valuenow', '248');
    await expect.poll(pageX).toBe(248);
  } finally {
    await app.close();
  }
});

test('a tab dropped on another chord moves there, reloading signed out when that chord keeps its own sign-ins', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login` });
  try {
    const shell = await pageWhere(app, isShell);
    const today = shell.getByRole('tree', { name: 'Today' });
    const chords = shell.getByRole('tablist', { name: 'Chords' });
    await expect(today).toContainText('Signed in');
    // Work keeps its own sign-ins; Personal has the account.
    await shell.getByRole('button', { name: 'New chord' }).click();
    await shell.getByRole('textbox', { name: 'Chord name' }).fill('Work');
    await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    await runAction(shell, 'chord.separateSignIns');
    await chords.getByRole('tab', { name: 'Personal' }).click();
    const { overlay } = { overlay: await pageWhere(app, isOverlay) };
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    // Type once it's open: keys sent before its field has focus go nowhere.
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await overlay.keyboard.type(`${site.origin}/whoami`);
    await overlay.keyboard.press('Enter');
    const whoami = () => app.windows().find((p) => p.url() === `${site.origin}/whoami`)?.title();
    await expect.poll(whoami).toBe('Alex');

    // Drop it on Work in the switcher.
    await drag(shell, today.getByRole('treeitem').filter({ hasText: 'Alex' }), await point(chords.getByRole('tab', { name: 'Work' }), 14));
    await expect(shell.getByText('Moved to Work (sign-ins differ, so it reloaded)')).toBeVisible();
    await expect(today).not.toContainText('Alex');
    await chords.getByRole('tab', { name: 'Work' }).click();
    const row = today.getByRole('treeitem').first();
    await row.click();
    await expect.poll(whoami).toBe('Signed out');

    // Undo takes it home, where it's signed in again.
    await chords.getByRole('tab', { name: 'Personal' }).click();
    await shell.getByRole('group').filter({ hasText: 'Moved to Work' }).getByRole('button', { name: 'Undo' }).click();
    await expect(today).toContainText(/Signed out|Alex/);
    await row.click();
    await expect.poll(whoami).toBe('Alex');
  } finally {
    await app.close();
  }
});

/**
 * Counts, in the shell, each time the sidebar starts to peek. Lifting the shell above the page makes
 * Chromium send it a pointer move where the computer's own pointer is, not the test's: over the page,
 * that puts a peek away again a moment later. So a peek is told by its start, not by its staying.
 */
const countPeeks = (shell: Page) =>
  shell.evaluate(() => {
    const w = window as unknown as { peeks: number };
    w.peeks = 0;
    new MutationObserver((records) => {
      w.peeks += records.filter((r) => r.oldValue === null).length;
    }).observe(document.querySelector('[data-sidebar]')!, { attributes: true, attributeFilter: ['data-peek'], attributeOldValue: true });
  });
const peeks = (shell: Page) => shell.evaluate(() => (window as unknown as { peeks: number }).peeks);

test('minimal mode: off by default, the window’s edge does nothing; turned on in Settings, the edge or the toggle shows the sidebar itself over the page, for good', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_USER_DATA: profile });
  const peekSwitch = (settings: Page) => settings.getByRole('switch', { name: 'Show the sidebar when you point at the window’s edge' });
  /** The sidebar's place on screen, rounded: docked and peeking, it's the same. */
  const box = async (sidebar: Locator) => {
    const b = (await sidebar.boundingBox())!;
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  };
  try {
    const shell = await pageWhere(app, isShell);
    const sidebar = shell.getByRole('navigation', { name: 'Sidebar' });
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('First page');
    const docked = await box(sidebar);
    await countPeeks(shell);
    await shell.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(sidebar).toBeHidden();
    // The page sits right above the shell…
    await expect.poll(async () => (await views(app))[1]!.url).toBe(`${site.origin}/`);

    // …and off by default, neither the window's edge nor resting on the toggle shows the sidebar.
    const show = shell.getByRole('button', { name: 'Show sidebar' });
    const restOnToggle = async () => {
      await show.hover();
      await shell.mouse.move(700, 300);
      await show.hover();
    };
    await shell.mouse.move(300, 300);
    await shell.mouse.move(1, 300, { steps: 6 });
    await shell.waitForTimeout(800);
    await restOnToggle();
    await shell.waitForTimeout(800);
    expect(await peeks(shell)).toBe(0);
    await expect(sidebar).toBeHidden();

    // Settings → Appearance turns it on.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await expect(peekSwitch(settings)).toHaveAttribute('aria-checked', 'false');
    await peekSwitch(settings).click();
    await expect(peekSwitch(settings)).toHaveAttribute('aria-checked', 'true');
    await closeSettings(app);

    // The pointer reaching the window's left edge: the sidebar slides in over the page.
    await shell.mouse.move(300, 300);
    await shell.mouse.move(1, 300, { steps: 6 });
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => (await views(app))[0]!.url).toBe(`${site.origin}/`);
    // The page didn't move.
    expect((await views(app))[0]!.x).toBe(4);
    // It stays while the pointer is in it.
    await shell.mouse.move(60, 300, { steps: 4 });
    await shell.waitForTimeout(800);
    await expect(sidebar).toBeVisible();
    // It's the sidebar itself, where it is when it's showing, with its toggle, buttons and address.
    expect(await box(sidebar)).toEqual(docked);
    await expect(sidebar.getByRole('tree', { name: 'Today' })).toContainText('First page');
    for (const name of ['Show sidebar', 'Back', 'Forward', 'Reload']) await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /^Address/ })).toBeVisible();

    // Pointing back at the page puts it away, and the shell goes back under the page.
    await shell.mouse.move(700, 300, { steps: 6 });
    await expect(sidebar).toBeHidden();
    await expect.poll(async () => (await views(app))[1]!.url).toBe(`${site.origin}/`);
    // Resting on the toggle peeks it too, once the pointer has left it since the sidebar was hidden.
    const before = await peeks(shell);
    await restOnToggle();
    await expect.poll(() => peeks(shell)).toBeGreaterThan(before);
    // The peeking sidebar's own toggle docks it. (In the test, the window's real cursor sits mid-window, and lifting
    // the shell sends a move from there, which puts a peek from the toggle away: on a desk the cursor is on the toggle.)
    await shell.mouse.move(700, 300, { steps: 6 });
    await expect(sidebar).toBeHidden();
    await shell.mouse.move(1, 300, { steps: 6 });
    await expect(sidebar).toBeVisible();
    await shell.mouse.move(60, 300, { steps: 4 });
    await sidebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
    await expect.poll(async () => (await views(app))[1]!.x).toBeGreaterThan(4);
  } finally {
    await app.close();
  }

  // After a relaunch it's still on.
  app = await launch({ CHORD_USER_DATA: profile });
  try {
    const shell = await pageWhere(app, isShell);
    const sidebar = shell.getByRole('navigation', { name: 'Sidebar' });
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('First page');
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await expect(peekSwitch(settings)).toHaveAttribute('aria-checked', 'true');
    await closeSettings(app);
    await countPeeks(shell);
    await shell.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(sidebar).toBeHidden();
    await shell.mouse.move(300, 300);
    await shell.mouse.move(1, 300, { steps: 6 });
    await expect(sidebar).toBeVisible();
    expect(await peeks(shell)).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
