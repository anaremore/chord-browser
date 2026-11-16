/**
 * DevTools going away with their page (quitting with them open): on macOS a destroyed
 * WebContentsView's `webContents` is undefined, so DevTools have to keep the page they made
 * rather than reading it through the view again. PR #22's E2E hit this on macOS only:
 * `Cannot read properties of undefined (reading 'isDestroyed')` in DevTools.close.
 * Tabs, floating pages and Settings: view-teardown.test.ts.
 */
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeContents, type FakeView } from './fake-view';

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: class {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/window', () => ({ createUiView: vi.fn() }));
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));

const { DevTools } = await import('../../src/main/devtools');

describe('DevTools close with their page', () => {
  it.each([
    ['their own page is destroyed (quitting)', 'tools'],
    ['the inspected page is destroyed (the tab closing)', 'page'],
  ] as const)('%s, while docked: closed without an error, and nothing left open', (_, which) => {
    const page = new FakeContents();
    const changed = vi.fn();
    const devtools = new DevTools({
      page: () => page as unknown as WebContents,
      sessionFor: () => ({}) as Session,
      uiSession: {} as Session,
      settings: () => ({ side: 'right', width: 440, height: 320, window: false }),
      remember: vi.fn(),
      changed,
      nearBounds: () => undefined,
      wire: vi.fn(),
      openUrl: vi.fn(),
      reveal: vi.fn(),
    });
    expect(devtools.show('n1')).toBe(true);
    const tools = devtools.dockedView('n1') as unknown as FakeView;
    const toolsPage = tools.webContents!;
    expect(devtools.nodeOf(toolsPage as unknown as WebContents)).toBe('n1');

    expect(() => (which === 'tools' ? toolsPage.destroy() : page.destroy())).not.toThrow();
    expect(devtools.placeOf('n1')).toBeNull();
    expect(changed).toHaveBeenLastCalledWith('n1', null);
    // Gone already: never closed twice. The inspected page's DevTools close only while it's there.
    if (which === 'tools') expect(toolsPage.close).not.toHaveBeenCalled();
    else expect(toolsPage.close).toHaveBeenCalledOnce();
    expect(page.closeDevTools).toHaveBeenCalledTimes(which === 'tools' ? 1 : 0);
  });
});
