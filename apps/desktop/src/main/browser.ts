/**
 * The orchestrator: owns windows, runs reducer effects against real views,
 * broadcasts patches to renderer mirrors, and carries out keyboard actions.
 */
import {
  activeTab,
  activeTabId,
  markdownLink,
  motionEnabled,
  tabsInOrder,
  zoomStep,
  type ActionId,
  type Effect,
  type NodeId,
  type State,
  type TabNode,
  type WindowId,
} from '@chord/core';
import type { Rect, SettingsSnapshot } from '@chord/ipc';
import { app, BaseWindow, clipboard, dialog, screen, type Menu, type Session, type WebContents } from 'electron';
import { placeOnDisplays } from './bounds';
import { attachContextMenu } from './context-menu';
import { send } from './ipc';
import { attachShortcuts, type KeyboardHandlers } from './keyboard';
import { buildAppMenu, buildChordMenu, buildTabMenu, OPTIONS_MENU_WIDTH } from './menu';
import { systemInfo } from './platform';
import { SettingsWindow } from './settings-window';
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
  /** The browser window used most recently: menus, Settings and links from Settings act on it. */
  private lastWindowId: WindowId | null = null;
  private settingsWindow: SettingsWindow | null = null;
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
          searchEngine: () => this.store.state.settings.searchEngine,
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
      if (this.settingsWindow && change.patches.some((p) => ['settings', 'chords', 'windows'].includes(String(p.path[0])))) {
        this.settingsWindow.update(this.settingsSnapshot());
      }
      options.onChange?.(change);
    });
  }

  /** Open a window for every window in the state that isn't open yet, and show its active tab. */
  start(): void {
    for (const model of Object.values(this.store.state.windows)) if (!this.windows.has(model.id)) this.openWindow(model.id);
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
      bounds: model.bounds && placeOnDisplays(model.bounds, screen.getAllDisplays().map((d) => d.workArea)),
      sidebar: model.sidebar,
      onBounds: (bounds) => this.store.dispatch({ t: 'window.bounds', windowId, bounds }),
    });
    this.windows.set(windowId, w);
    this.lastWindowId ??= windowId;
    w.window.on('focus', () => {
      this.lastWindowId = windowId;
      this.settingsWindow?.update(this.settingsSnapshot());
    });
    for (const contents of [w.shell.webContents, w.overlay.webContents]) {
      attachShortcuts(contents, this.keyboard);
      attachContextMenu(contents, {
        surface: 'ui',
        inspect: !app.isPackaged,
        searchEngine: () => this.store.state.settings.searchEngine,
        openTab: (url, background) => this.store.dispatch({ t: 'tab.open', windowId, url, background }),
        placement: () => ({ window: w.window, x: 0, y: 0 }),
      });
    }
    w.window.on('closed', () => {
      this.windows.delete(windowId);
      if (this.lastWindowId === windowId) this.lastWindowId = this.windows.keys().next().value ?? null;
      if (this.windows.size === 0 && process.platform !== 'darwin') {
        this.tabs.destroyAll();
        this.settingsWindow?.window.close();
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
        case 'window.layout': {
          const animate = motionEnabled(this.store.state.settings, 'sidebar', systemInfo().prefersReducedMotion);
          this.windows.get(effect.windowId)?.setSidebar(effect.sidebar, animate);
          break;
        }
      }
    }
  }

  /** Run an action for the window that owns this contents (keys, the shell's buttons, the command bar). */
  run(action: ActionId, contents: WebContents): boolean {
    const w = this.windowFor(contents) ?? (contents === this.settingsWindow?.view.webContents ? this.lastWindow() : undefined);
    return w ? this.runAction(action, w) : false;
  }

  /** Menu items act on the focused Chord window, or the last one used (when Settings has focus). */
  private runInFocusedWindow(action: ActionId): void {
    const focused = BaseWindow.getFocusedWindow();
    const w = [...this.windows.values()].find((x) => x.window === focused) ?? this.lastWindow();
    if (w) this.runAction(action, w);
    else if (action === 'app.settings' || action === 'app.shortcuts') this.openSettings(action === 'app.shortcuts' ? 'shortcuts' : undefined);
  }

  private lastWindow(): AppWindow | undefined {
    return (this.lastWindowId ? this.windows.get(this.lastWindowId) : undefined) ?? this.windows.values().next().value;
  }

  settingsSnapshot(): SettingsSnapshot {
    const state = this.store.state;
    const model = this.lastWindowId ? state.windows[this.lastWindowId] : undefined;
    const chord = model ? state.chords[model.activeChordId] : Object.values(state.chords)[0];
    return {
      settings: state.settings,
      chord: chord ? { id: chord.id, name: chord.name, icon: chord.icon, theme: chord.theme } : null,
    };
  }

  openSettings(section?: string): void {
    if (this.settingsWindow) {
      this.settingsWindow.show(section);
      return;
    }
    this.settingsWindow = new SettingsWindow(this.options.uiSession, this.lastWindow()?.window.getBounds(), section, () => {
      this.settingsWindow = null;
    });
    attachShortcuts(this.settingsWindow.view.webContents, this.keyboard);
    attachContextMenu(this.settingsWindow.view.webContents, {
      surface: 'ui',
      inspect: !app.isPackaged,
      searchEngine: () => this.store.state.settings.searchEngine,
      openTab: (url) => this.openUrlInLastWindow(url),
      placement: () => (this.settingsWindow ? { window: this.settingsWindow.window, x: 0, y: 0 } : undefined),
    });
  }

  /** A link from Settings opens as a new tab in the browser window used last, which comes forward. */
  openUrlInLastWindow(url: string): void {
    const w = this.lastWindow();
    if (!w) return;
    this.store.dispatch({ t: 'tab.open', windowId: w.id, url });
    w.window.focus();
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

  openChordMenu(contents: WebContents, chordId: string, at: { x: number; y: number }): void {
    const w = this.windowFor(contents);
    const chord = this.store.state.chords[chordId];
    if (!w || !chord) return;
    const onlyChord = Object.keys(this.store.state.chords).length < 2;
    w.popupMenu(
      buildChordMenu({
        rename: () => {
          this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
          send(w.shell.webContents, 'chord:rename', chordId);
        },
        editColors: () => {
          this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
          this.lastWindowId = w.id;
          this.openSettings('appearance');
        },
        delete: onlyChord ? null : () => void this.confirmDeleteChord(w, chordId),
      }),
      { ...at, width: 0, height: 0 },
    );
  }

  private async confirmDeleteChord(w: AppWindow, chordId: string): Promise<void> {
    const state = this.store.state;
    const chord = state.chords[chordId];
    if (!chord) return;
    const tabs = Object.values(state.nodes).filter((n) => n.chordId === chordId && n.kind === 'tab').length;
    const { response } = await dialog.showMessageBox(w.window, {
      type: 'warning',
      buttons: ['Delete chord', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete “${chord.name}”?`,
      detail:
        tabs === 0
          ? 'It has no tabs.'
          : `Its ${tabs === 1 ? 'tab closes' : `${tabs} tabs close`}. You can reopen ${tabs === 1 ? 'it' : 'them'} with Reopen closed tab.`,
    });
    if (response === 0) this.store.dispatch({ t: 'chord.delete', chordId });
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
      case 'app.settings':
        this.openSettings();
        return true;
      case 'app.shortcuts':
        this.openSettings('shortcuts');
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
      case 'chord.next':
      case 'chord.previous':
        this.store.dispatch({ t: 'chord.cycle', windowId: w.id, direction: action === 'chord.next' ? 1 : -1 });
        return true;
      default: {
        const goto = /^chord\.goto(\d)$/.exec(action);
        if (goto) this.store.dispatch({ t: 'chord.goto', windowId: w.id, index: Number(goto[1]) - 1 });
        return Boolean(goto);
      }
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
