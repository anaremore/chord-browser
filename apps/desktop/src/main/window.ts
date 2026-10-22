/**
 * One Chord window (ARCHITECTURE.md §5): a BaseWindow whose content view holds
 * the shell (Chord's UI, full window, transparent) and the active tab, inset
 * and rounded on top of it.
 *
 * M1.0 has a single tab; TabManager replaces `tab` in M1.1.
 */
import { join } from 'node:path';
import type { NavAction, TabState } from '@chord/ipc';
import { frameRadius, size } from '@chord/tokens';
import { BaseWindow, WebContentsView, app, nativeTheme, type Session } from 'electron';
import { registerCaller, send } from './ipc';
import { platform, systemInfo, titleBarOverlay, windowChromeOptions } from './platform';
import { lockToOrigins } from './security';
import { originOf } from './urls';

// Google is the default search engine (decided 2026-10-22). Tests override the
// first page so CI never depends on the network.
const HOME_URL = (!app.isPackaged && process.env['CHORD_HOME_URL']) || 'https://www.google.com/';

export interface AppWindowOptions {
  uiSession: Session;
  browsingSession: Session;
}

export class AppWindow {
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
  private readonly tab: WebContentsView;

  constructor({ uiSession, browsingSession }: AppWindowOptions) {
    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      title: 'Chord',
      show: false,
      ...windowChromeOptions(),
    });

    this.shell = new WebContentsView({
      webPreferences: {
        session: uiSession,
        preload: join(import.meta.dirname, '../preload/shell.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.shell.setBackgroundColor('#00000000');

    this.tab = new WebContentsView({
      webPreferences: { session: browsingSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.tab.setBorderRadius(frameRadius[platform]);

    // Shell first, tab above it (later children draw on top).
    this.window.contentView.addChildView(this.shell);
    this.window.contentView.addChildView(this.tab);

    const shellUrl = process.env['ELECTRON_RENDERER_URL']
      ? `${process.env['ELECTRON_RENDERER_URL']}/shell/index.html`
      : 'chord://shell/';
    const shellOrigin = originOf(shellUrl);
    if (!shellOrigin) throw new Error(`Bad shell URL ${shellUrl}`);
    registerCaller(this.shell.webContents, 'shell', [shellOrigin]);
    lockToOrigins(this.shell.webContents, [shellOrigin]);

    this.wireTab();
    this.layout();
    this.window.on('resize', () => this.layout());

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay());
      send(this.shell.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      nativeTheme.off('updated', onTheme);
      for (const view of [this.shell, this.tab]) if (!view.webContents.isDestroyed()) view.webContents.close();
    });

    this.shell.webContents.once('did-finish-load', () => {
      this.pushTabState();
      this.window.show();
    });
    void this.shell.webContents.loadURL(shellUrl);
    void this.tab.webContents.loadURL(HOME_URL);
  }

  navigate(action: NavAction): void {
    const contents = this.tab.webContents;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
  }

  /** The content frame: inset from the window, right of the sidebar, below the strip on Windows/Linux. */
  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    const inset = size.frameInset;
    const top = platform === 'darwin' ? inset : size.strip;
    this.shell.setBounds({ x: 0, y: 0, width, height });
    this.tab.setBounds({
      x: size.sidebarWidth,
      y: top,
      width: Math.max(0, width - size.sidebarWidth - inset),
      height: Math.max(0, height - top - inset),
    });
  }

  private faviconUrl: string | null = null;

  private wireTab(): void {
    const contents = this.tab.webContents;
    const push = () => this.pushTabState();
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      contents.on(event as 'did-start-loading', push);
    }
    contents.on('page-favicon-updated', (_event, favicons) => {
      this.faviconUrl = favicons[0] ?? null;
      push();
    });
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.faviconUrl = null;
    });
    // M1.0 has one tab, so new windows load in place. M1.1 opens real tabs and OAuth popups.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https:') || url.startsWith('http:')) void contents.loadURL(url);
      return { action: 'deny' };
    });
  }

  tabState(): TabState {
    const contents = this.tab.webContents;
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      faviconUrl: this.faviconUrl,
    };
  }

  private pushTabState(): void {
    if (this.tab.webContents.isDestroyed()) return;
    send(this.shell.webContents, 'tab:state', this.tabState());
  }
}
