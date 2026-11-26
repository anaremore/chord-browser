/**
 * #287 (Neon's round 2 of #282): your reloads go through tabs.reload, so a page stopped before it ever loaded (no
 * history, or only an agent tab's blank page) loads its tab's address instead of reloading nothing. The sidebar row's
 * button here; the toolbar's (index.ts) and the page menu's (context-menu.ts) call the same.
 */
import { describe, expect, it, vi } from 'vitest';

// Electron as far as browser.ts and what it imports touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { Browser } = await import('../../src/main/browser');

describe('your reloads go through tabs.reload (#287)', () => {
  it('Hard Reload in DevTools (round 1 of #292, SF2): tabs.reload, ignoring the cache', () => {
    const contents = { isDestroyed: () => false, reloadIgnoringCache: vi.fn() };
    const reload = vi.fn();
    const userNavigates = vi.fn();
    const self = Object.assign(Object.create(Browser.prototype) as object, { tabs: { get: () => ({ webContents: contents }), reload }, userNavigates, devtools: {} });
    (Browser.prototype as unknown as { runInDevtools(a: string, n: string, c: unknown): boolean }).runInDevtools.call(self, 'nav.hardReload', 'n1', contents);
    expect(reload).toHaveBeenCalledWith(contents, { ignoreCache: true });
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['nav.back', 'go', ['back']],
    ['nav.forward', 'go', ['forward']],
    ['nav.hardReload', 'reload', [{ ignoreCache: true }]],
  ])('the keys and the app menu: %s through tabs.%s (round 1 of #292, SF1 and SF2)', (action, method, args) => {
    const history = { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() };
    const contents = { isDestroyed: () => false, navigationHistory: history, reloadIgnoringCache: vi.fn() };
    const tabs = { go: vi.fn(), reload: vi.fn() };
    const w = { id: 'w1', activeTabContents: contents, focusSource: () => 'page' };
    const self = Object.assign(Object.create(Browser.prototype) as object, {
      store: { state: { windows: { w1: { id: 'w1', activeChordId: 'c1', activeTab: { c1: null } } }, nodes: {}, chords: {} } },
      peeks: { contents: () => undefined },
      pageIn: () => contents,
      readers: { pageOf: () => undefined },
      tabs,
      userNavigates: vi.fn(),
    });
    (Browser.prototype as unknown as { runAction(a: string, w: unknown): boolean }).runAction.call(self, action, w);
    expect((tabs as Record<string, ReturnType<typeof vi.fn>>)[method]).toHaveBeenCalledWith(contents, ...args);
    expect(history.goBack).not.toHaveBeenCalled();
    expect(history.goForward).not.toHaveBeenCalled();
    expect(contents.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it('the sidebar row’s reload button', () => {
    const contents = { isDestroyed: () => false, reload: vi.fn() };
    const reload = vi.fn();
    const userNavigates = vi.fn();
    // Browser's own methods (reloadPage), over just what they read.
    const self = Object.assign(Object.create(Browser.prototype) as object, { tabs: { get: () => ({ webContents: contents }), reload }, userNavigates });
    Browser.prototype.reloadTab.call(self as never, 'n1');
    expect(userNavigates).toHaveBeenCalledWith(contents);
    expect(reload).toHaveBeenCalledWith(contents, {});
    expect(contents.reload).not.toHaveBeenCalled();
  });
});
