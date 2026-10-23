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
import type { PopoverState, Rect, SettingsSnapshot } from '@chord/ipc';
import { app, BaseWindow, clipboard, screen, type Menu, type Session, type WebContents } from 'electron';
import { placeOnDisplays } from './bounds';
import { attachContextMenu } from './context-menu';
import { Extensions } from './extensions';
import type { WebStore } from './extensions/webstore';
import { FindInPage } from './find';
import { send } from './ipc';
import { attachShortcuts, type KeyboardHandlers } from './keyboard';
import { buildAppMenu, buildChordMenu, buildTabMenu, OPTIONS_MENU_WIDTH } from './menu';
import type { HistoryEvent } from '@chord/data';
import type { PermissionBroker } from './permissions';
import { systemInfo } from './platform';
import { SettingsWindow } from './settings-window';
import { Store, type Change } from './store';
import { TabManager } from './tabs';
import { AppWindow } from './window';

export interface BrowserOptions {
  initial: State;
  uiSession: Session;
  profileSession(profileId: string): Session;
  /** Answers permission requests; connected here once the store exists. */
  permissions: PermissionBroker;
  /** Where visits and page titles go (chord-data's history). */
  history(event: HistoryEvent): void;
  /** Persistence hook: every change, after it's applied. */
  onChange?(change: Change): void;
  /** Chrome extensions (ARCHITECTURE.md §12). */
  extensions: {
    /** Where Web Store extensions are unpacked. */
    root: string;
    /** The extension library's preload, as built. */
    preloadPath: string;
    webStore: WebStore;
    /** Development and tests only: the key packages must be signed with instead of the Web Store's. */
    publisherKeyHash?: string;
  };
}

export class Browser {
  readonly store: Store;
  readonly tabs: TabManager;
  readonly extensions: Extensions;
  private readonly windows = new Map<WindowId, AppWindow>();
  private readonly finders = new Map<WindowId, FindInPage>();
  /** The last popover state sent to each window, so unchanged state isn't re-sent on every engine event. */
  private readonly popoverSent = new Map<WindowId, string>();
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
      onVisit: (url, title) => options.history({ k: 'visit', url, title, at: Date.now() }),
      onTitle: (url, title) => options.history({ k: 'title', url, title }),
      onContentsCreated: (contents, nodeId) => {
        attachShortcuts(contents, this.keyboard);
        this.extensions.tabCreated(contents, nodeId);
        // Whatever a page asked for is denied once it's gone or replaced by another page.
        contents.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) options.permissions.forgetTab(nodeId);
        });
        contents.once('destroyed', () => options.permissions.forgetTab(nodeId));
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
          extensionItems: (params) => this.extensions.contextMenuItems(contents, params),
        });
      },
    });
    this.extensions = new Extensions({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      profileSession: (profileId) => options.profileSession(profileId),
      root: options.extensions.root,
      preloadPath: options.extensions.preloadPath,
      webStore: options.extensions.webStore,
      ...(options.extensions.publisherKeyHash ? { publisherKeyHash: options.extensions.publisherKeyHash } : {}),
      windows: () => this.windows.values(),
      windowById: (windowId) => this.windows.get(windowId),
      lastWindow: () => this.lastWindow(),
      windowOfNode: (nodeId) => this.windowShowing(nodeId),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      liveTabs: () => this.tabs.entries(),
      ensureTab: (nodeId) => this.tabs.ensure(nodeId)?.webContents,
      toast: (windowId, message) => {
        const w = this.windows.get(windowId);
        if (w) send(w.shell.webContents, 'toast:show', { id: `extension:${Date.now()}`, message });
      },
      openSettings: (section) => this.openSettings(section),
      changed: () => this.settingsWindow?.update(this.settingsSnapshot()),
    });
    options.permissions.connect({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      onChange: () => this.syncPopovers(),
    });
    this.store.subscribe((change) => {
      this.broadcast(change);
      this.runEffects(change.effects);
      this.syncPopovers();
      this.extensions.sync();
      if (this.settingsWindow && change.patches.some((p) => ['settings', 'chords', 'windows', 'extensions'].includes(String(p.path[0])))) {
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
      if ([w.shell.webContents, w.overlay.webContents, w.popover.webContents, w.activeTabContents].includes(contents)) return w;
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
    this.finders.set(windowId, new FindInPage(() => this.syncPopover(w)));
    w.popover.webContents.on('did-finish-load', () => {
      this.popoverSent.delete(windowId);
      this.syncPopover(w);
    });
    w.shell.webContents.on('did-finish-load', () => {
      this.extensions.forget(windowId);
      this.extensions.sync();
    });
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
      this.finders.delete(windowId);
      this.popoverSent.delete(windowId);
      this.extensions.forget(windowId);
      if (this.lastWindowId === windowId) this.lastWindowId = this.windows.keys().next().value ?? null;
      if (this.windows.size === 0 && process.platform !== 'darwin') {
        this.tabs.destroyAll();
        this.settingsWindow?.window.close();
        app.quit();
      }
    });
    const active = activeTabId(this.store.state, windowId);
    w.showTab(active ? (this.tabs.ensure(active) ?? null) : null);
    this.extensions.tabShown(w);
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
        case 'view.show': {
          const w = this.windows.get(effect.windowId);
          w?.showTab(effect.nodeId ? (this.tabs.ensure(effect.nodeId) ?? null) : null);
          if (w) this.extensions.tabShown(w);
          break;
        }
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

  /** What a window's popover shows: the find bar for its page, and the active tab's permission prompt. */
  popoverState(w: AppWindow): PopoverState {
    const state = this.store.state;
    const model = state.windows[w.id];
    const find = this.finders.get(w.id);
    return {
      theme: model ? (state.chords[model.activeChordId]?.theme ?? null) : null,
      interface: state.settings.interface,
      find: find && find.target === w.activeTabContents ? find.state : null,
      permission: this.options.permissions.promptFor(activeTabId(state, w.id)),
    };
  }

  findFor(contents: WebContents): FindInPage | undefined {
    const w = this.windowFor(contents);
    return w ? this.finders.get(w.id) : undefined;
  }

  private syncPopovers(): void {
    for (const w of this.windows.values()) this.syncPopover(w);
  }

  /**
   * Keep one window's popover and frame in step with its active tab: the
   * find bar closes when its page isn't shown any more, a page that failed or
   * crashed is hidden behind the frame's explanation, and the popover gets
   * fresh state only when something it shows changed.
   */
  private syncPopover(w: AppWindow): void {
    const find = this.finders.get(w.id);
    if (find?.target && find.target !== w.activeTabContents) find.close(false);
    const id = activeTabId(this.store.state, w.id);
    const live = id ? this.store.state.live[id] : undefined;
    w.setTabHidden(Boolean(live?.error || live?.crashed));
    const state = this.popoverState(w);
    const json = JSON.stringify(state);
    if (this.popoverSent.get(w.id) === json) return;
    this.popoverSent.set(w.id, json);
    send(w.popover.webContents, 'popover:state', state);
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

  /** The browser window used most recently (Settings acts on it). */
  lastBrowserWindow(): AppWindow | undefined {
    return this.lastWindow();
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
      extensions: this.extensions.infos(),
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
        pinned: tab.section === 'pinned',
        togglePin: () => this.store.dispatch({ t: tab.section === 'pinned' ? 'tab.unpin' : 'tab.pin', nodeId }),
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
          send(w.shell.webContents, 'chord:edit', { chordId, field: 'name' });
        },
        changeIcon: () => {
          this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
          send(w.shell.webContents, 'chord:edit', { chordId, field: 'icon' });
        },
        editColors: () => {
          this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
          this.lastWindowId = w.id;
          this.openSettings('appearance');
        },
        delete: onlyChord ? null : () => this.deleteChord(w, chordId),
      }),
      { ...at, width: 0, height: 0 },
    );
  }

  /**
   * Delete at once and offer Undo in a toast: no confirmation box (native ones
   * also make Windows play a warning sound).
   */
  private deleteChord(w: AppWindow, chordId: string): void {
    const chord = this.store.state.chords[chordId];
    if (!chord) return;
    this.store.dispatch({ t: 'chord.delete', chordId });
    send(w.shell.webContents, 'toast:show', {
      id: `chord-deleted:${chordId}`,
      message: `Deleted “${chord.name}”`,
      action: { label: 'Undo', command: { t: 'chord.restore', windowId: w.id, chordId } },
    });
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
      case 'view.find':
        if (activeContents) {
          this.finders.get(w.id)?.open(activeContents);
          w.focusPopover();
        }
        return true;
      case 'view.findNext':
      case 'view.findPrevious':
        if (activeContents) {
          this.finders.get(w.id)?.step(activeContents, action === 'view.findNext');
          w.focusPopover();
        }
        return true;
      case 'tab.pin':
        if (tab) this.store.dispatch({ t: tab.section === 'pinned' ? 'tab.unpin' : 'tab.pin', nodeId: tab.id });
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
      case 'chord.delete': {
        const chordId = this.store.state.windows[w.id]?.activeChordId;
        if (chordId && Object.keys(this.store.state.chords).length > 1) this.deleteChord(w, chordId);
        return true;
      }
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
