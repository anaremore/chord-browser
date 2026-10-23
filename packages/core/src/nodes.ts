/** The sidebar tree's one primitive: a parent's children, in order. */
import type { ChordId, NodeId, Section, SidebarNode, State } from './model';

/** Rank order; ties (possible after reopening a closed tab) fall back to ID, which is time-ordered. */
const byRank = (a: SidebarNode, b: SidebarNode) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Children of a parent (a folder or a split, or the section's root) in one section of a chord, in sidebar order. */
export function children(state: State, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  return Object.values(state.nodes)
    .filter((n) => n.chordId === chordId && n.section === section && n.parentId === parentId)
    .sort(byRank);
}
