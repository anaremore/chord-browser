/**
 * #277 (from #272's round 2): "Search … for this image" loads the engine's upload as a new tab's first page through the
 * tab's wait for its session (tabs.ts' queueLoad over whenProxied; Safe Browsing told if it waits: round 2 of #333), so the
 * upload replaces the tab's own first load rather than
 * racing it, and waits for the session's proxy and ad-blocking rules as that load would have.
 */
import { describe, expect, it, vi } from 'vitest';

// Electron as far as browser.ts and what it imports touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { Browser } = await import('../../src/main/browser');

describe('an image search’s upload waits with the tab’s first load (#277)', () => {
  // A new tab in front or behind (openTabFor), or the tab on screen (its address was being edited: it moves, so an agent's
  // tab is yours from there, userNavigates).
  it.each(['front', 'background', 'current'] as const)('%s: the upload goes through the gate (queueLoad), and loads only when it says', (where) => {
    const contents = { isDestroyed: () => false, loadURL: vi.fn(async (_url: string, _options?: object) => undefined) };
    const queueLoad = vi.fn();
    const openTabFor = vi.fn(() => contents);
    const userNavigates = vi.fn();
    const self = {
      store: { state: { settings: { googleFree: false } } },
      openTabFor,
      userNavigates,
      tabs: { queueLoad },
      options: { proxyReady: () => null },
    };
    const image = { bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1, originalWidth: 1, originalHeight: 1 };
    Browser.prototype.searchByImage.call(self as never, { activeTabContents: contents } as never, 'bing', image, where);
    expect(openTabFor).toHaveBeenCalledTimes(where === 'current' ? 0 : 1);
    expect(userNavigates).toHaveBeenCalledTimes(where === 'current' ? 1 : 0);
    expect(queueLoad).toHaveBeenCalledOnce();
    expect(queueLoad.mock.calls[0]![0]).toBe(contents);
    // Nothing loads until the tab's wait lets it.
    expect(contents.loadURL).not.toHaveBeenCalled();
    (queueLoad.mock.calls[0]![1] as () => void)();
    expect(contents.loadURL).toHaveBeenCalledOnce();
    expect(contents.loadURL.mock.calls[0]![1]).toMatchObject({ postData: [{ type: 'rawData' }] });
  });
});
