/**
 * What the command bar shows for a query (DESIGN.md §7.3, ARCHITECTURE.md §10):
 * the address or search for the text, open tabs in every chord, history,
 * other chords and actions, ranked by the signals in core/rank.ts (from
 * Crest): how well the text matches, how often and recently a page was used,
 * whether a tab is pinned, and what was picked before for the same text.
 */
import {
  abbreviationScore,
  habit,
  learnedPoints,
  matchScore,
  parseInput,
  placeKey,
  prefixes,
  recencyPoints,
  searchEngine,
  searchUrl,
  sortedChords,
  usagePoints,
  type ActionId,
  type Chord,
  type State,
  type TabNode,
} from '@chord/core';
import type { HistorySearch } from '@chord/ipc';
import { displayHost, pageTitle } from '../shared/site';

export type Result =
  | { kind: 'open'; key: string; title: string; detail: string; url: string; search: boolean }
  | { kind: 'tab'; key: string; title: string; detail: string; tab: TabNode; chordName: string | null }
  | { kind: 'history'; key: string; title: string; detail: string; url: string }
  | { kind: 'action'; key: string; title: string; action: ActionId }
  | { kind: 'chord'; key: string; title: string; chord: Chord };

/** Actions that work in this milestone; the list grows with each feature. */
const ACTIONS: { action: ActionId; title: string; words: string }[] = [
  { action: 'tab.reopen', title: 'Reopen closed tab', words: 'reopen closed tab undo restore' },
  { action: 'tab.close', title: 'Close tab', words: 'close tab' },
  { action: 'tab.pin', title: 'Pin or unpin tab', words: 'pin unpin tab keep' },
  { action: 'address.copy', title: 'Copy page address', words: 'copy url address link' },
  { action: 'address.copyMarkdown', title: 'Copy as Markdown link', words: 'copy markdown link md' },
  { action: 'tab.next', title: 'Next tab', words: 'next tab down' },
  { action: 'tab.previous', title: 'Previous tab', words: 'previous tab up' },
  { action: 'nav.hardReload', title: 'Reload, skipping the cache', words: 'hard reload refresh cache' },
  { action: 'view.toggleSidebar', title: 'Show or hide sidebar', words: 'toggle hide show collapse sidebar minimal' },
  { action: 'view.zoomIn', title: 'Zoom in', words: 'zoom in bigger larger' },
  { action: 'view.zoomOut', title: 'Zoom out', words: 'zoom out smaller' },
  { action: 'view.zoomReset', title: 'Actual size', words: 'zoom reset actual size 100' },
  { action: 'view.fullscreen', title: 'Full screen', words: 'full screen fullscreen' },
  { action: 'view.find', title: 'Find in page', words: 'find search in page text' },
  { action: 'page.print', title: 'Print', words: 'print pdf' },
  { action: 'page.viewSource', title: 'View page source', words: 'view source html code' },
  { action: 'app.devtools', title: 'Developer tools', words: 'developer tools devtools inspect console' },
  { action: 'chord.delete', title: 'Delete this chord', words: 'delete remove chord space' },
  { action: 'app.settings', title: 'Settings', words: 'settings preferences options' },
  { action: 'app.shortcuts', title: 'Keyboard shortcuts', words: 'keyboard shortcuts hotkeys keys cheat sheet' },
];

/** The most rows of each kind, and in all. */
const LIMIT = { tab: 5, history: 6, chord: 3, action: 3 } as const;
const MAX_ROWS = 12;
/** An open tab scores above the same match in history; a pinned one above that (Crest's signals). */
const OPEN_TAB_POINTS = 150;
const KEPT_POINTS = 100;
/** Only a page used this much may lead with a prefix match, ahead of the typed address or search. */
const LEADS_AT_USAGE = 120;
const LEADS_AT_RECENCY = 100;

const tabTitle = (t: TabNode) => pageTitle(t) || displayHost(t.url) || 'New tab';

/** "github.com/anaremore/chord-browser": the address without scheme or `www.`. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : decodeURIComponent(u.pathname);
    return `${u.host.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

/** Where a row leads, as learned picks remember it: a page's place, a chord, an action. Searches aren't remembered. */
export function destinationOf(result: Result): string | null {
  switch (result.kind) {
    case 'open':
      return result.search ? null : placeKey(result.url);
    case 'tab':
      return placeKey(result.tab.url) ?? `tab:${result.tab.id}`;
    case 'history':
      return placeKey(result.url);
    case 'chord':
      return `chord:${result.chord.id}`;
    case 'action':
      return `action:${result.action}`;
  }
}

interface Scored {
  result: Result;
  kind: keyof typeof LIMIT;
  score: number;
  mayLead: boolean;
}

export function buildResults(
  query: string,
  state: State,
  windowId: string,
  mode: 'new' | 'edit',
  history: HistorySearch | null = null,
  now = Date.now(),
): Result[] {
  const q = query.trim();
  const win = state.windows[windowId];
  const activeId = win ? win.activeTab[win.activeChordId] : null;
  const tabs = Object.values(state.nodes).filter((n): n is TabNode => n.kind === 'tab');
  const chordName = (t: TabNode) => (win && t.chordId !== win.activeChordId ? (state.chords[t.chordId]?.name ?? null) : null);
  const tabResult = (t: TabNode): Result => ({
    kind: 'tab',
    key: `tab:${t.id}`,
    title: tabTitle(t),
    detail: displayHost(t.url),
    tab: t,
    chordName: chordName(t),
  });

  if (!q) {
    if (mode === 'edit') return [];
    // Nothing typed yet: recently used tabs, most recent first.
    return tabs
      .filter((t) => t.id !== activeId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 6)
      .map(tabResult);
  }

  const parsed = parseInput(q);
  let intent: Result | null = null;
  if (parsed?.kind === 'url') {
    intent = { kind: 'open', key: 'open', title: parsed.url, detail: '', url: parsed.url, search: false };
  } else if (parsed) {
    const engine = state.settings.searchEngine;
    intent = { kind: 'open', key: 'open', title: q, detail: `Search ${searchEngine(engine).name}`, url: searchUrl(parsed.query, engine), search: true };
  }

  const choices = history?.choices ?? [];
  const learned = (result: Result) => {
    const destination = destinationOf(result);
    return destination ? learnedPoints(choices, q, destination, now) : 0;
  };
  const scored: Scored[] = [];

  // Open tabs, in every chord. In edit mode the query starts as the current address; don't echo it.
  const claimed = new Set<string>();
  for (const t of tabs) {
    const place = placeKey(t.url);
    if (place) claimed.add(place);
    if (mode === 'edit' && t.id === activeId) continue;
    const title = tabTitle(t);
    const match = matchScore(q, title, shortUrl(t.url)) ?? abbreviationScore(q, title);
    if (match === null) continue;
    const result = tabResult(t);
    const recency = recencyPoints(t.lastActiveAt, now);
    const kept = t.section === 'pinned' ? KEPT_POINTS : 0;
    scored.push({
      result,
      kind: 'tab',
      score: match + OPEN_TAB_POINTS + recency + kept + learned(result),
      mayLead: (prefixes(q, title) || prefixes(q, shortUrl(t.url))) && (recency >= LEADS_AT_RECENCY || kept > 0),
    });
  }

  // History: one row per place, never one that's open as a tab or that the text itself opens.
  if (intent && !intent.search) {
    const place = placeKey(intent.url);
    if (place) claimed.add(place);
  }
  for (const h of history?.history ?? []) {
    const place = placeKey(h.url);
    if (!place || claimed.has(place)) continue;
    claimed.add(place);
    const title = h.title || shortUrl(h.url);
    const match = matchScore(q, title, shortUrl(h.url));
    if (match === null) continue;
    const result: Result = { kind: 'history', key: `history:${place}`, title, detail: shortUrl(h.url), url: h.url };
    const usage = usagePoints(h.frecency);
    scored.push({
      result,
      kind: 'history',
      score: match + usage + learned(result),
      mayLead: (prefixes(q, title) || prefixes(q, shortUrl(h.url))) && usage >= LEADS_AT_USAGE,
    });
  }

  // Other chords by name: how to switch when the sidebar is hidden.
  for (const chord of sortedChords(state)) {
    if (chord.id === win?.activeChordId) continue;
    const match = matchScore(q, chord.name) ?? abbreviationScore(q, chord.name);
    if (match === null) continue;
    const result: Result = { kind: 'chord', key: `chord:${chord.id}`, title: chord.name, chord };
    scored.push({ result, kind: 'chord', score: match + learned(result), mayLead: false });
  }

  for (const a of ACTIONS) {
    const match = matchScore(q, a.title, a.words) ?? abbreviationScore(q, a.title);
    if (match === null) continue;
    const result: Result = { kind: 'action', key: `action:${a.action}`, title: a.title, action: a.action };
    scored.push({ result, kind: 'action', score: match + learned(result), mayLead: false });
  }

  // Each kind keeps its best few; then everything blends, best first.
  const kept = (Object.keys(LIMIT) as (keyof typeof LIMIT)[]).flatMap((kind) =>
    scored
      .filter((s) => s.kind === kind)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT[kind]),
  );
  kept.sort((a, b) => b.score - a.score);

  // What leads (Return runs it): a habit for this exact text, else a well-used page the text starts.
  // A typed address leads over a page only by habit.
  const habitual = habit(choices, q, now);
  const lead =
    (habitual ? kept.find((s) => destinationOf(s.result) === habitual) : undefined) ??
    (parsed?.kind === 'url' ? undefined : kept.find((s) => s.mayLead));
  const rest = kept.filter((s) => s !== lead).map((s) => s.result);
  return [...(lead ? [lead.result] : []), ...(intent ? [intent] : []), ...rest].slice(0, MAX_ROWS);
}
