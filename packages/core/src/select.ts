/** Read-only queries over State, shared by main and renderers. */
import type { ChordId, NodeId, Section, SidebarNode, State, TabNode, WindowId } from './model';

/** Rank order; ties (possible after reopening a closed tab) fall back to ID, which is time-ordered. */
const byRank = (a: SidebarNode, b: SidebarNode) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Children of a parent in one section of a chord, in sidebar order. */
export function children(state: State, chordId: ChordId, section: Section, parentId: NodeId | null = null): SidebarNode[] {
  return Object.values(state.nodes)
    .filter((n) => n.chordId === chordId && n.section === section && n.parentId === parentId)
    .sort(byRank);
}

/** Every tab of a chord in visual order: pinned (depth-first through folders), then Today. */
export function tabsInOrder(state: State, chordId: ChordId): TabNode[] {
  const out: TabNode[] = [];
  const walk = (section: Section, parentId: NodeId | null) => {
    for (const node of children(state, chordId, section, parentId)) {
      if (node.kind === 'tab') out.push(node);
      else if (!node.collapsed) walk(section, node.id);
    }
  };
  walk('pinned', null);
  walk('today', null);
  return out;
}

export function sortedChords(state: State) {
  return Object.values(state.chords).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
}

export function activeTabId(state: State, windowId: WindowId): NodeId | null {
  const win = state.windows[windowId];
  if (!win) return null;
  return win.activeTab[win.activeChordId] ?? null;
}

export function activeTab(state: State, windowId: WindowId): TabNode | null {
  const id = activeTabId(state, windowId);
  const node = id ? state.nodes[id] : undefined;
  return node?.kind === 'tab' ? node : null;
}

/** Which windows currently show this tab. */
export function windowsShowing(state: State, nodeId: NodeId): WindowId[] {
  return Object.values(state.windows)
    .filter((w) => w.activeTab[w.activeChordId] === nodeId)
    .map((w) => w.id);
}
