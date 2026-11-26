/**
 * Round 1 of #292 (Neon's SF4): the toolbar's extension popup is handed its session's wait (proxyReady), as the tab's
 * page and the pop-out window are: extensions/index.ts' openPopup wires it to ExtensionPopup.
 */
import { describe, expect, it, vi } from 'vitest';

const made: Array<{ proxyReady?: (session: object) => unknown; session: object }> = [];
vi.mock('../../src/main/extensions/popup', () => ({
  ExtensionPopup: class {
    constructor(_host: unknown, options: { proxyReady?: (session: object) => unknown; session: object }) {
      made.push(options);
    }
    close() {}
  },
}));
// Electron as far as this module and what it imports touch it at load: anything else answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { Extensions } = await import('../../src/main/extensions/index');

describe('the toolbar’s extension popup and its session’s wait (round 1 of #292)', () => {
  it('openPopup hands the popup proxyReady, asked about the popup’s own session', () => {
    const wait = Promise.resolve();
    const proxyReady = vi.fn(() => wait);
    const extensions = new Extensions({ profileSession: () => ({}), proxyReady, nodeFor: () => 'n1', dispatch: vi.fn() } as never);
    const w = { id: 'w1' };
    Object.assign(extensions, { windowForBase: () => w });
    const callbacks = (extensions as unknown as { callbacks(p: string): { openPopup(o: object): void } }).callbacks('default');
    const session = {};
    callbacks.openPopup({ extensionId: 'x', tab: { session }, window: {}, url: 'chrome-extension://x/popup.html' });
    expect(made).toHaveLength(1);
    expect(made[0]!.session).toBe(session);
    expect(made[0]!.proxyReady?.(session)).toBe(wait);
    expect(proxyReady).toHaveBeenCalledWith(session);
  });
});
