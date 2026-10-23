/**
 * One Chord window (ARCHITECTURE.md §5). Views, bottom to top:
 *   shell    Chord's UI, full window, transparent
 *   tabs     the active tab, or 2–4 split panes, inset and rounded (from index 1)
 *   popover  find bar and permission prompts: sized to its cards, at the frame's top-right
 *   preview  a pinned tab's or folder's hover preview, beside the sidebar (DESIGN.md §7.6)
 *   floating an extension's popup, under its button (at most one)
 *   overlay  the command bar: always loaded, hidden until ⌘T / ⌘L (and Peek's scrim and header)
 *   peek     Peek's page, in the card the overlay draws (DESIGN.md §7.9)
 */
import { join } from 'node:path';
import { paneRects, type Bounds, type SplitDirection, type WindowId, type WindowModel } from '@chord/core';
import type { OverlayOpenEvent, PeekState, Rect, Role, Toast } from '@chord/ipc';
import { frameRadius, radius, size, space, springCurve, springs } from '@chord/tokens';
import { BaseWindow, WebContentsView, nativeTheme, type Menu, type Session, type WebContents } from 'electron';
import { FrameSnapshots, offscreen } from './frame-snapshot';
import { registerCaller, send } from './ipc';
import { epochNow, markLaunch } from './perf';
import { applyMaterial, platform, systemInfo, titleBarOverlay, windowChromeOptions } from './platform';
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
/** The hover preview glides between rows on `snappy` (DESIGN.md §7.6). */
const PREVIEW_SPRING = springCurve(springs.snappy);
/** The preview page pads its card so the whole shadow shows (more below); the card's own edge sits this far in. */
const PREVIEW_PAD = space[6];

/** How split panes share the content frame (DESIGN.md §7.9). */
export interface PaneLayout {
  direction: SplitDirection;
  sizes: number[];
}

export type UiSurface = 'shell' | 'overlay' | 'popover' | 'preview' | 'settings' | 'archive' | 'mini';

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
  preview: { preload: 'preview', role: 'preview' },
  settings: { preload: 'internal', role: 'internal' },
  archive: { preload: 'archive', role: 'archive' },
  mini: { preload: 'mini', role: 'mini' },
};

/**
 * Put a view at `rect`, unless it's there already. Every move of a page makes
 * it lay itself out again, so pages move only when they really go somewhere.
 */
function place(view: WebContentsView, rect: Rect): void {
  const to = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const now = view.getBounds();
  if (now.x !== to.x || now.y !== to.y || now.width !== to.width || now.height !== to.height) view.setBounds(to);
}

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
  readonly preview: WebContentsView;
  private previewSize = { width: 0, height: 0 };
  /** The hovered row's top and bottom, while a preview is wanted. */
  private previewAnchor: { top: number; bottom: number } | null = null;
  private previewGlide = false;
  private previewAnimation: ReturnType<typeof setInterval> | undefined;
  /** The pages shown: one tab, or a split's panes in order. */
  private panes: WebContentsView[] = [];
  private focusedPane = 0;
  private paneLayout: PaneLayout | null = null;
  /** Pages hidden while the frame shows why they didn't load (or that they crashed). */
  private hiddenPanes = new Set<WebContentsView>();
  private popoverSize = { width: 0, height: 0 };
  private focusPopoverWhenShown = false;
  private anchor: Rect | null = null;
  private overlayVisible = false;
  /** Where the keyboard was when the overlay opened: Esc gives it back there. */
  private overlayFrom: 'shell' | 'page' = 'page';
  private overlaySeq = 0;
  /** The command bar listens only once it has started; an opening asked for before that waits here. */
  private overlayReady = false;
  /** Toasts wait for the shell to load: one sent earlier (an update found at launch) would be lost. */
  private shellLoaded = false;
  private pendingToasts: Toast[] = [];
  private pendingOpen: { mode: OverlayOpenEvent['mode']; url: string; anchor: Rect | null; requestedAt: number } | null = null;
  /** The shell has painted its first frame: the window's launch is over. */
  private shellPainted = false;
  readonly isPrivate: boolean;
  private origin: FrameOrigin;
  /** The frame changes size by its pages' snapshot (ARCHITECTURE.md §5), never by moving them every frame. */
  private readonly snapshots: FrameSnapshots;
  /** Minimal mode's peek: the shell sits above the page so the sidebar can float over it. */
  private peeking = false;
  /** A tab is being dragged from the sidebar: the shell sits above the pages to show split drop zones. */
  private lifted = false;
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
  /** Duet's openings and closings waiting for their frame change, oldest first. */
  private readonly duetChanges: { width: number; publish(): void }[] = [];

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
    this.preview = createUiView(uiSession, 'preview');
    this.preview.setVisible(false);
    this.overlay = createUiView(uiSession, 'overlay');
    this.overlay.setVisible(false);
    // Tab views go in at index 1, between the shell and the popover.
    this.window.contentView.addChildView(this.shell);
    this.window.contentView.addChildView(this.popover);
    this.window.contentView.addChildView(this.preview);
    this.window.contentView.addChildView(this.overlay);

    // The snapshot's rects are the layout's, in the shell's CSS pixels: the shell draws the pictures with them.
    this.snapshots = new FrameSnapshots({
      tell: (event) => send(this.shell.webContents, 'frame:snapshot', event),
      panes: () => {
        const frame = this.frameRect();
        const rects = this.paneRectsIn(frame);
        return this.panes.map((view, i) => ({ view, rect: rects[i] ?? frame }));
      },
      canSnapshot: () => this.canSnapshot(),
      targets: () => this.paneRectsIn(this.frameRect()),
      layout: () => this.layout(),
    });
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
      this.hidePreview();
      // A frame snapshot's pictures are going to where the frame was: the pages come back at once.
      this.snapshots.finish();
      this.layout();
      reportBounds();
    });
    this.window.on('move', reportBounds);
    if (platform === 'darwin') this.window.on('leave-full-screen', () => this.refreshPageFullScreen());
    this.window.on('maximize', reportBounds);
    this.window.on('unmaximize', reportBounds);

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay(forced));
      applyMaterial(this.window, forced);
      for (const view of [this.shell, this.popover, this.preview, this.overlay]) send(view.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      this.closeFloating();
      clearTimeout(this.peekTimer);
      nativeTheme.off('updated', onTheme);
      clearTimeout(boundsTimer);
      this.snapshots.dispose();
      clearInterval(this.previewAnimation);
      for (const view of [this.shell, this.popover, this.preview, this.overlay]) if (!view.webContents.isDestroyed()) view.webContents.close();
    });

    markLaunch('windowCreated');
    // Quitting right after launch can close the window before its shell has loaded.
    this.shell.webContents.once('did-finish-load', () => {
      markLaunch('shellLoaded');
      if (this.window.isDestroyed()) return;
      this.window.show();
      markLaunch('windowShown');
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

  /** The focused page: the active tab, or the focused pane of a split. */
  private get tabView(): WebContentsView | null {
    return this.panes[this.focusedPane] ?? null;
  }

  /** Whether the shell sits above the pages (the sidebar peeking, or a drag showing drop zones). */
  private get shellRaised(): boolean {
    return this.peeking || this.lifted;
  }

  /**
   * Show tabs' views in the content frame: one, or a split's panes laid out
   * by `layout`, with `focused` the one that takes the keyboard. None: the
   * shell's empty state shows through.
   */
  showTabs(views: readonly WebContentsView[], focused: number, layout: PaneLayout | null): void {
    // Pages coming or going while a frame snapshot moves: the pictures are of the old ones, so they're done.
    this.snapshots.finish();
    const next = views.slice(0, 4);
    const focus = next[focused] ?? next[0] ?? null;
    const focusChanged = focus !== this.tabView;
    const same = next.length === this.panes.length && next.every((v, i) => v === this.panes[i]);
    this.paneLayout = next.length > 1 ? layout : null;
    if (same && !focusChanged) {
      this.layout();
      return;
    }
    if (focusChanged) {
      this.closeFloating();
      // Fullscreen belonged to the page going away; Chord's frame comes back for the next one.
      if (this.pageFullScreen) this.leavePageFullScreen();
    }
    const root = this.window.contentView;
    for (const view of this.panes) if (!next.includes(view)) root.removeChildView(view);
    for (const view of next) {
      view.setVisible(!this.hiddenPanes.has(view));
      // Just above the shell; or, while the shell is raised over the pages, just below it. Panes never overlap.
      if (!this.panes.includes(view)) root.addChildView(view, this.shellRaised ? 0 : 1);
    }
    this.panes = [...next];
    this.focusedPane = focus ? next.indexOf(focus) : 0;
    this.layout();
    if (this.overlayVisible || !focusChanged) return;
    (focus?.webContents ?? this.shell.webContents).focus();
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
    this.hidePreview();
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
    send(this.overlay.webContents, 'overlay:open', { mode: 'peek', anchor: null, url: info.url, seq: this.peekSeq, peek: this.peekState(), requestedAt: epochNow() });
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
    // Back where it lives: above the pages, below the hover preview and the command bar.
    root.removeChildView(this.popover);
    root.addChildView(this.popover, root.children.indexOf(this.preview));
    if (this.overlayVisible) {
      this.overlayVisible = false;
      this.overlay.setVisible(false);
    }
    this.layout();
    (this.tabView?.webContents ?? this.shell.webContents).focus();
    return view;
  }

  /**
   * "Open in Today": Peek's page grows from its card to the whole frame
   * (`smooth`; as a tab of its own it replaces a split), then `done` makes it
   * the tab. With motion off it's immediate.
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

  /** The content frame, in window coordinates (left of Duet's panel when it's open). */
  private frameRect(): Rect {
    const { width: windowWidth, height } = this.window.getContentBounds();
    const width = this.duetWidth > 0 ? Math.max(0, windowWidth - this.duetWidth - space[2]) : windowWidth;
    const x = Math.round(this.origin.left);
    const y = Math.round(this.origin.top);
    return { x, y, width: Math.max(0, width - x - size.frameInset), height: Math.max(0, height - y - size.frameInset) };
  }

  /** Each pane's rect in the frame: a split's, or the frame for one tab. The shell draws them with the same math. */
  private paneRectsIn(frame: Rect): Rect[] {
    return this.paneLayout && this.panes.length > 1 ? paneRects(frame, this.paneLayout.direction, this.paneLayout.sizes) : [frame];
  }

  /** Peek's card floats over the focused pane. */
  private peekCard(): Rect {
    const whole = this.frameRect();
    const frame = this.paneRectsIn(whole)[this.focusedPane] ?? whole;
    const width = Math.round(Math.min(frame.width * PEEK_SHARE, PEEK_MAX.width));
    const height = Math.round(Math.min(frame.height * PEEK_SHARE, PEEK_MAX.height));
    return { x: Math.round(frame.x + (frame.width - width) / 2), y: Math.round(frame.y + (frame.height - height) / 2), width, height };
  }

  /** Peek's page: the card below its 40 px header. */
  private peekPageRect(): Rect {
    const card = this.peekCard();
    return { x: card.x, y: card.y + size.header, width: card.width, height: Math.max(0, card.height - size.header) };
  }

  /** Every page shown in the frame: a split's panes, or the one tab. */
  get paneContents(): WebContents[] {
    return this.panes.map((v) => v.webContents);
  }

  /**
   * A page entered or left HTML fullscreen. Electron makes the window
   * fullscreen itself; Chord lifts the page above its own views and lets it
   * fill the window, square-cornered, then puts the frame back.
   */
  setPageFullScreen(on: boolean): void {
    if (this.pageFullScreen === on || this.window.isDestroyed() || !this.tabView) return;
    this.snapshots.finish();
    if (!on) return this.leavePageFullScreen();
    this.pageFullScreen = true;
    this.closeFloating();
    this.hidePreview();
    this.closeOverlay();
    const root = this.window.contentView;
    root.removeChildView(this.tabView);
    root.addChildView(this.tabView);
    this.tabView.setBorderRadius(0);
    this.layout();
  }

  /**
   * macOS: as the window animates out of fullscreen, Electron (45) tells the
   * page it's still fullscreen ("pending" while the transition runs) and
   * doesn't tell it again when the animation ends, so the page's element
   * stays fullscreen inside Chord's frame. Resizing the page's view makes
   * Chromium tell the page afresh, now that the transition is over.
   */
  private refreshPageFullScreen(): void {
    const view = this.tabView;
    if (!view || this.pageFullScreen || this.window.isDestroyed()) return;
    const bounds = view.getBounds();
    view.setBounds({ ...bounds, height: bounds.height + 1 });
    view.setBounds(bounds);
  }

  private leavePageFullScreen(): void {
    this.pageFullScreen = false;
    const view = this.tabView;
    if (view && !this.window.isDestroyed()) {
      const root = this.window.contentView;
      root.removeChildView(view);
      root.addChildView(view, this.shellRaised ? 0 : 1);
      view.setBorderRadius(frameRadius[platform]);
    }
    this.layout();
  }

  /** Hide these pages so the frame behind them can explain an error or a crash. */
  setHiddenPanes(hidden: ReadonlySet<WebContents>): void {
    const next = new Set(this.panes.filter((v) => hidden.has(v.webContents)));
    // A page failed or crashed while its picture moved: the frame explains it now.
    if (next.size !== this.hiddenPanes.size || [...next].some((v) => !this.hiddenPanes.has(v))) this.snapshots.finish();
    this.hiddenPanes = next;
    for (const view of this.panes) view.setVisible(!this.hiddenPanes.has(view));
  }

  /** The popover reports its cards' size; 0 × 0 hides it. */
  setPopoverSize(width: number, height: number): void {
    this.popoverSize = { width: Math.ceil(width), height: Math.ceil(height) };
    this.layout();
  }

  /**
   * The popover shows while it has cards, except while a frame snapshot moves
   * (it hangs from a page that's out of sight). Shown, it takes focus if asked to.
   */
  private showPopover(): void {
    const visible = this.popoverSize.width > 0 && this.popoverSize.height > 0 && !this.snapshots.active;
    if (this.popover.getVisible() !== visible) this.popover.setVisible(visible);
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

  /**
   * Show the hover preview beside the sidebar, its top level with the hovered
   * row (DESIGN.md §7.6). It appears once its page reports a size; while one
   * is up, the next glides to its row (`animate`) instead of jumping.
   */
  anchorPreview(anchor: { top: number; bottom: number }, animate: boolean): void {
    this.previewGlide = animate && this.preview.getVisible();
    this.previewAnchor = anchor;
    this.placePreview();
  }

  /** The preview page reports its card's size; 0 × 0 hides it. */
  setPreviewSize(width: number, height: number): void {
    this.previewSize = { width: Math.ceil(width), height: Math.ceil(height) };
    this.placePreview();
  }

  hidePreview(): void {
    this.previewAnchor = null;
    clearInterval(this.previewAnimation);
    this.previewAnimation = undefined;
    if (!this.window.isDestroyed()) this.preview.setVisible(false);
  }

  /**
   * Where the preview goes: level with the row, kept inside the window. The
   * view starts at the sidebar's edge, never over it: a view takes the pointer
   * even where it's transparent, and the rows' buttons and the resize handle
   * are there.
   */
  private placePreview(): void {
    if (this.window.isDestroyed()) return;
    const { width: w, height: h } = this.previewSize;
    if (!this.previewAnchor || w === 0 || h === 0) {
      this.preview.setVisible(false);
      return;
    }
    const content = this.window.getContentBounds();
    const x = Math.round(this.origin.left);
    const y = Math.max(0, Math.min(Math.round(this.previewAnchor.top) - PREVIEW_PAD, content.height - h));
    const from = this.preview.getBounds();
    clearInterval(this.previewAnimation);
    this.previewAnimation = undefined;
    if (!this.previewGlide || !this.preview.getVisible() || from.y === y) {
      this.preview.setBounds({ x, y, width: w, height: h });
      this.preview.setVisible(true);
      return;
    }
    const start = performance.now();
    const step = () => {
      if (this.window.isDestroyed()) return clearInterval(this.previewAnimation);
      const elapsed = performance.now() - start;
      const k = PREVIEW_SPRING.at(elapsed);
      this.preview.setBounds({ x, y: Math.round(from.y + (y - from.y) * k), width: w, height: h });
      if (elapsed >= PREVIEW_SPRING.durationMs) {
        clearInterval(this.previewAnimation);
        this.previewAnimation = undefined;
      }
    };
    this.previewAnimation = setInterval(step, FRAME_TICK_MS);
    step();
  }

  setAnchor(rect: Rect | null): void {
    this.anchor = rect;
  }

  /**
   * `anchor` places the downloads panel by its button; ⌘L uses the address the
   * shell reported. `from`: where the keyboard was, so dismissing it (Esc, a
   * click outside) gives the focus back there (DESIGN.md §10). `requestedAt` is
   * when the opening was asked for: the command bar's open budget counts from it.
   */
  openOverlay(mode: OverlayOpenEvent['mode'], url: string, anchor: Rect | null = null, from: 'shell' | 'page' = 'page', requestedAt = epochNow()): void {
    this.closeFloating();
    this.hidePreview();
    this.overlayFrom = from;
    if (!this.overlayReady) {
      // A brand-new window: the command bar opens as soon as it's listening.
      this.pendingOpen = { mode, url, anchor, requestedAt };
      return;
    }
    this.overlayVisible = true;
    this.overlay.setVisible(true);
    this.overlay.webContents.focus();
    send(this.overlay.webContents, 'overlay:open', { mode, anchor: mode === 'edit' ? this.anchor : anchor, url, seq: ++this.overlaySeq, requestedAt });
  }

  /** The command bar has started and listens for openings (it says so after every load). */
  markOverlayReady(): void {
    this.overlayReady = true;
    const pending = this.pendingOpen;
    this.pendingOpen = null;
    if (pending) this.openOverlay(pending.mode, pending.url, pending.anchor, this.overlayFrom, pending.requestedAt);
    else if (this.shellPainted) send(this.overlay.webContents, 'overlay:warm', null);
  }

  /**
   * The shell painted its first frame. Only now may the command bar warm up
   * for its first opening (CommandBar.tsx): doing it alongside the shell's
   * start would slow the launch.
   */
  markShellPainted(): void {
    if (this.shellPainted) return;
    this.shellPainted = true;
    if (this.overlayReady) send(this.overlay.webContents, 'overlay:warm', null);
  }

  /**
   * `seq` is the opening being closed; a close for an earlier one (racing a
   * newer open) is ignored. Dismissed, it gives the focus back to the shell if
   * that's where it came from; otherwise the page has it, as after a pick.
   */
  closeOverlay(seq = this.overlaySeq, dismissed = false): void {
    if (!this.overlayVisible || seq !== this.overlaySeq) return;
    // Peek's chrome closes with Peek (Browser does both).
    if (this.peek && seq === this.peekSeq) return;
    this.overlayVisible = false;
    this.overlay.setVisible(false);
    const back = dismissed && this.overlayFrom === 'shell' ? this.shell : (this.tabView ?? this.shell);
    back.webContents.focus();
  }

  /**
   * F6's regions (DESIGN.md §10): the shell decides the order, and asks for
   * the keyboard to go to the page, the popover (find, a permission prompt)
   * or back to itself.
   */
  focusRegion(to: 'page' | 'popover' | 'shell'): void {
    if (this.window.isDestroyed()) return;
    if (to === 'popover' && this.popover.getVisible()) this.popover.webContents.focus();
    else if (to === 'page' && this.tabView?.getVisible()) this.tabView.webContents.focus();
    else this.shell.webContents.focus();
  }

  /** Whether a find bar or permission prompt shows over the page (it's one of F6's regions). */
  get popoverShown(): boolean {
    return !this.window.isDestroyed() && this.popover.getVisible();
  }

  /** Which of the window's views has the keyboard, as F6 counts regions. */
  focusSource(contents: WebContents | null): 'shell' | 'popover' | 'overlay' | 'page' {
    if (contents === this.shell.webContents) return 'shell';
    if (contents === this.popover.webContents) return 'popover';
    if (contents === this.overlay.webContents) return 'overlay';
    return 'page';
  }

  /**
   * The sidebar docked, collapsed or resized: the frame starts somewhere
   * else, and the page goes there at once. Docking and collapsing glide
   * because they come through `changeFrame`; resizing follows the pointer.
   */
  setSidebar(sidebar: SidebarMode, width: number): void {
    this.closeFloating();
    this.hidePreview();
    // A resize while the pictures glide: the pages come back and follow the pointer.
    if (!this.snapshots.inChange) this.snapshots.finish();
    if (sidebar === 'docked') this.setPeek(false);
    this.origin = frameOrigin(sidebar, width);
    this.layout();
  }

  /**
   * Change the frame's size with `change` (it docks the sidebar, say). With
   * `animate`, by the snapshot technique (ARCHITECTURE.md §5): the pages are
   * pictured first, so `change` may run a moment later. Changes run in order.
   */
  changeFrame(change: () => void, animate: boolean): void {
    this.snapshots.change(change, animate);
  }

  /** Resolves once the frame changes asked for so far have happened (their pictures may still be gliding). */
  frameChanged(): Promise<void> {
    return this.snapshots.settled();
  }

  /** The shell painted a snapshot's pictures (`shown`), or they arrived (`moved`). */
  ackSnapshot(seq: number, phase: 'shown' | 'moved'): void {
    this.snapshots.ack(seq, phase);
  }

  /**
   * Whether the frame's pages can be pictured for a snapshot: the window is
   * on screen with its shell up, and every page in the frame shows (none is
   * fullscreen, or hidden behind an error).
   */
  private canSnapshot(): boolean {
    if (this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized()) return false;
    return this.shellPainted && this.panes.length > 0 && !this.pageFullScreen && this.hiddenPanes.size === 0;
  }

  /**
   * Minimal mode's sidebar peek (DESIGN.md §3.3, §6.5): the shell is lifted
   * above the page while the sidebar floats over it, and goes back below when
   * it slides away. The page itself never moves.
   */
  setPeek(open: boolean): void {
    if (this.peeking === open || this.window.isDestroyed()) return;
    const raised = this.shellRaised;
    this.peeking = open;
    this.hidePreview();
    if (raised !== this.shellRaised) this.placeShell();
  }

  /**
   * Dragging a tab from the sidebar: the shell goes above the pages so it can
   * draw split view's drop zones over them (DESIGN.md §8.4), and back after.
   * Its transparent parts let the pages show through.
   */
  setLifted(on: boolean): void {
    if (this.lifted === on || this.window.isDestroyed()) return;
    const raised = this.shellRaised;
    this.lifted = on;
    if (on) this.hidePreview();
    if (raised !== this.shellRaised) this.placeShell();
  }

  private placeShell(): void {
    const root = this.window.contentView;
    root.removeChildView(this.shell);
    // Above the pages, below the popover and the command bar; or back at the bottom.
    root.addChildView(this.shell, this.shellRaised ? root.children.indexOf(this.popover) : 0);
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

  /**
   * Duet's panel opens (its width) or closes (0), and the page makes room for
   * it: with `animate`, by the frame's snapshot while the panel slides in
   * (DESIGN.md §6.5). `publish` tells the shell what the panel shows; it's
   * held back while the frame's change waits for its pictures, so the panel
   * and the page move together.
   */
  setDuet(width: number, publish: () => void, animate: boolean): void {
    const waiting = this.duetChanges.at(-1);
    if (waiting ? waiting.width === width : this.duetWidth === width) {
      // Nothing changes size: what the panel shows goes now, or with the change it waits for.
      if (waiting) waiting.publish = publish;
      else publish();
      return;
    }
    const next = { width, publish };
    this.duetChanges.push(next);
    this.changeFrame(() => {
      this.duetChanges.splice(this.duetChanges.indexOf(next), 1);
      this.duetWidth = next.width;
      this.closeFloating();
      next.publish();
    }, animate);
  }

  /** The content frame: inset from the window, right of the sidebar (if docked), below the strip on Windows/Linux. */
  private layout(): void {
    if (this.window.isDestroyed()) return;
    const { width: windowWidth, height } = this.window.getContentBounds();
    const whole = { x: 0, y: 0, width: windowWidth, height };
    place(this.shell, whole);
    place(this.overlay, whole);
    const frame = this.frameRect();
    // The shell draws each pane's frame with the same math (DESIGN.md §7.9: 8 px gaps).
    const rects = this.paneRectsIn(frame);
    // While a frame snapshot's pictures move, the pages wait out of sight at the size they're going to be.
    const away = this.snapshots.active;
    this.panes.forEach((view, i) => {
      // The pane's rect in window pixels: the one place a page's rect leaves the layout's units (the shell's CSS pixels).
      const at = rects[i] ?? frame;
      if (this.pageFullScreen && view === this.tabView) place(view, whole);
      else place(view, away ? offscreen(at, whole) : at);
    });
    this.showPopover();
    const { width: pw, height: ph } = this.popoverSize;
    // With Peek open, the popover (find) hangs from its card's corner, below its header, over Peek's page.
    if (this.peek) {
      const page = this.peekPageRect();
      place(this.popover, { x: Math.max(page.x, page.x + page.width - pw), y: page.y, width: pw, height: ph });
      if (this.peekView && this.window.contentView.children.includes(this.peekView)) place(this.peekView, page);
      send(this.overlay.webContents, 'peek:state', this.peekState());
      return;
    }
    // The popover (find, permission prompts) hangs from the focused pane's top-right corner; its cards carry their own margin.
    const pane = rects[this.focusedPane] ?? frame;
    place(this.popover, { x: Math.max(pane.x, pane.x + pane.width - pw), y: pane.y, width: pw, height: ph });
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
