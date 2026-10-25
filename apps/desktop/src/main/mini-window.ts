/**
 * Mini windows (DESIGN.md §7.9): a link another app hands Chord opens in a
 * small window of its own, not a tab you have to go find. Its 36 px bar shows
 * the site, copy link and **Open in ▾ [chord]** (⌘↵); the OS's own caption
 * controls close it, as they do Chord's other windows. "Open in" moves the page into the chord's Today, page and history
 * intact, and the mini window fades away.
 *
 * Each link gets its own mini window, cascaded. It remembers the size you
 * last gave one. On Wayland the compositor places it.
 */
import { hostOf, uuidv7, type ChordId, type NodeId, type State } from '@chord/core';
import type { MiniState, Rect } from '@chord/ipc';
import { size } from '@chord/tokens';
import { BaseWindow, clipboard, Menu, nativeTheme, screen, type Session, type WebContents, type WebContentsView } from 'electron';
import { send } from './ipc';
import { miniWindowChromeOptions, onUiScale, platform, systemInfo, titleBarOverlay, trafficLightPosition, uiScale } from './platform';
import type { TabManager } from './tabs';
import { createUiView } from './window';

export interface MiniDeps {
  state(): State;
  tabs: TabManager;
  uiSession: Session;
  /** The session of a chord's sign-ins. */
  sessionFor(chordId: ChordId): Session;
  /** Where "Open in" points at first: the chord of the normal window used last. */
  defaultChord(): ChordId | null;
  /** Chords "Open in ▾" offers (never a private window's). */
  chords(): { id: ChordId; name: string; icon: string }[];
  /** Move the page into `chordId` (Browser picks the window). */
  promote(nodeId: NodeId, chordId: ChordId, page: WebContents): void;
  /** The mini window's size changed: remember it for the next one. */
  rememberSize(width: number, height: number): void;
  /** Keys and right-click for the bar, as Chord's other views have. */
  wire(bar: WebContents): void;
}

/** How long promoting takes to fade the window out. */
const FADE_MS = 140;
/** Each further mini window opens this far down and right. */
const CASCADE = 24;
const WAYLAND = platform === 'linux' && (process.env['XDG_SESSION_TYPE'] === 'wayland' || Boolean(process.env['WAYLAND_DISPLAY']));

class MiniWindow {
  readonly window: BaseWindow;
  readonly bar: WebContentsView;
  readonly page: WebContentsView;
  /** "Open in": the chord the page moves to. */
  target: ChordId | null;
  /** Its page has gone to a chord; the window is fading out. */
  promoted = false;
  /** The page is in HTML fullscreen (a video): it covers the bar too. */
  private fullScreen = false;
  private sizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly nodeId: NodeId,
    url: string,
    private readonly deps: MiniDeps,
    index: number,
    private readonly onClosed: (mini: MiniWindow) => void,
  ) {
    this.target = deps.defaultChord();
    const remembered = deps.state().settings.miniWindowSize;
    const width = remembered?.width ?? size.miniWidth;
    const height = remembered?.height ?? size.miniHeight;
    this.window = new BaseWindow({
      width,
      height,
      ...this.position(width, height, index),
      minWidth: 420,
      minHeight: 320,
      title: hostOf(url) ?? 'Chord',
      show: false,
      ...miniWindowChromeOptions(),
    });
    this.bar = createUiView(deps.uiSession, 'mini');
    deps.wire(this.bar.webContents);
    this.page = deps.tabs.createFloating(nodeId, { session: this.sessionForTarget(), url, private: false });
    this.page.setBorderRadius(0);
    this.window.contentView.addChildView(this.page);
    this.window.contentView.addChildView(this.bar);
    this.layout();

    const contents = this.page.webContents;
    const push = () => this.push();
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(event as 'did-navigate', push);
    }
    contents.on('page-title-updated', (_event, title) => {
      if (!this.window.isDestroyed()) this.window.setTitle(title || hostOf(contents.getURL()) || 'Chord');
    });
    contents.on('enter-html-full-screen', () => this.setFullScreen(true));
    contents.on('leave-html-full-screen', () => this.setFullScreen(false));
    this.window.on('resize', () => {
      this.layout();
      clearTimeout(this.sizeTimer);
      this.sizeTimer = setTimeout(() => {
        if (this.window.isDestroyed() || this.window.isMaximized() || this.window.isFullScreen()) return;
        const [w, h] = this.window.getSize();
        if (w && h) deps.rememberSize(w, h);
      }, 400);
    });
    const onTheme = () => send(this.bar.webContents, 'system:changed', systemInfo());
    nativeTheme.on('updated', onTheme);
    const stopScale = onUiScale(() => {
      if (this.window.isDestroyed()) return;
      if (platform === 'darwin') this.window.setWindowButtonPosition(trafficLightPosition(size.miniBar, 12));
      else this.window.setTitleBarOverlay?.(titleBarOverlay(null, size.miniBar));
      onTheme();
      this.layout();
    });
    this.window.on('closed', () => {
      stopScale();
      nativeTheme.off('updated', onTheme);
      clearTimeout(this.sizeTimer);
      if (!this.bar.webContents.isDestroyed()) this.bar.webContents.close();
      this.onClosed(this);
    });
    this.bar.webContents.once('did-finish-load', () => {
      if (this.window.isDestroyed()) return;
      this.push();
      this.window.show();
      contents.focus();
    });
  }

  /** Centered on the display you're using, cascaded; on Wayland the compositor decides. */
  private position(width: number, height: number, index: number): { x?: number; y?: number } {
    if (WAYLAND) return {};
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const offset = (index % 8) * CASCADE;
    return {
      x: Math.round(area.x + Math.max(0, (area.width - width) / 2) + offset),
      y: Math.round(area.y + Math.max(0, (area.height - height) / 2) + offset),
    };
  }

  /** The page loads with the sign-ins of the chord it would go to, so promoting keeps them. */
  private sessionForTarget(): Session {
    return this.deps.sessionFor(this.target ?? this.deps.chords()[0]?.id ?? '');
  }

  private setFullScreen(on: boolean): void {
    this.fullScreen = on;
    this.bar.setVisible(!on);
    this.layout();
  }

  private layout(): void {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    const bar = Math.round(size.miniBar * uiScale());
    const top = this.fullScreen ? 0 : bar;
    this.bar.setBounds({ x: 0, y: 0, width, height: bar });
    this.page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  state(): MiniState {
    const contents = this.page.webContents;
    const url = contents.isDestroyed() ? '' : contents.getURL();
    const chord = this.target ? this.deps.state().chords[this.target] : undefined;
    return {
      url,
      host: hostOf(url) ?? '',
      title: contents.isDestroyed() ? '' : contents.getTitle(),
      secure: url.startsWith('https:'),
      loading: !contents.isDestroyed() && contents.isLoading(),
      target: chord && !chord.private ? { id: chord.id, name: chord.name, icon: chord.icon } : null,
    };
  }

  push(): void {
    if (!this.bar.webContents.isDestroyed()) send(this.bar.webContents, 'mini:state', this.state());
  }

  /** Fade out (where the OS can), then close. */
  fadeAndClose(): void {
    if (this.window.isDestroyed()) return;
    if (platform === 'linux') return this.window.close();
    const start = performance.now();
    const timer = setInterval(() => {
      if (this.window.isDestroyed()) return clearInterval(timer);
      const k = Math.min(1, (performance.now() - start) / FADE_MS);
      this.window.setOpacity(1 - k);
      if (k >= 1) {
        clearInterval(timer);
        this.window.close();
      }
    }, 16);
  }
}

export class MiniWindows {
  private readonly open = new Map<NodeId, MiniWindow>();

  constructor(private readonly deps: MiniDeps) {}

  get count(): number {
    return this.open.size;
  }

  /** Open a link from another app in a mini window of its own. */
  show(url: string): void {
    const nodeId = uuidv7();
    const mini = new MiniWindow(nodeId, url, this.deps, this.open.size, (closed) => {
      this.open.delete(closed.nodeId);
      // Closed without "Open in": the page goes. (Promoted, it's a tab by now and this does nothing.)
      this.deps.tabs.closeFloating(closed.nodeId);
    });
    this.open.set(nodeId, mini);
    // ⌘↵ / Ctrl+Enter: "Open in", as in Peek.
    for (const contents of [mini.page.webContents, mini.bar.webContents]) {
      contents.on('before-input-event', (event, input) => {
        const command = platform === 'darwin' ? input.meta : input.control;
        if (input.type !== 'keyDown' || input.key !== 'Enter' || !command || input.alt || input.shift) return;
        event.preventDefault();
        this.promote(contents);
      });
    }
  }

  /** The mini window this contents belongs to: its bar, or its page. */
  forContents(contents: WebContents): MiniWindow | undefined {
    for (const mini of this.open.values()) {
      if (mini.bar.webContents === contents || mini.page.webContents === contents) return mini;
    }
    return undefined;
  }

  has(nodeId: NodeId): boolean {
    return this.open.has(nodeId);
  }

  /** The OS window of the mini window this contents is in. */
  windowFor(contents: WebContents): BaseWindow | undefined {
    return this.forContents(contents)?.window;
  }

  stateFor(contents: WebContents): MiniState | null {
    return this.forContents(contents)?.state() ?? null;
  }

  /** "Open in": the page moves into the chord as a tab, and the mini window fades away. */
  promote(contents: WebContents, chordId?: ChordId): void {
    const mini = this.forContents(contents);
    const target = chordId ?? mini?.target;
    if (!mini || !target || mini.promoted || mini.page.webContents.isDestroyed()) return;
    mini.promoted = true;
    // Out of the mini window first: a view has one parent, and the tab's window takes it next.
    if (!mini.window.isDestroyed()) mini.window.contentView.removeChildView(mini.page);
    this.deps.promote(mini.nodeId, target, mini.page.webContents);
    mini.fadeAndClose();
  }

  /** "Open in ▾": the chords, below the button; picking one moves the page there. */
  chooseChord(contents: WebContents, anchor: Rect): void {
    const mini = this.forContents(contents);
    if (!mini || mini.window.isDestroyed()) return;
    const menu = Menu.buildFromTemplate(
      this.deps.chords().map((chord) => ({
        label: `${chord.icon}  ${chord.name}`,
        type: 'radio' as const,
        checked: chord.id === mini.target,
        click: () => this.promote(contents, chord.id),
      })),
    );
    const s = uiScale();
    menu.popup({ window: mini.window, x: Math.round(anchor.x * s), y: Math.round((anchor.y + anchor.height + 4) * s) });
  }

  copyLink(contents: WebContents): void {
    const url = this.forContents(contents)?.state().url;
    if (url) clipboard.writeText(url);
  }

  /** A shortcut pressed in a mini window: the few that make sense there. Returns whether it was handled. */
  run(action: string, contents: WebContents): boolean {
    const mini = this.forContents(contents);
    if (!mini) return false;
    const page = mini.page.webContents;
    if (page.isDestroyed()) return false;
    switch (action) {
      case 'tab.close':
      case 'window.close':
        mini.window.close();
        return true;
      case 'nav.back':
        if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
        return true;
      case 'nav.forward':
        if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
        return true;
      case 'nav.reload':
        page.reload();
        return true;
      case 'nav.hardReload':
        page.reloadIgnoringCache();
        return true;
      case 'address.copy':
        clipboard.writeText(page.getURL());
        return true;
      case 'page.print':
        page.print();
        return true;
      case 'app.devtools':
        // The page's own developer tools, popped out in a window of Electron's own (DESIGN.md §7.15).
        if (page.isDevToolsOpened()) page.closeDevTools();
        else page.openDevTools({ mode: 'detach' });
        return true;
      default:
        return false;
    }
  }

  /** A chord changed name or went away: bars show the new "Open in". */
  refresh(): void {
    for (const mini of this.open.values()) {
      const chords = this.deps.chords();
      if (mini.target && !chords.some((c) => c.id === mini.target)) mini.target = this.deps.defaultChord();
      mini.push();
    }
  }

  closeAll(): void {
    for (const mini of [...this.open.values()]) if (!mini.window.isDestroyed()) mini.window.close();
  }
}
