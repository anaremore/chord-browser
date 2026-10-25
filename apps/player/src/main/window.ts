/**
 * Chord Player's window (DESIGN.md §7.13; spike S14's approach (a)): a
 * frameless window of its own with a 40 px bar in the colors of the chord it
 * came from (the service's name and *Back to Chord*, the OS's own window
 * controls), and the service's page below. Moving, resizing, fullscreen,
 * Spaces and picture-in-picture are the OS's and Chromium's own.
 */
import type { Theme } from '@chord/player-protocol';
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
      this.layout();
    });
    this.page.webContents.on('leave-html-full-screen', () => {
      this.fullScreen = false;
      this.layout();
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

  /** Brings the window to the front, its page focused. */
  focus(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
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
