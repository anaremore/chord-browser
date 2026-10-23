/**
 * A long Today list (DESIGN.md §6.7: windowed above 150 rows) and the archive
 * arc (§6.5): scrolling, the keyboard to the end of 200 tabs, a drag past the
 * window's edge, and Clear's arc with motion and with reduced motion. The
 * seeded tabs come from CHORD_PERF_TABS (src/main/perf-seed.ts), asleep.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { audit, capturesDir, isSettings, isShell, launch, pageWhere, runAction, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const TABS = 200;
const ROW = 32;

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>First page</title><p>One</p>' });
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

const today = (shell: Page) => shell.getByRole('tree', { name: 'Today' });

/** Chord with the home tab and 200 sleeping Today tabs. */
async function longToday(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_PERF_TABS: String(TABS), ...env });
  const shell = await pageWhere(app, isShell);
  await expect(today(shell).getByRole('treeitem').first()).toHaveAttribute('aria-setsize', String(TABS + 1), { timeout: 20_000 });
  return { app, shell };
}

/**
 * Motion on or off whatever the OS says (as perf.spec.ts does): main's
 * reduced-motion setting is replaced and announced, and the page's own
 * `prefers-reduced-motion` follows, for Motion's `reducedMotion="user"`.
 */
async function setMotion(app: ElectronApplication, shell: Page, on: boolean): Promise<void> {
  await app.evaluate(({ nativeTheme, systemPreferences }, reduced) => {
    systemPreferences.getAnimationSettings = () => ({ shouldRenderRichAnimation: !reduced, scrollAnimationsEnabledBySystem: !reduced, prefersReducedMotion: reduced });
    nativeTheme.emit('updated');
  }, !on);
  await shell.emulateMedia({ reducedMotion: on ? 'no-preference' : 'reduce' });
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(!on);
}

/** The rows in the DOM: each one's place in the list (aria-posinset) and the slot it's drawn in. */
const drawn = (list: Locator) =>
  list.evaluate((ul, row) => {
    const top = ul.getBoundingClientRect().top - ul.scrollTop;
    return [...ul.querySelectorAll<HTMLElement>(':scope > [data-row]')].map((el) => ({
      pos: Number(el.getAttribute('aria-posinset')),
      size: Number(el.getAttribute('aria-setsize')),
      slot: Math.round((el.getBoundingClientRect().top - top) / row),
    }));
  }, ROW);

/** The focused row's place in the list, and whether it shows inside the list's box. */
const focusedRow = (list: Locator) =>
  list.evaluate((ul) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !ul.contains(el)) return null;
    const box = ul.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { pos: Number(el.getAttribute('aria-posinset')), shows: r.top >= box.top - 1 && r.bottom <= box.bottom + 1 };
  });

/** Today's order from main's state: tab IDs, top to bottom. */
const todayOrder = (shell: Page) =>
  shell.evaluate(async () => {
    type Node = { id: string; kind: string; chordId: string; section: string; parentId: string | null; rank: string };
    const chord = (window as unknown as { chord: { state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string }>; nodes: Record<string, Node> } }> } } }).chord;
    const { windowId, state } = await chord.state.snapshot();
    const chordId = state.windows[windowId]!.activeChordId;
    return Object.values(state.nodes)
      .filter((n) => n.chordId === chordId && n.section === 'today' && n.parentId === null && n.kind !== 'folder')
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1))
      .map((n) => n.id);
  });

test('a windowed Today: 200 tabs, only rows near the view mounted, each in its place, every one reachable by scrolling', async () => {
  // Light, for the contrast audit's worst case under the tint.
  const { app, shell } = await longToday({ CHORD_APPEARANCE: 'light' });
  try {
    const list = today(shell);
    const check = async (scrolledTo: string) => {
      const rows = await drawn(list);
      expect(rows.length, `rows mounted, ${scrolledTo}`).toBeLessThan(60);
      expect(rows.length).toBeGreaterThan(5);
      for (const r of rows) {
        expect(r.size, 'every row knows the whole list').toBe(TABS + 1);
        expect(r.slot + 1, `a row drawn where it belongs, ${scrolledTo}`).toBe(r.pos);
      }
      return rows;
    };
    // The full height scrolls, so the scrollbar tells the truth.
    expect(await list.evaluate((ul) => ul.scrollHeight)).toBe((TABS + 1) * ROW);
    expect((await check('at the top')).some((r) => r.pos === 1)).toBe(true);

    await list.evaluate((ul, row) => ul.scrollTo({ top: 100 * row }), ROW);
    await expect.poll(async () => (await drawn(list)).some((r) => r.pos === 101)).toBe(true);
    await check('in the middle');
    // Unmounted rows above and below: what's left is still a tree a screen reader can read (DESIGN.md §10).
    expect(await audit(shell, 'windowed Today', { appearance: 'light', include: '[role="tree"][aria-label="Today"]' })).toEqual([]);

    // A wheel, the way a hand scrolls, to the end.
    const box = (await list.boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) await shell.mouse.wheel(0, 400);
    await expect.poll(async () => (await drawn(list)).some((r) => r.pos === TABS + 1)).toBe(true);
    await expect(list.locator(`[aria-posinset="${TABS + 1}"]`)).toBeInViewport();
    await check('at the end');
    // The tab on screen stays mounted wherever the list is scrolled (its pill glides from there; it's the Tab stop).
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('the keyboard walks a windowed Today: End reaches the 201st row, arrows cross the window, and a focused or picked-up row stays mounted', async () => {
  const { app, shell } = await longToday();
  try {
    const list = today(shell);
    await list.locator('[aria-selected="true"]').focus();
    expect(await focusedRow(list)).toEqual({ pos: 1, shows: true });

    await shell.keyboard.press('End');
    await expect.poll(() => focusedRow(list)).toEqual({ pos: TABS + 1, shows: true });
    for (let i = 0; i < 30; i++) await shell.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(list)).toEqual({ pos: TABS + 1 - 30, shows: true });

    // Scrolled away with the wheel, the focused row keeps the focus (it stays mounted).
    await list.evaluate((ul) => ul.scrollTo({ top: 0 }));
    await expect.poll(async () => (await drawn(list)).some((r) => r.pos === 1)).toBe(true);
    expect((await focusedRow(list))?.pos).toBe(TABS + 1 - 30);
    // ↓ from there scrolls it back into view.
    await shell.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(list)).toEqual({ pos: TABS + 2 - 30, shows: true });

    // Picked up with Space, moved, and dropped: the row stays put under the keyboard, wherever the list scrolls.
    const picked = await shell.evaluate(() => document.activeElement?.getAttribute('data-id'));
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText('Picked up');
    await shell.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(list)).toEqual({ pos: TABS + 1 - 30, shows: true });
    await list.evaluate((ul) => ul.scrollTo({ top: ul.scrollHeight }));
    await expect(list.locator(`[data-row][data-id="${picked}"]`).first()).toBeAttached();
    await shell.keyboard.press('Space');
    await expect(shell.getByTestId('announcer')).toContainText(`${TABS + 1 - 30} of ${TABS + 1}`);
    expect((await todayOrder(shell)).indexOf(picked!)).toBe(TABS - 30);

    await shell.keyboard.press('Home');
    await expect.poll(() => focusedRow(list)).toEqual({ pos: 1, shows: true });
    expect(await list.evaluate((ul) => ul.scrollTop)).toBe(0);
  } finally {
    await app.close();
  }
});

test('a drag past the edge of a windowed Today scrolls it, and the row lands among rows that weren’t mounted when the drag began', async () => {
  const { app, shell } = await longToday();
  try {
    const list = today(shell);
    const mountedAtStart = new Set((await drawn(list)).map((r) => r.pos));
    const source = list.locator('[data-row][aria-posinset="2"]');
    const id = (await source.getAttribute('data-id'))!;
    const from = (await source.boundingBox())!;
    const box = (await list.boundingBox())!;
    const x = from.x + from.width / 2;
    await shell.mouse.move(x, from.y + from.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(x, from.y + from.height / 2 + 6, { steps: 4 });
    // Hold it at the list's bottom edge: dnd-kit scrolls the list, and the rows coming into view mount.
    await shell.mouse.move(x, box.y + box.height - 4, { steps: 12 });
    await expect.poll(() => list.evaluate((ul) => ul.scrollTop), { timeout: 15_000 }).toBeGreaterThan(80 * ROW);
    // Back into the list, where it stops scrolling, over rows that weren't there when it was picked up.
    await shell.mouse.move(x, box.y + box.height / 2, { steps: 8 });
    await shell.waitForTimeout(300);
    await shell.mouse.move(x, box.y + box.height / 2 + 2, { steps: 2 });
    await shell.waitForTimeout(300);
    // Where it has made room for itself: its row (in the top layer, beside its placeholder) says its place.
    const landing = Number(await list.locator(`[data-row][data-id="${id}"]`).first().getAttribute('aria-posinset'));
    expect(landing).toBeGreaterThan(80);
    expect(mountedAtStart.has(landing), 'it lands where no row was mounted when the drag began').toBe(false);
    await shell.mouse.up();
    // Main has it there, and the list doesn't jump back on the way.
    await expect.poll(async () => (await todayOrder(shell)).indexOf(id)).toBe(landing - 1);
    // Once it has settled (dnd-kit's stand-in for it is gone), it's drawn there.
    await expect(list.locator('[data-dnd-placeholder]')).toHaveCount(0);
    await expect(list.locator(`[data-row][data-id="${id}"]`)).toHaveAttribute('aria-posinset', String(landing));
  } finally {
    await app.close();
  }
});

test('at other interface sizes, a windowed Today keeps every row in its place, and Tab finds the tab on screen far down the list', async () => {
  const { app, shell } = await longToday();
  try {
    const list = today(shell);
    /** Mounted rows sit in their slots, and the list scrolls its full height (rows are 32 CSS px at any zoom). */
    const inPlace = async (where: string) => {
      expect(await list.evaluate((ul) => ul.scrollHeight)).toBe((TABS + 1) * ROW);
      for (const r of await drawn(list)) expect(r.slot + 1, `a row drawn where it belongs, ${where}`).toBe(r.pos);
    };
    const scrollTo = async (row: number) => {
      await list.evaluate((ul, top) => ul.scrollTo({ top }), row * ROW);
      await expect.poll(async () => (await drawn(list)).some((r) => r.pos === row + 1)).toBe(true);
    };

    // The tab on screen is far down the list: picked there, then the list goes back to the top.
    await scrollTo(150);
    const far = list.locator('[data-row="tab"][aria-posinset="160"]');
    await far.click();
    await expect(far).toHaveAttribute('aria-selected', 'true');

    const screen = await shell.evaluate(() => devicePixelRatio);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
    const sizes = settings.getByRole('radiogroup', { name: 'Interface size' });
    for (const scale of [1.5, 0.9]) {
      const size = `${Math.round(scale * 100)}%`;
      await sizes.getByRole('radio', { name: size }).click();
      await expect.poll(() => shell.evaluate(() => devicePixelRatio)).toBeCloseTo(screen * scale, 2);
      for (const row of [0, 100, TABS]) {
        await scrollTo(row);
        await inPlace(`${size}, scrolled to row ${row + 1}`);
      }
      // From the top, Tab into the list lands on the tab on screen, scrolled into view with its neighbors.
      await scrollTo(0);
      await shell.getByRole('button', { name: /^New tab/ }).focus();
      await shell.keyboard.press('Tab');
      await expect.poll(() => focusedRow(list)).toEqual({ pos: 160, shows: true });
      await expect.poll(async () => (await drawn(list)).filter((r) => r.pos === 159 || r.pos === 161).length).toBe(2);
      await inPlace(`${size}, at the tab on screen`);
    }
  } finally {
    await app.close();
  }
});

/**
 * Counts what the arc draws from now on: rows drawn again as they leave
 * (`[data-exit]`), favicons in flight (`[data-flight]`), the most at once,
 * and where the flights start.
 */
const watchArc = (shell: Page) =>
  shell.evaluate(() => {
    const arc = { exits: [] as string[], flights: 0, starts: [] as number[], now: 0, peak: 0, flashes: 0 };
    (window as unknown as { arc: typeof arc }).arc = arc;
    const each = (nodes: NodeList, fn: (el: HTMLElement) => void) => {
      for (const n of nodes) if (n instanceof HTMLElement) for (const el of [n, ...n.querySelectorAll<HTMLElement>('*')]) fn(el);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        each(r.addedNodes, (el) => {
          if (el.matches('[data-exit]')) arc.exits.push(el.dataset['exit']!);
          if (el.matches('[data-flight]')) {
            arc.flights++;
            arc.starts.push(el.getBoundingClientRect().top);
          }
          if (el.matches('[data-exit], [data-flight]')) arc.peak = Math.max(arc.peak, ++arc.now);
          if (el.closest('[data-archive-button]') && el.parentElement?.matches('[data-archive-button]') && !el.matches('svg')) arc.flashes++;
        });
        each(r.removedNodes, (el) => {
          if (el.matches('[data-exit], [data-flight]')) arc.now--;
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
const arcSeen = (shell: Page) =>
  shell.evaluate(() => (window as unknown as { arc: { exits: string[]; flights: number; starts: number[]; peak: number; flashes: number } }).arc);

for (const appearance of ['light', 'dark'] as const) {
  test(`Clear Today: rows on screen shrink away and up to six favicons arc into the Archive button, which gulps (${appearance})`, async () => {
    const { app, shell } = await longToday({ CHORD_APPEARANCE: appearance });
    try {
      await setMotion(app, shell, true);
      const list = today(shell);
      // From the middle of the list: rows that were never mounted at the start are the ones that fly.
      await list.evaluate((ul, row) => ul.scrollTo({ top: 120 * row }), ROW);
      await expect.poll(async () => (await drawn(list)).some((r) => r.pos === 121)).toBe(true);
      const box = (await list.boundingBox())!;
      const archive = shell.locator('[data-archive-button]');
      await watchArc(shell);
      const clear = shell.getByRole('button', { name: 'Clear', exact: true });
      await shell.getByRole('separator').first().hover();
      await clear.click();
      // Mid-flight, for the record: the favicons on their way to the box (Chord's own view only).
      await expect.poll(() => shell.locator('[data-flight]').count(), { intervals: [5] }).toBeGreaterThan(0);
      await shell.screenshot({ path: resolve(capturesDir, `archive-arc-${appearance}.png`) });
      await expect(list.locator('[data-row]')).toHaveCount(0);
      // All of it ends, and nothing is left drawn.
      await expect(shell.locator('[data-flight], [data-exit]')).toHaveCount(0);
      const arc = await arcSeen(shell);
      expect(arc.flights).toBe(6);
      expect(arc.exits.length, 'only rows on screen are drawn leaving').toBeLessThanOrEqual(Math.ceil(box.height / ROW) + 1);
      expect(arc.exits.every((kind) => kind === 'archive'), 'they leave as archived, not closed').toBe(true);
      expect(arc.peak, 'under 50 nodes animate at once').toBeLessThan(50);
      for (const top of arc.starts) expect(top, 'favicons start from rows that were on screen').toBeGreaterThanOrEqual(box.y - 1);
      for (const top of arc.starts) expect(top).toBeLessThanOrEqual(box.y + box.height);
      // The button is back at rest, with no will-change left behind.
      await expect.poll(() => archive.evaluate((el) => [el.style.willChange, getComputedStyle(el).transform].join(' '))).toMatch(/^ (none|matrix\(1, 0, 0, 1, 0, 0\))$/);

      // A closed tab leaves its own way: it drifts, nothing flies.
      await shell.getByRole('button', { name: 'Undo' }).click();
      await expect(list.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', String(TABS + 1));
      await list.evaluate((ul) => ul.scrollTo({ top: 0 }));
      await shell.waitForTimeout(700);
      await watchArc(shell);
      const row = list.locator('[data-row][aria-posinset="3"]');
      await row.hover();
      // The row's × is for the pointer (the keyboard has Delete), so it's hidden from the accessibility tree.
      await row.locator('[aria-label^="Close "]').click();
      await expect.poll(async () => (await arcSeen(shell)).exits).toEqual(['close']);
      expect((await arcSeen(shell)).flights).toBe(0);
    } finally {
      await app.close();
    }
  });
}

test('Clear Today with reduced motion: rows go at once, nothing flies, and the Archive button’s highlight fades', async () => {
  const { app, shell } = await longToday();
  try {
    await setMotion(app, shell, false);
    await watchArc(shell);
    await shell.getByRole('separator').first().hover();
    await shell.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(today(shell).locator('[data-row]')).toHaveCount(0);
    await expect.poll(async () => (await arcSeen(shell)).flashes).toBe(1);
    const arc = await arcSeen(shell);
    expect(arc.flights).toBe(0);
    expect(arc.exits).toEqual([]);
    // The highlight is gone in a moment.
    await expect(shell.locator('[data-archive-button] > span')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Clear Today with "Animate tab moves" off: nothing animates at all', async () => {
  const { app, shell } = await longToday();
  try {
    await setMotion(app, shell, true);
    // Settings → Motion → Animate tab moves, as a person switches it off.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Motion' }).click();
    const tabMoves = settings.getByRole('switch', { name: 'Animate tab moves' });
    await tabMoves.click();
    await expect(tabMoves).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['motionOff'])).toContain('tabMoves');
    await watchArc(shell);
    await shell.getByRole('separator').first().hover();
    await shell.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(today(shell).locator('[data-row]')).toHaveCount(0);
    await shell.waitForTimeout(300);
    expect(await arcSeen(shell)).toMatchObject({ exits: [], flights: 0, flashes: 0 });
  } finally {
    await app.close();
  }
});
