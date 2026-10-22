/**
 * One Chord window (ARCHITECTURE.md §5). Views, bottom to top:
 *   shell    Chord's UI, full window, transparent
 *   tab      the active tab, inset and rounded (index 1)
 *   overlay  the command bar: always loaded, hidden until ⌘T / ⌘L
 */
import { join } from 'node:path';
import type { Bounds, WindowId } from '@chord/core';
import type { OverlayOpenEvent, Rect, Role } from '@chord/ipc';
import { size } from '@chord/tokens';
import { BaseWindow, WebContentsView, nativeTheme, type Session } from 'electron';
import { registerCaller, send } from './ipc';
import { platform, systemInfo, titleBarOverlay, windowChromeOptions } from './platform';
import { lockToOrigins } from './security';
import { originOf } from './urls';

export interface AppWindowOptions {
  id: WindowId;
  uiSession: Session;
  bounds: Bounds | null;
  onBounds(bounds: Bounds): void;
}

function uiUrl(surface: 'shell' | 'overlay'): string {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return dev ? `${dev}/${surface}/index.html` : `chord://${surface}/`;
}

function createUiView(uiSession: Session, surface: 'shell' | 'overlay', role: Role): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      session: uiSession,
      preload: join(import.meta.dirname, `../preload/${surface}.cjs`),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#00000000');
  const url = uiUrl(surface);
  const origin = originOf(url);
  if (!origin) throw new Error(`Bad UI URL ${url}`);
  registerCaller(view.webContents, role, [origin]);
  lockToOrigins(view.webContents, [origin]);
  void view.webContents.loadURL(url);
  return view;
}

export class AppWindow {
  readonly id: WindowId;
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
  readonly overlay: WebContentsView;
  private tabView: WebContentsView | null = null;
  private anchor: Rect | null = null;
  private overlayVisible = false;

  constructor({ id, uiSession, bounds, onBounds }: AppWindowOptions) {
    this.id = id;
    this.window = new BaseWindow({
      ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { width: 1280, height: 820 }),
      minWidth: 720,
      minHeight: 480,
      title: 'Chord',
      show: false,
      ...windowChromeOptions(),
    });
    if (bounds?.maximized) this.window.maximize();

    this.shell = createUiView(uiSession, 'shell', 'shell');
    this.overlay = createUiView(uiSession, 'overlay', 'overlay');
    this.overlay.setVisible(false);
    this.window.contentView.addChildView(this.shell);
    this.window.contentView.addChildView(this.overlay);

    this.layout();
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;
    const reportBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (this.window.isDestroyed() || this.window.isMinimized() || this.window.isFullScreen()) return;
        const maximized = this.window.isMaximized();
        const b = maximized ? this.window.getNormalBounds() : this.window.getBounds();
        onBounds({ x: b.x, y: b.y, width: b.width, height: b.height, maximized });
      }, 400);
    };
    this.window.on('resize', () => {
      this.layout();
      reportBounds();
    });
    this.window.on('move', reportBounds);
    this.window.on('maximize', reportBounds);
    this.window.on('unmaximize', reportBounds);

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay());
      for (const view of [this.shell, this.overlay]) send(view.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      nativeTheme.off('updated', onTheme);
      clearTimeout(boundsTimer);
      for (const view of [this.shell, this.overlay]) if (!view.webContents.isDestroyed()) view.webContents.close();
    });

    this.shell.webContents.once('did-finish-load', () => this.window.show());
  }

  /** Show a tab's view in the content frame (or nothing: the shell's empty state shows through). */
  showTab(view: WebContentsView | null): void {
    if (this.tabView === view) return;
    if (this.tabView) this.window.contentView.removeChildView(this.tabView);
    this.tabView = view;
    if (view) {
      this.window.contentView.addChildView(view, 1);
      this.layout();
      if (!this.overlayVisible) view.webContents.focus();
    } else if (!this.overlayVisible) {
      this.shell.webContents.focus();
    }
  }

  get activeTabContents() {
    return this.tabView?.webContents ?? null;
  }

  setAnchor(rect: Rect | null): void {
    this.anchor = rect;
  }

  openOverlay(mode: OverlayOpenEvent['mode'], url: string): void {
    this.overlayVisible = true;
    this.overlay.setVisible(true);
    this.overlay.webContents.focus();
    send(this.overlay.webContents, 'overlay:open', { mode, anchor: mode === 'edit' ? this.anchor : null, url });
  }

  closeOverlay(): void {
    if (!this.overlayVisible) return;
    this.overlayVisible = false;
    this.overlay.setVisible(false);
    (this.tabView?.webContents ?? this.shell.webContents).focus();
  }

  /** The content frame: inset from the window, right of the sidebar, below the strip on Windows/Linux. */
  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    const inset = size.frameInset;
    const top = platform === 'darwin' ? inset : size.strip;
    this.shell.setBounds({ x: 0, y: 0, width, height });
    this.overlay.setBounds({ x: 0, y: 0, width, height });
    this.tabView?.setBounds({
      x: size.sidebarWidth,
      y: top,
      width: Math.max(0, width - size.sidebarWidth - inset),
      height: Math.max(0, height - top - inset),
    });
  }
}
