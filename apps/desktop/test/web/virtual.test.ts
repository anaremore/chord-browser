import { describe, expect, it } from 'vitest';
import { EMPTY, grow, inOrder, inSpan, moveId, pieces, rowChanges, slotsInOrder, visibleSpan, WINDOW_ABOVE, type ChangeOptions, type Placed } from '../../src/renderer/shell/virtual';

describe('visibleSpan', () => {
  it('is the rows a viewport shows, partly shown ones included', () => {
    expect(visibleSpan(0, 320, 32, 200)).toEqual({ first: 0, last: 9 });
    expect(visibleSpan(16, 320, 32, 200)).toEqual({ first: 0, last: 10 });
    expect(visibleSpan(3200, 320, 32, 200)).toEqual({ first: 100, last: 109 });
  });

  it('stays within the list', () => {
    expect(visibleSpan(0, 2000, 32, 5)).toEqual({ first: 0, last: 4 });
    expect(visibleSpan(10_000, 320, 32, 5)).toEqual({ first: 4, last: 4 });
  });

  it('is empty for an empty list or a list that shows nothing', () => {
    expect(visibleSpan(0, 320, 32, 0)).toEqual(EMPTY);
    expect(visibleSpan(0, 0, 32, 10)).toEqual(EMPTY);
  });
});

describe('grow', () => {
  it('adds rows on each side, within the list', () => {
    expect(grow({ first: 10, last: 20 }, 6, 200)).toEqual({ first: 4, last: 26 });
    expect(grow({ first: 2, last: 8 }, 6, 10)).toEqual({ first: 0, last: 9 });
  });

  it('leaves an empty span empty', () => {
    expect(grow(EMPTY, 6, 10)).toEqual(EMPTY);
  });
});

describe('pieces', () => {
  it('draws every row when the list is not windowed', () => {
    expect(pieces(3, null, [])).toEqual([{ kind: 'rows', first: 0, last: 2 }]);
    expect(pieces(0, null, [])).toEqual([]);
  });

  it('draws the window, with gaps standing in for the rest', () => {
    expect(pieces(200, { first: 40, last: 60 }, [])).toEqual([
      { kind: 'gap', first: 0, last: 39 },
      { kind: 'rows', first: 40, last: 60 },
      { kind: 'gap', first: 61, last: 199 },
    ]);
  });

  it('keeps rows mounted wherever they are, and merges the ones that touch', () => {
    expect(pieces(200, { first: 40, last: 60 }, [0, 61, 150, 150])).toEqual([
      { kind: 'rows', first: 0, last: 0 },
      { kind: 'gap', first: 1, last: 39 },
      { kind: 'rows', first: 40, last: 61 },
      { kind: 'gap', first: 62, last: 149 },
      { kind: 'rows', first: 150, last: 150 },
      { kind: 'gap', first: 151, last: 199 },
    ]);
  });

  it('ignores kept rows outside the list', () => {
    expect(pieces(10, { first: 0, last: 9 }, [-1, 10, 99])).toEqual([{ kind: 'rows', first: 0, last: 9 }]);
  });

  it('accounts for every row exactly once', () => {
    const count = 3 * WINDOW_ABOVE;
    const drawn = pieces(count, { first: 100, last: 130 }, [3, 4, 300, 449]);
    let next = 0;
    for (const p of drawn) {
      expect(p.first).toBe(next);
      expect(p.last).toBeGreaterThanOrEqual(p.first);
      next = p.last + 1;
    }
    expect(next).toBe(count);
  });
});

describe('inSpan', () => {
  it('includes both ends', () => {
    expect(inSpan({ first: 2, last: 4 }, 2)).toBe(true);
    expect(inSpan({ first: 2, last: 4 }, 4)).toBe(true);
    expect(inSpan({ first: 2, last: 4 }, 5)).toBe(false);
    expect(inSpan(EMPTY, 0)).toBe(false);
  });
});

describe('moveId', () => {
  it('moves the dragged row to where the row under it is, down or up', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveId(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns the same array when nothing moves', () => {
    const ids = ['a', 'b'];
    expect(moveId(ids, 'a', 'a')).toBe(ids);
    expect(moveId(ids, 'a', 'z')).toBe(ids);
  });
});

describe('inOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('puts items in the order of the IDs', () => {
    expect(inOrder(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps them as they are when the IDs are a different set (a tab came or went mid-drag)', () => {
    expect(inOrder(items, ['c', 'a'])).toBe(items);
    expect(inOrder(items, ['c', 'a', 'z'])).toBe(items);
    expect(inOrder(items, null)).toBe(items);
  });
});

describe('rowChanges', () => {
  /** A list's rows: IDs in order, each "element" its own ID. */
  const placed = (ids: string[], shown = ids): Placed<string> => ({ slots: slotsInOrder(ids), shown: new Map(shown.map((id) => [id, id])) });
  const rows = (ids: string[]) => ids.map((id) => [id, id] as const);
  const options = (more: Partial<ChangeOptions<string>> = {}): ChangeOptions<string> => ({ rowHeight: 32, near: () => true, shows: () => true, shift: 0, still: false, ...more });

  it('slides the rows below a closed one up into its place, and sees it leave from where it was', () => {
    const before = placed(['a', 'b', 'c', 'd']);
    const now = ['a', 'c', 'd'];
    const changes = rowChanges(rows(now), before, slotsInOrder(now), options());
    expect(changes.arrived).toEqual([]);
    expect(changes.moved).toEqual([
      { el: 'c', dy: 32 },
      { el: 'd', dy: 32 },
    ]);
    expect(changes.gone).toEqual([{ id: 'b', el: 'b', slot: 1 }]);
    expect([...changes.shown.keys()]).toEqual(['a', 'c', 'd']);
  });

  it('springs in a row new to the list, and makes room for it', () => {
    const now = ['n', 'a', 'b'];
    const changes = rowChanges(rows(now), placed(['a', 'b']), slotsInOrder(now), options());
    expect(changes.arrived).toEqual(['n']);
    expect(changes.moved).toEqual([
      { el: 'a', dy: -32 },
      { el: 'b', dy: -32 },
    ]);
  });

  it('moves rows that move with the list as a whole too (Pinned grew above Today)', () => {
    // One row went to Pinned, which grew a row: the rows below it stay put on screen, the ones above slide down.
    const now = ['a', 'b', 'd'];
    const changes = rowChanges(rows(now), placed(['a', 'b', 'c', 'd']), slotsInOrder(now), options({ shift: -32 }));
    expect(changes.moved).toEqual([
      { el: 'a', dy: -32 },
      { el: 'b', dy: -32 },
    ]);
  });

  it('animates only near the viewport, and sees rows leave only where they showed', () => {
    const before = placed(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e']);
    const now = ['c', 'd', 'e'];
    const changes = rowChanges(rows(now), before, slotsInOrder(now), options({ near: (slot) => slot <= 1, shows: (slot) => slot >= 1 }));
    // c and d move from or to near places; e moves from 4 to 2, neither of them near.
    expect(changes.moved.map((m) => m.el)).toEqual(['c', 'd']);
    expect(changes.gone.map((g) => g.id)).toEqual(['b']);
  });

  it('only notes what shows while something else moves the rows, and leaves rows it is dropping alone', () => {
    const now = ['b', 'a'];
    const still = rowChanges(rows(now), placed(['a', 'b', 'c']), slotsInOrder(now), options({ still: true }));
    expect(still).toMatchObject({ arrived: [], moved: [], gone: [] });
    expect([...still.shown.keys()]).toEqual(['b', 'a']);
    const dropping = rowChanges(rows(['a']), placed(['a', 'b']), slotsInOrder(['a']), options({ busy: (el) => el === 'b' }));
    expect(dropping.gone).toEqual([]);
  });

  it('leaves out rows that are no longer in the list but still drawn (on their way out)', () => {
    const changes = rowChanges(rows(['a', 'x']), placed(['a']), slotsInOrder(['a']), options());
    expect([...changes.shown.keys()]).toEqual(['a']);
    expect(changes.arrived).toEqual([]);
  });
});

describe('slotsInOrder', () => {
  it('numbers the rows as they come, once each', () => {
    expect([...slotsInOrder(['b', 'a', 'b', 'c'])]).toEqual([
      ['b', 0],
      ['a', 1],
      ['c', 2],
    ]);
  });
});
