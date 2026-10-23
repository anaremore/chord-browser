/**
 * One Chord window (ARCHITECTURE.md §5). Views, bottom to top:
 *   shell    Chord's UI, full window, transparent
 *   tab      the active tab, inset and rounded (index 1)
 *   popover  find bar and permission prompts: sized to its cards, at the frame's top-right
 *   floating an extension's popup, under its button (at most one)
 *   overlay  the command bar: always loaded, hidden until ⌘T / ⌘L (and Peek's scrim and header)
 *   peek     Peek's page, in the card the overlay draws (DESIGN.md §7.9)
 */
import { join } from 'node:path';
import type { Bounds, WindowId, WindowModel } from '@chord/core';
import type { OverlayOpenEvent, PeekState, Rect, Role } from '@chord/ipc';
import { frameRadius, radius, size, space, springCurve, springs } from '@chord/tokens';
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

export type UiSurface = 'shell' | 'overlay' | 'popover' | 'settings' | 'archive' | 'mini';

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
  mini: { preload: 'mini', role: 'mini' },
};

/** Peek's card: up to 88% of the content frame, at most 1200 × 900, centered in it (DESIGN.md §7.9). */
const PEEK_SHARE = 0.88;
const PEEK_MAX = { width: 1200, height: 900 } as const;

/** What a Peek shows, apart from where its card is (main works that out from the window). */
export type PeekInfo = Omit<PeekState, 'card'>;

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
  private pendingOpen: { mode: OverlayOpenEvent['mode']; url: string; anchor: Rect | null } | null = null;
  readonly isPrivate: boolean;
  private origin: FrameOrigin;
  private frameAnimation: ReturnType<typeof setInterval> | undefined;
  /** Minimal mode's peek: the shell sits above the page so the sidebar can float over it. */
  private peeking = false;
  /** The page is in HTML fullscreen (a video): it covers the whole window, above Chord's own views. */
  private pageFullScreen = false;
  private floating: FloatingView | null = null;
  /** Peek: its page, and what its chrome in the overlay shows. */
  private peekView: WebContentsView | null = null;
  private peek: PeekInfo | null = null;
  private peekSeq = 0;
  private peekTimer: ReturnType<typeof setTimeout> | undefined;
  /** Duet's panel on the right (0 when closed): the page's frame ends before it, with a gap. */
  private duetWidth = 0;

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
      clearTimeout(this.peekTimer);
      nativeTheme.off('updated', onTheme);
      clearTimeout(boundsTimer);
      clearInterval(this.frameAnimation);
      for (const view of [this.shell, this.popover, this.overlay]) if (!view.webContents.isDestroyed()) view.webContents.close();
    });

    // Quitting right after launch can close the window before its shell has loaded.
    this.shell.webContents.once('did-finish-load', () => {
      if (!this.window.isDestroyed()) this.window.show();
    });
    // Loading again (a reload, or after a crash), the command bar isn't listening until it says so.
    this.overlay.webContents.on('did-start-loading', () => {
      this.overlayReady = false;
    });
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

  /* ---------- Peek (DESIGN.md §7.9, §8.5) ---------- */

  /** Peek's page, while one is open. */
  get peekContents() {
    return this.peek ? (this.peekView?.webContents ?? null) : null;
  }

  /** Which opening of the overlay is Peek's, so a close for it (overlay:close) closes the Peek. */
  get peekOverlaySeq(): number | null {
    return this.peek ? this.peekSeq : null;
  }

  /**
   * Open Peek over the frame: the overlay draws the scrim and the card's
   * header, growing from the click; the page goes into the card once the
   * card has landed (`delayMs`), so it never pops in ahead of it.
   */
  openPeek(view: WebContentsView, info: PeekInfo, delayMs: number): void {
    if (!this.overlayReady || this.window.isDestroyed()) return;
    this.closeFloating();
    this.peek = info;
    this.peekView = view;
    view.setBorderRadius(radius.lg);
    // The find bar goes above Peek's page, at its card's corner.
    const root = this.window.contentView;
    root.removeChildView(this.popover);
    root.addChildView(this.popover);
    this.overlayVisible = true;
    this.overlay.setVisible(true);
    // Esc and ⌘↵ work from the first frame; the page takes focus once it's in the card.
    this.overlay.webContents.focus();
    this.peekSeq = ++this.overlaySeq;
    send(this.overlay.webContents, 'overlay:open', { mode: 'peek', anchor: null, url: info.url, seq: this.peekSeq, peek: this.peekState() });
    clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => {
      if (this.peekView !== view || this.window.isDestroyed()) return;
      root.addChildView(view, root.children.indexOf(this.popover));
      this.layout();
      view.webContents.focus();
    }, delayMs);
    this.layout();
  }

  /** The page moved on (address, title): Peek's header follows. */
  updatePeek(info: Partial<PeekInfo>): void {
    if (!this.peek) return;
    this.peek = { ...this.peek, ...info };
    send(this.overlay.webContents, 'peek:state', this.peekState());
  }

  /** Take Peek's page out of the window (it closes, or becomes a tab) and put the overlay away. */
  closePeek(): WebContentsView | null {
    const view = this.peekView;
    clearTimeout(this.peekTimer);
    if (this.peek) send(this.overlay.webContents, 'overlay:dismiss', { seq: this.peekSeq });
    this.peek = null;
    this.peekView = null;
    if (this.window.isDestroyed()) return view;
    const root = this.window.contentView;
    if (view && root.children.includes(view)) root.removeChildView(view);
    root.removeChildView(this.popover);
    root.addChildView(this.popover, root.children.indexOf(this.overlay));
    if (this.overlayVisible) {
      this.overlayVisible = false;
      this.overlay.setVisible(false);
    }
    this.layout();
    (this.tabView?.webContents ?? this.shell.webContents).focus();
    return view;
  }

  /**
   * "Open in Today": Peek's page grows from its card to the frame (`smooth`),
   * then `done` makes it the tab. With motion off it's immediate.
   */
  growPeekToFrame(animate: boolean, done: () => void): void {
    const view = this.peekView;
    if (!view || !this.peek || this.window.isDestroyed()) return done();
    clearTimeout(this.peekTimer);
    const root = this.window.contentView;
    if (!root.children.includes(view)) root.addChildView(view, root.children.indexOf(this.popover));
    const from = this.peekPageRect();
    const to = this.frameRect();
    if (!animate) return done();
    const start = performance.now();
    const timer = setInterval(() => {
      if (this.window.isDestroyed() || view.webContents.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      const elapsed = performance.now() - start;
      const k = FRAME_SPRING.at(elapsed);
      view.setBounds({
        x: Math.round(from.x + (to.x - from.x) * k),
        y: Math.round(from.y + (to.y - from.y) * k),
        width: Math.round(from.width + (to.width - from.width) * k),
        height: Math.round(from.height + (to.height - from.height) * k),
      });
      if (elapsed >= FRAME_SPRING.durationMs) {
        clearInterval(timer);
        done();
      }
    }, FRAME_TICK_MS);
  }

  private peekState(): PeekState {
    return { ...this.peek!, card: this.peekCard() };
  }

  /** The content frame, in window coordinates (left of Duet's panel when it's open, as layout() has it). */
  private frameRect(): Rect {
    const { width: windowWidth, height } = this.window.getContentBounds();
    const width = this.duetWidth > 0 ? Math.max(0, windowWidth - this.duetWidth - space[2]) : windowWidth;
    const x = Math.round(this.origin.left);
    const y = Math.round(this.origin.top);
    return { x, y, width: Math.max(0, width - x - size.frameInset), height: Math.max(0, height - y - size.frameInset) };
  }

  private peekCard(): Rect {
    const frame = this.frameRect();
    const width = Math.round(Math.min(frame.width * PEEK_SHARE, PEEK_MAX.width));
    const height = Math.round(Math.min(frame.height * PEEK_SHARE, PEEK_MAX.height));
    return { x: Math.round(frame.x + (frame.width - width) / 2), y: Math.round(frame.y + (frame.height - height) / 2), width, height };
  }

  /** Peek's page: the card below its 40 px header. */
  private peekPageRect(): Rect {
    const card = this.peekCard();
    return { x: card.x, y: card.y + size.header, width: card.width, height: Math.max(0, card.height - size.header) };
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
    // Peek's chrome closes with Peek (Browser does both).
    if (this.peek && seq === this.peekSeq) return;
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

  /** Duet's panel opened (its width) or closed (0). The page makes room for it. */
  setDuetWidth(width: number): void {
    if (this.duetWidth === width) return;
    this.duetWidth = width;
    this.closeFloating();
    this.layout();
  }

  /** The content frame: inset from the window, right of the sidebar (if docked), below the strip on Windows/Linux. */
  private layout(): void {
    const { width: windowWidth, height } = this.window.getContentBounds();
    // With Duet open, the frame ends before its panel and the gap between them.
    const width = this.duetWidth > 0 ? Math.max(0, windowWidth - this.duetWidth - space[2]) : windowWidth;
    const inset = size.frameInset;
    const x = Math.round(this.origin.left);
    const y = Math.round(this.origin.top);
    this.shell.setBounds({ x: 0, y: 0, width: windowWidth, height });
    this.overlay.setBounds({ x: 0, y: 0, width: windowWidth, height });
    if (this.pageFullScreen) this.tabView?.setBounds({ x: 0, y: 0, width: windowWidth, height });
    else this.tabView?.setBounds({ x, y, width: Math.max(0, width - x - inset), height: Math.max(0, height - y - inset) });
    // The popover hangs from the frame's top-right corner; its cards carry their own margin.
    // With Peek open it hangs from the card's, below its header, over Peek's page.
    const { width: pw, height: ph } = this.popoverSize;
    if (this.peek) {
      const page = this.peekPageRect();
      this.popover.setBounds({ x: Math.max(page.x, page.x + page.width - pw), y: page.y, width: pw, height: ph });
      if (this.peekView && this.window.contentView.children.includes(this.peekView)) this.peekView.setBounds(page);
      send(this.overlay.webContents, 'peek:state', this.peekState());
      return;
    }
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
