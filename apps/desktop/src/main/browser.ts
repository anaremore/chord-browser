/**
 * The orchestrator: owns windows, runs reducer effects against real views,
 * broadcasts patches to renderer mirrors, and carries out keyboard actions.
 */
import { activeTab, activeTabId, tabsInOrder, type ActionId, type Effect, type NodeId, type State, type WindowId } from '@chord/core';
import { app, type Session, type WebContents } from 'electron';
import { send } from './ipc';
import { attachShortcuts, type KeyboardHandlers } from './keyboard';
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
    run: (action, contents) => this.runAction(action, contents),
    onControlUp: () => this.finishRecentCycle(),
  };

  constructor(private readonly options: BrowserOptions) {
    this.store = new Store(options.initial);
    this.tabs = new TabManager({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      sessionFor: (node) => options.profileSession(this.store.state.chords[node.chordId]?.profileId ?? 'default'),
      windowFor: (nodeId) => this.windowShowing(nodeId),
      onContentsCreated: (contents) => attachShortcuts(contents, this.keyboard),
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
      onBounds: (bounds) => this.store.dispatch({ t: 'window.bounds', windowId, bounds }),
    });
    this.windows.set(windowId, w);
    attachShortcuts(w.shell.webContents, this.keyboard);
    attachShortcuts(w.overlay.webContents, this.keyboard);
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
      }
    }
  }

  private runAction(action: ActionId, contents: WebContents): boolean {
    const w = this.windowFor(contents);
    if (!w) return false;
    const active = activeTabId(this.store.state, w.id);
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
