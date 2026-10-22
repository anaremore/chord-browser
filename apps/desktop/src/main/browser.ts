/**
 * The orchestrator: owns windows, runs reducer effects against real views,
 * broadcasts patches to renderer mirrors, and carries out keyboard actions.
 */
import {
  activeTab,
  activeTabId,
  markdownLink,
  tabsInOrder,
  zoomStep,
  type ActionId,
  type Effect,
  type NodeId,
  type State,
  type TabNode,
  type WindowId,
} from '@chord/core';
import type { Rect } from '@chord/ipc';
import { app, BaseWindow, clipboard, type Menu, type Session, type WebContents } from 'electron';
import { attachContextMenu } from './context-menu';
import { send } from './ipc';
import { attachShortcuts, type KeyboardHandlers } from './keyboard';
import { buildAppMenu, buildTabMenu, OPTIONS_MENU_WIDTH } from './menu';
import { systemInfo } from './platform';
import { Store, type Change } from './store';
import { TabManager } from './tabs';
import { AppWindow } from './window';

export interface BrowserOptions {
  initial: State;
  uiSession: Session;
  profileSession(profileId: string): Session;
  /** Persistence hook: every change, after it's applied. */
  onChange?(change: Change): void;
}

export class Browser {
  readonly store: Store;
  readonly tabs: TabManager;
  private readonly windows = new Map<WindowId, AppWindow>();
  private recent: { windowId: WindowId; order: NodeId[]; index: number } | null = null;
  private readonly keyboard: KeyboardHandlers = {
    run: (action, contents) => this.run(action, contents),
    onControlUp: () => this.finishRecentCycle(),
  };
  /** The application menu (macOS menu bar; on Windows/Linux the ⋯ menu, whose accelerators stay live). */
  readonly appMenu: Menu = buildAppMenu((action) => this.runInFocusedWindow(action));

  constructor(private readonly options: BrowserOptions) {
    this.store = new Store(options.initial);
    this.tabs = new TabManager({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      sessionFor: (node) => options.profileSession(this.store.state.chords[node.chordId]?.profileId ?? 'default'),
      windowFor: (nodeId) => this.windowShowing(nodeId),
      onContentsCreated: (contents, nodeId) => {
        attachShortcuts(contents, this.keyboard);
        attachContextMenu(contents, {
          surface: 'web',
          inspect: true,
          openTab: (url, background) => {
            const windowId = this.windowShowing(nodeId);
            if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url, background });
          },
          placement: () => {
            const w = this.windowFor(contents);
            const bounds = this.tabs.get(nodeId)?.getBounds();
            return w && bounds ? { window: w.window, x: bounds.x, y: bounds.y } : undefined;
          },
        });
      },
    });
    this.store.subscribe((change) => {
      this.broadcast(change);
      this.runEffects(change.effects);
      options.onChange?.(change);
    });
  }

  /** Open a window for every window in the state and show its active tab. */
  start(): void {
    for (const model of Object.values(this.store.state.windows)) this.openWindow(model.id);
  }

  focusFirstWindow(): void {
    const [first] = this.windows.values();
    if (!first) return;
    if (first.window.isMinimized()) first.window.restore();
    first.window.focus();
  }

  get windowCount(): number {
    return this.windows.size;
  }

  windowFor(contents: WebContents): AppWindow | undefined {
    for (const w of this.windows.values()) {
      if (w.shell.webContents === contents || w.overlay.webContents === contents || w.activeTabContents === contents) return w;
    }
    const nodeId = this.tabs.nodeFor(contents);
    const windowId = nodeId ? this.windowShowing(nodeId) : undefined;
    return windowId ? this.windows.get(windowId) : undefined;
  }

  activeUrl(windowId: WindowId): string {
    return activeTab(this.store.state, windowId)?.url ?? '';
  }

  private openWindow(windowId: WindowId): AppWindow {
    const model = this.store.state.windows[windowId]!;
    const w = new AppWindow({
      id: windowId,
      uiSession: this.options.uiSession,
      bounds: model.bounds,
      sidebar: model.sidebar,
      onBounds: (bounds) => this.store.dispatch({ t: 'window.bounds', windowId, bounds }),
    });
    this.windows.set(windowId, w);
    for (const contents of [w.shell.webContents, w.overlay.webContents]) {
      attachShortcuts(contents, this.keyboard);
      attachContextMenu(contents, {
        surface: 'ui',
        inspect: !app.isPackaged,
        openTab: (url, background) => this.store.dispatch({ t: 'tab.open', windowId, url, background }),
        placement: () => ({ window: w.window, x: 0, y: 0 }),
      });
    }
    w.window.on('closed', () => {
      this.windows.delete(windowId);
      if (this.windows.size === 0 && process.platform !== 'darwin') {
        this.tabs.destroyAll();
        app.quit();
      }
    });
    const active = activeTabId(this.store.state, windowId);
    w.showTab(active ? (this.tabs.ensure(active) ?? null) : null);
    return w;
  }

  private windowShowing(nodeId: NodeId): WindowId | undefined {
    const models = Object.values(this.store.state.windows);
    const showing = models.find((m) => m.activeTab[m.activeChordId] === nodeId);
    if (showing) return showing.id;
    const node = this.store.state.nodes[nodeId];
    return models.find((m) => m.activeChordId === node?.chordId)?.id ?? models[0]?.id;
  }

  private broadcast(change: Change): void {
    if (change.patches.length === 0) return;
    const event = { version: change.state.version, patches: change.patches };
    for (const w of this.windows.values()) {
      send(w.shell.webContents, 'state:patch', event);
      send(w.overlay.webContents, 'state:patch', event);
    }
  }

  private runEffects(effects: Effect[]): void {
    for (const effect of effects) {
      switch (effect.e) {
        case 'view.ensure':
          this.tabs.ensure(effect.nodeId);
          break;
        case 'view.show':
          this.windows.get(effect.windowId)?.showTab(effect.nodeId ? (this.tabs.ensure(effect.nodeId) ?? null) : null);
          break;
        case 'view.navigate':
          this.tabs.navigate(effect.nodeId, effect.url);
          break;
        case 'view.destroy':
          this.tabs.destroy(effect.nodeId);
          break;
        case 'window.layout':
          this.windows.get(effect.windowId)?.setSidebar(effect.sidebar, !systemInfo().prefersReducedMotion);
          break;
      }
    }
  }

  /** Run an action for the window that owns this contents (keys, the shell's buttons, the command bar). */
  run(action: ActionId, contents: WebContents): boolean {
    const w = this.windowFor(contents);
    return w ? this.runAction(action, w) : false;
  }

  /** Menu items act on the focused Chord window. */
  private runInFocusedWindow(action: ActionId): void {
    const focused = BaseWindow.getFocusedWindow();
    const w = [...this.windows.values()].find((x) => x.window === focused) ?? this.windows.values().next().value;
    if (w) this.runAction(action, w);
  }

  openAppMenu(contents: WebContents, anchor: Rect): void {
    this.windowFor(contents)?.popupMenu(this.appMenu, anchor, OPTIONS_MENU_WIDTH);
  }

  openTabMenu(contents: WebContents, nodeId: NodeId, at: { x: number; y: number }): void {
    const w = this.windowFor(contents);
    const node = this.store.state.nodes[nodeId];
    if (!w || node?.kind !== 'tab') return;
    const tab: TabNode = node;
    w.popupMenu(
      buildTabMenu({
        url: tab.url,
        copyLink: () => clipboard.writeText(tab.url),
        copyMarkdown: () => clipboard.writeText(markdownLink(tab.title, tab.url)),
        reload: () => this.tabs.get(nodeId)?.webContents.reload(),
        duplicate: () => this.store.dispatch({ t: 'tab.open', windowId: w.id, url: tab.url }),
        close: () => this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId }),
      }),
      { ...at, width: 0, height: 0 },
    );
  }

  private runAction(action: ActionId, w: AppWindow): boolean {
    const active = activeTabId(this.store.state, w.id);
    const tab = activeTab(this.store.state, w.id);
    const activeContents = w.activeTabContents;
    switch (action) {
      case 'address.edit':
        w.openOverlay('edit', this.activeUrl(w.id));
        return true;
      case 'tab.new':
        w.openOverlay('new', '');
        return true;
      case 'tab.close':
        if (active) this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId: active });
        return true;
      case 'tab.reopen':
        this.store.dispatch({ t: 'tab.reopenClosed', windowId: w.id });
        return true;
      case 'tab.recentNext':
      case 'tab.recentPrevious':
        this.cycleRecent(w.id, action === 'tab.recentNext' ? 1 : -1);
        return true;
      case 'tab.next':
      case 'tab.previous':
        this.store.dispatch({ t: 'tab.cycle', windowId: w.id, direction: action === 'tab.next' ? 1 : -1 });
        return true;
      case 'nav.reload':
        activeContents?.reload();
        return true;
      case 'nav.hardReload':
        activeContents?.reloadIgnoringCache();
        return true;
      case 'nav.back':
        if (activeContents?.navigationHistory.canGoBack()) activeContents.navigationHistory.goBack();
        return true;
      case 'nav.forward':
        if (activeContents?.navigationHistory.canGoForward()) activeContents.navigationHistory.goForward();
        return true;
      case 'view.fullscreen':
        w.window.setFullScreen(!w.window.isFullScreen());
        return true;
      case 'view.toggleSidebar': {
        const sidebar = this.store.state.windows[w.id]?.sidebar === 'collapsed' ? 'docked' : 'collapsed';
        this.store.dispatch({ t: 'window.sidebar', windowId: w.id, sidebar });
        return true;
      }
      case 'view.zoomIn':
      case 'view.zoomOut':
        activeContents?.setZoomFactor(zoomStep(activeContents.getZoomFactor(), action === 'view.zoomIn' ? 1 : -1));
        return true;
      case 'view.zoomReset':
        activeContents?.setZoomFactor(1);
        return true;
      case 'page.print':
        activeContents?.print();
        return true;
      case 'page.viewSource':
        if (tab && /^https?:/i.test(tab.url)) this.store.dispatch({ t: 'tab.open', windowId: w.id, url: `view-source:${tab.url}` });
        return true;
      case 'address.copy':
        if (tab) clipboard.writeText(tab.url);
        return true;
      case 'address.copyMarkdown':
        if (tab) clipboard.writeText(markdownLink(tab.title, tab.url));
        return true;
      case 'app.devtools':
        activeContents?.toggleDevTools();
        return true;
      case 'window.close':
        w.window.close();
        return true;
      case 'app.quit':
        app.quit();
        return true;
      default:
        // Chords arrive in M1.3; keep their keys reserved so pages never see them.
        return action.startsWith('chord.');
    }
  }

  /** Hold Ctrl and press Tab to walk back through recently used tabs; release to land. */
  private cycleRecent(windowId: WindowId, direction: 1 | -1): void {
    const state = this.store.state;
    if (!this.recent || this.recent.windowId !== windowId) {
      const chordId = state.windows[windowId]?.activeChordId;
      if (!chordId) return;
      const order = tabsInOrder(state, chordId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((t) => t.id);
      if (order.length < 2) return;
      this.recent = { windowId, order, index: 0 };
    }
    const r = this.recent;
    r.index = (r.index + direction + r.order.length) % r.order.length;
    this.store.dispatch({ t: 'tab.activate', windowId, nodeId: r.order[r.index]!, touch: false });
  }

  private finishRecentCycle(): void {
    const r = this.recent;
    this.recent = null;
    if (r) this.store.dispatch({ t: 'tab.activate', windowId: r.windowId, nodeId: r.order[r.index]!, touch: true });
  }
}
