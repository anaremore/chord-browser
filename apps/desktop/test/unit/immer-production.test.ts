/**
 * Core reads a draft's nodes through Immer's own copy (core/nodes.ts), whose
 * field names (`copy_`, `base_`) only Immer's development build keeps. Its
 * production builds rename them: there core must read the draft itself, slow
 * but right. Chord bundles the development build (`immer.mjs`) everywhere;
 * this holds the queries right under either.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as dev from 'immer';
import { describe, expect, it } from 'vitest';
import { childrenToRead, deleteNode, emptyState, nodeIds, nodeList, nodeOf, nodesOfChord, setNode, splitsWithPanes, tabsInOrder, type SidebarNode, type State, type TabNode } from '@chord/core';

const require = createRequire(import.meta.url);
const production = require(join(dirname(require.resolve('immer')), 'immer.cjs.production.js')) as typeof dev;

const tab = (id: string, rank: string, parentId: string | null = null): SidebarNode => ({
  kind: 'tab',
  id,
  chordId: 'c1',
  section: 'pinned',
  parentId,
  rank,
  url: `https://${id}.test/`,
  title: id,
  pinnedUrl: `https://${id}.test/`,
  customTitle: null,
  favicon: null,
  lastActiveAt: 0,
  createdAt: 0,
});

function base(produce: typeof dev.produce): State {
  const state = emptyState();
  for (const n of [
    tab('a', 'a0'),
    { kind: 'folder', id: 'f', chordId: 'c1', section: 'pinned', parentId: null, rank: 'a1', title: 'F', collapsed: false, createdAt: 0 } as SidebarNode,
    tab('x', 'a0', 'f'),
    tab('b', 'a2'),
  ])
    setNode(state, n);
  return produce(state, () => {});
}

const ids = (nodes: readonly SidebarNode[]) => nodes.map((n) => n.id);

describe.each([
  ['development', dev],
  ['production', production],
] as const)("core's tree queries in a draft of Immer's %s build", (build, immer) => {
  it.each([
    { name: 'a node added', change: (d: State) => setNode(d, tab('c', 'a3')), pinned: ['a', 'f', 'b', 'c'], order: ['a', 'x', 'b', 'c'] },
    { name: 'a node deleted', change: (d: State) => void deleteNode(d, 'a'), pinned: ['f', 'b'], order: ['x', 'b'] },
    { name: 'a node re-ranked', change: (d: State) => void (nodeOf(d, 'a')!.rank = 'a9'), pinned: ['f', 'b', 'a'], order: ['x', 'b', 'a'] },
    { name: 'a node moved into the folder', change: (d: State) => void (nodeOf(d, 'b')!.parentId = 'f'), pinned: ['a', 'f'], order: ['a', 'x', 'b'] },
  ])('see $name', ({ change, pinned, order }) => {
    immer.produce(base(immer.produce), (d) => {
      const draft = d as State;
      change(draft);
      expect(ids(childrenToRead(draft, 'c1', 'pinned'))).toEqual(pinned);
      expect(ids(tabsInOrder(draft, 'c1'))).toEqual(order);
      expect(nodeList(draft)).toHaveLength(nodeIds(draft).length);
      expect(ids(nodesOfChord(draft, 'c1')).sort()).toEqual(ids(nodeList(draft)).sort());
      expect(ids(splitsWithPanes(draft).inside('f')).sort()).toEqual(ids(nodeList(draft).filter((n) => n.parentId === 'f')).sort());
    });
    // And the state it made, whose index is the last one's put right.
    const next = immer.produce(base(immer.produce), (d) => change(d as State));
    expect(ids(childrenToRead(next, 'c1', 'pinned'))).toEqual(pinned);
    expect(ids(tabsInOrder(next, 'c1'))).toEqual(order);
  });

  it(build === 'development' ? 'reads its own copy: nothing only read is drafted' : 'read the draft itself: everything read is drafted', () => {
    immer.produce(base(immer.produce), (d) => {
      const draft = d as State;
      (nodeOf(draft, 'b') as TabNode).title = 'changed';
      for (const n of nodeList(draft)) expect(immer.isDraft(n), n.id).toBe(build === 'production' || n.id === 'b');
    });
  });
});
