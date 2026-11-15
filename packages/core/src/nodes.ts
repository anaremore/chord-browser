/**
 * The sidebar tree's one primitive: a parent's children, in order.
 *
 * Fast on a very large profile (ARCHITECTURE.md §6.1, *Large profiles*):
 * - In the reducer, `state` is an Immer draft, and reading every value of a
 *   draft makes a draft of each, which Immer then has to finalize: with 5,000
 *   pinned tabs one close took 1.4 s. These read the draft's own copy instead
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

/** Children by chord, section and parent (null: the section's root), each list sorted when first asked for. */
type Groups = Map<ChordId, Map<Section, Map<NodeId | null, { nodes: SidebarNode[]; sorted: boolean }>>>;

/** One pass over `nodes` (only `chordId`'s, when given). */
function group(nodes: readonly SidebarNode[], chordId?: ChordId): Groups {
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

function sortedIn(groups: Groups, chordId: ChordId, section: Section, parentId: NodeId | null): SidebarNode[] {
  const found = groups.get(chordId)?.get(section)?.get(parentId);
  if (!found) return [];
  if (!found.sorted) {
    found.nodes.sort(byRank);
    found.sorted = true;
  }
  return found.nodes.slice();
}

/** A frozen state's groups, kept for as long as its `nodes` is around. */
const frozenGroups = new WeakMap<object, Groups>();

/** The groups of a state that's done, from one pass when first asked; null for one that can still change (a draft too). */
function groupsOf(state: Pick<State, 'nodes'>): Groups | null {
  if (!Object.isFrozen(state.nodes)) return null;
  let found = frozenGroups.get(state.nodes);
  if (!found) frozenGroups.set(state.nodes, (found = group(Object.values(state.nodes))));
  return found;
}

/**
 * Children of a parent (a folder or a split, or the section's root) in one
 * section of a chord, in sidebar order, to read: in a draft, frozen
 * originals for the ones not changed yet. A new array each time.
 */
export function childrenToRead(state: Pick<State, 'nodes'>, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  const groups = groupsOf(state);
  if (groups) return sortedIn(groups, chordId, section, parentId);
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
 * A chord's children by parent, from one pass, for walking its tree:
 * children of `parentId` in `section`, in order, to read.
 */
export function childrenIndex(state: Pick<State, 'nodes'>, chordId: ChordId): (section: Section, parentId: NodeId | null) => SidebarNode[] {
  const groups = groupsOf(state) ?? group(nodeList(state), chordId);
  return (section, parentId) => sortedIn(groups, chordId, section, parentId);
}
