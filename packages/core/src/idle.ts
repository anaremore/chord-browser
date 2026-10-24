/**
 * Tidying up after idle tabs (ARCHITECTURE.md §7, §9): Today tabs you haven't
 * used in a while go to the archive, and background tabs free their memory by
 * sleeping. Pure: main supplies the clock and what the engine knows (which
 * tabs are playing, sharing, or in picture-in-picture).
 */
import type { ArchiveAfter, NodeId, State, TabNode } from './model';
import { shownTabs } from './split';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long each "Archive tabs after" choice lets a Today tab sit unused; null never archives. */
export const ARCHIVE_AFTER_MS: Record<ArchiveAfter, number | null> = {
  '12h': 12 * HOUR_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  never: null,
};

/** Background tabs hidden this long go to sleep. */
export const SLEEP_AFTER_MS = HOUR_MS;

/** How often main looks for tabs to archive or put to sleep (and on wake from system sleep). */
export const IDLE_CHECK_MS = 5 * 60_000;

/** When the computer is low on memory, background tabs hidden this long go to sleep instead. */
export const PRESSURE_SLEEP_AFTER_MS = 5 * 60_000;

/** How often main asks the OS how much memory is free (a cheap call). */
export const MEMORY_CHECK_MS = 30_000;

/** Archived tabs are kept this long. */
export const ARCHIVE_KEEP_MS = 30 * DAY_MS;

/** Chord's own pages, which run on Chord's UI session rather than as web pages. */
export const isInternalUrl = (url: string) => /^chord:\/\//i.test(url);

/** The archive page's address. */
export const ARCHIVE_URL = 'chord://archive/';

/** Tabs on screen in any window (every pane of a split shown): never archived or slept. */
export function visibleTabs(state: State): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const win of Object.values(state.windows)) for (const id of shownTabs(state, win.id)) out.add(id);
  return out;
}

/**
 * Today tabs unused for at least `afterMs`, oldest first. Pinned tabs never
 * go, nor does a private window's tab (nothing of it is kept), nor a split's
 * pane (you put it there on purpose); nor do tabs on screen, or ones the
 * engine says are busy (`busy`: playing, sharing the camera or screen, being
 * shared, in picture-in-picture).
 */
export function archiveCandidates(state: State, now: number, afterMs: number | null, busy: ReadonlySet<NodeId> = new Set()): NodeId[] {
  if (afterMs === null) return [];
  const visible = visibleTabs(state);
  return Object.values(state.nodes)
    .filter((n): n is TabNode => n.kind === 'tab' && n.section === 'today' && !state.chords[n.chordId]?.private)
    .filter((t) => !(t.parentId && state.nodes[t.parentId]?.kind === 'split'))
    .filter((t) => !visible.has(t.id) && !busy.has(t.id) && now - t.lastActiveAt >= afterMs)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    .map((t) => t.id);
}

/**
 * Loaded tabs (pinned or Today) hidden for at least `afterMs`, under the same
 * rules. Chord's own pages are cheap and keep no history worth restoring, so
 * they sleep like any other.
 */
export function sleepCandidates(state: State, now: number, afterMs: number, loaded: Iterable<NodeId>, busy: ReadonlySet<NodeId> = new Set()): NodeId[] {
  const visible = visibleTabs(state);
  const out: NodeId[] = [];
  for (const id of loaded) {
    const node = state.nodes[id];
    if (node?.kind !== 'tab' || visible.has(id) || busy.has(id)) continue;
    if (now - node.lastActiveAt >= afterMs) out.push(id);
  }
  return out;
}
