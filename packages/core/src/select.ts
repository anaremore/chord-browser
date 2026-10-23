/** Read-only queries over State, shared by main and renderers. */
import type { Chord, ChordId, Download, NodeId, Section, SidebarNode, State, TabNode, WindowId } from './model';

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

/** Your chords in switcher order. A private window's own chord is never among them. */
export function sortedChords(state: State): Chord[] {
  return Object.values(state.chords)
    .filter((c) => !c.private)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
}

export const isPrivateWindow = (state: State, windowId: WindowId): boolean => Boolean(state.windows[windowId]?.private);
export const isPrivateChord = (state: State, chordId: ChordId): boolean => Boolean(state.chords[chordId]?.private);

/** The chords a window can see and switch between: a private window only its own. */
export function chordsFor(state: State, windowId: WindowId): Chord[] {
  const win = state.windows[windowId];
  if (win?.private) {
    const own = state.chords[win.activeChordId];
    return own ? [own] : [];
  }
  return sortedChords(state);
}

/** The downloads a window lists: a private window's own, or everything not from a private window. */
export function downloadsFor(state: State, windowId: WindowId): Download[] {
  const priv = isPrivateWindow(state, windowId);
  return Object.values(state.downloads).filter((d) => (priv ? d.privateWindow === windowId : !d.privateWindow));
}

/**
 * Where ⌘⇧T reopens from in this window: the newest closed tab on its side
 * (a private window's own, or none of any private window's). -1 if none.
 */
export function reopenableIndex(state: State, windowId: WindowId): number {
  const win = state.windows[windowId];
  if (!win) return -1;
  return state.closed.findIndex((c) => (win.private ? c.node.chordId === win.activeChordId : !isPrivateChord(state, c.node.chordId)));
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

/** Which windows currently show this tab (at most one: a tab shows in one window at a time). */
export function windowsShowing(state: State, nodeId: NodeId): WindowId[] {
  return Object.values(state.windows)
    .filter((w) => w.activeTab[w.activeChordId] === nodeId)
    .map((w) => w.id);
}
