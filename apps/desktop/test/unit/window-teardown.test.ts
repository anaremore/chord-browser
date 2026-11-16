/**
 * A Chord window whose views' pages die first (quitting with DevTools docked, a UI
 * renderer gone): on macOS a view whose page is destroyed has no `webContents`
 * (view-page.ts). The window's `closed` handler, its layout, the frame snapshot's
 * pictures and F6 focus must carry on without them. Tabs, floating pages and Settings:
 * view-teardown.test.ts.
 */
import { EventEmitter } from 'node:events';
import type { WindowId } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

/** What AppWindow asks of a BaseWindow: on screen, 1280 × 820. */
class FakeWindow extends EventEmitter {
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
  getContentBounds = () => ({ x: 0, y: 0, width: 1280, height: 820 });
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

/** A window showing one tab, with its DevTools docked beside it; the shell has painted, so frame changes glide. */
function windowWithDevtools() {
  const w = new AppWindow({ id: 'w1' as WindowId, uiSession: {} as Session, bounds: null, sidebar: 'docked', sidebarWidth: 240, onBounds: vi.fn(), presenting: () => false });
  w.markShellPainted();
  const page = new FakeView();
  const tools = new FakeView();
  w.showTabs([page as unknown as WebContentsView], 0, null, [{ view: tools as unknown as WebContentsView, tab: 'n1' }]);
  return { w, page, tools, shell: w.shell as unknown as FakeView, popover: w.popover as unknown as FakeView, overlay: w.overlay as unknown as FakeView };
}

describe('a window whose views’ pages die first', () => {
  it.each([
    ['the shell’s', 'shell'],
    ['the command bar’s', 'overlay'],
    ['the popover’s', 'popover'],
  ] as const)('closing, %s page already gone: no error, and the others close once', (_, which) => {
    const views = windowWithDevtools();
    views[which].page.destroy();
    expect(() => (views.w.window as unknown as FakeWindow).emit('closed')).not.toThrow();
    for (const name of ['shell', 'overlay', 'popover'] as const) {
      expect(views[name].page.close).toHaveBeenCalledTimes(name === which ? 0 : 1);
    }
  });

  it('docked DevTools whose page is gone (quitting): not laid out, pictured or focused, and the frame still changes', async () => {
    const { w, page, tools, shell } = windowWithDevtools();
    expect(w.devtoolsShown).toBe(true);
    const placed = tools.setBounds.mock.calls.length;
    const pageWidth = page.getBounds().width;
    // Before DevTools.close has cleared them from the window.
    tools.page.destroy();
    expect(w.devtoolsShown).toBe(false);

    // The frame changes (the sidebar collapsing), pictured first: the page alone is.
    const change = vi.fn(() => w.setSidebar('collapsed', 240));
    w.changeFrame(change, true);
    await w.frameChanged();
    expect(change).toHaveBeenCalledOnce();
    expect(page.page.capturePage).toHaveBeenCalled();
    // The page takes the whole pane; the DevTools' view stays where it was.
    expect(page.getBounds().width).toBeGreaterThan(pageWidth);
    expect(tools.setBounds).toHaveBeenCalledTimes(placed);

    // F6 to DevTools that are gone: the keyboard goes to the shell.
    shell.page.focus.mockClear();
    w.focusRegion('devtools');
    expect(shell.page.focus).toHaveBeenCalledOnce();
  });

  it('F6 to the page when it is gone: the keyboard goes to the shell', () => {
    const { w, page, shell } = windowWithDevtools();
    page.page.destroy();
    shell.page.focus.mockClear();
    expect(() => w.focusRegion('page')).not.toThrow();
    expect(shell.page.focus).toHaveBeenCalledOnce();
  });
});
