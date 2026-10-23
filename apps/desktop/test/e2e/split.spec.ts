/**
 * Split view (ROADMAP.md Phase 2, DESIGN.md §7.9, §8.4): made by dropping a
 * tab on the page, from a tab's menu, or with "Split with…"; focus follows
 * clicks and keys act on the focused pane; dividers resize; a pane dragged
 * out (or Separate) un-splits; and a split comes back after a relaunch.
 * Native menus can't be clicked from a test, so the menu a right-click pops
 * is caught in main and its item clicked there.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title><p>First</p>',
    '/second': '<title>Second page</title><p>Second</p>',
    '/third': '<title>Third page</title><p>Third</p>',
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function launch(env: Record<string, string>, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  // A fresh profile per launch unless a test reuses one: tests never touch a developer's real data.
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');

interface Chord {
  chord: {
    action: { run(a: string): Promise<void> };
    overlay: { open(m: string): Promise<void> };
    state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string | null> }>; nodes: Record<string, Node> } }>; dispatch(c: unknown): Promise<void> };
  };
}
interface Node {
  id: string;
  kind: string;
  parentId: string | null;
  rank: string;
  title?: string;
  url?: string;
  direction?: string;
  sizes?: number[];
}

const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as Chord).chord.action.run(a), action);
const dispatch = (shell: Page, command: unknown) => shell.evaluate((c) => (window as unknown as Chord).chord.state.dispatch(c), command);

/** The split on screen (if any): its panes' titles in order, how they share the frame, and the focused one. */
const splitState = (shell: Page) =>
  shell.evaluate(async () => {
    const { windowId, state } = await (window as unknown as Chord).chord.state.snapshot();
    const win = state.windows[windowId]!;
    const active = win.activeTab[win.activeChordId] ?? null;
    const nodes = Object.values(state.nodes);
    const parent = active ? state.nodes[active]?.parentId : null;
    const split = parent ? nodes.find((n) => n.id === parent && n.kind === 'split') : undefined;
    const panes = split ? nodes.filter((n) => n.parentId === split.id).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1)) : [];
    return {
      windowId,
      active: active ? (state.nodes[active]?.title ?? '') : '',
      activeId: active,
      ids: Object.fromEntries(nodes.filter((n) => n.kind === 'tab').map((n) => [n.title ?? '', n.id])),
      panes: panes.map((p) => p.title ?? ''),
      sizes: split?.sizes ?? [],
      direction: split?.direction ?? null,
      splits: nodes.filter((n) => n.kind === 'split').length,
    };
  });

/** The web pages in the window's frame, left to right (then top to bottom), with their bounds. */
const pageViews = async (app: ElectronApplication) => {
  const all = await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0]!.contentView.children.map((v) => ({
      ...v.getBounds(),
      visible: v.getVisible(),
      url: 'webContents' in v ? (v as { webContents: { getURL(): string } }).webContents.getURL() : '',
    })),
  );
  return all.filter((v) => /^https?:/.test(v.url)).sort((a, b) => a.x - b.x || a.y - b.y);
};

/** Drag with the mouse the way a hand does: pick up, travel, settle, let go. */
async function drag(shell: Page, from: Locator, to: { x: number; y: number }) {
  const a = (await from.boundingBox())!;
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 4 });
  await shell.mouse.move(to.x, to.y, { steps: 16 });
  await shell.waitForTimeout(250);
  await shell.mouse.move(to.x + 1, to.y, { steps: 2 });
  await shell.mouse.up();
  // A new drag can't start while this drop's animation settles.
  await shell.waitForTimeout(600);
}

/** Catch the next native menu main pops up, and click its item labeled `label`. */
async function clickMenuItem(app: ElectronApplication, open: () => Promise<void>, label: string) {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as { caughtMenu?: unknown };
    g.caughtMenu = undefined;
    Menu.prototype.popup = function (this: unknown) {
      g.caughtMenu = this;
    };
  });
  await open();
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as { caughtMenu?: unknown }).caughtMenu))).toBe(true);
  const clicked = await app.evaluate((_, wanted) => {
    const menu = (globalThis as { caughtMenu?: { items: { label: string; enabled: boolean; click(): void }[] } }).caughtMenu!;
    const item = menu.items.find((i) => i.label === wanted);
    if (!item?.enabled) return false;
    item.click();
    return true;
  }, label);
  expect(clicked, `menu item “${label}”`).toBe(true);
}

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

/** Shell, command bar, and a few tabs opened through it (the newest is active, at the top of Today). */
async function setUp(app: ElectronApplication, paths: string[]) {
  const shell = await pageWhere(app, isShell);
  const overlay = await pageWhere(app, isOverlay);
  const today = shell.getByRole('tree', { name: 'Today' });
  await expect(today).toContainText('First page');
  for (const path of paths) {
    await shell.evaluate(() => (window as unknown as Chord).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await overlay.keyboard.type(`${site.origin}${path}`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('treeitem').first()).toContainText(new RegExp(path.slice(1), 'i'));
  }
  return { shell, overlay, today };
}

const GAP = 8;
/** A pane's narrowest (SPLIT.minPane in @chord/core). */
const MIN_PANE = 320;

test('a tab dropped on the page splits the frame; clicks move focus, keys act on the focused pane, dividers resize', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, today } = await setUp(app, ['/second']);
    const [frame] = await pageViews(app);
    expect(frame).toBeDefined();

    // Drop "First page" on the right of the page: it opens beside "Second page".
    await drag(shell, today.getByRole('treeitem').filter({ hasText: 'First page' }), { x: frame!.x + frame!.width - 60, y: frame!.y + frame!.height / 2 });
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Second page', 'First page']);
    expect(await splitState(shell)).toMatchObject({ active: 'First page', direction: 'row', sizes: [0.5, 0.5] });
    // Both pages are on screen, side by side, 8 px apart, filling the frame.
    await expect.poll(async () => (await pageViews(app)).map((v) => v.url)).toEqual([`${site.origin}/second`, `${site.origin}/`]);
    const [left, right] = await pageViews(app);
    expect(left!.x).toBe(frame!.x);
    expect(right!.x - (left!.x + left!.width)).toBe(GAP);
    expect(right!.x + right!.width).toBe(frame!.x + frame!.width);
    expect(Math.abs(left!.width - right!.width)).toBeLessThanOrEqual(1);
    // In the sidebar it's one row, with its titles joined; the focused pane has the ring.
    await expect(today.getByRole('treeitem', { name: 'Split: Second page + First page' })).toHaveAttribute('aria-current', 'page');
    const ids = (await splitState(shell)).ids;
    await expect(shell.locator(`[data-pane="${ids['First page']}"]`)).toHaveAttribute('data-focused');

    // Clicking into the other page focuses it: the address and the ring follow.
    const second = await pageWhere(app, (url) => url === `${site.origin}/second`);
    await second.mouse.click(120, 120);
    await expect.poll(async () => (await splitState(shell)).active).toBe('Second page');
    await expect(shell.locator(`[data-pane="${ids['Second page']}"]`)).toHaveAttribute('data-focused');
    await expect(shell.getByRole('button', { name: /127\.0\.0\.1/ }).first()).toHaveAttribute('title', `${site.origin}/second`);

    // Dragging the divider resizes both panes live; near even it snaps to even; double-click evens out.
    const divider = shell.locator('[data-divider="0"]');
    const box = (await divider.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await shell.mouse.move(cx, cy);
    await shell.mouse.down();
    await shell.mouse.move(cx - 80, cy, { steps: 6 });
    await shell.mouse.move(cx - 160, cy, { steps: 6 });
    await shell.mouse.up();
    await expect.poll(async () => (await splitState(shell)).sizes[0]!).toBeLessThan(0.45);
    // Well over 120 px narrower, unless that would take it under a pane's minimum (on a small screen, it does).
    const narrowed = Math.max(MIN_PANE, left!.width - 120);
    await expect.poll(async () => (await pageViews(app))[0]!.width).toBeLessThanOrEqual(narrowed);
    expect((await pageViews(app))[0]!.width).toBeGreaterThanOrEqual(MIN_PANE);
    const moved = (await splitState(shell)).sizes;
    expect(moved[0]! + moved[1]!).toBeCloseTo(1, 6);
    await divider.dblclick();
    await expect.poll(async () => (await splitState(shell)).sizes).toEqual([0.5, 0.5]);
    const nudge = (await divider.boundingBox())!;
    await shell.mouse.move(nudge.x + nudge.width / 2, nudge.y + nudge.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(nudge.x + nudge.width / 2 + 5, nudge.y + nudge.height / 2, { steps: 3 });
    await shell.mouse.up();
    await shell.waitForTimeout(300);
    expect((await splitState(shell)).sizes).toEqual([0.5, 0.5]);

    // Keyboard actions act on the focused pane. (Playwright's key presses in a page never reach
    // before-input-event, so they're run through the action registry, as the shortcut handler does.)
    await runAction(shell, 'address.copy');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${site.origin}/second`);
    // Close tab closes the focused pane; the split of one dissolves.
    await runAction(shell, 'tab.close');
    await expect.poll(async () => (await splitState(shell)).splits).toBe(0);
    expect((await splitState(shell)).active).toBe('First page');
    await expect.poll(async () => (await pageViews(app)).map((v) => v.url)).toEqual([`${site.origin}/`]);
    expect((await pageViews(app))[0]).toMatchObject({ x: frame!.x, width: frame!.width });
  } finally {
    await app.close();
  }
});

test('the tab menu and "Split with…" split too; dragging a pane out or Separate un-splits, with Undo', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const { shell, overlay, today } = await setUp(app, ['/second', '/third']);

    // Right-click → Open in split: beside the page on screen.
    await clickMenuItem(app, () => today.getByRole('treeitem', { name: 'First page', exact: true }).click({ button: 'right' }), 'Open in split');
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Third page', 'First page']);

    // "Split with…" (its shortcut is in the registry): the command bar picks what opens beside it.
    await runAction(shell, 'split.with');
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await expect(overlay.getByRole('combobox')).toHaveAttribute('placeholder', 'Split with a tab or a page');
    await overlay.keyboard.type('second');
    await expect(overlay.getByRole('option').first()).toContainText('Second page');
    await overlay.keyboard.press('Enter');
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Third page', 'First page', 'Second page']);
    expect((await splitState(shell)).active).toBe('Second page');
    await expect.poll(async () => (await pageViews(app)).length).toBe(3);

    // ⌘⌥[ / ⌘⌥] move focus between panes.
    await runAction(shell, 'split.focusPrevious');
    await expect.poll(async () => (await splitState(shell)).active).toBe('First page');

    // Opened, the split lists its tabs; dragging one out to the sidebar takes it out of the split.
    const splitRow = today.getByRole('treeitem', { name: /^Split: / });
    await splitRow.hover();
    await shell.locator('[data-split-toggle]').click();
    await expect(today.getByRole('treeitem')).toHaveCount(4);
    const splitBox = (await splitRow.boundingBox())!;
    await drag(shell, shell.locator('[data-row="tab"][data-parent]').filter({ hasText: 'Second page' }), { x: splitBox.x + splitBox.width / 2, y: splitBox.y + splitBox.height - 4 });
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Third page', 'First page']);
    await expect(today.getByRole('treeitem', { name: 'Second page', exact: true })).toBeVisible();
    await expect.poll(async () => (await pageViews(app)).length).toBe(2);

    // Separate: every pane its own tab again, and Undo joins them back as they were.
    await runAction(shell, 'split.separate');
    await expect.poll(async () => (await splitState(shell)).splits).toBe(0);
    await expect.poll(async () => (await pageViews(app)).length).toBe(1);
    await shell.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Third page', 'First page']);
    await expect.poll(async () => (await pageViews(app)).length).toBe(2);

    // Dragging out one of the last two dissolves the split.
    const again = (await today.getByRole('treeitem', { name: 'Second page', exact: true }).boundingBox())!;
    await drag(shell, shell.locator('[data-row="tab"][data-parent]').filter({ hasText: 'First page' }), { x: again.x + again.width / 2, y: again.y + again.height - 4 });
    await expect.poll(async () => (await splitState(shell)).splits).toBe(0);
    await expect.poll(async () => (await pageViews(app)).length).toBe(1);
  } finally {
    await app.close();
  }
});

test('a split comes back after a relaunch, exactly as it was', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, profile);
  try {
    const { shell } = await setUp(app, ['/second']);
    const { windowId, activeId, ids } = await splitState(shell);
    await dispatch(shell, { t: 'split.add', windowId, withId: activeId, nodeId: ids['First page'], direction: 'column' });
    await expect.poll(async () => (await splitState(shell)).panes).toEqual(['Second page', 'First page']);
    const splitId = await shell.evaluate(async () => {
      const { state } = await (window as unknown as Chord).chord.state.snapshot();
      return Object.values(state.nodes).find((n) => n.kind === 'split')!.id;
    });
    await dispatch(shell, { t: 'split.resize', splitId, sizes: [0.3, 0.7] });
    await expect.poll(async () => (await splitState(shell)).sizes).toEqual([0.3, 0.7]);
  } finally {
    await app.close();
  }

  app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, profile);
  try {
    const shell = await pageWhere(app, isShell);
    const today = shell.getByRole('tree', { name: 'Today' });
    await expect(today.getByRole('treeitem', { name: 'Split: Second page + First page' })).toBeVisible();
    expect(await splitState(shell)).toMatchObject({ panes: ['Second page', 'First page'], direction: 'column', sizes: [0.3, 0.7] });
    // Stacked, the first pane about 30% of the frame.
    await expect.poll(async () => (await pageViews(app)).length).toBe(2);
    const [top, bottom] = (await pageViews(app)).sort((a, b) => a.y - b.y);
    expect(top!.x).toBe(bottom!.x);
    expect(bottom!.y - (top!.y + top!.height)).toBe(GAP);
    expect(top!.height / (top!.height + bottom!.height)).toBeCloseTo(0.3, 2);
  } finally {
    await app.close();
  }
});
