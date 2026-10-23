/**
 * One Chord window (ARCHITECTURE.md §5). Views, bottom to top:
 *   shell    Chord's UI, full window, transparent
 *   tab      the active tab, inset and rounded (index 1)
 *   popover  find bar and permission prompts: sized to its cards, at the frame's top-right
 *   floating an extension's popup, under its button (at most one)
 *   overlay  the command bar: always loaded, hidden until ⌘T / ⌘L
 */
import { join } from 'node:path';
import type { Bounds, WindowId, WindowModel } from '@chord/core';
import type { OverlayOpenEvent, Rect, Role, Toast } from '@chord/ipc';
import { frameRadius, size, space, springCurve, springs } from '@chord/tokens';
import { BaseWindow, WebContentsView, nativeTheme, type Menu, type Session } from 'electron';
import { registerCaller, send } from './ipc';
import { platform, systemInfo, titleBarOverlay, windowChromeOptions } from './platform';
import { lockToOrigins } from './security';
import { originOf } from './urls';

export type SidebarMode = WindowModel['sidebar'];

export interface AppWindowOptions {
  id: WindowId;
  uiSession: Session;
  bounds: Bounds | null;
  sidebar: SidebarMode;
  sidebarWidth: number;
  /** A private window: always dark, and titled so in the taskbar and window switcher. */
  private?: boolean;
  onBounds(bounds: Bounds): void;
}

interface FrameOrigin {
  left: number;
  top: number;
}

/** Where the content frame starts: right of the sidebar, or just inset when it's collapsed (DESIGN.md §3.3). */
function frameOrigin(sidebar: SidebarMode, sidebarWidth: number): FrameOrigin {
  if (sidebar === 'collapsed') return { left: size.frameInset, top: size.strip };
  return { left: sidebarWidth, top: platform === 'darwin' ? size.frameInset : size.strip };
}

const FRAME_SPRING = springCurve(springs.smooth);
const FRAME_TICK_MS = 1000 / 60;

export type UiSurface = 'shell' | 'overlay' | 'popover' | 'settings' | 'archive';

/** A view that floats over the page until something else happens (an extension's popup). */
export interface FloatingView {
  readonly view: WebContentsView;
  close(): void;
}

/**
 * Each surface's preload and IPC role. Settings and the archive page are both
 * Chord's own pages, but only the archive sees archived tabs.
 */
const SURFACES: Record<UiSurface, { preload: string; role: Role }> = {
  shell: { preload: 'shell', role: 'shell' },
  overlay: { preload: 'overlay', role: 'overlay' },
  popover: { preload: 'popover', role: 'popover' },
  settings: { preload: 'internal', role: 'internal' },
  archive: { preload: 'archive', role: 'archive' },
};

function uiUrl(surface: UiSurface): string {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return dev ? `${dev}/${surface}/index.html` : `chord://${surface}/`;
}

/** A view of Chord's own UI: sandboxed, on the in-memory UI session, locked to its origin. */
export function createUiView(uiSession: Session, surface: UiSurface, hash?: string): WebContentsView {
  const { preload, role } = SURFACES[surface];
  const view = new WebContentsView({
    webPreferences: {
      session: uiSession,
      preload: join(import.meta.dirname, `../preload/${preload}.cjs`),
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
  void view.webContents.loadURL(hash ? `${url}#${encodeURIComponent(hash)}` : url);
  return view;
}

export class AppWindow {
  readonly id: WindowId;
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
  readonly overlay: WebContentsView;
  readonly popover: WebContentsView;
  private tabView: WebContentsView | null = null;
  /** The page is hidden while the frame shows why it didn't load (or that it crashed). */
  private tabHidden = false;
  private popoverSize = { width: 0, height: 0 };
  private focusPopoverWhenShown = false;
  private anchor: Rect | null = null;
  private overlayVisible = false;
  private overlaySeq = 0;
  /** The command bar listens only once it has started; an opening asked for before that waits here. */
  private overlayReady = false;
  /** Toasts wait for the shell to load: one sent earlier (an update found at launch) would be lost. */
  private shellLoaded = false;
  private pendingToasts: Toast[] = [];
  private pendingOpen: { mode: OverlayOpenEvent['mode']; url: string; anchor: Rect | null } | null = null;
  readonly isPrivate: boolean;
  private origin: FrameOrigin;
  private frameAnimation: ReturnType<typeof setInterval> | undefined;
  /** Minimal mode's peek: the shell sits above the page so the sidebar can float over it. */
  private peeking = false;
  /** The page is in HTML fullscreen (a video): it covers the whole window, above Chord's own views. */
  private pageFullScreen = false;
  private floating: FloatingView | null = null;

  constructor({ id, uiSession, bounds, sidebar, sidebarWidth, private: isPrivate = false, onBounds }: AppWindowOptions) {
    this.id = id;
    this.isPrivate = isPrivate;
    this.origin = frameOrigin(sidebar, sidebarWidth);
    const forced = isPrivate ? 'dark' : null;
    this.window = new BaseWindow({
      ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { width: 1280, height: 820 }),
      minWidth: 720,
      minHeight: 480,
      title: isPrivate ? 'Chord (private window)' : 'Chord',
      show: false,
      ...windowChromeOptions(forced),
    });
    if (bounds?.maximized) this.window.maximize();

    this.shell = createUiView(uiSession, 'shell');
    this.popover = createUiView(uiSession, 'popover');
    this.popover.setVisible(false);
    this.overlay = createUiView(uiSession, 'overlay');
    this.overlay.setVisible(false);
    // Tab views go in at index 1, between the shell and the popover.
    this.window.contentView.addChildView(this.shell);
    this.window.contentView.addChildView(this.popover);
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
      this.closeFloating();
      this.layout();
      reportBounds();
    });
    this.window.on('move', reportBounds);
    this.window.on('maximize', reportBounds);
    this.window.on('unmaximize', reportBounds);

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay(forced));
      for (const view of [this.shell, this.popover, this.overlay]) send(view.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      this.closeFloating();
      nativeTheme.off('updated', onTheme);
      clearTimeout(boundsTimer);
      clearInterval(this.frameAnimation);
      for (const view of [this.shell, this.popover, this.overlay]) if (!view.webContents.isDestroyed()) view.webContents.close();
    });

    // Quitting right after launch can close the window before its shell has loaded.
    this.shell.webContents.once('did-finish-load', () => {
      if (!this.window.isDestroyed()) this.window.show();
    });
    this.shell.webContents.on('did-start-loading', () => {
      this.shellLoaded = false;
    });
    this.shell.webContents.on('did-finish-load', () => {
      this.shellLoaded = true;
      const pending = this.pendingToasts;
      this.pendingToasts = [];
      for (const toast of pending) send(this.shell.webContents, 'toast:show', toast);
    });
    // Loading again (a reload, or after a crash), the command bar isn't listening until it says so.
    this.overlay.webContents.on('did-start-loading', () => {
      this.overlayReady = false;
    });
  }

  /** A toast in this window's sidebar (or minimal bar), once its shell can show it. */
  toast(toast: Toast): void {
    if (this.shellLoaded) send(this.shell.webContents, 'toast:show', toast);
    // The same toast again replaces the one waiting, as it would on screen.
    else this.pendingToasts = [...this.pendingToasts.filter((t) => t.id !== toast.id), toast];
  }

  /** Show a tab's view in the content frame (or nothing: the shell's empty state shows through). */
  showTab(view: WebContentsView | null): void {
    if (this.tabView === view) return;
    this.closeFloating();
    // Fullscreen belonged to the page going away; Chord's frame comes back for the next one.
    if (this.pageFullScreen) this.leavePageFullScreen();
    if (this.tabView) this.window.contentView.removeChildView(this.tabView);
    this.tabView = view;
    if (view) {
      view.setVisible(!this.tabHidden);
      // Just above the shell; or, while the sidebar peeks over the page, just below it.
      this.window.contentView.addChildView(view, this.peeking ? 0 : 1);
      this.layout();
      if (!this.overlayVisible) view.webContents.focus();
    } else if (!this.overlayVisible) {
      this.shell.webContents.focus();
    }
  }

  get activeTabContents() {
    return this.tabView?.webContents ?? null;
  }

  /**
   * A page entered or left HTML fullscreen. Electron makes the window
   * fullscreen itself; Chord lifts the page above its own views and lets it
   * fill the window, square-cornered, then puts the frame back.
   */
  setPageFullScreen(on: boolean): void {
    if (this.pageFullScreen === on || this.window.isDestroyed() || !this.tabView) return;
    if (!on) return this.leavePageFullScreen();
    this.pageFullScreen = true;
    this.closeFloating();
    this.closeOverlay();
    const root = this.window.contentView;
    root.removeChildView(this.tabView);
    root.addChildView(this.tabView);
    this.tabView.setBorderRadius(0);
    this.layout();
  }

  private leavePageFullScreen(): void {
    this.pageFullScreen = false;
    const view = this.tabView;
    if (view && !this.window.isDestroyed()) {
      const root = this.window.contentView;
      root.removeChildView(view);
      root.addChildView(view, this.peeking ? 0 : 1);
      view.setBorderRadius(frameRadius[platform]);
    }
    this.layout();
  }

  /** Hide the page so the frame behind it can explain an error or a crash. */
  setTabHidden(hidden: boolean): void {
    if (this.tabHidden === hidden) return;
    this.tabHidden = hidden;
    this.tabView?.setVisible(!hidden);
  }

  /** The popover reports its cards' size; 0 × 0 hides it. */
  setPopoverSize(width: number, height: number): void {
    this.popoverSize = { width: Math.ceil(width), height: Math.ceil(height) };
    const visible = this.popoverSize.width > 0 && this.popoverSize.height > 0;
    this.popover.setVisible(visible);
    this.layout();
    if (visible && this.focusPopoverWhenShown) {
      this.focusPopoverWhenShown = false;
      this.popover.webContents.focus();
    }
  }

  /** Give the popover keyboard focus (the find bar), now or as soon as it's shown. */
  focusPopover(): void {
    if (this.popover.getVisible()) this.popover.webContents.focus();
    else this.focusPopoverWhenShown = true;
  }

  setAnchor(rect: Rect | null): void {
    this.anchor = rect;
  }

  /** `anchor` places the downloads panel by its button; ⌘L uses the address the shell reported. */
  openOverlay(mode: OverlayOpenEvent['mode'], url: string, anchor: Rect | null = null): void {
    this.closeFloating();
    if (!this.overlayReady) {
      // A brand-new window: the command bar opens as soon as it's listening.
      this.pendingOpen = { mode, url, anchor };
      return;
    }
    this.overlayVisible = true;
    this.overlay.setVisible(true);
    this.overlay.webContents.focus();
    send(this.overlay.webContents, 'overlay:open', { mode, anchor: mode === 'edit' ? this.anchor : anchor, url, seq: ++this.overlaySeq });
  }

  /** The command bar has started and listens for openings (it says so after every load). */
  markOverlayReady(): void {
    this.overlayReady = true;
    const pending = this.pendingOpen;
    this.pendingOpen = null;
    if (pending) this.openOverlay(pending.mode, pending.url, pending.anchor);
  }

  /** `seq` is the opening being closed; a close for an earlier one (racing a newer open) is ignored. */
  closeOverlay(seq = this.overlaySeq): void {
    if (!this.overlayVisible || seq !== this.overlaySeq) return;
    this.overlayVisible = false;
    this.overlay.setVisible(false);
    (this.tabView?.webContents ?? this.shell.webContents).focus();
  }

  /**
   * Dock, collapse or resize the sidebar. The page glides on the same spring
   * the shell's CSS uses for the frame behind it, so the two move as one;
   * resizing follows the pointer without animating.
   */
  setSidebar(sidebar: SidebarMode, width: number, animate: boolean): void {
    this.closeFloating();
    clearInterval(this.frameAnimation);
    this.frameAnimation = undefined;
    if (sidebar === 'docked') this.setPeek(false);
    const to = frameOrigin(sidebar, width);
    if (!animate || !this.tabView) {
      this.origin = to;
      this.layout();
      return;
    }
    const from = this.origin;
    const start = performance.now();
    const step = () => {
      const elapsed = performance.now() - start;
      const k = FRAME_SPRING.at(elapsed);
      this.origin = { left: from.left + (to.left - from.left) * k, top: from.top + (to.top - from.top) * k };
      this.layout();
      if (elapsed >= FRAME_SPRING.durationMs) {
        clearInterval(this.frameAnimation);
        this.frameAnimation = undefined;
      }
    };
    this.frameAnimation = setInterval(step, FRAME_TICK_MS);
    step();
  }

  /**
   * Minimal mode's sidebar peek (DESIGN.md §3.3, §6.5): the shell is lifted
   * above the page while the sidebar floats over it, and goes back below when
   * it slides away. The page itself never moves.
   */
  setPeek(open: boolean): void {
    if (this.peeking === open || this.window.isDestroyed()) return;
    this.peeking = open;
    const root = this.window.contentView;
    root.removeChildView(this.shell);
    // Above the page, below the popover and the command bar; or back at the bottom.
    root.addChildView(this.shell, open ? root.children.indexOf(this.popover) : 0);
  }

  /** Float a view over the page, below the command bar. Whatever floated before closes. */
  showFloating(floating: FloatingView): void {
    this.closeFloating();
    this.floating = floating;
    this.window.contentView.addChildView(floating.view, this.window.contentView.children.indexOf(this.overlay));
  }

  /** Take a floating view off the window (it closed itself). */
  releaseFloating(floating: FloatingView): void {
    if (this.floating === floating) this.floating = null;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(floating.view);
  }

  closeFloating(): void {
    const floating = this.floating;
    this.floating = null;
    floating?.close();
  }

  /** The window's content area and the page frame within it, for placing floating views. */
  get frameBounds(): { width: number; height: number; frameTop: number } {
    const { width, height } = this.window.getContentBounds();
    return { width, height, frameTop: Math.round(this.origin.top) };
  }

  /** The content frame: inset from the window, right of the sidebar (if docked), below the strip on Windows/Linux. */
  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    const inset = size.frameInset;
    const x = Math.round(this.origin.left);
    const y = Math.round(this.origin.top);
    this.shell.setBounds({ x: 0, y: 0, width, height });
    this.overlay.setBounds({ x: 0, y: 0, width, height });
    if (this.pageFullScreen) this.tabView?.setBounds({ x: 0, y: 0, width, height });
    else this.tabView?.setBounds({ x, y, width: Math.max(0, width - x - inset), height: Math.max(0, height - y - inset) });
    // The popover hangs from the frame's top-right corner; its cards carry their own margin.
    const { width: pw, height: ph } = this.popoverSize;
    this.popover.setBounds({ x: Math.max(x, width - inset - pw), y, width: pw, height: ph });
  }

  /**
   * Pop a menu at a point (an empty rect), or below an anchor with its right
   * edge under the anchor's (the ⋯ button, by the window's right edge).
   * Electron can't right-align native menus, so `width` is the menu's
   * measured width.
   */
  popupMenu(menu: Menu, anchor: Rect, width = 0): void {
    const below = anchor.height > 0 ? anchor.height + space[1] : 0;
    const x = Math.max(0, Math.round(anchor.x + anchor.width - width));
    menu.popup({ window: this.window, x, y: Math.round(anchor.y + below) });
  }
}
