/**
 * Importing from other browsers (ROADMAP.md 0.2, ARCHITECTURE.md §9). The
 * readers (apps/desktop/src/import) turn a browser profile into the plain data
 * below; this decides where it lands. Each top-level bookmark folder goes to a
 * chord you pick: a new one named after it, or one you have, as a pinned
 * folder. The bookmarks bar's own links can become Favorites, open tabs land
 * in a chord's Today, and history goes to Chord's history, which no chord owns.
 * Passwords, cookies, autofill and extensions are never read.
 */
import { generateNKeysBetween } from 'fractional-indexing';
import { DEFAULT_PROFILE, MAX_FAVORITES, type Chord, type ChordId, type ChordThemeSpec, type Favorite, type FolderNode, type SidebarNode, type State, type TabNode } from './model';
import { children } from './nodes';
import { dayOf, frecencyOn, HALF_LIFE_DAYS } from './rank';
import { sortedChords, sortedFavorites } from './select';

/** The browsers Chord imports from. Never Arc (ROADMAP.md, Not planned). */
export type ImportBrowser = 'chrome' | 'edge' | 'brave' | 'firefox' | 'safari';

export const IMPORT_BROWSER_NAMES: Record<ImportBrowser, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox', safari: 'Safari' };

export interface BookmarkLink {
  kind: 'link';
  title: string;
  url: string;
}

export interface BookmarkFolder {
  kind: 'folder';
  title: string;
  items: BookmarkItem[];
}

export type BookmarkItem = BookmarkLink | BookmarkFolder;

/**
 * Where a browser keeps bookmarks at the top: the bookmarks bar (`bar`: Chrome's
 * bar, Firefox's toolbar, Safari's Favorites bar), or another root such as
 * Other bookmarks, the Bookmarks Menu or Mobile bookmarks.
 */
export interface BookmarkRoot {
  kind: 'bar' | 'other';
  title: string;
  items: BookmarkItem[];
}

export interface ImportedTab {
  url: string;
  title: string;
}

/** What one browser profile holds, read from copies of its files. */
export interface ImportPreview {
  roots: BookmarkRoot[];
  /** Its open tabs; null where its files can't be read reliably (Chromium's session files). */
  tabs: ImportedTab[] | null;
  /** Pages in its history. */
  history: number;
}

/**
 * One page of a browser's history: every visit (Unix ms, oldest first), and
 * the ones whose address was typed, which count twice toward frecency as a
 * typed pick does in Chord.
 */
export interface ImportedPage {
  url: string;
  title: string;
  visits: number[];
  typed: number[];
}

/**
 * One thing to map to a chord: the bookmarks bar's own links (`bar`), a
 * folder at the top of a root (`folder`), or another root's own links (`loose`).
 */
export interface ImportGroup {
  /** `r<root>` for a root's own links, `r<root>/<index>` for a folder in it. */
  id: string;
  kind: 'bar' | 'folder' | 'loose';
  title: string;
  /** Web addresses inside, at any depth. */
  links: number;
}

/**
 * Where a group goes: a `new` chord named after it, a chord you have
 * (`chord:<id>`), Favorites (the bookmarks bar's own links only), or nowhere.
 */
export type ImportTarget = 'new' | 'favorites' | 'skip' | `chord:${string}`;

export interface ImportChoices {
  /** By group id; a group that isn't listed isn't imported. */
  groups: Record<string, ImportTarget>;
  /** Open tabs: a chord's Today (`chord:<id>`), or `skip`. */
  tabs: ImportTarget;
  history: boolean;
}

/** What one import added, so its Undo can take exactly that away (this session only, never saved). */
export interface ImportRecord {
  chordIds: ChordId[];
  /** Folders and tabs it put at the top of chords you already had; everything else it made is inside these or in its own chords. */
  nodeIds: string[];
  favoriteIds: string[];
}

/** The bookmarks bar's links that become Favorites; the rest go in a folder. The row wraps well before this. */
export const IMPORT_FAVORITES = 24;
/** Open tabs brought into Today at most, in the browser's order. */
export const IMPORT_TABS = 500;
/** New chords made by default; further folders default to the chord you're in, as pinned folders. */
const DEFAULT_NEW_CHORDS = 6;
const MAX_TITLE = 500;
const MAX_CHORD_NAME = 64;
const MAX_FOLDER_TITLE = 64;

/** Only web addresses are imported: no bookmarklets, `file:`, `place:` queries or browser pages. */
export const isImportableUrl = (url: string): boolean => /^https?:\/\/[^/\s]/i.test(url) && url.length <= 32_768;

/** Web addresses in a list of bookmarks, at any depth. */
export function countLinks(items: readonly BookmarkItem[]): number {
  let n = 0;
  for (const item of items) n += item.kind === 'link' ? (isImportableUrl(item.url) ? 1 : 0) : countLinks(item.items);
  return n;
}

/** The open tabs that come across: web pages, once each, at most IMPORT_TABS, in the browser's order. */
export function importableTabs(tabs: readonly ImportedTab[]): ImportedTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => isImportableUrl(t.url) && !seen.has(t.url) && Boolean(seen.add(t.url))).slice(0, IMPORT_TABS);
}

/** Folders with at least one web address inside, at any depth. */
export function countFolders(items: readonly BookmarkItem[]): number {
  let n = 0;
  for (const item of items) if (item.kind === 'folder' && countLinks(item.items) > 0) n += 1 + countFolders(item.items);
  return n;
}

/** The groups a person maps, in order: the bar's links, the bar's folders, other roots' folders, then other roots' own links. Empty ones are left out. */
export function importGroups(preview: ImportPreview): ImportGroup[] {
  const own: ImportGroup[] = [];
  const folders: ImportGroup[] = [];
  const later: ImportGroup[] = [];
  preview.roots.forEach((root, r) => {
    const links = root.items.filter((i) => i.kind === 'link' && isImportableUrl(i.url)).length;
    if (links > 0) (root.kind === 'bar' ? own : later).push({ id: `r${r}`, kind: root.kind === 'bar' ? 'bar' : 'loose', title: root.title, links });
    root.items.forEach((item, i) => {
      if (item.kind !== 'folder') return;
      const inside = countLinks(item.items);
      if (inside > 0) folders.push({ id: `r${r}/${i}`, kind: 'folder', title: item.title.trim() || 'Untitled folder', links: inside });
    });
  });
  return [...own, ...folders, ...later];
}

/**
 * What a group's mapping starts as: the bar's links in Favorites, the first
 * few folders as chords of their own, everything else in `chordId`.
 */
export function defaultChoices(preview: ImportPreview, chordId: ChordId): ImportChoices {
  const groups: Record<string, ImportTarget> = {};
  let made = 0;
  for (const group of importGroups(preview)) {
    if (group.kind === 'bar') groups[group.id] = 'favorites';
    else if (group.kind === 'folder' && made < DEFAULT_NEW_CHORDS) {
      groups[group.id] = 'new';
      made++;
    } else groups[group.id] = `chord:${chordId}`;
  }
  return { groups, tabs: preview.tabs && importableTabs(preview.tabs).length > 0 ? `chord:${chordId}` : 'skip', history: preview.history > 0 };
}

/** The items a group stands for. */
function groupItems(preview: ImportPreview, id: string): { title: string; items: BookmarkItem[]; loose: boolean } | null {
  const match = /^r(\d+)(?:\/(\d+))?$/.exec(id);
  const root = match ? preview.roots[Number(match[1])] : undefined;
  if (!match || !root) return null;
  if (match[2] === undefined) return { title: root.title, items: root.items.filter((i) => i.kind === 'link'), loose: true };
  const folder = root.items[Number(match[2])];
  return folder?.kind === 'folder' ? { title: folder.title.trim() || 'Untitled folder', items: folder.items, loose: false } : null;
}

export interface ImportPlanOptions {
  importId: string;
  now: number;
  newId: () => string;
  /** Colors for new chords, in turn. */
  themes: readonly ChordThemeSpec[];
  /** Where the bookmarks bar's links go when Favorites is full: the chord the import started from. */
  fallbackChordId: ChordId;
}

/** Where an import's bookmarks and tabs land, ready for the reducer's `import.add`. */
export interface ImportPlan {
  importId: string;
  chords: Chord[];
  /** Folders and tabs, parents before their children, so any prefix is a whole tree. */
  nodes: SidebarNode[];
  favorites: Favorite[];
  counts: { bookmarks: number; folders: number; tabs: number; chords: number; favorites: number };
}

/** A chord's icon: the first letter of its name, as the switcher shows letters. */
function letterIcon(name: string): string {
  const letter = [...name].find((ch) => /[\p{L}\p{N}]/u.test(ch));
  return letter ? letter.toLocaleUpperCase() : '★';
}

const clip = (text: string, max: number) => [...text.trim()].slice(0, max).join('');

/**
 * Decide where everything goes. Pure: ids and time come from `options`. Chords
 * that don't exist (or are a private window's) and groups mapped nowhere are
 * skipped, so whatever a renderer sends, nothing lands in a private window.
 */
export function planImport(state: State, preview: ImportPreview, choices: ImportChoices, options: ImportPlanOptions): ImportPlan {
  const { now, newId } = options;
  const chords: Chord[] = [];
  const nodes: SidebarNode[] = [];
  const favorites: Favorite[] = [];
  const counts = { bookmarks: 0, folders: 0, tabs: 0, chords: 0, favorites: 0 };
  const existing = new Set(sortedChords(state).map((c) => c.id));
  const chordOf = (target: ImportTarget | undefined): ChordId | null => (target?.startsWith('chord:') && existing.has(target.slice(6)) ? target.slice(6) : null);
  // Appends to a chord's Pinned go after what's there, and after each other, in group order.
  const lastPinned = new Map<ChordId, string | null>();
  const pinnedEnd = (chordId: ChordId) => {
    if (!lastPinned.has(chordId)) lastPinned.set(chordId, children(state, chordId, 'pinned', null).at(-1)?.rank ?? null);
    return lastPinned.get(chordId)!;
  };

  /** A list of bookmarks under `parentId`, after `after`; empty folders are left out. */
  const place = (items: readonly BookmarkItem[], chordId: ChordId, parentId: string | null, after: string | null): string | null => {
    const kept = items.filter((item) => (item.kind === 'link' ? isImportableUrl(item.url) : countLinks(item.items) > 0));
    if (kept.length === 0) return after;
    const ranks = generateNKeysBetween(after, null, kept.length);
    kept.forEach((item, i) => {
      const id = newId();
      if (item.kind === 'link') {
        const tab: TabNode = {
          kind: 'tab',
          id,
          chordId,
          section: 'pinned',
          parentId,
          rank: ranks[i]!,
          url: item.url,
          title: clip(item.title, MAX_TITLE) || item.url,
          pinnedUrl: item.url,
          customTitle: null,
          favicon: null,
          lastActiveAt: now,
          createdAt: now,
        };
        nodes.push(tab);
        counts.bookmarks++;
        return;
      }
      nodes.push(folderNode(id, chordId, parentId, ranks[i]!, item.title));
      counts.folders++;
      place(item.items, chordId, id, null);
    });
    return ranks.at(-1)!;
  };
  // Imported folders start closed, so a big import doesn't flood the sidebar.
  const folderNode = (id: string, chordId: ChordId, parentId: string | null, rank: string, title: string): FolderNode => ({
    kind: 'folder',
    id,
    chordId,
    section: 'pinned',
    parentId,
    rank,
    title: clip(title, MAX_FOLDER_TITLE) || 'Untitled folder',
    collapsed: true,
    createdAt: now,
  });
  /** A pinned folder at the end of a chord's Pinned, holding `items`. */
  const asFolder = (chordId: ChordId, title: string, items: readonly BookmarkItem[]) => {
    if (countLinks(items) === 0) return;
    const rank = generateNKeysBetween(pinnedEnd(chordId), null, 1)[0]!;
    lastPinned.set(chordId, rank);
    const id = newId();
    nodes.push(folderNode(id, chordId, null, rank, title));
    counts.folders++;
    place(items, chordId, id, null);
  };

  const groups = importGroups(preview);
  const newChords = groups.filter((g) => choices.groups[g.id] === 'new');
  const chordRanks = generateNKeysBetween(sortedChords(state).at(-1)?.rank ?? null, null, newChords.length);
  for (const group of groups) {
    const target = choices.groups[group.id];
    const found = groupItems(preview, group.id);
    if (!target || target === 'skip' || !found) continue;
    if (target === 'new') {
      const id = newId();
      const name = clip(found.title, MAX_CHORD_NAME) || 'Bookmarks';
      chords.push({
        id,
        profileId: state.settings.separateSignIns ? newId() : DEFAULT_PROFILE,
        name,
        icon: letterIcon(name),
        theme: structuredTheme(options.themes[chords.length % Math.max(1, options.themes.length)]),
        rank: chordRanks[chords.length]!,
        createdAt: now,
      });
      counts.chords++;
      // The folder's contents are the chord's Pinned: no folder named after the chord inside it.
      place(found.items, id, null, null);
      continue;
    }
    if (target === 'favorites' && group.kind === 'bar') {
      const have = new Set(sortedFavorites(state).map((f) => f.url));
      const room = Math.max(0, Math.min(IMPORT_FAVORITES, MAX_FAVORITES - have.size));
      const order = sortedFavorites(state);
      const links = found.items.filter((i): i is BookmarkLink => i.kind === 'link' && isImportableUrl(i.url) && !have.has(i.url) && Boolean(have.add(i.url)));
      const fit = links.slice(0, room);
      const ranks = generateNKeysBetween(order.at(-1)?.rank ?? null, null, fit.length);
      fit.forEach((link, i) => {
        favorites.push({ id: newId(), url: link.url, title: clip(link.title, MAX_TITLE) || link.url, favicon: null, rank: ranks[i]!, createdAt: now });
        counts.favorites++;
      });
      // What doesn't fit stays together, in a folder named after the bar.
      if (links.length > fit.length && existing.has(options.fallbackChordId)) asFolder(options.fallbackChordId, found.title, links.slice(fit.length));
      continue;
    }
    const chordId = chordOf(target);
    if (chordId) asFolder(chordId, found.title, found.items);
  }

  const tabsTo = chordOf(choices.tabs);
  if (tabsTo && preview.tabs) {
    const tabs = importableTabs(preview.tabs);
    const first = children(state, tabsTo, 'today', null)[0];
    const ranks = generateNKeysBetween(null, first?.rank ?? null, tabs.length);
    tabs.forEach((page, i) => {
      // Not loaded until opened, like tabs restored at launch.
      nodes.push({
        kind: 'tab',
        id: newId(),
        chordId: tabsTo,
        section: 'today',
        parentId: null,
        rank: ranks[i]!,
        url: page.url,
        title: clip(page.title, MAX_TITLE) || page.url,
        pinnedUrl: null,
        customTitle: null,
        favicon: null,
        lastActiveAt: now,
        createdAt: now,
      });
      counts.tabs++;
    });
  }
  return { importId: options.importId, chords, nodes, favorites, counts };
}

/** A fresh copy (State is frozen by Immer, so nothing may share theme objects). */
function structuredTheme(theme: ChordThemeSpec | undefined): ChordThemeSpec {
  const t = theme ?? { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' };
  return { stops: t.stops.map((s) => ({ ...s })), grain: t.grain, appearance: t.appearance, ...(t.themeId !== undefined ? { themeId: t.themeId } : {}) };
}

/**
 * Many uses of a page at once, as rank.ts's decay day: the same frecency as
 * calling `used()` once per visit, oldest first. Null without any visits.
 */
export function decayOfVisits(visits: readonly number[], now: number): number | null {
  let score = 0;
  for (const at of visits) score += 2 ** ((dayOf(Math.min(at, now)) - dayOf(now)) / HALF_LIFE_DAYS);
  return score > 0 ? dayOf(now) + HALF_LIFE_DAYS * Math.log2(score) : null;
}

/** Two frecencies added together, each a decay day. */
export function addDecay(a: number, b: number, now: number): number {
  return dayOf(now) + HALF_LIFE_DAYS * Math.log2(frecencyOn(a, now) + frecencyOn(b, now));
}
