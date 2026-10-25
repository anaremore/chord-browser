/**
 * TabManager (ARCHITECTURE.md §9): one WebContentsView per live tab, created
 * lazily, wired to report navigation back into the Store. A tab can also
 * sleep: its page closes, and its back/forward history (scroll position
 * included) comes back when it's shown again.
 */
import { countShows, isCrossSite, isInternalUrl, pageBadge, placeKey, usableDataIcon, type Command, type LiveTab, type NodeId, type State, type TabCount, type TabNode, type WindowId } from '@chord/core';
import type { NavState } from '@chord/data';
import { frameRadius } from '@chord/tokens';
import { WebContentsView, type BrowserWindow, type HandlerDetails, type Session, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import { windowIcon } from './app-icon';
import { trimNavState } from './nav';
import { platform } from './platform';
import { pageCall } from './page-call';

const MAX_FAVICON_BYTES = 64 * 1024;
/** Sites whose icon each session keeps (TabManager.siteIcons). */
const SITE_ICONS = 256;

/** A web page's site, for its icon: its origin. Null for anything else (Chord's pages, about:, files). */
export function siteOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const MAX_CRASH_RELOADS = 2;
/** A navigation this soon after a click (or Enter) in the page counts as you following a link, not the page redirecting itself. */
const LINK_GESTURE_MS = 1500;

export interface TabManagerDeps {
  state(): State;
  dispatch(command: Command): void;
  sessionFor(node: TabNode): Session;
  /** A view for one of Chord's own pages (`chord://archive`), on Chord's UI session with its own preload. */
  createInternalView(url: string): WebContentsView;
  /** The window a tab belongs to, for opening links from it. */
  windowFor(nodeId: NodeId): WindowId | undefined;
  /** Hook for keyboard shortcuts and other per-contents wiring. */
  onContentsCreated(contents: WebContents, nodeId: NodeId): void;
  /** A page was visited (or its title arrived): history keeps it. */
  onVisit(url: string, title: string, nodeId: NodeId): void;
  onTitle(url: string, title: string, nodeId: NodeId): void;
  /** A page opened a popup window (sign-in, payment): wire its context menu. */
  onPopupCreated(contents: WebContents, openerNodeId: NodeId): void;
  /** A link in a pinned tab leads to another site: it opens in Peek (DESIGN.md §8.5), from `origin` (in the page) if known. */
  onPeek(openerNodeId: NodeId, url: string, origin: { x: number; y: number } | null): void;
}

/** A page that isn't a tab yet: a Peek's or a mini window's (DESIGN.md §7.9). */
interface FloatingPage {
  view: WebContentsView;
  /** A private window's Peek: its visits never reach history. */
  private: boolean;
}

export class TabManager {
  private readonly views = new Map<NodeId, WebContentsView>();
  private readonly crashReloads = new Map<NodeId, number>();
  /** Tabs playing audio or video right now (muted video counts). */
  private readonly playing = new Set<NodeId>();
  /** History to load instead of the tab's address the next time its view is made: it slept, or came back from the archive. */
  private readonly pendingHistory = new Map<NodeId, NavState>();
  /** Tabs showing one of Chord's own pages, on Chord's UI session. */
  private readonly internal = new Set<NodeId>();
  /** Pages that aren't tabs yet, by the id they'll have as one. */
  private readonly floating = new Map<NodeId, FloatingPage>();
  /** The count each tab's page gave itself (the Badging API), shown or not: Settings can hide it, then show it again. */
  private readonly badges = new Map<NodeId, Exclude<TabCount, null>>();
  /** The count each service worker gave its site, by its scope, per session: its tabs show it when their page has none. */
  private readonly scopeBadges = new WeakMap<Session, Map<string, Exclude<TabCount, null>>>();
  /**
   * Each site's icon, by origin, per session (a private window's go with it):
   * a tab arriving on a site Chord has an icon for shows it at once, and a
   * page that never names its icon, or whose icon can't be fetched, keeps it.
   */
  private readonly siteIcons = new WeakMap<Session, Map<string, string>>();

  constructor(private readonly deps: TabManagerDeps) {}

  /** Keep a site's icon, the newest first out of `SITE_ICONS` (a few KB each). */
  private rememberIcon(session: Session, url: string, icon: string): void {
    const site = siteOf(url);
    if (!site) return;
    let icons = this.siteIcons.get(session);
    if (!icons) this.siteIcons.set(session, (icons = new Map()));
    icons.delete(site);
    icons.set(site, icon);
    if (icons.size > SITE_ICONS) icons.delete(icons.keys().next().value!);
  }

  /** A site's icon if Chord has one: kept from earlier, or on another of this session's tabs there. */
  private knownIcon(session: Session, site: string): string | null {
    const kept = this.siteIcons.get(session)?.get(site);
    if (kept) return kept;
    for (const node of Object.values(this.deps.state().nodes)) {
      if (node.kind !== 'tab' || !node.favicon || (node.url !== site && !node.url.startsWith(`${site}/`))) continue;
      if (this.deps.sessionFor(node) !== session) continue;
      this.rememberIcon(session, node.url, node.favicon);
      return node.favicon;
    }
    return null;
  }

  get(nodeId: NodeId): WebContentsView | undefined {
    return this.views.get(nodeId);
  }

  /** Every tab that has a page, and its contents. */
  *entries(): IterableIterator<[NodeId, WebContents]> {
    for (const [id, view] of this.views) if (!view.webContents.isDestroyed()) yield [id, view.webContents];
  }

  nodeFor(contents: WebContents): NodeId | undefined {
    for (const [id, view] of this.views) if (view.webContents === contents) return id;
    return undefined;
  }

  /** The id of a page that isn't a tab (yet): Peek's, or a mini window's. */
  floatingNodeFor(contents: WebContents): NodeId | undefined {
    for (const [id, page] of this.floating) if (page.view.webContents === contents) return id;
    return undefined;
  }

  /** Tabs with a page loaded. */
  loaded(): NodeId[] {
    return [...this.views.keys()];
  }

  isPlaying(nodeId: NodeId): boolean {
    return this.playing.has(nodeId);
  }

  /** Whether the tab's page shows a video in picture-in-picture. */
  async inPictureInPicture(nodeId: NodeId): Promise<boolean> {
    const contents = this.views.get(nodeId)?.webContents;
    if (!contents || contents.isDestroyed() || this.internal.has(nodeId)) return false;
    // An isolated world shares the page's DOM but not its scripts, so a page can't fake this. A hung page
    // answers no (it can go to sleep), rather than holding up every tab after it.
    return Boolean(await pageCall(contents.executeJavaScriptInIsolatedWorld(999, [{ code: 'Boolean(document.pictureInPictureElement)' }]), false));
  }

  /** The tab's back/forward history as it is now (or as it fell asleep), ready to restore later. */
  history(nodeId: NodeId): NavState | null {
    const contents = this.views.get(nodeId)?.webContents;
    if (!contents || contents.isDestroyed()) return this.pendingHistory.get(nodeId) ?? null;
    if (this.internal.has(nodeId)) return null;
    return trimNavState(contents.navigationHistory.getAllEntries(), contents.navigationHistory.getActiveIndex());
  }

  /** Load this history, rather than the tab's address, the next time the tab's view is made. */
  restoreHistoryOnLoad(nodeId: NodeId, nav: NavState | null): void {
    if (nav) this.pendingHistory.set(nodeId, nav);
  }

  ensure(nodeId: NodeId): WebContentsView | undefined {
    const existing = this.views.get(nodeId);
    if (existing) return existing;
    const node = this.deps.state().nodes[nodeId];
    if (node?.kind !== 'tab') return undefined;

    const internal = isInternalUrl(node.url);
    const view = internal
      ? this.deps.createInternalView(node.url)
      : new WebContentsView({
          webPreferences: {
            session: this.deps.sessionFor(node),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
          },
        });
    view.setBorderRadius(frameRadius[platform]);
    this.views.set(nodeId, view);
    if (internal) this.internal.add(nodeId);
    this.wire(nodeId, view.webContents, internal);
    this.deps.onContentsCreated(view.webContents, nodeId);
    if (internal) return view;

    const nav = this.pendingHistory.get(nodeId);
    this.pendingHistory.delete(nodeId);
    const contents = view.webContents;
    // Muted stays muted: after sleeping, a restart, or a move to other sign-ins (a new page each time).
    if (node.muted) contents.setAudioMuted(true);
    if (nav) {
      // Back where it was: same page, same back/forward list, same scroll position.
      contents.navigationHistory.restore({ entries: nav.entries, index: nav.index }).catch(() => {
        if (!contents.isDestroyed() && contents.navigationHistory.length() === 0) void contents.loadURL(node.url).catch(() => {});
      });
    } else {
      void contents.loadURL(node.url).catch(() => {
        // Load failures surface through did-fail-load; nothing to do here.
      });
    }
    return view;
  }

  /**
   * A page that isn't a tab yet (Peek, a mini window): a tab's view and
   * wiring, under the id it will have as a tab, so `adopt` can make it one
   * without reloading. Its reports to the store wait until then; its visits
   * still count as history unless it's private.
   */
  createFloating(nodeId: NodeId, { session, url, private: isPrivate }: { session: Session; url: string; private: boolean }): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    this.floating.set(nodeId, { view, private: isPrivate });
    this.wire(nodeId, view.webContents, false);
    this.deps.onContentsCreated(view.webContents, nodeId);
    void view.webContents.loadURL(url).catch(() => {
      // Load failures show in the page itself, as they would in a tab.
    });
    return view;
  }

  /** The floating page with this contents, if it is one. */
  floatingFor(contents: WebContents): NodeId | undefined {
    for (const [id, page] of this.floating) if (page.view.webContents === contents) return id;
    return undefined;
  }

  getFloating(nodeId: NodeId): WebContentsView | undefined {
    return this.floating.get(nodeId)?.view;
  }

  /** The floating page becomes the tab `nodeId` (tab.adopt makes the node), keeping its page and history. */
  adopt(nodeId: NodeId): WebContentsView | undefined {
    const page = this.floating.get(nodeId);
    if (!page || page.view.webContents.isDestroyed()) return undefined;
    this.floating.delete(nodeId);
    this.views.set(nodeId, page.view);
    page.view.setBorderRadius(frameRadius[platform]);
    return page.view;
  }

  /** A floating page that won't become a tab: its page closes. */
  closeFloating(nodeId: NodeId): void {
    const page = this.floating.get(nodeId);
    this.floating.delete(nodeId);
    if (page && !page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  navigate(nodeId: NodeId, url: string): void {
    const view = this.views.get(nodeId);
    if (!view) return;
    // Chord's pages and web pages live in different sessions: crossing over needs a new view.
    if (isInternalUrl(url) !== this.internal.has(nodeId)) {
      this.destroy(nodeId);
      this.ensure(nodeId);
      return;
    }
    if (!isInternalUrl(url)) void view.webContents.loadURL(url).catch(() => {});
  }

  /** Silence the tab's page, or let it be heard. A tab without a page is silenced when it gets one (ensure). */
  setMuted(nodeId: NodeId, muted: boolean): void {
    const contents = this.views.get(nodeId)?.webContents;
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(muted);
  }

  /** A tab's count as it shows: its page's, else its site's service worker's; hidden when counts are off, or off for its site. */
  private shownBadge(nodeId: NodeId, url: string): TabCount {
    const badge = this.badges.get(nodeId) ?? this.scopeBadge(nodeId, url);
    return badge !== null && countShows(url, this.deps.state().settings.tabCounts) ? badge : null;
  }

  /** The count a service worker gave the tab's site: the one whose scope is the longest start of its address, in its session. */
  private scopeBadge(nodeId: NodeId, url: string): TabCount {
    const node = this.deps.state().nodes[nodeId];
    const scopes = node?.kind === 'tab' ? this.scopeBadges.get(this.deps.sessionFor(node)) : undefined;
    let best: { scope: string; badge: Exclude<TabCount, null> } | null = null;
    for (const [scope, badge] of scopes ?? []) if (url.startsWith(scope) && (!best || scope.length > best.scope.length)) best = { scope, badge };
    return best?.badge ?? null;
  }

  /** A service worker set or cleared its site's count: its tabs under `scope`, in its session, show it now. */
  setScopeBadge(ses: Session, scope: string, raw: unknown): void {
    const badge = pageBadge(raw);
    if (badge === undefined || !/^https?:\/\//.test(scope)) return;
    let scopes = this.scopeBadges.get(ses);
    if (!scopes) this.scopeBadges.set(ses, (scopes = new Map()));
    if (badge === null) scopes.delete(scope);
    else scopes.set(scope, badge);
    this.refreshCounts();
  }

  /** Whether the tab has a count of its own or its site's (its menu offers to hide or show it). */
  hasBadge(nodeId: NodeId): boolean {
    const contents = this.views.get(nodeId)?.webContents;
    return this.badges.has(nodeId) || (contents && !contents.isDestroyed() ? this.scopeBadge(nodeId, contents.getURL()) !== null : false);
  }

  /** Counts were turned on or off, hidden for a site, or a service worker's changed: every awake tab shows its own as it is now. */
  refreshCounts(): void {
    const state = this.deps.state();
    for (const [nodeId, view] of this.views) {
      const contents = view.webContents;
      if (contents.isDestroyed() || !state.live[nodeId]) continue;
      const badge = this.shownBadge(nodeId, contents.getURL());
      if (state.live[nodeId]!.badge !== badge) this.deps.dispatch({ t: 'tab.live', nodeId, live: { badge } });
    }
  }

  /** Close the tab's page, keeping its history to load when it's shown again. */
  sleep(nodeId: NodeId): void {
    const nav = this.history(nodeId);
    this.destroy(nodeId);
    this.restoreHistoryOnLoad(nodeId, nav);
  }

  destroy(nodeId: NodeId): void {
    const view = this.views.get(nodeId);
    this.views.delete(nodeId);
    this.crashReloads.delete(nodeId);
    this.playing.delete(nodeId);
    this.badges.delete(nodeId);
    this.pendingHistory.delete(nodeId);
    this.internal.delete(nodeId);
    // removeChildView alone keeps the renderer alive; close() frees it (ARCHITECTURE.md §5).
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
    for (const id of [...this.floating.keys()]) this.closeFloating(id);
  }

  private wire(nodeId: NodeId, contents: WebContents, internal: boolean): void {
    // A page being closed (a pinned tab unloading) still fires a few events on its way out.
    // Only the tab's current page may report, or a late event would mark it loaded again.
    const current = () => !contents.isDestroyed() && this.views.get(nodeId)?.webContents === contents;
    const dispatch = (command: Command) => {
      if (current()) this.deps.dispatch(command);
    };
    // A page being torn down still fires did-stop-loading; its history is gone by then.
    const history = () =>
      contents.isDestroyed() ? {} : { canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
    const live = (patch: Partial<LiveTab>) => dispatch({ t: 'tab.live', nodeId, live: patch });
    // A floating page (Peek, a mini window) isn't in the store yet, but its visits are history (unless private).
    const reportsHistory = () => {
      if (current()) return true;
      const page = this.floating.get(nodeId);
      return Boolean(page && !page.private && page.view.webContents === contents && !contents.isDestroyed());
    };

    contents.on('did-start-loading', () => live({ loading: true, crashed: false }));
    contents.on('did-stop-loading', () => live({ loading: false, ...history() }));
    if (internal) {
      // Chord's own page keeps its chord:// address (in development it's served from elsewhere),
      // isn't history, and has no site icon.
      contents.on('page-title-updated', (_event, title) => dispatch({ t: 'tab.updated', nodeId, title }));
      return;
    }

    // History: one visit per page a tab shows. In-page navigations count when they reach a
    // different place (pushState routing), not when only the fragment changes.
    let visited: string | null = null;
    const visit = (url: string) => {
      const place = placeKey(url);
      if (!place || place === visited || !reportsHistory()) return;
      visited = place;
      // The title arrives with page-title-updated; at this point it may still be the last page's.
      this.deps.onVisit(url, '', nodeId);
    };
    contents.on('did-navigate', (_event, url, code) => {
      // A new page: the last one's count goes with it.
      const had = this.badges.delete(nodeId);
      const shown = this.shownBadge(nodeId, url);
      if (had || shown !== null) live({ badge: shown });
      // Its icon stays while the site does (a page may never name one, or fail to load it). On another
      // site, the icon Chord has for that one, or none until the page's own arrives: never the last site's.
      const before = this.deps.state().nodes[nodeId];
      const site = siteOf(url);
      if (before?.kind === 'tab' && siteOf(before.url) !== site) {
        dispatch({ t: 'tab.updated', nodeId, url, favicon: site ? this.knownIcon(contents.session, site) : null });
      } else {
        dispatch({ t: 'tab.updated', nodeId, url });
      }
      live(history());
      visited = null;
      if (code > 0) visit(url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      dispatch({ t: 'tab.updated', nodeId, url });
      live(history());
      visit(url);
    });
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // The icon waits for the page to commit (did-navigate): a navigation can still be cancelled, or download.
      live({ error: null });
    });
    // The frame explains failures instead of showing a blank page. -3 is ERR_ABORTED: the
    // user (or the page) stopped it, which isn't an error.
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) live({ loading: false, error: { code, url }, ...history() });
    });
    contents.on('page-title-updated', (_event, title) => {
      dispatch({ t: 'tab.updated', nodeId, title });
      if (reportsHistory()) this.deps.onTitle(contents.getURL(), title, nodeId);
    });
    contents.on('page-favicon-updated', (_event, favicons) => void this.loadFavicon(nodeId, contents, favicons));
    contents.on('audio-state-changed', (event) => live({ audible: event.audible }));
    // The count the page gives itself (counts on tabs, ARCHITECTURE.md §9), from Chord's page preload: its top frame's only.
    contents.ipc.on('page:badge', (event, raw: unknown) => {
      const badge = pageBadge(raw);
      if (badge === undefined || event.senderFrame?.parent || !current()) return;
      if (badge === null) this.badges.delete(nodeId);
      else this.badges.set(nodeId, badge);
      live({ badge: this.shownBadge(nodeId, contents.getURL()) });
    });
    // Playing tabs are never slept or archived, even muted (ARCHITECTURE.md §9).
    contents.on('media-started-playing', () => {
      if (current()) this.playing.add(nodeId);
    });
    contents.on('media-paused', () => {
      if (current()) this.playing.delete(nodeId);
    });

    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || !current()) return;
      // Reload automatically at most twice, then show "This page stopped" (borrowed from Crest).
      const attempts = this.crashReloads.get(nodeId) ?? 0;
      if (attempts < MAX_CRASH_RELOADS) {
        this.crashReloads.set(nodeId, attempts + 1);
        contents.reload();
      } else {
        live({ crashed: true, loading: false });
      }
      if (this.badges.delete(nodeId)) live({ badge: null });
    });

    contents.setWindowOpenHandler((details) => this.openFrom(nodeId, details));
    contents.on('did-create-window', (popup) => this.wirePopup(popup, nodeId));

    // Peek (DESIGN.md §8.5): following a link in a pinned tab to another site opens it in Peek, so
    // the pinned page stays put. Only links you follow: a page redirecting itself (sign-in flows)
    // navigates as usual, so a navigation counts only just after a click or Enter in the page.
    let gestureAt = 0;
    let gesturePoint: { x: number; y: number } | null = null;
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'mouseUp') {
        gestureAt = Date.now();
        const mouse = input as Electron.MouseInputEvent;
        gesturePoint = { x: mouse.x, y: mouse.y };
      } else if (input.type === 'keyDown' && (input as Electron.KeyboardInputEvent).keyCode === 'Enter') {
        gestureAt = Date.now();
        gesturePoint = null;
      }
    });
    contents.on('will-navigate', (event) => {
      if (!event.isMainFrame || event.isSameDocument || !this.leadsToPeek(nodeId, contents, event.url)) return;
      if (Date.now() - gestureAt > LINK_GESTURE_MS) return;
      event.preventDefault();
      this.deps.onPeek(nodeId, event.url, gesturePoint);
    });
  }

  /** Whether following `url` from this tab's page opens Peek: it's pinned, and the link leaves its site. */
  private leadsToPeek(nodeId: NodeId, contents: WebContents, url: string): boolean {
    const node = this.deps.state().nodes[nodeId];
    return node?.kind === 'tab' && node.section === 'pinned' && this.views.get(nodeId)?.webContents === contents && isCrossSite(contents.getURL(), url);
  }

  /**
   * window.open from a tab, or from a popup it opened. Real popups (window
   * features given: OAuth, payments) stay windows at the size they asked for,
   * keeping window.opener so they can report back. Everything else becomes a
   * tab in the opener's Chord window.
   */
  private openFrom(openerNodeId: NodeId, { url, disposition, features }: HandlerDetails): WindowOpenHandlerResponse {
    if (disposition === 'new-window' && features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...windowIcon(),
          // The size a page asks for is its own area, as in Chrome, not the window's frame.
          useContentSize: true,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
        },
      };
    }
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    // Peek and mini windows keep to themselves: a link that wants a new tab opens right there.
    const floating = this.floating.get(openerNodeId);
    if (floating) {
      if (!floating.view.webContents.isDestroyed()) void floating.view.webContents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    // A pinned tab's link to another site opens in Peek, unless it was asked for in the background (⌘/Ctrl-click).
    const opener = this.views.get(openerNodeId)?.webContents;
    if (disposition !== 'background-tab' && opener && this.leadsToPeek(openerNodeId, opener, url)) {
      this.deps.onPeek(openerNodeId, url, null);
      return { action: 'deny' };
    }
    const windowId = this.deps.windowFor(openerNodeId);
    if (windowId) this.deps.dispatch({ t: 'tab.open', windowId, url, background: disposition === 'background-tab' });
    return { action: 'deny' };
  }

  private wirePopup(popup: BrowserWindow, openerNodeId: NodeId): void {
    // Not the app menu: Alt would otherwise reveal it on Windows and Linux.
    popup.removeMenu();
    const contents = popup.webContents;
    // Popups follow the same rules as their opener, so a sign-in window can't spawn unchecked windows.
    contents.setWindowOpenHandler((details) => this.openFrom(openerNodeId, details));
    contents.on('did-create-window', (child) => this.wirePopup(child, openerNodeId));
    this.deps.onPopupCreated(contents, openerNodeId);
  }

  /**
   * Fetch through the tab's own session (its cookies apply), keep small icons
   * as data: URLs, and remember each for its site. An icon that can't be had
   * changes nothing: the tab keeps the one it has (its site's, or the monogram).
   */
  private async loadFavicon(nodeId: NodeId, contents: WebContents, favicons: string[]): Promise<void> {
    const url = favicons.find((u) => /^(https?|data):/i.test(u));
    if (!url) return;
    // The page this icon is for: by the time it's fetched, the tab may be on another site.
    const page = contents.getURL();
    const session = contents.session;
    let icon: string | null = null;
    try {
      if (url.startsWith('data:')) {
        if (usableDataIcon(url, MAX_FAVICON_BYTES)) icon = url;
      } else {
        const response = await contents.session.fetch(url, { signal: AbortSignal.timeout(8000) });
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        const bytes = response.ok && /^image\//.test(type) ? Buffer.from(await response.arrayBuffer()) : null;
        if (bytes && bytes.length > 0 && bytes.length <= MAX_FAVICON_BYTES) icon = `data:${type};base64,${bytes.toString('base64')}`;
      }
    } catch {
      // Unreachable: the tab keeps the icon it has.
    }
    if (!icon) return;
    this.rememberIcon(session, page, icon);
    if (contents.isDestroyed() || siteOf(contents.getURL()) !== siteOf(page)) return;
    this.deps.dispatch({ t: 'tab.updated', nodeId, favicon: icon });
  }
}
