import { isDraft, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { children, childrenToRead, descendants, emptyState, nodeList, tabsInOrder, type SidebarNode, type State, type TabNode } from '../src';

const tab = (id: string, rank: string, parentId: string | null = null, section: 'pinned' | 'today' = 'pinned'): SidebarNode => ({
  kind: 'tab',
  id,
  chordId: 'c1',
  section,
  parentId,
  rank,
  url: `https://${id}.test/`,
  title: id,
  pinnedUrl: section === 'pinned' ? `https://${id}.test/` : null,
  customTitle: null,
  favicon: null,
  lastActiveAt: 0,
  createdAt: 0,
});

/** c1's pinned: a, folder f (with x, y), b; Today: t. Frozen, as the store's states are. */
function base(): State {
  const state = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'C', icon: 'C', theme: { stops: [], grain: 0, appearance: 'auto' }, rank: 'a0', createdAt: 0 };
  for (const n of [
    tab('a', 'a0'),
    { kind: 'folder', id: 'f', chordId: 'c1', section: 'pinned', parentId: null, rank: 'a1', title: 'F', collapsed: false, createdAt: 0 } as SidebarNode,
    tab('x', 'a0', 'f'),
    tab('y', 'a1', 'f'),
    tab('b', 'a2'),
    tab('t', 'a0', null, 'today'),
  ])
    state.nodes[n.id] = n;
  return produce(state, () => {});
}

const ids = (nodes: readonly SidebarNode[]) => nodes.map((n) => n.id);

/**
 * Each change made in a draft, then what the helpers see in that same draft:
 * they read the draft's own copy (nodes.ts), so they must see every change.
 */
const cases: { name: string; change: (d: State) => void; pinned: string[]; inFolder: string[]; order: string[] }[] = [
  { name: 'nothing', change: () => {}, pinned: ['a', 'f', 'b'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 'b', 't'] },
  { name: 'a node added', change: (d) => void (d.nodes['c'] = tab('c', 'a3')), pinned: ['a', 'f', 'b', 'c'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 'b', 'c', 't'] },
  { name: 'a node deleted', change: (d) => void delete d.nodes['a'], pinned: ['f', 'b'], inFolder: ['x', 'y'], order: ['x', 'y', 'b', 't'] },
  { name: 'a node re-ranked', change: (d) => void (d.nodes['a']!.rank = 'a9'), pinned: ['f', 'b', 'a'], inFolder: ['x', 'y'], order: ['x', 'y', 'b', 'a', 't'] },
  { name: 'a node moved into the folder', change: (d) => void (d.nodes['b']!.parentId = 'f'), pinned: ['a', 'f'], inFolder: ['x', 'y', 'b'], order: ['a', 'x', 'y', 'b', 't'] },
  { name: 'a node unpinned', change: (d) => void (d.nodes['b']!.section = 'today'), pinned: ['a', 'f'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 't', 'b'] },
  { name: 'a node replaced', change: (d) => void (d.nodes['y'] = tab('y', '9', 'f')), pinned: ['a', 'f', 'b'], inFolder: ['y', 'x'], order: ['a', 'y', 'x', 'b', 't'] },
  { name: 'the folder collapsed', change: (d) => void ((d.nodes['f'] as { collapsed: boolean }).collapsed = true), pinned: ['a', 'f', 'b'], inFolder: ['x', 'y'], order: ['a', 'b', 't'] },
];

describe('reading nodes', () => {
  it.each(cases)('in a draft, after $name', ({ change, pinned, inFolder, order }) => {
    produce(base(), (d) => {
      const draft = d as State;
      change(draft);
      expect(ids(childrenToRead(draft, 'c1', 'pinned'))).toEqual(pinned);
      expect(ids(children(draft, 'c1', 'pinned', 'f'))).toEqual(inFolder);
      expect(ids(tabsInOrder(draft, 'c1'))).toEqual(order);
      expect(ids(descendants(draft, 'f'))).toEqual(inFolder);
      expect(nodeList(draft)).toHaveLength(Object.keys(draft.nodes).length);
    });
  });

  it.each(cases)('in the state it made, after $name', ({ change, pinned, inFolder, order }) => {
    const next = produce(base(), (d) => change(d as State));
    expect(ids(children(next, 'c1', 'pinned'))).toEqual(pinned);
    expect(ids(childrenToRead(next, 'c1', 'pinned', 'f'))).toEqual(inFolder);
    expect(ids(tabsInOrder(next, 'c1'))).toEqual(order);
  });

  it('hands out drafts from `children` in a draft, so what it returns can change', () => {
    const next = produce(base(), (d) => {
      const found = children(d as State, 'c1', 'pinned');
      expect(found.every(isDraft)).toBe(true);
      found[0]!.rank = 'a8';
    });
    expect(ids(children(next, 'c1', 'pinned'))).toEqual(['f', 'b', 'a']);
  });

  it('drafts no node it only reads, only the ones changed', () => {
    produce(base(), (d) => {
      const draft = d as State;
      (draft.nodes['b'] as TabNode).title = 'changed';
      // Read through Immer's own copy (nodes.ts): if Immer ever stores it differently, these would be drafts.
      for (const read of [nodeList(draft), childrenToRead(draft, 'c1', 'pinned'), childrenToRead(draft, 'c1', 'pinned', 'f'), tabsInOrder(draft, 'c1'), descendants(draft, 'f')]) {
        expect(read.length).toBeGreaterThan(0);
        for (const n of read) expect(isDraft(n), n.id).toBe(n.id === 'b');
      }
    });
  });

  it('gives a new array each time from a frozen state', () => {
    const state = base();
    const first = childrenToRead(state, 'c1', 'pinned');
    first.reverse();
    expect(ids(childrenToRead(state, 'c1', 'pinned'))).toEqual(['a', 'f', 'b']);
  });

  it("doesn't keep children of a state that can still change", () => {
    const state = emptyState();
    state.nodes['a'] = tab('a', 'a0');
    expect(ids(children(state, 'c1', 'pinned'))).toEqual(['a']);
    state.nodes['b'] = tab('b', 'a1');
    expect(ids(children(state, 'c1', 'pinned'))).toEqual(['a', 'b']);
  });
});
