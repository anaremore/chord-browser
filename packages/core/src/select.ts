/** Read-only queries over State, shared by main and renderers. */
import type { Chord, ChordId, Download, Favorite, NodeId, Section, SidebarNode, State, TabNode, WindowId } from './model';
import { placeKey } from './rank';

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

/** Everything inside a folder, at any depth, parents before their children. */
export function descendants(state: State, folderId: NodeId): SidebarNode[] {
  const folder = state.nodes[folderId];
  if (folder?.kind !== 'folder') return [];
  const out: SidebarNode[] = [];
  const walk = (parentId: NodeId) => {
    for (const node of children(state, folder.chordId, folder.section, parentId)) {
      out.push(node);
      if (node.kind === 'folder') walk(node.id);
    }
  };
  walk(folderId);
  return out;
}

/** How deep a node sits: 0 at a section's root, 1 inside one folder, and so on. */
export function depthOf(state: State, nodeId: NodeId): number {
  let depth = 0;
  let parentId = state.nodes[nodeId]?.parentId ?? null;
  // The loop guard keeps a damaged tree (a cycle) from hanging.
  while (parentId && depth < 64) {
    depth++;
    parentId = state.nodes[parentId]?.parentId ?? null;
  }
  return depth;
}

/** Whether `nodeId` is `ancestorId` or somewhere inside it. */
export function isWithin(state: State, nodeId: NodeId, ancestorId: NodeId): boolean {
  let current: NodeId | null = nodeId;
  for (let guard = 0; current && guard < 64; guard++) {
    if (current === ancestorId) return true;
    current = state.nodes[current]?.parentId ?? null;
  }
  return false;
}

/** The Favorites row in order. */
export function sortedFavorites(state: State): Favorite[] {
  return Object.values(state.favorites).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * The tab in a chord that a favorite should switch to instead of opening its
 * page again: one on the very same page, else the most recently used one on
 * the same site.
 */
export function tabForFavorite(state: State, chordId: ChordId, url: string): TabNode | null {
  const tabs = Object.values(state.nodes).filter((n): n is TabNode => n.kind === 'tab' && n.chordId === chordId);
  const place = placeKey(url);
  const same = place ? tabs.filter((t) => placeKey(t.url) === place) : [];
  const host = siteOf(url);
  const pool = same.length > 0 ? same : host ? tabs.filter((t) => siteOf(t.url) === host) : [];
  return pool.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
}

/** The host (and port) a web address is on, without "www.". */
function siteOf(url: string): string | null {
  return placeKey(url)?.split(/[/?]/, 1)[0] ?? null;
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
