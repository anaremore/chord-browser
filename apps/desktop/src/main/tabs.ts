/**
 * TabManager (ARCHITECTURE.md §9): one WebContentsView per live tab, created
 * lazily, wired to report navigation back into the Store.
 */
import { placeKey, usableDataIcon, type Command, type LiveTab, type NodeId, type State, type TabNode, type WindowId } from '@chord/core';
import { frameRadius } from '@chord/tokens';
import { WebContentsView, type BrowserWindow, type HandlerDetails, type Session, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import { windowIcon } from './app-icon';
import { platform } from './platform';

const MAX_FAVICON_BYTES = 64 * 1024;
const MAX_CRASH_RELOADS = 2;

export interface TabManagerDeps {
  state(): State;
  dispatch(command: Command): void;
  sessionFor(node: TabNode): Session;
  /** The window a tab belongs to, for opening links from it. */
  windowFor(nodeId: NodeId): WindowId | undefined;
  /** Hook for keyboard shortcuts and other per-contents wiring. */
  onContentsCreated(contents: WebContents, nodeId: NodeId): void;
  /** A page was visited (or its title arrived): history keeps it. */
  onVisit(url: string, title: string): void;
  onTitle(url: string, title: string): void;
  /** A page opened a popup window (sign-in, payment): wire its context menu. */
  onPopupCreated(contents: WebContents, openerNodeId: NodeId): void;
}

export class TabManager {
  private readonly views = new Map<NodeId, WebContentsView>();
  private readonly crashReloads = new Map<NodeId, number>();

  constructor(private readonly deps: TabManagerDeps) {}

  get(nodeId: NodeId): WebContentsView | undefined {
    return this.views.get(nodeId);
  }

  nodeFor(contents: WebContents): NodeId | undefined {
    for (const [id, view] of this.views) if (view.webContents === contents) return id;
    return undefined;
  }

  ensure(nodeId: NodeId): WebContentsView | undefined {
    const existing = this.views.get(nodeId);
    if (existing) return existing;
    const node = this.deps.state().nodes[nodeId];
    if (node?.kind !== 'tab') return undefined;

    const view = new WebContentsView({
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
    this.wire(nodeId, view.webContents);
    this.deps.onContentsCreated(view.webContents, nodeId);
    void view.webContents.loadURL(node.url).catch(() => {
      // Load failures surface through did-fail-load; nothing to do here.
    });
    return view;
  }

  navigate(nodeId: NodeId, url: string): void {
    void this.views.get(nodeId)?.webContents.loadURL(url).catch(() => {});
  }

  destroy(nodeId: NodeId): void {
    const view = this.views.get(nodeId);
    this.views.delete(nodeId);
    this.crashReloads.delete(nodeId);
    // removeChildView alone keeps the renderer alive; close() frees it (ARCHITECTURE.md §5).
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }

  private wire(nodeId: NodeId, contents: WebContents): void {
    // A page being closed (a pinned tab unloading) still fires a few events on its way out.
    // Only the tab's current page may report, or a late event would mark it loaded again.
    const current = () => !contents.isDestroyed() && this.views.get(nodeId)?.webContents === contents;
    const dispatch = (command: Command) => {
      if (current()) this.deps.dispatch(command);
    };
    const history = () => ({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
    const live = (patch: Partial<LiveTab>) => dispatch({ t: 'tab.live', nodeId, live: patch });

    contents.on('did-start-loading', () => live({ loading: true, crashed: false }));
    contents.on('did-stop-loading', () => live({ loading: false, ...history() }));
    // History: one visit per page a tab shows. In-page navigations count when they reach a
    // different place (pushState routing), not when only the fragment changes.
    let visited: string | null = null;
    const visit = (url: string) => {
      const place = placeKey(url);
      if (!place || place === visited || !current()) return;
      visited = place;
      // The title arrives with page-title-updated; at this point it may still be the last page's.
      this.deps.onVisit(url, '');
    };
    contents.on('did-navigate', (_event, url, code) => {
      dispatch({ t: 'tab.updated', nodeId, url });
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
      dispatch({ t: 'tab.updated', nodeId, favicon: null });
      live({ error: null });
    });
    // The frame explains failures instead of showing a blank page. -3 is ERR_ABORTED: the
    // user (or the page) stopped it, which isn't an error.
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) live({ loading: false, error: { code, url }, ...history() });
    });
    contents.on('page-title-updated', (_event, title) => {
      dispatch({ t: 'tab.updated', nodeId, title });
      if (current()) this.deps.onTitle(contents.getURL(), title);
    });
    contents.on('page-favicon-updated', (_event, favicons) => void this.loadFavicon(nodeId, contents, favicons));
    contents.on('audio-state-changed', (event) => live({ audible: event.audible }));

    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      // Reload automatically at most twice, then show "This page stopped" (borrowed from Crest).
      const attempts = this.crashReloads.get(nodeId) ?? 0;
      if (attempts < MAX_CRASH_RELOADS) {
        this.crashReloads.set(nodeId, attempts + 1);
        contents.reload();
      } else {
        live({ crashed: true, loading: false });
      }
    });

    contents.setWindowOpenHandler((details) => this.openFrom(nodeId, details));
    contents.on('did-create-window', (popup) => this.wirePopup(popup, nodeId));
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
    const windowId = this.deps.windowFor(openerNodeId);
    if (windowId && /^https?:/i.test(url)) {
      this.deps.dispatch({ t: 'tab.open', windowId, url, background: disposition === 'background-tab' });
    }
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

  /** Fetch through the tab's own session (its cookies apply), keep small icons as data: URLs. */
  private async loadFavicon(nodeId: NodeId, contents: WebContents, favicons: string[]): Promise<void> {
    const url = favicons.find((u) => /^(https?|data):/i.test(u));
    if (!url) return;
    try {
      if (url.startsWith('data:')) {
        if (usableDataIcon(url, MAX_FAVICON_BYTES)) this.deps.dispatch({ t: 'tab.updated', nodeId, favicon: url });
        return;
      }
      const response = await contents.session.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!/^image\//.test(type)) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return;
      if (contents.isDestroyed()) return;
      this.deps.dispatch({ t: 'tab.updated', nodeId, favicon: `data:${type};base64,${bytes.toString('base64')}` });
    } catch {
      // Unreachable icons fall back to the monogram.
    }
  }
}
