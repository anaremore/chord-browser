/**
 * A long Pinned (DESIGN.md §6.7): it grows to its cap, half the chord's pane,
 * then scrolls on its own, windowed above 150 rows as Today is, and its lower
 * edge fades while there's more below. Today keeps the rest of the pane.
 * Scrolling, the keyboard, a drag past its edge, drags across the lists and
 * into a folder, each chord's scroll kept, reduced transparency, and a short
 * Pinned left as it was. The seeded tabs come from CHORD_PERF_PINNED and
 * CHORD_PERF_FOLDERS (src/main/perf-seed.ts), asleep.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { audit, capturesDir, dispatch, isShell, launch, pageWhere, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const ROW = 32;
/** 300 pinned tabs: 200 loose, then 5 folders of 20, the 1st, 3rd and 5th open. */
const PINNED = 300;
const ROWS = 200 + 5 + 3 * 20;

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>First page</title><p>One</p>' });
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

const pinnedTree = (shell: Page) => shell.getByRole('tree', { name: 'Pinned' });
const todayTree = (shell: Page) => shell.getByRole('tree', { name: 'Today' });

async function longPinned(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_PERF_TABS: '20', CHORD_PERF_PINNED: String(PINNED), CHORD_PERF_FOLDERS: '5', ...env });
  const shell = await pageWhere(app, isShell);
  await expect(pinnedTree(shell).getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '205', { timeout: 30_000 });
  return { app, shell };
}

type Node = { id: string; kind: string; chordId: string; section: string; parentId: string | null; rank: string; collapsed?: boolean };
type Snapshot = { windowId: string; state: { windows: Record<string, { activeChordId: string }>; nodes: Record<string, Node> } };
const snapshot = (shell: Page) =>
  shell.evaluate(() => (window as unknown as { chord: { state: { snapshot(): Promise<Snapshot> } } }).chord.state.snapshot());

/** Pinned's rows from main's state, as the sidebar flattens them: each folder's children after it when it's open. */
async function pinnedOrder(shell: Page): Promise<string[]> {
  const { windowId, state } = await snapshot(shell);
  const chordId = state.windows[windowId]!.activeChordId;
  const nodes = Object.values(state.nodes).filter((n) => n.chordId === chordId && n.section === 'pinned');
  const out: string[] = [];
  const walk = (parent: string | null) => {
    for (const n of nodes.filter((m) => m.parentId === parent).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1))) {
      out.push(n.id);
      if (n.kind === 'folder' && !n.collapsed) walk(n.id);
    }
  };
  walk(null);
  return out;
}

/** The rows in the DOM: each one's ID and the slot it's drawn in. */
const drawn = (list: Locator) =>
  list.evaluate((ul, row) => {
    const top = ul.getBoundingClientRect().top - ul.scrollTop;
    return [...ul.querySelectorAll<HTMLElement>(':scope > [data-row]')].map((el) => ({ id: el.dataset['id']!, slot: Math.round((el.getBoundingClientRect().top - top) / row) }));
  }, ROW);

/** The focused row: its ID, which list it's in, and whether it shows inside that list's box. */
const focusedRow = (shell: Page) =>
  shell.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const list = el?.closest<HTMLElement>('[role="tree"]');
    if (!el || !list) return null;
    const box = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { id: el.dataset['id'], tree: list.getAttribute('aria-label'), shows: r.top >= box.top - 1 && r.bottom <= box.bottom + 1 };
  });

const scrollTo = async (list: Locator, row: number) => {
  await list.evaluate((ul, top) => ul.scrollTo({ top }), row * ROW);
  await expect.poll(async () => (await drawn(list)).some((r) => r.slot === row)).toBe(true);
};

const mask = (list: Locator) => list.evaluate((ul) => getComputedStyle(ul).maskImage);

for (const appearance of ['light', 'dark'] as const) {
  test(`a long Pinned stops at half the pane and scrolls on its own, windowed, its lower edge fading while there's more (${appearance})`, async () => {
    const { app, shell } = await longPinned({ CHORD_APPEARANCE: appearance });
    try {
      const pinned = pinnedTree(shell);
      const today = todayTree(shell);
      const order = await pinnedOrder(shell);
      expect(order).toHaveLength(ROWS);
      /** Mounted rows sit in their slots, in the state's order, and only rows near the view are mounted. */
      const check = async (where: string) => {
        const rows = await drawn(pinned);
        expect(rows.length, `rows mounted, ${where}`).toBeLessThan(40);
        for (const r of rows) expect(order[r.slot], `a row drawn where it belongs, ${where}`).toBe(r.id);
      };

      // At most half the chord's pane; Today has the rest, its rows on screen.
      // The chord's pane: the first box around Pinned's (the tree around both lists has none of its own).
      const pane = await pinned.evaluate((ul) => {
        let el = ul.parentElement!.parentElement;
        while (el && getComputedStyle(el).display === 'contents') el = el.parentElement;
        return el!.getBoundingClientRect().height;
      });
      const box = (await pinned.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(pane / 2 + 1);
      expect(box.height).toBeGreaterThan(pane / 2 - ROW);
      await expect(today.getByRole('treeitem').first()).toBeInViewport();
      expect((await today.boundingBox())!.height).toBeGreaterThan(4 * ROW);
      // The full height scrolls, so the scrollbar tells the truth.
      expect(await pinned.evaluate((ul) => ul.scrollHeight)).toBe(ROWS * ROW);
      await check('at the top');
      // More below: the lower edge fades.
      await expect(pinned).toHaveAttribute('data-more');
      expect(await mask(pinned)).toMatch(/gradient/);
      await shell.screenshot({ path: resolve(capturesDir, `pinned-cap-${appearance}.png`) });

      await scrollTo(pinned, 120);
      await check('in the middle');
      // Rows unmounted above and below: still a tree a screen reader can read (DESIGN.md §10).
      expect(await audit(shell, `windowed Pinned (${appearance})`, { appearance, include: '[role="tree"][aria-label="Pinned"]' })).toEqual([]);

      // A wheel, the way a hand scrolls, to the end: its folders, and no fade past the last row.
      await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 30; i++) await shell.mouse.wheel(0, 400);
      await expect.poll(async () => (await drawn(pinned)).some((r) => r.slot === ROWS - 1)).toBe(true);
      await expect(pinned.locator(`[data-row][data-id="${order.at(-1)}"]`)).toBeInViewport();
      await check('at the end');
      await expect(pinned).not.toHaveAttribute('data-more');
      expect(await mask(pinned)).toBe('none');
      await shell.screenshot({ path: resolve(capturesDir, `pinned-cap-end-${appearance}.png`) });
      // Today didn't move.
      expect(await today.evaluate((ul) => ul.scrollTop)).toBe(0);
    } finally {
      await app.close();
    }
  });
}

test('the keyboard walks a long Pinned: arrows cross its window and into Today, each row scrolled into view in its own list', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const today = todayTree(shell);
    const order = await pinnedOrder(shell);
    // From Today's first row, ↑ is Pinned's last: Pinned scrolls to its end to show it.
    await today.getByRole('treeitem').first().focus();
    await shell.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(shell)).toEqual({ id: order.at(-1), tree: 'Pinned', shows: true });
    for (let i = 0; i < 40; i++) await shell.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(shell)).toEqual({ id: order.at(-41), tree: 'Pinned', shows: true });

    // Scrolled away with the wheel, the focused row keeps the focus (it stays mounted), and ↓ brings it back.
    await scrollTo(pinned, 0);
    expect((await focusedRow(shell))?.id).toBe(order.at(-41));
    await shell.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(shell)).toEqual({ id: order.at(-40), tree: 'Pinned', shows: true });

    // Home: Pinned's first row, at the top.
    await shell.keyboard.press('Home');
    await expect.poll(() => focusedRow(shell)).toEqual({ id: order[0], tree: 'Pinned', shows: true });
    expect(await pinned.evaluate((ul) => ul.scrollTop)).toBe(0);

    // Picked up with Space and moved down: it stays under the keyboard, mounted wherever Pinned scrolls.
    for (let i = 0; i < 20; i++) await shell.keyboard.press('ArrowDown');
    const picked = order[20]!;
    await expect.poll(() => focusedRow(shell)).toEqual({ id: picked, tree: 'Pinned', shows: true });
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText('Picked up');
    await shell.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(shell)).toEqual({ id: picked, tree: 'Pinned', shows: true });
    await pinned.evaluate((ul) => ul.scrollTo({ top: ul.scrollHeight }));
    await expect(pinned.locator(`[data-row][data-id="${picked}"]`)).toBeAttached();
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText('Dropped');
    expect((await pinnedOrder(shell)).indexOf(picked)).toBe(21);
  } finally {
    await app.close();
  }
});

/** Picks a row up, carries it to (x, y) the way a hand does, and holds it there; `drop` lets go. */
async function carry(shell: Page, from: Locator, to: { x: number; y: number }) {
  const b = (await from.boundingBox())!;
  const x = b.x + b.width / 2;
  await shell.mouse.move(x, b.y + b.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(x, b.y + b.height / 2 + 6, { steps: 4 });
  await shell.mouse.move(to.x, to.y, { steps: 12 });
}

test('a drag past the edge of a long Pinned scrolls it, and the row lands among rows that weren’t mounted when it began', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const mountedAtStart = new Set((await drawn(pinned)).map((r) => r.slot));
    const order = await pinnedOrder(shell);
    const id = order[1]!;
    const box = (await pinned.boundingBox())!;
    const x = box.x + box.width / 2;
    // Held at Pinned's bottom edge: it scrolls, and the rows coming into view mount.
    await carry(shell, pinned.locator(`[data-row][data-id="${id}"]`), { x, y: box.y + box.height - 4 });
    await expect.poll(() => pinned.evaluate((ul) => ul.scrollTop), { timeout: 15_000 }).toBeGreaterThan(60 * ROW);
    // Back into the list, where it stops scrolling, over rows that weren't there when it was picked up.
    await shell.mouse.move(x, box.y + box.height / 2, { steps: 8 });
    await shell.waitForTimeout(300);
    await shell.mouse.move(x, box.y + box.height / 2 + 2, { steps: 2 });
    await shell.waitForTimeout(300);
    // Where it has made room for itself (its siblings are all loose tabs up here): its place among them.
    const landing = Number(await pinned.locator(`[data-row][data-id="${id}"]`).first().getAttribute('aria-posinset'));
    expect(landing).toBeGreaterThan(60);
    expect(mountedAtStart.has(landing - 1), 'it lands where no row was mounted when the drag began').toBe(false);
    await shell.mouse.up();
    // Main has it there, and the list doesn't jump back on the way.
    await expect.poll(async () => (await pinnedOrder(shell)).indexOf(id)).toBe(landing - 1);
    await expect(pinned.locator('[data-dnd-placeholder]')).toHaveCount(0);
    await expect(pinned.locator(`[data-row][data-id="${id}"]`)).toHaveAttribute('aria-posinset', String(landing));
  } finally {
    await app.close();
  }
});

test('drags across a long Pinned’s scrolled edge: from Today into a folder at its end, and from deep in Pinned to Today', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const today = todayTree(shell);
    const node = async (id: string) => (await snapshot(shell)).state.nodes[id]!;

    // Pinned scrolled to its end, where its last folder is open: a Today tab dropped on one of that folder's tabs joins it.
    await pinned.evaluate((ul) => ul.scrollTo({ top: ul.scrollHeight }));
    const order = await pinnedOrder(shell);
    const into = order.at(-5)!;
    const folder = (await node(into)).parentId!;
    expect((await node(folder)).kind).toBe('folder');
    const target = pinned.locator(`[data-row][data-id="${into}"]`);
    await expect(target).toBeInViewport();
    const moving = (await today.locator('[data-row="tab"]').nth(2).getAttribute('data-id'))!;
    const t = (await target.boundingBox())!;
    await carry(shell, today.locator(`[data-row][data-id="${moving}"]`), { x: t.x + t.width / 2, y: t.y + t.height / 2 - 4 });
    await shell.waitForTimeout(300);
    await shell.mouse.move(t.x + t.width / 2 + 1, t.y + t.height / 2 - 4, { steps: 2 });
    await shell.mouse.up();
    await expect.poll(async () => {
      const n = await node(moving);
      return [n.section, n.parentId];
    }).toEqual(['pinned', folder]);
    await expect(pinned.locator(`[data-row][data-id="${moving}"]`)).toHaveAttribute('data-parent', folder);

    // From the middle of Pinned (rows never mounted at the start) onto Today: it's unpinned there.
    await scrollTo(pinned, 100);
    const out = (await pinnedOrder(shell))[102]!;
    const onto = today.locator('[data-row="tab"]').nth(3);
    const o = (await onto.boundingBox())!;
    await carry(shell, pinned.locator(`[data-row][data-id="${out}"]`), { x: o.x + o.width / 2, y: o.y + 6 });
    await shell.waitForTimeout(300);
    await shell.mouse.move(o.x + o.width / 2 + 1, o.y + 6, { steps: 2 });
    await shell.mouse.up();
    await expect.poll(async () => (await node(out)).section).toBe('today');
    await expect(today.locator(`[data-row][data-id="${out}"]`)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('each chord keeps where its Pinned and Today were scrolled, and reduce transparency gives the fade a hard edge', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const today = todayTree(shell);
    await scrollTo(pinned, 150);
    await today.evaluate((ul, top) => ul.scrollTo({ top }), 3 * ROW);
    const before = { pinned: await pinned.evaluate((ul) => ul.scrollTop), today: await today.evaluate((ul) => ul.scrollTop) };
    expect(before.today).toBeGreaterThan(0);

    const { windowId, state } = await snapshot(shell);
    const home = state.windows[windowId]!.activeChordId;
    await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: 'briefcase', theme: { stops: [{ l: 0.72, c: 0.1, h: 200 }], grain: 0.2, appearance: 'light' } });
    await expect(pinnedTree(shell)).toHaveCount(0);
    await dispatch(shell, { t: 'chord.activate', windowId, chordId: home });
    await expect.poll(async () => ({ pinned: await pinned.evaluate((ul) => ul.scrollTop), today: await today.evaluate((ul) => ul.scrollTop) })).toEqual(before);
    // Back where it was, with the rows there mounted and in their places.
    const order = await pinnedOrder(shell);
    const rows = await drawn(pinned);
    expect(rows.some((r) => r.slot === 150)).toBe(true);
    for (const r of rows) expect(order[r.slot]).toBe(r.id);

    // Reduce transparency: no fade, a hard edge.
    const setReduced = async (reduce: boolean) => {
      await app.evaluate(({ nativeTheme }, r) => {
        Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { configurable: true, get: () => r });
        nativeTheme.emit('updated');
      }, reduce);
      await shell.evaluate(() => (window as unknown as { chord: { system: { info(): Promise<unknown> } } }).chord.system.info());
    };
    await setReduced(false);
    await expect.poll(() => mask(pinned)).toMatch(/gradient/);
    await setReduced(true);
    await expect.poll(() => mask(pinned)).toBe('none');
    await setReduced(false);
    await expect.poll(() => mask(pinned)).toMatch(/gradient/);
  } finally {
    await app.close();
  }
});

test('a short Pinned is as it was: as tall as its rows, nothing to scroll, no fade', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_PERF_TABS: '20', CHORD_PERF_PINNED: '4' });
  try {
    const shell = await pageWhere(app, isShell);
    const pinned = pinnedTree(shell);
    await expect(pinned.getByRole('treeitem')).toHaveCount(4, { timeout: 20_000 });
    expect(await pinned.evaluate((ul) => [ul.clientHeight, ul.scrollHeight, ul.scrollTop])).toEqual([4 * ROW, 4 * ROW, 0]);
    await expect(pinned).not.toHaveAttribute('data-more');
    expect(await mask(pinned)).toBe('none');
    // Today starts right under it, past the divider and New tab, as before.
    const gap = (await todayTree(shell).boundingBox())!.y - ((await pinned.boundingBox())!.y + 4 * ROW);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(3 * ROW);
  } finally {
    await app.close();
  }
});
