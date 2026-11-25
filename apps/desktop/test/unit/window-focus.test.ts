/**
 * Coming back to a window (macOS, agents.spec's "coming back to Chord"): AppKit can make a view of the window its first
 * responder when the window becomes key, the popover among them, though it's hidden (no card up). A hidden popover,
 * preview or overlay never keeps the focus: it goes to your page (keepFocusOffParked). A popover showing a card keeps it.
 */
import { EventEmitter } from 'node:events';
import type { WindowId } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

const focus = vi.hoisted(() => ({ window: null as unknown, contents: null as unknown }));

class FakeWindow extends EventEmitter {
  static getFocusedWindow = () => focus.window;
  content = { x: 0, y: 0, width: 1280, height: 820 };
  readonly contentView = {
    children: [] as unknown[],
    addChildView: vi.fn((view: unknown, index?: number) => {
      const c = this.contentView.children;
      if (index === undefined) c.push(view);
      else c.splice(index, 0, view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const c = this.contentView.children;
      if (c.includes(view)) c.splice(c.indexOf(view), 1);
    }),
  };
  getContentBounds = () => ({ ...this.content });
  getBounds = () => this.getContentBounds();
  isDestroyed = () => false;
  isVisible = () => true;
  isMinimized = () => false;
  isMaximized = () => false;
  isFullScreen = () => false;
  maximize = vi.fn();
  show = vi.fn();
  setTitleBarOverlay = vi.fn();
  setWindowButtonPosition = vi.fn();
}

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: FakeWindow,
  webContents: { getFocusedWebContents: () => focus.contents },
  MessageChannelMain: class {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/ipc', () => ({ registerCaller: vi.fn(), send: vi.fn() }));
vi.mock('../../src/main/security', () => ({ lockToOrigins: vi.fn() }));
vi.mock('../../src/main/perf', () => ({ epochNow: () => 0, markLaunch: vi.fn() }));
vi.mock('../../src/main/platform', () => ({
  platform: 'darwin',
  applyMaterial: vi.fn(),
  onUiScale: () => () => undefined,
  systemInfo: () => ({}),
  titleBarOverlay: () => ({}),
  trafficLightPosition: () => ({ x: 0, y: 0 }),
  uiScale: () => 1,
  windowChromeOptions: () => ({}),
}));

const { AppWindow } = await import('../../src/main/window');

function newWindow() {
  const w = new AppWindow({ id: 'w1' as WindowId, uiSession: {} as Session, bounds: null, sidebar: 'docked', sidebarWidth: 240, onBounds: vi.fn(), presenting: () => false });
  w.markShellPainted();
  const page = new FakeView();
  w.showTabs([page as unknown as WebContentsView], 0, null, []);
  focus.window = (w as unknown as { window: FakeWindow }).window;
  // Only what keepFocusOffParked does counts (showing the tab focused it already).
  page.page.focus.mockClear();
  return { w, page, popover: w.popover as unknown as FakeView, preview: w.preview as unknown as FakeView, overlay: w.overlay as unknown as FakeView };
}

describe('coming back to a window, the focus is on a view you can see (agents.spec’s “coming back to Chord”)', () => {
  it('a hidden popover, preview or overlay never keeps it: it goes to your page', () => {
    for (const which of ['popover', 'preview', 'overlay'] as const) {
      const made = newWindow();
      const view = made[which];
      view.setVisible(false);
      focus.contents = view.page;
      made.w.keepFocusOffParked();
      expect(made.page.page.focus, which).toHaveBeenCalled();
    }
  });

  it('a popover showing a card keeps it (its card is what you answer)', () => {
    const { w, page, popover } = newWindow();
    popover.setVisible(true);
    focus.contents = popover.page;
    w.keepFocusOffParked();
    expect(page.page.focus).not.toHaveBeenCalled();
  });
});
