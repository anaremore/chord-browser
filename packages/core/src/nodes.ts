/**
 * The sidebar's nodes, and the tree's one primitive: a parent's children, in order.
 *
 * Fast on a very large profile (ARCHITECTURE.md §6.1, *Large profiles*):
 * - The nodes are kept in buckets by a hash of their ID (`state.nodes[bucket][id]`),
 *   so a change copies and freezes one bucket of about a 256th of them, not
 *   every node: with 35,000 nodes a flat map's copy and freeze alone took
 *   20–35 ms a change, in main and again in every renderer's mirror. Read and
 *   change them only through these helpers (`nodeOf`, `nodeList`, `setNode`,
 *   `deleteNode`); the type keeps `state.nodes[id]` from compiling.
 * - In the reducer, `state` is an Immer draft, and reading every value of a
 *   draft makes a draft of each, which Immer then has to finalize: with 5,000
 *   pinned tabs one close took 1.4 s. These read the draft's own copy instead
 *   (`nodeList`), where nodes already changed are drafts and the rest are
 *   as they were, and hand out drafts only for what they return.
 * - A state that's done (frozen) never changes, so its children are indexed
 *   once and kept with it. A new state's index is the last one's, with the
 *   buckets that changed put right, so a change costs about the bucket, not
 *   every node. In a draft, the children come from its base's index with
 *   the draft's changed buckets laid over it.
 *
 * What's saved, synced and exported never sees the buckets: patches under
 * `['nodes', bucket, id]` name one node (`nodeIdsOfPatch`), and records are
 * one per node, as before.
 */
import { isDraft } from 'immer';
import type { ChordId, NodeId, Section, SidebarNode, State } from './model';

/** Rank order; ties (possible after reopening a closed tab) fall back to ID, which is time-ordered. */
export const byRank = (a: SidebarNode, b: SidebarNode): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** A bucket's key: `n` and two hex digits. Never an array index, so buckets keep their order. */
export type BucketKey = `n${string}`;

/** One bucket: its nodes by ID. */
export type NodeBucket = Record<NodeId, SidebarNode>;

/**
 * The sidebar's nodes by bucket, then by ID. Every bucket is always there,
 * empty or not, so a node's patch path is always `['nodes', bucket, id, …]`.
 */
export type NodeBuckets = { [bucket: BucketKey]: NodeBucket };

/** How many buckets: about 140 nodes each at 35,000 (5,000 pinned tabs and 30,000 bookmarks). */
export const NODE_BUCKETS = 256;

const BUCKET_KEYS: readonly BucketKey[] = Array.from({ length: NODE_BUCKETS }, (_, i) => `n${i.toString(16).padStart(2, '0')}` as BucketKey);

/**
 * The bucket a node's ID falls in: FNV-1a over its last 8 characters (a
 * UUIDv7's are random; its first are the time), then a final mix so short
 * IDs that differ in one character spread too.
 */
export function bucketOf(id: NodeId): BucketKey {
  let h = 0x811c9dc5;
  for (let i = Math.max(0, id.length - 8); i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return BUCKET_KEYS[h & (NODE_BUCKETS - 1)]!;
}

/** No nodes: every bucket, empty. */
export function emptyNodes(): NodeBuckets {
  const nodes: NodeBuckets = {};
  for (const key of BUCKET_KEYS) nodes[key] = {};
  return nodes;
}

/** Nodes in buckets, from a list (the last of an ID wins). */
export function nodesFrom(list: Iterable<SidebarNode>): NodeBuckets {
  const nodes = emptyNodes();
  for (const node of list) nodes[bucketOf(node.id)]![node.id] = node;
  return nodes;
}

/**
 * Anything with the nodes: a state, a draft of one, or just its nodes (or a
 * test's own looser picture of them, so its nodes are its own type too).
 */
export type HasNodes = { readonly nodes: { readonly [bucket: BucketKey]: Readonly<Record<NodeId, object>> } };
/** A node of `S`: in a draft, a draft. */
type NodeIn<S extends HasNodes> = S['nodes'][BucketKey][NodeId];

/**
 * In a draft, the nodes these helpers handed out as drafts, put in or took
 * out, by bucket: only they can differ from the draft's base, so the tree's
 * queries in a draft look at them, not at every node of every bucket that
 * changed (deleting a chord changes them all). Nothing else can reach a node
 * by its ID (the type keeps `state.nodes[id]` from compiling).
 */
const journals = new WeakMap<object, Map<BucketKey, Set<NodeId>>>();

function touch(nodes: NodeBuckets, key: BucketKey, id: NodeId): void {
  if (!isDraft(nodes)) return;
  let journal = journals.get(nodes);
  if (!journal) journals.set(nodes, (journal = new Map()));
  const ids = journal.get(key);
  if (ids) ids.add(id);
  else journal.set(key, new Set([id]));
}

/** A node by ID. In a draft, a draft of it, to change. */
export function nodeOf<S extends HasNodes>(state: S, id: NodeId): NodeIn<S> | undefined {
  const nodes = state.nodes as NodeBuckets;
  const key = bucketOf(id);
  touch(nodes, key, id);
  return nodes[key]?.[id] as NodeIn<S> | undefined;
}

/** Whether there's a node with this ID (in a draft, without making a draft of it). */
export function hasNode(state: HasNodes, id: NodeId): boolean {
  const bucket = (state.nodes as NodeBuckets)[bucketOf(id)];
  return bucket !== undefined && id in bucket;
}

/** Put a node in (or in place of the one with its ID). */
export function setNode(state: HasNodes, node: SidebarNode): void {
  const nodes = state.nodes as NodeBuckets;
  const key = bucketOf(node.id);
  touch(nodes, key, node.id);
  (nodes[key] ??= {})[node.id] = node;
}

/** Take a node out. */
export function deleteNode(state: HasNodes, id: NodeId): void {
  const nodes = state.nodes as NodeBuckets;
  const key = bucketOf(id);
  const bucket = nodes[key];
  if (!bucket || !(id in bucket)) return;
  touch(nodes, key, id);
  delete bucket[id];
}

/** Immer's own key for a draft's state (a global symbol, so every copy of Immer shares it). */
const DRAFT_STATE = Symbol.for('immer-state');

interface DraftState<T> {
  base_: T;
  copy_: T | null;
}

const draftStateOf = <T>(value: T): DraftState<T> | undefined => (value as { [DRAFT_STATE]?: DraftState<T> })[DRAFT_STATE];

/**
 * A record as it is now, to read: in a draft, its own copy, without making a
 * draft of each value. Values already changed in the draft are drafts; the
 * others are the frozen originals, so change one through the record, never this.
 *
 * `copy_` and `base_` are Immer's own, and its production builds rename
 * them: there, this is the draft itself, which is right, only slow. Chord
 * resolves `immer` to its development build (`immer.mjs`) in every process;
 * `immer-production.test.ts` holds both ways.
 */
function ownOf<T extends object>(record: T): T {
  const draft = draftStateOf(record);
  return draft?.copy_ ?? draft?.base_ ?? record;
}

/** Every node, to read (see `ownOf`): change one through `nodeOf` or `setNode`. */
export function nodeList<S extends HasNodes>(state: S): NodeIn<S>[] {
  const out: NodeIn<S>[] = [];
  const buckets = ownOf(state.nodes as NodeBuckets);
  for (const key in buckets) {
    const bucket = buckets[key as BucketKey];
    if (!bucket) continue;
    const own = ownOf(bucket);
    for (const id in own) out.push(own[id] as NodeIn<S>);
  }
  return out;
}

/** Every node's ID. */
export function nodeIds(state: HasNodes): NodeId[] {
  const out: NodeId[] = [];
  const buckets = ownOf(state.nodes as NodeBuckets);
  for (const key in buckets) {
    const bucket = buckets[key as BucketKey];
    if (bucket) for (const id in ownOf(bucket)) out.push(id);
  }
  return out;
}

/** How many nodes there are. */
export function nodeCount(state: HasNodes): number {
  let n = 0;
  const buckets = ownOf(state.nodes as NodeBuckets);
  for (const key in buckets) {
    const bucket = buckets[key as BucketKey];
    if (bucket) n += Object.keys(ownOf(bucket)).length;
  }
  return n;
}

/**
 * The nodes an Immer patch is about, by its path: one, under
 * `['nodes', bucket, id, …]`; every one in the bucket, or in the state, when
 * a bucket or all of `nodes` was written whole (read from `state`, and from
 * `before` when given, so one taken out is there too); null for a patch
 * that isn't about nodes. This is how persistence, sync and export keep one
 * op per node, as when the nodes weren't in buckets.
 */
export function nodeIdsOfPatch(path: readonly (string | number)[], state: HasNodes, before?: HasNodes): NodeId[] | null {
  if (path[0] !== 'nodes') return null;
  if (path.length >= 3) return [String(path[2])];
  const ids = new Set<NodeId>();
  for (const s of before ? [state, before] : [state]) {
    if (path.length === 1) for (const id of nodeIds(s)) ids.add(id);
    else for (const id of Object.keys((s.nodes as NodeBuckets)[path[1] as BucketKey] ?? {})) ids.add(id);
  }
  return [...ids];
}

/** Whether an Immer patch is about the node with this ID (or might be: a bucket, or all of `nodes`, written whole). */
export function patchTouchesNode(path: readonly (string | number)[], id: NodeId): boolean {
  if (path[0] !== 'nodes') return false;
  if (path.length >= 3) return path[2] === id;
  return path.length === 1 || path[1] === bucketOf(id);
}

// ———————————————————————————————————————————————————————— Children ——

/** The sidebar's own nodes: a state, a draft of one, or just its nodes. */
type Nodes = { readonly nodes: NodeBuckets };

/** Children by chord, section and parent (null: the section's root), each list sorted when first asked for. */
type Groups = Map<ChordId, Map<Section, Map<NodeId | null, Group>>>;
interface Group {
  nodes: SidebarNode[];
  sorted: boolean;
}

/** A state's index: its children, and its splits (which settle after every change that can move a pane, split.ts). */
interface Index {
  groups: Groups;
  splits: ReadonlySet<SidebarNode>;
}

/** One pass over `nodes`. */
function indexOf(nodes: readonly SidebarNode[]): Index {
  const splits = new Set<SidebarNode>();
  for (const node of nodes) if (node.kind === 'split') splits.add(node);
  return { groups: group(nodes), splits };
}

/** One pass over `nodes` (only `chordId`'s, when given). */
function group(nodes: Iterable<SidebarNode>, chordId?: ChordId): Groups {
  const groups: Groups = new Map();
  for (const node of nodes) {
    if (chordId !== undefined && node.chordId !== chordId) continue;
    let sections = groups.get(node.chordId);
    if (!sections) groups.set(node.chordId, (sections = new Map()));
    let parents = sections.get(node.section);
    if (!parents) sections.set(node.section, (parents = new Map()));
    const found = parents.get(node.parentId);
    if (found) found.nodes.push(node);
    else parents.set(node.parentId, { nodes: [node], sorted: false });
  }
  return groups;
}

/** A group's nodes in order (sorting it in place the first time: its members never change, only their order is settled). */
function sortedOf(found: Group | undefined): SidebarNode[] {
  if (!found) return [];
  if (!found.sorted) {
    found.nodes.sort(byRank);
    found.sorted = true;
  }
  return found.nodes;
}

const groupIn = (groups: Groups, chordId: ChordId, section: Section, parentId: NodeId | null): Group | undefined => groups.get(chordId)?.get(section)?.get(parentId);

/** Where a node goes in the groups (read from a draft's own copy: through its proxy, every read costs). */
const keyOf = (node: SidebarNode) => {
  const n = ownOf(node);
  return `${n.chordId}\0${n.section}\0${n.parentId ?? ''}`;
};

/** Nodes in rank order, some of them drafts: sorted by their own copies, so no read goes through a proxy. */
function sortRead(list: SidebarNode[]): SidebarNode[] {
  const keyed = list.map((n) => ({ n, own: ownOf(n) }));
  keyed.sort((a, b) => byRank(a.own, b.own));
  return keyed.map((k) => k.n);
}

/** The buckets that aren't the same object in both; null past `limit` of them. */
function changedBuckets(was: NodeBuckets, now: NodeBuckets, limit: number): BucketKey[] | null {
  const changed: BucketKey[] = [];
  for (const key in now) {
    if (now[key as BucketKey] === was[key as BucketKey]) continue;
    changed.push(key as BucketKey);
    if (changed.length > limit) return null;
  }
  for (const key in was) if (!(key in now)) changed.push(key as BucketKey);
  return changed.length > limit ? null : changed;
}

/** Which nodes changed between two versions of the nodes, by identity, bucket by bucket: what left, and what came. */
interface Diff {
  /** By where they were (`keyOf`). */
  gone: Map<string, Set<SidebarNode>>;
  /** By where they are. */
  came: Map<string, SidebarNode[]>;
  /** Splits among them. */
  goneSplits: Set<SidebarNode>;
  cameSplits: SidebarNode[];
  /** What came, by its parent (not the root), in any chord and section. */
  cameUnder: Map<NodeId, SidebarNode[]>;
}

/**
 * How `now` differs from `was`, over the buckets that aren't the same object
 * (`now` may be a draft's own copy, its buckets drafts). With `bail`, null
 * once most of the nodes it has looked at changed: they're unrelated, and
 * indexing `now` afresh is cheaper.
 */
function diff(was: NodeBuckets, now: NodeBuckets, bail: boolean, journal?: Map<BucketKey, Set<NodeId>>): Diff | null {
  const changed = changedBuckets(was, now, NODE_BUCKETS)!;
  let seen = 0;
  let changes = 0;
  const gone = new Map<string, Set<SidebarNode>>();
  const came = new Map<string, SidebarNode[]>();
  const goneSplits = new Set<SidebarNode>();
  const cameSplits: SidebarNode[] = [];
  const cameUnder = new Map<NodeId, SidebarNode[]>();
  for (const key of changed) {
    const before = was[key] ?? {};
    const after = now[key] ? ownOf(now[key]) : {};
    // In a draft, only what the journal names in a bucket that's still a draft; a bucket put in whole, or one the
    // journal doesn't name, is read whole.
    const ids = journal && isDraft(now[key]) ? journal.get(key) : undefined;
    if (ids) {
      for (const id of ids) {
        const old = before[id];
        const node = after[id];
        if (old === node) continue;
        if (old) {
          const at = keyOf(old);
          const set = gone.get(at);
          if (set) set.add(old);
          else gone.set(at, new Set([old]));
          if (old.kind === 'split') goneSplits.add(old);
        }
        if (node) {
          const own = ownOf(node);
          const at = keyOf(node);
          const list = came.get(at);
          if (list) list.push(node);
          else came.set(at, [node]);
          if (own.kind === 'split') cameSplits.push(node);
          if (own.parentId !== null) {
            const under = cameUnder.get(own.parentId);
            if (under) under.push(node);
            else cameUnder.set(own.parentId, [node]);
          }
        }
      }
      continue;
    }
    for (const id in before) {
      const old = before[id]!;
      seen++;
      if (after[id] === old) continue;
      changes++;
      const at = keyOf(old);
      const set = gone.get(at);
      if (set) set.add(old);
      else gone.set(at, new Set([old]));
      if (old.kind === 'split') goneSplits.add(old);
    }
    for (const id in after) {
      const node = after[id]!;
      if (before[id] === node) continue;
      changes++;
      const own = ownOf(node);
      const at = keyOf(node);
      const list = came.get(at);
      if (list) list.push(node);
      else came.set(at, [node]);
      if (own.kind === 'split') cameSplits.push(node);
      if (own.parentId !== null) {
        const under = cameUnder.get(own.parentId);
        if (under) under.push(node);
        else cameUnder.set(own.parentId, [node]);
      }
    }
    if (bail && changes > 1000 && changes > seen) return null;
  }
  return { gone, came, goneSplits, cameSplits, cameUnder };
}

/** Where `node` goes in `sorted` (binary search by rank). */
function insertSorted(sorted: SidebarNode[], node: SidebarNode): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (byRank(sorted[mid]!, node) < 0) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, node);
}

/** A group with what left taken out and what came put in: a new group (the old one stays with its state). */
function changedGroup(old: Group | undefined, gone: Set<SidebarNode> | undefined, came: SidebarNode[] | undefined): Group | null {
  const kept = old ? (gone ? old.nodes.filter((n) => !gone.has(n)) : old.nodes.slice()) : [];
  const sorted = old ? old.sorted : true;
  if (came) {
    if (sorted && came.length <= 16) for (const node of came) insertSorted(kept, node);
    else {
      kept.push(...came);
      if (kept.length === 0) return null;
      return { nodes: kept, sorted: false };
    }
  }
  return kept.length === 0 ? null : { nodes: kept, sorted };
}

/** An index with a diff applied, copying only the maps and groups it touches. */
function applyDiff(index: Index, changes: Diff): Index {
  const { gone, came, goneSplits, cameSplits } = changes;
  let splits = index.splits;
  if (goneSplits.size > 0 || cameSplits.length > 0) {
    const kept = new Set(splits);
    for (const n of goneSplits) kept.delete(n);
    for (const n of cameSplits) kept.add(n);
    splits = kept;
  }
  const next: Groups = new Map(index.groups);
  const copied = new Set<object>();
  const own = <K, V>(map: Map<K, V>): Map<K, V> => {
    if (copied.has(map)) return map;
    const copy = new Map(map);
    copied.add(copy);
    return copy;
  };
  for (const at of new Set([...gone.keys(), ...came.keys()])) {
    const [chordId, section, parent] = at.split('\0') as [ChordId, Section, string];
    const parentId = parent === '' ? null : parent;
    let sections = next.get(chordId);
    sections = sections ? own(sections) : own(new Map());
    next.set(chordId, sections);
    let parents = sections.get(section);
    parents = parents ? own(parents) : own(new Map());
    sections.set(section, parents);
    const group = changedGroup(parents.get(parentId), gone.get(at), came.get(at));
    if (group) parents.set(parentId, group);
    else parents.delete(parentId);
  }
  return { groups: next, splits };
}

/** A frozen state's index, kept for as long as its `nodes` is around. */
const frozenIndexes = new WeakMap<object, Index>();
/**
 * The frozen nodes indexed last, newest first: the next state is most likely
 * made from one of them, so its index is that one's put right. A few, not
 * one: a process can follow more than one line of states (main's store, and
 * a state sync or a test works out beside it).
 */
const recent: { nodes: NodeBuckets; index: Index }[] = [];
const RECENT = 4;

function remember(nodes: NodeBuckets, index: Index): void {
  const at = recent.findIndex((r) => r.nodes === nodes);
  if (at === 0) return;
  if (at > 0) recent.splice(at, 1);
  recent.unshift({ nodes, index });
  if (recent.length > RECENT) recent.pop();
}

/** The recent index closest to `nodes`: fewest buckets apart. */
function closest(nodes: NodeBuckets): { nodes: NodeBuckets; index: Index } | null {
  let best: { nodes: NodeBuckets; index: Index } | null = null;
  let fewest = NODE_BUCKETS;
  for (const r of recent) {
    const changed = changedBuckets(r.nodes, nodes, fewest);
    if (changed && (!best || changed.length < fewest)) {
      best = r;
      fewest = changed.length;
    }
  }
  return best;
}

/** Whether nodes are done changing: the buckets object and every bucket frozen (Immer freezes them all). */
function isDone(nodes: NodeBuckets): boolean {
  if (!Object.isFrozen(nodes)) return false;
  for (const key in nodes) if (!Object.isFrozen(nodes[key as BucketKey])) return false;
  return true;
}

/** The index of nodes that are done (frozen), cached; null for ones that can still change (a draft too). */
function indexOfNodes(nodes: NodeBuckets): Index | null {
  const known = frozenIndexes.get(nodes);
  if (known) {
    remember(nodes, known);
    return known;
  }
  if (isDraft(nodes) || !isDone(nodes)) return null;
  const from = closest(nodes);
  const changes = from ? diff(from.nodes, nodes, true) : null;
  const index = from && changes ? applyDiff(from.index, changes) : indexOf(nodeList({ nodes }));
  frozenIndexes.set(nodes, index);
  remember(nodes, index);
  return index;
}

/**
 * How to read children in a state: its own groups when it's done; in a
 * draft, its base's groups with the draft's changes laid over them; null
 * when neither can be had (a state still being changed by hand, or Immer's
 * production build), and every node must be read.
 */
interface View extends Index {
  changes: Diff | null;
}

function viewOf(state: Nodes): View | null {
  const nodes = state.nodes;
  if (isDraft(nodes)) {
    const draft = draftStateOf(nodes);
    if (!draft?.base_) return null;
    const index = indexOfNodes(draft.base_);
    if (!index) return null;
    return { ...index, changes: draft.copy_ ? diff(draft.base_, draft.copy_, false, journals.get(nodes)) : null };
  }
  const index = indexOfNodes(nodes);
  return index ? { ...index, changes: null } : null;
}

/** A parent's children from a view, in order. A new array. */
function childrenIn(view: View, chordId: ChordId, section: Section, parentId: NodeId | null): SidebarNode[] {
  const base = sortedOf(groupIn(view.groups, chordId, section, parentId));
  if (!view.changes) return base.slice();
  const at = `${chordId}\0${section}\0${parentId ?? ''}`;
  const gone = view.changes.gone.get(at);
  const came = view.changes.came.get(at);
  if (!gone && !came) return base.slice();
  const kept = gone ? base.filter((n) => !gone.has(n)) : base.slice();
  if (!came) return kept;
  kept.push(...came);
  return sortRead(kept);
}

/**
 * Children of a parent (a folder or a split, or the section's root) in one
 * section of a chord, in sidebar order, to read: in a draft, frozen
 * originals for the ones not changed yet. A new array each time.
 */
export function childrenToRead(state: Nodes, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  const view = viewOf(state);
  if (view) return childrenIn(view, chordId, section, parentId);
  return nodeList(state)
    .filter((n) => n.chordId === chordId && n.section === section && n.parentId === parentId)
    .sort(byRank);
}

/**
 * The same, shared and never to be changed, for a state that's done: what
 * the sidebar draws from, many times a frame. In a draft, or a state still
 * changing, a new array.
 */
export function childrenShared(state: Nodes, chordId: ChordId, section: Section, parentId: NodeId | null = null): readonly SidebarNode[] {
  const view = viewOf(state);
  if (view && !view.changes) return sortedOf(groupIn(view.groups, chordId, section, parentId));
  return childrenToRead(state, chordId, section, parentId);
}

/** Children of a parent (a folder or a split, or the section's root) in one section of a chord, in sidebar order. In a draft, drafts. */
export function children(state: State, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  const found = childrenToRead(state, chordId, section, parentId);
  return isDraft(state.nodes) ? found.map((n) => nodeOf(state, n.id)!) : found;
}

/**
 * A chord's children by parent, for walking its tree: children of
 * `parentId` in `section`, in order, to read. Worked out once (a draft's
 * changes, or one pass over the nodes), however many parents are asked for.
 */
export function childrenIndex(state: Nodes, chordId: ChordId): (section: Section, parentId: NodeId | null) => SidebarNode[] {
  const view: View = viewOf(state) ?? { groups: group(nodeList(state), chordId), splits: new Set(), changes: null };
  return (section, parentId) => childrenIn(view, chordId, section, parentId);
}

/**
 * Every node of a chord, to read (in a draft, drafts for the ones changed),
 * in no order: from the index, not a pass over every node.
 */
export function nodesOfChord(state: Nodes, chordId: ChordId): SidebarNode[] {
  const view = viewOf(state);
  if (!view) return nodeList(state).filter((n) => n.chordId === chordId);
  const out: SidebarNode[] = [];
  const changes = view.changes;
  for (const [section, parents] of view.groups.get(chordId) ?? []) {
    for (const [parentId, found] of parents) {
      const gone = changes?.gone.get(`${chordId}\0${section}\0${parentId ?? ''}`);
      for (const n of found.nodes) if (!gone?.has(n)) out.push(n);
    }
  }
  if (changes) for (const [at, list] of changes.came) if (at.startsWith(`${chordId}\0`)) out.push(...list);
  return out;
}

/**
 * Every split, to read (in a draft, drafts for the ones changed), and what's
 * in one: every node whose parent it is, in any chord or section (old or
 * damaged data can put another chord's tab in a split), in no order. From
 * the index, not a pass over every node: splits settle after most changes (split.ts).
 */
export function splitsWithPanes(state: Nodes): { splits: SidebarNode[]; inside: (splitId: NodeId) => SidebarNode[] } {
  const view = viewOf(state);
  if (!view) {
    const all = nodeList(state);
    const under = new Map<NodeId, SidebarNode[]>();
    for (const n of all) {
      if (n.parentId === null) continue;
      const list = under.get(n.parentId);
      if (list) list.push(n);
      else under.set(n.parentId, [n]);
    }
    return { splits: all.filter((n) => n.kind === 'split'), inside: (id) => under.get(id) ?? [] };
  }
  const changes = view.changes;
  const splits = [...view.splits].filter((n) => !changes?.goneSplits.has(n));
  if (changes) splits.push(...changes.cameSplits);
  const inside = (id: NodeId): SidebarNode[] => {
    const out: SidebarNode[] = [];
    for (const [chordId, sections] of view.groups) {
      for (const [section, parents] of sections) {
        const found = parents.get(id);
        if (!found) continue;
        const gone = changes?.gone.get(`${chordId}\0${section}\0${id}`);
        for (const n of found.nodes) if (!gone?.has(n)) out.push(n);
      }
    }
    if (changes) out.push(...(changes.cameUnder.get(id) ?? []));
    return out;
  };
  return { splits, inside };
}
