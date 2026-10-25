/**
 * What the command bar shows for a query (DESIGN.md §7.3, ARCHITECTURE.md §10):
 * the address or search for the text, open tabs in every chord, archived tabs,
 * history, other chords and actions, ranked by the signals in core/rank.ts (from
 * Crest): how well the text matches, how often and recently a page was used,
 * whether a tab is pinned, and what was picked before for the same text.
 *
 * A scope narrows it: a site keyword (`yt`, then Tab) searches that site, and
 * a filter (`@tabs`, `@history`, …) shows only that kind. The engine's search
 * suggestions come last, so they never move the rows above them.
 */
import { type DuetHit,
  abbreviationScore,
  habit,
  keywordFor,
  keywordSearchUrl,
  learnedPoints,
  matchScore,
  parseInput,
  placeKey,
  prefixes,
  recencyPoints,
  searchEngine,
  searchUrl,
  shownTabs,
  chordsFor,
  activeTab,
  activeTabId,
  splitOf,
  usagePoints,
  type ActionId,
  type ArchivedTab,
  type Chord,
  type SiteKeyword,
  type State,
  type TabNode,
} from '@chord/core';
import type { HistorySearch } from '@chord/ipc';
import { displayHost, pageTitle } from '../shared/site';

export type Filter = 'tabs' | 'pinned' | 'history' | 'archive' | 'duet' | 'chords' | 'actions';
export type Scope = { kind: 'keyword'; keyword: SiteKeyword } | { kind: 'filter'; filter: Filter };

export type Result =
  /** The address or search the text spells; `suggested` when the engine offered it. */
  | { kind: 'open'; key: string; title: string; detail: string; url: string; search: boolean; suggested?: boolean }
  | { kind: 'tab'; key: string; title: string; detail: string; tab: TabNode; chordName: string | null }
  | { kind: 'history'; key: string; title: string; detail: string; url: string }
  /** A tab in the archive: picking it brings the tab back, history and all. */
  | { kind: 'archive'; key: string; title: string; detail: string; url: string; archiveId: string }
  /** A Duet chat whose words match (@duet): picking it opens the chat. */
  | { kind: 'duet'; key: string; title: string; detail: string; threadId: string; chordId: string }
  | { kind: 'action'; key: string; title: string; action: ActionId }
  | { kind: 'chord'; key: string; title: string; chord: Chord }
  /** A way to narrow the bar: search a site, or show one kind of result. */
  | { kind: 'scope'; key: string; title: string; detail: string; scope: Scope };

/** The narrowing filters (DESIGN.md §7.3), in the order `@` lists them. */
export const FILTERS: readonly { id: Filter; token: string; name: string; placeholder: string }[] = [
  { id: 'tabs', token: '@tabs', name: 'Tabs', placeholder: 'Search open tabs' },
  { id: 'pinned', token: '@pinned', name: 'Pinned', placeholder: 'Search pinned tabs' },
  { id: 'history', token: '@history', name: 'History', placeholder: 'Search history' },
  { id: 'archive', token: '@archive', name: 'Archive', placeholder: 'Search the archive' },
  { id: 'duet', token: '@duet', name: 'Duet chats', placeholder: 'Search Duet chats' },
  { id: 'chords', token: '@chords', name: 'Chords', placeholder: 'Search chords' },
  { id: 'actions', token: '@actions', name: 'Actions', placeholder: 'Search actions' },
];

export const filterInfo = (id: Filter) => FILTERS.find((f) => f.id === id)!;

/**
 * The scope the text switches to when Tab (or Space) follows it: a filter's
 * `@word`, or a site keyword. Only short abbreviations switch on Space.
 */
export function scopeFor(text: string, key: 'tab' | 'space'): Scope | null {
  const typed = text.trim().toLowerCase();
  const filter = FILTERS.find((f) => f.token === typed);
  if (filter) return { kind: 'filter', filter: filter.id };
  const keyword = keywordFor(typed);
  return keyword && (key === 'tab' || keyword.space) ? { kind: 'keyword', keyword } : null;
}

export function scopeLabel(scope: Scope): { name: string; placeholder: string } {
  if (scope.kind === 'keyword') return { name: scope.keyword.name, placeholder: `Search ${scope.keyword.name}` };
  const f = filterInfo(scope.filter);
  return { name: f.name, placeholder: f.placeholder };
}

/** Actions that work in this milestone; the list grows with each feature. */
/** The tab on screen is one of a split's panes. */
const inSplit = (state: State, windowId: string) => {
  const active = activeTabId(state, windowId);
  return active !== null && splitOf(state, active) !== null;
};

/** The tab on screen is a web page, muted (`true`) or not. */
const webTabMuted = (muted: boolean) => (state: State, windowId: string) => {
  const tab = activeTab(state, windowId);
  return tab !== null && /^https?:/i.test(tab.url) && Boolean(tab.muted) === muted;
};

/** Reader view for the tab on screen: offered while its page reads as an article (`false`), or left while it's open (`true`). */
const inReader = (on: boolean) => (state: State, windowId: string) => {
  const active = activeTabId(state, windowId);
  const live = active ? state.live[active] : undefined;
  return on ? Boolean(live?.reader) : Boolean(live?.readable && !live.reader);
};

/**
 * Every action the keyboard needs is here (DESIGN.md §14.1 rule 4). `when`:
 * shown only where it does something (Separate split tabs, in a split).
 */
const ACTIONS: { action: ActionId; title: string; words: string; when?: (state: State, windowId: string) => boolean }[] = [
  { action: 'tab.reopen', title: 'Reopen closed tab', words: 'reopen closed tab undo restore' },
  { action: 'app.history', title: 'Archive', words: 'archive archived history closed tabs' },
  { action: 'tab.close', title: 'Close tab', words: 'close tab' },
  { action: 'tab.pin', title: 'Pin or unpin tab', words: 'pin unpin tab keep' },
  // One of the two, for the tab on screen.
  { action: 'tab.mute', title: 'Mute tab', words: 'mute tab sound audio silence quiet volume', when: webTabMuted(false) },
  { action: 'tab.mute', title: 'Unmute tab', words: 'unmute tab sound audio volume', when: webTabMuted(true) },
  { action: 'tab.favorite', title: 'Add this tab to Favorites', words: 'add favorite favorites star bookmark tile' },
  { action: 'folder.new', title: 'New folder with this tab', words: 'new folder group organize pinned' },
  { action: 'today.clear', title: 'Clear Today', words: 'clear today archive tidy close all tabs' },
  { action: 'split.with', title: 'Split with…', words: 'split view side by side pane beside two tabs', when: (s, w) => activeTabId(s, w) !== null },
  { action: 'split.separate', title: 'Separate split tabs', words: 'separate split unsplit leave panes tabs apart', when: inSplit },
  { action: 'split.focusNext', title: 'Focus the pane to the right', words: 'split pane focus next right', when: inSplit },
  { action: 'split.focusPrevious', title: 'Focus the pane to the left', words: 'split pane focus previous left', when: inSplit },
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
  { action: 'view.reader', title: 'Show reader view', words: 'reader view mode read article text clean distraction', when: inReader(false) },
  { action: 'view.reader', title: 'Leave reader view', words: 'reader view leave exit close article page', when: inReader(true) },
  { action: 'page.print', title: 'Print', words: 'print pdf' },
  { action: 'page.viewSource', title: 'View page source', words: 'view source html code' },
  { action: 'app.devtools', title: 'Developer tools', words: 'developer tools devtools inspect console' },
  { action: 'chord.delete', title: 'Delete this chord', words: 'delete remove chord space' },
  { action: 'chord.separateSignIns', title: 'Keep sign-ins separate for this chord', words: 'sign ins separate accounts cookies profile login' },
  { action: 'app.settings', title: 'Settings', words: 'settings preferences options' },
  { action: 'app.shortcuts', title: 'Keyboard shortcuts', words: 'keyboard shortcuts hotkeys keys cheat sheet' },
];

/** The most rows of each kind, and in all. A filter shows more of its one kind. */
const LIMIT = { tab: 5, archive: 4, history: 6, chord: 3, action: 3 } as const;
const MAX_ROWS = 12;
/** A filter lists everything of its kind; the panel scrolls. */
const FILTER_ROWS = 50;
/** An open tab scores above the same match in history; a pinned one above that (Crest's signals). */
const OPEN_TAB_POINTS = 150;
const KEPT_POINTS = 100;
/** Only a page used this much may lead with a prefix match, ahead of the typed address or search. */
const LEADS_AT_USAGE = 120;
const LEADS_AT_RECENCY = 100;

const tabTitle = (t: TabNode) => pageTitle(t) || displayHost(t.url) || 'New tab';

const archiveResult = (a: ArchivedTab): Result => ({
  kind: 'archive',
  key: `archive:${a.id}`,
  title: a.title || shortUrl(a.url),
  detail: shortUrl(a.url),
  url: a.url,
  archiveId: a.id,
});

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

/** Where a row leads, as learned picks remember it: a page's place, a chord, an action. Searches and scopes aren't remembered. */
export function destinationOf(result: Result): string | null {
  switch (result.kind) {
    case 'open':
      return result.search ? null : placeKey(result.url);
    case 'tab':
      return placeKey(result.tab.url) ?? `tab:${result.tab.id}`;
    case 'history':
    case 'archive':
      return placeKey(result.url);
    case 'chord':
      return `chord:${result.chord.id}`;
    case 'action':
      return `action:${result.action}`;
    case 'scope':
    case 'duet':
      return null;
  }
}

/**
 * Inline autocomplete (DESIGN.md §7.3, ARCHITECTURE.md §10): when the row
 * that leads is a page whose address starts with what was typed, the rest of
 * that address, to show selected after the caret. Only the leading row
 * completes, so the field never shows one place while Return opens another.
 */
export function completionFor(typed: string, lead: Result | undefined): string {
  if (!typed || /\s/.test(typed) || typed.includes('://')) return '';
  if (lead?.kind !== 'tab' && lead?.kind !== 'history' && lead?.kind !== 'archive') return '';
  const place = placeKey(lead.kind === 'tab' ? lead.tab.url : lead.url);
  if (!place) return '';
  const lower = typed.toLowerCase();
  for (const address of [place, `www.${place}`]) {
    if (address.length > typed.length && address.toLowerCase().startsWith(lower)) return address.slice(typed.length);
  }
  return '';
}

interface Scored {
  result: Result;
  kind: keyof typeof LIMIT;
  score: number;
  mayLead: boolean;
}

export interface Narrowing {
  /** A site keyword or filter the person switched to. */
  scope?: Scope | null;
  /** The engine's suggestions for the text, newest reply. */
  suggestions?: readonly string[];
  /** Duet chats matching the text (@duet), newest reply. */
  duetHits?: readonly DuetHit[];
}

/**
 * The command bar's rows. In `split` mode ("Split with…", DESIGN.md §8.4)
 * only what can open beside the current tab: pages to open, and this
 * chord's other tabs that aren't on screen.
 */
export function buildResults(
  query: string,
  state: State,
  windowId: string,
  mode: 'new' | 'edit' | 'split',
  history: HistorySearch | null = null,
  now = Date.now(),
  narrowing: Narrowing = {},
): Result[] {
  const all = resultsFor(query, state, windowId, mode === 'split' ? 'new' : mode, history, now, narrowing);
  if (mode !== 'split') return all;
  const win = state.windows[windowId];
  const onScreen = new Set(shownTabs(state, windowId));
  return all.filter((r) => {
    if (r.kind === 'tab') return r.tab.chordId === win?.activeChordId && !onScreen.has(r.tab.id);
    return r.kind === 'open' || r.kind === 'history' || r.kind === 'scope';
  });
}

function resultsFor(
  query: string,
  state: State,
  windowId: string,
  mode: 'new' | 'edit',
  history: HistorySearch | null,
  now: number,
  { scope = null, suggestions = [], duetHits = [] }: Narrowing,
): Result[] {
  const q = query.trim();
  const win = state.windows[windowId];
  const activeId = win ? win.activeTab[win.activeChordId] : null;
  // Open tabs from the chords this window can see: a private window's own, or none of a private window's.
  const visibleChords = new Set(chordsFor(state, windowId).map((c) => c.id));
  const tabs = Object.values(state.nodes).filter((n): n is TabNode => n.kind === 'tab' && visibleChords.has(n.chordId));
  const chordName = (t: TabNode) => (win && t.chordId !== win.activeChordId ? (state.chords[t.chordId]?.name ?? null) : null);
  const tabResult = (t: TabNode): Result => ({
    kind: 'tab',
    key: `tab:${t.id}`,
    title: tabTitle(t),
    detail: displayHost(t.url),
    tab: t,
    chordName: chordName(t),
  });
  const engine = state.settings.searchEngine;
  const suggestionRows = (into: (text: string) => string): Result[] =>
    suggestions.map((text) => ({ kind: 'open', key: `suggest:${text}`, title: text, detail: '', url: into(text), search: true, suggested: true }));

  if (scope?.kind === 'filter' && scope.filter === 'duet') {
    return duetHits.map((h) => ({ kind: 'duet', key: `duet:${h.messageId}`, title: h.threadTitle || 'Duet chat', detail: h.snippet, threadId: h.threadId, chordId: h.chordId }));
  }
  if (scope?.kind === 'filter') return filtered(scope.filter, q, state, windowId, win?.activeChordId ?? null, activeId ?? null, tabs, tabResult, history, now);

  if (!q) {
    if (mode === 'edit' || scope) return [];
    // Nothing typed yet: recently used tabs, most recent first.
    return tabs
      .filter((t) => t.id !== activeId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 6)
      .map(tabResult);
  }

  // A site keyword: the site's search first, then pages on that site that match, then the engine's ideas.
  if (scope?.kind === 'keyword') {
    const k = scope.keyword;
    const onSite = (url: string) => placeKey(url)?.startsWith(k.place) ?? false;
    const intent: Result = { kind: 'open', key: 'open', title: q, detail: `Search ${k.name}`, url: keywordSearchUrl(k, q), search: true };
    const pages: Result[] = [
      ...tabs.filter((t) => onSite(t.url) && matchScore(q, tabTitle(t), shortUrl(t.url)) !== null).map(tabResult),
      ...(history?.archive ?? [])
        .filter((a) => onSite(a.url) && matchScore(q, a.title || shortUrl(a.url), shortUrl(a.url)) !== null)
        .map(archiveResult),
      ...(history?.history ?? [])
        .filter((h) => onSite(h.url) && matchScore(q, h.title || shortUrl(h.url), shortUrl(h.url)) !== null)
        .map((h): Result => ({ kind: 'history', key: `history:${placeKey(h.url)}`, title: h.title || shortUrl(h.url), detail: shortUrl(h.url), url: h.url })),
    ];
    const seen = new Set<string>();
    const unique = pages.filter((r) => {
      const place = destinationOf(r) ?? r.key;
      if (seen.has(place)) return false;
      seen.add(place);
      return true;
    });
    return [intent, ...unique.slice(0, MAX_ROWS - 1), ...(k.engine ? suggestionRows((text) => keywordSearchUrl(k, text)) : [])];
  }

  const parsed = parseInput(q);
  let intent: Result | null = null;
  if (parsed?.kind === 'url') {
    intent = { kind: 'open', key: 'open', title: parsed.url, detail: '', url: parsed.url, search: false };
  } else if (parsed) {
    intent = { kind: 'open', key: 'open', title: q, detail: `Search ${searchEngine(engine).name}`, url: searchUrl(parsed.query, engine), search: true };
  }

  // Ways to narrow: `@` lists the filters it could start; a keyword typed exactly offers its site.
  const filterOffers: Result[] =
    q.startsWith('@') && !/\s/.test(q)
      ? FILTERS.filter((f) => f.token.startsWith(q.toLowerCase())).map((f) => ({
          kind: 'scope',
          key: `scope:${f.token}`,
          title: f.placeholder,
          detail: f.token,
          scope: { kind: 'filter', filter: f.id },
        }))
      : [];
  const keyword = keywordFor(q);
  const keywordOffer: Result | null = keyword
    ? { kind: 'scope', key: `scope:${keyword.keyword}`, title: `Search ${keyword.name}`, detail: keyword.keyword, scope: { kind: 'keyword', keyword } }
    : null;

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
  // Archived tabs before history: the same page, but it comes back with its own back/forward
  // history. It ranks with the page's use, and recent archiving counts as recent use.
  const usageOf = new Map<string, number>();
  for (const h of history?.history ?? []) {
    const place = placeKey(h.url);
    if (place) usageOf.set(place, Math.max(usageOf.get(place) ?? 0, usagePoints(h.frecency)));
  }
  for (const a of history?.archive ?? []) {
    const place = placeKey(a.url);
    if (!place || claimed.has(place)) continue;
    claimed.add(place);
    const title = a.title || shortUrl(a.url);
    const match = matchScore(q, title, shortUrl(a.url));
    if (match === null) continue;
    const result = archiveResult(a);
    const usage = Math.max(usageOf.get(place) ?? 0, recencyPoints(a.archivedAt, now));
    scored.push({
      result,
      kind: 'archive',
      score: match + usage + learned(result),
      mayLead: (prefixes(q, title) || prefixes(q, shortUrl(a.url))) && usage >= LEADS_AT_USAGE,
    });
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
  for (const chord of chordsFor(state, windowId)) {
    if (chord.id === win?.activeChordId) continue;
    const match = matchScore(q, chord.name) ?? abbreviationScore(q, chord.name);
    if (match === null) continue;
    const result: Result = { kind: 'chord', key: `chord:${chord.id}`, title: chord.name, chord };
    scored.push({ result, kind: 'chord', score: match + learned(result), mayLead: false });
  }

  for (const a of ACTIONS) {
    if (a.when && !a.when(state, windowId)) continue;
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
  // A typed address leads over a page only by habit, or when it is an open tab's address exactly:
  // then Return switches to that tab rather than opening it twice. `@` text leads with its filters.
  const habitual = habit(choices, q, now);
  const typedPlace = parsed?.kind === 'url' ? placeKey(parsed.url) : null;
  const lead =
    filterOffers.length > 0
      ? undefined
      : ((habitual ? kept.find((s) => destinationOf(s.result) === habitual) : undefined) ??
        (typedPlace
          ? kept.find((s) => s.result.kind === 'tab' && placeKey(s.result.tab.url) === typedPlace)
          : kept.find((s) => s.mayLead)));
  const rest = kept.filter((s) => s !== lead).map((s) => s.result);
  const local = [...filterOffers, ...(lead ? [lead.result] : []), ...(intent ? [intent] : []), ...(keywordOffer ? [keywordOffer] : []), ...rest].slice(0, MAX_ROWS);
  // Half a filter (`@hi`) isn't a search worth suggesting for.
  return [...local, ...(parsed?.kind === 'search' && filterOffers.length === 0 ? suggestionRows((text) => searchUrl(text, engine)) : [])];
}

/** One kind of result only (`@tabs` and the rest): everything of that kind when nothing's typed, best matches otherwise. */
function filtered(
  filter: Filter,
  q: string,
  state: State,
  windowId: string,
  activeChordId: string | null,
  activeId: string | null,
  tabs: TabNode[],
  tabResult: (t: TabNode) => Result,
  history: HistorySearch | null,
  now: number,
): Result[] {
  const ranked = <T>(items: T[], match: (item: T) => number | null, extra: (item: T) => number, toResult: (item: T) => Result): Result[] =>
    items
      .map((item) => ({ item, match: q ? match(item) : 0 }))
      .filter((x): x is { item: T; match: number } => x.match !== null)
      .map((x) => ({ result: toResult(x.item), score: x.match + extra(x.item) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, FILTER_ROWS)
      .map((x) => x.result);
  const tabMatch = (t: TabNode) => matchScore(q, tabTitle(t), shortUrl(t.url)) ?? abbreviationScore(q, tabTitle(t));
  switch (filter) {
    case 'tabs':
      return ranked(
        tabs.filter((t) => t.id !== activeId),
        tabMatch,
        (t) => recencyPoints(t.lastActiveAt, now) + (q ? 0 : t.lastActiveAt / 1e12),
        tabResult,
      );
    case 'pinned':
      return ranked(
        tabs.filter((t) => t.section === 'pinned'),
        tabMatch,
        (t) => recencyPoints(t.lastActiveAt, now),
        tabResult,
      );
    case 'history': {
      const seen = new Set<string>();
      const pages = (history?.history ?? []).filter((h) => {
        const place = placeKey(h.url);
        if (!place || seen.has(place)) return false;
        seen.add(place);
        return true;
      });
      return ranked(
        pages,
        (h) => matchScore(q, h.title || shortUrl(h.url), shortUrl(h.url)),
        (h) => (q ? usagePoints(h.frecency) : h.lastVisitAt / 1e12),
        (h) => ({ kind: 'history', key: `history:${placeKey(h.url)}`, title: h.title || shortUrl(h.url), detail: shortUrl(h.url), url: h.url }),
      );
    }
    case 'archive':
      return ranked(
        history?.archive ?? [],
        (a) => matchScore(q, a.title || shortUrl(a.url), shortUrl(a.url)),
        (a) => (q ? recencyPoints(a.archivedAt, now) : a.archivedAt / 1e12),
        archiveResult,
      );
    case 'chords':
      return ranked(
        chordsFor(state, windowId).filter((c) => c.id !== activeChordId),
        (c) => matchScore(q, c.name) ?? abbreviationScore(q, c.name),
        () => 0,
        (c) => ({ kind: 'chord', key: `chord:${c.id}`, title: c.name, chord: c }),
      );
    case 'actions':
      return ranked(
        ACTIONS.filter((a) => !a.when || a.when(state, windowId)),
        (a) => matchScore(q, a.title, a.words) ?? abbreviationScore(q, a.title),
        () => 0,
        (a) => ({ kind: 'action', key: `action:${a.action}`, title: a.title, action: a.action }),
      );
    case 'duet':
      // Answered by chord-data (buildResults' duetHits), not ranked here.
      return [];
  }
}
