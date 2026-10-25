/**
 * Sharing (ARCHITECTURE.md §9): which tabs a page may share through Chord's
 * picker. Main supplies which tabs have a page; these are the rules that
 * don't need one.
 */
import { isPrivateChord } from './select';
import type { NodeId, State, TabNode } from './model';

/** The most tabs the picker lists; the rest are older than anyone would look for. */
export const MAX_SHAREABLE_TABS = 50;

/**
 * The tabs the page in `askingId` may share, the asking tab first, then the
 * most recently used: web pages with a page loaded (`loaded`), never Chord's
 * own. A private window's page sees only its own window's tabs, and no other
 * page ever sees a private window's.
 */
export function shareableTabs(state: State, askingId: NodeId, loaded: Iterable<NodeId>): TabNode[] {
  const asking = state.nodes[askingId];
  if (asking?.kind !== 'tab') return [];
  const privately = isPrivateChord(state, asking.chordId);
  const out: TabNode[] = [];
  for (const id of loaded) {
    const node = state.nodes[id];
    if (node?.kind !== 'tab' || !/^(https?|file):/i.test(node.url)) continue;
    if (privately ? node.chordId !== asking.chordId : isPrivateChord(state, node.chordId)) continue;
    out.push(node);
  }
  return out
    .sort((a, b) => Number(b.id === askingId) - Number(a.id === askingId) || b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_SHAREABLE_TABS);
}
