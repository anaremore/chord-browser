/**
 * Developer tools in the window (DESIGN.md §7.15; ARCHITECTURE.md §9). Each
 * tab's DevTools are a view of Chord's own: the tab's page is pointed at it
 * (`setDevToolsWebContents`) and opens DevTools there in `detach` mode, so
 * the DevTools page fills its view and Chord places it. Docked, the window
 * lays it out beside the page (`AppWindow.layout`); popped out, it moves,
 * unreloaded, into a window of its own with a bar to dock it back.
 *
 * Why not Electron's own docking: the page's window has caption controls
 * over its content (WCO) on Windows and Linux, and Electron undocks DevTools
 * docked on the right there; its docked DevTools also live inside the page's
 * own view, where the frame snapshot can't picture them.
 *
 * Each tab keeps its own, open or closed; they close with its page (the tab
 * closing, sleeping, or loading again in other sign-ins). DevTools load in a
 * session of their own (`persist:chord-devtools`; a private window's, in
 * memory), never a profile's: what they fetch themselves (source maps) stays
 * out of your sign-ins, and a private window's out of the disk. Their own
 * preferences are Electron's, kept with the inspected page's session.
 */
import { hostOf, type DevtoolsPlace, type DevtoolsSettings, type NodeId } from '@chord/core';
import type { DevtoolsBar } from '@chord/ipc';
import { frameRadius, size } from '@chord/tokens';
import { BaseWindow, nativeTheme, screen, WebContentsView, type Rectangle, type Session, type WebContents } from 'electron';
import { send } from './ipc';
import { backgroundHex, miniWindowChromeOptions, onUiScale, platform, systemInfo, titleBarOverlay, trafficLightPosition, uiScale } from './platform';
import { createUiView } from './window';

export interface DevtoolsDeps {
  /** The tab's page, if it has one. */
  page(nodeId: NodeId): WebContents | undefined;
  /** The session the tab's DevTools load in: Chord's own for them, or a private window's in-memory one. */
  sessionFor(nodeId: NodeId): Session;
  uiSession: Session;
  settings(): DevtoolsSettings;
  /** Remember a choice for the next DevTools (the side, a window or not). */
  remember(patch: Partial<DevtoolsSettings>): void;
  /** A tab's DevTools opened, closed, popped out or docked: the windows showing it lay out again. */
  changed(nodeId: NodeId, place: DevtoolsPlace | null): void;
  /** The window showing the tab, to open a DevTools window near. */
  nearBounds(nodeId: NodeId): Rectangle | undefined;
  /** Keys and focus for DevTools and their bar, as Chord's other views have. */
  wire(contents: WebContents, nodeId: NodeId): void;
  /** A link DevTools asked to open (an address in the console): a new tab beside the inspected one. */
  openUrl(nodeId: NodeId, url: string): void;
  /** Docking from a DevTools window: the tab comes forward in its window, so they show. */
  reveal(nodeId: NodeId): void;
}

interface Entry {
  nodeId: NodeId;
  page: WebContents;
  view: WebContentsView;
  place: DevtoolsPlace;
  window: DevtoolsWindow | null;
  unwatch(): void;
}

/** A DevTools window's size, and how far from the tab's window it opens. */
const WINDOW_SIZE = { width: 960, height: 640 } as const;
const WINDOW_OFFSET = 48;
const WAYLAND = platform === 'linux' && (process.env['XDG_SESSION_TYPE'] === 'wayland' || Boolean(process.env['WAYLAND_DISPLAY']));

/** ⌘⇧D / Ctrl+Shift+D inside DevTools: pop them out, or dock them (Chrome's key for it). */
export function isToggleKey(input: Pick<Electron.Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>, os = platform): boolean {
  const mod = os === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  // By position, as Chord's shortcuts go with a modifier down: D on any layout.
  return input.type === 'keyDown' && mod && input.shift && !input.alt && (input.code === 'KeyD' || input.key.toLowerCase() === 'd');
}

/**
 * A tab's DevTools in a window of their own: a 36 px bar (the tab's site,
 * and Dock in the window) above them. The OS's caption controls close it,
 * and the DevTools with it.
 */
class DevtoolsWindow {
  readonly window: BaseWindow;
  readonly bar: WebContentsView;
  /** Their DevTools left for the tab's window: closing this one doesn't close them. */
  private released = false;

  constructor(
    private readonly entry: Entry,
    private readonly deps: DevtoolsDeps,
    private readonly onClosed: () => void,
    onToggle: () => void,
  ) {
    const near = deps.nearBounds(entry.nodeId);
    this.window = new BaseWindow({
      ...WINDOW_SIZE,
      ...this.position(near),
      minWidth: 480,
      minHeight: 320,
      title: this.title(),
      show: false,
      ...miniWindowChromeOptions(),
    });
    this.bar = createUiView(deps.uiSession, 'devtools');
    deps.wire(this.bar.webContents, entry.nodeId);
    // ⌘⇧D / Ctrl+Shift+D docks them from the bar too.
    this.bar.webContents.on('before-input-event', (event, input) => {
      if (!isToggleKey(input)) return;
      event.preventDefault();
      onToggle();
    });
    entry.view.setBorderRadius(0);
    this.window.contentView.addChildView(entry.view);
    this.window.contentView.addChildView(this.bar);
    this.layout();
    this.window.on('resize', () => this.layout());
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
      if (!this.bar.webContents.isDestroyed()) this.bar.webContents.close();
      if (!this.released) this.onClosed();
    });
    this.bar.webContents.once('did-finish-load', () => {
      if (this.window.isDestroyed()) return;
      this.push();
      this.window.show();
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.focus();
    });
  }

  /** Down and right of the tab's window, on its display; on Wayland the compositor decides. */
  private position(near: Rectangle | undefined): { x?: number; y?: number } {
    if (WAYLAND || !near) return {};
    const area = screen.getDisplayMatching(near).workArea;
    const x = Math.min(near.x + WINDOW_OFFSET, area.x + Math.max(0, area.width - WINDOW_SIZE.width));
    const y = Math.min(near.y + WINDOW_OFFSET, area.y + Math.max(0, area.height - WINDOW_SIZE.height));
    return { x: Math.max(area.x, x), y: Math.max(area.y, y) };
  }

  private title(): string {
    const host = this.entry.page.isDestroyed() ? null : hostOf(this.entry.page.getURL());
    return host ? `Developer tools – ${host}` : 'Developer tools';
  }

  private layout(): void {
    if (this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    const bar = Math.round(size.miniBar * uiScale());
    this.bar.setBounds({ x: 0, y: 0, width, height: bar });
    if (this.window.contentView.children.includes(this.entry.view)) this.entry.view.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
  }

  /** The page moved on: the bar and the title follow. */
  push(): void {
    if (this.window.isDestroyed()) return;
    this.window.setTitle(this.title());
    send(this.bar.webContents, 'devtools:bar', barState(this.entry.page, this.deps.settings()));
  }

  /** Let their DevTools go (docking, or closing them), then close. */
  release(): void {
    this.released = true;
    if (this.window.isDestroyed()) return;
    if (this.window.contentView.children.includes(this.entry.view)) this.window.contentView.removeChildView(this.entry.view);
    this.window.close();
  }
}

function barState(page: WebContents, settings: DevtoolsSettings): DevtoolsBar {
  const url = page.isDestroyed() ? '' : page.getURL();
  return { host: hostOf(url) ?? url, title: page.isDestroyed() ? '' : page.getTitle(), side: settings.side };
}

export class DevTools {
  private readonly open = new Map<NodeId, Entry>();

  constructor(private readonly deps: DevtoolsDeps) {}

  /** Where a tab's DevTools are, if they're open. */
  placeOf(nodeId: NodeId): DevtoolsPlace | null {
    return this.open.get(nodeId)?.place ?? null;
  }

  /** A tab's DevTools while they're docked: the window lays them out beside its page. */
  dockedView(nodeId: NodeId): WebContentsView | null {
    const entry = this.open.get(nodeId);
    return entry?.place === 'docked' ? entry.view : null;
  }

  /** The tab whose DevTools (or DevTools window's bar) this is. */
  nodeOf(contents: WebContents): NodeId | undefined {
    for (const entry of this.open.values()) if (entry.view.webContents === contents || entry.window?.bar.webContents === contents) return entry.nodeId;
    return undefined;
  }

  /** The tab whose DevTools window has this bar. */
  nodeOfBar(contents: WebContents): NodeId | undefined {
    for (const entry of this.open.values()) if (entry.window?.bar.webContents === contents) return entry.nodeId;
    return undefined;
  }

  /** What a DevTools window's bar shows. */
  barFor(contents: WebContents): DevtoolsBar {
    const entry = this.open.get(this.nodeOfBar(contents) ?? '');
    return entry ? barState(entry.page, this.deps.settings()) : { host: '', title: '', side: this.deps.settings().side };
  }

  /** Open them, or close them if they're open (F12). */
  toggle(nodeId: NodeId): void {
    if (this.open.has(nodeId)) this.close(nodeId);
    else this.show(nodeId);
  }

  /** Open a tab's DevTools (docked, or in a window, as last chosen), or bring them forward. */
  show(nodeId: NodeId, place: DevtoolsPlace = this.deps.settings().window ? 'window' : 'docked'): boolean {
    const existing = this.open.get(nodeId);
    if (existing) {
      this.focus(existing);
      return true;
    }
    const page = this.deps.page(nodeId);
    if (!page || page.isDestroyed()) return false;
    // Electron's own DevTools (opened while the page was Peek's): DevTools can only show in one place.
    if (page.isDevToolsOpened()) page.closeDevTools();
    const view = new WebContentsView({
      webPreferences: { session: this.deps.sessionFor(nodeId), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    });
    // Chord's own background while DevTools load, rather than white.
    view.setBackgroundColor(backgroundHex());
    view.setBorderRadius(frameRadius[platform]);
    const contents = view.webContents;
    // DevTools never leave DevTools or open windows; links they open come through the page (devtools-open-url).
    contents.on('will-navigate', (event) => {
      if (!event.url.startsWith('devtools://')) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Before they've navigated anywhere (Electron's rule): the page loads DevTools into this view.
    page.setDevToolsWebContents(contents);
    page.openDevTools({ mode: 'detach', activate: false });
    const entry: Entry = { nodeId, page, view, place, window: null, unwatch: () => {} };
    entry.unwatch = this.watch(entry);
    this.open.set(nodeId, entry);
    this.deps.wire(contents, nodeId);
    if (place === 'window') entry.window = this.windowFor(entry);
    this.deps.changed(nodeId, place);
    this.focus(entry);
    return true;
  }

  /** Close a tab's DevTools: their view goes, and their window if they have one. */
  close(nodeId: NodeId): void {
    const entry = this.open.get(nodeId);
    if (!entry) return;
    this.open.delete(nodeId);
    entry.unwatch();
    entry.window?.release();
    entry.window = null;
    // Out of the window that showed them first, then gone.
    this.deps.changed(nodeId, null);
    if (!entry.page.isDestroyed()) entry.page.closeDevTools();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  /** Into a window of their own, as they are (nothing reloads); the next ones open there too. */
  popOut(nodeId: NodeId): void {
    const entry = this.open.get(nodeId);
    if (!entry || entry.place === 'window') return;
    entry.place = 'window';
    // Out of the tab's window first: a view has one parent.
    this.deps.changed(nodeId, 'window');
    entry.window = this.windowFor(entry);
    this.deps.remember({ window: true });
  }

  /** Back beside the page, as they are; the next ones open docked too. `reveal`: bring the tab forward so they show. */
  dock(nodeId: NodeId, reveal = false): void {
    const entry = this.open.get(nodeId);
    if (!entry || entry.place === 'docked') return;
    entry.place = 'docked';
    const window = entry.window;
    entry.window = null;
    window?.release();
    entry.view.setBorderRadius(frameRadius[platform]);
    this.deps.remember({ window: false });
    if (reveal) this.deps.reveal(nodeId);
    this.deps.changed(nodeId, 'docked');
    this.focus(entry);
  }

  /** ⌘⇧D / Ctrl+Shift+D, or Pop out and Dock: whichever they aren't. */
  toggleWindow(nodeId: NodeId, reveal = false): void {
    const place = this.placeOf(nodeId);
    if (place === 'docked') this.popOut(nodeId);
    else if (place === 'window') this.dock(nodeId, reveal);
  }

  /** Inspect: the element at a point in the page, with DevTools open (and opened, if they weren't). */
  inspect(nodeId: NodeId, x: number, y: number): void {
    if (!this.show(nodeId)) return;
    const entry = this.open.get(nodeId)!;
    if (!entry.page.isDestroyed()) entry.page.inspectElement(x, y);
    this.focus(entry);
  }

  /** Every DevTools window's bar says which side docking puts them on. */
  settingsChanged(): void {
    for (const entry of this.open.values()) entry.window?.push();
  }

  private focus(entry: Entry): void {
    if (entry.view.webContents.isDestroyed()) return;
    if (entry.window && !entry.window.window.isDestroyed()) entry.window.window.focus();
    entry.view.webContents.focus();
  }

  private windowFor(entry: Entry): DevtoolsWindow {
    return new DevtoolsWindow(
      entry,
      this.deps,
      () => {
        // Closed with the OS's caption control: the DevTools close with it.
        if (this.open.get(entry.nodeId) === entry) {
          entry.window = null;
          this.close(entry.nodeId);
        }
      },
      () => this.dock(entry.nodeId, true),
    );
  }

  /** What ends a tab's DevTools (their page going, their own renderer failing), and what they ask of Chord. */
  private watch(entry: Entry): () => void {
    const { page, nodeId } = entry;
    const contents = entry.view.webContents;
    const gone = () => {
      if (this.open.get(nodeId) === entry) this.close(nodeId);
    };
    const failed = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      if (details.reason !== 'clean-exit') gone();
    };
    const openUrl = (_event: Electron.Event, url: string) => this.deps.openUrl(nodeId, url);
    const moved = () => entry.window?.push();
    const toggle = (event: Electron.Event, input: Electron.Input) => {
      if (!isToggleKey(input)) return;
      event.preventDefault();
      this.toggleWindow(nodeId, true);
    };
    page.once('destroyed', gone);
    page.on('devtools-open-url', openUrl);
    page.on('page-title-updated', moved);
    page.on('did-navigate', moved);
    page.on('did-navigate-in-page', moved);
    contents.once('destroyed', gone);
    contents.on('render-process-gone', failed);
    contents.on('before-input-event', toggle);
    return () => {
      page.off('destroyed', gone);
      page.off('devtools-open-url', openUrl);
      page.off('page-title-updated', moved);
      page.off('did-navigate', moved);
      page.off('did-navigate-in-page', moved);
      if (contents.isDestroyed()) return;
      contents.off('destroyed', gone);
      contents.off('render-process-gone', failed);
      contents.off('before-input-event', toggle);
    };
  }
}
