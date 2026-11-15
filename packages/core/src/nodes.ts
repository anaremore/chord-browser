/**
 * The sidebar tree's one primitive: a parent's children, in order.
 *
 * Fast on a very large profile (ARCHITECTURE.md §6.1, *Large profiles*):
 * - In the reducer, `state` is an Immer draft, and reading every value of a
 *   draft makes a draft of each, which Immer then has to finalize: with 5,000
 *   pinned tabs one close took 1.5 s. These read the draft's own copy instead
 *   (`nodeList`), where nodes already changed are drafts and the rest are
 *   as they were, and hand out drafts only for what they return.
 * - A state that's done (frozen) never changes, so its children are found in
 *   one pass over its nodes, kept for as long as the state is around.
 */
import { isDraft } from 'immer';
import type { ChordId, NodeId, Section, SidebarNode, State } from './model';

/** Rank order; ties (possible after reopening a closed tab) fall back to ID, which is time-ordered. */
export const byRank = (a: SidebarNode, b: SidebarNode): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Immer's own key for a draft's state (a global symbol, so every copy of Immer shares it). */
const DRAFT_STATE = Symbol.for('immer-state');

interface DraftState<T> {
  base_: T;
  copy_: T | null;
}

/**
 * A record's values as they are now, to read: in a draft, without making a
 * draft of each. Values already changed in the draft are drafts; the others
 * are the frozen originals, so change one through `record[id]`, never this.
 */
export function valuesOf<T>(record: Readonly<Record<string, T>>): T[] {
  const draft = (record as { [DRAFT_STATE]?: DraftState<Record<string, T>> })[DRAFT_STATE];
  return Object.values(draft ? (draft.copy_ ?? draft.base_) : record);
}

/** Every node, to read (see `valuesOf`): change one through `state.nodes[id]`. */
export const nodeList = (state: Pick<State, 'nodes'>): SidebarNode[] => valuesOf(state.nodes);

const groupKey = (chordId: ChordId, section: Section, parentId: NodeId | null) => `${chordId}\u0000${section}\u0000${parentId ?? ''}`;

/** A frozen state's children by parent, sorted when first asked for. */
const groups = new WeakMap<object, Map<string, { nodes: SidebarNode[]; sorted: boolean }>>();

function groupsOf(nodes: Record<NodeId, SidebarNode>): Map<string, { nodes: SidebarNode[]; sorted: boolean }> {
  let found = groups.get(nodes);
  if (!found) {
    found = new Map();
    for (const node of Object.values(nodes)) {
      const key = groupKey(node.chordId, node.section, node.parentId);
      const group = found.get(key);
      if (group) group.nodes.push(node);
      else found.set(key, { nodes: [node], sorted: false });
    }
    groups.set(nodes, found);
  }
  return found;
}

/**
 * Children of a parent (a folder or a split, or the section's root) in one
 * section of a chord, in sidebar order, to read: in a draft, frozen
 * originals for the ones not changed yet. A new array each time.
 */
export function childrenToRead(state: Pick<State, 'nodes'>, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  if (Object.isFrozen(state.nodes)) {
    const group = groupsOf(state.nodes).get(groupKey(chordId, section, parentId));
    if (!group) return [];
    if (!group.sorted) {
      group.nodes.sort(byRank);
      group.sorted = true;
    }
    return group.nodes.slice();
  }
  return nodeList(state)
    .filter((n) => n.chordId === chordId && n.section === section && n.parentId === parentId)
    .sort(byRank);
}

/** Children of a parent (a folder or a split, or the section's root) in one section of a chord, in sidebar order. In a draft, drafts. */
export function children(state: State, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  const found = childrenToRead(state, chordId, section, parentId);
  return isDraft(state.nodes) ? found.map((n) => state.nodes[n.id]!) : found;
}

/**
 * Every node of a chord grouped by parent, from one pass, for walking its
 * tree: children of `parentId` in `section` (sorted when asked), to read.
 */
export function childrenIndex(state: Pick<State, 'nodes'>, chordId: ChordId): (section: Section, parentId: NodeId | null) => SidebarNode[] {
  if (Object.isFrozen(state.nodes)) return (section, parentId) => childrenToRead(state, chordId, section, parentId);
  const index = new Map<string, SidebarNode[]>();
  for (const node of nodeList(state)) {
    if (node.chordId !== chordId) continue;
    const key = groupKey(chordId, node.section, node.parentId);
    const list = index.get(key);
    if (list) list.push(node);
    else index.set(key, [node]);
  }
  return (section, parentId) => (index.get(groupKey(chordId, section, parentId)) ?? []).slice().sort(byRank);
}
