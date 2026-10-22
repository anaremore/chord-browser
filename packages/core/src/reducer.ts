/**
 * The reducer (ARCHITECTURE.md §6.1). Pure and deterministic given `ctx`, so
 * renderers can apply commands optimistically and land on the same state.
 * Returns Immer patches (for mirrors and persistence) and effects (for main to
 * carry out against real WebContentsViews).
 */
import { generateKeyBetween } from 'fractional-indexing';
import { enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import {
  IDLE_LIVE,
  type Bounds,
  type ChordId,
  type ClosedTab,
  type LiveTab,
  type NodeId,
  type State,
  type TabNode,
  type WindowId,
} from './model';
import { children, tabsInOrder } from './select';

enablePatches();

export type Command =
  | { t: 'tab.open'; windowId: WindowId; url: string; background?: boolean }
  /** `touch: false` switches without counting as a visit (used while cycling recent tabs). */
  | { t: 'tab.activate'; windowId: WindowId; nodeId: NodeId; touch?: boolean }
  | { t: 'tab.close'; windowId: WindowId; nodeId: NodeId }
  | { t: 'tab.reopenClosed'; windowId: WindowId }
  | { t: 'tab.navigate'; nodeId: NodeId; url: string }
  | { t: 'tab.cycle'; windowId: WindowId; direction: 1 | -1 }
  /** Engine reports (not user intent). */
  | { t: 'tab.updated'; nodeId: NodeId; url?: string; title?: string; favicon?: string | null }
  | { t: 'tab.live'; nodeId: NodeId; live: Partial<LiveTab> }
  | { t: 'window.bounds'; windowId: WindowId; bounds: Bounds }
  | { t: 'window.sidebar'; windowId: WindowId; sidebar: 'docked' | 'collapsed' };

export type Effect =
  /** Make sure a view exists for this tab (created lazily, loading `url`). */
  | { e: 'view.ensure'; nodeId: NodeId }
  /** Show this tab (or nothing) in the window's content frame. */
  | { e: 'view.show'; windowId: WindowId; nodeId: NodeId | null }
  | { e: 'view.navigate'; nodeId: NodeId; url: string }
  | { e: 'view.destroy'; nodeId: NodeId }
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

function topOfToday(state: Draft<State>, chordId: ChordId): string {
  const first = children(state as State, chordId, 'today', null)[0];
  return generateKeyBetween(null, first?.rank ?? null);
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
      if (!cmd.background) activate(draft, cmd.windowId, id, ctx, effects);
      return;
    }

    case 'tab.activate': {
      const node = draft.nodes[cmd.nodeId];
      const win = draft.windows[cmd.windowId];
      if (node?.kind !== 'tab' || !win) return;
      if (node.chordId !== win.activeChordId) win.activeChordId = node.chordId;
      activate(draft, cmd.windowId, cmd.nodeId, ctx, effects, cmd.touch ?? true);
      return;
    }

    case 'tab.close': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab') return;
      const order = tabsInOrder(draft as State, node.chordId);
      const index = order.findIndex((t) => t.id === node.id);
      // Arc's rule: land on the tab below, or above if this was the last one.
      const neighbor = order[index + 1] ?? order[index - 1] ?? null;
      const closed: ClosedTab = { node: { ...(node as TabNode) }, windowId: cmd.windowId, closedAt: ctx.now };
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
      if (win.activeChordId !== chordId) win.activeChordId = chordId;
      activate(draft, cmd.windowId, restored.id, ctx, effects);
      return;
    }

    case 'tab.navigate': {
      const node = draft.nodes[cmd.nodeId];
      if (node?.kind !== 'tab') return;
      node.url = cmd.url;
      effects.push({ e: 'view.ensure', nodeId: cmd.nodeId }, { e: 'view.navigate', nodeId: cmd.nodeId, url: cmd.url });
      return;
    }

    case 'tab.cycle': {
      const win = draft.windows[cmd.windowId];
      if (!win) return;
      const order = tabsInOrder(draft as State, win.activeChordId);
      if (order.length === 0) return;
      const current = order.findIndex((t) => t.id === win.activeTab[win.activeChordId]);
      const next = order[(current + cmd.direction + order.length) % order.length]!;
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
      for (const [key, value] of Object.entries(cmd.live) as [keyof LiveTab, boolean][]) {
        if (live[key] !== value) live[key] = value;
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
  }
}
