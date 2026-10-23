/**
 * The reducer (ARCHITECTURE.md §6.1). Pure and deterministic given `ctx`, so
 * renderers can apply commands optimistically and land on the same state.
 * Returns Immer patches (for mirrors and persistence) and effects (for main to
 * carry out against real WebContentsViews).
 */
import { generateKeyBetween } from 'fractional-indexing';
import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { cleanKeys } from './bindings';
import { isInternalUrl, visibleTabs } from './idle';
import {
  DEFAULT_PROFILE,
  IDLE_LIVE,
  MAX_ZOOM,
  MIN_ZOOM,
  SIDEBAR_WIDTH,
  PRIVATE_CHORD_THEME,
  extensionKey,
  privateProfileId,
  type ArchivedTab,
  type ArchiveReason,
  type Bounds,
  type ChordId,
  type ChordThemeSpec,
  type ClosedTab,
  type CustomTheme,
  type Download,
  type FolderNode,
  type InstalledExtension,
  type LiveTab,
  type NodeId,
  type PermissionDecision,
  type ProfileId,
  type Section,
  type SidebarNode,
  type SitePermission,
  type SettingsPatch,
  type State,
  type TabNode,
  type WindowId,
  type WindowModel,
} from './model';
import { shortcutById, type ActionId } from './shortcuts';
import { children, chordsFor, descendants, isPrivateChord, isWithin, reopenableIndex, sortedChords, sortedFavorites, tabForFavorite, tabsInOrder } from './select';

enablePatches();

export type Command =
  | { t: 'tab.open'; windowId: WindowId; url: string; background?: boolean; pinned?: boolean }
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
  | { t: 'chord.theme'; chordId: ChordId; theme: Partial<ChordThemeSpec> }
  /** A new chord after the others, switched to in this window. */
  | { t: 'chord.create'; windowId: WindowId; name: string; icon: string; theme: ChordThemeSpec }
  | { t: 'chord.activate'; windowId: WindowId; chordId: ChordId }
  /** Next or previous chord in the switcher, wrapping around. */
  | { t: 'chord.cycle'; windowId: WindowId; direction: 1 | -1 }
  /** ⌘1–⌘8 go to that chord; ⌘9 always goes to the last one, as tab shortcuts do in Chrome. */
  | { t: 'chord.goto'; windowId: WindowId; index: number }
  | { t: 'chord.update'; chordId: ChordId; name?: string; icon?: string }
  /** Which sign-ins a chord uses: DEFAULT_PROFILE to share, or a profile of its own. Its open tabs reload into it. */
  | { t: 'chord.profile'; chordId: ChordId; profileId: ProfileId }
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

export type Effect =
  /** Make sure a view exists for this tab (created lazily, loading `url`). */
  | { e: 'view.ensure'; nodeId: NodeId }
  /** Show this tab (or nothing) in the window's content frame. */
  | { e: 'view.show'; windowId: WindowId; nodeId: NodeId | null }
  | { e: 'view.navigate'; nodeId: NodeId; url: string }
  | { e: 'view.destroy'; nodeId: NodeId }
  /** Close the tab's page but keep its back/forward history and scroll position for when it's shown again. */
  | { e: 'view.sleep'; nodeId: NodeId }
  /** A tab is going to the archive: save it, with its history, before its view is destroyed. */
  | { e: 'archive.save'; nodeId: NodeId; tab: ArchivedTab }
  /** A tab came back from the archive: its saved history goes into the new view, and the entry leaves the archive. */
  | { e: 'archive.restored'; archiveId: string; nodeId: NodeId }
  /** The window's sidebar docked or collapsed, or changed width: lay the content frame out again. */
  | { e: 'window.layout'; windowId: WindowId; sidebar: 'docked' | 'collapsed'; width: number; animate: boolean }
  /** A window was created: open it. */
  | { e: 'window.open'; windowId: WindowId };

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
/** Deleted folders kept for Undo this session. */
const MAX_DELETED_FOLDERS = 10;
/** The most favorites; the row wraps well before this. */
const MAX_FAVORITES = 48;
/** Longest folder name. */
const MAX_FOLDER_TITLE = 64;
/** The most custom themes kept. */
const MAX_THEMES = 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Finished downloads kept in the list; older ones drop off. */
const MAX_DOWNLOADS = 100;
/** Removed extensions kept for Undo. */
const MAX_REMOVED_EXTENSIONS = 10;
/** Longest chord name; the switcher and headers truncate well before this. */
const MAX_CHORD_NAME = 64;
/** A new window opens this far down and right of the one it came from. */
const CASCADE = 28;

export function apply(state: State, command: Command, ctx: Context): Result {
  const effects: Effect[] = [];
  const [next, patches] = produceWithPatches(state, (draft) => {
    run(draft, command, ctx, effects);
  });
  if (patches.length === 0) return { state, patches, effects };
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
  return true;
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

/** The window other than `windowId` that shows this tab, if any: a tab shows in one window at a time. */
function shownByOther(draft: Draft<State>, nodeId: NodeId, windowId: WindowId): Draft<WindowModel> | undefined {
  return Object.values(draft.windows).find((w) => w.id !== windowId && w.activeTab[w.activeChordId] === nodeId);
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
  // A window showing this tab lets it go first (a view has one parent): it falls back to its
  // most recently used tab that's free, and its effects come first so the page never has two homes.
  const other = nodeId ? shownByOther(draft, nodeId, windowId) : undefined;
  if (other) {
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

function run(draft: Draft<State>, cmd: Command, ctx: Context, effects: Effect[]): void {
  switch (cmd.t) {
    case 'tab.open': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      const id = ctx.newId();
      const tab: TabNode = {
        kind: 'tab',
        id,
        chordId: win.activeChordId,
        section: 'today',
        parentId: null,
        rank: topOfToday(draft, win.activeChordId),
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
      if (cmd.pinned && !win.private) moveNode(draft, draft.nodes[id]!, 'pinned', children(draft as State, win.activeChordId, 'pinned', null).length);
      draft.live[id] = { ...IDLE_LIVE, loading: true };
      effects.push({ e: 'view.ensure', nodeId: id });
      if (!cmd.background) {
        leave(draft, win, ctx);
        activate(draft, cmd.windowId, id, ctx, effects);
      }
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
      const order = tabsInOrder(draft as State, node.chordId);
      const index = order.findIndex((t) => t.id === node.id);
      // Arc's rule: land on the tab below, or above if this was the last one (one no other window shows).
      const isClosing = (t: TabNode) => t.id === node.id;
      // A pinned tab never goes away: closing unloads it and takes it home to its pinned page.
      if (node.section === 'pinned') {
        if (node.pinnedUrl && node.url !== node.pinnedUrl) node.url = node.pinnedUrl;
        delete draft.live[cmd.nodeId];
        effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
        for (const win of Object.values(draft.windows)) {
          if (win.activeTab[node.chordId] !== cmd.nodeId) continue;
          const neighbor = nearestFree(draft, order, index, win.id, isClosing);
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
      delete draft.nodes[cmd.nodeId];
      delete draft.live[cmd.nodeId];
      effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
      for (const win of Object.values(draft.windows)) {
        for (const [chordId, tabId] of Object.entries(win.activeTab)) {
          if (tabId !== cmd.nodeId) continue;
          const neighbor = nearestFree(draft, order, index, win.id, isClosing);
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
      if (draft.closed.length > MAX_CLOSED) draft.closed.length = MAX_CLOSED;
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
      if (Object.values(draft.windows).some((w) => w.activeTab[w.activeChordId] === cmd.nodeId)) return;
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
      moveNode(draft, node, 'pinned', children(draft as State, node.chordId, 'pinned', null).length);
      return;
    }

    case 'tab.unpin': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || node.section !== 'pinned') return;
      moveNode(draft, node, 'today', 0);
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
        } else if (live[key] !== value) {
          live[key] = value as boolean;
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
      if (searchEngine !== undefined && draft.settings.searchEngine !== searchEngine) draft.settings.searchEngine = searchEngine;
      if (archiveAfter !== undefined && draft.settings.archiveAfter !== archiveAfter) draft.settings.archiveAfter = archiveAfter;
      if (sleepTabs !== undefined && draft.settings.sleepTabs !== sleepTabs) draft.settings.sleepTabs = sleepTabs;
      if (searchSuggestions !== undefined && draft.settings.searchSuggestions !== searchSuggestions) draft.settings.searchSuggestions = searchSuggestions;
      if (checkForUpdates !== undefined && draft.settings.checkForUpdates !== checkForUpdates) draft.settings.checkForUpdates = checkForUpdates;
      const { autoPip } = cmd.settings;
      if (autoPip !== undefined && draft.settings.autoPip !== autoPip) draft.settings.autoPip = autoPip;
      if (colorScheme !== undefined && draft.settings.colorScheme !== colorScheme) draft.settings.colorScheme = colorScheme;
      if (cmd.settings.duet) {
        const duet = cmd.settings.duet;
        const current = draft.settings.duet;
        if (duet.enabled !== undefined && current.enabled !== duet.enabled) current.enabled = duet.enabled;
        if (duet.provider !== undefined && current.provider !== duet.provider) current.provider = duet.provider;
        if (duet.model !== undefined && current.model !== duet.model) current.model = duet.model;
        if (duet.keep !== undefined && current.keep !== duet.keep) current.keep = duet.keep;
        if (duet.scope !== undefined && current.scope !== duet.scope) current.scope = duet.scope;
        if (duet.neverSites) current.neverSites = [...new Set(duet.neverSites)];
        if (duet.offChords) current.offChords = [...new Set(duet.offChords)];
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
      chord.profileId = cmd.profileId;
      // A page can't change session: every open tab in the chord closes its page, and the one
      // a window shows comes straight back in the new session. The rest load when you visit them.
      for (const node of Object.values(draft.nodes)) {
        if (node.kind !== 'tab' || node.chordId !== cmd.chordId || !draft.live[node.id]) continue;
        delete draft.live[node.id];
        effects.push({ e: 'view.destroy', nodeId: node.id });
      }
      for (const win of Object.values(draft.windows)) {
        const shown = win.activeChordId === cmd.chordId ? win.activeTab[cmd.chordId] : null;
        if (!shown) continue;
        draft.live[shown] = { ...IDLE_LIVE, loading: true };
        effects.push({ e: 'view.ensure', nodeId: shown }, { e: 'view.show', windowId: win.id, nodeId: shown });
      }
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
  }
}
