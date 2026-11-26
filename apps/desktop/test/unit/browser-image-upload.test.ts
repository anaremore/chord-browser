/**
 * #277 (from #272's round 2): "Search … for this image" loads the engine's upload as a new tab's first page through the
 * tab's wait for its session (tabs.ts' whenProxied), so the upload replaces the tab's own first load rather than
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
  it.each(['front', 'background'] as const)('a new tab (%s): the upload goes through whenProxied, and loads only when it says', (where) => {
    const contents = { isDestroyed: () => false, loadURL: vi.fn(async (_url: string, _options?: object) => undefined) };
    const whenProxied = vi.fn();
    const self = {
      store: { state: { settings: { googleFree: false } } },
      openTabFor: () => contents,
      tabs: { whenProxied },
      options: { proxyReady: () => null },
    };
    const image = { bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1, originalWidth: 1, originalHeight: 1 };
    Browser.prototype.searchByImage.call(self as never, {} as never, 'bing', image, where);
    expect(whenProxied).toHaveBeenCalledOnce();
    expect(whenProxied.mock.calls[0]![0]).toBe(contents);
    // Nothing loads until the tab's wait lets it.
    expect(contents.loadURL).not.toHaveBeenCalled();
    (whenProxied.mock.calls[0]![1] as () => void)();
    expect(contents.loadURL).toHaveBeenCalledOnce();
    expect(contents.loadURL.mock.calls[0]![1]).toMatchObject({ postData: [{ type: 'rawData' }] });
  });
});
