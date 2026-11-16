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
  setBounds: Mock = vi.fn();
  setVisible: Mock = vi.fn();
}
