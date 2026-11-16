/**
 * A page and its view as main sees them, for teardown tests: on macOS a destroyed
 * WebContentsView's `webContents` is undefined (view-page.ts), so anything that reads a
 * page through its view after the page is gone throws
 * `Cannot read properties of undefined (reading 'isDestroyed')`.
 */
import { EventEmitter } from 'node:events';
import { vi, type Mock } from 'vitest';

/** A page: events, and destroyed for good once destroyed. */
export class FakeContents extends EventEmitter {
  destroyed = false;
  readonly session = {};
  readonly ipc = new EventEmitter();
  readonly navigationHistory = {
    getAllEntries: () => [],
    getActiveIndex: () => 0,
    length: () => 0,
    canGoBack: () => false,
    canGoForward: () => false,
    restore: vi.fn(async () => undefined),
  };
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
  close: Mock = vi.fn(() => this.destroy());
  focus: Mock = vi.fn();
  send: Mock = vi.fn();
  loadURL: Mock = vi.fn(async () => undefined);
  reload: Mock = vi.fn();
  setAudioMuted: Mock = vi.fn();
  setWindowOpenHandler: Mock = vi.fn();
  setDevToolsWebContents: Mock = vi.fn();
  openDevTools: Mock = vi.fn();
  closeDevTools: Mock = vi.fn();
  isDevToolsOpened = () => false;
  isLoading = () => false;
  isFocused = () => false;
  getZoomFactor = () => 1;
  setZoomFactor: Mock = vi.fn();
  postMessage: Mock = vi.fn();
  /** A picture of one BGRA pixel, as the frame snapshot takes. */
  capturePage: Mock = vi.fn(async () => ({ isEmpty: () => false, getScaleFactors: () => [1], getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([1, 2, 3, 255]) }));
  getURL = () => 'http://127.0.0.1/broken';
  getTitle = () => 'Broken';
}

/** A view as Electron's is on macOS: its page is gone from it once destroyed. */
export class FakeView {
  readonly page = new FakeContents();
  get webContents(): FakeContents | undefined {
    return this.page.destroyed ? undefined : this.page;
  }
  setBackgroundColor: Mock = vi.fn();
  setBorderRadius: Mock = vi.fn();
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  getBounds = () => this.bounds;
  setBounds: Mock = vi.fn((b: { x: number; y: number; width: number; height: number }) => (this.bounds = b));
  private visible = true;
  getVisible = () => this.visible;
  setVisible: Mock = vi.fn((visible: boolean) => (this.visible = visible));
}
