/**
 * The orchestrator: owns windows, runs reducer effects against real views,
 * broadcasts patches to renderer mirrors, and carries out keyboard actions.
 */
import {
  ARCHIVE_URL,
  type ImageSearchEngine,
  activeTab,
  activeTabId,
  blockingOffSites,
  blockingSite,
  children,
  chordsFor,
  countShows,
  DEFAULT_PROFILE,
  DEFAULT_READER,
  hostOf,
  isBlockingOff,
  isCrossSite,
  effectsHost,
  isInternalUrl,
  isPrivateChord,
  isPrivateProfile,
  privateWindowOf,
  keycapFor,
  markdownLink,
  mediaVisibleTo,
  motionEnabled,
  READER_SIZES,
  reopenableIndex,
  routeFor,
  routeHost,
  shareableTabs,
  shownTabs,
  sortedChords,
  splitMembers,
  splitOf,
  SPLIT,
  tabsInOrder,
  uuidv7,
  type ActionId,
  type ArchiveReason,
  type Effect,
  type LiveTab,
  type SavedEffects,
  type NodeId,
  type State,
  type TabNode,
  type WindowId,
} from '@chord/core';
import type { ArchiveEntry, HistoryEvent, NavState } from '@chord/data';
import type { ArchiveSnapshot, DevtoolsAction, GesturePhase, MediaAction, NowPlaying, OtherBrowserId, PopoverState, PreviewTarget, ReaderLook, Rect, SettingsSnapshot } from '@chord/ipc';
import { THEME_VARS, type Theme } from '@chord/player-protocol';
import { createChordTheme, hexToRgb, rgbToOklch, size } from '@chord/tokens';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BaseWindow, BrowserWindow, clipboard, Menu, nativeTheme, screen, webContents, type Session, type WebContents, type WebContentsView } from 'electron';
import { AutoPip } from './auto-pip';
import { placeOnDisplays } from './bounds';
import { attachContextMenu } from './context-menu';
import { DevTools } from './devtools';
import { DrmNotices, drmServiceFor, findBrowsers, launchEnv } from './drm';
import { Effects } from './effects/service';
import { CHECK_WAIT_MS } from './player/install-state';
import type { PlayerInstaller } from './player/installer';
import { ChordPlayer, type ChordPlayerDeps } from './player/service';
import { imageSearchRequest, type SearchImage } from './image-search';
import { Extensions } from './extensions';
import type { WebStore } from './extensions/webstore';
import { FindInPage } from './find';
import { send } from './ipc';
import { attachShortcuts, type KeyboardHandlers } from './keyboard';
import { setShortcutOverrides } from './shortcut-overrides';
import { IdleKeeper, type IdleTiming } from './idle';
import { MiniWindows } from './mini-window';
import { MediaWatcher } from './media';
import { liveOf, Peeks } from './peek';
import { buildAppMenu, buildChordMenu, buildFavoriteMenu, buildFolderMenu, buildSplitMenu, buildTabMenu, OPTIONS_MENU_WIDTH } from './menu';
import type { PermissionBroker } from './permissions';
import { Previews } from './previews';
import { Readers, type ReaderLinkTarget } from './reader/service';
import type { Verdict } from './safe-browsing/database';
import { SafeBrowsingGuard } from './safe-browsing/guard';
import type { ScreenShareBroker } from './screen-share';
import type { AuthBroker } from './http-auth';
import type { PasskeyBroker } from './passkeys';
import type { Screenshots } from './screenshots/service';
import { HistorySaver } from './history-saver';
import { SiteZoom } from './site-zoom';
import { spellcheckLanguages } from './spellcheck';
import { platform, setUiScale, systemInfo } from './platform';
import { SettingsWindow } from './settings-window';
import { Store, type Change } from './store';
import { TabManager } from './tabs';
import { AppWindow, createUiView } from './window';

/** Histories of tabs archived this session, kept in memory so ⌘⇧T doesn't wait on the database. */
const MAX_REMEMBERED_HISTORIES = 100;
/** The command bar connects to the same server ahead of Enter at most this often (`preconnect`). */
const PRECONNECT_EVERY_MS = 10_000;

/** Whether two addresses share an origin (a pinned tab that left its site shows ↩). Unparseable counts as the same. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return true;
  }
}

export interface BrowserOptions {
  initial: State;
  uiSession: Session;
  profileSession(profileId: string): Session;
  /** Answers permission requests; connected here once the store exists. */
  permissions: PermissionBroker;
  /** Where visits, page titles and archived tabs go (chord-data). */
  history(event: HistoryEvent): void;
  /** Reads from chord-data's archive: one entry, or the newest archived for some reasons. */
  archive: { entry(which: { archiveId: string } | { reasons: ArchiveReason[] }): Promise<ArchiveEntry | null> };
  /** When idle tabs are archived and put to sleep. */
  idle: IdleTiming;
  /** The computer is low on memory: tabs sleep sooner (idle.ts). */
  memoryLow(): boolean;
  /** Answers getDisplayMedia with Chord's picker; connected here once the store exists. */
  screenShare: ScreenShareBroker;
  /** Answers sites and proxies that ask for a username and password; connected here once the store exists. */
  httpAuth: AuthBroker;
  /** Screenshots (DESIGN.md §7.12): capture mode, the clipboard, Save and the recent list. */
  screenshots: Screenshots;
  /** Chooses a passkey when an authenticator holds several for a site; connected here once the store exists. */
  passkeys: PasskeyBroker;
  /** Persistence hook: every change, after it's applied. */
  onChange?(change: Change): void;
  /** Open tabs' back/forward histories as chord-data saved them, by node id. */
  histories?: Record<string, NavState>;
  /** Save an open tab's back/forward history (never a private window's). */
  saveHistory(nodeId: NodeId, nav: NavState | null): void;
  /** A private window closed: drop its session (cookies, storage, cache) and anything kept for it. */
  releaseProfile(profileId: string): void;
  /**
   * The session developer tools load in (DESIGN.md §7.16): Chord's own,
   * persistent one, or for a private window's tab (its profile id) an
   * in-memory one of that window's. Never a profile's.
   */
  devtoolsSession(privateProfileId: string | null): Session;
  /** Safe Browsing (ARCHITECTURE.md §14.5): checks pages while it's on, and whether to offer turning it on. */
  safeBrowsing: {
    enabled(): boolean;
    check(urls: string[]): Promise<Verdict>;
    /** The one-time offer applies: available, never asked, not in Google-free mode. */
    offer(): boolean;
  };
  /** Ad and tracker blocking (ARCHITECTURE.md §9): each page's element hiding, which profile a page's session is, and when a change is in. */
  adBlocking: {
    attachPage(contents: WebContents): void;
    profileOf(contents: WebContents): string | undefined;
    settled(): Promise<void>;
  };
  /** Chord Player (ARCHITECTURE.md §9): its installer, how to start it, and what to do once it's gone. */
  player: {
    installer: PlayerInstaller;
    host: ChordPlayerDeps['host'];
    /** The player quit: with no windows left (Windows, Linux), Chord quits too. */
    closed(): void;
  };
  /** Effects (ARCHITECTURE.md §9): every saved site, how to save one, and the sanitizer's worker as built. */
  effects: {
    saved: readonly SavedEffects[];
    persist(host: string, site: SavedEffects | null): void;
    workerPath: string;
  };
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

/** Trackpad scroll phases forwarded to the shell, for the chord swipe. */
const GESTURE_PHASES: Partial<Record<string, GesturePhase>> = {
  gestureScrollBegin: 'begin',
  gestureScrollEnd: 'end',
  gestureFlingStart: 'fling',
};

export class Browser {
  readonly store: Store;
  readonly tabs: TabManager;
  /** Open tabs' histories, saved so a restart or a crash brings them back where they were. */
  private readonly histories: HistorySaver;
  readonly extensions: Extensions;
  /** Safe Browsing's warnings: which pages show one, "Back to safety" and "Visit anyway". */
  readonly safeBrowsing: SafeBrowsingGuard;

  get screenshots(): Screenshots {
    return this.options.screenshots;
  }
  private readonly windows = new Map<WindowId, AppWindow>();
  private readonly finders = new Map<WindowId, FindInPage>();
  /** The last popover state sent to each window, so unchanged state isn't re-sent on every engine event. */
  private readonly popoverSent = new Map<WindowId, string>();
  /** When the command bar last had each server connected ahead of Enter, by profile and origin (`preconnect`). */
  private readonly preconnected = new Map<string, number>();
  /** Tabs playing media, for the Now playing cards (DESIGN.md §7.10), and what each window's card was last sent. */
  readonly media: MediaWatcher;
  private readonly drm: DrmNotices;
  /** Chord Player: the DRM notice's first offer, the tab it plays for, its card entry (ARCHITECTURE.md §9). */
  readonly player: ChordPlayer;
  /** A popover refresh for when a young Chord Player check stops holding the DRM notice back. */
  private playerWait: ReturnType<typeof setTimeout> | null = null;
  private readonly mediaSent = new Map<WindowId, string>();
  /** The sign-in box each window last gave the keyboard to, so a box takes it once. */
  private readonly authFocused = new Map<WindowId, string>();
  /** The browser window used most recently: menus, Settings and links from Settings act on it. */
  private lastWindowId: WindowId | null = null;
  private settingsWindow: SettingsWindow | null = null;
  private recent: { windowId: WindowId; order: NodeId[]; index: number } | null = null;
  readonly idle: IdleKeeper;
  /** Duet (set once main has it): the panel's toggle and window bookkeeping. */
  duet: { act(windowId: WindowId, action: { do: 'toggle' }): Promise<void>; forgetWindow(windowId: WindowId): void } | null = null;
  /** Duet's panel width (DESIGN.md §3: 380, 320–560). */
  readonly duetWidth = size.duetWidth;

  /** A window by id (Duet acts in the window a message came from). */
  window(id: WindowId): AppWindow | undefined {
    return this.windows.get(id);
  }

  get allWindows(): AppWindow[] {
    return [...this.windows.values()];
  }
  private readonly autoPip: AutoPip;
  /** Hover previews for pinned tabs and folders, and the pictures behind them (DESIGN.md §7.6). */
  private readonly previews: Previews;
  /** Effects (DESIGN.md §7.15): per-site styles, the card, the picker, and Ask Duet. */
  readonly effects: Effects;
  private readonly siteZoom: SiteZoom;
  private readonly archivedHistory = new Map<string, NavState | null>();
  /** Archive entries being restored, so a double click brings a tab back once. */
  private readonly restoring = new Set<string>();
  private archiveChangedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chord is quitting: windows closing now stay in the saved state, to come back at the next launch. */
  private quitting = false;
  /** The Settings view while it records a shortcut: main acts on none of its keys until it's done. */
  private recordingIn: WebContents | null = null;
  /** Peek over each window (DESIGN.md §8.5), and the mini windows links from other apps open in (§7.9). */
  readonly peeks: Peeks;
  /** Tabs' reader views (DESIGN.md §7.11), and what each was last told about how it looks. */
  readonly readers: Readers;
  /** Tabs' developer tools, docked beside their page or in a window of their own (DESIGN.md §7.16). */
  readonly devtools: DevTools;
  private readonly readerSent = new Map<number, string>();
  readonly minis: MiniWindows;
  /** How often a site's pages went to each chord this session, for offering a link route (never silently). */
  private readonly routeHints = new Map<string, Map<string, number>>();
  /** Sites a route was offered for this session: one offer each. */
  private readonly routeOffered = new Set<string>();
  /** Windows opened for a page that's on its way (a mini window's): they don't open the command bar. */
  private readonly quietWindows = new Set<WindowId>();
  /** Whether a page was sharing when Chord last looked: presenting mode starts and ends with that. */
  private wasSharing = false;
  /** Whether presenting mode was on when Chord last acted on it, and the windows whose sidebar it collapsed (Settings), to dock again. */
  private presentingOn = false;
  private readonly collapsedForPresenting = new Set<WindowId>();
  private readonly keyboard: KeyboardHandlers = {
    run: (action, contents) => this.run(action, contents),
    onControlUp: () => this.finishRecentCycle(),
    paused: (contents) => contents === this.recordingIn,
  };
  /** The application menu (macOS menu bar; on Windows/Linux the ⋯ menu, whose accelerators stay live). */
  appMenu: Menu;

  constructor(private readonly options: BrowserOptions) {
    this.store = new Store(options.initial);
    setShortcutOverrides(this.store.state.settings.shortcuts);
    this.safeBrowsing = new SafeBrowsingGuard({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      enabled: () => options.safeBrowsing.enabled(),
      check: (urls) => options.safeBrowsing.check(urls),
      isTab: (contents, nodeId) => this.tabs.get(nodeId)?.webContents === contents,
      contentsOf: (nodeId) => this.tabs.get(nodeId)?.webContents,
      handOver: (contents, nodeId, url) => this.openFlaggedAsTab(contents, nodeId, url),
      closeTab: (nodeId) => {
        const windowId = this.windowShowing(nodeId);
        if (windowId) this.store.dispatch({ t: 'tab.close', windowId, nodeId });
      },
    });
    this.effects = new Effects({
      workerPath: options.effects.workerPath,
      saved: options.effects.saved,
      persist: (host, site) => options.effects.persist(host, site),
      everywhere: () => this.store.state.settings.effects.wet,
      setEverywhere: (wet) => this.store.dispatch({ t: 'settings.set', settings: { effects: { wet } } }),
      // A private window's session is its own profile (`private-<window id>`).
      privateWindowOf: (contents) => {
        const profileId = options.adBlocking.profileOf(contents);
        return profileId && isPrivateProfile(profileId) ? privateWindowOf(profileId) : null;
      },
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      setLive: (nodeId, effects) => this.setEffectsLive(nodeId, effects),
      windows: () => this.windows.values(),
      front: (windowId) => {
        const nodeId = activeTabId(this.store.state, windowId);
        const contents = nodeId ? this.tabs.get(nodeId)?.webContents : undefined;
        return nodeId && contents && !contents.isDestroyed() ? { nodeId, contents, url: contents.getURL() } : null;
      },
      popoverChanged: (windowId) => {
        const w = this.windows.get(windowId);
        if (w) this.syncPopover(w);
      },
      sendView: (windowId, view) => {
        const w = this.windows.get(windowId);
        if (w) send(w.popover.webContents, 'effects:state', view);
      },
      startPicker: (windowId, host) => {
        const w = this.windows.get(windowId);
        return w ? this.options.screenshots.start(w, { host }) : false;
      },
      pickerPage: (windowId) => {
        const w = this.windows.get(windowId);
        return w ? this.options.screenshots.pickerPage(w) : null;
      },
      settingsChanged: () => this.settingsWindow?.update(this.settingsSnapshot()),
    });
    // Before any window: Chord's own views open at the interface size (DESIGN.md §10).
    setUiScale(this.store.state.settings.uiScale);
    this.appMenu = buildAppMenu((action) => this.runInFocusedWindow(action), this.store.state.presenting !== null);
    this.tabs = new TabManager({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      sessionFor: (node) => options.profileSession(this.store.state.chords[node.chordId]?.profileId ?? 'default'),
      // The archive is Chord's only page shown as a tab so far.
      createInternalView: () => createUiView(options.uiSession, 'archive'),
      windowFor: (nodeId) => this.windowShowing(nodeId),
      // A private window's pages never reach history.
      onVisit: (url, title, nodeId) => {
        if (!this.isPrivateNode(nodeId)) options.history({ k: 'visit', url, title, at: Date.now() });
      },
      onTitle: (url, title, nodeId) => {
        if (!this.isPrivateNode(nodeId)) options.history({ k: 'title', url, title });
      },
      onContentsCreated: (contents, nodeId) => {
        attachShortcuts(contents, this.keyboard);
        this.extensions.tabCreated(contents, nodeId);
        this.safeBrowsing.attach(contents, nodeId);
        this.autoPip.attach(contents, nodeId);
        this.media.attach(contents, nodeId);
        this.siteZoom.attach(contents);
        this.readers.attach(contents, nodeId);
        options.adBlocking.attachPage(contents);
        this.effects.attachPage(contents);
        contents.on('did-stop-loading', () => this.previews.loaded(nodeId));
        // Whatever a page asked for is denied once it's gone or replaced by another page; a share ends.
        contents.on('did-start-navigation', (details) => {
          if (!details.isMainFrame || details.isSameDocument) return;
          options.permissions.forgetTab(nodeId);
          options.screenShare.forgetTab(nodeId);
          options.httpAuth.forgetTab(nodeId);
          options.passkeys.forgetTab(nodeId);
          options.passkeys.forgetTab(nodeId);
        });
        contents.once('destroyed', () => {
          options.permissions.forgetTab(nodeId);
          options.screenShare.forgetTab(nodeId);
          options.httpAuth.forgetTab(nodeId);
        });
        // Clicking into a split's pane focuses it: the address, buttons and keys act on it from then on.
        contents.on('focus', () => this.paneFocused(nodeId));
        contents.on('input-event', (_event, input) => {
          if (input.type === 'mouseDown') this.paneFocused(nodeId);
          // Scrolling, typing or a click changes what the saved history should bring back (scroll, form fields).
          if (input.type === 'mouseWheel' || input.type === 'keyDown' || input.type === 'mouseUp') this.histories.touch(nodeId);
        });
        contents.on('did-navigate', (_event, url) => {
          this.histories.touch(nodeId, true);
          // The tab left its service: it shows its own page again (the player plays on, still on the card).
          if (nodeId === this.player.nodeId && !drmServiceFor(url)) this.player.release(nodeId);
        });
        contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
          if (isMainFrame) this.histories.touch(nodeId, true);
        });
        // A page going fullscreen (a video) covers the whole window; Esc, or the page, brings Chord back.
        contents.on('enter-html-full-screen', () => this.windowFor(contents)?.setPageFullScreen(true));
        contents.on('leave-html-full-screen', () => this.windowFor(contents)?.setPageFullScreen(false));
        attachContextMenu(contents, {
          surface: 'web',
          // Every web page; the archive (Chord's own page) only in development builds, as Chord's other views.
          inspect: !app.isPackaged || this.store.state.nodes[nodeId]?.kind !== 'tab' || !isInternalUrl((this.store.state.nodes[nodeId] as TabNode).url),
          // A tab's page opens its developer tools where they live (docked, or their window); Peek's and a mini window's, popped out.
          inspectElement: (x, y) => this.inspectAt(contents, nodeId, x, y),
          searchEngine: () => this.store.state.settings.searchEngine,
          openTab: (url, background) => {
            // A mini window's links open in mini windows of their own.
            if (this.minis.has(nodeId)) return this.minis.show(url);
            const windowId = this.windowShowing(nodeId);
            if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url, background });
          },
          // Any tab can open a link in Peek this way, a private window's too (it has no pinned tabs);
          // Peek's own page and mini windows can't, until they're tabs.
          peek: {
            available: () => this.tabs.get(nodeId)?.webContents === contents && this.windowFor(contents)?.activeTabContents === contents,
            open: (url, at) => {
              const w = this.windowFor(contents);
              if (w && w.activeTabContents === contents) this.peeks.show(w, nodeId, url, at);
            },
          },
          placement: () => {
            const owner = this.windowFor(contents)?.window ?? this.minis.windowFor(contents);
            const bounds = (this.tabs.get(nodeId) ?? this.tabs.getFloating(nodeId))?.getBounds();
            return owner && bounds ? { window: owner, x: bounds.x, y: bounds.y } : undefined;
          },
          extensionItems: (params) => this.extensions.contextMenuItems(contents, params),
          adBlocking: this.blockingMenu(contents),
          screenshot: () => {
            const w = this.windowFor(contents);
            if (w) this.options.screenshots.start(w);
          },
          // Effects act on the tab in front, so only its own page offers them.
          effects: {
            available: () => this.windowFor(contents)?.activeTabContents === contents && effectsHost(contents.getURL()) !== null,
            open: () => {
              const w = this.windowFor(contents);
              if (w) this.effects.open(w);
            },
            hide: () => {
              const w = this.windowFor(contents);
              if (w) this.effects.startPick(w);
            },
          },
        });
      },
      onPeek: (openerNodeId, url, origin) => {
        const windowId = this.windowShowing(openerNodeId);
        const w = windowId ? this.windows.get(windowId) : undefined;
        // Peek opens over the window showing the pinned tab; a background one just gets a new tab.
        if (w && w.activeTabContents && w.activeTabContents === this.tabs.get(openerNodeId)?.webContents) this.peeks.show(w, openerNodeId, url, origin);
        else if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url, background: true });
      },
      onPopupCreated: (contents, openerNodeId) => {
        this.safeBrowsing.attachPopup(contents, openerNodeId);
        options.adBlocking.attachPage(contents);
        this.effects.attachPage(contents);
        attachContextMenu(contents, {
          surface: 'web',
          inspect: true,
          searchEngine: () => this.store.state.settings.searchEngine,
          // Links from a sign-in window open beside the page that opened it.
          openTab: (url, background) => {
            const windowId = this.windowShowing(openerNodeId);
            if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url, background });
          },
          placement: () => {
            const popup = BrowserWindow.fromWebContents(contents);
            return popup ? { window: popup, x: 0, y: 0 } : undefined;
          },
        });
      },
    });
    this.media = new MediaWatcher({
      isTab: (contents, nodeId) => this.tabs.get(nodeId)?.webContents === contents,
      changed: () => this.syncMedia(),
    });
    this.drm = new DrmNotices({ browsers: () => findBrowsers(launchEnv(process.env, homedir())), changed: () => this.syncPopovers() });
    this.player = new ChordPlayer({
      installer: options.player.installer,
      host: options.player.host,
      // Widevine's CDM comes from Google's component updater: never in Google-free mode.
      enabled: () => !this.store.state.settings.googleFree,
      tabExists: (nodeId) => this.store.state.nodes[nodeId]?.kind === 'tab',
      setTabInPlayer: (nodeId, inPlayer) => this.store.dispatch({ t: 'tab.live', nodeId, live: { player: inPlayer } }),
      openLink: (url, nodeId) => this.openPlayerLink(url, nodeId),
      back: (nodeId) => this.backFromPlayer(nodeId),
      theme: (nodeId) => this.playerTheme(nodeId),
      changed: () => this.syncPopovers(),
      mediaChanged: () => this.syncMedia(),
      closed: () => options.player.closed(),
    });
    const sessionForChord = (chordId: string) => options.profileSession(this.store.state.chords[chordId]?.profileId ?? DEFAULT_PROFILE);
    this.peeks = new Peeks({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      tabs: this.tabs,
      sessionFor: sessionForChord,
      animates: () => motionEnabled(this.store.state.settings, 'commandBar', systemInfo().prefersReducedMotion),
      adopted: (contents, nodeId) => {
        this.extensions.tabCreated(contents, nodeId);
        this.readers.detect(nodeId);
      },
      changed: () => this.syncPopovers(),
    });
    this.readers = new Readers({
      workerPath: join(import.meta.dirname, 'reader.js'),
      dispatch: (command) => this.store.dispatch(command),
      page: (nodeId) => this.tabs.get(nodeId)?.webContents,
      createView: () => createUiView(options.uiSession, 'reader'),
      changed: (nodeId) => {
        for (const w of this.windows.values()) if (shownTabs(this.store.state, w.id).includes(nodeId)) this.showPanes(w);
      },
      wire: (contents, nodeId) => this.wireReader(contents, nodeId),
      follow: (nodeId, url, target) => this.followFromReader(nodeId, url, target),
      failed: (nodeId) => {
        const windowId = this.windowShowing(nodeId);
        this.windows.get(windowId ?? '')?.toast({ id: `reader:${nodeId}`, message: 'Chord couldn’t find an article on this page.' });
      },
    });
    this.devtools = new DevTools({
      page: (nodeId) => this.tabs.get(nodeId)?.webContents,
      sessionFor: (nodeId) => {
        const node = this.store.state.nodes[nodeId];
        const profileId = node ? this.store.state.chords[node.chordId]?.profileId : undefined;
        return options.devtoolsSession(profileId && isPrivateProfile(profileId) ? profileId : null);
      },
      uiSession: options.uiSession,
      settings: () => this.store.state.settings.devtools,
      remember: (patch) => this.store.dispatch({ t: 'settings.set', settings: { devtools: patch } }),
      changed: (nodeId, place) => {
        // A sleeping tab has no live entry; reporting would wake it in the sidebar.
        const live = this.store.state.live[nodeId];
        if (live && live.devtools !== place) this.store.dispatch({ t: 'tab.live', nodeId, live: { devtools: place } });
        for (const w of this.windows.values()) if (shownTabs(this.store.state, w.id).includes(nodeId)) this.showPanes(w);
      },
      nearBounds: (nodeId) => this.windows.get(this.windowShowing(nodeId) ?? '')?.window.getBounds(),
      wire: (contents, nodeId) => {
        attachShortcuts(contents, this.keyboard);
        // Into a split's pane's DevTools, that pane is the focused one, as clicking into its page makes it.
        contents.on('focus', () => this.paneFocused(nodeId));
        contents.on('input-event', (_event, input) => {
          if (input.type === 'mouseDown') this.paneFocused(nodeId);
        });
      },
      openUrl: (nodeId, url) => {
        const windowId = this.windowShowing(nodeId);
        if (windowId && /^https?:/i.test(url)) this.store.dispatch({ t: 'tab.open', windowId, url });
      },
      reveal: (nodeId) => {
        const w = this.windows.get(this.windowShowing(nodeId) ?? '');
        if (!w) return;
        if (!shownTabs(this.store.state, w.id).includes(nodeId)) this.store.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
        if (w.window.isMinimized()) w.window.restore();
        w.window.focus();
      },
    });
    // Reader views follow the computer's appearance, accent and reduced motion, as Chord's other views do.
    nativeTheme.on('updated', () => {
      this.syncReaders(true);
      this.player.themeChanged();
    });
    this.minis = new MiniWindows({
      state: () => this.store.state,
      tabs: this.tabs,
      uiSession: options.uiSession,
      sessionFor: sessionForChord,
      defaultChord: () => {
        const last = this.lastNormalWindow();
        return (last && this.store.state.windows[last.id]?.activeChordId) || (sortedChords(this.store.state)[0]?.id ?? null);
      },
      chords: () => sortedChords(this.store.state).map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
      promote: (nodeId, chordId, page) => this.promoteMini(nodeId, chordId, page),
      wire: (bar) => {
        attachShortcuts(bar, this.keyboard);
        attachContextMenu(bar, {
          surface: 'ui',
          inspect: !app.isPackaged,
          searchEngine: () => this.store.state.settings.searchEngine,
          openTab: (url) => this.openUrlInLastWindow(url),
          placement: () => undefined,
        });
      },
      rememberSize: (width, height) => this.store.dispatch({ t: 'settings.set', settings: { miniWindowSize: { width, height } } }),
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
      // Extensions never open tabs in a private window (they don't run there).
      lastWindow: () => this.lastNormalWindow(),
      windowOfNode: (nodeId) => this.windowShowing(nodeId),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      liveTabs: () => this.tabs.entries(),
      ensureTab: (nodeId) => this.tabs.ensure(nodeId)?.webContents,
      toast: (windowId, message, action) => {
        const w = this.windows.get(windowId);
        if (w) w.toast({ id: `extension:${Date.now()}`, message, ...(action ? { action } : {}) });
      },
      openSettings: (section) => this.openSettings(section),
      changed: () => this.settingsWindow?.update(this.settingsSnapshot()),
    });
    this.histories = new HistorySaver({
      history: (nodeId) => this.tabs.history(nodeId),
      save: (nodeId, nav) => options.saveHistory(nodeId, nav),
      savable: (nodeId) => this.store.state.nodes[nodeId]?.kind === 'tab' && !this.isPrivateNode(nodeId),
    });
    // Back where they were: each open tab's saved history, if it still ends on the tab's page.
    for (const [nodeId, nav] of Object.entries(options.histories ?? {})) {
      const node = this.store.state.nodes[nodeId];
      if (node?.kind !== 'tab' || nav.entries[nav.index]?.url !== node.url) continue;
      this.tabs.restoreHistoryOnLoad(nodeId as NodeId, nav);
      this.histories.restored(nodeId as NodeId, nav);
    }
    options.permissions.connect({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      onChange: () => this.syncPopovers(),
    });
    this.previews = new Previews(join(app.getPath('userData'), 'Captures'), {
      state: () => this.store.state,
      contentsOf: (nodeId) => this.tabs.get(nodeId)?.webContents,
      onScreen: (contents) => [...this.windows.values()].some((w) => w.paneContents.includes(contents) && !w.window.isMinimized()),
      animate: () => motionEnabled(this.store.state.settings, 'sidebar', systemInfo().prefersReducedMotion),
    });
    void this.previews.open();
    this.autoPip = new AutoPip({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      contents: (nodeId) => this.tabs.get(nodeId)?.webContents,
      loaded: () => this.tabs.loaded(),
      isShown: (nodeId) => {
        const contents = this.tabs.get(nodeId)?.webContents;
        return Boolean(contents) && [...this.windows.values()].some((w) => w.paneContents.includes(contents!));
      },
      // "Back to tab" in the PiP window: the tab comes forward in its window.
      bringBack: (nodeId) => {
        const windowId = this.windowShowing(nodeId);
        const w = windowId ? this.windows.get(windowId) : undefined;
        if (!w) return;
        this.store.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
        if (w.window.isMinimized()) w.window.restore();
        w.window.focus();
      },
    });
    this.siteZoom = new SiteZoom({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      isPrivate: (contents) => {
        const node = this.store.state.nodes[this.tabs.nodeFor(contents) ?? ''];
        return node ? isPrivateChord(this.store.state, node.chordId) : false;
      },
    });
    options.httpAuth.connect({
      // A tab's page, or Peek's (its box shows over Peek). A mini window has no popover to ask in.
      nodeFor: (contents) => {
        const floating = this.tabs.floatingNodeFor(contents);
        return this.tabs.nodeFor(contents) ?? (floating && this.peeks.windowOf(floating) ? floating : undefined);
      },
      onChange: () => this.syncPopovers(),
    });
    // Choosing a passkey, over the same tab or Peek a sign-in box would show over.
    options.passkeys.connect({
      nodeFor: (contents) => {
        const floating = this.tabs.floatingNodeFor(contents);
        return this.tabs.nodeFor(contents) ?? (floating && this.peeks.windowOf(floating) ? floating : undefined);
      },
      onChange: () => this.syncPopovers(),
    });
    options.screenShare.connect({
      state: () => this.store.state,
      dispatch: (command) => this.store.dispatch(command),
      nodeFor: (contents) => this.tabs.nodeFor(contents),
      // A tab picked that fell asleep while the picker was up wakes to be shared.
      contentsOf: (nodeId) => this.tabs.ensure(nodeId)?.webContents,
      shareableTabs: (nodeId) => shareableTabs(this.store.state, nodeId, this.tabs.loaded()),
      onChange: () => this.syncPopovers(),
      sharingChanged: () => this.syncSharing(),
      repaint: (nodeId) => {
        const view = this.tabs.get(nodeId);
        if (view) for (const w of this.windows.values()) w.repaintParked(view);
      },
      cantStop: (nodeId, host) => {
        const windowId = this.windowShowing(nodeId);
        const w = windowId ? this.windows.get(windowId) : undefined;
        if (w) w.toast({ id: `share:${nodeId}`, message: `Chord can't stop this share. Use ${host}'s own Stop button.`, whilePresenting: true });
      },
    });
    this.idle = new IdleKeeper(
      {
        state: () => this.store.state,
        dispatch: (command) => this.store.dispatch(command),
        tabs: this.tabs,
        isCapturing: (nodeId) => options.permissions.isCapturing(nodeId),
        memoryLow: options.memoryLow,
      },
      options.idle,
    );
    this.store.subscribe((change) => {
      this.broadcast(change);
      this.runEffects(change.effects);
      this.syncPopovers();
      // A playing tab moved, closed or changed chords: the cards that may show it change.
      if (change.patches.some((p) => p.path[0] === 'nodes' || p.path[0] === 'chords' || p.path[0] === 'windows')) this.syncMedia();
      // Chord Player: the tab it plays for closed, or its chord's colors changed.
      if (this.player.nodeId && !change.state.nodes[this.player.nodeId]) this.player.tabClosed(this.player.nodeId);
      if (change.patches.some((p) => p.path[0] === 'chords' || (p.path[0] === 'nodes' && p.path[1] === this.player.nodeId) || (p.path[0] === 'settings' && p.path[1] === 'interface'))) this.player.themeChanged();
      this.extensions.sync();
      if (change.patches.some((p) => p.path[0] === 'extensions')) this.extensions.reconcile();
      // Pictures of tabs that were closed, archived or unpinned go; turning previews off takes them all.
      // "Keep recent screenshots" turned off: the kept ones go.
      if (!change.state.settings.keepScreenshots && change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'keepScreenshots')) void this.options.screenshots.forgetAll();
      if (change.patches.some((p) => p.path[0] === 'nodes' || p.path[0] === 'chords' || (p.path[0] === 'settings' && p.path[1] === 'pagePreviews'))) {
        this.previews.sync();
        if (!change.state.settings.pagePreviews) for (const w of this.windows.values()) w.hidePreview();
      }
      // Dry or wet everywhere: every page's Effects follow.
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'effects')) this.effects.everywhereChanged();
      // Presenting mode started or ended: what it hides, and the sidebars it collapses (after this change is out).
      if (change.patches.some((p) => p.path[0] === 'presenting')) {
        const presenting = change.state.presenting !== null;
        queueMicrotask(() => this.presentingChanged(presenting));
      }
      // A window moved while a screen is shared: whether it's on the shared screen may have changed.
      if (change.patches.some((p) => p.path[0] === 'windows') && this.options.screenShare.sources().some((s) => s.kind === 'screen')) {
        queueMicrotask(() => this.syncSharedWindows());
      }
      // New keys apply at once: the router reads them live, and the menus are rebuilt to show and accept them.
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'shortcuts')) {
        setShortcutOverrides(change.state.settings.shortcuts);
        this.applyAppMenu();
      }
      setUiScale(change.state.settings.uiScale);
      // Developer tools' side and size: docked ones move in every window, and DevTools windows' bars say where docking puts them.
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'devtools')) {
        for (const w of this.windows.values()) w.setDevtoolsSettings(change.state.settings.devtools);
        this.devtools.settingsChanged();
      }
      if (this.settingsWindow && change.patches.some((p) => ['settings', 'chords', 'windows', 'extensions', 'sitePermissions', 'linkRoutes'].includes(String(p.path[0])))) {
        this.settingsWindow.update(this.settingsSnapshot());
      }
      if (change.patches.some((p) => p.path[0] === 'chords')) this.minis.refresh();
      // Reader views: their chord's colors (a tab can move chords), their controls, their keys.
      if (change.patches.some((p) => p.path[0] === 'settings' || p.path[0] === 'chords' || p.path[0] === 'nodes')) this.syncReaders();
      if (change.patches.some((p) => p.path[0] === 'chords' || (p.path[0] === 'settings' && p.path[1] === 'interface'))) {
        for (const contents of this.archivePages()) send(contents, 'archive:snapshot', this.archiveSnapshot(contents));
      }
      options.onChange?.(change);
    });
  }

  /** Open a window for every window in the state that isn't open yet (or a new one if there are none), and show its active tab. */
  start(): void {
    const models = Object.values(this.store.state.windows);
    if (models.length === 0) this.newWindow();
    for (const model of models) if (!this.windows.has(model.id)) this.openWindow(model.id);
    this.idle.start();
  }

  /** Quitting: every window closing from now on is remembered for the next launch, as Chrome does. */
  prepareToQuit(): void {
    this.quitting = true;
    // While the pages are still there: where each one is now.
    this.histories.flush();
  }

  /**
   * ⌘N or ⌘⇧N: a new window on the chord you're in (or a private window with
   * a chord of its own), with the command bar open. Returns its id.
   */
  newWindow({ from, private: isPrivate = false }: { from?: WindowId; private?: boolean } = {}): WindowId {
    if (!isPrivate) {
      // A window you closed while only private ones were open was kept for the next launch; this one replaces it.
      for (const model of Object.values(this.store.state.windows)) {
        if (!model.private && !this.windows.has(model.id)) this.store.dispatch({ t: 'window.close', windowId: model.id });
      }
    }
    const windowId = uuidv7();
    this.store.dispatch({ t: 'window.create', windowId, ...(from ? { from } : {}), ...(isPrivate ? { privateChordId: uuidv7() } : {}) });
    return windowId;
  }

  private isPrivateNode(nodeId: NodeId): boolean {
    const node = this.store.state.nodes[nodeId];
    return node ? isPrivateChord(this.store.state, node.chordId) : false;
  }

  /** Chord launched again without a link: its first window comes forward (or its windows come back, if only mini windows were open). */
  focusFirstWindow(): void {
    if (this.windows.size === 0) this.start();
    const [first] = this.windows.values();
    if (!first) return;
    if (first.window.isMinimized()) first.window.restore();
    first.window.focus();
  }

  get windowCount(): number {
    return this.windows.size;
  }

  /** Each window's last snapshot fallback, for tests (chordTestHooks). */
  snapshotFallbacks(): AppWindow['snapshotFallback'][] {
    return [...this.windows.values()].map((w) => w.snapshotFallback);
  }

  windowFor(contents: WebContents): AppWindow | undefined {
    for (const w of this.windows.values()) {
      if ([w.shell.webContents, w.overlay.webContents, w.popover.webContents, w.preview.webContents, w.peekContents, ...w.paneContents].includes(contents)) return w;
    }
    const nodeId = this.tabs.nodeFor(contents);
    const windowId = nodeId ? this.windowShowing(nodeId) : undefined;
    return windowId ? this.windows.get(windowId) : undefined;
  }

  /** Whether one of Settings → Motion's switches is on, and the OS allows motion (DESIGN.md §6.8). */
  animates(gate: Parameters<typeof motionEnabled>[1]): boolean {
    return motionEnabled(this.store.state.settings, gate, systemInfo().prefersReducedMotion);
  }

  /**
   * Dock or collapse a window's sidebar (toggle it, with no `sidebar`). The
   * page's frame glides there by its snapshot (DESIGN.md §6.5), or changes at
   * once with "Animate the sidebar" off or reduced motion. Which way a toggle
   * goes is decided when it runs, so two quick toggles go there and back.
   */
  setSidebar(w: AppWindow, sidebar?: 'docked' | 'collapsed'): void {
    if (sidebar && this.store.state.windows[w.id]?.sidebar === sidebar) return;
    w.changeFrame(() => {
      const now = this.store.state.windows[w.id]?.sidebar;
      if (!now) return;
      this.store.dispatch({ t: 'window.sidebar', windowId: w.id, sidebar: sidebar ?? (now === 'collapsed' ? 'docked' : 'collapsed') });
    }, this.animates('sidebar'));
  }

  /** The pointer rests on a pinned tab or folder row in a window's sidebar (or left it). */
  previewHover(w: AppWindow, target: PreviewTarget): Promise<void> {
    return this.previews.hover(w, target);
  }

  activeUrl(windowId: WindowId): string {
    return activeTab(this.store.state, windowId)?.url ?? '';
  }

  private openWindow(windowId: WindowId, { commandBar = false } = {}): AppWindow {
    const model = this.store.state.windows[windowId]!;
    const w = new AppWindow({
      id: windowId,
      uiSession: this.options.uiSession,
      bounds: model.bounds && placeOnDisplays(model.bounds, screen.getAllDisplays().map((d) => d.workArea)),
      sidebar: model.sidebar,
      sidebarWidth: model.sidebarWidth,
      private: Boolean(model.private),
      onBounds: (bounds) => this.store.dispatch({ t: 'window.bounds', windowId, bounds }),
      presenting: () => this.store.state.presenting !== null,
      devtools: this.store.state.settings.devtools,
    });
    this.windows.set(windowId, w);
    this.finders.set(windowId, new FindInPage(() => this.syncPopover(w)));
    // A load can finish after its window has closed (quitting right after launch): only an open window syncs.
    w.popover.webContents.on('did-finish-load', () => {
      if (this.windows.get(windowId) !== w) return;
      this.popoverSent.delete(windowId);
      this.authFocused.delete(windowId);
      this.syncPopover(w);
    });
    w.shell.webContents.on('did-finish-load', () => {
      if (this.windows.get(windowId) !== w) return;
      this.extensions.forget(windowId);
      this.extensions.sync();
      // A shell that loaded again asks for the card's media itself, and hears every change from now on.
      this.mediaSent.delete(windowId);
    });
    // The chord swipe's phases (DESIGN.md §6.4): the renderer sees only wheel events, which
    // don't say when the fingers lift. Where the OS sends none, the shell ends on idle.
    w.shell.webContents.on('input-event', (_event, input) => {
      const phase = GESTURE_PHASES[input.type];
      if (phase) send(w.shell.webContents, 'gesture:phase', phase);
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
      this.duet?.forgetWindow(windowId);
      this.options.screenshots.windowClosed(windowId);
      this.effects.forgetWindow(windowId);
      this.windows.delete(windowId);
      this.finders.delete(windowId);
      this.popoverSent.delete(windowId);
      this.mediaSent.delete(windowId);
      this.authFocused.delete(windowId);
      this.extensions.forget(windowId);
      this.peeks.forget(windowId);
      this.quietWindows.delete(windowId);
      this.collapsedForPresenting.delete(windowId);
      if (this.lastWindowId === windowId) this.lastWindowId = this.windows.keys().next().value ?? null;
      this.windowClosed(windowId);
      // A shared tab waiting out of sight in this window goes to another one, so it keeps painting.
      this.syncParking();
      // A mini window still open keeps Chord running; closing it then quits (window-all-closed).
      if (this.windows.size === 0 && this.minis.count === 0 && process.platform !== 'darwin') {
        this.idle.stop();
        this.media.stop();
        this.histories.flush();
        this.tabs.destroyAll();
        this.settingsWindow?.window.close();
        app.quit();
      }
    });
    this.showPanes(w);
    if (commandBar) w.openOverlay('new', '');
    return w;
  }

  /**
   * A window closed. A private window is forgotten at once, sign-ins and all.
   * Closing one of several windows forgets it too; the last normal one, or
   * any while quitting, stays saved so it comes back next time.
   */
  private windowClosed(windowId: WindowId): void {
    const state = this.store.state;
    const model = state.windows[windowId];
    if (!model || this.quitting) return;
    if (model.private) {
      const profileId = state.chords[model.activeChordId]?.profileId;
      this.store.dispatch({ t: 'window.close', windowId });
      if (profileId) this.options.releaseProfile(profileId);
      return;
    }
    const normalOpen = [...this.windows.keys()].some((id) => !state.windows[id]?.private);
    if (normalOpen) this.store.dispatch({ t: 'window.close', windowId });
  }

  /** The window showing a tab (alone or as a split's pane), else one on its chord, else one on its side of the private line. */
  private windowShowing(nodeId: NodeId): WindowId | undefined {
    const peeking = this.peeks.windowOf(nodeId);
    if (peeking) return peeking;
    const models = Object.values(this.store.state.windows);
    const showing = models.find((m) => shownTabs(this.store.state, m.id).includes(nodeId));
    if (showing) return showing.id;
    const node = this.store.state.nodes[nodeId];
    const priv = node ? isPrivateChord(this.store.state, node.chordId) : false;
    return models.find((m) => m.activeChordId === node?.chordId)?.id ?? (priv ? undefined : models.find((m) => !m.private)?.id);
  }

  private broadcast(change: Change): void {
    if (change.patches.length === 0) return;
    const event = { version: change.state.version, patches: change.patches };
    // Archived rows leave the sidebar their own way (DESIGN.md §6.5): the shell hears which, before they go.
    const archived = change.effects.flatMap((e) => (e.e === 'archive.save' && e.tab.reason !== 'closed' ? [e.nodeId] : []));
    for (const w of this.windows.values()) {
      if (archived.length > 0) send(w.shell.webContents, 'sidebar:archived', { nodeIds: archived });
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
          if (!w) break;
          // Peek belongs to the page it came from: another tab, pane or chord closes it.
          this.peeks.close(w);
          this.showPanes(w);
          break;
        }
        case 'view.navigate': {
          // Going between Chord's own page and the web makes a new view; windows showing the tab take it.
          const before = this.tabs.get(effect.nodeId);
          this.tabs.navigate(effect.nodeId, effect.url);
          const after = this.tabs.get(effect.nodeId);
          if (after && after !== before) {
            for (const w of this.windows.values()) if (shownTabs(this.store.state, w.id).includes(effect.nodeId)) this.showPanes(w);
          }
          break;
        }
        case 'view.destroy':
          this.shareLost(effect.nodeId);
          this.histories.forget(effect.nodeId);
          this.tabs.destroy(effect.nodeId);
          break;
        case 'view.mute':
          this.tabs.setMuted(effect.nodeId, effect.muted);
          break;
        case 'view.sleep':
          this.tabs.sleep(effect.nodeId);
          // Asleep, its history is what brings it back, after a crash too.
          this.histories.touch(effect.nodeId, true);
          break;
        case 'archive.save': {
          // Before its view goes: the history is what brings it back where it was.
          const nav = this.tabs.history(effect.nodeId);
          this.rememberHistory(effect.tab.id, nav);
          this.options.history({ k: 'archive', tab: effect.tab, nav });
          this.archiveChanged();
          break;
        }
        case 'archive.restored':
          this.tabs.restoreHistoryOnLoad(effect.nodeId, this.archivedHistory.get(effect.archiveId) ?? null);
          this.archivedHistory.delete(effect.archiveId);
          this.options.history({ k: 'unarchive', id: effect.archiveId });
          this.archiveChanged();
          break;
        case 'window.layout':
          // Docking and collapsing glide by the frame's snapshot (setSidebar below); here the frame just moves.
          this.windows.get(effect.windowId)?.setSidebar(effect.sidebar, effect.width);
          break;
        case 'window.open':
          if (!this.windows.has(effect.windowId)) this.openWindow(effect.windowId, { commandBar: !this.quietWindows.has(effect.windowId) });
          break;
        case 'site.reload': {
          // Ad blocking changed for a site from its page's menu: its pages on screen reload once the change is in
          // (after this change's subscribers have asked for it, hence the microtask).
          const { site, chordId } = effect;
          queueMicrotask(() =>
            void this.options.adBlocking.settled().then(() => {
              for (const w of this.windows.values()) {
                if (chordId ? this.store.state.windows[w.id]?.activeChordId !== chordId : w.isPrivate) continue;
                for (const contents of w.paneContents) if (!contents.isDestroyed() && isBlockingOff(contents.getURL(), [site])) contents.reload();
              }
            }),
          );
          break;
        }
      }
    }
  }

  /**
   * The command bar's chosen row would open this page: open a connection to its server now (DNS, TCP, TLS),
   * in the session the page would load in, so it starts sooner on Enter, as Chrome's address bar does
   * (ROADMAP, P0 Performance). One connection, at most once per server every 10 s; web addresses only.
   */
  preconnect(w: AppWindow, url: string): void {
    let origin: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      origin = parsed.origin;
    } catch {
      return;
    }
    const chordId = this.store.state.windows[w.id]?.activeChordId;
    const profileId = chordId ? this.store.state.chords[chordId]?.profileId : undefined;
    if (!profileId) return;
    const key = `${profileId} ${origin}`;
    const now = Date.now();
    if (now - (this.preconnected.get(key) ?? -Infinity) < PRECONNECT_EVERY_MS) return;
    // Forget the oldest once the list is long: it only stops repeats.
    if (this.preconnected.size >= 256) this.preconnected.delete(this.preconnected.keys().next().value!);
    this.preconnected.delete(key);
    this.preconnected.set(key, now);
    this.options.profileSession(profileId).preconnect({ url: origin, numSockets: 1 });
  }

  /**
   * A tab's "Show count on tab": offered when its page gives itself a count, or its site's is
   * hidden, so it can come back. Not in private windows (the list is saved), nor with counts off.
   */
  private countMenu(tab: TabNode): { shown: boolean; toggle(): void } | null {
    const settings = this.store.state.settings.tabCounts;
    if (!settings.enabled || isPrivateChord(this.store.state, tab.chordId)) return null;
    const shown = countShows(tab.url, settings);
    if (shown && !this.tabs.hasBadge(tab.id)) return null;
    return { shown, toggle: () => this.store.dispatch({ t: 'tabCounts.site', site: tab.url, off: shown }) };
  }

  /** A page's "Block ads on this site": whether blocking is on there, and turning it off (or on again) with Undo. */
  private blockingMenu(contents: WebContents): { on(url: string): boolean | null; set(url: string, on: boolean): void } {
    const scope = () => {
      const profileId = this.options.adBlocking.profileOf(contents);
      const state = this.store.state;
      if (!profileId) return null;
      const privateChord = isPrivateProfile(profileId) ? Object.values(state.chords).find((c) => c.private && c.profileId === profileId) : undefined;
      return { profileId, chordId: privateChord?.id };
    };
    return {
      on: (url) => {
        const where = scope();
        if (!where || !this.store.state.settings.adBlocking.enabled || !blockingSite(url)) return null;
        return !isBlockingOff(url, blockingOffSites(this.store.state, where.profileId));
      },
      set: (url, on) => {
        const where = scope();
        const site = blockingSite(url);
        if (!where || !site) return;
        const command = (off: boolean) => ({ t: 'adBlocking.site' as const, site, off, ...(where.chordId ? { chordId: where.chordId } : {}) });
        this.store.dispatch(command(!on));
        this.windowFor(contents)?.toast({
          id: `blocking:${site}`,
          message: on ? `Blocking ads on ${site} again` : `Not blocking ads on ${site}`,
          action: { label: 'Undo', command: command(on) },
        });
      },
    };
  }

  /**
   * Put a window's pages in its frame as the state says: the active tab, or
   * every pane of its split (focused on the active tab), laid out as the
   * split says. Videos in pages that left the screen may pop out (auto
   * picture-in-picture); pages back on screen take theirs back.
   */
  private showPanes(w: AppWindow): void {
    const state = this.store.state;
    // A tab in reader view shows its reader view in the frame; its page waits behind, and counts as shown.
    const pages = (list: WebContents[]) => list.map((contents) => this.readers.pageOf(contents) ?? contents);
    const before = pages(w.paneContents);
    const active = activeTabId(state, w.id);
    const shown = shownTabs(state, w.id).flatMap((nodeId) => {
      const view = this.tabs.ensure(nodeId);
      return view ? [{ nodeId, view }] : [];
    });
    const split = active ? splitOf(state, active) : null;
    // Hover previews: picture the pages going off screen while their views are still attached.
    const showing = shown.map((p) => p.view.webContents);
    for (const contents of before) {
      const nodeId = showing.includes(contents) || contents.isDestroyed() ? undefined : this.tabs.nodeFor(contents);
      if (nodeId) this.previews.leaving(nodeId, contents);
    }
    // A shared tab leaving the screen stays where it is, out of sight, rather than being taken off the window.
    this.syncParking();
    w.showTabs(
      shown.map((p) => this.readers.viewFor(p.nodeId) ?? p.view),
      Math.max(0, shown.findIndex((p) => p.nodeId === active)),
      split ? { direction: split.direction, sizes: split.sizes } : null,
      // Each pane's docked developer tools, beside its page (or its reader view: they're the page's).
      shown.map((p) => {
        const view = this.devtools.dockedView(p.nodeId);
        return view ? { view, tab: p.nodeId } : null;
      }),
    );
    for (const { nodeId, view } of shown) if (!before.includes(view.webContents)) this.previews.shown(nodeId);
    this.extensions.tabShown(w);
    const after = pages(w.paneContents);
    for (const contents of before) {
      if (after.includes(contents) || contents.isDestroyed()) continue;
      this.autoPip.left(contents);
      const nodeId = this.tabs.nodeFor(contents);
      if (nodeId) this.media.left(nodeId);
    }
    for (const { nodeId, view } of shown) {
      this.autoPip.returned(nodeId);
      if (!before.includes(view.webContents)) this.autoPip.cameBack(nodeId);
    }
    this.syncPopover(w);
  }

  /**
   * A share started or ended (ARCHITECTURE.md §9): presenting mode starts
   * with the first and ends with the last, unless you turned it on yourself;
   * windows being shared get their tinted edge; shared tabs keep painting.
   */
  private syncSharing(): void {
    const sharing = this.options.screenShare.count > 0;
    if (sharing !== this.wasSharing) {
      this.wasSharing = sharing;
      this.store.dispatch({ t: 'presenting.set', on: sharing, by: 'share' });
    }
    this.syncSharedWindows();
    this.syncParking();
  }

  /**
   * Which of Chord's windows a page is sharing: one shared as a window, and
   * every window on a shared screen (all of them when the OS doesn't say
   * which screen). What the system's picker chose, Chord can't know.
   */
  private syncSharedWindows(): void {
    const windowIds: WindowId[] = [];
    for (const source of this.options.screenShare.sources()) {
      for (const w of this.windows.values()) {
        if (w.window.isDestroyed()) continue;
        const shared =
          source.kind === 'window'
            ? w.window.getMediaSourceId() === source.id
            : source.kind === 'screen' && (source.displayId === '' || String(screen.getDisplayMatching(w.window.getBounds()).id) === source.displayId);
        if (shared) windowIds.push(w.id);
      }
    }
    this.store.dispatch({ t: 'sharing.windows', windowIds });
  }

  /**
   * Shared tabs keep painting for the page capturing them (ARCHITECTURE.md
   * §9): one that isn't on screen stays attached to the window that has it,
   * out of sight, as the frame snapshot parks pages; a detached view has no
   * compositor, and its stream would freeze. A shared tab no window has yet
   * goes to the window of the page sharing it. One a window is about to show
   * stays where it is until it's a pane there.
   */
  private syncParking(): void {
    const state = this.store.state;
    const wanted = new Map<WindowId, WebContentsView[]>();
    const windows = [...this.windows.values()].filter((w) => !w.window.isDestroyed());
    for (const { nodeId, by } of this.options.screenShare.sharedTabs()) {
      const view = this.tabs.get(nodeId);
      if (!view || view.webContents.isDestroyed()) continue;
      const shownIn = Object.values(state.windows).find((m) => shownTabs(state, m.id).includes(nodeId))?.id;
      const holder = windows.find((w) => w.holds(view))?.id;
      // In reader view, the article stands in the frame and the page isn't on the window at all: it waits behind it.
      const reading = Boolean(this.readers.viewFor(nodeId));
      if (shownIn && !reading && shownIn !== holder) continue;
      const home = holder ?? (reading ? shownIn : undefined) ?? by.map((id) => this.windowShowing(id)).find((id) => id && this.windows.has(id)) ?? this.windowShowing(nodeId);
      if (home) wanted.set(home, [...(wanted.get(home) ?? []), view]);
    }
    for (const w of windows) w.park(wanted.get(w.id) ?? []);
  }

  /**
   * Presenting mode started or ended. Starting, hover previews go and, with
   * Settings → General's switch, sidebars collapse; ending, the sidebars it
   * collapsed dock again. The rest (history, previews, notifications,
   * toasts) is refused where it comes from, as long as it's on.
   */
  private presentingChanged(presenting: boolean): void {
    // Only on and off count (a share's mode becoming yours changes nothing here), and only the latest.
    if (presenting === this.presentingOn || presenting !== (this.store.state.presenting !== null)) return;
    this.presentingOn = presenting;
    this.applyAppMenu();
    if (presenting) {
      for (const w of this.windows.values()) w.hidePreview();
      if (!this.store.state.settings.presentingHidesSidebar) return;
      for (const w of this.windows.values()) {
        if (this.store.state.windows[w.id]?.sidebar !== 'docked') continue;
        this.collapsedForPresenting.add(w.id);
        this.setSidebar(w, 'collapsed');
      }
      return;
    }
    for (const id of this.collapsedForPresenting) {
      const w = this.windows.get(id);
      if (w) this.setSidebar(w, 'docked');
    }
    this.collapsedForPresenting.clear();
  }

  /**
   * A shared tab's page is about to close while the tab stays: it moved to
   * other sign-ins (a page can't change session), so its share ends with it.
   * The window says so, even while presenting: it's about the share itself.
   */
  private shareLost(nodeId: NodeId): void {
    const contents = this.tabs.get(nodeId)?.webContents;
    const node = this.store.state.nodes[nodeId];
    const chord = node ? this.store.state.chords[node.chordId] : undefined;
    if (!contents || contents.isDestroyed() || node?.kind !== 'tab' || !chord || !this.options.screenShare.isShared(nodeId)) return;
    if (contents.session === this.options.profileSession(chord.profileId)) return;
    // In the window of the page that was sharing it.
    const by = this.options.screenShare.sharedTabs().find((t) => t.nodeId === nodeId)?.by ?? [];
    const windowId = [...by, nodeId].map((id) => this.windowShowing(id)).find(Boolean);
    const title = node.customTitle || node.title || hostOf(node.url) || 'the tab';
    this.windows.get(windowId ?? '')?.toast({
      id: `share-ended:${nodeId}`,
      message: `Stopped sharing “${title}”: it moved to other sign-ins, so it loaded again`,
      whilePresenting: true,
    });
  }

  /** A page took the keyboard: if it's a pane of its window's split, that pane is now the focused one. */
  private paneFocused(nodeId: NodeId): void {
    const state = this.store.state;
    for (const w of Object.values(state.windows)) {
      if (activeTabId(state, w.id) === nodeId || !shownTabs(state, w.id).includes(nodeId)) continue;
      this.store.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
      return;
    }
  }

  /** What a window's popover shows: the find bar for its page, and the active tab's permission prompt. */
  popoverState(w: AppWindow): PopoverState {
    const state = this.store.state;
    const model = state.windows[w.id];
    const find = this.finders.get(w.id);
    const shown = this.peeks.contents(w) ?? w.activeTabContents;
    return {
      theme: model ? (state.chords[model.activeChordId]?.theme ?? null) : null,
      interface: state.settings.interface,
      find: find && find.target === shown ? find.state : null,
      permission: this.options.permissions.promptFor(activeTabId(state, w.id)),
      share: this.options.screenShare.promptFor(activeTabId(state, w.id)),
      // Peek's page is in front while it's open: its sign-in box first.
      auth: this.options.httpAuth.promptFor(this.peeks.nodeOf(w) ?? activeTabId(state, w.id)),
      passkey: this.options.passkeys.promptFor(this.peeks.nodeOf(w) ?? activeTabId(state, w.id)),
      // Not over first run (which asks itself), nor in a private window.
      safeBrowsingOffer: !w.isPrivate && state.settings.onboarded && this.options.safeBrowsing.offer(),
      // A tab whose service plays in Chord Player says so in its frame instead.
      drm: state.settings.onboarded || w.isPrivate ? (this.tabInPlayer(w) ? null : this.drm.noticeFor(this.activeUrl(w.id), w.isPrivate ? null : this.playerOffer())) : null,
      effects: this.effects.cardFor(w.id),
    };
  }

  /** A tab's Effects state for the button beside its address, sent only when it changes. */
  private setEffectsLive(nodeId: NodeId, effects: LiveTab['effects']): void {
    const live = this.store.state.live[nodeId];
    if (this.store.state.nodes[nodeId]?.kind === 'tab' && (live?.effects ?? null) !== effects) this.store.dispatch({ t: 'tab.live', nodeId, live: { effects } });
  }

  private tabInPlayer(w: AppWindow): boolean {
    const nodeId = activeTabId(this.store.state, w.id);
    return Boolean(nodeId && this.store.state.live[nodeId]?.player);
  }

  /** What the notice offers of Chord Player; while Chord finds out, the card waits a moment, then shows without it. */
  private playerOffer(): ReturnType<ChordPlayer['offer']> {
    const offer = this.player.offer();
    if (offer === 'pending' && !this.playerWait) {
      this.playerWait = setTimeout(() => {
        this.playerWait = null;
        this.syncPopovers();
      }, CHECK_WAIT_MS + 100);
    }
    return offer;
  }

  /**
   * The command bar's "Search … for this image" (main/image-search.ts): a new
   * tab, in front or behind, or the current one when its address was being
   * edited, loads the engine's upload as its first page. Never Google in
   * Google-free mode.
   */
  searchByImage(w: AppWindow, engine: ImageSearchEngine, image: SearchImage, where: 'current' | 'front' | 'background'): void {
    const state = this.store.state;
    if (engine === 'google' && state.settings.googleFree) return;
    const request = imageSearchRequest(engine, image, app.isPackaged ? undefined : process.env['CHORD_IMAGE_SEARCH_ORIGIN'] || undefined);
    const contents = where === 'current' ? w.activeTabContents : this.openTabFor(w, request.home, where === 'background');
    if (!contents || contents.isDestroyed()) return;
    contents.loadURL(request.url, { postData: [{ type: 'rawData', bytes: request.body }], extraHeaders: `Content-Type: ${request.contentType}
` }).catch(() => {});
  }

  /** A new tab in the window, on `url` for now, and its page, so main can load into it (an upload, say). */
  private openTabFor(w: AppWindow, url: string, background: boolean): WebContents | null {
    const before = new Set(Object.keys(this.store.state.nodes));
    this.store.dispatch({ t: 'tab.open', windowId: w.id, url, background });
    const nodeId = Object.keys(this.store.state.nodes).find((id) => !before.has(id));
    return nodeId ? (this.tabs.ensure(nodeId)?.webContents ?? null) : null;
  }

  /** The DRM notice's buttons, for the page the window shows: another browser, Chord Player (installing it first), or Not now. */
  drmAction(sender: WebContents, action: { open: OtherBrowserId } | { player: 'install' | 'open' | 'retry' } | 'dismiss'): void {
    const w = this.windowFor(sender);
    if (!w) return;
    const url = this.activeUrl(w.id);
    if (action === 'dismiss') this.drm.dismiss(url);
    else if ('open' in action) this.drm.open(url, action.open);
    else {
      // Never from a private window or in Google-free mode, and only for a service's page.
      const nodeId = activeTabId(this.store.state, w.id);
      if (w.isPrivate || this.store.state.settings.googleFree || !nodeId || !drmServiceFor(url)) return;
      void this.player.openFor(nodeId, url);
    }
  }

  /** Chord Player's install state changed: the DRM notices show it. */
  playerChanged(): void {
    this.syncPopovers();
  }

  /** A link Chord Player handed back: a new tab beside the tab it plays for, in that window, which comes forward. */
  private openPlayerLink(url: string, nodeId: NodeId | null): void {
    const showing = nodeId ? this.windows.get(this.windowShowing(nodeId) ?? '') : undefined;
    const w = showing && !showing.isPrivate ? showing : this.normalWindowForLinks();
    if (!w) return;
    this.store.dispatch({ t: 'tab.open', windowId: w.id, url });
    if (w.window.isMinimized()) w.window.restore();
    w.window.focus();
  }

  /** The player's Back to Chord: the tab it plays for comes forward in its window (a window comes back if none is open). */
  private backFromPlayer(nodeId: NodeId | null): void {
    if (this.windows.size === 0) this.start();
    const showing = nodeId ? this.windows.get(this.windowShowing(nodeId) ?? '') : undefined;
    const w = showing ?? this.lastNormalWindow();
    if (!w) return;
    if (nodeId && this.store.state.nodes[nodeId]) this.store.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
    if (w.window.isMinimized()) w.window.restore();
    // macOS doesn't let a background app take activation unless asked; this came from your click in the player.
    if (process.platform === 'darwin') app.focus({ steal: true });
    w.window.focus();
  }

  /** The chord's colors for the player's bar: the tab's chord, as a solid window draws it (DESIGN.md §5). */
  private playerTheme(nodeId: NodeId): Theme | null {
    const state = this.store.state;
    const node = state.nodes[nodeId];
    const chord = node ? state.chords[node.chordId] : undefined;
    if (!chord) return null;
    const info = systemInfo();
    const accent = info.accentColor ? hexToRgb(info.accentColor) : null;
    const theme = createChordTheme(chord.theme, {
      systemAppearance: info.appearance,
      material: 'solid',
      contrast: state.settings.interface.contrast,
      glass: state.settings.interface.glass,
      focus: accent ? rgbToOklch(accent) : null,
    });
    const vars: Theme['vars'] = {};
    for (const name of THEME_VARS) if (theme.vars[name]) vars[name] = theme.vars[name];
    return { appearance: theme.appearance, vars };
  }

  /** A tab that plays in Chord Player: back to the player, or its page here instead. Only a tab the window's card or frame shows. */
  async playerAction(w: AppWindow, nodeId: NodeId, action: 'show' | 'release'): Promise<void> {
    if (nodeId !== this.player.nodeId || mediaVisibleTo(this.store.state, w.id, [{ nodeId }]).length === 0) return;
    if (action === 'show') await this.player.focus();
    else this.player.release(nodeId);
  }

  /** Everything that plays in a window's chords: Chord Player (for its tab) and the tabs themselves, newest first. */
  private allMedia(): NowPlaying[] {
    const player = this.player.nowPlaying();
    const tabs = this.media.list();
    return player ? [player, ...tabs.filter((m) => m.nodeId !== player.nodeId)] : tabs;
  }

  /** What a window's Now playing card may offer: tabs in its chords playing media, newest first. */
  nowPlaying(windowId: WindowId): NowPlaying[] {
    return mediaVisibleTo(this.store.state, windowId, this.allMedia());
  }

  /** The card's Play, Pause and picture-in-picture, for a tab the window's card offers; and Mute for Chord Player. */
  async mediaAction(w: AppWindow, nodeId: NodeId, action: MediaAction): Promise<void> {
    if (mediaVisibleTo(this.store.state, w.id, [{ nodeId }]).length === 0) return;
    if (nodeId === this.player.nodeId && this.player.nowPlaying()) {
      if (action !== 'pictureInPicture') await this.player.act(action);
      return;
    }
    if (!this.media.has(nodeId) || action === 'mute' || action === 'unmute') return;
    if (action === 'pictureInPicture') await this.autoPip.toggle(nodeId);
    else await this.media.act(nodeId, action);
  }

  /**
   * Each window's card hears what changed: the media in its chords. Compared by
   * the watcher's version and which tabs, so artwork isn't compared byte by byte.
   */
  private syncMedia(): void {
    const playing = this.allMedia();
    for (const w of this.windows.values()) {
      const shown = mediaVisibleTo(this.store.state, w.id, playing);
      const key = `${this.media.version}:${this.player.version}:${shown.map((p) => p.nodeId).join(',')}`;
      if (this.mediaSent.get(w.id) === key) continue;
      this.mediaSent.set(w.id, key);
      send(w.shell.webContents, 'media:state', shown);
    }
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
    // Find works on the focused pane, or Peek's page over it; it closes when focus moves elsewhere.
    if (find?.target && find.target !== (this.peeks.contents(w) ?? w.activeTabContents)) find.close(false);
    const state = this.store.state;
    // The frame explains errors and crashes (pane by pane), and holds first run's cards, instead of the page.
    const onboarding = !state.settings.onboarded && !w.isPrivate;
    const hidden = new Set<WebContents>();
    for (const nodeId of shownTabs(state, w.id)) {
      const live = state.live[nodeId];
      const contents = this.tabs.get(nodeId)?.webContents;
      if (contents && (onboarding || live?.error || live?.crashed || live?.threat || live?.player)) hidden.add(contents);
    }
    w.setHiddenPanes(hidden);
    const popover = this.popoverState(w);
    const json = JSON.stringify(popover);
    if (this.popoverSent.get(w.id) === json) return;
    this.popoverSent.set(w.id, json);
    send(w.popover.webContents, 'popover:state', popover);
    // A new sign-in box takes the keyboard, ready to type the username.
    // A new sign-in box or passkey choice takes the keyboard, ready to answer.
    const asking = popover.auth ? `auth:${popover.auth.id}` : popover.passkey ? `passkey:${popover.passkey.id}` : '';
    if (asking && this.authFocused.get(w.id) !== asking) w.focusPopover();
    this.authFocused.set(w.id, asking);
  }

  /** Run an action for the window that owns this contents (keys, the shell's buttons, the command bar). */
  run(action: ActionId, contents: WebContents): boolean {
    // A key in a tab's developer tools (or their window's bar) acts for that tab.
    const devtoolsOf = this.devtools.nodeOf(contents);
    if (devtoolsOf) return this.runInDevtools(action, devtoolsOf, contents);
    const own = this.windowFor(contents);
    if (own) return this.runAction(action, own, contents);
    const w = contents === this.settingsWindow?.view.webContents ? this.lastWindow() : undefined;
    if (w) return this.runAction(action, w);
    // A mini window: its own few (close, back, reload…); app-wide ones act on the last normal window.
    // The rest stay the page's.
    if (this.minis.forContents(contents)) {
      if (this.minis.run(action, contents)) return true;
      if (action === 'app.quit') app.quit();
      else if (action.startsWith('app.') || action.startsWith('window.new')) this.runInFocusedWindow(action);
      else return false;
      return true;
    }
    return false;
  }

  /**
   * A reserved key pressed in a tab's developer tools, as Chrome has them:
   * F12 closes them, reloading reloads their page. Docked, the rest act in
   * their window as from the page beside them (it's the focused pane by
   * then). In their own window, closing it (⌘W) closes them; other keys are
   * DevTools' own.
   */
  private runInDevtools(action: ActionId, nodeId: NodeId, contents: WebContents): boolean {
    const page = this.tabs.get(nodeId)?.webContents;
    switch (action) {
      case 'app.devtools':
        this.devtools.close(nodeId);
        return true;
      case 'app.devtoolsWindow':
        this.devtools.toggleWindow(nodeId, true);
        return true;
      case 'nav.reload':
        page?.reload();
        return true;
      case 'nav.hardReload':
        page?.reloadIgnoringCache();
        return true;
      case 'app.quit':
        app.quit();
        return true;
    }
    if (this.devtools.placeOf(nodeId) === 'docked') {
      const w = this.windows.get(this.windowShowing(nodeId) ?? '');
      return w ? this.runAction(action, w, contents) : false;
    }
    if (action === 'tab.close' || action === 'window.close') {
      this.devtools.close(nodeId);
      return true;
    }
    return false;
  }

  /** Inspect, from a page's right-click menu: a tab's developer tools where they live; Peek's or a mini window's, popped out. */
  private inspectAt(contents: WebContents, nodeId: NodeId, x: number, y: number): void {
    if (this.tabs.get(nodeId)?.webContents === contents) {
      this.devtools.inspect(nodeId, x, y);
      return;
    }
    if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: 'detach' });
    contents.inspectElement(x, y);
    contents.devToolsWebContents?.focus();
  }

  /**
   * Developer tools' header in the shell (a tab its window shows), or the bar
   * of their window (its own tab): close, pop out, dock, the other side, and
   * the edge between them and the page, dragged live and saved when let go.
   */
  devtoolsAction(sender: WebContents, action: DevtoolsAction): void {
    const barOf = this.devtools.nodeOfBar(sender);
    if (barOf) {
      if (action.do === 'dock') this.devtools.dock(barOf, true);
      else if (action.do === 'close') this.devtools.close(barOf);
      return;
    }
    const w = this.windowFor(sender);
    if (!w) return;
    const settings = this.store.state.settings.devtools;
    switch (action.do) {
      case 'resize':
        if (!action.done) return w.dragDevtools(action.size);
        this.store.dispatch({ t: 'settings.set', settings: { devtools: settings.side === 'right' ? { width: action.size } : { height: action.size } } });
        w.dragDevtools(null);
        return;
      case 'side':
        this.store.dispatch({ t: 'settings.set', settings: { devtools: { side: action.side } } });
        return;
    }
    const nodeId = action.nodeId;
    if (!nodeId || !shownTabs(this.store.state, w.id).includes(nodeId)) return;
    if (action.do === 'close') this.devtools.close(nodeId);
    else if (action.do === 'window') this.devtools.popOut(nodeId);
    else this.devtools.dock(nodeId);
  }

  /** Whether a tab's developer tools may open: any web page; Chord's own pages only in development builds, as Inspect Chord UI. */
  private devtoolsAllowed(nodeId: NodeId): boolean {
    const node = this.store.state.nodes[nodeId];
    return node?.kind === 'tab' && (!app.isPackaged || !isInternalUrl(node.url));
  }

  /** Menu items act on the focused Chord window, or the last one used (when Settings has focus). */
  private runInFocusedWindow(action: ActionId): void {
    const focused = BaseWindow.getFocusedWindow();
    const w = [...this.windows.values()].find((x) => x.window === focused) ?? this.lastWindow();
    if (w) this.runAction(action, w, webContents.getFocusedWebContents());
    else if (action === 'app.settings' || action === 'app.shortcuts') this.openSettings(action === 'app.shortcuts' ? 'shortcuts' : undefined);
    // macOS, with every window closed: ⌘N and ⌘⇧N still make one.
    else if (action === 'window.new' || action === 'window.newPrivate') this.newWindow({ private: action === 'window.newPrivate' });
  }

  /** The normal browser window used most recently: Settings acts on it, never on a private window. */
  lastBrowserWindow(): AppWindow | undefined {
    return this.lastNormalWindow();
  }

  private lastWindow(): AppWindow | undefined {
    return (this.lastWindowId ? this.windows.get(this.lastWindowId) : undefined) ?? this.windows.values().next().value;
  }

  /** The window used most recently that isn't private: where Settings, links from other apps and extensions act. */
  private lastNormalWindow(): AppWindow | undefined {
    const last = this.lastWindow();
    if (last && !last.isPrivate) return last;
    return [...this.windows.values()].find((w) => !w.isPrivate);
  }

  settingsSnapshot(): SettingsSnapshot {
    const state = this.store.state;
    const last = this.lastNormalWindow();
    const model = last ? state.windows[last.id] : undefined;
    const chord = model ? state.chords[model.activeChordId] : sortedChords(state)[0];
    return {
      settings: state.settings,
      chord: chord ? { id: chord.id, name: chord.name, icon: chord.icon, theme: chord.theme } : null,
      extensions: this.extensions.infos(),
      chords: sortedChords(state).map((c) => ({ id: c.id, name: c.name, icon: c.icon, profileId: c.profileId })),
      sitePermissions: state.sitePermissions,
      spellcheckLanguages: spellcheckLanguages(),
      linkRoutes: Object.values(state.linkRoutes).sort((a, b) => a.host.localeCompare(b.host)),
      effects: this.effects.sites(),
    };
  }

  /** Builds the menus from the current shortcuts and installs the app menu. */
  applyAppMenu(): void {
    this.appMenu = buildAppMenu((action) => this.runInFocusedWindow(action), this.store.state.presenting !== null);
    Menu.setApplicationMenu(this.appMenu);
  }

  /** Settings is (or stops) recording a shortcut in this contents. Only the Settings view may ask. */
  setRecordingShortcut(contents: WebContents, recording: boolean): void {
    this.recordingIn = recording && contents === this.settingsWindow?.view.webContents ? contents : null;
  }

  openSettings(section?: string): void {
    if (this.settingsWindow) {
      this.settingsWindow.show(section);
      return;
    }
    this.settingsWindow = new SettingsWindow(this.options.uiSession, this.lastWindow()?.window.getBounds(), section, () => {
      this.settingsWindow = null;
      this.recordingIn = null;
    });
    // Recording a shortcut ends when Settings loses focus, whatever its page says.
    this.settingsWindow.window.on('blur', () => {
      this.recordingIn = null;
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

  /**
   * Links from other apps (Chord as the default browser). A link route sends
   * its site straight to its chord, as a tab. Otherwise it opens in a mini
   * window (Settings → General, the default) or as a tab in the normal window
   * used last. Never into a private window.
   */
  openExternalUrls(urls: readonly string[]): void {
    const state = this.store.state;
    const tabs: { url: string; chordId: string | null }[] = [];
    for (const url of urls) {
      const routed = routeFor(state, url);
      if (!routed && state.settings.externalLinks === 'mini') this.minis.show(url);
      else tabs.push({ url, chordId: routed });
    }
    if (tabs.length === 0) return;
    const w = this.normalWindowForLinks();
    if (!w) return;
    for (const { url, chordId } of tabs) {
      if (chordId && chordId !== this.store.state.windows[w.id]?.activeChordId) this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
      this.store.dispatch({ t: 'tab.open', windowId: w.id, url });
    }
    if (w.window.isMinimized()) w.window.restore();
    w.window.focus();
  }

  /** The normal window links go to: the one used last, after bringing windows back (macOS keeps running without any). */
  private normalWindowForLinks({ quiet = false } = {}): AppWindow | undefined {
    if (this.windows.size === 0) this.start();
    if (!this.lastNormalWindow()) {
      const id = this.newWindow();
      if (quiet) this.quietWindows.add(id);
    }
    return this.lastNormalWindow();
  }

  /**
   * "Open in" from a mini window: its page becomes the top tab of `chordId`
   * in a normal window (one already on that chord, else the one used last,
   * which switches to it). With the same sign-ins the live page moves,
   * history and all; with different ones it opens again there.
   */
  private promoteMini(nodeId: NodeId, chordId: string, page: WebContents): void {
    const state = this.store.state;
    const chord = state.chords[chordId];
    if (!chord || chord.private) return;
    const url = page.getURL();
    const onChord = [...this.windows.values()].find((x) => !x.isPrivate && state.windows[x.id]?.activeChordId === chordId);
    const w = onChord ?? this.normalWindowForLinks({ quiet: true });
    if (!w) return;
    if (page.session === this.options.profileSession(chord.profileId)) {
      const view = this.tabs.adopt(nodeId);
      if (view) {
        this.store.dispatch({ t: 'tab.adopt', windowId: w.id, nodeId, chordId, url, title: page.getTitle(), live: liveOf(page) });
        this.extensions.tabCreated(page, nodeId);
        this.readers.detect(nodeId);
      }
    } else {
      this.tabs.closeFloating(nodeId);
      if (this.store.state.windows[w.id]?.activeChordId !== chordId) this.store.dispatch({ t: 'chord.activate', windowId: w.id, chordId });
      this.store.dispatch({ t: 'tab.open', windowId: w.id, url });
      w.toast({ id: `mini-moved:${nodeId}`, message: `Opened in ${chord.name} (sign-ins differ, so it loaded again)` });
    }
    if (w.window.isMinimized()) w.window.restore();
    w.window.focus();
    const offer = this.routeOffer(url, chordId, w);
    if (offer) {
      w.toast({
        id: `route-offer:${offer}`,
        message: `Always open ${offer} in ${chord.name}?`,
        action: { label: 'Always', command: { t: 'linkRoute.set', host: offer, chordId } },
      });
    }
  }

  /**
   * Learning which chord a site belongs in (from Crest), as an offer, never
   * silently: the second time this session a site's page goes to the same
   * chord (from a mini window, or moved there), Chord asks once whether its
   * links should always open there. Returns the site to ask about, if it's time.
   */
  private routeOffer(url: string, chordId: string, w: AppWindow): string | null {
    const host = routeHost(hostOf(url) ?? '');
    const chord = this.store.state.chords[chordId];
    if (!host || !chord || chord.private || w.isPrivate || this.routeOffered.has(host) || this.store.state.linkRoutes[host]) return null;
    const counts = this.routeHints.get(host) ?? new Map<string, number>();
    const seen = (counts.get(chordId) ?? 0) + 1;
    counts.set(chordId, seen);
    this.routeHints.set(host, counts);
    if (seen < 2) return null;
    this.routeOffered.add(host);
    return host;
  }

  /** Close the overlay for this opening; Peek's closes Peek. */
  closeOverlay(contents: WebContents, seq: number, dismissed = false): void {
    const w = this.windowFor(contents);
    if (!w) return;
    if (w.peekOverlaySeq === seq) this.peeks.close(w);
    else w.closeOverlay(seq, dismissed);
    // Capture mode closed without taking anything (a no-op otherwise); picking for Effects says what it hid.
    this.options.screenshots.cancel(w);
    this.effects.pickDone(w.id);
  }

  /** Peek's "Open in Today", from its header. */
  expandPeek(contents: WebContents): void {
    const w = this.windowFor(contents);
    if (w) this.peeks.expand(w);
  }

  /** Settings → General → Link routes: send a site to a chord, or stop. */
  setLinkRoute(host: string, chordId: string | null): void {
    if (chordId) this.store.dispatch({ t: 'linkRoute.set', host, chordId });
    else this.store.dispatch({ t: 'linkRoute.delete', host });
  }

  /** A link from Settings opens as a new tab in the normal window used last, which comes forward. */
  openUrlInLastWindow(url: string): void {
    const w = this.lastNormalWindow();
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
    if (!w || !node) return;
    if (node.kind === 'folder') {
      w.popupMenu(
        buildFolderMenu({
          collapsed: node.collapsed,
          toggle: () => this.store.dispatch({ t: 'folder.toggle', nodeId, collapsed: !node.collapsed }),
          rename: () => send(w.shell.webContents, 'sidebar:rename', { nodeId }),
          newFolderInside: () => this.createFolder(w, node.chordId, null, nodeId),
          delete: () => this.deleteFolder(w, nodeId),
        }),
        { ...at, width: 0, height: 0 },
      );
      return;
    }
    if (node.kind === 'split') {
      const pinned = node.section === 'pinned';
      const first = splitMembers(this.store.state, nodeId)[0];
      w.popupMenu(
        buildSplitMenu({
          pinned,
          canPin: !isPrivateChord(this.store.state, node.chordId),
          togglePin: () => first && this.store.dispatch({ t: pinned ? 'tab.unpin' : 'tab.pin', nodeId: first.id }),
          separate: () => this.separateSplit(w, nodeId),
          close: () => {
            for (const pane of splitMembers(this.store.state, nodeId)) this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId: pane.id });
          },
        }),
        { ...at, width: 0, height: 0 },
      );
      return;
    }
    const tab: TabNode = node;
    const state = this.store.state;
    const from = state.chords[tab.chordId];
    // "Open in split" puts it beside the tab on screen (or in that tab's split, if there's room).
    const shown = activeTab(state, w.id);
    const shownSplit = shown ? splitOf(state, shown.id) : null;
    const inShownSplit = shownSplit !== null && tab.parentId === shownSplit.id;
    const room = !shownSplit || splitMembers(state, shownSplit.id).length < SPLIT.maxPanes;
    const canSplit = shown !== null && shown.id !== tab.id && shown.chordId === tab.chordId && !inShownSplit && room;
    const ownSplit = splitOf(state, tab.id);
    w.popupMenu(
      buildTabMenu({
        url: tab.url,
        pinned: tab.section === 'pinned',
        // Nothing pins in a private window.
        canPin: !isPrivateChord(this.store.state, tab.chordId),
        togglePin: () => this.store.dispatch({ t: tab.section === 'pinned' ? 'tab.unpin' : 'tab.pin', nodeId }),
        copyLink: () => clipboard.writeText(tab.url),
        copyMarkdown: () => clipboard.writeText(markdownLink(tab.title, tab.url)),
        reload: () => this.tabs.get(nodeId)?.webContents.reload(),
        duplicate: () => this.store.dispatch({ t: 'tab.open', windowId: w.id, url: tab.url }),
        muted: Boolean(tab.muted),
        toggleMute: () => this.store.dispatch({ t: 'tab.mute', nodeId, muted: !tab.muted }),
        count: this.countMenu(tab),
        close: () => this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId }),
        addFavorite: this.canFavorite(tab) ? () => this.store.dispatch({ t: 'favorite.add', favoriteId: uuidv7(), nodeId }) : null,
        newFolder: () => this.createFolder(w, tab.chordId, nodeId),
        openInSplit: canSplit && shown ? () => this.store.dispatch({ t: 'split.add', windowId: w.id, withId: shown.id, nodeId }) : null,
        removeFromSplit: ownSplit ? () => this.store.dispatch({ t: 'split.remove', nodeId }) : null,
        moveTargets: (isPrivateChord(state, tab.chordId) ? [] : chordsFor(state, w.id))
          .filter((c) => c.id !== tab.chordId)
          .map((c) => ({ id: c.id, label: `${c.icon}  ${c.name}`, signInsDiffer: c.profileId !== from?.profileId })),
        moveTo: (chordId) => this.moveToChord(w, nodeId, chordId),
        stopSharing:
          state.live[nodeId]?.sharing || state.live[nodeId]?.shared
            ? { label: state.live[nodeId]?.sharing ? 'Stop sharing' : 'Stop sharing this tab', click: () => void this.options.screenShare.stop(nodeId) }
            : null,
        // Reader view, for a page that reads as an article (or shows one now): the tab comes to the front for it.
        reader: state.live[nodeId]?.reader || state.live[nodeId]?.readable ? { on: Boolean(state.live[nodeId]?.reader) } : null,
        toggleReader: () => {
          if (!shownTabs(this.store.state, w.id).includes(nodeId)) this.store.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
          void this.readers.toggle(nodeId);
        },
        backToPinned: tab.pinnedUrl && tab.section === 'pinned' && !sameOrigin(tab.url, tab.pinnedUrl) ? () => this.store.dispatch({ t: 'tab.navigate', nodeId, url: tab.pinnedUrl! }) : null,
      }),
      { ...at, width: 0, height: 0 },
    );
  }

  /** The page in a window's focused pane: behind its reader view, if it has one open. */
  pageIn(w: AppWindow): WebContents | null {
    return this.readers.pageOf(w.activeTabContents) ?? w.activeTabContents;
  }

  /** A reader view's page gets what Chord's views get, plus what a tab's page gets: zoom keys and the wheel, and focus that picks a split's pane. */
  private wireReader(contents: WebContents, nodeId: NodeId): void {
    attachShortcuts(contents, this.keyboard);
    attachContextMenu(contents, {
      surface: 'reader',
      inspect: !app.isPackaged,
      searchEngine: () => this.store.state.settings.searchEngine,
      openTab: (url, background) => {
        const windowId = this.windowShowing(nodeId);
        if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url, background });
      },
      placement: () => {
        const owner = this.windowFor(contents)?.window;
        const bounds = this.readers.viewFor(nodeId)?.getBounds();
        return owner && bounds ? { window: owner, x: bounds.x, y: bounds.y } : undefined;
      },
    });
    contents.on('focus', () => this.paneFocused(nodeId));
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown') this.paneFocused(nodeId);
    });
    // Ctrl + wheel (and pinching) changes the text size, as the zoom keys do.
    contents.on('zoom-changed', (_event, direction) => this.stepReaderSize(direction === 'in' ? 1 : -1));
    contents.once('destroyed', () => this.readerSent.delete(contents.id));
  }

  /** Reader view's text, a size bigger or smaller (every reader view follows: it's one setting). */
  private stepReaderSize(by: 1 | -1): void {
    const size = Math.min(READER_SIZES - 1, Math.max(0, this.store.state.settings.reader.size + by));
    this.store.dispatch({ t: 'settings.set', settings: { reader: { size } } });
  }

  /**
   * A link in a reader view, followed as one in its tab would be: from a
   * pinned tab to another site, in Peek (unless asked for behind); otherwise
   * in the tab (reader view closes as the page goes), or in a new tab.
   */
  private followFromReader(nodeId: NodeId, url: string, target: ReaderLinkTarget): void {
    const windowId = this.windowShowing(nodeId);
    const w = windowId ? this.windows.get(windowId) : undefined;
    const node = this.store.state.nodes[nodeId];
    if (!w || node?.kind !== 'tab') return;
    if (target !== 'background' && node.section === 'pinned' && isCrossSite(node.url, url)) this.peeks.show(w, nodeId, url, null);
    else if (target === 'here') this.store.dispatch({ t: 'tab.navigate', nodeId, url });
    else this.store.dispatch({ t: 'tab.open', windowId: w.id, url, background: target === 'background' });
  }

  /** How a reader view looks: its tab's chord colors, the interface and reader settings, reduced motion, its keys. */
  readerLook(contents: WebContents): ReaderLook {
    const state = this.store.state;
    const nodeId = this.readers.nodeOf(contents);
    const node = nodeId ? state.nodes[nodeId] : undefined;
    return {
      theme: node ? (state.chords[node.chordId]?.theme ?? null) : null,
      interface: state.settings.interface,
      reader: state.settings.reader,
      reducedMotion: state.settings.motion.followSystem && systemInfo().prefersReducedMotion,
      toggleKeys: keycapFor('view.reader', platform, state.settings.shortcuts),
    };
  }

  /** Each reader view hears when how it looks changed (and, with `system`, the computer's settings too). */
  private syncReaders(system = false): void {
    for (const contents of this.readers.contents()) {
      if (system) send(contents, 'system:changed', systemInfo());
      const look = this.readerLook(contents);
      const json = JSON.stringify(look);
      if (this.readerSent.get(contents.id) === json) continue;
      this.readerSent.set(contents.id, json);
      send(contents, 'reader:look', look);
    }
  }

  openFavoriteMenu(contents: WebContents, favoriteId: string, at: { x: number; y: number }): void {
    const w = this.windowFor(contents);
    if (!w || !this.store.state.favorites[favoriteId]) return;
    w.popupMenu(buildFavoriteMenu({ remove: () => this.store.dispatch({ t: 'favorite.remove', favoriteId }) }), { ...at, width: 0, height: 0 });
  }

  /** A web page that isn't a favorite yet. */
  private canFavorite(tab: TabNode): boolean {
    const url = tab.pinnedUrl ?? tab.url;
    return /^https?:/i.test(url) && !Object.values(this.store.state.favorites).some((f) => f.url === url);
  }

  /**
   * A new folder, named "New folder" and ready to rename: around `tabId`
   * (pinning it), or empty at the end of Pinned, or inside `parentId`.
   */
  createFolder(w: AppWindow, chordId: string, tabId: NodeId | null, parentId: NodeId | null = null): void {
    const folderId = uuidv7();
    this.store.dispatch({ t: 'folder.create', folderId, chordId, title: 'New folder', ...(tabId ? { tabId } : {}) });
    if (!this.store.state.nodes[folderId]) return;
    if (parentId) this.store.dispatch({ t: 'node.move', nodeId: folderId, section: 'pinned', index: Number.MAX_SAFE_INTEGER, parentId });
    send(w.shell.webContents, 'sidebar:rename', { nodeId: folderId });
  }

  /** Delete at once and offer Undo (DESIGN.md §9: "Deleted folder 'Reading' · Undo"). */
  deleteFolder(w: AppWindow, nodeId: NodeId): void {
    const folder = this.store.state.nodes[nodeId];
    if (folder?.kind !== 'folder') return;
    this.store.dispatch({ t: 'folder.delete', nodeId });
    w.toast({
      id: `folder-deleted:${nodeId}`,
      message: `Deleted folder “${folder.title}”`,
      action: { label: 'Undo', command: { t: 'folder.restore', nodeId } },
    });
  }

  /**
   * Move a tab to another chord, with Undo back to the exact spot. With
   * different sign-ins its page closes and reloads in the new session, and
   * the toast says so (DESIGN.md §9).
   */
  moveToChord(w: AppWindow, nodeId: NodeId, chordId: string): void {
    const state = this.store.state;
    const tab = state.nodes[nodeId];
    const to = state.chords[chordId];
    if (tab?.kind !== 'tab' || !to || tab.chordId === chordId) return;
    // A private window's tabs stay in it, and nothing moves into one.
    if (to.private || isPrivateChord(state, tab.chordId)) return;
    const from = tab.chordId;
    const place = { section: tab.section, parentId: tab.parentId, rank: tab.rank };
    const reloads = state.chords[from]?.profileId !== to.profileId;
    // A shared tab's page closes with other sign-ins, and its share ends: the move's own toast says so (replacing shareLost's).
    const unshared = reloads && this.options.screenShare.isShared(nodeId);
    this.store.dispatch({ t: 'node.moveToChord', nodeId, chordId });
    const offer = this.routeOffer(tab.url, chordId, w);
    w.toast({
      id: unshared ? `share-ended:${nodeId}` : `tab-moved:${nodeId}`,
      message: unshared ? `Moved to ${to.name} (sign-ins differ, so it reloaded and is no longer shared)` : reloads ? `Moved to ${to.name} (sign-ins differ, so it reloaded)` : `Moved to ${to.name}`,
      ...(unshared ? { whilePresenting: true } : {}),
      action: { label: 'Undo', command: { t: 'node.moveToChord', nodeId, chordId: from, place } },
      // The second move of a site's page to this chord: offer a route on the same toast.
      ...(offer ? { also: { message: `Always open ${offer} here?`, action: { label: 'Always', command: { t: 'linkRoute.set', host: offer, chordId } } } } : {}),
    });
  }

  /** Clear: every Today tab in the chord goes to the archive, and Undo brings them back in place. */
  private clearToday(w: AppWindow): void {
    const state = this.store.state;
    const chordId = state.windows[w.id]?.activeChordId;
    if (!chordId) return;
    // Splits stay: you set them up on purpose (separate one to let its tabs go).
    const nodeIds = children(state, chordId, 'today', null)
      .filter((n) => n.kind === 'tab')
      .map((n) => n.id);
    if (nodeIds.length === 0) return;
    const shown = activeTabId(state, w.id);
    const archives = !isPrivateChord(state, chordId);
    if (archives) this.store.dispatch({ t: 'tab.archive', nodeIds, reason: 'cleared' });
    else for (const nodeId of nodeIds) this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId });
    w.toast({
      id: `today-cleared:${chordId}`,
      message: `${archives ? 'Archived' : 'Closed'} ${nodeIds.length} ${nodeIds.length === 1 ? 'tab' : 'tabs'}`,
      action: { label: 'Undo', command: { t: 'closed.restore', windowId: w.id, nodeIds, activate: shown && nodeIds.includes(shown) ? shown : null } },
    });
  }

  /**
   * Separate a split's tabs, each back in the sidebar where the split was,
   * with Undo (DESIGN.md §8.4: each step can be undone from a toast).
   */
  separateSplit(w: AppWindow, splitId: NodeId): void {
    const state = this.store.state;
    const split = state.nodes[splitId];
    if (split?.kind !== 'split') return;
    const nodeIds = splitMembers(state, splitId).map((t) => t.id);
    const focus = activeTabId(state, w.id);
    this.store.dispatch({ t: 'split.separate', splitId });
    w.toast({
      id: `split-separated:${splitId}`,
      message: 'Separated split tabs',
      action: {
        label: 'Undo',
        command: {
          t: 'split.join',
          windowId: w.id,
          splitId,
          nodeIds,
          direction: split.direction,
          sizes: split.sizes,
          ...(focus && nodeIds.includes(focus) ? { focus } : {}),
        },
      },
    });
  }

  /** While a tab is dragged from the sidebar, the shell sits above the page to draw split drop zones. */
  setLifted(contents: WebContents, lifted: boolean): void {
    this.windowFor(contents)?.setLifted(lifted);
  }

  /** Minimal mode's peek: the shell goes above the page while the sidebar floats over it. */
  setPeek(contents: WebContents, open: boolean): void {
    const w = this.windowFor(contents);
    if (w && this.store.state.windows[w.id]?.sidebar === 'collapsed') w.setPeek(open);
    else w?.setPeek(false);
  }

  openChordMenu(contents: WebContents, chordId: string, at: { x: number; y: number }): void {
    const w = this.windowFor(contents);
    const chord = this.store.state.chords[chordId];
    // A private window's chord has nothing to change: no name, colors, sign-ins or delete.
    if (!w || !chord || chord.private) return;
    const onlyChord = sortedChords(this.store.state).length < 2;
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
          // Appearance, with the chord's colors open on the wheel.
          this.openSettings('appearance/colors');
        },
        separateSignIns: chord.profileId !== DEFAULT_PROFILE,
        toggleSeparateSignIns: () => this.toggleSeparateSignIns(w, chordId),
        delete: onlyChord ? null : () => this.deleteChord(w, chordId),
      }),
      { ...at, width: 0, height: 0 },
    );
  }

  /** "Chord 0.2.0 is ready": a downloaded update, whose toast restarts into it. */
  announceUpdateReady(id: string, message: string): void {
    const w = this.lastNormalWindow();
    if (!w) return;
    w.toast({ id, message, action: { label: 'Restart to update', update: 'restart' } });
  }

  /**
   * Safe Browsing flagged a page that isn't a tab's (Peek's, a mini window's,
   * or a popup): it closes, and the address opens as a tab, where the frame
   * shows the warning with its ways out. Peek and popups open beside the tab
   * they came from; a mini window's goes to the normal window used last.
   */
  private openFlaggedAsTab(contents: WebContents, nodeId: NodeId, url: string): void {
    const peeking = this.peeks.windowOf(nodeId);
    const peekWindow = peeking ? this.windows.get(peeking) : undefined;
    if (peekWindow) {
      this.peeks.close(peekWindow);
      this.store.dispatch({ t: 'tab.open', windowId: peekWindow.id, url });
      return;
    }
    const mini = this.minis.forContents(contents);
    if (mini) {
      mini.window.close();
      const w = this.normalWindowForLinks();
      if (w) {
        this.store.dispatch({ t: 'tab.open', windowId: w.id, url });
        w.window.focus();
      }
      return;
    }
    if (this.tabs.get(nodeId)?.webContents === contents) return;
    BrowserWindow.fromWebContents(contents)?.close();
    const windowId = this.windowShowing(nodeId);
    if (windowId) this.store.dispatch({ t: 'tab.open', windowId, url });
  }

  /** The warning's buttons, for a tab the sender's window shows. */
  safeBrowsingAction(sender: WebContents, nodeId: NodeId, action: 'back' | 'proceed'): void {
    const w = this.windowFor(sender);
    if (!w || !shownTabs(this.store.state, w.id).includes(nodeId)) return;
    if (action === 'back') this.safeBrowsing.back(nodeId);
    else this.safeBrowsing.proceed(nodeId);
  }

  /** A download Safe Browsing holds: the downloads panel opens where it started, so you can keep or delete it. */
  showHeldDownload(privateWindow: WindowId | undefined): void {
    const w = privateWindow ? this.windows.get(privateWindow) : this.lastNormalWindow();
    if (!w) return;
    this.peeks.close(w);
    w.openOverlay('downloads', '');
  }

  /** A note for the window used last, with a link that opens as a tab there (a new Chord version, for one). */
  announce(id: string, message: string, link: { label: string; url: string }): void {
    const w = this.lastNormalWindow();
    if (!w) return;
    w.toast({ id, message, action: { label: link.label, command: { t: 'tab.open', windowId: w.id, url: link.url } } });
  }

  /**
   * Delete at once and offer Undo in a toast: no confirmation box (native ones
   * also make Windows play a warning sound).
   */
  private deleteChord(w: AppWindow, chordId: string): void {
    const chord = this.store.state.chords[chordId];
    if (!chord || chord.private) return;
    this.store.dispatch({ t: 'chord.delete', chordId });
    w.toast({
      id: `chord-deleted:${chordId}`,
      message: `Deleted “${chord.name}”`,
      action: { label: 'Undo', command: { t: 'chord.restore', windowId: w.id, chordId } },
    });
  }

  private toggleSeparateSignIns(w: AppWindow, chordId: string): void {
    const chord = this.store.state.chords[chordId];
    if (chord) this.setSeparateSignIns(chordId, chord.profileId === DEFAULT_PROFILE, w);
  }

  /**
   * "Keep sign-ins separate": the chord gets a profile of its own (its tabs
   * reload in it, signed out), or shares the default one again. Undo goes
   * back to the sign-ins it had, which stay on disk until the next launch.
   */
  setSeparateSignIns(chordId: string, separate: boolean, w = this.lastNormalWindow()): void {
    const chord = this.store.state.chords[chordId];
    if (!chord || chord.private || (chord.profileId !== DEFAULT_PROFILE) === separate) return;
    const previous = chord.profileId;
    this.store.dispatch({ t: 'chord.profile', chordId, profileId: separate ? uuidv7() : DEFAULT_PROFILE });
    if (!w) return;
    w.toast({
      id: `chord-signins:${chordId}`,
      message: separate ? `“${chord.name}” keeps its own sign-ins now. Its tabs reloaded, signed out.` : `“${chord.name}” shares sign-ins with your other chords again.`,
      action: { label: 'Undo', command: { t: 'chord.profile', chordId, profileId: previous } },
    });
  }

  /** `source`: the contents the key or click came from (F6 starts there; Esc on the command bar goes back there). */
  private runAction(action: ActionId, w: AppWindow, source: WebContents | null = null): boolean {
    const active = activeTabId(this.store.state, w.id);
    const tab = activeTab(this.store.state, w.id);
    // While Peek is open, page actions (back, reload, find, zoom, print, copy) act on its page.
    const peek = this.peeks.contents(w);
    // What's in front: find and print act on a reader view; going back, reloading and developer tools, on its page.
    const activeContents = peek ?? w.activeTabContents;
    const pageContents = peek ?? this.pageIn(w);
    const reader = !peek && this.readers.pageOf(activeContents) !== undefined;
    const from = w.focusSource(source) === 'shell' ? 'shell' : 'page';
    switch (action) {
      case 'address.edit':
        this.peeks.close(w);
        w.openOverlay('edit', this.activeUrl(w.id), null, from);
        return true;
      case 'tab.new':
        this.peeks.close(w);
        w.openOverlay('new', '', null, from);
        return true;
      case 'view.focusNextRegion':
      case 'view.focusPreviousRegion': {
        // The command bar and Peek are modal: F6 stays out of them.
        const at = w.focusSource(source);
        if (at === 'overlay' || peek) return true;
        send(w.shell.webContents, 'focus:region', { direction: action === 'view.focusNextRegion' ? 1 : -1, from: at, popover: w.popoverShown, devtools: w.devtoolsShown });
        return true;
      }
      case 'tab.close':
        // ⌘W closes Peek first, as Esc does.
        if (peek) this.peeks.close(w);
        else if (active) this.store.dispatch({ t: 'tab.close', windowId: w.id, nodeId: active });
        return true;
      case 'tab.reopen':
        // This session's closed tabs keep their place; after that, the archive remembers what you closed.
        // A private window reopens only its own, and has no archive.
        if (reopenableIndex(this.store.state, w.id) >= 0) this.store.dispatch({ t: 'tab.reopenClosed', windowId: w.id });
        else if (!w.isPrivate) void this.options.archive.entry({ reasons: ['closed', 'cleared'] }).then((entry) => entry && this.restoreEntry(w.id, entry, true));
        return true;
      case 'app.history':
        if (!w.isPrivate) this.openArchive(w.id);
        return true;
      case 'window.new':
      case 'window.newPrivate':
        this.newWindow({ from: w.id, private: action === 'window.newPrivate' });
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
        pageContents?.reload();
        return true;
      case 'nav.hardReload':
        pageContents?.reloadIgnoringCache();
        return true;
      case 'nav.back':
        if (pageContents?.navigationHistory.canGoBack()) pageContents.navigationHistory.goBack();
        return true;
      case 'nav.forward':
        if (pageContents?.navigationHistory.canGoForward()) pageContents.navigationHistory.goForward();
        return true;
      case 'view.fullscreen':
        w.window.setFullScreen(!w.window.isFullScreen());
        return true;
      case 'view.toggleSidebar':
        this.setSidebar(w);
        return true;
      case 'view.presenting':
        // The switch (and its shortcut), for when another app shares Chord's window: Chord can't tell.
        this.store.dispatch({ t: 'presenting.set', on: this.store.state.presenting === null, by: 'you' });
        return true;
      case 'view.zoomIn':
      case 'view.zoomOut':
        // In reader view, the text size, as Safari does; otherwise remembered for the site, as in Chrome.
        if (reader) this.stepReaderSize(action === 'view.zoomIn' ? 1 : -1);
        else if (activeContents) this.siteZoom.step(activeContents, action === 'view.zoomIn' ? 1 : -1);
        return true;
      case 'view.zoomReset':
        if (reader) this.store.dispatch({ t: 'settings.set', settings: { reader: { size: DEFAULT_READER.size } } });
        else if (activeContents) this.siteZoom.reset(activeContents);
        return true;
      case 'view.reader':
        // For the tab on screen; Peek's page isn't a tab.
        if (!peek && active) void this.readers.toggle(active);
        return true;
      case 'page.screenshot':
        this.options.screenshots.start(w);
        return true;
      // Effects act on the tab in front; Peek's page isn't a tab.
      case 'effects.open':
        this.peeks.close(w);
        this.effects.open(w);
        return true;
      case 'effects.site':
        this.peeks.close(w);
        this.effects.toggleSite(w);
        return true;
      case 'effects.everywhere':
        this.effects.toggleEverywhere(w);
        return true;
      case 'effects.hide':
        this.peeks.close(w);
        this.effects.startPick(w);
        return true;
      case 'page.print':
        activeContents?.print();
        return true;
      case 'page.viewSource':
        if (tab && /^https?:/i.test(tab.url)) this.store.dispatch({ t: 'tab.open', windowId: w.id, url: `view-source:${tab.url}` });
        return true;
      case 'address.copy':
        if (peek) clipboard.writeText(peek.getURL());
        else if (tab) clipboard.writeText(tab.url);
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
      case 'tab.mute':
        if (tab) this.store.dispatch({ t: 'tab.mute', nodeId: tab.id, muted: !tab.muted });
        return true;
      case 'tab.favorite':
        if (tab && this.canFavorite(tab)) this.store.dispatch({ t: 'favorite.add', favoriteId: uuidv7(), nodeId: tab.id });
        return true;
      case 'folder.new': {
        const chordId = this.store.state.windows[w.id]?.activeChordId;
        if (chordId) this.createFolder(w, chordId, tab && !isInternalUrl(tab.url) ? tab.id : null);
        return true;
      }
      case 'today.clear':
        this.clearToday(w);
        return true;
      case 'split.with':
        // Pick what opens beside the current tab; with nothing shown there's nothing to split.
        if (active) w.openOverlay('split', '', null, from);
        return true;
      case 'split.focusNext':
      case 'split.focusPrevious':
        this.store.dispatch({ t: 'split.focus', windowId: w.id, direction: action === 'split.focusNext' ? 1 : -1 });
        return true;
      case 'split.separate': {
        const split = active ? splitOf(this.store.state, active) : null;
        if (split) this.separateSplit(w, split.id);
        return true;
      }
      case 'app.settings':
        this.openSettings();
        return true;
      case 'app.shortcuts':
        this.openSettings('shortcuts');
        return true;
      case 'app.devtools':
        // Peek's page: popped out, in a window of Electron's own (DESIGN.md §7.16). A tab's: docked, or in their window.
        if (peek) {
          if (peek.isDevToolsOpened()) peek.closeDevTools();
          else peek.openDevTools({ mode: 'detach' });
        } else if (active && this.devtoolsAllowed(active)) this.devtools.toggle(active);
        return true;
      case 'app.devtoolsSide':
        if (active && this.devtools.placeOf(active) === 'docked') {
          this.store.dispatch({ t: 'settings.set', settings: { devtools: { side: this.store.state.settings.devtools.side === 'right' ? 'bottom' : 'right' } } });
        }
        return true;
      case 'app.devtoolsWindow':
        if (active) this.devtools.toggleWindow(active, true);
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
      case 'duet.toggle':
        void this.duet?.act(w.id, { do: 'toggle' });
        return true;
      case 'chord.separateSignIns': {
        const chordId = this.store.state.windows[w.id]?.activeChordId;
        if (chordId) this.toggleSeparateSignIns(w, chordId);
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

  /** Show the archive page: the one already open in this chord, or a new tab. */
  private openArchive(windowId: WindowId): void {
    const chordId = this.store.state.windows[windowId]?.activeChordId;
    const open = chordId ? tabsInOrder(this.store.state, chordId).find((t) => t.url.startsWith(ARCHIVE_URL)) : undefined;
    if (open) this.store.dispatch({ t: 'tab.activate', windowId, nodeId: open.id });
    else this.store.dispatch({ t: 'tab.open', windowId, url: ARCHIVE_URL });
  }

  /**
   * Bring a tab back from the archive into the window `contents` belongs to.
   * The command bar opens it; the archive page leaves it waiting in the sidebar.
   */
  async restoreArchived(contents: WebContents, archiveId: string): Promise<void> {
    const w = this.windowFor(contents);
    if (!w || this.restoring.has(archiveId)) return;
    this.restoring.add(archiveId);
    try {
      const entry = await this.options.archive.entry({ archiveId });
      if (entry) this.restoreEntry(w.id, entry, contents === w.overlay.webContents);
    } finally {
      this.restoring.delete(archiveId);
    }
  }

  private restoreEntry(windowId: WindowId, entry: ArchiveEntry, activate: boolean): void {
    this.rememberHistory(entry.tab.id, entry.nav);
    this.store.dispatch({ t: 'archive.restore', windowId, nodeId: uuidv7(), tab: entry.tab, activate });
  }

  /** Forget an archived tab for good (the archive page's Remove). */
  removeArchived(archiveId: string): void {
    this.archivedHistory.delete(archiveId);
    this.options.history({ k: 'unarchive', id: archiveId });
    this.archiveChanged();
  }

  private rememberHistory(archiveId: string, nav: NavState | null): void {
    this.archivedHistory.set(archiveId, nav);
    while (this.archivedHistory.size > MAX_REMEMBERED_HISTORIES) this.archivedHistory.delete(this.archivedHistory.keys().next().value!);
  }

  /** Every archive page that's loaded. */
  private archivePages(): WebContents[] {
    return Object.values(this.store.state.nodes)
      .filter((n): n is TabNode => n.kind === 'tab' && isInternalUrl(n.url))
      .map((n) => this.tabs.get(n.id)?.webContents)
      .filter((c): c is WebContents => c !== undefined && !c.isDestroyed());
  }

  /** Archive pages list their entries again, once a burst of changes settles. */
  private archiveChanged(): void {
    clearTimeout(this.archiveChangedTimer);
    this.archiveChangedTimer = setTimeout(() => {
      for (const contents of this.archivePages()) send(contents, 'archive:changed', null);
    }, 100);
  }

  /** What an archive page shows besides its entries: its chord's colors and every chord's name. */
  archiveSnapshot(contents: WebContents): ArchiveSnapshot {
    const state = this.store.state;
    const nodeId = this.tabs.nodeFor(contents);
    const node = nodeId ? state.nodes[nodeId] : undefined;
    return {
      theme: node ? (state.chords[node.chordId]?.theme ?? null) : null,
      interface: state.settings.interface,
      chords: sortedChords(state).map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
    };
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
