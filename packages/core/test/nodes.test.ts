import { isDraft, produce, enablePatches, produceWithPatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { children, childrenToRead, descendants, emptyState, nodeList, tabsInOrder, bucketOf, byRank, childrenIndex, childrenShared, deleteNode, NODE_BUCKETS, nodeIds, nodeIdsOfPatch, nodeOf, nodesFrom, nodesOfChord, patchTouchesNode, setNode, splitsWithPanes, uuidv7, type SidebarNode, type State, type TabNode, type BucketKey, type NodeBuckets, type Section } from '../src';

enablePatches();

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
    setNode(state, n);
  return produce(state, () => {});
}

const ids = (nodes: readonly SidebarNode[]) => nodes.map((n) => n.id);

/**
 * Each change made in a draft, then what the helpers see in that same draft:
 * they read the draft's own copy (nodes.ts), so they must see every change.
 */
const cases: { name: string; change: (d: State) => void; pinned: string[]; inFolder: string[]; order: string[] }[] = [
  { name: 'nothing', change: () => {}, pinned: ['a', 'f', 'b'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 'b', 't'] },
  { name: 'a node added', change: (d) => setNode(d, tab('c', 'a3')), pinned: ['a', 'f', 'b', 'c'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 'b', 'c', 't'] },
  { name: 'a node deleted', change: (d) => void deleteNode(d, 'a'), pinned: ['f', 'b'], inFolder: ['x', 'y'], order: ['x', 'y', 'b', 't'] },
  { name: 'a node re-ranked', change: (d) => void (nodeOf(d, 'a')!.rank = 'a9'), pinned: ['f', 'b', 'a'], inFolder: ['x', 'y'], order: ['x', 'y', 'b', 'a', 't'] },
  { name: 'a node moved into the folder', change: (d) => void (nodeOf(d, 'b')!.parentId = 'f'), pinned: ['a', 'f'], inFolder: ['x', 'y', 'b'], order: ['a', 'x', 'y', 'b', 't'] },
  { name: 'a node unpinned', change: (d) => void (nodeOf(d, 'b')!.section = 'today'), pinned: ['a', 'f'], inFolder: ['x', 'y'], order: ['a', 'x', 'y', 't', 'b'] },
  { name: 'a node replaced', change: (d) => setNode(d, tab('y', '9', 'f')), pinned: ['a', 'f', 'b'], inFolder: ['y', 'x'], order: ['a', 'y', 'x', 'b', 't'] },
  { name: 'the folder collapsed', change: (d) => void ((nodeOf(d, 'f') as { collapsed: boolean }).collapsed = true), pinned: ['a', 'f', 'b'], inFolder: ['x', 'y'], order: ['a', 'b', 't'] },
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
      expect(nodeList(draft)).toHaveLength(nodeIds(draft).length);
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
      (nodeOf(draft, 'b') as TabNode).title = 'changed';
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
    setNode(state, tab('a', 'a0'));
    expect(ids(children(state, 'c1', 'pinned'))).toEqual(['a']);
    setNode(state, tab('b', 'a1'));
    expect(ids(children(state, 'c1', 'pinned'))).toEqual(['a', 'b']);
  });
});

describe('nodes in buckets', () => {
  it('spreads IDs over every bucket, evenly enough', () => {
    const counts = new Map<BucketKey, number>();
    const all = [...Array.from({ length: 35_000 }, (_, i) => `imp-t${i}`), ...Array.from({ length: 5_000 }, () => uuidv7())];
    for (const id of all) counts.set(bucketOf(id), (counts.get(bucketOf(id)) ?? 0) + 1);
    expect(counts.size).toBe(NODE_BUCKETS);
    // 40,000 over 256 is 156 a bucket: none has half as many again.
    expect(Math.max(...counts.values())).toBeLessThan(235);
  });

  it("keeps every bucket, empty or not, so a node's patch path is always [nodes, bucket, id]", () => {
    const state = emptyState();
    expect(Object.keys(state.nodes)).toHaveLength(NODE_BUCKETS);
    const [, patches] = produceWithPatches(state, (d) => {
      setNode(d, tab('a', 'a0'));
      deleteNode(d, 'missing');
    });
    expect(patches).toEqual([{ op: 'add', path: ['nodes', bucketOf('a'), 'a'], value: tab('a', 'a0') }]);
  });

  it.each([
    { path: ['nodes', 'n00', 'a', 'title'], want: ['a'] },
    { path: ['nodes', 'n00', 'a'], want: ['a'] },
    { path: ['chords', 'c1'], want: null },
  ])('names the nodes a patch is about: $path', ({ path, want }) => {
    expect(nodeIdsOfPatch(path, emptyState())).toEqual(want);
  });

  it('names every node of a bucket, or of the state, written whole, before and after', () => {
    const before = { nodes: nodesFrom([tab('a', 'a0'), tab('b', 'a1')]) };
    const after = { nodes: nodesFrom([tab('a', 'a0'), tab('c', 'a2')]) };
    expect(nodeIdsOfPatch(['nodes'], after, before)!.sort()).toEqual(['a', 'b', 'c']);
    expect(nodeIdsOfPatch(['nodes', bucketOf('b')], after, before)).toContain('b');
    expect(patchTouchesNode(['nodes', bucketOf('a'), 'a', 'rank'], 'a')).toBe(true);
    expect(patchTouchesNode(['nodes', bucketOf('a'), 'b'], 'a')).toBe(false);
    expect(patchTouchesNode(['nodes', bucketOf('a')], 'a')).toBe(true);
    expect(patchTouchesNode(['nodes'], 'a')).toBe(true);
    expect(patchTouchesNode(['live', 'a'], 'a')).toBe(false);
  });
});

/** A small seeded random source, so a failure can be found again. */
function random(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! };
}

const CHORDS = ['c1', 'c2', 'c3'];
const SECTIONS: Section[] = ['pinned', 'today'];

/** What every query should say, from one plain pass over the nodes as they are now (in a draft, its own copy). */
function check(state: State, label: string) {
  const all = nodeList(state);
  const parents = [null, ...all.map((n) => n.id), 'nowhere'];
  const want = (c: string, sec: Section, p: string | null) =>
    all
      .filter((n) => n.chordId === c && n.section === sec && n.parentId === p)
      .sort(byRank)
      .map((n) => n.id);
  for (const c of CHORDS) {
    const index = childrenIndex(state, c);
    for (const sec of SECTIONS) {
      for (const p of parents) {
        const expected = want(c, sec, p);
        expect(ids(childrenToRead(state, c, sec, p)), `${label}: ${c}/${sec}/${p}`).toEqual(expected);
        expect(ids(childrenShared(state, c, sec, p)), `${label}: shared ${c}/${sec}/${p}`).toEqual(expected);
        expect(ids(index(sec, p)), `${label}: index ${c}/${sec}/${p}`).toEqual(expected);
      }
    }
    expect(ids(nodesOfChord(state, c)).sort(), `${label}: chord ${c}`).toEqual(all.filter((n) => n.chordId === c).map((n) => n.id).sort());
  }
  const splits = splitsWithPanes(state);
  expect(ids(splits.splits).sort(), `${label}: splits`).toEqual(all.filter((n) => n.kind === 'split').map((n) => n.id).sort());
  for (const p of parents) {
    if (p !== null) expect(ids(splits.inside(p)).sort(), `${label}: inside ${p}`).toEqual(all.filter((n) => n.parentId === p).map((n) => n.id).sort());
  }
}

/** One random change, made as the reducer makes them (through the helpers), or once in a while straight to a bucket. */
function change(d: State, r: ReturnType<typeof random>, made: { n: number }) {
  const all = nodeList(d);
  const some = () => r.pick(all);
  const parentFor = () => (r.next() < 0.5 || all.length === 0 ? null : some().id);
  const rank = () => `a${r.int(30).toString().padStart(2, '0')}`;
  const what = all.length < 5 ? 0 : r.int(9);
  if (what <= 1) {
    const id = `n${made.n++}`;
    const kind = r.next() < 0.15 ? 'split' : r.next() < 0.2 ? 'folder' : 'tab';
    const at = { id, chordId: r.pick(CHORDS), section: r.pick(SECTIONS), parentId: parentFor(), rank: rank(), createdAt: 0 };
    if (kind === 'split') setNode(d, { ...at, kind, direction: 'row', sizes: [] });
    else if (kind === 'folder') setNode(d, { ...at, kind, title: id, collapsed: false } as SidebarNode);
    else setNode(d, { ...tab(id, at.rank, at.parentId, at.section), chordId: at.chordId });
  } else if (what === 2) deleteNode(d, some().id);
  else if (what === 3) nodeOf(d, some().id)!.rank = rank();
  else if (what === 4) nodeOf(d, some().id)!.parentId = parentFor();
  else if (what === 5) Object.assign(nodeOf(d, some().id)!, { chordId: r.pick(CHORDS), section: r.pick(SECTIONS) });
  else if (what === 6) {
    // Put in whole in its own place, as a merge does.
    const old = some();
    setNode(d, { ...old, rank: rank() } as SidebarNode);
  } else if (what === 7) void nodeOf(d, some().id); // drafted, not changed
  else {
    // A bucket put in whole, past the helpers (nothing in Chord does): the queries must still see it. (A single node
    // written past them can't be: the journal is how a draft's changes are found, nodes.ts.)
    const old = some();
    const key = bucketOf(old.id);
    const copies = Object.fromEntries(nodeList({ nodes: { [key]: (d.nodes as NodeBuckets)[key]! } }).map((n) => [n.id, { ...n }]));
    (d.nodes as NodeBuckets)[key] = { ...copies, [old.id]: { ...old, parentId: null } as SidebarNode };
  }
}

describe("the index of a state's children, kept from one state to the next", () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))('agrees with a plain pass, in drafts and in the states they make (seed %i)', (seed) => {
    const r = random(seed);
    const made = { n: 0 };
    let state = produce(emptyState(), (d) => {
      for (let i = 0; i < 40; i++) change(d as State, r, made);
    });
    check(state, 'start');
    // Another line of states beside it, as main's store and a mirror are in one test process.
    let other = produce(state, (d) => change(d as State, r, made));
    for (let step = 0; step < 25; step++) {
      state = produce(state, (d) => {
        const draft = d as State;
        for (let k = 0, n = 1 + r.int(6); k < n; k++) {
          change(draft, r, made);
          if (r.next() < 0.5) check(draft, `seed ${seed}, step ${step}.${k}, draft`);
        }
      });
      check(state, `seed ${seed}, step ${step}`);
      if (step % 3 === 0) {
        other = produce(other, (d) => change(d as State, r, made));
        check(other, `seed ${seed}, other ${step}`);
      }
    }
  });

  it('indexes afresh a state unrelated to the last ones, and one changed all over', () => {
    const a = produce(emptyState(), (d) => {
      for (let i = 0; i < 2000; i++) setNode(d, tab(`a${i}`, `a${i}`));
    });
    check(a, 'a');
    const b = produce(emptyState(), (d) => {
      for (let i = 0; i < 2000; i++) setNode(d, tab(`b${i}`, `a${i}`));
    });
    check(b, 'b');
    const c = produce(b, (d) => {
      for (const n of nodeList(d)) nodeOf(d, n.id)!.rank = `z${n.rank}`;
    });
    check(c, 'c');
  });
});
