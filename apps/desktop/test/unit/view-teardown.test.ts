/**
 * Pages that die before their views (the renderer gone, quitting with Settings or a
 * floating page open): on macOS the view's `webContents` is undefined then (view-page.ts),
 * and reading through it threw `Cannot read properties of undefined (reading 'isDestroyed')`.
 * Each way a view is torn down, with its page destroyed first and with it still there:
 * no error, and a page still there is closed exactly once. DevTools: devtools-teardown.test.ts.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

/** Settings' window: what SettingsWindow asks of a BaseWindow. */
class FakeWindow extends EventEmitter {
  readonly contentView = { addChildView: vi.fn() };
  getContentBounds = () => ({ x: 0, y: 0, width: 860, height: 620 });
  isDestroyed = () => false;
  isMinimized = () => false;
  restore = vi.fn();
  focus = vi.fn();
  show = vi.fn();
}

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: FakeWindow,
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/window', async () => {
  const { FakeView: View } = await import('./fake-view');
  return { createUiView: () => new View() };
});
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));
vi.mock('../../src/main/platform', () => ({
  platform: 'darwin',
  applyMaterial: vi.fn(),
  onUiScale: () => () => undefined,
  systemInfo: () => ({}),
  titleBarOverlay: () => ({}),
  trafficLightPosition: () => ({ x: 0, y: 0 }),
  windowChromeOptions: () => ({}),
}));

const { TabManager } = await import('../../src/main/tabs');
const { SettingsWindow } = await import('../../src/main/settings-window');

const NODE = 'n1' as NodeId;

function tabs() {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: 'https://a.example/', section: 'today' } as SidebarNode]), live: {}, settings: { tabCounts: {} } } as unknown as State;
  return new TabManager({
    state: () => state,
    dispatch: vi.fn(),
    sessionFor: () => ({}) as Session,
    proxyReady: () => null,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => undefined,
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
  });
}

/** Each teardown: make the view, maybe destroy its page first, then tear it down (and read it on the way, as main does). */
const teardowns: [string, (destroyFirst: boolean) => FakeView][] = [
  [
    'a tab closing',
    (destroyFirst) => {
      const manager = tabs();
      const view = manager.ensure(NODE) as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      // What else reads a tab's page through its view on the way out.
      expect([...manager.entries()]).toHaveLength(destroyFirst ? 0 : 1);
      expect(manager.history(NODE)).toBeDefined();
      manager.setMuted(NODE, true);
      manager.refreshCounts();
      manager.hasBadge(NODE);
      manager.navigate(NODE, 'https://b.example/');
      manager.destroy(NODE);
      return view;
    },
  ],
  [
    'a tab going to sleep',
    (destroyFirst) => {
      const manager = tabs();
      const view = manager.ensure(NODE) as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      manager.sleep(NODE);
      return view;
    },
  ],
  [
    'every tab and floating page, quitting',
    (destroyFirst) => {
      const manager = tabs();
      const view = manager.createFloating('f1' as NodeId, { session: {} as Session, url: 'https://peek.example/', private: false }) as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      manager.destroyAll();
      return view;
    },
  ],
  [
    'a floating page (Peek, a mini window) closing',
    (destroyFirst) => {
      const manager = tabs();
      const view = manager.createFloating('f1' as NodeId, { session: {} as Session, url: 'https://peek.example/', private: false }) as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      manager.closeFloating('f1' as NodeId);
      return view;
    },
  ],
  [
    'a floating page that would become a tab',
    (destroyFirst) => {
      const manager = tabs();
      const view = manager.createFloating('f1' as NodeId, { session: {} as Session, url: 'https://peek.example/', private: false }) as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      // A page that's gone can't be a tab: it stays floating, and closes as one.
      expect(Boolean(manager.adopt('f1' as NodeId))).toBe(!destroyFirst);
      if (destroyFirst) manager.closeFloating('f1' as NodeId);
      else manager.destroy('f1' as NodeId);
      return view;
    },
  ],
  [
    'the Settings window closing',
    (destroyFirst) => {
      const onClosed = vi.fn();
      const settings = new SettingsWindow({} as Session, undefined, undefined, onClosed);
      const view = settings.view as unknown as FakeView;
      if (destroyFirst) view.page.destroy();
      settings.show('motion');
      settings.update({} as never);
      (settings.window as unknown as FakeWindow).emit('closed');
      expect(onClosed).toHaveBeenCalledOnce();
      return view;
    },
  ],
];

describe('a view torn down, with its page', () => {
  describe.each(teardowns)('%s', (_, teardown) => {
    it('destroyed first: no error, and nothing closed twice', () => {
      let view: FakeView | undefined;
      expect(() => (view = teardown(true))).not.toThrow();
      expect(view!.page.close).not.toHaveBeenCalled();
    });

    it('still there: closed, once', () => {
      const view = teardown(false);
      expect(view.page.close).toHaveBeenCalledOnce();
      expect(view.webContents).toBeUndefined();
    });
  });
});
