/**
 * The Today list's window (DESIGN.md §6.7): above 150 rows only the rows near
 * the viewport are mounted, and spacers stand in for the rest. Every row is
 * one height, so a row's place is its index times that height.
 *
 * Some rows stay mounted wherever they are (`keep`): the tab on screen (its
 * pill glides from there), a row being dragged or moved with the keyboard,
 * and the row with the keyboard focus.
 */

/** The list is windowed above this many rows. */
export const WINDOW_ABOVE = 150;
/**
 * Rows mounted past each edge of the viewport: enough that a wheel's notch
 * never shows a gap, few enough that a drag (which measures every row it
 * could land on as it starts) and a Clear (which unmounts them) stay cheap.
 */
export const OVERSCAN = 3;

/** Rows `first` to `last`, inclusive; empty when `last < first`. */
export interface Span {
  first: number;
  last: number;
}

export const EMPTY: Span = { first: 0, last: -1 };

export const inSpan = (span: Span, index: number) => index >= span.first && index <= span.last;

/** The rows a viewport `height` px tall shows when scrolled to `top`. */
export function visibleSpan(top: number, height: number, rowHeight: number, count: number): Span {
  if (count <= 0 || height <= 0) return EMPTY;
  const first = Math.max(0, Math.min(count - 1, Math.floor(top / rowHeight)));
  const last = Math.max(first, Math.min(count - 1, Math.ceil((top + height) / rowHeight) - 1));
  return { first, last };
}

/** `span` and `by` more rows on each side, within the list. */
export function grow(span: Span, by: number, count: number): Span {
  if (span.last < span.first) return span;
  return { first: Math.max(0, span.first - by), last: Math.min(count - 1, span.last + by) };
}

/** Consecutive mounted rows, or a gap standing in for rows that aren't. */
export type Piece = { kind: 'rows'; first: number; last: number } | { kind: 'gap'; first: number; last: number };

/**
 * What to draw: every row when `window` is null, else the rows in `window`
 * and the ones in `keep`, in order, with a gap wherever rows are left out.
 */
export function pieces(count: number, window: Span | null, keep: Iterable<number>): Piece[] {
  if (count <= 0) return [];
  if (!window) return [{ kind: 'rows', first: 0, last: count - 1 }];
  const spans: Span[] = window.last >= window.first ? [{ first: Math.max(0, window.first), last: Math.min(count - 1, window.last) }] : [];
  for (const index of keep) if (index >= 0 && index < count) spans.push({ first: index, last: index });
  spans.sort((a, b) => a.first - b.first);
  // Merge what touches or overlaps.
  const runs: Span[] = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (last && span.first <= last.last + 1) last.last = Math.max(last.last, span.last);
    else runs.push({ ...span });
  }
  const out: Piece[] = [];
  let next = 0;
  for (const run of runs) {
    if (run.first > next) out.push({ kind: 'gap', first: next, last: run.first - 1 });
    out.push({ kind: 'rows', ...run });
    next = run.last + 1;
  }
  if (next < count) out.push({ kind: 'gap', first: next, last: count - 1 });
  return out;
}

/**
 * `ids` with `source` moved to where `target` is: how rows make room while one
 * is dragged over another (dnd-kit's own `move`, on IDs). The same array when
 * nothing moves.
 */
export function moveId(ids: readonly string[], source: string, target: string): readonly string[] {
  const from = ids.indexOf(source);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** `items` in the order of `ids`, if `ids` holds exactly their IDs; else `items` as they are. */
export function inOrder<T extends { id: string }>(items: readonly T[], ids: readonly string[] | null): readonly T[] {
  if (!ids || ids.length !== items.length) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) return items;
    out.push(item);
  }
  return out;
}

/* ---------- How rows move (today-motion.ts), worked out from indices ---------- */

/** A list's rows as the last commit had them: where each was (by index, mounted or not), and the ones shown. */
export interface Placed<E> {
  slots: ReadonlyMap<string, number>;
  shown: ReadonlyMap<string, E>;
}

export interface RowChanges<E> {
  /** The rows shown now, by ID. */
  shown: Map<string, E>;
  /** New to the list. */
  arrived: E[];
  /** Somewhere else now: they slide from `dy` px away. */
  moved: { el: E; dy: number }[];
  /** Left the list (not just scrolled out of the window), from where they showed. */
  gone: { id: string; el: E; slot: number }[];
}

export interface ChangeOptions<E> {
  rowHeight: number;
  /** Whether a place is near enough the viewport to animate there (DESIGN.md §6.7). */
  near(slot: number): boolean;
  /** Whether a place showed: only rows that did are seen leaving. */
  shows(slot: number): boolean;
  /** How far the whole list moved on screen since, px (Pinned grew above Today): rows that move with it slide too. */
  shift: number;
  /** Nothing moves: something else is moving the rows (dnd-kit, while a row is dragged). */
  still: boolean;
  /** A row something else is moving (dnd-kit, as it drops one): it isn't seen leaving. */
  busy?(el: E): boolean;
}

/**
 * What changed in a list of rows, all one height, since `before`: rows new to
 * it, rows whose place changed, and rows that left. `rows` are the rows shown
 * now, in any order; `slots`, every row's place now. Nothing is measured: a
 * row's place is its index.
 */
export function rowChanges<E>(rows: Iterable<readonly [string, E]>, before: Placed<E>, slots: ReadonlyMap<string, number>, options: ChangeOptions<E>): RowChanges<E> {
  const { rowHeight, near, shows, shift, still, busy } = options;
  const out: RowChanges<E> = { shown: new Map(), arrived: [], moved: [], gone: [] };
  for (const [id, el] of rows) {
    const slot = slots.get(id);
    if (slot === undefined) continue;
    out.shown.set(id, el);
    if (still) continue;
    const was = before.slots.get(id);
    if (was === undefined) {
      if (near(slot)) out.arrived.push(el);
      continue;
    }
    const dy = (was - slot) * rowHeight + shift;
    if (dy !== 0 && (near(slot) || near(was))) out.moved.push({ el, dy });
  }
  if (!still)
    for (const [id, el] of before.shown) {
      const slot = before.slots.get(id);
      if (!slots.has(id) && slot !== undefined && shows(slot) && !busy?.(el)) out.gone.push({ id, el, slot });
    }
  return out;
}

/** Places by the order rows are in: where something else (dnd-kit) left them. */
export function slotsInOrder(ids: Iterable<string>): Map<string, number> {
  const slots = new Map<string, number>();
  for (const id of ids) if (!slots.has(id)) slots.set(id, slots.size);
  return slots;
}
