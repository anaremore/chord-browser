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

/** A node by ID. In a draft, a draft of it, to change. */
export function nodeOf<S extends HasNodes>(state: S, id: NodeId): NodeIn<S> | undefined {
  return (state.nodes as NodeBuckets)[bucketOf(id)]?.[id] as NodeIn<S> | undefined;
}

/** Whether there's a node with this ID. */
export const hasNode = (state: HasNodes, id: NodeId): boolean => nodeOf(state, id) !== undefined;

/** Put a node in (or in place of the one with its ID). */
export function setNode<S extends HasNodes>(state: S, node: SidebarNode): NodeIn<S> {
  const key = bucketOf(node.id);
  const nodes = state.nodes as NodeBuckets;
  const bucket = (nodes[key] ??= {});
  bucket[node.id] = node;
  return bucket[node.id] as NodeIn<S>;
}

/** Take a node out. */
export function deleteNode(state: HasNodes, id: NodeId): void {
  const bucket = (state.nodes as NodeBuckets)[bucketOf(id)];
  if (bucket && id in bucket) delete bucket[id];
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

/** Where a node goes in the groups. */
const keyOf = (n: SidebarNode) => `${n.chordId}\0${n.section}\0${n.parentId ?? ''}`;

/** Which nodes changed between two versions of the nodes, by identity, bucket by bucket: what left, and what came. */
interface Diff {
  /** By where they were (`keyOf`). */
  gone: Map<string, Set<SidebarNode>>;
  /** By where they are. */
  came: Map<string, SidebarNode[]>;
}

/**
 * How `now` differs from `was`, over the buckets that aren't the same object
 * (`now` may be a draft's own copy, its buckets drafts); null when more than
 * `limit` buckets differ, so building afresh is about as cheap.
 */
function diff(was: NodeBuckets, now: NodeBuckets, limit: number): Diff | null {
  const changed: BucketKey[] = [];
  for (const key in now) if (now[key as BucketKey] !== was[key as BucketKey]) changed.push(key as BucketKey);
  for (const key in was) if (!(key in now)) changed.push(key as BucketKey);
  if (changed.length > limit) return null;
  const gone = new Map<string, Set<SidebarNode>>();
  const came = new Map<string, SidebarNode[]>();
  for (const key of changed) {
    const before = was[key] ?? {};
    const after = now[key] ? ownOf(now[key]) : {};
    for (const id in before) {
      const old = before[id]!;
      if (after[id] === old) continue;
      const at = keyOf(old);
      const set = gone.get(at);
      if (set) set.add(old);
      else gone.set(at, new Set([old]));
    }
    for (const id in after) {
      const node = after[id]!;
      if (before[id] === node) continue;
      const at = keyOf(node);
      const list = came.get(at);
      if (list) list.push(node);
      else came.set(at, [node]);
    }
  }
  return { gone, came };
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

/** `groups` with a diff applied, copying only the maps and groups it touches. */
function applyDiff(groups: Groups, { gone, came }: Diff): Groups {
  const next: Groups = new Map(groups);
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
  return next;
}

/** A frozen state's groups, kept for as long as its `nodes` is around. */
const frozenGroups = new WeakMap<object, Groups>();
/** The last frozen nodes indexed: the next state is most likely made from it, so its index is this one put right. */
let lastIndexed: { nodes: NodeBuckets; groups: Groups } | null = null;

/** More buckets changed than this, and a state is indexed afresh. */
const DIFF_LIMIT = NODE_BUCKETS / 2;

/** Whether nodes are done changing: the buckets object and every bucket frozen (Immer freezes them all). */
function isDone(nodes: NodeBuckets): boolean {
  if (!Object.isFrozen(nodes)) return false;
  for (const key in nodes) if (!Object.isFrozen(nodes[key as BucketKey])) return false;
  return true;
}

/** The groups of nodes that are done (frozen), cached; null for ones that can still change (a draft too). */
function groupsOfNodes(nodes: NodeBuckets): Groups | null {
  const known = frozenGroups.get(nodes);
  if (known) {
    if (lastIndexed?.nodes !== nodes) lastIndexed = { nodes, groups: known };
    return known;
  }
  if (isDraft(nodes) || !isDone(nodes)) return null;
  const changes = lastIndexed ? diff(lastIndexed.nodes, nodes, DIFF_LIMIT) : null;
  const groups = changes ? applyDiff(lastIndexed!.groups, changes) : group(nodeList({ nodes }));
  frozenGroups.set(nodes, groups);
  lastIndexed = { nodes, groups };
  return groups;
}

/**
 * How to read children in a state: its own groups when it's done; in a
 * draft, its base's groups with the draft's changes laid over them; null
 * when neither can be had (a state still being changed by hand, or Immer's
 * production build), and every node must be read.
 */
interface View {
  groups: Groups;
  changes: Diff | null;
}

function viewOf(state: Nodes): View | null {
  const nodes = state.nodes;
  if (isDraft(nodes)) {
    const draft = draftStateOf(nodes);
    if (!draft?.base_) return null;
    const groups = groupsOfNodes(draft.base_);
    if (!groups) return null;
    return { groups, changes: draft.copy_ ? diff(draft.base_, draft.copy_, Infinity) : null };
  }
  const groups = groupsOfNodes(nodes);
  return groups ? { groups, changes: null } : null;
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
  if (came) {
    kept.push(...came);
    kept.sort(byRank);
  }
  return kept;
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
  const view = viewOf(state) ?? { groups: group(nodeList(state), chordId), changes: null };
  return (section, parentId) => childrenIn(view, chordId, section, parentId);
}
