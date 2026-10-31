/**
 * The reducer (ARCHITECTURE.md §6.1). Pure and deterministic given `ctx`, so
 * renderers can apply commands optimistically and land on the same state.
 * Returns Immer patches (for mirrors and persistence) and effects (for main to
 * carry out against real WebContentsViews).
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { blockingSite, cleanOffSites } from './ad-blocking';
import { cleanCountSites, countSite } from './tab-counts';
import { cleanKeys } from './bindings';
import { cleanDevtoolsSettings } from './devtools';
import { isInternalUrl, visibleTabs } from './idle';
import {
  DEFAULT_PROFILE,
  GOOGLE_FREE_ENGINE,
  IDLE_LIVE,
  MAX_FAVORITES,
  MAX_ZOOM,
  MIN_ZOOM,
  SIDEBAR_WIDTH,
  SPLIT,
  PRIVATE_CHORD_THEME,
  extensionKey,
  isPrivateProfile,
  isUiScale,
  privateProfileId,
  type ArchivedTab,
  type ArchiveReason,
  type Bounds,
  type Chord,
  type ChordId,
  type ChordThemeSpec,
  type ClosedTab,
  type CustomTheme,
  type Download,
  type Favorite,
  type FolderNode,
  type InstalledExtension,
  type LiveTab,
  type NodeId,
  type PermissionDecision,
  type Presenting,
  type ProfileId,
  type Section,
  type SidebarNode,
  type SitePermission,
  type SplitDirection,
  type SplitNode,
  type Settings,
  type SettingsPatch,
  type State,
  type TabNode,
  type WindowId,
  type WindowModel,
} from './model';
import { routeFor, routeKey } from './links';
import { emptyMergeUndo, type MergePart, type MergeUndo } from './merge';
import { isTabUrl } from './records';
import { restoreChord, validTheme } from './restore';
import { cleanProxy, sameProxy, type ProxySettings } from './proxy';
import { cleanReaderSettings } from './reader';
import { shortcutById, type ActionId } from './shortcuts';
import type { SyncApply, SyncGone } from './sync';
import { children, chordsFor, descendants, isPrivateChord, isWithin, reopenableIndex, sortedChords, sortedFavorites, tabForFavorite, tabsInOrder } from './select';
import { equalSizes, normalizeSizes, settleSplits, shownTabs, shownWith, splitMembers, splitOf } from './split';

enablePatches();

export type Command =
  /**
   * A new tab at the top of Today. With `route`, a link route for its site
   * (from the command bar) puts it in that chord instead, and the window goes there.
   */
  | { t: 'tab.open'; windowId: WindowId; url: string; background?: boolean; pinned?: boolean; route?: boolean }
  /**
   * A page that wasn't a tab yet (Peek, a mini window) becomes one as `nodeId`:
   * main has already given TabManager its live page, so it keeps its history.
   * It lands at the top of `chordId`'s Today (the window's chord by default),
   * and the window goes there.
   */
  | { t: 'tab.adopt'; windowId: WindowId; nodeId: NodeId; chordId?: ChordId; url: string; title: string; favicon?: string | null; live?: Partial<LiveTab> }
  /** Send a site's links to a chord (from Crest); a site has at most one route. */
  | { t: 'linkRoute.set'; host: string; chordId: ChordId }
  | { t: 'linkRoute.delete'; host: string }
  /** `touch: false` switches without counting as a visit (used while cycling recent tabs). */
  | { t: 'tab.activate'; windowId: WindowId; nodeId: NodeId; touch?: boolean }
  | { t: 'tab.close'; windowId: WindowId; nodeId: NodeId }
  | { t: 'tab.reopenClosed'; windowId: WindowId }
  /** Send Today tabs to the archive: unused for a while (`auto`) or Clear (`cleared`). */
  | { t: 'tab.archive'; nodeIds: NodeId[]; reason: 'auto' | 'cleared' }
  /**
   * Bring a tab back from the archive as `nodeId` (main picks it, so it can
   * load the tab's saved history into the view first), at the top of its
   * chord's Today. `activate` switches to it; otherwise it waits in the sidebar.
   */
  | { t: 'archive.restore'; windowId: WindowId; nodeId: NodeId; tab: ArchivedTab; activate: boolean }
  /** Free a background tab's page; it reloads, with its history, when shown again. */
  | { t: 'tab.sleep'; nodeId: NodeId }
  | { t: 'tab.navigate'; nodeId: NodeId; url: string }
  | { t: 'tab.cycle'; windowId: WindowId; direction: 1 | -1 }
  /**
   * Drag and drop: put a tab or folder at a position among the children of
   * `parentId` (a folder, or the section's root when null or absent) in its
   * chord. Folders live in Pinned, so moving a tab into one pins it.
   */
  | { t: 'node.move'; nodeId: NodeId; section: Section; index: number; parentId?: NodeId | null }
  /**
   * Move a tab to another chord: to `place` (Undo uses the exact spot it
   * left), else the end of Pinned if it was pinned, or the top of Today.
   * If the chords' sign-ins differ, its page closes and reloads in the new session.
   */
  | { t: 'node.moveToChord'; nodeId: NodeId; chordId: ChordId; place?: { section: Section; parentId: NodeId | null; rank: string } }
  /** A folder in Pinned: where `tabId` is (taking the tab inside), or at the end of the chord's Pinned. */
  | { t: 'folder.create'; folderId: NodeId; chordId: ChordId; title: string; tabId?: NodeId }
  | { t: 'folder.rename'; nodeId: NodeId; title: string }
  | { t: 'folder.toggle'; nodeId: NodeId; collapsed: boolean }
  /** Removes a folder and everything in it, kept for Undo. */
  | { t: 'folder.delete'; nodeId: NodeId }
  | { t: 'folder.restore'; nodeId: NodeId }
  /** Add a tab's page to Favorites, at `index` (the end when absent). */
  | { t: 'favorite.add'; favoriteId: string; nodeId: NodeId; index?: number }
  | { t: 'favorite.remove'; favoriteId: string }
  | { t: 'favorite.move'; favoriteId: string; index: number }
  /** Switch to the chord's tab on that site, or open the favorite in Today. */
  | { t: 'favorite.open'; windowId: WindowId; favoriteId: string }
  /** Undo Clear: these tabs come back from the ⌘⇧T list to where they were; `activate` is shown again. */
  | { t: 'closed.restore'; windowId: WindowId; nodeIds: NodeId[]; activate?: NodeId | null }
  /** Pin to the bottom of the pinned section, keeping the current page as its home. */
  | { t: 'tab.pin'; nodeId: NodeId }
  /** Unpin to the top of Today. */
  | { t: 'tab.unpin'; nodeId: NodeId }
  /** Silence a tab's page, or let it be heard again. It's kept with the tab (sleep and restarts too). */
  | { t: 'tab.mute'; nodeId: NodeId; muted: boolean }
  /** Engine reports (not user intent). */
  | { t: 'tab.updated'; nodeId: NodeId; url?: string; title?: string; favicon?: string | null }
  | { t: 'tab.live'; nodeId: NodeId; live: Partial<LiveTab> }
  /**
   * A new window (main picks its id). It starts on the chord `from` shows,
   * with nothing open yet. With `privateChordId` it's a private window with a
   * chord of its own.
   */
  | { t: 'window.create'; windowId: WindowId; from?: WindowId; privateChordId?: ChordId }
  /** One of several windows closed. A private window takes its chord, tabs and downloads with it. */
  | { t: 'window.close'; windowId: WindowId }
  | { t: 'window.bounds'; windowId: WindowId; bounds: Bounds }
  | { t: 'window.sidebar'; windowId: WindowId; sidebar: 'docked' | 'collapsed' }
  /** Drag the sidebar's edge: clamped to SIDEBAR_WIDTH. */
  | { t: 'window.sidebarWidth'; windowId: WindowId; width: number }
  | { t: 'settings.set'; settings: SettingsPatch }
  /**
   * Presenting mode (ARCHITECTURE.md §9). By `share`: a page in Chord started
   * sharing (on, unless it's on already), or the last share ended (off, unless
   * you turned it on). By `you`, the switch or its shortcut: as asked, either way.
   */
  | { t: 'presenting.set'; on: boolean; by: Presenting }
  /** The Chord windows a page is sharing now, as a window or on a shared screen (their edge is tinted). */
  | { t: 'sharing.windows'; windowIds: WindowId[] }
  | { t: 'chord.theme'; chordId: ChordId; theme: Partial<ChordThemeSpec> }
  /** A new chord after the others, switched to in this window. */
  | { t: 'chord.create'; windowId: WindowId; name: string; icon: string; theme: ChordThemeSpec }
  | { t: 'chord.activate'; windowId: WindowId; chordId: ChordId }
  /** Next or previous chord in the switcher, wrapping around. */
  | { t: 'chord.cycle'; windowId: WindowId; direction: 1 | -1 }
  /** ⌘1–⌘8 go to that chord; ⌘9 always goes to the last one, as tab shortcuts do in Chrome. */
  | { t: 'chord.goto'; windowId: WindowId; index: number }
  | { t: 'chord.update'; chordId: ChordId; name?: string; icon?: string }
  /**
   * Which sign-ins a chord uses: DEFAULT_PROFILE to share, or a profile of its
   * own. Its open tabs reload into it. Sharing them again drops its own proxy.
   */
  | { t: 'chord.profile'; chordId: ChordId; profileId: ProfileId }
  /**
   * A chord's own proxy, or (null) Settings' proxy for every chord. With
   * `profileId` the chord moves to those sign-ins first, as chord.profile
   * does: a proxy of its own needs sign-ins of its own (Electron sets proxies
   * per session), so one for a chord sharing sign-ins comes with a new
   * profile, and Undo puts both back. A proxy for shared sign-ins, or one that
   * can't be used, changes nothing.
   */
  | { t: 'chord.proxy'; chordId: ChordId; proxy: ProxySettings | null; profileId?: ProfileId }
  /** Removes a chord and its tabs, kept for Undo. The last chord can't be deleted. */
  | { t: 'chord.delete'; chordId: ChordId }
  /** Undo a deletion: the chord and its tabs come back, and this window switches to it. */
  | { t: 'chord.restore'; windowId: WindowId; chordId: ChordId }
  /** Engine reports: a download started or moved on. */
  | { t: 'download.update'; download: Download }
  /** Take one download off the list (the file stays where it is). */
  | { t: 'download.remove'; id: string }
  /** Take every finished download off the list this window shows (a private window's own, or the rest). */
  | { t: 'download.clear'; windowId: WindowId }
  /** Engine reports: an extension was installed, updated, or told so (main only). */
  | { t: 'extension.record'; extension: InstalledExtension }
  /** An extension was removed from a profile (main only); kept for Undo this session. */
  | { t: 'extension.forget'; profileId: string; id: string }
  /** Undo a removal: main loads it again. */
  | { t: 'extension.restore'; profileId: string; id: string }
  /** Show or hide an extension's button in the shelf (or title bar). */
  | { t: 'extension.pin'; profileId: string; id: string; pinned: boolean }
  /** Add or change a custom theme; chords made from it follow. */
  | { t: 'theme.save'; theme: CustomTheme }
  /** Remove a custom theme; chords using it keep their colors. */
  | { t: 'theme.delete'; id: string }
  /** Remember (or, with null, forget) a site's answer to a permission prompt. */
  | { t: 'permission.set'; origin: string; permissions: SitePermission[]; decision: PermissionDecision | null }
  /** Forget everything decided for a site (Settings → Site permissions). */
  | { t: 'permission.forget'; origin: string }
  /** The page zoom you chose for a site; 1 forgets it. */
  | { t: 'zoom.set'; host: string; factor: number }
  /**
   * A page's "Block ads on this site" (and its Undo): ad blocking off or on
   * again for the site of `site` (an address or a name), and the site's open
   * pages reload. From a private window (`chordId` its chord), turning it off
   * lasts only as long as the window; turning it on changes Settings' list too.
   */
  | { t: 'adBlocking.site'; site: string; off: boolean; chordId?: ChordId }
  /** A tab's "Show count": the count its site (`site`, an address or a host) gives itself hidden, or shown again. */
  | { t: 'tabCounts.site'; site: string; off: boolean }
  /**
   * Split view (DESIGN.md §8.4): show `nodeId` (or a new tab for `url`) as a
   * pane beside `withId`, at pane `index` (the end when absent). `withId`'s
   * split grows, or a new one takes `withId`'s place, running `direction`. A
   * tab already in that split moves to `index`. The window shows the split,
   * focused on the pane added.
   */
  | { t: 'split.add'; windowId: WindowId; withId: NodeId; nodeId?: NodeId; url?: string; index?: number; direction?: SplitDirection }
  /** Panes' shares after a divider was dragged (or double-clicked to even them out), in pane order. */
  | { t: 'split.resize'; splitId: NodeId; sizes: number[] }
  /** A pane's tab leaves its split, to just after it in the sidebar. A split of one dissolves. */
  | { t: 'split.remove'; nodeId: NodeId }
  /** Every pane becomes its own tab again, where the split was. */
  | { t: 'split.separate'; splitId: NodeId }
  /**
   * Undo for separating: these tabs become split `splitId` again where the
   * first of them is, in this order, and the window shows it (focused on `focus`).
   */
  | { t: 'split.join'; windowId: WindowId; splitId: NodeId; nodeIds: NodeId[]; direction: SplitDirection; sizes?: number[]; focus?: NodeId }
  /** Focus the pane before (-1) or after (1) the focused one (⌘⌥[ / ⌘⌥]). */
  | { t: 'split.focus'; windowId: WindowId; direction: 1 | -1 }
  /**
   * Part of an import from another browser (main only; `planImport` in
   * import.ts decides it): new chords, then folders and tabs, parents first,
   * then favorites. Big imports arrive in several of these. Nothing lands in a
   * private window's chord, and nothing loads until it's opened.
   */
  | { t: 'import.add'; importId: string; chords?: Chord[]; nodes?: SidebarNode[]; favorites?: Favorite[] }
  /**
   * Undo an import: the chords it made go, and so do the folders, tabs and
   * favorites it added. With `limit`, that many folders and tabs at a time,
   * the innermost first; main repeats it until the import is gone.
   */
  | { t: 'import.undo'; importId: string; limit?: number }
  /**
   * Part of an import from a Chord file (main only; `planMerge` in merge.ts
   * decides it): things to add or update, each whole, by id; Settings'
   * changes; and a new profile's first-run chord making way. What it replaces
   * is kept for Undo, which `import.undo` puts back first. Nothing is
   * deleted, nothing lands in a private window's chord, a chord keeps its
   * sign-ins, a site gets only blocks, and nothing loads until it's opened.
   */
  | ({ t: 'data.merge'; importId: string } & MergePart)
  /**
   * What other computers changed, through sync (main only; chord-data's merge
   * and core's planApply decide it, docs/decisions/S15-your-data.md §7): things
   * to put, each whole, by id, then things that went. No Undo, and nothing of
   * it is written to this computer's log (main saves it marked as sync's).
   * Checked again here: nothing lands in a private window's chord, a chord
   * keeps its sign-ins and its proxy, tabs only on web pages or the archive
   * page, folders only in Pinned, and nothing loads until it's opened.
   */
  | ({ t: 'sync.apply' } & Partial<Omit<SyncApply, 'effects' | 'gone'>> & { gone?: Partial<SyncGone> })
  /**
   * Joining sync with the synced setup (S15 §6): this computer's own chords
   * go, kept for Undo this session, and their Today tabs move to the top of
   * `to`'s Today; windows on them go to `to`.
   */
  | { t: 'sync.replace'; chordIds: ChordId[]; to: ChordId }
  /** Undo for `sync.replace`: the chords come back, and this window goes to the first. */
  | { t: 'sync.unreplace'; windowId: WindowId; chordIds: ChordId[] }
  /** A toast's Undo for turning sync off or removing a computer, before it happens (main takes it over). */
  | { t: 'sync.undo'; token: string }
  /** A sync problem's toast: Settings → Your data, where it's explained (main takes it over). */
  | { t: 'sync.open' }
  /**
   * Undo a change to a site's Effects (a toast's button): main takes it over
   * (main/effects), since Effects live outside the store (ARCHITECTURE.md §9).
   */
  | { t: 'effects.undo'; token: string }
  /**
   * Undo a form Duet filled (a toast's button): main puts the fields back
   * from the page's own isolated world (main/duet), outside the store.
   */
  | { t: 'duet.undoFill'; token: string }

export type Effect =
  /** Make sure a view exists for this tab (created lazily, loading `url`). */
  | { e: 'view.ensure'; nodeId: NodeId }
  /** Show this tab (or nothing) in the window's content frame. */
  | { e: 'view.show'; windowId: WindowId; nodeId: NodeId | null }
  | { e: 'view.navigate'; nodeId: NodeId; url: string }
  | { e: 'view.destroy'; nodeId: NodeId }
  /** Close the tab's page but keep its back/forward history and scroll position for when it's shown again. */
  | { e: 'view.sleep'; nodeId: NodeId }
  /** Silence the tab's page, or let it be heard (a page made later is silenced as it's made). */
  | { e: 'view.mute'; nodeId: NodeId; muted: boolean }
  /** A tab is going to the archive: save it, with its history, before its view is destroyed. */
  | { e: 'archive.save'; nodeId: NodeId; tab: ArchivedTab }
  /** A tab came back from the archive: its saved history goes into the new view, and the entry leaves the archive. */
  | { e: 'archive.restored'; archiveId: string; nodeId: NodeId }
  /** The window's sidebar docked or collapsed, or changed width: lay the content frame out again. */
  | { e: 'window.layout'; windowId: WindowId; sidebar: 'docked' | 'collapsed'; width: number; animate: boolean }
  /** A window was created: open it. */
  | { e: 'window.open'; windowId: WindowId }
  /** Ad blocking turned off or on for a site: its pages on screen reload, in that private window's chord only, or in every other. */
  | { e: 'site.reload'; site: string; chordId: ChordId | null };

export interface Context {
  now: number;
  newId: () => string;
}

export interface Result {
  state: State;
  patches: Patch[];
  effects: Effect[];
}

const MAX_CLOSED = 50;
/** Deleted chords kept for Undo this session. */
const MAX_DELETED_CHORDS = 5;
/** Chords sync took away kept for Undo: far more than a session's toasts offer. */
const MAX_SYNC_UNDO = 100;
/** Deleted folders kept for Undo this session. */
const MAX_DELETED_FOLDERS = 10;
/** Longest folder name. */
const MAX_FOLDER_TITLE = 64;
/** The most custom themes kept. */
const MAX_THEMES = 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** The mini window's remembered size stays within what a window can sensibly be. */
const clampSize = (n: number) => Math.round(Math.min(4000, Math.max(360, Number.isFinite(n) ? n : 0)));
/** Finished downloads kept in the list; older ones drop off. */
const MAX_DOWNLOADS = 100;
/** Removed extensions kept for Undo. */
const MAX_REMOVED_EXTENSIONS = 10;
/** Longest chord name; the switcher and headers truncate well before this. */
const MAX_CHORD_NAME = 64;
/** A new window opens this far down and right of the one it came from. */
const CASCADE = 28;

/** Commands that can add, move or take away a split's panes: splits settle after them (split.ts). */
const CHANGES_SPLITS: ReadonlySet<Command['t']> = new Set<Command['t']>([
  'tab.close',
  'tab.archive',
  'tab.reopenClosed',
  'closed.restore',
  'node.move',
  'node.moveToChord',
  'folder.delete',
  'folder.restore',
  'chord.delete',
  'chord.restore',
  'tab.pin',
  'tab.unpin',
  'window.close',
  'split.add',
  'split.resize',
  'split.remove',
  'split.separate',
  'split.join',
  // An imported tab may have been put in a split since.
  'import.undo',
  // A Chord file brings splits, and can move tabs into and out of them.
  'data.merge',
  // So does another computer, through sync.
  'sync.apply',
  'sync.replace',
  'sync.unreplace',
]);

/** What a window's content frame holds: its panes and how they share it. */
function paneKey(state: State, windowId: WindowId): string {
  const shown = shownTabs(state, windowId);
  const split = shown.length > 1 ? splitOf(state, shown[0]!) : null;
  return JSON.stringify([shown, split?.direction, split?.sizes]);
}

export function apply(state: State, command: Command, ctx: Context): Result {
  const effects: Effect[] = [];
  const settles = CHANGES_SPLITS.has(command.t);
  const [next, patches] = produceWithPatches(state, (draft) => {
    run(draft, command, ctx, effects);
    if (settles) settleSplits(draft as State);
  });
  if (patches.length === 0) return { state, patches, effects };
  // A window whose panes (or how they share the frame) changed lays them out again.
  if (settles) {
    for (const win of Object.values(next.windows)) {
      if (paneKey(state, win.id) !== paneKey(next, win.id)) effects.push({ e: 'view.show', windowId: win.id, nodeId: win.activeTab[win.activeChordId] ?? null });
    }
  }
  // Bump the version as its own step so it is part of the patch stream.
  const [versioned, versionPatches] = produceWithPatches(next, (draft) => {
    draft.version += 1;
  });
  return { state: versioned, patches: [...patches, ...versionPatches], effects };
}

/** A rank strictly between two neighbors; ties (possible in old data) fall back to after `before`. */
function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

/**
 * Move a tab or folder among the children of `parentId` (a folder, or the
 * section's root) in its chord. Folders live in Pinned, and nothing moves into
 * itself. Pinning a tab keeps the page it's on as its pinned home; unpinning
 * forgets it. Returns false when the move isn't allowed or changes nothing.
 */
function moveNode(draft: Draft<State>, node: Draft<SidebarNode>, section: Section, index: number, parentId: NodeId | null = null): boolean {
  if (parentId !== null) {
    const parent = draft.nodes[parentId];
    if (parent?.kind !== 'folder' || parent.chordId !== node.chordId || isWithin(draft as State, parentId, node.id)) return false;
    section = parent.section;
  }
  if (node.kind === 'folder' && section !== 'pinned') return false;
  const siblings = children(draft as State, node.chordId, section, parentId).filter((n) => n.id !== node.id);
  const at = Math.max(0, Math.min(index, siblings.length));
  if (node.section === section && node.parentId === parentId) {
    const current = children(draft as State, node.chordId, section, parentId).findIndex((n) => n.id === node.id);
    if (current === at) return false;
  }
  node.rank = rankBetween(siblings[at - 1]?.rank ?? null, siblings[at]?.rank ?? null);
  if (node.parentId !== parentId) node.parentId = parentId;
  if (node.kind === 'tab' && node.section !== section) {
    node.section = section;
    node.pinnedUrl = section === 'pinned' ? (node.pinnedUrl ?? node.url) : null;
  }
  // A split takes its panes along: they pin or unpin with it.
  if (node.kind === 'split' && node.section !== section) {
    for (const pane of splitMembers(draft as State, node.id)) {
      pane.section = section;
      pane.pinnedUrl = section === 'pinned' ? (pane.pinnedUrl ?? pane.url) : null;
    }
    node.section = section;
  }
  return true;
}

/** The pane to land on when `nodeId` leaves a split: the one after it, else the one before. */
function paneNeighbor(panes: readonly NodeId[], nodeId: NodeId): NodeId | null {
  const at = panes.indexOf(nodeId);
  const rest = panes.filter((id) => id !== nodeId);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null;
}

/**
 * Take a tab out of its split, to just after the split among the split's
 * siblings. The panes left keep their shares relative to each other.
 */
function leaveSplit(draft: Draft<State>, tab: Draft<TabNode>, split: Draft<SplitNode>): void {
  const panes = splitMembers(draft as State, split.id);
  const at = panes.findIndex((p) => p.id === tab.id);
  if (at < 0) return;
  if (panes.length > 2) split.sizes = normalizeSizes(split.sizes.filter((_, i) => i !== at), panes.length - 1);
  const siblings = children(draft as State, split.chordId, split.section, split.parentId);
  const next = siblings[siblings.findIndex((n) => n.id === split.id) + 1];
  tab.parentId = split.parentId;
  tab.rank = rankBetween(split.rank, next?.rank ?? null);
}

/** Put a tab into a split as pane `index`, keeping the others' order and making room for it. */
function joinSplit(draft: Draft<State>, tab: Draft<TabNode>, split: Draft<SplitNode>, index: number): void {
  const others = splitMembers(draft as State, split.id).filter((p) => p.id !== tab.id);
  const wasPane = tab.parentId === split.id;
  const before = splitMembers(draft as State, split.id);
  const at = Math.max(0, Math.min(index, others.length));
  tab.rank = rankBetween(others[at - 1]?.rank ?? null, others[at]?.rank ?? null);
  tab.parentId = split.id;
  if (tab.section !== split.section) {
    tab.section = split.section;
    tab.pinnedUrl = split.section === 'pinned' ? (tab.pinnedUrl ?? tab.url) : null;
  }
  if (wasPane) {
    // Moving a pane: its share moves with it.
    const share = split.sizes[before.findIndex((p) => p.id === tab.id)] ?? 1 / before.length;
    const rest = split.sizes.filter((_, i) => before[i]?.id !== tab.id);
    rest.splice(at, 0, share);
    split.sizes = normalizeSizes(rest, before.length);
  } else {
    // A new pane gets an even share; the others shrink in proportion.
    const n = others.length + 1;
    const rest = normalizeSizes(split.sizes, others.length).map((s) => (s * (n - 1)) / n);
    rest.splice(at, 0, 1 / n);
    split.sizes = rest;
  }
}

/**
 * Tabs are leaving a chord's sidebar (deleted with a folder, moved away): the
 * windows showing one land on the nearest tab that stays, below first (Arc's
 * rule). Measure before they leave; call the returned function after.
 */
function landWindows(draft: Draft<State>, leaving: ReadonlySet<NodeId>, ctx: Context, effects: Effect[]): () => void {
  const landing = new Map<string, NodeId | null>();
  for (const win of Object.values(draft.windows)) {
    for (const [chordId, tabId] of Object.entries(win.activeTab)) {
      if (!tabId || !leaving.has(tabId)) continue;
      const order = tabsInOrder(draft as State, chordId);
      const at = order.findIndex((t) => t.id === tabId);
      const stays = (t: TabNode) => !leaving.has(t.id);
      // Inside a collapsed folder the tab isn't in the visible order: land on the first that stays.
      const below = at >= 0 ? order.slice(at + 1).find(stays) : order.find(stays);
      const above = at >= 0 ? order.slice(0, at).reverse().find(stays) : undefined;
      landing.set(`${win.id}:${chordId}`, (below ?? above)?.id ?? null);
    }
  }
  return () => {
    for (const win of Object.values(draft.windows)) {
      for (const chordId of Object.keys(win.activeTab)) {
        const key = `${win.id}:${chordId}`;
        if (!landing.has(key)) continue;
        const next = landing.get(key) ?? null;
        if (chordId === win.activeChordId) activate(draft, win.id, next, ctx, effects);
        else win.activeTab[chordId] = next;
      }
    }
  };
}

function topOfToday(state: Draft<State>, chordId: ChordId): string {
  const first = children(state as State, chordId, 'today', null)[0];
  return generateKeyBetween(null, first?.rank ?? null);
}

/**
 * Ask main to archive a tab that's about to go (before its view does), and
 * return the archive entry's id. Chord's own pages (the archive itself) just
 * close: there's nothing worth keeping.
 */
function toArchive(node: TabNode, reason: ArchiveReason, ctx: Context, effects: Effect[]): string | null {
  if (isInternalUrl(node.url)) return null;
  const id = ctx.newId();
  const tab: ArchivedTab = { id, chordId: node.chordId, url: node.url, title: node.title, favicon: node.favicon, reason, archivedAt: ctx.now };
  effects.push({ e: 'archive.save', nodeId: node.id, tab });
  return id;
}

/** The window other than `windowId` that shows this tab (alone or as a pane), if any: a tab shows in one window at a time. */
function shownByOther(draft: Draft<State>, nodeId: NodeId, windowId: WindowId): Draft<WindowModel> | undefined {
  return Object.values(draft.windows).find((w) => w.id !== windowId && shownTabs(draft as State, w.id).includes(nodeId));
}

/** A chord's most recently used tab that no other window is showing (and isn't `skip`). */
function recentFree(draft: Draft<State>, chordId: ChordId, windowId: WindowId, skip: NodeId | null = null): NodeId | null {
  return (
    tabsInOrder(draft as State, chordId)
      .filter((t) => t.id !== skip && !shownByOther(draft, t.id, windowId))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
  );
}

/** Where a window lands when its tab goes: the nearest tab below it, else above, that no other window shows (Arc's rule). */
function nearestFree(draft: Draft<State>, order: readonly TabNode[], index: number, windowId: WindowId, gone: (t: TabNode) => boolean): NodeId | null {
  const free = (t: TabNode) => !gone(t) && !shownByOther(draft, t.id, windowId);
  const below = order.slice(index + 1).find(free);
  const above = order.slice(0, Math.max(0, index)).reverse().find(free);
  return (below ?? above)?.id ?? null;
}

/**
 * The tab a window shows stops being used now. It counts as used until a
 * moment ago, so idle time (archiving, sleeping) runs from when you left it,
 * and it stays just behind the tab you're going to in recently-used order.
 */
function leave(draft: Draft<State>, win: Draft<WindowModel>, ctx: Context): void {
  const id = win.activeTab[win.activeChordId];
  const node = id ? draft.nodes[id] : undefined;
  if (node?.kind === 'tab') node.lastActiveAt = ctx.now - 1;
}

function activate(
  draft: Draft<State>,
  windowId: WindowId,
  nodeId: NodeId | null,
  ctx: Context,
  effects: Effect[],
  touch = true,
) {
  const win = draft.windows[windowId];
  if (!win) return;
  win.activeTab[win.activeChordId] = nodeId;
  // A window showing this tab (or another pane of its split) lets it go first (a view has one
  // parent): it falls back to its most recently used tab that's free, and its effects come first
  // so the page never has two homes.
  const group = nodeId ? shownWith(draft as State, nodeId) : [];
  for (const other of Object.values(draft.windows)) {
    if (other.id === windowId || !shownTabs(draft as State, other.id).some((id) => group.includes(id))) continue;
    const fallback = recentFree(draft, other.activeChordId, other.id, nodeId);
    other.activeTab[other.activeChordId] = fallback;
    if (fallback) effects.push({ e: 'view.ensure', nodeId: fallback });
    effects.push({ e: 'view.show', windowId: other.id, nodeId: fallback });
  }
  if (nodeId) {
    const node = draft.nodes[nodeId];
    if (touch && node?.kind === 'tab') node.lastActiveAt = ctx.now;
    effects.push({ e: 'view.ensure', nodeId });
  }
  effects.push({ e: 'view.show', windowId, nodeId });
}

/** Switch a window to a chord, landing on the tab it last showed there (or its most recently used one). */
function switchChord(draft: Draft<State>, windowId: WindowId, chordId: ChordId, ctx: Context, effects: Effect[]): void {
  const win = draft.windows[windowId];
  if (!win || win.activeChordId === chordId || !chordsFor(draft as State, windowId).some((c) => c.id === chordId)) return;
  leave(draft, win, ctx);
  win.activeChordId = chordId;
  // Landing on a chord never takes a tab from another window.
  let tabId = win.activeTab[chordId] ?? null;
  if (!tabId || draft.nodes[tabId]?.kind !== 'tab' || shownByOther(draft, tabId, windowId)) tabId = recentFree(draft, chordId, windowId);
  activate(draft, windowId, tabId, ctx, effects);
}

/**
 * A chord moves to other sign-ins. A page can't change session: every open tab in the chord closes its
 * page, and the one a window shows comes straight back in the new session. The rest load when you visit
 * them. Shared sign-ins mean the shared session, and so the proxy for every chord: its own goes.
 */
function changeProfile(draft: Draft<State>, chord: Draft<Chord>, profileId: ProfileId, effects: Effect[]): void {
  chord.profileId = profileId;
  if (profileId === DEFAULT_PROFILE) delete chord.proxy;
  for (const node of Object.values(draft.nodes)) {
    if (node.kind !== 'tab' || node.chordId !== chord.id || !draft.live[node.id]) continue;
    delete draft.live[node.id];
    effects.push({ e: 'view.destroy', nodeId: node.id });
  }
  for (const win of Object.values(draft.windows)) {
    const shown = win.activeChordId === chord.id ? win.activeTab[chord.id] : null;
    if (!shown) continue;
    draft.live[shown] = { ...IDLE_LIVE, loading: true };
    effects.push({ e: 'view.ensure', nodeId: shown }, { e: 'view.show', windowId: win.id, nodeId: shown });
  }
}

/** A plain copy of a draft's value, for an Undo to put back later. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const PERMISSIONS: readonly SitePermission[] = ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'];

/**
 * Tabs that move to another chord (an import's move, or its Undo putting one
 * back): windows showing one land elsewhere, and a page whose sign-ins change
 * closes, to load in its new session when it's shown. Call before they move;
 * call what it returns after.
 */
function moving(draft: Draft<State>, moves: ReadonlyMap<NodeId, ChordId>, ctx: Context, effects: Effect[]): () => void {
  const leaving = new Set([...moves.keys()].filter((id) => draft.nodes[id]?.kind === 'tab'));
  const land = landWindows(draft, leaving, ctx, effects);
  return () => {
    for (const id of leaving) {
      const node = draft.nodes[id];
      const from = draft.chords[moves.get(id) ?? ''];
      if (!node || !draft.live[id] || draft.chords[node.chordId]?.profileId === from?.profileId) continue;
      delete draft.live[id];
      effects.push({ e: 'view.destroy', nodeId: id });
    }
    land();
  };
}

/** `data.merge`: one part of a Chord file's import, checked again here (main's boundary), with what it replaces kept for Undo. */
function mergeIn(draft: Draft<State>, cmd: Extract<Command, { t: 'data.merge' }>, ctx: Context, effects: Effect[]): void {
  const record = (draft.imports[cmd.importId] ??= { chordIds: [], nodeIds: [], favoriteIds: [] });
  const undo = (record.merged ??= emptyMergeUndo());
  if (undo.restored) return;

  // Chords: a new one is added; one you have takes the file's name, icon, colors and place, never other sign-ins.
  // Neither takes a proxy from here: only `proxies` sets one, which comes only with Settings from the file.
  for (const incoming of cmd.chords ?? []) {
    if (incoming.private || isPrivateProfile(incoming.profileId)) continue;
    const { proxy: _proxy, ...plain } = incoming;
    const chord = restoreChord({ ...plain, name: incoming.name.trim().slice(0, MAX_CHORD_NAME) || 'Chord' });
    const existing = draft.chords[chord.id];
    if (!existing) {
      draft.chords[chord.id] = chord;
      record.chordIds.push(chord.id);
      continue;
    }
    if (existing.private) continue;
    if (!(chord.id in undo.chords) && !record.chordIds.includes(chord.id)) undo.chords[chord.id] = copy(existing);
    existing.name = chord.name;
    existing.icon = chord.icon;
    existing.theme = chord.theme;
    existing.rank = chord.rank;
  }
  // A chord's own proxy, as chord.proxy sets one: only with sign-ins of its own, and only one that can be used.
  for (const [chordId, value] of Object.entries(cmd.proxies ?? {})) {
    const chord = draft.chords[chordId];
    const proxy = value === null ? null : cleanProxy(value);
    if (!chord || chord.private || chord.profileId === DEFAULT_PROFILE || (value !== null && !proxy) || sameProxy(chord.proxy, proxy)) continue;
    if (!(chordId in undo.chords) && !record.chordIds.includes(chordId)) undo.chords[chordId] = copy(chord);
    if (proxy) chord.proxy = proxy;
    else delete chord.proxy;
  }

  // Folders, tabs and splits, parents first. Each in a chord that's there, in a folder (or, for a tab, a split) of the same chord, never inside itself; otherwise at its section's root.
  const made = new Set(record.chordIds);
  const added = new Set(undo.added);
  const moves = new Map<NodeId, ChordId>();
  for (const node of cmd.nodes ?? []) {
    const existing = draft.nodes[node.id];
    const to = draft.chords[node.chordId];
    if (existing && to && !to.private && existing.chordId !== node.chordId && existing.kind === node.kind && (node.kind !== 'tab' || isTabUrl(node.url))) moves.set(node.id, existing.chordId);
  }
  const land = moving(draft, moves, ctx, effects);
  for (const incoming of cmd.nodes ?? []) {
    const chord = draft.chords[incoming.chordId];
    const existing = draft.nodes[incoming.id];
    if (!chord || chord.private || (incoming.kind === 'tab' && !isTabUrl(incoming.url))) continue;
    if (existing && (existing.kind !== incoming.kind || draft.chords[existing.chordId]?.private)) continue;
    const node = { ...incoming } as SidebarNode;
    if (node.parentId !== null) {
      const parent = draft.nodes[node.parentId];
      const fits =
        parent &&
        parent.id !== node.id &&
        parent.chordId === node.chordId &&
        (parent.kind === 'folder' || (parent.kind === 'split' && node.kind === 'tab')) &&
        !(existing && isWithin(draft as State, parent.id, node.id));
      if (fits) node.section = parent.section;
      else node.parentId = null;
    }
    if (node.kind === 'folder' && node.section !== 'pinned') continue;
    if (node.kind === 'tab') node.pinnedUrl = node.section === 'pinned' ? (node.pinnedUrl ?? node.url) : null;
    if (existing) {
      if (!(node.id in undo.nodes) && !added.has(node.id)) undo.nodes[node.id] = copy(existing);
      // What's live stays: a tab's icon, unless the file brings one, and when it was last shown.
      draft.nodes[node.id] = node.kind === 'tab' && existing.kind === 'tab' ? { ...node, favicon: node.favicon ?? existing.favicon, lastActiveAt: existing.lastActiveAt } : node;
      continue;
    }
    // Unloaded: no live entry, so nothing loads until it's opened.
    draft.nodes[node.id] = node;
    undo.added.push(node.id);
    added.add(node.id);
    // Undo takes away the chords it made whole; elsewhere it needs the tops of what it added.
    if (!made.has(node.chordId) && (node.parentId === null || !added.has(node.parentId))) record.nodeIds.push(node.id);
  }
  land();

  // Favorites: one you have takes the file's title, icon and place; a new one only while the row has room and not twice.
  for (const favorite of cmd.favorites ?? []) {
    if (!/^https?:\/\//i.test(favorite.url)) continue;
    const existing = draft.favorites[favorite.id];
    if (existing) {
      if (!(favorite.id in undo.favorites) && !record.favoriteIds.includes(favorite.id)) undo.favorites[favorite.id] = copy(existing);
      draft.favorites[favorite.id] = { ...favorite, favicon: favorite.favicon ?? existing.favicon, createdAt: existing.createdAt };
      continue;
    }
    const order = Object.values(draft.favorites);
    if (order.length >= MAX_FAVORITES || order.some((f) => f.url === favorite.url)) continue;
    draft.favorites[favorite.id] = favorite;
    record.favoriteIds.push(favorite.id);
  }

  for (const incoming of cmd.themes ?? []) {
    const theme = validTheme(incoming);
    if (!theme) continue;
    const index = draft.settings.themes.findIndex((t) => t.id === theme.id);
    if (index < 0 && draft.settings.themes.length >= MAX_THEMES) continue;
    if (!(theme.id in undo.themes)) undo.themes[theme.id] = index >= 0 ? copy(draft.settings.themes[index]!) : null;
    if (index >= 0) draft.settings.themes[index] = theme;
    else draft.settings.themes.push(theme);
  }

  for (const route of cmd.routes ?? []) {
    const host = routeKey(route.host);
    const chord = draft.chords[route.chordId];
    if (!host || host !== route.host || !chord || chord.private) continue;
    const existing = draft.linkRoutes[host];
    if (!(host in undo.routes)) undo.routes[host] = existing ? copy(existing) : null;
    draft.linkRoutes[host] = { host, chordId: chord.id, createdAt: existing?.createdAt ?? route.createdAt };
  }

  for (const [host, factor] of Object.entries(cmd.zoom ?? {})) {
    if (!/^[a-z0-9.:[\]-]{1,300}$/.test(host) || typeof factor !== 'number' || !(factor >= MIN_ZOOM && factor <= MAX_ZOOM) || Math.abs(factor - 1) < 0.001) continue;
    if (!(host in undo.zoom)) undo.zoom[host] = draft.siteZoom[host] ?? null;
    draft.siteZoom[host] = factor;
  }

  // Blocks only: there's no way here to allow anything.
  for (const [origin, permissions] of Object.entries(cmd.blocks ?? {})) {
    const blocked = (Array.isArray(permissions) ? permissions : []).filter((p) => PERMISSIONS.includes(p));
    if (!/^https?:\/\/[^\s/]+$/.test(origin) || blocked.length === 0) continue;
    if (!(origin in undo.permissions)) undo.permissions[origin] = draft.sitePermissions[origin] ? copy(draft.sitePermissions[origin]!) : null;
    const site = (draft.sitePermissions[origin] ??= {});
    for (const permission of blocked) site[permission] = 'block';
  }

  // Settings, through settings.set's own checks; what each one was, for Undo (Google-free mode can move the search engine too).
  if (cmd.settings) {
    const before = copy(draft.settings) as Record<string, unknown>;
    run(draft, { t: 'settings.set', settings: cmd.settings }, ctx, effects);
    for (const key of Object.keys(draft.settings) as (keyof Settings)[]) {
      if (key === 'themes') continue;
      const after = JSON.stringify(draft.settings[key]);
      if (after === JSON.stringify(before[key])) continue;
      undo.settings[key] = { before: undo.settings[key]?.before ?? before[key], after };
    }
  }

  if (cmd.makeWay) makeWay(draft, undo, cmd.makeWay.chordId, cmd.makeWay.to, effects);
}

/**
 * A new profile's first-run chord makes way for a file's (S15 §5): its tabs
 * go to the top of `to`'s Today (anything pinned to the end of its Pinned),
 * windows on it go to `to`, showing the tab they showed, and it goes. Undo
 * brings it back as it was.
 */
function makeWay(draft: Draft<State>, undo: Draft<MergeUndo>, chordId: ChordId, to: ChordId, effects: Effect[]): void {
  const chord = draft.chords[chordId];
  const target = draft.chords[to];
  if (!chord || !target || chord.private || target.private || chordId === to || undo.madeWay || sortedChords(draft as State).length < 2) return;
  const nodes = Object.values(draft.nodes).filter((n) => n.chordId === chordId);
  undo.madeWay = { chord: copy(chord), nodes: nodes.map(copy), to };
  const today = children(draft as State, chordId, 'today', null);
  const pinned = children(draft as State, chordId, 'pinned', null);
  const todayRanks = generateNKeysBetween(null, children(draft as State, to, 'today', null)[0]?.rank ?? null, today.length);
  const pinnedRanks = generateNKeysBetween(children(draft as State, to, 'pinned', null).at(-1)?.rank ?? null, null, pinned.length);
  today.forEach((n, i) => (draft.nodes[n.id]!.rank = todayRanks[i]!));
  pinned.forEach((n, i) => (draft.nodes[n.id]!.rank = pinnedRanks[i]!));
  const resign = chord.profileId !== target.profileId;
  for (const node of nodes) {
    draft.nodes[node.id]!.chordId = to;
    if (resign && draft.live[node.id]) {
      delete draft.live[node.id];
      effects.push({ e: 'view.destroy', nodeId: node.id });
    }
  }
  for (const win of Object.values(draft.windows)) {
    const shown = win.activeTab[chordId] ?? null;
    delete win.activeTab[chordId];
    if (win.activeChordId !== chordId) continue;
    win.activeChordId = to;
    win.activeTab[to] = shown;
    // The tab it showed stays on screen; in other sign-ins it loads again there.
    if (shown && !draft.live[shown]) {
      draft.live[shown] = { ...IDLE_LIVE, loading: true };
      effects.push({ e: 'view.ensure', nodeId: shown });
    }
    effects.push({ e: 'view.show', windowId: win.id, nodeId: shown });
  }
  for (const [host, route] of Object.entries(draft.linkRoutes)) {
    if (route.chordId !== chordId) continue;
    if (!(host in undo.routes)) undo.routes[host] = copy(route);
    delete draft.linkRoutes[host];
  }
  delete draft.chords[chordId];
}

/**
 * The first part of an import's Undo, for a Chord file: what it updated goes
 * back to what it was (where it's still there), and the first-run chord that
 * made way comes back with its tabs. Taking away what it added follows, as
 * for any import.
 */
function putBack(draft: Draft<State>, undo: Draft<MergeUndo>, ctx: Context, effects: Effect[]): void {
  const way = undo.madeWay;
  if (way && !draft.chords[way.chord.id]) {
    draft.chords[way.chord.id] = copy(way.chord);
    const resign = draft.chords[way.to]?.profileId !== way.chord.profileId;
    const moved = new Set(way.nodes.map((n) => n.id));
    for (const before of way.nodes) {
      const node = draft.nodes[before.id];
      if (!node) continue;
      draft.nodes[before.id] = { ...node, chordId: before.chordId, section: before.section, parentId: before.parentId, rank: before.rank } as SidebarNode;
      if (resign && draft.live[before.id]) {
        delete draft.live[before.id];
        effects.push({ e: 'view.destroy', nodeId: before.id });
      }
    }
    // Windows on the chord it made way for go back to it, showing the tab they showed if it was one of its.
    for (const win of Object.values(draft.windows)) {
      const shown = win.activeTab[way.to] ?? null;
      const back = shown && moved.has(shown) ? shown : null;
      if (back) win.activeTab[way.to] = null;
      if (win.activeChordId !== way.to) continue;
      win.activeChordId = way.chord.id;
      win.activeTab[way.chord.id] = back;
      if (back && !draft.live[back]) {
        draft.live[back] = { ...IDLE_LIVE, loading: true };
        effects.push({ e: 'view.ensure', nodeId: back });
      }
      effects.push({ e: 'view.show', windowId: win.id, nodeId: back });
    }
  }
  for (const [id, before] of Object.entries(undo.chords)) {
    const chord = draft.chords[id];
    if (!chord) continue;
    draft.chords[id] = restoreChord({ ...copy(before), profileId: chord.profileId });
  }
  const moves = new Map<NodeId, ChordId>();
  for (const [id, before] of Object.entries(undo.nodes)) {
    const node = draft.nodes[id];
    if (node && node.kind === before.kind && node.chordId !== before.chordId && draft.chords[before.chordId]) moves.set(id, node.chordId);
  }
  const land = moving(draft, moves, ctx, effects);
  for (const [id, before] of Object.entries(undo.nodes)) {
    const node = draft.nodes[id];
    if (!node || node.kind !== before.kind || !draft.chords[before.chordId]) continue;
    const back = copy(before);
    if (back.parentId !== null && draft.nodes[back.parentId]?.chordId !== back.chordId) back.parentId = null;
    draft.nodes[id] = node.kind === 'tab' && back.kind === 'tab' ? { ...back, favicon: node.favicon ?? back.favicon, lastActiveAt: node.lastActiveAt } : back;
  }
  land();
  for (const [id, before] of Object.entries(undo.favorites)) if (draft.favorites[id]) draft.favorites[id] = copy(before);
  for (const [id, before] of Object.entries(undo.themes)) {
    const index = draft.settings.themes.findIndex((t) => t.id === id);
    if (before === null) {
      if (index >= 0) draft.settings.themes.splice(index, 1);
    } else if (index >= 0) draft.settings.themes[index] = copy(before);
  }
  for (const [host, before] of Object.entries(undo.routes)) {
    if (before === null) delete draft.linkRoutes[host];
    else if (draft.chords[before.chordId]) draft.linkRoutes[host] = copy(before);
  }
  for (const [host, before] of Object.entries(undo.zoom)) {
    if (before === null) delete draft.siteZoom[host];
    else draft.siteZoom[host] = before;
  }
  for (const [origin, before] of Object.entries(undo.permissions)) {
    if (before === null) delete draft.sitePermissions[origin];
    else draft.sitePermissions[origin] = copy(before);
  }
  // A setting goes back only if it's still as the import left it: one you've changed since is yours.
  for (const [key, change] of Object.entries(undo.settings) as [keyof Settings, { before: unknown; after: string }][]) {
    if (JSON.stringify(draft.settings[key]) === change.after) (draft.settings as Record<string, unknown>)[key] = copy(change.before);
  }
  undo.restored = true;
}

/**
 * A chord makes way for another (`to`): another computer deleted it (sync), or
 * it's this computer's and joining takes the synced setup. What's only this
 * computer's moves to the top of `to`'s Today, in its order: its Today tabs
 * (a split with its panes), and any pinned tab that's open, which stops being
 * pinned (it no longer syncs). Windows on it go to `to`, showing what they
 * showed if it moved. The rest (pinned folders, splits and tabs not open)
 * goes, kept with the chord for Undo this session (`sync.unreplace` puts it
 * back, and what moved too), as chord.delete keeps one.
 */
function giveWay(draft: Draft<State>, chordId: ChordId, to: ChordId, ctx: Context, effects: Effect[], open: ReadonlySet<NodeId> = new Set(Object.keys(draft.live))): void {
  const chord = draft.chords[chordId];
  const target = draft.chords[to];
  if (!chord || !target || chord.private || target.private || chordId === to) return;
  const today = children(draft as State, chordId, 'today', null);
  const opened = Object.values(draft.nodes)
    .filter((n) => n.chordId === chordId && n.kind === 'tab' && n.section === 'pinned' && open.has(n.id))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const going = [...today, ...opened];
  const ranks = generateNKeysBetween(null, children(draft as State, to, 'today', null)[0]?.rank ?? null, going.length);
  const resign = chord.profileId !== target.profileId;
  const moved = new Set<NodeId>();
  const before: SidebarNode[] = [];
  const carry = (node: Draft<SidebarNode>) => {
    before.push(copy(node));
    node.chordId = to;
    moved.add(node.id);
    // A page can't change sign-ins: it closes, and loads again in its new session when it's shown.
    if (resign && draft.live[node.id]) {
      delete draft.live[node.id];
      effects.push({ e: 'view.destroy', nodeId: node.id });
    }
  };
  going.forEach((n, i) => {
    const node = draft.nodes[n.id]!;
    carry(node);
    node.rank = ranks[i]!;
    if (node.section === 'pinned') {
      node.section = 'today';
      node.parentId = null;
      if (node.kind === 'tab') node.pinnedUrl = null;
    }
    // A split in Today brings its panes.
    if (node.kind === 'split') for (const inner of Object.values(draft.nodes)) if (inner.parentId === node.id && inner.chordId === chordId) carry(inner);
  });
  // Windows on it go to `to`, showing what they showed if it moved.
  for (const win of Object.values(draft.windows)) {
    const shown = win.activeTab[chordId] ?? null;
    delete win.activeTab[chordId];
    if (win.activeChordId !== chordId) continue;
    win.activeChordId = to;
    const show = shown && moved.has(shown) ? shown : null;
    win.activeTab[to] = show;
    if (show && !draft.live[show]) {
      draft.live[show] = { ...IDLE_LIVE, loading: true };
      effects.push({ e: 'view.ensure', nodeId: show });
    }
    effects.push({ e: 'view.show', windowId: win.id, nodeId: show });
  }
  // The rest goes with it, kept for Undo this session.
  const rest = Object.values(draft.nodes).filter((n) => n.chordId === chordId);
  draft.syncUndo.unshift({ id: ctx.newId(), chord: copy(chord), nodes: rest.map((n) => copy(n)), deletedAt: ctx.now, moved: before });
  if (draft.syncUndo.length > MAX_SYNC_UNDO) draft.syncUndo.length = MAX_SYNC_UNDO;
  for (const node of rest) {
    if (node.kind === 'tab' && draft.live[node.id]) effects.push({ e: 'view.destroy', nodeId: node.id });
    delete draft.nodes[node.id];
    delete draft.live[node.id];
  }
  delete draft.chords[chordId];
}

/** A chord another computer deleted (sync): it makes way for its neighbour, never losing what's only this computer's. Never the last one. */
function dropChord(draft: Draft<State>, chordId: ChordId, ctx: Context, effects: Effect[], open: ReadonlySet<NodeId>): void {
  const order = sortedChords(draft as State).filter((c) => !c.private);
  const index = order.findIndex((c) => c.id === chordId);
  if (index < 0 || order.length < 2) return;
  const neighbor = (order[index + 1] ?? order[index - 1])!;
  giveWay(draft, chordId, neighbor.id, ctx, effects, open);
  for (const [host, route] of Object.entries(draft.linkRoutes)) if (route.chordId === chordId) delete draft.linkRoutes[host];
}

/**
 * `sync.unreplace`: chords that made way (for the synced setup, or deleted on
 * another computer) come back as they were, and what moved out of them goes
 * back where it was, if it's still where it went. A chord sync brought back
 * meanwhile stays as it is; its tabs still go back to it.
 */
function unreplace(draft: Draft<State>, windowId: WindowId, chordIds: readonly ChordId[], ctx: Context, effects: Effect[]): void {
  const back: ChordId[] = [];
  for (const chordId of chordIds) {
    const index = draft.syncUndo.findIndex((d) => d.chord.id === chordId);
    if (index < 0) continue;
    const [deleted] = draft.syncUndo.splice(index, 1);
    if (!draft.chords[chordId]) {
      draft.chords[chordId] = deleted!.chord;
      back.push(chordId);
    }
    // What it held comes back where it was, in it (a folder before what it held, whatever order they were kept in).
    const restored: NodeId[] = [];
    for (const node of deleted!.nodes) {
      if (draft.nodes[node.id] || !draft.chords[node.chordId]) continue;
      draft.nodes[node.id] = copy(node);
      restored.push(node.id);
    }
    for (const id of restored) {
      const node = draft.nodes[id]!;
      if (node.parentId !== null && draft.nodes[node.parentId]?.chordId !== node.chordId) node.parentId = null;
    }
    const moves = new Map<NodeId, ChordId>();
    for (const was of deleted!.moved ?? []) {
      const node = draft.nodes[was.id];
      if (node && node.kind === was.kind && node.chordId !== was.chordId && draft.chords[was.chordId]) moves.set(was.id, node.chordId);
    }
    const land = moving(draft, moves, ctx, effects);
    for (const was of deleted!.moved ?? []) {
      const node = draft.nodes[was.id];
      if (!node || node.kind !== was.kind || !draft.chords[was.chordId]) continue;
      const put = copy(was);
      if (put.parentId !== null && draft.nodes[put.parentId]?.chordId !== put.chordId) put.parentId = null;
      // A tab keeps where it's got to since (its page, title and icon); it goes back to its place, and its pinned home.
      draft.nodes[was.id] = node.kind === 'tab' && put.kind === 'tab' ? { ...put, url: node.url, title: node.title, favicon: node.favicon, lastActiveAt: node.lastActiveAt } : put;
    }
    land();
  }
  if (back[0]) switchChord(draft, windowId, back[0], ctx, effects);
}

/** Whether `parent` can hold `node` here (syncIn's rule): of its chord, in Pinned, a folder (or a split, for a tab), never inside it. */
function holds(state: State, parent: SidebarNode | undefined, node: SidebarNode): boolean {
  return Boolean(
    parent &&
      parent.id !== node.id &&
      parent.chordId === node.chordId &&
      parent.section === 'pinned' &&
      (parent.kind === 'folder' || (parent.kind === 'split' && node.kind === 'tab')) &&
      !isWithin(state, parent.id, node.id),
  );
}

/**
 * `sync.apply`: what other computers changed, checked again here (main's
 * boundary) as `data.merge` checks a file's, then what they took away. Things
 * are put first, all of them, then each one's place is checked (a parent that
 * holds it, of its chord, never inside itself), so the order they come in
 * doesn't decide where they land. No Undo: these are changes you made
 * elsewhere.
 */
function syncIn(draft: Draft<State>, cmd: Extract<Command, { t: 'sync.apply' }>, ctx: Context, effects: Effect[]): void {
  // What's open here before anything changes: what a deleted chord carries, and what a tombstone moves to Today.
  const openBefore = new Set(Object.keys(draft.live));
  // Chords: a new one is added, with sign-ins of its own if it had them (never a private window's, never ones a chord
  // here has); one you have takes its name, icon, colors and place. Never its sign-ins, never a proxy.
  const profilesHere = new Set(Object.values(draft.chords).map((c) => c.profileId));
  for (const incoming of cmd.chords ?? []) {
    if (incoming.private || isPrivateProfile(incoming.profileId)) continue;
    const { proxy: _proxy, blockingOff: _off, private: _private, ...plain } = incoming;
    const chord = restoreChord({ ...plain, name: incoming.name.trim().slice(0, MAX_CHORD_NAME) || 'Chord' });
    const existing = draft.chords[chord.id];
    if (!existing) {
      if (chord.profileId !== DEFAULT_PROFILE && profilesHere.has(chord.profileId)) chord.profileId = ctx.newId();
      profilesHere.add(chord.profileId);
      draft.chords[chord.id] = chord;
      continue;
    }
    if (existing.private) continue;
    if (existing.name !== chord.name) existing.name = chord.name;
    if (existing.icon !== chord.icon) existing.icon = chord.icon;
    if (JSON.stringify(existing.theme) !== JSON.stringify(chord.theme)) existing.theme = chord.theme;
    if (existing.rank !== chord.rank) existing.rank = chord.rank;
  }

  // Folders, tabs and splits. A tab's address here stays its own (sync carries only its home); a new one opens at its
  // home, unloaded. Its title and icon follow only while it's on its home, since that's what they're of.
  const incoming = (cmd.nodes ?? []).filter((node) => {
    const chord = draft.chords[node.chordId];
    const existing = draft.nodes[node.id];
    if (!chord || chord.private || (existing && (existing.kind !== node.kind || draft.chords[existing.chordId]?.private))) return false;
    if (node.kind === 'folder' && node.section !== 'pinned') return false;
    return node.kind !== 'tab' || (isTabUrl(node.pinnedUrl ?? node.url) && node.section === 'pinned');
  });
  const moves = new Map<NodeId, ChordId>();
  for (const node of incoming) {
    const existing = draft.nodes[node.id];
    if (existing && existing.chordId !== node.chordId) moves.set(node.id, existing.chordId);
  }
  const land = moving(draft, moves, ctx, effects);
  const placed: NodeId[] = [];
  for (const node of incoming) {
    const existing = draft.nodes[node.id];
    if (node.kind === 'tab') {
      const home = node.pinnedUrl ?? node.url;
      const was = existing?.kind === 'tab' ? existing : null;
      const onHome = !was || was.url === (was.pinnedUrl ?? was.url);
      draft.nodes[node.id] = {
        ...node,
        url: was ? was.url : home,
        pinnedUrl: home,
        title: was && !onHome ? was.title : node.title,
        favicon: was && (!onHome || node.favicon === null) ? was.favicon : node.favicon,
        lastActiveAt: was ? was.lastActiveAt : node.lastActiveAt,
        ...(node.muted ? { muted: true } : {}),
      } as TabNode;
      if (was && Boolean(was.muted) !== Boolean(node.muted)) effects.push({ e: 'view.mute', nodeId: node.id, muted: Boolean(node.muted) });
    } else draft.nodes[node.id] = { ...node } as SidebarNode;
    placed.push(node.id);
  }
  // Each one's place, now that everything is in: a parent of its chord that can hold it, and never inside itself.
  for (const id of placed) {
    const node = draft.nodes[id]!;
    if (node.parentId === null) continue;
    if (!holds(draft as State, draft.nodes[node.parentId], node)) node.parentId = null;
  }
  land();

  // Favorites: one you have takes its address, title, icon and place; a new one while the row has room, never twice.
  for (const favorite of cmd.favorites ?? []) {
    if (!/^https?:\/\//i.test(favorite.url)) continue;
    const existing = draft.favorites[favorite.id];
    if (existing) {
      if (Object.values(draft.favorites).some((f) => f.id !== favorite.id && f.url === favorite.url)) continue;
      draft.favorites[favorite.id] = { ...favorite, favicon: favorite.favicon ?? existing.favicon, createdAt: existing.createdAt };
      continue;
    }
    const order = Object.values(draft.favorites);
    if (order.length >= MAX_FAVORITES || order.some((f) => f.url === favorite.url)) continue;
    draft.favorites[favorite.id] = favorite;
  }

  for (const incomingTheme of cmd.themes ?? []) {
    const theme = validTheme(incomingTheme);
    if (!theme) continue;
    const index = draft.settings.themes.findIndex((t) => t.id === theme.id);
    if (index >= 0) {
      if (JSON.stringify(draft.settings.themes[index]) !== JSON.stringify(theme)) draft.settings.themes[index] = theme;
    } else if (draft.settings.themes.length < MAX_THEMES) draft.settings.themes.push(theme);
  }

  for (const route of cmd.routes ?? []) {
    const host = routeKey(route.host);
    const chord = draft.chords[route.chordId];
    if (!host || host !== route.host || !chord || chord.private) continue;
    const existing = draft.linkRoutes[host];
    if (existing?.chordId === chord.id) continue;
    draft.linkRoutes[host] = { host, chordId: chord.id, createdAt: existing?.createdAt ?? route.createdAt };
  }

  // Settings, through settings.set's own checks (main checked the patch with the schema Settings' changes pass).
  if (cmd.settings) run(draft, { t: 'settings.set', settings: cmd.settings }, ctx, effects);

  // What went. A tab another computer unpinned or deleted: an open one moves to the top of Today here, an unloaded one
  // goes. A folder: what's still in it (moved in meanwhile) goes to the top of its section. A split: its panes stay, where it was.
  const gone = cmd.gone ?? {};
  // Chords first: each makes way, with everything in it kept for Undo, and what's only this computer's (what was open
  // here before this apply, whatever sign-ins it lands in) moved to another.
  for (const chordId of gone.chords ?? []) dropChord(draft, chordId, ctx, effects, openBefore);
  // A node's tombstone is about a pinned one: one that's in Today here now (moved out of a chord that went, or unpinned
  // here) is only this computer's, and stays.
  const goneNodes = new Set(
    (gone.nodes ?? []).filter(({ id, kind }) => draft.nodes[id]?.kind === kind && draft.nodes[id]!.section === 'pinned' && !draft.chords[draft.nodes[id]!.chordId]?.private).map(({ id }) => id),
  );
  const leaving = new Set([...goneNodes].filter((id) => draft.nodes[id]?.kind === 'tab' && !openBefore.has(id)));
  const landGone = landWindows(draft, leaving, ctx, effects);
  // Nothing pinned goes without Undo: what's taken away, and what moves because of it, kept per chord in sync's list.
  const kept = new Map<ChordId, { nodes: SidebarNode[]; moved: SidebarNode[] }>();
  const keep = (node: Draft<SidebarNode>, what: 'nodes' | 'moved') => {
    const entry = kept.get(node.chordId) ?? { nodes: [], moved: [] };
    entry[what].push(copy(node));
    kept.set(node.chordId, entry);
  };
  for (const id of goneNodes) {
    const node = draft.nodes[id]!;
    if (node.kind === 'tab') {
      keep(node, openBefore.has(id) ? 'moved' : 'nodes');
      if (openBefore.has(id)) {
        const top = topOfToday(draft, node.chordId);
        node.section = 'today';
        node.parentId = null;
        node.rank = top;
        node.pinnedUrl = null;
      } else delete draft.nodes[id];
      continue;
    }
    const inside = Object.values(draft.nodes).filter((n) => n.parentId === id && !goneNodes.has(n.id));
    keep(node, 'nodes');
    for (const child of inside) keep(child, 'moved');
    if (node.kind === 'split') {
      const siblings = children(draft as State, node.chordId, node.section, node.parentId);
      const at = siblings.findIndex((n) => n.id === node.id);
      const ranks = generateNKeysBetween(siblings[at - 1]?.rank ?? null, siblings[at + 1]?.rank ?? null, inside.length);
      inside.forEach((pane, i) => {
        pane.parentId = node.parentId;
        pane.rank = ranks[i]!;
      });
    } else for (const child of inside) child.parentId = null;
    delete draft.nodes[id];
  }
  landGone();
  for (const [chordId, entry] of kept) {
    const chord = draft.chords[chordId];
    if (!chord) continue;
    draft.syncUndo.unshift({ id: ctx.newId(), chord: copy(chord), nodes: entry.nodes, moved: entry.moved, deletedAt: ctx.now, nodesOnly: true });
  }
  if (draft.syncUndo.length > MAX_SYNC_UNDO) draft.syncUndo.length = MAX_SYNC_UNDO;
  for (const id of gone.favorites ?? []) if (draft.favorites[id]) delete draft.favorites[id];
  for (const id of gone.themes ?? []) {
    const index = draft.settings.themes.findIndex((t) => t.id === id);
    if (index < 0) continue;
    draft.settings.themes.splice(index, 1);
    for (const chord of Object.values(draft.chords)) if (chord.theme.themeId === id) chord.theme.themeId = null;
  }
  for (const host of gone.routes ?? []) if (draft.linkRoutes[host]) delete draft.linkRoutes[host];
}

/** `sync.replace`: this computer's own chords make way for the synced setup (joining with *Use the synced setup*), each kept for Undo. */
function replaceChords(draft: Draft<State>, chordIds: readonly ChordId[], to: ChordId, ctx: Context, effects: Effect[]): void {
  for (const chordId of chordIds) giveWay(draft, chordId, to, ctx, effects);
}

function run(draft: Draft<State>, cmd: Command, ctx: Context, effects: Effect[]): void {
  switch (cmd.t) {
    case 'tab.open': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      // A route sends the site to its chord; a private window keeps everything to itself.
      const routed = cmd.route && !win.private ? routeFor(draft as State, cmd.url) : null;
      const chordId = routed && chordsFor(draft as State, cmd.windowId).some((c) => c.id === routed) ? routed : win.activeChordId;
      const id = ctx.newId();
      const tab: TabNode = {
        kind: 'tab',
        id,
        chordId,
        section: 'today',
        parentId: null,
        rank: topOfToday(draft, chordId),
        url: cmd.url,
        title: '',
        pinnedUrl: null,
        customTitle: null,
        favicon: null,
        lastActiveAt: ctx.now,
        createdAt: ctx.now,
      };
      draft.nodes[id] = tab;
      // First run's "What do you open every day?" lands straight in Pinned (never in a private window).
      if (cmd.pinned && !win.private) moveNode(draft, draft.nodes[id]!, 'pinned', children(draft as State, chordId, 'pinned', null).length);
      draft.live[id] = { ...IDLE_LIVE, loading: true };
      effects.push({ e: 'view.ensure', nodeId: id });
      if (!cmd.background) {
        leave(draft, win, ctx);
        if (win.activeChordId !== chordId) win.activeChordId = chordId;
        activate(draft, cmd.windowId, id, ctx, effects);
      }
      return;
    }

    case 'tab.adopt': {
      const win = draft.windows[cmd.windowId];
      if (!win || draft.nodes[cmd.nodeId]) return;
      const chordId = cmd.chordId ?? win.activeChordId;
      // The window must be allowed to show that chord: a private window only its own, others never a private one.
      if (!chordsFor(draft as State, cmd.windowId).some((c) => c.id === chordId)) return;
      draft.nodes[cmd.nodeId] = {
        kind: 'tab',
        id: cmd.nodeId,
        chordId,
        section: 'today',
        parentId: null,
        rank: topOfToday(draft, chordId),
        url: cmd.url,
        title: cmd.title,
        pinnedUrl: null,
        customTitle: null,
        favicon: cmd.favicon ?? null,
        lastActiveAt: ctx.now,
        createdAt: ctx.now,
      };
      draft.live[cmd.nodeId] = { ...IDLE_LIVE, ...cmd.live };
      leave(draft, win, ctx);
      if (win.activeChordId !== chordId) win.activeChordId = chordId;
      activate(draft, cmd.windowId, cmd.nodeId, ctx, effects);
      return;
    }

    case 'linkRoute.set': {
      const host = routeKey(cmd.host);
      const chord = draft.chords[cmd.chordId];
      if (!host || !chord || chord.private) return;
      const existing = draft.linkRoutes[host];
      if (existing?.chordId === chord.id) return;
      draft.linkRoutes[host] = { host, chordId: chord.id, createdAt: existing?.createdAt ?? ctx.now };
      return;
    }

    case 'linkRoute.delete': {
      const host = routeKey(cmd.host) ?? cmd.host;
      if (draft.linkRoutes[host]) delete draft.linkRoutes[host];
      return;
    }

    case 'tab.activate': {
      const node = draft.nodes[cmd.nodeId];
      const win = draft.windows[cmd.windowId];
      if (node?.kind !== 'tab' || !win) return;
      // A private window shows only its own tabs, and no other window ever shows them.
      if (win.private ? node.chordId !== win.activeChordId : isPrivateChord(draft as State, node.chordId)) return;
      const touch = cmd.touch ?? true;
      if (touch && win.activeTab[win.activeChordId] !== cmd.nodeId) leave(draft, win, ctx);
      if (node.chordId !== win.activeChordId) win.activeChordId = node.chordId;
      activate(draft, cmd.windowId, cmd.nodeId, ctx, effects, touch);
      return;
    }

    case 'tab.close': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab') return;
      // Closing a pane: the split's other panes stay on screen, and the window lands on one of them.
      const split = splitOf(draft as State, node.id);
      const panes = split ? splitMembers(draft as State, split.id).map((t) => t.id) : [];
      const order = tabsInOrder(draft as State, node.chordId);
      const index = order.findIndex((t) => t.id === node.id);
      // Arc's rule: land on the tab below, or above if this was the last one (one no other window shows).
      const isClosing = (t: TabNode) => t.id === node.id;
      const landingFor = (windowId: WindowId) => (split ? paneNeighbor(panes, node.id) : null) ?? nearestFree(draft, order, index, windowId, isClosing);
      // A pinned tab never goes away: closing unloads it and takes it home to its pinned page.
      if (node.section === 'pinned') {
        // A pinned pane leaves its split as it closes, and waits just after it.
        if (split) leaveSplit(draft, node, split as Draft<SplitNode>);
        if (node.pinnedUrl && node.url !== node.pinnedUrl) node.url = node.pinnedUrl;
        delete draft.live[cmd.nodeId];
        effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
        for (const win of Object.values(draft.windows)) {
          if (win.activeTab[node.chordId] !== cmd.nodeId) continue;
          const neighbor = landingFor(win.id);
          if (node.chordId === win.activeChordId) activate(draft, win.id, neighbor, ctx, effects);
          else win.activeTab[node.chordId] = neighbor;
        }
        return;
      }
      // A closed Today tab goes to the archive; ⌘⇧T brings it back to the same place.
      // A private window's tabs never reach the archive: ⌘⇧T remembers them only while it's open.
      const archiveId = isPrivateChord(draft as State, node.chordId) ? null : toArchive(node as TabNode, 'closed', ctx, effects);
      const closed: ClosedTab = { node: { ...(node as TabNode) }, windowId: cmd.windowId, closedAt: ctx.now, archiveId };
      draft.closed.unshift(closed);
      if (draft.closed.length > MAX_CLOSED) draft.closed.length = MAX_CLOSED;
      // The panes left keep their shares relative to each other; ⌘⇧T puts this one back in the split.
      if (split) leaveSplit(draft, node, split as Draft<SplitNode>);
      delete draft.nodes[cmd.nodeId];
      delete draft.live[cmd.nodeId];
      effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
      for (const win of Object.values(draft.windows)) {
        for (const [chordId, tabId] of Object.entries(win.activeTab)) {
          if (tabId !== cmd.nodeId) continue;
          const neighbor = landingFor(win.id);
          if (chordId === win.activeChordId) activate(draft, win.id, neighbor, ctx, effects);
          else win.activeTab[chordId] = neighbor;
        }
      }
      return;
    }

    case 'tab.reopenClosed': {
      const win = draft.windows[cmd.windowId];
      // The newest closed tab from this window's side of the private line.
      const at = reopenableIndex(draft as State, cmd.windowId);
      if (!win || at < 0) return;
      const [entry] = draft.closed.splice(at, 1);
      if (!entry) return;
      // Back where it was if its chord (and folder) still exist; otherwise top of Today.
      const chordExists = Boolean(draft.chords[entry.node.chordId]);
      const parentExists = entry.node.parentId === null || Boolean(draft.nodes[entry.node.parentId]);
      const keepPlace = chordExists && parentExists;
      const chordId = chordExists ? entry.node.chordId : win.activeChordId;
      const restored: TabNode = {
        ...entry.node,
        chordId,
        section: keepPlace ? entry.node.section : 'today',
        parentId: keepPlace ? entry.node.parentId : null,
        rank: keepPlace ? entry.node.rank : topOfToday(draft, chordId),
        lastActiveAt: ctx.now,
      };
      draft.nodes[restored.id] = restored;
      draft.live[restored.id] = { ...IDLE_LIVE, loading: true };
      if (entry.archiveId) effects.push({ e: 'archive.restored', archiveId: entry.archiveId, nodeId: restored.id });
      leave(draft, win, ctx);
      if (win.activeChordId !== chordId) win.activeChordId = chordId;
      activate(draft, cmd.windowId, restored.id, ctx, effects);
      return;
    }

    case 'tab.archive': {
      // Tidying up never takes a tab from under you; Clear can (it's what you asked for).
      const onScreen = cmd.reason === 'auto' ? visibleTabs(draft as State) : new Set<NodeId>();
      // A private window's tabs are never tidied away; Clear closes them without archiving.
      const tabs = cmd.nodeIds
        .map((id) => draft.nodes[id])
        .filter((n): n is Draft<TabNode> => n?.kind === 'tab' && n.section === 'today' && !onScreen.has(n.id))
        .filter((n) => cmd.reason !== 'auto' || !isPrivateChord(draft as State, n.chordId));
      if (tabs.length === 0) return;
      const gone = new Set(tabs.map((t) => t.id));
      // Where each window lands if its tab goes: the nearest tab that stays, below first (Arc's rule).
      const landing = new Map<string, NodeId | null>();
      for (const win of Object.values(draft.windows)) {
        for (const [chordId, tabId] of Object.entries(win.activeTab)) {
          if (!tabId || !gone.has(tabId)) continue;
          const order = tabsInOrder(draft as State, chordId);
          const at = order.findIndex((t) => t.id === tabId);
          landing.set(`${win.id}:${chordId}`, nearestFree(draft, order, at, win.id, (t) => gone.has(t.id)));
        }
      }
      for (const tab of tabs) {
        const archiveId = isPrivateChord(draft as State, tab.chordId) ? null : toArchive(tab as TabNode, cmd.reason, ctx, effects);
        // Clearing is something you did, so ⌘⇧T can undo it; tidying up after idle tabs isn't.
        if (cmd.reason === 'cleared') draft.closed.unshift({ node: { ...(tab as TabNode) }, windowId: '', closedAt: ctx.now, archiveId });
        delete draft.nodes[tab.id];
        delete draft.live[tab.id];
        effects.push({ e: 'view.destroy', nodeId: tab.id });
      }
      // A whole Clear stays undoable, however many tabs it took (its toast's Undo restores them all).
      const keep = Math.max(MAX_CLOSED, cmd.reason === 'cleared' ? tabs.length : 0);
      if (draft.closed.length > keep) draft.closed.length = keep;
      for (const win of Object.values(draft.windows)) {
        for (const chordId of Object.keys(win.activeTab)) {
          const key = `${win.id}:${chordId}`;
          if (!landing.has(key)) continue;
          const next = landing.get(key) ?? null;
          if (chordId === win.activeChordId) activate(draft, win.id, next, ctx, effects);
          else win.activeTab[chordId] = next;
        }
      }
      return;
    }

    case 'archive.restore': {
      const win = draft.windows[cmd.windowId];
      if (!win || win.private || draft.nodes[cmd.nodeId]) return;
      const chordId = draft.chords[cmd.tab.chordId] ? cmd.tab.chordId : win.activeChordId;
      draft.nodes[cmd.nodeId] = {
        kind: 'tab',
        id: cmd.nodeId,
        chordId,
        section: 'today',
        parentId: null,
        rank: topOfToday(draft, chordId),
        url: cmd.tab.url,
        title: cmd.tab.title,
        pinnedUrl: null,
        customTitle: null,
        favicon: cmd.tab.favicon,
        lastActiveAt: ctx.now,
        createdAt: ctx.now,
      };
      // If it's also on the ⌘⇧T list, it isn't closed any more.
      const listed = draft.closed.findIndex((c) => c.archiveId === cmd.tab.id);
      if (listed >= 0) draft.closed.splice(listed, 1);
      effects.push({ e: 'archive.restored', archiveId: cmd.tab.id, nodeId: cmd.nodeId });
      if (cmd.activate) {
        draft.live[cmd.nodeId] = { ...IDLE_LIVE, loading: true };
        leave(draft, win, ctx);
        if (win.activeChordId !== chordId) win.activeChordId = chordId;
        activate(draft, cmd.windowId, cmd.nodeId, ctx, effects);
      }
      return;
    }

    case 'tab.sleep': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || !draft.live[cmd.nodeId]) return;
      if (Object.values(draft.windows).some((w) => shownTabs(draft as State, w.id).includes(cmd.nodeId))) return;
      delete draft.live[cmd.nodeId];
      effects.push({ e: 'view.sleep', nodeId: cmd.nodeId });
      return;
    }

    case 'tab.navigate': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab') return;
      node.url = cmd.url;
      effects.push({ e: 'view.ensure', nodeId: cmd.nodeId }, { e: 'view.navigate', nodeId: cmd.nodeId, url: cmd.url });
      return;
    }

    case 'node.move': {
      const node = draft.nodes[cmd.nodeId];
      // Nothing pins in a private window: it would be forgotten anyway.
      if (cmd.section === 'pinned' && node && isPrivateChord(draft as State, node.chordId)) return;
      if (node) moveNode(draft, node, cmd.section, cmd.index, cmd.parentId ?? null);
      return;
    }

    case 'node.moveToChord': {
      const node = draft.nodes[cmd.nodeId];
      const from = node ? draft.chords[node.chordId] : undefined;
      const to = draft.chords[cmd.chordId];
      if (node?.kind !== 'tab' || !from || !to || from.id === to.id) return;
      // A private window's tabs stay in it, and nothing moves into one (tab.activate refuses the same line).
      if (from.private || to.private) return;
      const land = landWindows(draft, new Set([node.id]), ctx, effects);
      node.chordId = to.id;
      const place = cmd.place;
      const parent = place?.parentId ? draft.nodes[place.parentId] : undefined;
      if (place && (place.parentId === null || (parent?.kind === 'folder' && parent.chordId === to.id))) {
        node.section = place.section;
        node.parentId = place.parentId;
        node.rank = place.rank;
      } else {
        node.parentId = null;
        node.rank =
          node.section === 'pinned' ? rankBetween(children(draft as State, to.id, 'pinned', null).at(-1)?.rank ?? null, null) : topOfToday(draft, to.id);
      }
      if (node.section === 'pinned') node.pinnedUrl ??= node.url;
      else node.pinnedUrl = null;
      // A page can't change session: with different sign-ins it closes, and loads again when shown.
      if (from.profileId !== to.profileId && draft.live[node.id]) {
        delete draft.live[node.id];
        effects.push({ e: 'view.destroy', nodeId: node.id });
      }
      land();
      return;
    }

    case 'folder.create': {
      const chord = draft.chords[cmd.chordId];
      // Folders live in Pinned, which a private window doesn't have.
      if (!chord || chord.private || draft.nodes[cmd.folderId]) return;
      const tab = cmd.tabId ? draft.nodes[cmd.tabId] : undefined;
      if (cmd.tabId && (tab?.kind !== 'tab' || tab.chordId !== chord.id)) return;
      // Where the tab was, if it was pinned; otherwise the end of Pinned.
      const inPlace = tab?.section === 'pinned';
      const folder: FolderNode = {
        kind: 'folder',
        id: cmd.folderId,
        chordId: chord.id,
        section: 'pinned',
        parentId: inPlace ? tab.parentId : null,
        rank: inPlace ? tab.rank : rankBetween(children(draft as State, chord.id, 'pinned', null).at(-1)?.rank ?? null, null),
        title: cmd.title.trim().slice(0, MAX_FOLDER_TITLE) || 'New folder',
        collapsed: false,
        createdAt: ctx.now,
      };
      draft.nodes[folder.id] = folder;
      if (tab) moveNode(draft, tab, 'pinned', 0, folder.id);
      return;
    }

    case 'folder.rename': {
      const folder = draft.nodes[cmd.nodeId];
      const title = cmd.title.trim().slice(0, MAX_FOLDER_TITLE);
      if (folder?.kind === 'folder' && title && folder.title !== title) folder.title = title;
      return;
    }

    case 'folder.toggle': {
      const folder = draft.nodes[cmd.nodeId];
      if (folder?.kind === 'folder' && folder.collapsed !== cmd.collapsed) folder.collapsed = cmd.collapsed;
      return;
    }

    case 'folder.delete': {
      const folder = draft.nodes[cmd.nodeId];
      if (folder?.kind !== 'folder') return;
      const inside = descendants(draft as State, folder.id);
      const land = landWindows(draft, new Set(inside.filter((n) => n.kind === 'tab').map((n) => n.id)), ctx, effects);
      draft.deletedFolders.unshift({ folder: { ...(folder as FolderNode) }, nodes: inside.map((n) => ({ ...n })), deletedAt: ctx.now });
      if (draft.deletedFolders.length > MAX_DELETED_FOLDERS) draft.deletedFolders.length = MAX_DELETED_FOLDERS;
      for (const node of inside) {
        if (node.kind === 'tab' && draft.live[node.id]) effects.push({ e: 'view.destroy', nodeId: node.id });
        delete draft.live[node.id];
        delete draft.nodes[node.id];
      }
      delete draft.nodes[folder.id];
      land();
      return;
    }

    case 'folder.restore': {
      const index = draft.deletedFolders.findIndex((d) => d.folder.id === cmd.nodeId);
      if (index < 0 || draft.nodes[cmd.nodeId]) return;
      const { folder, nodes } = draft.deletedFolders[index]!;
      if (!draft.chords[folder.chordId]) return;
      draft.deletedFolders.splice(index, 1);
      // Back in its place, or at the end of Pinned if the folder it was in has gone too.
      const parentGone = folder.parentId !== null && !draft.nodes[folder.parentId];
      const end = rankBetween(children(draft as State, folder.chordId, 'pinned', null).at(-1)?.rank ?? null, null);
      draft.nodes[folder.id] = parentGone ? { ...folder, parentId: null, rank: end } : folder;
      for (const node of nodes) draft.nodes[node.id] = node;
      return;
    }

    case 'favorite.add': {
      const tab = draft.nodes[cmd.nodeId];
      // Favorites are kept and shared; nothing from a private window becomes one.
      if (tab?.kind !== 'tab' || draft.favorites[cmd.favoriteId] || isPrivateChord(draft as State, tab.chordId)) return;
      const url = tab.pinnedUrl ?? tab.url;
      const order = sortedFavorites(draft as State);
      // Web pages only, one favorite per page, and a sane limit.
      if (!/^https?:/i.test(url) || order.length >= MAX_FAVORITES || order.some((f) => f.url === url)) return;
      const at = Math.max(0, Math.min(cmd.index ?? order.length, order.length));
      draft.favorites[cmd.favoriteId] = {
        id: cmd.favoriteId,
        url,
        title: tab.customTitle ?? tab.title,
        favicon: tab.favicon,
        rank: rankBetween(order[at - 1]?.rank ?? null, order[at]?.rank ?? null),
        createdAt: ctx.now,
      };
      return;
    }

    case 'favorite.remove':
      delete draft.favorites[cmd.favoriteId];
      return;

    case 'favorite.move': {
      const favorite = draft.favorites[cmd.favoriteId];
      if (!favorite) return;
      const order = sortedFavorites(draft as State);
      const others = order.filter((f) => f.id !== favorite.id);
      const at = Math.max(0, Math.min(cmd.index, others.length));
      if (order.findIndex((f) => f.id === favorite.id) === at) return;
      favorite.rank = rankBetween(others[at - 1]?.rank ?? null, others[at]?.rank ?? null);
      return;
    }

    case 'favorite.open': {
      const win = draft.windows[cmd.windowId];
      const favorite = draft.favorites[cmd.favoriteId];
      if (!win || !favorite) return;
      const existing = tabForFavorite(draft as State, win.activeChordId, favorite.url);
      if (!existing) {
        run(draft, { t: 'tab.open', windowId: cmd.windowId, url: favorite.url }, ctx, effects);
        return;
      }
      if (win.activeTab[win.activeChordId] !== existing.id) leave(draft, win, ctx);
      activate(draft, cmd.windowId, existing.id, ctx, effects);
      return;
    }

    case 'closed.restore': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      const wanted = new Set(cmd.nodeIds);
      const entries = draft.closed.filter((c) => wanted.has(c.node.id) && !draft.nodes[c.node.id]);
      if (entries.length === 0) return;
      for (const entry of entries) {
        const { node } = entry;
        const chordExists = Boolean(draft.chords[node.chordId]);
        const keep = chordExists && (node.parentId === null || Boolean(draft.nodes[node.parentId]));
        const chordId = chordExists ? node.chordId : win.activeChordId;
        draft.nodes[node.id] = {
          ...node,
          chordId,
          section: keep ? node.section : 'today',
          parentId: keep ? node.parentId : null,
          rank: keep ? node.rank : topOfToday(draft, chordId),
        };
        if (entry.archiveId) effects.push({ e: 'archive.restored', archiveId: entry.archiveId, nodeId: node.id });
      }
      draft.closed = draft.closed.filter((c) => !wanted.has(c.node.id));
      const shown = cmd.activate ? draft.nodes[cmd.activate] : undefined;
      if (shown?.kind === 'tab' && shown.chordId === win.activeChordId) {
        draft.live[shown.id] = { ...IDLE_LIVE, loading: true };
        leave(draft, win, ctx);
        activate(draft, cmd.windowId, shown.id, ctx, effects);
      }
      return;
    }

    case 'tab.pin': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || node.section === 'pinned' || isPrivateChord(draft as State, node.chordId)) return;
      // A pane pins its whole split: the panes stay together.
      const unit = (splitOf(draft as State, node.id) as Draft<SplitNode> | null) ?? node;
      moveNode(draft, unit, 'pinned', children(draft as State, node.chordId, 'pinned', null).length);
      return;
    }

    case 'tab.unpin': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || node.section !== 'pinned') return;
      moveNode(draft, (splitOf(draft as State, node.id) as Draft<SplitNode> | null) ?? node, 'today', 0);
      return;
    }

    case 'tab.cycle': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      const order = tabsInOrder(draft as State, win.activeChordId);
      if (order.length === 0) return;
      const current = order.findIndex((t) => t.id === win.activeTab[win.activeChordId]);
      const next = order[(current + cmd.direction + order.length) % order.length]!;
      if (next.id !== win.activeTab[win.activeChordId]) leave(draft, win, ctx);
      activate(draft, cmd.windowId, next.id, ctx, effects);
      return;
    }

    case 'tab.mute': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || Boolean(node.muted) === cmd.muted) return;
      if (cmd.muted) node.muted = true;
      else delete node.muted;
      effects.push({ e: 'view.mute', nodeId: cmd.nodeId, muted: cmd.muted });
      return;
    }

    case 'tab.updated': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab') return;
      if (cmd.url !== undefined && node.url !== cmd.url) node.url = cmd.url;
      if (cmd.title !== undefined && node.title !== cmd.title) node.title = cmd.title;
      if (cmd.favicon !== undefined && node.favicon !== cmd.favicon) node.favicon = cmd.favicon;
      return;
    }

    case 'tab.live': {
      if (!draft.nodes[cmd.nodeId]) return;
      const live = (draft.live[cmd.nodeId] ??= { ...IDLE_LIVE });
      for (const [key, value] of Object.entries(cmd.live) as [keyof LiveTab, LiveTab[keyof LiveTab]][]) {
        if (key === 'error') {
          const error = value as LiveTab['error'];
          if (live.error?.code !== error?.code || live.error?.url !== error?.url) live.error = error;
        } else if (key === 'threat') {
          const threat = value as LiveTab['threat'];
          if (live.threat?.kind !== threat?.kind || live.threat?.url !== threat?.url || live.threat?.frameUrl !== threat?.frameUrl) live.threat = threat;
        } else if (live[key] !== value) {
          // The rest are flags, and the page's count (a number, 'dot' or null).
          (live as Record<keyof LiveTab, unknown>)[key] = value;
        }
      }
      return;
    }

    case 'window.create': {
      if (draft.windows[cmd.windowId]) return;
      const from = cmd.from ? draft.windows[cmd.from] : undefined;
      const bounds = from?.bounds ? { ...from.bounds, x: from.bounds.x + CASCADE, y: from.bounds.y + CASCADE, maximized: false } : null;
      let chordId: ChordId | undefined;
      if (cmd.privateChordId) {
        chordId = cmd.privateChordId;
        draft.chords[chordId] = {
          id: chordId,
          profileId: privateProfileId(cmd.windowId),
          name: 'Private',
          icon: '',
          theme: { ...PRIVATE_CHORD_THEME, stops: PRIVATE_CHORD_THEME.stops.map((s) => ({ ...s })) },
          rank: 'z',
          createdAt: ctx.now,
          private: true,
        };
      } else {
        // The chord you're in, or (from a private window) your first one.
        chordId = from && !from.private ? from.activeChordId : sortedChords(draft as State)[0]?.id;
      }
      if (!chordId) return;
      draft.windows[cmd.windowId] = {
        id: cmd.windowId,
        activeChordId: chordId,
        activeTab: { [chordId]: null },
        sidebar: from?.sidebar ?? 'docked',
        sidebarWidth: from?.sidebarWidth ?? SIDEBAR_WIDTH.default,
        bounds,
        ...(cmd.privateChordId ? { private: true } : {}),
      };
      effects.push({ e: 'window.open', windowId: cmd.windowId });
      return;
    }

    case 'window.close': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      delete draft.windows[cmd.windowId];
      if (draft.sharedWindows.includes(cmd.windowId)) draft.sharedWindows = draft.sharedWindows.filter((id) => id !== cmd.windowId);
      if (!win.private) return;
      // Closing a private window forgets everything in it (files it downloaded stay on disk).
      const chordId = win.activeChordId;
      for (const node of Object.values(draft.nodes)) {
        if (node.chordId !== chordId) continue;
        if (node.kind === 'tab') effects.push({ e: 'view.destroy', nodeId: node.id });
        delete draft.nodes[node.id];
        delete draft.live[node.id];
      }
      delete draft.chords[chordId];
      if (draft.closed.some((c) => c.node.chordId === chordId)) draft.closed = draft.closed.filter((c) => c.node.chordId !== chordId);
      for (const d of Object.values(draft.downloads)) if (d.privateWindow === cmd.windowId) delete draft.downloads[d.id];
      return;
    }

    case 'window.bounds': {
      const win = draft.windows[cmd.windowId];
      if (win) win.bounds = cmd.bounds;
      return;
    }

    case 'window.sidebar': {
      const win = draft.windows[cmd.windowId];
      if (!win || win.sidebar === cmd.sidebar) return;
      win.sidebar = cmd.sidebar;
      effects.push({ e: 'window.layout', windowId: cmd.windowId, sidebar: cmd.sidebar, width: win.sidebarWidth, animate: true });
      return;
    }

    case 'window.sidebarWidth': {
      const win = draft.windows[cmd.windowId];
      if (!win || !Number.isFinite(cmd.width)) return;
      const width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, cmd.width)));
      if (win.sidebarWidth === width) return;
      win.sidebarWidth = width;
      effects.push({ e: 'window.layout', windowId: cmd.windowId, sidebar: win.sidebar, width, animate: false });
      return;
    }

    case 'settings.set': {
      const { searchEngine, motion, colorScheme, archiveAfter, sleepTabs, searchSuggestions, checkForUpdates, extensionButtons } = cmd.settings;
      if (extensionButtons !== undefined && draft.settings.extensionButtons !== extensionButtons) draft.settings.extensionButtons = extensionButtons;
      const { googleFree } = cmd.settings;
      if (googleFree !== undefined && draft.settings.googleFree !== googleFree) draft.settings.googleFree = googleFree;
      // Google-free mode searches with anything but Google: choosing Google is ignored, and turning the mode on moves off it.
      if (searchEngine !== undefined && draft.settings.searchEngine !== searchEngine && !(draft.settings.googleFree && searchEngine === 'google')) {
        draft.settings.searchEngine = searchEngine;
      }
      if (draft.settings.googleFree && draft.settings.searchEngine === 'google') draft.settings.searchEngine = GOOGLE_FREE_ENGINE;
      // Safe Browsing's lists come from Google: Google-free mode turns it off and keeps it off.
      // Turning it on means its notice was on screen (it sits beside every switch for it).
      const { safeBrowsing, safeBrowsingAsked } = cmd.settings;
      if (safeBrowsingAsked !== undefined && draft.settings.safeBrowsingAsked !== safeBrowsingAsked) draft.settings.safeBrowsingAsked = safeBrowsingAsked;
      if (safeBrowsing !== undefined && draft.settings.safeBrowsing !== safeBrowsing && !(draft.settings.googleFree && safeBrowsing)) {
        draft.settings.safeBrowsing = safeBrowsing;
        if (safeBrowsing && !draft.settings.safeBrowsingAsked) draft.settings.safeBrowsingAsked = true;
      }
      if (draft.settings.googleFree && draft.settings.safeBrowsing) draft.settings.safeBrowsing = false;
      if (cmd.settings.tabCounts) {
        const { enabled, offSites } = cmd.settings.tabCounts;
        const current = draft.settings.tabCounts;
        if (enabled !== undefined && current.enabled !== enabled) current.enabled = enabled;
        if (offSites) {
          const clean = cleanCountSites(offSites);
          if (clean.join('\n') !== current.offSites.join('\n')) current.offSites = clean;
        }
      }
      if (cmd.settings.adBlocking) {
        const { enabled, offSites } = cmd.settings.adBlocking;
        const current = draft.settings.adBlocking;
        if (enabled !== undefined && current.enabled !== enabled) current.enabled = enabled;
        if (offSites) {
          const clean = cleanOffSites(offSites);
          if (clean.join('\n') !== current.offSites.join('\n')) current.offSites = clean;
        }
      }
      if (archiveAfter !== undefined && draft.settings.archiveAfter !== archiveAfter) draft.settings.archiveAfter = archiveAfter;
      if (sleepTabs !== undefined && draft.settings.sleepTabs !== sleepTabs) draft.settings.sleepTabs = sleepTabs;
      if (searchSuggestions !== undefined && draft.settings.searchSuggestions !== searchSuggestions) draft.settings.searchSuggestions = searchSuggestions;
      if (checkForUpdates !== undefined && draft.settings.checkForUpdates !== checkForUpdates) draft.settings.checkForUpdates = checkForUpdates;
      const { autoPip, pagePreviews, keepScreenshots, uiScale } = cmd.settings;
      if (isUiScale(uiScale) && draft.settings.uiScale !== uiScale) draft.settings.uiScale = uiScale;
      if (autoPip !== undefined && draft.settings.autoPip !== autoPip) draft.settings.autoPip = autoPip;
      const { autoPipDefaultOff } = cmd.settings;
      if (autoPipDefaultOff !== undefined && draft.settings.autoPipDefaultOff !== autoPipDefaultOff) draft.settings.autoPipDefaultOff = autoPipDefaultOff;
      if (pagePreviews !== undefined && draft.settings.pagePreviews !== pagePreviews) draft.settings.pagePreviews = pagePreviews;
      const { presentingHidesSidebar, sidebarPeek } = cmd.settings;
      if (presentingHidesSidebar !== undefined && draft.settings.presentingHidesSidebar !== presentingHidesSidebar) {
        draft.settings.presentingHidesSidebar = presentingHidesSidebar;
      }
      if (sidebarPeek !== undefined && draft.settings.sidebarPeek !== sidebarPeek) draft.settings.sidebarPeek = sidebarPeek;
      if (keepScreenshots !== undefined && draft.settings.keepScreenshots !== keepScreenshots) draft.settings.keepScreenshots = keepScreenshots;
      const { encryptExports } = cmd.settings;
      if (encryptExports !== undefined && draft.settings.encryptExports !== encryptExports) draft.settings.encryptExports = encryptExports;
      if (colorScheme !== undefined && draft.settings.colorScheme !== colorScheme) draft.settings.colorScheme = colorScheme;
      if (cmd.settings.duet) {
        const duet = cmd.settings.duet;
        const current = draft.settings.duet;
        if (duet.enabled !== undefined && current.enabled !== duet.enabled) current.enabled = duet.enabled;
        if (duet.provider !== undefined && current.provider !== duet.provider) current.provider = duet.provider;
        if (duet.model !== undefined && current.model !== duet.model) current.model = duet.model;
        if (duet.keep !== undefined && current.keep !== duet.keep) current.keep = duet.keep;
        if (duet.scope !== undefined && current.scope !== duet.scope) current.scope = duet.scope;
        if (duet.readsNothing !== undefined && current.readsNothing !== duet.readsNothing) current.readsNothing = duet.readsNothing;
        if (duet.neverSites) current.neverSites = [...new Set(duet.neverSites)];
        if (duet.offChords) current.offChords = [...new Set(duet.offChords)];
        if (duet.codexImages !== undefined && current.codexImages !== duet.codexImages) current.codexImages = duet.codexImages;
      }
      const { separateSignIns, onboarded } = cmd.settings;
      if (separateSignIns !== undefined && draft.settings.separateSignIns !== separateSignIns) draft.settings.separateSignIns = separateSignIns;
      if (onboarded !== undefined && draft.settings.onboarded !== onboarded) draft.settings.onboarded = onboarded;
      for (const [key, value] of Object.entries(motion ?? {}) as [keyof typeof draft.settings.motion, boolean | undefined][]) {
        if (value !== undefined && draft.settings.motion[key] !== value) draft.settings.motion[key] = value;
      }
      for (const [key, value] of Object.entries(cmd.settings.interface ?? {}) as [keyof typeof draft.settings.interface, number | undefined][]) {
        if (value !== undefined && draft.settings.interface[key] !== clamp01(value)) draft.settings.interface[key] = clamp01(value);
      }
      const { externalLinks, miniWindowSize } = cmd.settings;
      if (externalLinks !== undefined && draft.settings.externalLinks !== externalLinks) draft.settings.externalLinks = externalLinks;
      if (miniWindowSize !== undefined) {
        const size = miniWindowSize && { width: clampSize(miniWindowSize.width), height: clampSize(miniWindowSize.height) };
        const same = size && draft.settings.miniWindowSize?.width === size.width && draft.settings.miniWindowSize.height === size.height;
        if (!same && !(size === null && draft.settings.miniWindowSize === null)) draft.settings.miniWindowSize = size;
      }
      // Reader view's controls: only steps and choices it has.
      if (cmd.settings.reader) {
        const next = cleanReaderSettings(draft.settings.reader, cmd.settings.reader);
        const current = draft.settings.reader;
        if (current.size !== next.size) current.size = next.size;
        if (current.width !== next.width) current.width = next.width;
        if (current.theme !== next.theme) current.theme = next.theme;
        if (current.font !== next.font) current.font = next.font;
      }
      if (cmd.settings.effects?.wet !== undefined && draft.settings.effects.wet !== cmd.settings.effects.wet) draft.settings.effects.wet = cmd.settings.effects.wet;
      // Developer tools: a side Chord has, and sizes in range.
      if (cmd.settings.devtools) {
        const next = cleanDevtoolsSettings(draft.settings.devtools, cmd.settings.devtools);
        const current = draft.settings.devtools;
        if (current.side !== next.side) current.side = next.side;
        if (current.width !== next.width) current.width = next.width;
        if (current.height !== next.height) current.height = next.height;
        if (current.window !== next.window) current.window = next.window;
      }
      // The proxy for every chord: the whole of it, or nothing if it can't be used.
      const proxy = cmd.settings.proxy === undefined ? null : cleanProxy(cmd.settings.proxy);
      if (proxy && !sameProxy(draft.settings.proxy, proxy)) draft.settings.proxy = proxy;
      const { spellcheck } = cmd.settings;
      if (spellcheck?.enabled !== undefined && draft.settings.spellcheck.enabled !== spellcheck.enabled) draft.settings.spellcheck.enabled = spellcheck.enabled;
      if (spellcheck?.language !== undefined && draft.settings.spellcheck.language !== spellcheck.language) draft.settings.spellcheck.language = spellcheck.language;
      // Shortcuts: each listed action gets its new keys (checked again here), or null goes back to the registry's.
      for (const [id, keys] of Object.entries(cmd.settings.shortcuts ?? {}) as [ActionId, readonly string[] | null | undefined][]) {
        if (keys === undefined || !shortcutById(id)) continue;
        if (keys === null) delete draft.settings.shortcuts[id];
        else draft.settings.shortcuts[id] = cleanKeys(id, keys);
      }
      return;
    }

    case 'presenting.set': {
      if (cmd.by === 'you') {
        const next = cmd.on ? 'you' : null;
        if (draft.presenting !== next) draft.presenting = next;
      } else if (cmd.on) {
        draft.presenting ??= 'share';
      } else if (draft.presenting === 'share') {
        draft.presenting = null;
      }
      return;
    }

    case 'sharing.windows': {
      const ids = [...new Set(cmd.windowIds)].filter((id) => draft.windows[id]).sort();
      if (ids.join(' ') !== draft.sharedWindows.join(' ')) draft.sharedWindows = ids;
      return;
    }

    case 'theme.save': {
      const theme: CustomTheme = { ...cmd.theme, name: cmd.theme.name.trim().slice(0, 40) || 'Untitled', grain: clamp01(cmd.theme.grain) };
      const index = draft.settings.themes.findIndex((t) => t.id === theme.id);
      if (index >= 0) draft.settings.themes[index] = theme;
      else if (draft.settings.themes.length < MAX_THEMES) draft.settings.themes.push(theme);
      else return;
      // Chords made from this theme follow its edits.
      for (const chord of Object.values(draft.chords)) {
        if (chord.theme.themeId !== theme.id) continue;
        chord.theme.stops = theme.stops;
        chord.theme.grain = theme.grain;
      }
      return;
    }

    case 'theme.delete': {
      const index = draft.settings.themes.findIndex((t) => t.id === cmd.id);
      if (index < 0) return;
      draft.settings.themes.splice(index, 1);
      for (const chord of Object.values(draft.chords)) if (chord.theme.themeId === cmd.id) chord.theme.themeId = null;
      return;
    }

    case 'chord.create': {
      const win = draft.windows[cmd.windowId];
      if (!win || win.private) return;
      const last = sortedChords(draft as State).at(-1);
      const id = ctx.newId();
      draft.chords[id] = {
        id,
        profileId: draft.settings.separateSignIns ? ctx.newId() : DEFAULT_PROFILE,
        name: cmd.name.trim().slice(0, MAX_CHORD_NAME) || 'New chord',
        icon: cmd.icon,
        theme: cmd.theme,
        rank: generateKeyBetween(last?.rank ?? null, null),
        createdAt: ctx.now,
      };
      win.activeTab[id] = null;
      switchChord(draft, cmd.windowId, id, ctx, effects);
      return;
    }

    case 'chord.activate':
      switchChord(draft, cmd.windowId, cmd.chordId, ctx, effects);
      return;

    case 'chord.cycle': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      const order = chordsFor(draft as State, cmd.windowId);
      const current = order.findIndex((c) => c.id === win.activeChordId);
      const next = order[(current + cmd.direction + order.length) % order.length];
      if (next) switchChord(draft, cmd.windowId, next.id, ctx, effects);
      return;
    }

    case 'chord.goto': {
      const order = chordsFor(draft as State, cmd.windowId);
      const target = cmd.index >= 8 ? order.at(-1) : order[cmd.index];
      if (target) switchChord(draft, cmd.windowId, target.id, ctx, effects);
      return;
    }

    case 'chord.update': {
      const chord = draft.chords[cmd.chordId];
      if (!chord) return;
      const name = cmd.name?.trim().slice(0, MAX_CHORD_NAME);
      if (name && chord.name !== name) chord.name = name;
      if (cmd.icon && chord.icon !== cmd.icon) chord.icon = cmd.icon;
      return;
    }

    case 'chord.profile': {
      const chord = draft.chords[cmd.chordId];
      if (!chord || chord.private || chord.profileId === cmd.profileId) return;
      changeProfile(draft, chord, cmd.profileId, effects);
      return;
    }

    case 'chord.proxy': {
      const chord = draft.chords[cmd.chordId];
      if (!chord || chord.private) return;
      const proxy = cmd.proxy === null ? null : cleanProxy(cmd.proxy);
      const profileId = cmd.profileId ?? chord.profileId;
      if ((cmd.proxy !== null && !proxy) || (proxy && profileId === DEFAULT_PROFILE)) return;
      if (profileId !== chord.profileId) changeProfile(draft, chord, profileId, effects);
      if (proxy && !sameProxy(chord.proxy, proxy)) chord.proxy = proxy;
      else if (!proxy && chord.proxy) delete chord.proxy;
      return;
    }

    case 'chord.delete': {
      const order = sortedChords(draft as State);
      const index = order.findIndex((c) => c.id === cmd.chordId);
      if (index < 0 || order.length < 2) return;
      const neighbor = (order[index + 1] ?? order[index - 1])!;
      for (const win of Object.values(draft.windows)) {
        if (win.activeChordId === cmd.chordId) switchChord(draft, win.id, neighbor.id, ctx, effects);
        delete win.activeTab[cmd.chordId];
      }
      const nodes = Object.values(draft.nodes).filter((n) => n.chordId === cmd.chordId);
      draft.deletedChords.unshift({ chord: { ...draft.chords[cmd.chordId]! }, nodes: nodes.map((n) => ({ ...n })), deletedAt: ctx.now });
      if (draft.deletedChords.length > MAX_DELETED_CHORDS) draft.deletedChords.length = MAX_DELETED_CHORDS;
      for (const node of nodes) {
        if (node.kind === 'tab') effects.push({ e: 'view.destroy', nodeId: node.id });
        delete draft.nodes[node.id];
        delete draft.live[node.id];
      }
      delete draft.chords[cmd.chordId];
      return;
    }

    case 'chord.restore': {
      const index = draft.deletedChords.findIndex((d) => d.chord.id === cmd.chordId);
      if (index < 0 || draft.chords[cmd.chordId]) return;
      const [deleted] = draft.deletedChords.splice(index, 1);
      draft.chords[cmd.chordId] = deleted!.chord;
      for (const node of deleted!.nodes) draft.nodes[node.id] = node;
      switchChord(draft, cmd.windowId, cmd.chordId, ctx, effects);
      return;
    }

    case 'download.update': {
      // A private window's download that finishes after the window closed stays forgotten.
      if (cmd.download.privateWindow && !draft.windows[cmd.download.privateWindow]) return;
      const current = draft.downloads[cmd.download.id];
      if (current && JSON.stringify(current) === JSON.stringify(cmd.download)) return;
      draft.downloads[cmd.download.id] = cmd.download;
      const finished = Object.values(draft.downloads)
        .filter((d) => d.state !== 'progressing' && d.state !== 'paused')
        .sort((a, b) => b.startedAt - a.startedAt);
      for (const old of finished.slice(MAX_DOWNLOADS)) delete draft.downloads[old.id];
      return;
    }

    case 'download.remove':
      delete draft.downloads[cmd.id];
      return;

    case 'download.clear': {
      const priv = Boolean(draft.windows[cmd.windowId]?.private);
      for (const d of Object.values(draft.downloads)) {
        const listed = priv ? d.privateWindow === cmd.windowId : !d.privateWindow;
        if (listed && d.state !== 'progressing' && d.state !== 'paused') delete draft.downloads[d.id];
      }
      return;
    }

    case 'extension.record': {
      const key = extensionKey(cmd.extension.profileId, cmd.extension.id);
      const current = draft.extensions[key];
      if (current && JSON.stringify(current) === JSON.stringify(cmd.extension)) return;
      draft.extensions[key] = cmd.extension;
      return;
    }

    case 'extension.forget': {
      const key = extensionKey(cmd.profileId, cmd.id);
      const removed = draft.extensions[key];
      if (!removed) return;
      delete draft.extensions[key];
      draft.removedExtensions = [removed, ...draft.removedExtensions.filter((e) => extensionKey(e.profileId, e.id) !== key)].slice(0, MAX_REMOVED_EXTENSIONS);
      return;
    }

    case 'extension.restore': {
      const key = extensionKey(cmd.profileId, cmd.id);
      const removed = draft.removedExtensions.find((e) => extensionKey(e.profileId, e.id) === key);
      if (!removed || draft.extensions[key]) return;
      draft.extensions[key] = removed;
      draft.removedExtensions = draft.removedExtensions.filter((e) => e !== removed);
      return;
    }

    case 'extension.pin': {
      const ext = draft.extensions[extensionKey(cmd.profileId, cmd.id)];
      if (ext && ext.pinned !== cmd.pinned) ext.pinned = cmd.pinned;
      return;
    }

    case 'permission.set': {
      const site = (draft.sitePermissions[cmd.origin] ??= {});
      for (const permission of cmd.permissions) {
        if (cmd.decision === null) delete site[permission];
        else if (site[permission] !== cmd.decision) site[permission] = cmd.decision;
      }
      if (Object.keys(site).length === 0) delete draft.sitePermissions[cmd.origin];
      return;
    }

    case 'permission.forget':
      delete draft.sitePermissions[cmd.origin];
      return;

    case 'zoom.set': {
      if (!cmd.host) return;
      const factor = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cmd.factor));
      // Chromium's zoom steps aren't exact; anything this close to 100% is 100%.
      if (Math.abs(factor - 1) < 0.001) delete draft.siteZoom[cmd.host];
      else if (draft.siteZoom[cmd.host] !== factor) draft.siteZoom[cmd.host] = factor;
      return;
    }

    case 'tabCounts.site': {
      const site = countSite(cmd.site);
      const saved = draft.settings.tabCounts;
      if (!site || saved.offSites.includes(site) === cmd.off) return;
      saved.offSites = cmd.off ? cleanCountSites([...saved.offSites, site]) : saved.offSites.filter((s) => s !== site);
      return;
    }

    case 'adBlocking.site': {
      const site = blockingSite(cmd.site);
      if (!site) return;
      const chord = cmd.chordId ? draft.chords[cmd.chordId] : undefined;
      const inPrivate = chord?.private === true;
      const saved = draft.settings.adBlocking;
      const own = inPrivate ? (chord.blockingOff ?? []) : [];
      const isOff = saved.offSites.includes(site) || own.includes(site);
      if (isOff === cmd.off) return;
      if (cmd.off && inPrivate) chord.blockingOff = [...own, site];
      else if (cmd.off) saved.offSites = cleanOffSites([...saved.offSites, site]);
      else {
        if (inPrivate && own.includes(site)) chord.blockingOff = own.filter((s) => s !== site);
        if (saved.offSites.includes(site)) saved.offSites = saved.offSites.filter((s) => s !== site);
      }
      effects.push({ e: 'site.reload', site, chordId: inPrivate ? chord.id : null });
      return;
    }

    case 'chord.theme': {
      const theme = draft.chords[cmd.chordId]?.theme;
      if (!theme) return;
      const { stops, grain, appearance, themeId } = cmd.theme;
      if (stops) theme.stops = stops;
      if (grain !== undefined && theme.grain !== grain) theme.grain = clamp01(grain);
      if (appearance && theme.appearance !== appearance) theme.appearance = appearance;
      if (themeId !== undefined && theme.themeId !== themeId) theme.themeId = themeId;
      return;
    }

    case 'split.add': {
      const win = draft.windows[cmd.windowId];
      const beside = draft.nodes[cmd.withId];
      if (!win || beside?.kind !== 'tab' || beside.chordId !== win.activeChordId) return;
      let split = splitOf(draft as State, beside.id) as Draft<SplitNode> | null;
      const existing = cmd.nodeId ? draft.nodes[cmd.nodeId] : undefined;
      if (cmd.nodeId && (existing?.kind !== 'tab' || existing.chordId !== beside.chordId || existing.id === beside.id)) return;
      if (!cmd.nodeId && !cmd.url) return;
      // A split holds four panes at most (a pane moving within it is fine).
      if (split && existing?.parentId !== split.id && splitMembers(draft as State, split.id).length >= SPLIT.maxPanes) return;
      let tab = existing as Draft<TabNode> | undefined;
      if (!tab) {
        const id = ctx.newId();
        draft.nodes[id] = {
          kind: 'tab',
          id,
          chordId: beside.chordId,
          section: beside.section,
          parentId: null,
          rank: topOfToday(draft, beside.chordId),
          url: cmd.url!,
          title: '',
          pinnedUrl: null,
          customTitle: null,
          favicon: null,
          lastActiveAt: ctx.now,
          createdAt: ctx.now,
        };
        draft.live[id] = { ...IDLE_LIVE, loading: true };
        effects.push({ e: 'view.ensure', nodeId: id });
        tab = draft.nodes[id] as Draft<TabNode>;
      }
      // Out of any other split first (that one settles afterwards).
      const from = splitOf(draft as State, tab.id) as Draft<SplitNode> | null;
      if (from && from.id !== split?.id) leaveSplit(draft, tab, from);
      if (!split) {
        // A new split takes the place of the tab it's made beside.
        const id = ctx.newId();
        draft.nodes[id] = {
          kind: 'split',
          id,
          chordId: beside.chordId,
          section: beside.section,
          parentId: beside.parentId,
          rank: beside.rank,
          direction: cmd.direction ?? 'row',
          sizes: [1],
          createdAt: ctx.now,
        };
        beside.parentId = id;
        beside.rank = generateKeyBetween(null, null);
        split = draft.nodes[id] as Draft<SplitNode>;
      }
      joinSplit(draft, tab, split, cmd.index ?? SPLIT.maxPanes);
      leave(draft, win, ctx);
      activate(draft, cmd.windowId, tab.id, ctx, effects);
      return;
    }

    case 'split.resize': {
      const split = draft.nodes[cmd.splitId];
      if (split?.kind !== 'split') return;
      const n = splitMembers(draft as State, split.id).length;
      if (cmd.sizes.length !== n) return;
      const sizes = normalizeSizes(cmd.sizes, n);
      if (sizes.every((s, i) => Math.abs(s - (split.sizes[i] ?? 0)) < 1e-4)) return;
      split.sizes = sizes;
      return;
    }

    case 'split.remove': {
      const node = draft.nodes[cmd.nodeId];
      const split = node ? (splitOf(draft as State, node.id) as Draft<SplitNode> | null) : null;
      if (node?.kind !== 'tab' || !split) return;
      leaveSplit(draft, node, split);
      return;
    }

    case 'split.separate': {
      const split = draft.nodes[cmd.splitId];
      if (split?.kind !== 'split') return;
      // The panes take the split's place, in order.
      const panes = splitMembers(draft as State, split.id);
      const siblings = children(draft as State, split.chordId, split.section, split.parentId);
      const at = siblings.findIndex((n) => n.id === split.id);
      const ranks = generateNKeysBetween(siblings[at - 1]?.rank ?? null, siblings[at + 1]?.rank ?? null, panes.length);
      panes.forEach((pane, i) => {
        pane.parentId = split.parentId;
        pane.rank = ranks[i]!;
      });
      delete draft.nodes[split.id];
      return;
    }

    case 'split.join': {
      const win = draft.windows[cmd.windowId];
      const tabs = cmd.nodeIds.map((id) => draft.nodes[id]).filter((n): n is Draft<TabNode> => n?.kind === 'tab');
      const first = tabs[0];
      if (!win || !first || tabs.length < 2 || tabs.length > SPLIT.maxPanes || draft.nodes[cmd.splitId]) return;
      if (tabs.some((t) => t.chordId !== first.chordId)) return;
      for (const tab of tabs) {
        const from = splitOf(draft as State, tab.id) as Draft<SplitNode> | null;
        if (from) leaveSplit(draft, tab, from);
      }
      draft.nodes[cmd.splitId] = {
        kind: 'split',
        id: cmd.splitId,
        chordId: first.chordId,
        section: first.section,
        parentId: first.parentId,
        rank: first.rank,
        direction: cmd.direction,
        sizes: normalizeSizes(cmd.sizes ?? equalSizes(tabs.length), tabs.length),
        createdAt: ctx.now,
      };
      const ranks = generateNKeysBetween(null, null, tabs.length);
      tabs.forEach((tab, i) => {
        tab.parentId = cmd.splitId;
        tab.rank = ranks[i]!;
        if (tab.section !== first.section) {
          tab.section = first.section;
          tab.pinnedUrl = first.section === 'pinned' ? (tab.pinnedUrl ?? tab.url) : null;
        }
      });
      const focus = cmd.focus && tabs.some((t) => t.id === cmd.focus) ? cmd.focus : first.id;
      if (win.activeChordId !== first.chordId) return;
      leave(draft, win, ctx);
      activate(draft, cmd.windowId, focus, ctx, effects);
      return;
    }

    case 'split.focus': {
      const win = draft.windows[cmd.windowId];
      const active = win ? win.activeTab[win.activeChordId] : null;
      const split = active ? splitOf(draft as State, active) : null;
      if (!win || !active || !split) return;
      const panes = splitMembers(draft as State, split.id);
      const at = panes.findIndex((p) => p.id === active);
      const next = panes[at + cmd.direction];
      if (!next) return;
      leave(draft, win, ctx);
      activate(draft, cmd.windowId, next.id, ctx, effects);
      return;
    }

    case 'import.add': {
      const record = (draft.imports[cmd.importId] ??= { chordIds: [], nodeIds: [], favoriteIds: [] });
      for (const chord of cmd.chords ?? []) {
        if (draft.chords[chord.id] || chord.private) continue;
        draft.chords[chord.id] = chord;
        record.chordIds.push(chord.id);
      }
      const made = new Set(record.chordIds);
      for (const node of cmd.nodes ?? []) {
        const chord = draft.chords[node.chordId];
        // Never into a private window's chord; folders only in Pinned; no splits.
        if (!chord || chord.private || draft.nodes[node.id] || node.kind === 'split' || (node.kind === 'folder' && node.section !== 'pinned')) continue;
        if (node.parentId !== null) {
          // Parents arrive before their children, in this command or an earlier one.
          const parent = draft.nodes[node.parentId];
          if (parent?.kind !== 'folder' || parent.chordId !== node.chordId) continue;
        }
        draft.nodes[node.id] = node.kind === 'tab' && node.section === 'pinned' ? { ...node, pinnedUrl: node.pinnedUrl ?? node.url } : node;
        // Undo removes the chords it made whole; elsewhere it needs the tops of what it added.
        if (node.parentId === null && !made.has(node.chordId)) record.nodeIds.push(node.id);
      }
      for (const favorite of cmd.favorites ?? []) {
        const order = Object.values(draft.favorites);
        if (draft.favorites[favorite.id] || !/^https?:/i.test(favorite.url) || order.length >= MAX_FAVORITES || order.some((f) => f.url === favorite.url)) continue;
        draft.favorites[favorite.id] = favorite;
        record.favoriteIds.push(favorite.id);
      }
      return;
    }

    case 'data.merge':
      mergeIn(draft, cmd, ctx, effects);
      return;

    case 'sync.apply':
      syncIn(draft, cmd, ctx, effects);
      return;

    case 'sync.replace':
      replaceChords(draft, cmd.chordIds, cmd.to, ctx, effects);
      return;

    case 'sync.unreplace':
      unreplace(draft, cmd.windowId, cmd.chordIds, ctx, effects);
      return;

    case 'import.undo': {
      const record = draft.imports[cmd.importId];
      if (!record) return;
      // A Chord file's: what it updated goes back first, in one part (merge.ts keeps it small), then what it added goes.
      if (record.merged && !record.merged.restored) putBack(draft, record.merged, ctx, effects);
      const order = sortedChords(draft as State);
      const gone = new Set(record.chordIds.filter((id) => draft.chords[id]));
      // There's always a chord to land on (the import never removes one it didn't make).
      if (order.every((c) => gone.has(c.id))) gone.clear();
      // What it added: its chords' trees, and what it put at the top of chords you had, with everything
      // inside. Listed parents first (breadth-first, through one index of the tree), taken children first,
      // so a part never leaves anything without its folder.
      const inside = new Map<NodeId, NodeId[]>();
      const roots: NodeId[] = record.nodeIds.filter((id) => draft.nodes[id] && !gone.has(draft.nodes[id]!.chordId));
      for (const node of Object.values(draft.nodes)) {
        if (!node.parentId) {
          if (gone.has(node.chordId)) roots.push(node.id);
          continue;
        }
        const list = inside.get(node.parentId);
        if (list) list.push(node.id);
        else inside.set(node.parentId, [node.id]);
      }
      const listed: NodeId[] = [];
      const seen = new Set<NodeId>();
      for (let i = 0, queue = roots; i < queue.length; i++) {
        const id = queue[i]!;
        if (seen.has(id)) continue;
        seen.add(id);
        listed.push(id);
        queue.push(...(inside.get(id) ?? []));
      }
      const part = listed.reverse().slice(0, cmd.limit ?? listed.length);
      // Windows on a chord that goes move to the nearest one that stays (the first part does it).
      for (const win of Object.values(draft.windows)) {
        if (!gone.has(win.activeChordId)) continue;
        const at = order.findIndex((c) => c.id === win.activeChordId);
        const next = order.slice(at + 1).find((c) => !gone.has(c.id)) ?? order.slice(0, Math.max(0, at)).reverse().find((c) => !gone.has(c.id));
        if (next) switchChord(draft, win.id, next.id, ctx, effects);
      }
      const land = landWindows(draft, new Set(part.filter((id) => draft.nodes[id]?.kind === 'tab')), ctx, effects);
      for (const id of part) {
        if (draft.nodes[id]?.kind === 'tab' && draft.live[id]) effects.push({ e: 'view.destroy', nodeId: id });
        delete draft.live[id];
        delete draft.nodes[id];
      }
      land();
      if (part.length < listed.length) return;
      // The last part: the chords themselves, their routes, the favorites, and the record.
      for (const chordId of gone) {
        delete draft.chords[chordId];
        for (const win of Object.values(draft.windows)) delete win.activeTab[chordId];
        for (const [host, route] of Object.entries(draft.linkRoutes)) if (route.chordId === chordId) delete draft.linkRoutes[host];
      }
      for (const id of record.favoriteIds) delete draft.favorites[id];
      delete draft.imports[cmd.importId];
      return;
    }

    case 'effects.undo':
      // Main's: the store holds no Effects.
      return;

    case 'sync.undo':
    case 'sync.open':
      // Main's: sync's pending steps and Settings live outside the store.
      return;

    case 'duet.undoFill':
      // Main's: what a fill replaced stays in the page.
      return;
  }
}
