/**
 * One Chord window (ARCHITECTURE.md §5). Views, bottom to top:
 *   shell    Chord's UI, full window, transparent
 *   tabs     the active tab, or 2–4 split panes, inset and rounded (from index 1)
 *   popover  find bar and permission prompts: sized to its cards, at the frame's top-right
 *   preview  a pinned tab's or folder's hover preview, beside the sidebar (DESIGN.md §7.6)
 *   floating an extension's popup, under its button (at most one)
 *   overlay  the command bar: always loaded, hidden until ⌘T / ⌘L
 */
import { join } from 'node:path';
import { paneRects, type Bounds, type SplitDirection, type WindowId, type WindowModel } from '@chord/core';
import type { OverlayOpenEvent, Rect, Role } from '@chord/ipc';
import { frameRadius, size, space, springCurve, springs } from '@chord/tokens';
import { BaseWindow, WebContentsView, nativeTheme, type Menu, type Session, type WebContents } from 'electron';
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
/** The hover preview glides between rows on `snappy` (DESIGN.md §7.6). */
const PREVIEW_SPRING = springCurve(springs.snappy);
/** The preview page pads its card so the whole shadow shows (more below); the card's own edge sits this far in. */
const PREVIEW_PAD = space[6];

/** How split panes share the content frame (DESIGN.md §7.9). */
export interface PaneLayout {
  direction: SplitDirection;
  sizes: number[];
}

export type UiSurface = 'shell' | 'overlay' | 'popover' | 'preview' | 'settings' | 'archive';

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
  private overlaySeq = 0;
  /** The command bar listens only once it has started; an opening asked for before that waits here. */
  private overlayReady = false;
  private pendingOpen: { mode: OverlayOpenEvent['mode']; url: string; anchor: Rect | null } | null = null;
  readonly isPrivate: boolean;
  private origin: FrameOrigin;
  private frameAnimation: ReturnType<typeof setInterval> | undefined;
  /** Minimal mode's peek: the shell sits above the page so the sidebar can float over it. */
  private peeking = false;
  /** A tab is being dragged from the sidebar: the shell sits above the pages to show split drop zones. */
  private lifted = false;
  /** The page is in HTML fullscreen (a video): it covers the whole window, above Chord's own views. */
  private pageFullScreen = false;
  private floating: FloatingView | null = null;
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
    this.preview = createUiView(uiSession, 'preview');
    this.preview.setVisible(false);
    this.overlay = createUiView(uiSession, 'overlay');
    this.overlay.setVisible(false);
    // Tab views go in at index 1, between the shell and the popover.
    this.window.contentView.addChildView(this.shell);
    this.window.contentView.addChildView(this.popover);
    this.window.contentView.addChildView(this.preview);
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
      this.hidePreview();
      this.layout();
      reportBounds();
    });
    this.window.on('move', reportBounds);
    this.window.on('maximize', reportBounds);
    this.window.on('unmaximize', reportBounds);

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay(forced));
      for (const view of [this.shell, this.popover, this.preview, this.overlay]) send(view.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      this.closeFloating();
      nativeTheme.off('updated', onTheme);
      clearTimeout(boundsTimer);
      clearInterval(this.frameAnimation);
      clearInterval(this.previewAnimation);
      for (const view of [this.shell, this.popover, this.preview, this.overlay]) if (!view.webContents.isDestroyed()) view.webContents.close();
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
    this.hiddenPanes = new Set(this.panes.filter((v) => hidden.has(v.webContents)));
    for (const view of this.panes) view.setVisible(!this.hiddenPanes.has(view));
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

  /** `anchor` places the downloads panel by its button; ⌘L uses the address the shell reported. */
  openOverlay(mode: OverlayOpenEvent['mode'], url: string, anchor: Rect | null = null): void {
    this.closeFloating();
    this.hidePreview();
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
    this.hidePreview();
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
    const frame = { x, y, width: Math.max(0, width - x - inset), height: Math.max(0, height - y - inset) };
    // The shell draws each pane's frame with the same math (DESIGN.md §7.9: 8 px gaps).
    const rects = this.paneLayout && this.panes.length > 1 ? paneRects(frame, this.paneLayout.direction, this.paneLayout.sizes) : [frame];
    this.panes.forEach((view, i) => {
      if (this.pageFullScreen && view === this.tabView) view.setBounds({ x: 0, y: 0, width: windowWidth, height });
      else view.setBounds(rects[i] ?? frame);
    });
    // The popover (find, permission prompts) hangs from the focused pane's top-right corner; its cards carry their own margin.
    const pane = rects[this.focusedPane] ?? frame;
    const { width: pw, height: ph } = this.popoverSize;
    this.popover.setBounds({ x: Math.max(pane.x, pane.x + pane.width - pw), y: pane.y, width: pw, height: ph });
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
