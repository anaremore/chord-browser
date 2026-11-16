import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { apply, archiveCandidates, emptyState, paneRects, resizeSizes, restoreState, settleSplits, shownTabs, splitMembers, splitOf, tabsInOrder, visibleTabs, windowsShowing, type Command, type Context, type SidebarNode, type SplitNode, type State, type TabNode, nodeOf, setNode, nodeList } from '../src';

/** One chord, one window, three Today tabs (t1 on top); ids from the reducer come out as id-001, id-002, … */
function setup() {
  let n = 0;
  let now = 1_000;
  const ctx: Context = {
    get now() {
      return now++;
    },
    newId: () => `id-${String(++n).padStart(3, '0')}`,
  };
  let state: State = emptyState();
  const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  const tab = (id: string, rank: string, section: 'pinned' | 'today' = 'today'): TabNode => ({
    kind: 'tab',
    id,
    chordId: 'c1',
    section,
    parentId: null,
    rank,
    url: `https://${id}.test/`,
    title: id,
    pinnedUrl: section === 'pinned' ? `https://${id}.test/` : null,
    customTitle: null,
    favicon: null,
    lastActiveAt: 0,
    createdAt: 0,
  });
  setNode(state, tab('t1', 'a0'));
  setNode(state, tab('t2', 'a1'));
  setNode(state, tab('t3', 'a2'));
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: 't1' }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const run = (cmd: Command) => {
    const result = apply(state, cmd, ctx);
    state = result.state;
    return result;
  };
  return {
    get state() {
      return state;
    },
    set state(next: State) {
      state = next;
    },
    run,
  };
}

const split = (state: State, id: string) => nodeOf(state, id) as SplitNode;
const panes = (state: State, splitId: string) => splitMembers(state, splitId).map((t) => t.id);

describe('pane layout', () => {
  it('shares the frame after the gaps, in whole pixels, ending at the edge', () => {
    const rects = paneRects({ x: 248, y: 40, width: 1001, height: 700 }, 'row', [0.5, 0.5], 8);
    expect(rects).toEqual([
      { x: 248, y: 40, width: 497, height: 700 },
      { x: 753, y: 40, width: 496, height: 700 },
    ]);
    const stacked = paneRects({ x: 0, y: 0, width: 800, height: 600 }, 'column', [1, 1, 2], 8);
    expect(stacked.map((r) => r.height)).toEqual([146, 146, 292]);
    expect(stacked.at(-1)!.y + stacked.at(-1)!.height).toBe(600);
    expect(paneRects({ x: 1, y: 2, width: 3, height: 4 }, 'row', [1])).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });

  it('resizes the two panes beside a divider, never below the minimum', () => {
    const sizes = resizeSizes([0.5, 0.5], 0, 100, 1008, 8, 320);
    expect(sizes[0]).toBeCloseTo(0.6, 5);
    expect(resizeSizes([0.5, 0.5], 0, -1000, 1008, 8, 320)[0]).toBeCloseTo(320 / 1000, 5);
    // The pane not beside the divider keeps its share.
    const three = resizeSizes([0.25, 0.25, 0.5], 1, 50, 1016, 8, 100);
    expect(three[0]).toBeCloseTo(0.25, 5);
    expect(three[1]).toBeCloseTo(0.3, 5);
  });
});

describe('split commands', () => {
  it('makes a split where the shown tab is, focused on the pane added', () => {
    const t = setup();
    const result = t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3' });
    const s = splitOf(t.state, 't1')!;
    expect(s).toMatchObject({ kind: 'split', section: 'today', rank: 'a0', direction: 'row', sizes: [0.5, 0.5] });
    expect(panes(t.state, s.id)).toEqual(['t1', 't3']);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t3');
    expect(shownTabs(t.state, 'w1')).toEqual(['t1', 't3']);
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 't3' });
    // The sidebar shows the split where t1 was, then t2.
    expect(tabsInOrder(t.state, 'c1').map((x) => x.id)).toEqual(['t1', 't3', 't2']);
  });

  it('adds a third pane at the place asked, and opens a new tab as a pane', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3', index: 0 });
    expect(panes(t.state, s)).toEqual(['t3', 't1', 't2']);
    expect(split(t.state, s).sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', url: 'https://new.test/' });
    expect(panes(t.state, s)).toHaveLength(4);
    // A fifth doesn't fit.
    const before = t.state;
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', url: 'https://fifth.test/' });
    expect(t.state).toBe(before);
  });

  it('moves a pane within its split, its share going with it', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'split.resize', splitId: s, sizes: [0.3, 0.7] });
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2', index: 0 });
    expect(panes(t.state, s)).toEqual(['t2', 't1']);
    expect(split(t.state, s).sizes[0]).toBeCloseTo(0.7, 6);
  });

  it('resizes, ignoring sizes that don’t match the panes, and lays the window out again', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = splitOf(t.state, 't1')!.id;
    const result = t.run({ t: 'split.resize', splitId: s, sizes: [2, 6] });
    expect(split(t.state, s).sizes).toEqual([0.25, 0.75]);
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 't2' });
    const before = t.state;
    t.run({ t: 'split.resize', splitId: s, sizes: [1, 1, 1] });
    expect(t.state).toBe(before);
  });

  it('takes a pane out to just after the split, and a split of one dissolves', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'split.resize', splitId: s, sizes: [0.5, 0.25, 0.25] });
    t.run({ t: 'split.remove', nodeId: 't2' });
    expect(panes(t.state, s)).toEqual(['t1', 't3']);
    expect(split(t.state, s).sizes).toEqual([0.6666666666666666, 0.3333333333333333]);
    expect(tabsInOrder(t.state, 'c1').map((x) => x.id)).toEqual(['t1', 't3', 't2']);
    t.run({ t: 'split.remove', nodeId: 't3' });
    expect(nodeOf(t.state, s)).toBeUndefined();
    expect(nodeOf(t.state, 't1')).toMatchObject({ parentId: null, rank: 'a0' });
    expect(nodeList(t.state).some((n) => n.kind === 'split')).toBe(false);
  });

  it('separates every pane into its own tab where the split was, and joins them again', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't2', nodeId: 't3' });
    const s = splitOf(t.state, 't2')!;
    t.run({ t: 'split.separate', splitId: s.id });
    expect(nodeOf(t.state, s.id)).toBeUndefined();
    expect(tabsInOrder(t.state, 'c1').map((x) => x.id)).toEqual(['t1', 't2', 't3']);
    // Undo: the same split, as it was.
    t.run({ t: 'split.join', windowId: 'w1', splitId: s.id, nodeIds: ['t2', 't3'], direction: 'column', sizes: [1, 3], focus: 't3' });
    expect(split(t.state, s.id)).toMatchObject({ direction: 'column', sizes: [0.25, 0.75] });
    expect(panes(t.state, s.id)).toEqual(['t2', 't3']);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t3');
  });

  it('moves focus between panes, stopping at the ends', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.run({ t: 'split.focus', windowId: 'w1', direction: -1 });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t1');
    const before = t.state;
    t.run({ t: 'split.focus', windowId: 'w1', direction: -1 });
    expect(t.state).toBe(before);
  });
});

describe('splits and the rest of the sidebar', () => {
  it('closing a pane lands on a pane beside it; closing the last but one dissolves the split', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 't2' });
    const result = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 't2' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t3');
    expect(panes(t.state, s)).toEqual(['t1', 't3']);
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 't3' });
    // ⌘⇧T puts it back in the split.
    t.run({ t: 'tab.reopenClosed', windowId: 'w1' });
    expect(panes(t.state, s)).toEqual(['t1', 't2', 't3']);
    expect(split(t.state, s).sizes).toHaveLength(3);
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 't2' });
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 't3' });
    expect(nodeOf(t.state, s)).toBeUndefined();
    expect(shownTabs(t.state, 'w1')).toEqual(['t1']);
  });

  it('a pinned pane leaves its split when closed, and stays pinned', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3' });
    t.run({ t: 'tab.pin', nodeId: 't1' });
    const s = splitOf(t.state, 't1')!.id;
    expect(split(t.state, s).section).toBe('pinned');
    expect(['t1', 't2', 't3'].map((id) => (nodeOf(t.state, id) as TabNode).pinnedUrl)).toEqual(['https://t1.test/', 'https://t2.test/', 'https://t3.test/']);
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 't3' });
    expect(nodeOf(t.state, 't3')).toMatchObject({ section: 'pinned', parentId: null });
    expect(panes(t.state, s)).toEqual(['t1', 't2']);
    // Unpinning a pane unpins the split.
    t.run({ t: 'tab.unpin', nodeId: 't2' });
    expect(split(t.state, s).section).toBe('today');
    expect((nodeOf(t.state, 't1') as TabNode).pinnedUrl).toBeNull();
  });

  it('a split moves as one, in and out of folders', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'folder.create', folderId: 'f1', chordId: 'c1', title: 'Work' });
    t.run({ t: 'node.move', nodeId: s, section: 'pinned', index: 0, parentId: 'f1' });
    expect(split(t.state, s)).toMatchObject({ section: 'pinned', parentId: 'f1' });
    expect((nodeOf(t.state, 't2') as TabNode).section).toBe('pinned');
    // Dragging a pane out to the sidebar takes it out of the split.
    t.run({ t: 'node.move', nodeId: 't2', section: 'today', index: 0 });
    expect(nodeOf(t.state, s)).toBeUndefined();
    expect(nodeOf(t.state, 't1')).toMatchObject({ parentId: 'f1', section: 'pinned' });
  });

  it('a window showing any pane of a split lets the whole split go to another window', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.state = { ...t.state, windows: { ...t.state.windows, w2: { id: 'w2', activeChordId: 'c1', activeTab: { c1: 't3' }, sidebar: 'docked', sidebarWidth: 248, bounds: null } } };
    t.run({ t: 'tab.activate', windowId: 'w2', nodeId: 't1' });
    expect(shownTabs(t.state, 'w2')).toEqual(['t1', 't2']);
    expect(shownTabs(t.state, 'w1')).toEqual(['t3']);
    expect(windowsShowing(t.state, 't2')).toEqual(['w2']);
  });

  it('every pane on screen counts as visible, and panes are never tidied away', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    expect([...visibleTabs(t.state)].sort()).toEqual(['t1', 't2']);
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 't3' });
    expect(archiveCandidates(t.state, 10 ** 12, 1)).toEqual([]);
    expect(t.run({ t: 'tab.sleep', nodeId: 't1' }).effects).toEqual([]);
  });

  it('settles splits that lost panes, gained too many, or hold the wrong kind of node', () => {
    const t = setup();
    const state = t.state;
    setNode(state, { kind: 'split', id: 's', chordId: 'c1', section: 'today', parentId: null, rank: 'Zz', direction: 'row', sizes: [1], createdAt: 0 });
    for (const [i, id] of ['t1', 't2', 't3'].entries()) Object.assign(nodeOf(state, id)!, { parentId: 's', rank: `a${i}` });
    const changed = settleSplits(state);
    expect(splitMembers(state, 's').map((p) => p.id)).toEqual(['t1', 't2', 't3']);
    expect((nodeOf(state, 's') as SplitNode).sizes).toHaveLength(3);
    expect(changed.size).toBe(3);
  });

  // A split inside a split (old or damaged data): which one settles first follows their IDs' order (split.ts), and
  // either way nothing is lost and every split ends whole. In a draft too, as the reducer runs it. The inner split is
  // s1 (before the outer s2) or s3 (after it); the order the nodes went in doesn't matter.
  const nested = (order: string[], inner: number, innerId: 's1' | 's3' = 's1') => {
    const state = emptyState();
    const tab = (id: string, parentId: string | null, rank: string): TabNode => ({ kind: 'tab', id, chordId: 'c1', section: 'today', parentId, rank, url: `https://${id}.test/`, title: id, pinnedUrl: null, customTitle: null, favicon: null, lastActiveAt: 0, createdAt: 0 });
    const made: Record<string, SidebarNode> = {
      s1: { kind: 'split', id: innerId, chordId: 'c1', section: 'today', parentId: 's2', rank: 'a0', direction: 'row', sizes: [], createdAt: 0 },
      s2: { kind: 'split', id: 's2', chordId: 'c1', section: 'today', parentId: null, rank: 'a0', direction: 'row', sizes: [0.5, 0.5], createdAt: 0 },
      x2: tab('x2', 's2', 'a1'),
      x3: tab('x3', 's2', 'a2'),
    };
    for (let i = 1; i <= inner; i++) made[`t${i}`] = tab(`t${i}`, innerId, `a${i}`);
    for (const id of order) for (const key of Object.keys(made).filter((k) => k.startsWith(id))) setNode(state, made[key]!);
    return state;
  };
  const shape = (state: State) =>
    Object.fromEntries(
      nodeList(state)
        .filter((n): n is SplitNode => n.kind === 'split')
        .map((n) => [n.id, { parent: n.parentId, panes: splitMembers(state, n.id).map((p) => p.id), sizes: n.sizes.length }]),
    );
  it.each([
    { name: 'the inner one of one tab first: it dissolves into the outer', order: ['s1', 't', 's2', 'x'], inner: 1, innerId: 's1', splits: { s2: { parent: null, panes: ['t1', 'x2', 'x3'], sizes: 3 } } },
    { name: 'the inner one of one tab first, put in last', order: ['s2', 'x', 's1', 't'], inner: 1, innerId: 's1', splits: { s2: { parent: null, panes: ['t1', 'x2', 'x3'], sizes: 3 } } },
    { name: 'the outer first: the inner steps out, then dissolves', order: ['s2', 'x', 's1', 't'], inner: 1, innerId: 's3', splits: { s2: { parent: null, panes: ['x2', 'x3'], sizes: 2 } } },
    {
      name: 'the inner one of six first: its extras go to the outer, which it then steps out of',
      order: ['s1', 't', 's2', 'x'],
      inner: 6,
      innerId: 's1',
      splits: { s1: { parent: null, panes: ['t1', 't2', 't3', 't4'], sizes: 4 }, s2: { parent: null, panes: ['t5', 't6', 'x2', 'x3'], sizes: 4 } },
    },
    {
      name: 'the outer first, the inner of six',
      order: ['s2', 'x', 's1', 't'],
      inner: 6,
      innerId: 's3',
      splits: { s3: { parent: null, panes: ['t1', 't2', 't3', 't4'], sizes: 4 }, s2: { parent: null, panes: ['x2', 'x3'], sizes: 2 } },
    },
  ] as const)('settles nested splits: $name', ({ order, inner, innerId, splits }) => {
    const plain = nested([...order], inner, innerId);
    settleSplits(plain);
    const drafted = produce(nested([...order], inner, innerId), (d) => void settleSplits(d as State));
    for (const state of [plain, drafted]) {
      expect(shape(state)).toEqual(splits);
      const tabs = nodeList(state).filter((n) => n.kind === 'tab');
      expect(tabs).toHaveLength(inner + 2);
      // Every tab's parent is there.
      for (const t of tabs) if (t.parentId) expect(nodeOf(state, t.parentId)).toBeDefined();
    }
  });

  // A Today split holding a pinned tab (old or damaged data, or another computer's): the pinned tab steps out, into
  // Today, and the split settles on the rest, as if it had never been a pane.
  const strayPinned = (today: number, nest: boolean) => {
    const state = emptyState();
    const tab = (id: string, parentId: string, rank: string, section: 'pinned' | 'today'): TabNode => ({ kind: 'tab', id, chordId: 'c1', section, parentId, rank, url: `https://${id}.test/`, title: id, pinnedUrl: section === 'pinned' ? `https://${id}.test/` : null, customTitle: null, favicon: null, lastActiveAt: 0, createdAt: 0 });
    // Nested: s sits inside an outer Today split u with two tabs of its own, and settles first (its ID is first).
    setNode(state, { kind: 'split', id: 's', chordId: 'c1', section: 'today', parentId: nest ? 'u' : null, rank: 'a0', direction: 'row', sizes: [], createdAt: 0 });
    setNode(state, tab('p', 's', 'a0', 'pinned'));
    for (let i = 1; i <= today; i++) setNode(state, tab(`q${i}`, 's', `a${i}`, 'today'));
    if (nest) {
      setNode(state, { kind: 'split', id: 'u', chordId: 'c1', section: 'today', parentId: null, rank: 'a0', direction: 'row', sizes: [], createdAt: 0 });
      setNode(state, tab('x1', 'u', 'a1', 'today'));
      setNode(state, tab('x2', 'u', 'a2', 'today'));
    }
    return state;
  };
  it.each([
    { name: 'of 2: the split dissolves', today: 1, nest: false, splits: {}, p: null },
    { name: 'of 3: two panes', today: 2, nest: false, splits: { s: { parent: null, panes: ['q1', 'q2'], sizes: 2 } }, p: null },
    { name: 'of 5: four panes, none pushed out', today: 4, nest: false, splits: { s: { parent: null, panes: ['q1', 'q2', 'q3', 'q4'], sizes: 4 } }, p: null },
    { name: 'of 2, inside another split: both tabs become its panes', today: 1, nest: true, splits: { u: { parent: null, panes: ['q1', 'p', 'x1', 'x2'], sizes: 4 } }, p: 'u' },
  ])('settles a pinned tab in a Today split $name', ({ today, nest, splits, p }) => {
    const plain = strayPinned(today, nest);
    settleSplits(plain);
    const drafted = produce(strayPinned(today, nest), (d) => void settleSplits(d as State));
    for (const state of [plain, drafted]) {
      expect(shape(state)).toEqual(splits);
      expect(nodeOf(state, 'p')).toMatchObject({ section: 'today', parentId: p, pinnedUrl: null });
      expect(nodeList(state).filter((n) => n.kind === 'tab')).toHaveLength(today + 1 + (nest ? 2 : 0));
    }
  });

  it('restores splits whole, and one window keeps a split another one also shows', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = t.state;
    const restored = restoreState(
      {
        chords: Object.values(s.chords),
        nodes: nodeList(s),
        windows: [
          { ...s.windows['w1']!, activeTab: { c1: 't1' } },
          { ...s.windows['w1']!, id: 'w2', activeTab: { c1: 't2' } },
        ],
        settings: {},
      },
      { now: 0, newId: () => 'x', theme: s.chords['c1']!.theme, homeUrl: 'https://home.test/' },
    );
    expect(shownTabs(restored, 'w1')).toEqual(['t1', 't2']);
    expect(restored.windows['w2']!.activeTab['c1']).toBeNull();
  });
});
