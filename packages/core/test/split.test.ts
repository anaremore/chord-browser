import { describe, expect, it } from 'vitest';
import {
  apply,
  archiveCandidates,
  emptyState,
  paneRects,
  resizeSizes,
  restoreState,
  settleSplits,
  shownTabs,
  splitMembers,
  splitOf,
  tabsInOrder,
  visibleTabs,
  windowsShowing,
  type Command,
  type Context,
  type SplitNode,
  type State,
  type TabNode,
} from '../src';

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
  state.nodes['t1'] = tab('t1', 'a0');
  state.nodes['t2'] = tab('t2', 'a1');
  state.nodes['t3'] = tab('t3', 'a2');
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

const split = (state: State, id: string) => state.nodes[id] as SplitNode;
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
    expect(t.state.nodes[s]).toBeUndefined();
    expect(t.state.nodes['t1']).toMatchObject({ parentId: null, rank: 'a0' });
    expect(Object.values(t.state.nodes).some((n) => n.kind === 'split')).toBe(false);
  });

  it('separates every pane into its own tab where the split was, and joins them again', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't2', nodeId: 't3' });
    const s = splitOf(t.state, 't2')!;
    t.run({ t: 'split.separate', splitId: s.id });
    expect(t.state.nodes[s.id]).toBeUndefined();
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
    expect(t.state.nodes[s]).toBeUndefined();
    expect(shownTabs(t.state, 'w1')).toEqual(['t1']);
  });

  it('a pinned pane leaves its split when closed, and stays pinned', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't3' });
    t.run({ t: 'tab.pin', nodeId: 't1' });
    const s = splitOf(t.state, 't1')!.id;
    expect(split(t.state, s).section).toBe('pinned');
    expect(['t1', 't2', 't3'].map((id) => (t.state.nodes[id] as TabNode).pinnedUrl)).toEqual(['https://t1.test/', 'https://t2.test/', 'https://t3.test/']);
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 't3' });
    expect(t.state.nodes['t3']).toMatchObject({ section: 'pinned', parentId: null });
    expect(panes(t.state, s)).toEqual(['t1', 't2']);
    // Unpinning a pane unpins the split.
    t.run({ t: 'tab.unpin', nodeId: 't2' });
    expect(split(t.state, s).section).toBe('today');
    expect((t.state.nodes['t1'] as TabNode).pinnedUrl).toBeNull();
  });

  it('a split moves as one, in and out of folders', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = splitOf(t.state, 't1')!.id;
    t.run({ t: 'folder.create', folderId: 'f1', chordId: 'c1', title: 'Work' });
    t.run({ t: 'node.move', nodeId: s, section: 'pinned', index: 0, parentId: 'f1' });
    expect(split(t.state, s)).toMatchObject({ section: 'pinned', parentId: 'f1' });
    expect((t.state.nodes['t2'] as TabNode).section).toBe('pinned');
    // Dragging a pane out to the sidebar takes it out of the split.
    t.run({ t: 'node.move', nodeId: 't2', section: 'today', index: 0 });
    expect(t.state.nodes[s]).toBeUndefined();
    expect(t.state.nodes['t1']).toMatchObject({ parentId: 'f1', section: 'pinned' });
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
    state.nodes['s'] = { kind: 'split', id: 's', chordId: 'c1', section: 'today', parentId: null, rank: 'Zz', direction: 'row', sizes: [1], createdAt: 0 };
    for (const [i, id] of ['t1', 't2', 't3'].entries()) Object.assign(state.nodes[id]!, { parentId: 's', rank: `a${i}` });
    const changed = settleSplits(state);
    expect(splitMembers(state, 's').map((p) => p.id)).toEqual(['t1', 't2', 't3']);
    expect((state.nodes['s'] as SplitNode).sizes).toHaveLength(3);
    expect(changed.size).toBe(3);
  });

  it('restores splits whole, and one window keeps a split another one also shows', () => {
    const t = setup();
    t.run({ t: 'split.add', windowId: 'w1', withId: 't1', nodeId: 't2' });
    const s = t.state;
    const restored = restoreState(
      {
        chords: Object.values(s.chords),
        nodes: Object.values(s.nodes),
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
