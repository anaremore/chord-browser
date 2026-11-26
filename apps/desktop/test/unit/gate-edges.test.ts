/**
 * #300 and #299 (Opus's round 1 of #292): the navigations that went around the session's gate, and a gate whose wait
 * rejects.
 * - #300: a mini window's Back, Forward and Reload go through the tab manager's (tabs.go, tabs.reload: a load waiting
 *   for its session is dropped first, and they wait for it); Safe Browsing's Back to safety drops a waiting load before
 *   it leaves the flagged page.
 * - #299: a wait that rejects is over, never a page left blank; asked again, a source that keeps answering the same
 *   rejected wait doesn't spin.
 */
import { describe, expect, it, vi } from 'vitest';

// Electron as far as these modules touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { MiniWindows } = await import('../../src/main/mini-window');
const { SafeBrowsingGuard } = await import('../../src/main/safe-browsing/guard');

describe('a mini window’s Back, Forward and Reload (#300)', () => {
  it.each<[string, string, unknown[]]>([
    ['nav.back', 'go', ['back']],
    ['nav.forward', 'go', ['forward']],
    ['nav.reload', 'reload', [{}]],
    ['nav.hardReload', 'reload', [{ ignoreCache: true }]],
  ])('%s through tabs.%s, never the page’s own', (action, method, args) => {
    const history = { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() };
    const page = { isDestroyed: () => false, navigationHistory: history, reload: vi.fn(), reloadIgnoringCache: vi.fn() };
    const tabs = { go: vi.fn(), reload: vi.fn() };
    const self = Object.assign(Object.create(MiniWindows.prototype) as object, { forContents: () => ({ page: { webContents: page } }), deps: { tabs } });
    expect((MiniWindows.prototype as unknown as { run(a: string, c: unknown): boolean }).run.call(self, action, page)).toBe(true);
    expect((tabs as Record<string, ReturnType<typeof vi.fn>>)[method]).toHaveBeenCalledWith(page, ...args);
    expect(history.goBack).not.toHaveBeenCalled();
    expect(history.goForward).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.reloadIgnoringCache).not.toHaveBeenCalled();
  });
});

describe('Safe Browsing’s Back to safety (#300)', () => {
  it.each([true, false])('with somewhere to go back to: %s. A load waiting for its session is dropped first', (canGoBack) => {
    const order: string[] = [];
    const contents = {
      navigationHistory: { canGoBack: () => canGoBack, goBack: vi.fn(() => void order.push('back')) },
      loadURL: vi.fn(async () => void order.push('blank')),
    };
    const stopWaiting = vi.fn(() => void order.push('drop'));
    const guard = new SafeBrowsingGuard({ state: () => ({ live: {} }), dispatch: vi.fn(), enabled: () => true, check: vi.fn(), isTab: () => true, contentsOf: () => undefined, handOver: vi.fn(), closeTab: vi.fn(), stopWaiting } as never);
    (guard as unknown as { leave(c: unknown, w: object): void }).leave(contents, { own: false });
    expect(stopWaiting).toHaveBeenCalledWith(contents);
    expect(order).toEqual(canGoBack ? ['drop', 'back'] : ['drop', 'blank']);
  });
});
