/**
 * What the command bar shows for a query (DESIGN.md §7.3, ARCHITECTURE.md §10).
 * M1.1 sources: the typed address or search, open tabs, and actions. History,
 * archive and Crest's ranking arrive in M1.4.
 */
import { parseInput, searchEngine, searchUrl, sortedChords, type ActionId, type Chord, type State, type TabNode } from '@chord/core';
import uFuzzy from '@leeoniya/ufuzzy';
import { displayHost, pageTitle } from '../shared/site';

export type Result =
  | { kind: 'open'; key: string; title: string; detail: string; url: string; search: boolean }
  | { kind: 'tab'; key: string; title: string; detail: string; tab: TabNode; chordName: string | null }
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
  { action: 'page.print', title: 'Print', words: 'print pdf' },
  { action: 'page.viewSource', title: 'View page source', words: 'view source html code' },
  { action: 'app.devtools', title: 'Developer tools', words: 'developer tools devtools inspect console' },
  { action: 'app.settings', title: 'Settings', words: 'settings preferences options' },
  { action: 'app.shortcuts', title: 'Keyboard shortcuts', words: 'keyboard shortcuts hotkeys keys cheat sheet' },
];

const fuzzy = new uFuzzy({ intraMode: 1 });

function fuzzyIndexes(haystack: string[], needle: string): number[] {
  const [idxs, info, order] = fuzzy.search(haystack, needle);
  if (info && order) return order.map((i) => info.idx[i]!);
  return idxs ?? [];
}

const tabTitle = (t: TabNode) => pageTitle(t) || displayHost(t.url) || 'New tab';

/** A word in the title, or the site name, starts with what was typed. */
function strongMatch(t: TabNode, q: string): boolean {
  const needle = q.toLowerCase();
  const host = displayHost(t.url).toLowerCase();
  return host.startsWith(needle) || tabTitle(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(needle));
}

export function buildResults(query: string, state: State, windowId: string, mode: 'new' | 'edit'): Result[] {
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
  const out: Result[] = [];
  if (parsed?.kind === 'url') {
    out.push({ kind: 'open', key: 'open', title: parsed.url, detail: '', url: parsed.url, search: false });
  } else if (parsed) {
    const engine = state.settings.searchEngine;
    out.push({ kind: 'open', key: 'open', title: q, detail: `Search ${searchEngine(engine).name}`, url: searchUrl(parsed.query, engine), search: true });
  }

  // In edit mode the query starts as the current address; don't echo the tab back.
  const candidates = tabs.filter((t) => !(mode === 'edit' && t.id === activeId));
  const haystack = candidates.map((t) => `${tabTitle(t)} ${displayHost(t.url)}`);
  const tabMatches = fuzzyIndexes(haystack, q).slice(0, 5).map((i) => candidates[i]!);
  // An open tab that clearly matches beats searching for it (until M1.4's full ranking).
  if (tabMatches[0] && parsed?.kind !== 'url' && strongMatch(tabMatches[0], q)) out.unshift(tabResult(tabMatches.shift()!));
  out.push(...tabMatches.map(tabResult));

  // Other chords by name: how to switch when the sidebar is hidden.
  const chords = sortedChords(state).filter((c) => c.id !== win?.activeChordId);
  for (const i of fuzzyIndexes(chords.map((c) => c.name), q).slice(0, 3)) {
    const chord = chords[i]!;
    out.push({ kind: 'chord', key: `chord:${chord.id}`, title: chord.name, chord });
  }

  const words = ACTIONS.map((a) => `${a.title} ${a.words}`);
  for (const i of fuzzyIndexes(words, q).slice(0, 3)) {
    const a = ACTIONS[i]!;
    out.push({ kind: 'action', key: `action:${a.action}`, title: a.title, action: a.action });
  }
  return out;
}
