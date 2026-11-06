/**
 * Chord Player's window (DESIGN.md §7.14; spike S14's approach (a)): a
 * frameless window of its own with a 40 px bar in the colors of the chord it
 * came from (the service's name and *Back to Chord*, the OS's own window
 * controls), and the service's page below. Moving, resizing, fullscreen,
 * Spaces and picture-in-picture are the OS's and Chromium's own.
 *
 * Docked (Windows; S14's approach (b)): the page moves to a second,
 * borderless window that Chord places over the tab's content area and makes
 * its own window's owned window (so it stays above Chord, minimizes with it,
 * and stays out of Alt+Tab and the taskbar). The window of its own hides
 * meanwhile; undocking brings the page back to it.
 */
import { MAX_STILL_CHARS, roundedShape, type Rect, type Theme } from '@chord/player-protocol';
import { size } from '@chord/tokens';
import { BaseWindow, ipcMain, nativeTheme, screen, WebContentsView, type Session } from 'electron';
import { join } from 'node:path';

export const BAR_HEIGHT = size.playerBar;
/** Room the window controls take in the bar (Chord's own numbers, apps/desktop/src/main/platform.ts). */
const CONTROLS = { win32: { side: 'right', width: 3 * 46 }, linux: { side: 'right', width: 120 }, darwin: { side: 'left', width: 76 } } as const;

export type BarStatus = 'starting' | 'cdm' | 'ready' | 'failed';

/** What the bar shows. */
export interface BarState {
  service: string;
  status: BarStatus;
  theme: Theme | null;
  appearance: 'light' | 'dark';
  controls: { side: 'left' | 'right'; width: number };
  platform: NodeJS.Platform;
}

/** Light and dark backgrounds until Chord sends the chord's colors (DESIGN.md §4.5's window backgrounds). */
const FALLBACK = { light: '#f4f2f7', dark: '#1d1b22' } as const;
const SYMBOLS = { light: '#3a3a3a', dark: '#f4f4f4' } as const;

export interface WindowDeps {
  session: Session;
  uiSession: Session;
  preload: string;
  /** The bar's page (chord-player://bar/…, bar-protocol.ts). */
  barUrl: string;
  onBack(): void;
  onClosed(): void;
}

export class PlayerWindow {
  readonly window: BaseWindow;
  readonly bar: WebContentsView;
  readonly page: WebContentsView;
  private fullScreen = false;
  private state: BarState;
  private barReady = false;
  /** Docked: the borderless window over Chord's tab, and where Chord last said it goes (null: hidden). */
  private docked: BaseWindow | null = null;
  private dockBounds: Rect | null = null;
  /** The docked window's corners, as Chord rounds the frame, and the shape last set for them. */
  private dockRadius = 0;
  private shaped = '';

  constructor(private readonly deps: WindowDeps) {
    const platform = process.platform;
    const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    this.state = { service: '', status: 'starting', theme: null, appearance, controls: CONTROLS[platform as keyof typeof CONTROLS] ?? CONTROLS.linux, platform };
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1280, Math.round(area.width * 0.9));
    const height = Math.min(820, Math.round(area.height * 0.9));
    this.window = new BaseWindow({
      width,
      height,
      minWidth: 480,
      minHeight: 320,
      title: 'Chord Player',
      show: false,
      backgroundColor: FALLBACK[appearance],
      titleBarStyle: 'hidden',
      ...(platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: Math.round((BAR_HEIGHT - 12) / 2) } }
        : { titleBarOverlay: { color: '#00000000', symbolColor: SYMBOLS[appearance], height: BAR_HEIGHT } }),
    });
    this.bar = new WebContentsView({ webPreferences: { session: deps.uiSession, preload: deps.preload, sandbox: true, contextIsolation: true, spellcheck: false } });
    this.bar.setBackgroundColor('#00000000');
    this.page = new WebContentsView({ webPreferences: { session: deps.session, sandbox: true, contextIsolation: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' } });
    this.page.setBackgroundColor('#000000');
    this.window.contentView.addChildView(this.page);
    this.window.contentView.addChildView(this.bar);
    this.layout();
    this.window.on('resize', () => this.layout());
    this.window.on('closed', () => {
      if (this.docked && !this.docked.isDestroyed()) this.docked.destroy();
      for (const view of [this.bar, this.page]) if (!view.webContents.isDestroyed()) view.webContents.close();
      deps.onClosed();
    });

    // The bar: only its own page, and only its two messages.
    const bar = this.bar.webContents;
    bar.on('will-navigate', (event) => event.preventDefault());
    bar.setWindowOpenHandler(() => ({ action: 'deny' }));
    ipcMain.on('bar:ready', (event) => {
      if (event.sender !== bar) return;
      this.barReady = true;
      this.push();
    });
    ipcMain.on('bar:back', (event) => {
      if (event.sender === bar) deps.onBack();
    });
    void bar.loadURL(deps.barUrl);

    // A page going fullscreen (a video) covers the bar; leaving brings it back. Electron makes the window fullscreen itself.
    this.page.webContents.on('enter-html-full-screen', () => {
      this.fullScreen = true;
      // Docked, the rounded corners would cut the screen's: square again until it leaves.
      if (this.isDocked && this.shaped) {
        this.shaped = '';
        this.docked!.setShape([]);
      }
      this.layout();
    });
    this.page.webContents.on('leave-html-full-screen', () => {
      this.fullScreen = false;
      this.layout();
      // Back from fullscreen, docked: where the tab is now (Chord may have moved it meanwhile).
      if (this.isDocked) this.placeDocked();
    });
    nativeTheme.on('updated', () => {
      if (this.state.theme) return;
      this.setAppearance(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    });
  }

  get destroyed(): boolean {
    return this.window.isDestroyed();
  }

  private layout(): void {
    if (this.window.isDestroyed()) return;
    if (this.isDocked) {
      // Docked, the page is the whole window: Chord's tab around it is the bar.
      const { width, height } = this.docked!.getContentBounds();
      this.page.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    const { width, height } = this.window.getContentBounds();
    if (this.fullScreen) {
      this.bar.setVisible(false);
      this.page.setBounds({ x: 0, y: 0, width, height });
    } else {
      this.bar.setVisible(true);
      this.bar.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
      this.page.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
    }
  }

  update(change: Partial<Pick<BarState, 'service' | 'status'>>): void {
    this.state = { ...this.state, ...change };
    // The taskbar, Alt+Tab and the Dock's window list name it by its service.
    if (change.service && !this.window.isDestroyed()) this.window.setTitle(`${change.service} · Chord Player`);
    this.push();
  }

  /** The chord's colors: the bar takes them, and the window's background and controls follow. */
  setTheme(theme: Theme): void {
    this.state = { ...this.state, theme };
    this.setAppearance(theme.appearance);
  }

  private setAppearance(appearance: 'light' | 'dark'): void {
    this.state = { ...this.state, appearance };
    if (!this.window.isDestroyed()) {
      this.window.setBackgroundColor(FALLBACK[appearance]);
      if (process.platform !== 'darwin') this.window.setTitleBarOverlay({ color: '#00000000', symbolColor: SYMBOLS[appearance], height: BAR_HEIGHT });
    }
    this.push();
  }

  get barState(): BarState {
    return this.state;
  }

  private push(): void {
    const bar = this.bar.webContents;
    if (this.barReady && !bar.isDestroyed()) bar.send('bar:state', this.state);
  }

  get isDocked(): boolean {
    return Boolean(this.docked && !this.docked.isDestroyed() && this.docked.contentView.children.includes(this.page));
  }

  /**
   * Docked over Chord's tab at `bounds` (screen DIPs), or hidden there (null).
   * The page moves into the docked window the first time, playing on. Returns
   * the docked window's HWND, for Chord to make it its own window's owned window.
   */
  dock(bounds: Rect | null, radius = 0): string {
    const docked = this.dockedWindow();
    if (!this.isDocked) {
      this.window.contentView.removeChildView(this.page);
      docked.contentView.addChildView(this.page);
      this.window.hide();
    }
    this.dockBounds = bounds;
    this.dockRadius = radius;
    this.placeDocked();
    return docked.getNativeWindowHandle().readBigUInt64LE(0).toString();
  }

  /** Tests: whether it's docked, and the docked window's place on screen and visibility. */
  dockState(): { docked: boolean; visible: boolean; bounds: Rect | null; ownWindowVisible: boolean } {
    const docked = this.docked && !this.docked.isDestroyed() ? this.docked : null;
    return { docked: this.isDocked, visible: Boolean(docked?.isVisible()), bounds: docked ? docked.getBounds() : null, ownWindowVisible: !this.window.isDestroyed() && this.window.isVisible() };
  }

  /** Back to a window of its own, shown where it was (not brought forward: Chord stays in front). */
  undock(): void {
    if (!this.isDocked || this.window.isDestroyed()) return;
    const docked = this.docked!;
    if (docked.isFullScreen()) docked.setFullScreen(false);
    docked.contentView.removeChildView(this.page);
    docked.hide();
    this.dockBounds = null;
    this.window.contentView.addChildView(this.page, 0);
    this.layout();
    this.window.showInactive();
  }

  /** The docked window where Chord last said, or hidden; a fullscreen page stays fullscreen until it's hidden. */
  private placeDocked(): void {
    const docked = this.docked;
    if (!docked || docked.isDestroyed() || !this.isDocked) return;
    const bounds = this.dockBounds;
    if (!bounds) {
      if (docked.isFullScreen()) docked.setFullScreen(false);
      if (docked.isVisible()) docked.hide();
      return;
    }
    if (this.fullScreen || docked.isFullScreen()) return;
    const now = docked.getBounds();
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) docked.setBounds(bounds);
    this.layout();
    this.shapeDocked(bounds.width, bounds.height);
    // Shown without taking the keyboard: you click the video to use it, as a page in a tab.
    if (!docked.isVisible()) docked.showInactive();
  }

  /** Rounded corners, as the frame's under it (Windows; DIPs). Set again only when the size or radius changes. */
  private shapeDocked(width: number, height: number): void {
    const key = `${width}x${height}r${this.dockRadius}`;
    if (key === this.shaped || !this.docked || this.docked.isDestroyed()) return;
    this.shaped = key;
    this.docked.setShape(roundedShape(width, height, this.dockRadius));
  }

  private dockedWindow(): BaseWindow {
    if (this.docked && !this.docked.isDestroyed()) return this.docked;
    const docked = new BaseWindow({
      show: false,
      frame: false,
      // Chord's window owns it, which keeps it off the taskbar too; this keeps it off until then.
      skipTaskbar: true,
      thickFrame: false,
      hasShadow: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      backgroundColor: '#000000',
      title: this.window.getTitle(),
    });
    docked.on('resize', () => this.layout());
    // Alt+F4 in the docked page closes the player, as its own window's close button would.
    docked.on('close', (event) => {
      if (this.window.isDestroyed()) return;
      event.preventDefault();
      this.close();
    });
    this.docked = docked;
    return docked;
  }

  /**
   * A picture of the page, for Chord to show while the docked window hides
   * (something of Chord's covers the tab): a JPEG small enough for the channel.
   */
  async still(): Promise<string | null> {
    if (!this.isDocked || this.page.webContents.isDestroyed()) return null;
    try {
      const image = await this.page.webContents.capturePage();
      if (image.isEmpty()) return null;
      const size = image.getSize();
      for (const [width, quality] of [
        [1600, 70],
        [1100, 60],
        [700, 50],
      ] as const) {
        const scaled = size.width > width ? image.resize({ width, quality: 'good' }) : image;
        const data = `data:image/jpeg;base64,${scaled.toJPEG(quality).toString('base64')}`;
        if (data.length <= MAX_STILL_CHARS) return data;
      }
    } catch {
      // A page that can't be pictured: Chord shows its own placeholder instead.
    }
    return null;
  }

  /** Brings the window to the front, its page focused. */
  focus(): void {
    if (this.window.isDestroyed()) return;
    if (this.isDocked) {
      // Docked, it's where the tab is: shown only while the tab is, and above Chord's window, which owns it.
      if (this.docked!.isVisible()) {
        this.docked!.focus();
        this.page.webContents.focus();
      }
      return;
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    // Windows ignores focus() from an app that isn't in front (its foreground lock), and Chord is when you ask for
    // the player. Being on top a moment is allowed, so the window at least comes forward, even if Windows keeps the
    // keyboard where it was.
    if (process.platform === 'win32') {
      this.window.setAlwaysOnTop(true);
      this.window.setAlwaysOnTop(false);
    }
    this.window.focus();
    this.page.webContents.focus();
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.close();
  }

  /** The bar and the page as one picture (tests only: the player's own window). */
  async capture(): Promise<Buffer> {
    const { nativeImage } = await import('electron');
    const top = await this.bar.webContents.capturePage();
    const bottom = await this.page.webContents.capturePage();
    const a = top.getSize();
    const b = bottom.resize({ width: a.width }).getSize();
    const scaled = bottom.resize({ width: a.width });
    const buffer = Buffer.concat([top.toBitmap(), scaled.toBitmap()]);
    return nativeImage.createFromBitmap(buffer, { width: a.width, height: a.height + b.height }).toPNG();
  }
}

/** Where the bar's files are in the packaged app. */
export const barFiles = (dir: string) => ({ preload: join(dir, '../preload/bar.cjs'), renderer: join(dir, '../renderer') });
