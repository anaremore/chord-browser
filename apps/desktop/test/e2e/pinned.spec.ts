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
import { audit, capturesDir, dispatch, isSettings, isShell, launch, pageWhere, runAction, setReducedMotion, startSite, type Site } from './a11y-kit';
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
  // Whatever the OS says (macOS CI runners have reduce transparency on): the fade, unless a test turns it off.
  await setReducedTransparency(app, shell, false);
  return { app, shell };
}

/** Reduce transparency on or off, stubbed in main and announced (as a11y.spec.ts does). */
async function setReducedTransparency(app: ElectronApplication, shell: Page, reduce: boolean): Promise<void> {
  await app.evaluate(({ nativeTheme }, r) => {
    Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { configurable: true, get: () => r });
    nativeTheme.emit('updated');
  }, reduce);
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-transparency'))).toBe(reduce);
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
      // Whole rows, on the row grid: scrolled to either end, no row shows cut.
      expect(box.height % ROW).toBe(0);
      await expect(today.getByRole('treeitem').first()).toBeInViewport();
      expect((await today.boundingBox())!.height).toBeGreaterThan(4 * ROW);
      // The full height scrolls, so the scrollbar tells the truth.
      expect(await pinned.evaluate((ul) => ul.scrollHeight)).toBe(ROWS * ROW);
      await check('at the top');
      // At its cap it scrolls; more below, the lower edge fades.
      await expect(pinned).toHaveAttribute('data-capped');
      expect(await pinned.evaluate((ul) => getComputedStyle(ul).overflowY)).toBe('auto');
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
      // Whole rows: at the end, the first row on screen starts at Pinned's top edge.
      expect(await pinned.evaluate((ul, row) => ul.scrollTop % row, ROW)).toBe(0);
      // The pointer off the rows, so none shows hovered: onto the shell's own top bar (over the page, it's the
      // page's, and the shell never hears it leave).
      await shell.mouse.move(box.x + box.width + 400, 8);
      await expect(pinned.locator('[data-row]:hover')).toHaveCount(0);
      // Its hover background fades out (fade-fast) before the capture.
      await shell.waitForTimeout(400);
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
    await expect.poll(() => mask(pinned)).toMatch(/gradient/);
    await setReducedTransparency(app, shell, true);
    await expect.poll(() => mask(pinned)).toBe('none');
    await setReducedTransparency(app, shell, false);
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
    // Nothing clipped: the active pill gliding in from Today, a lifted row's shadow, a landing's overshoot.
    await expect(pinned).not.toHaveAttribute('data-capped');
    expect(await pinned.evaluate((ul) => [getComputedStyle(ul).overflowY, getComputedStyle(ul.nextElementSibling!).overflowY])).toEqual(['visible', 'visible']);
    // Today starts right under it, past the divider and New tab, as before.
    const gap = (await todayTree(shell).boundingBox())!.y - ((await pinned.boundingBox())!.y + 4 * ROW);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(3 * ROW);
  } finally {
    await app.close();
  }
});

test('the tab on screen shows in a long Pinned: switched to from out of view, or just pinned at its end; a click doesn’t scroll it', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const today = todayTree(shell);
    const { windowId } = await snapshot(shell);
    const order = await pinnedOrder(shell);
    const row = (id: string) => pinned.locator(`[data-row][data-id="${id}"]`);

    // Switched to as the command bar or Ctrl+Tab does: Pinned scrolls to it.
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: order[150] });
    await expect(row(order[150]!)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => row(order[150]!).evaluate((el) => {
      const box = el.closest('ul')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    })).toBe(true);

    // A click on a row that shows doesn't scroll Pinned.
    const visible = (await drawn(pinned)).find((r) => r.slot === 148)!.id;
    const before = await pinned.evaluate((ul) => ul.scrollTop);
    await row(visible).click();
    await expect(row(visible)).toHaveAttribute('aria-selected', 'true');
    await shell.waitForTimeout(200);
    expect(await pinned.evaluate((ul) => ul.scrollTop)).toBe(before);

    // A Today tab pinned with its key lands at Pinned's end, scrolled into view.
    await pinned.evaluate((ul) => ul.scrollTo({ top: 0 }));
    const tab = (await today.locator('[data-row="tab"]').nth(2).getAttribute('data-id'))!;
    await today.locator(`[data-row][data-id="${tab}"]`).click();
    await runAction(shell, 'tab.pin');
    await expect(row(tab)).toBeAttached();
    await expect.poll(() => row(tab).evaluate((el) => {
      const box = el.closest('ul')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    })).toBe(true);
  } finally {
    await app.close();
  }
});

test('a row leaving a scrolled long Pinned goes out where it was, inside Pinned: with motion, reduced motion, and tab moves off', async () => {
  const { app, shell } = await longPinned();
  try {
    const pinned = pinnedTree(shell);
    const box = (await pinned.boundingBox())!;
    // Rows drawn leaving Pinned, from now on: where each started.
    const watch = () =>
      shell.evaluate(() => {
        const seen: { top: number; bottom: number }[] = [];
        (window as unknown as { exits: typeof seen }).exits = seen;
        new MutationObserver((records) => {
          for (const r of records)
            for (const n of r.addedNodes)
              if (n instanceof HTMLElement && n.matches('[data-exit]')) {
                const b = n.getBoundingClientRect();
                seen.push({ top: b.top, bottom: b.bottom });
              }
        }).observe(document.body, { childList: true, subtree: true });
      });
    const seen = () => shell.evaluate(() => (window as unknown as { exits: { top: number; bottom: number }[] }).exits);
    /** Unpins the row at `slot` (scrolled to the middle first), the way its menu does. */
    const unpin = async (slot: number) => {
      await scrollTo(pinned, 100);
      const id = (await drawn(pinned)).find((r) => r.slot === slot)!.id;
      await watch();
      await dispatch(shell, { t: 'node.move', nodeId: id, section: 'today', index: 0 });
      await expect(pinned.locator(`[data-row][data-id="${id}"]`)).toHaveCount(0);
      await shell.waitForTimeout(400);
      return seen();
    };
    // The leaving layer is clipped to Pinned at its cap: nothing draws over the divider.
    expect(await pinned.evaluate((ul) => getComputedStyle(ul.nextElementSibling!).overflowY)).toBe('hidden');

    await setReducedMotion(app, shell, false);
    await shell.emulateMedia({ reducedMotion: 'no-preference' });
    const moving = await unpin(103);
    expect(moving).toHaveLength(1);
    // Where it was: its slot, less how far Pinned is scrolled.
    expect(Math.abs(moving[0]!.top - (box.y + (103 - 100) * ROW))).toBeLessThanOrEqual(2);
    expect(moving[0]!.bottom).toBeLessThanOrEqual(box.y + box.height + 1);

    await setReducedMotion(app, shell, true);
    await shell.emulateMedia({ reducedMotion: 'reduce' });
    expect(await unpin(104), 'reduced motion: it goes at once').toEqual([]);

    await setReducedMotion(app, shell, false);
    await shell.emulateMedia({ reducedMotion: 'no-preference' });
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Motion' }).click();
    const tabMoves = settings.getByRole('switch', { name: 'Animate tab moves' });
    await tabMoves.click();
    await expect(tabMoves).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['motionOff'])).toContain('tabMoves');
    expect(await unpin(105), 'tab moves off: nothing animates').toEqual([]);
  } finally {
    await app.close();
  }
});

test('a Pinned reaching its cap scrolls from the frame it does: no frame spills over Today, and a tab pinned there shows', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_PERF_TABS: '30', CHORD_PERF_PINNED: '2' });
  try {
    const shell = await pageWhere(app, isShell);
    const pinned = pinnedTree(shell);
    const today = todayTree(shell);
    await expect(pinned.getByRole('treeitem')).toHaveCount(2, { timeout: 20_000 });
    await setReducedTransparency(app, shell, false);
    // How many rows fit under the cap: half the chord's pane.
    const fit = await pinned.evaluate((ul, row) => {
      let el = ul.parentElement!.parentElement;
      while (el && getComputedStyle(el).display === 'contents') el = el.parentElement;
      return Math.floor(el!.getBoundingClientRect().height / 2 / row);
    }, ROW);
    const { windowId } = await snapshot(shell);
    const todayIds = () => today.locator('[data-row="tab"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')!));
    // Pinned filled to its cap, from elsewhere (as another window or a drop would): it fits, nothing scrolls.
    for (const id of (await todayIds()).slice(1, fit - 1)) await dispatch(shell, { t: 'node.move', nodeId: id, section: 'pinned', index: 0, parentId: null });
    await expect(pinned.getByRole('treeitem')).toHaveCount(fit);
    await expect(pinned).not.toHaveAttribute('data-capped');

    /** From now on, every frame: whether Pinned's rows are taller than it while it doesn't scroll (spilling over Today). */
    const watchSpill = () =>
      pinned.evaluate((ul) => {
        const probe = { spilled: 0, frames: 0 };
        (window as unknown as { spill: typeof probe }).spill = probe;
        // Laid-out heights, not transforms: a row sliding into place isn't a spill.
        const spills = () => {
          const rows = [...ul.children].reduce((sum, li) => sum + (li as HTMLElement).offsetHeight, 0);
          return ul.isConnected && rows > ul.clientHeight + 1 && getComputedStyle(ul).overflowY === 'visible';
        };
        // As each frame is about to be painted: a ResizeObserver reports after layout, before paint (rows reaching
        // the cap resize the list), as does a frame's first callback after the shell's own.
        const observer = new ResizeObserver(() => {
          if (spills()) probe.spilled++;
        });
        observer.observe(ul);
        const step = () => {
          probe.frames++;
          if (spills()) probe.spilled++;
          if (probe.frames < 60) requestAnimationFrame(step);
          else observer.disconnect();
        };
        requestAnimationFrame(step);
      });
    const spilled = () => shell.evaluate(() => (window as unknown as { spill: { spilled: number; frames: number } }).spill);

    // One more from elsewhere: it scrolls from the first frame its rows don't fit.
    await watchSpill();
    await dispatch(shell, { t: 'node.move', nodeId: (await todayIds())[1], section: 'pinned', index: 0, parentId: null });
    await expect(pinned).toHaveAttribute('data-capped');
    await expect.poll(async () => (await spilled()).frames).toBe(60);
    expect((await spilled()).spilled, 'no frame spills over Today').toBe(0);

    // Back under the cap, then the tab on screen pinned with its key, past it: it lands at the end, in view.
    const last = await pinned.locator('[data-row]').first().getAttribute('data-id');
    await dispatch(shell, { t: 'node.move', nodeId: last, section: 'today', index: 0 });
    await expect(pinned).not.toHaveAttribute('data-capped');
    const tab = (await todayIds())[3]!;
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: tab });
    await expect(today.locator(`[data-row][data-id="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
    await watchSpill();
    await runAction(shell, 'tab.pin');
    const row = pinned.locator(`[data-row][data-id="${tab}"]`);
    await expect(row).toBeAttached();
    await expect(pinned).toHaveAttribute('data-capped');
    await expect.poll(() => row.evaluate((el) => {
      const box = el.closest('ul')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    })).toBe(true);
    await expect.poll(async () => (await spilled()).frames).toBe(60);
    expect((await spilled()).spilled, 'no frame spills over Today').toBe(0);
  } finally {
    await app.close();
  }
});
