/**
 * #331 (the owner's pick (a); Neon's B1-r2): when a session's proxy begins failing, every tab whose page is in it has
 * that page closed, wherever the tab is: on screen (loaded again at once, held by the gate), off screen, or in a window
 * that's closed but remembered, which the store's `tab.sleep` leaves alone. No path leaves a live page in the session.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { Browser } = await import('../../src/main/browser');

const failing = { id: 'failing' };
const other = { id: 'other' };

/** A Browser with these tabs' pages, the store's `tab.sleep` doing what the reducer does for each (`asleep` or not). */
function browser(pages: Record<string, { session: object; reducerSleeps: boolean }>, state: object = { windows: {}, nodes: {}, chords: {}, live: {} }) {
  const live = new Set(Object.keys(pages));
  const tabs = {
    *entries() {
      for (const [id, page] of Object.entries(pages)) if (live.has(id)) yield [id, { isDestroyed: () => false, session: page.session }];
    },
    get: (id: string) => (live.has(id) ? { webContents: {} } : undefined),
    sleep: vi.fn((id: string) => void live.delete(id)),
    closeFloatingIn: vi.fn(),
  };
  const dispatch = vi.fn((command: { t: string; nodeId: string }) => {
    if (command.t === 'tab.sleep' && pages[command.nodeId]?.reducerSleeps) live.delete(command.nodeId);
  });
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    tabs,
    store: { state, dispatch },
    windows: new Map(),
    histories: { touch: vi.fn() },
    showPanes: vi.fn(),
  });
  (Browser.prototype as unknown as { holdPages(s: object): void }).holdPages.call(self, failing);
  return { live, tabs, dispatch };
}

describe('holdPages (#331)', () => {
  it('a tab off screen: put to sleep through the store, as any tab', () => {
    const { live, dispatch, tabs } = browser({ n1: { session: failing, reducerSleeps: true } });
    expect(dispatch).toHaveBeenCalledWith({ t: 'tab.sleep', nodeId: 'n1' });
    expect(tabs.sleep).not.toHaveBeenCalled();
    expect(live.has('n1')).toBe(false);
  });

  it('a tab in a window closed but remembered (the store won’t put it to sleep): its page is closed all the same (Neon’s B1-r2)', () => {
    const { live, tabs } = browser({ n1: { session: failing, reducerSleeps: false } }, { windows: { w1: { id: 'w1' } }, nodes: {}, chords: {}, live: {} });
    expect(tabs.sleep).toHaveBeenCalledWith('n1');
    expect(live.has('n1')).toBe(false);
  });

  it('a page with no `live` entry yet: closed too', () => {
    const { live } = browser({ n1: { session: failing, reducerSleeps: false } });
    expect(live.has('n1')).toBe(false);
  });

  it('its floating pages (Peek, a mini window) close too (Opus’s nit on #331)', () => {
    const { tabs } = browser({});
    expect(tabs.closeFloatingIn).toHaveBeenCalledWith(failing);
  });

  it('another session’s tabs are left alone', () => {
    const { live } = browser({ n1: { session: failing, reducerSleeps: true }, n2: { session: other, reducerSleeps: true } });
    expect([...live]).toEqual(['n2']);
  });
});
