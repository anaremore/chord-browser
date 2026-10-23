/**
 * The reducer (ARCHITECTURE.md §6.1). Pure and deterministic given `ctx`, so
 * renderers can apply commands optimistically and land on the same state.
 * Returns Immer patches (for mirrors and persistence) and effects (for main to
 * carry out against real WebContentsViews).
 */
import { generateKeyBetween } from 'fractional-indexing';
import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { isInternalUrl, visibleTabs } from './idle';
import {
  DEFAULT_PROFILE,
  IDLE_LIVE,
  type ArchivedTab,
  type ArchiveReason,
  type Bounds,
  type ChordId,
  type ChordThemeSpec,
  type ClosedTab,
  type CustomTheme,
  type Download,
  type LiveTab,
  type NodeId,
  type PermissionDecision,
  type ProfileId,
  type Section,
  type SitePermission,
  type SettingsPatch,
  type State,
  type TabNode,
  type WindowId,
  type WindowModel,
} from './model';
import { children, sortedChords, tabsInOrder } from './select';

enablePatches();

export type Command =
  | { t: 'tab.open'; windowId: WindowId; url: string; background?: boolean }
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
  /** Drag and drop: put a tab at a position in a section (pinned or Today) of its chord. */
  | { t: 'node.move'; nodeId: NodeId; section: Section; index: number }
  /** Pin to the bottom of the pinned section, keeping the current page as its home. */
  | { t: 'tab.pin'; nodeId: NodeId }
  /** Unpin to the top of Today. */
  | { t: 'tab.unpin'; nodeId: NodeId }
  /** Engine reports (not user intent). */
  | { t: 'tab.updated'; nodeId: NodeId; url?: string; title?: string; favicon?: string | null }
  | { t: 'tab.live'; nodeId: NodeId; live: Partial<LiveTab> }
  | { t: 'window.bounds'; windowId: WindowId; bounds: Bounds }
  | { t: 'window.sidebar'; windowId: WindowId; sidebar: 'docked' | 'collapsed' }
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
  /** Take every finished download off the list. */
  | { t: 'download.clear' }
  /** Add or change a custom theme; chords made from it follow. */
  | { t: 'theme.save'; theme: CustomTheme }
  /** Remove a custom theme; chords using it keep their colors. */
  | { t: 'theme.delete'; id: string }
  /** Remember (or, with null, forget) a site's answer to a permission prompt. */
  | { t: 'permission.set'; origin: string; permissions: SitePermission[]; decision: PermissionDecision | null };

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
  /** The window's sidebar docked or collapsed: lay the content frame out again. */
  | { e: 'window.layout'; windowId: WindowId; sidebar: 'docked' | 'collapsed' };

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
/** The most custom themes kept. */
const MAX_THEMES = 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Finished downloads kept in the list; older ones drop off. */
const MAX_DOWNLOADS = 100;
/** Longest chord name; the switcher and headers truncate well before this. */
const MAX_CHORD_NAME = 64;

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
 * Move a tab within or between its chord's sections. Pinning keeps the page
 * it's on as the pinned home; unpinning forgets it. Returns false for a no-op.
 */
function moveTab(draft: Draft<State>, node: Draft<TabNode>, section: Section, index: number): boolean {
  const siblings = children(draft as State, node.chordId, section, null).filter((n) => n.id !== node.id);
  const at = Math.max(0, Math.min(index, siblings.length));
  if (node.section === section && node.parentId === null) {
    const current = children(draft as State, node.chordId, section, null).findIndex((n) => n.id === node.id);
    if (current === at) return false;
  }
  node.rank = rankBetween(siblings[at - 1]?.rank ?? null, siblings[at]?.rank ?? null);
  node.parentId = null;
  if (node.section !== section) {
    node.section = section;
    node.pinnedUrl = section === 'pinned' ? (node.pinnedUrl ?? node.url) : null;
  }
  return true;
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
  if (!win || !draft.chords[chordId] || win.activeChordId === chordId) return;
  leave(draft, win, ctx);
  win.activeChordId = chordId;
  let tabId = win.activeTab[chordId] ?? null;
  if (!tabId || draft.nodes[tabId]?.kind !== 'tab') {
    const recent = tabsInOrder(draft as State, chordId).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    tabId = recent?.id ?? null;
  }
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
      // Arc's rule: land on the tab below, or above if this was the last one.
      const neighbor = order[index + 1] ?? order[index - 1] ?? null;
      // A pinned tab never goes away: closing unloads it and takes it home to its pinned page.
      if (node.section === 'pinned') {
        if (node.pinnedUrl && node.url !== node.pinnedUrl) node.url = node.pinnedUrl;
        delete draft.live[cmd.nodeId];
        effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
        for (const win of Object.values(draft.windows)) {
          if (win.activeTab[node.chordId] !== cmd.nodeId) continue;
          if (node.chordId === win.activeChordId) activate(draft, win.id, neighbor?.id ?? null, ctx, effects);
          else win.activeTab[node.chordId] = neighbor?.id ?? null;
        }
        return;
      }
      // A closed Today tab goes to the archive; ⌘⇧T brings it back to the same place.
      const archiveId = toArchive(node as TabNode, 'closed', ctx, effects);
      const closed: ClosedTab = { node: { ...(node as TabNode) }, windowId: cmd.windowId, closedAt: ctx.now, archiveId };
      draft.closed.unshift(closed);
      if (draft.closed.length > MAX_CLOSED) draft.closed.length = MAX_CLOSED;
      delete draft.nodes[cmd.nodeId];
      delete draft.live[cmd.nodeId];
      effects.push({ e: 'view.destroy', nodeId: cmd.nodeId });
      for (const win of Object.values(draft.windows)) {
        for (const [chordId, tabId] of Object.entries(win.activeTab)) {
          if (tabId !== cmd.nodeId) continue;
          if (chordId === win.activeChordId) activate(draft, win.id, neighbor?.id ?? null, ctx, effects);
          else win.activeTab[chordId] = neighbor?.id ?? null;
        }
      }
      return;
    }

    case 'tab.reopenClosed': {
      const win = draft.windows[cmd.windowId];
      const entry = draft.closed.shift();
      if (!win || !entry) return;
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
      const tabs = cmd.nodeIds
        .map((id) => draft.nodes[id])
        .filter((n): n is Draft<TabNode> => n?.kind === 'tab' && n.section === 'today' && !onScreen.has(n.id));
      if (tabs.length === 0) return;
      const gone = new Set(tabs.map((t) => t.id));
      // Where each window lands if its tab goes: the nearest tab that stays, below first (Arc's rule).
      const landing = new Map<string, NodeId | null>();
      for (const win of Object.values(draft.windows)) {
        for (const [chordId, tabId] of Object.entries(win.activeTab)) {
          if (!tabId || !gone.has(tabId)) continue;
          const order = tabsInOrder(draft as State, chordId);
          const at = order.findIndex((t) => t.id === tabId);
          const stays = (t: TabNode) => !gone.has(t.id);
          const below = order.slice(at + 1).find(stays);
          const above = order.slice(0, Math.max(0, at)).reverse().find(stays);
          landing.set(`${win.id}:${chordId}`, (below ?? above)?.id ?? null);
        }
      }
      for (const tab of tabs) {
        const archiveId = toArchive(tab as TabNode, cmd.reason, ctx, effects);
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
      if (!win || draft.nodes[cmd.nodeId]) return;
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
      if (node?.kind === 'tab') moveTab(draft, node, cmd.section, cmd.index);
      return;
    }

    case 'tab.pin': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || node.section === 'pinned') return;
      moveTab(draft, node, 'pinned', children(draft as State, node.chordId, 'pinned', null).length);
      return;
    }

    case 'tab.unpin': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab' || node.section !== 'pinned') return;
      moveTab(draft, node, 'today', 0);
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

    case 'window.bounds': {
      const win = draft.windows[cmd.windowId];
      if (win) win.bounds = cmd.bounds;
      return;
    }

    case 'window.sidebar': {
      const win = draft.windows[cmd.windowId];
      if (!win || win.sidebar === cmd.sidebar) return;
      win.sidebar = cmd.sidebar;
      effects.push({ e: 'window.layout', windowId: cmd.windowId, sidebar: cmd.sidebar });
      return;
    }

    case 'settings.set': {
      const { searchEngine, motion, colorScheme, archiveAfter, sleepTabs } = cmd.settings;
      if (searchEngine !== undefined && draft.settings.searchEngine !== searchEngine) draft.settings.searchEngine = searchEngine;
      if (archiveAfter !== undefined && draft.settings.archiveAfter !== archiveAfter) draft.settings.archiveAfter = archiveAfter;
      if (sleepTabs !== undefined && draft.settings.sleepTabs !== sleepTabs) draft.settings.sleepTabs = sleepTabs;
      const { autoPip } = cmd.settings;
      if (autoPip !== undefined && draft.settings.autoPip !== autoPip) draft.settings.autoPip = autoPip;
      if (colorScheme !== undefined && draft.settings.colorScheme !== colorScheme) draft.settings.colorScheme = colorScheme;
      const { separateSignIns } = cmd.settings;
      if (separateSignIns !== undefined && draft.settings.separateSignIns !== separateSignIns) draft.settings.separateSignIns = separateSignIns;
      for (const [key, value] of Object.entries(motion ?? {}) as [keyof typeof draft.settings.motion, boolean | undefined][]) {
        if (value !== undefined && draft.settings.motion[key] !== value) draft.settings.motion[key] = value;
      }
      for (const [key, value] of Object.entries(cmd.settings.interface ?? {}) as [keyof typeof draft.settings.interface, number | undefined][]) {
        if (value !== undefined && draft.settings.interface[key] !== clamp01(value)) draft.settings.interface[key] = clamp01(value);
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
      if (!win) return;
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
      const order = sortedChords(draft as State);
      const current = order.findIndex((c) => c.id === win.activeChordId);
      const next = order[(current + cmd.direction + order.length) % order.length];
      if (next) switchChord(draft, cmd.windowId, next.id, ctx, effects);
      return;
    }

    case 'chord.goto': {
      const order = sortedChords(draft as State);
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
      if (!chord || chord.profileId === cmd.profileId) return;
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

    case 'download.clear':
      for (const d of Object.values(draft.downloads)) if (d.state !== 'progressing' && d.state !== 'paused') delete draft.downloads[d.id];
      return;

    case 'permission.set': {
      const site = (draft.sitePermissions[cmd.origin] ??= {});
      for (const permission of cmd.permissions) {
        if (cmd.decision === null) delete site[permission];
        else if (site[permission] !== cmd.decision) site[permission] = cmd.decision;
      }
      if (Object.keys(site).length === 0) delete draft.sitePermissions[cmd.origin];
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
