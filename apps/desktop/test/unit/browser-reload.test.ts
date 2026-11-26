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
  it('the sidebar row’s reload button', () => {
    const contents = { isDestroyed: () => false, reload: vi.fn() };
    const reload = vi.fn();
    const userNavigates = vi.fn();
    // Browser's own methods (reloadPage), over just what they read.
    const self = Object.assign(Object.create(Browser.prototype) as object, { tabs: { get: () => ({ webContents: contents }), reload }, userNavigates });
    Browser.prototype.reloadTab.call(self as never, 'n1');
    expect(userNavigates).toHaveBeenCalledWith(contents);
    expect(reload).toHaveBeenCalledWith(contents);
    expect(contents.reload).not.toHaveBeenCalled();
  });
});
