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
function browser(
  pages: Record<string, { session: object; reducerSleeps: boolean }>,
  state: object = { windows: {}, nodes: {}, chords: {}, live: {} },
  peeking: Record<string, object> = {},
  minisHeld: { nodeId: string; chordId: string | null; url: string }[] = [],
) {
  const live = new Set(Object.keys(pages));
  const tabs = {
    *entries() {
      for (const [id, page] of Object.entries(pages)) if (live.has(id)) yield [id, { isDestroyed: () => false, session: page.session }];
    },
    get: (id: string) => (live.has(id) ? { webContents: {} } : undefined),
    sleep: vi.fn((id: string) => void live.delete(id)),
    closeFloatingIn: vi.fn(),
    floatingAddress: (id: string) => (id === 'peek-w1' ? 'https://peeked.test/' : undefined),
  };
  const dispatch = vi.fn((command: { t: string; nodeId?: string }) => {
    if (command.t === 'tab.sleep' && command.nodeId && pages[command.nodeId]?.reducerSleeps) live.delete(command.nodeId);
  });
  // Open windows, and the session of the page each one's Peek shows (if any).
  const windows = new Map(Object.keys(peeking).map((id) => [id, { id }]));
  const peeks = {
    contents: (w: { id: string }) => (peeking[w.id] ? { isDestroyed: () => false, session: peeking[w.id], getURL: () => '' } : null),
    nodeOf: (w: { id: string }) => `peek-${w.id}`,
    close: vi.fn(),
  };
  const minis = { closeIn: vi.fn(() => minisHeld) };
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    tabs,
    peeks,
    minis,
    store: { state, dispatch },
    windows,
    histories: { touch: vi.fn() },
    showPanes: vi.fn(),
    normalWindowForLinks: () => ({ id: 'w9' }),
  });
  (Browser.prototype as unknown as { holdPages(s: object): void }).holdPages.call(self, failing);
  return { live, tabs, dispatch, peeks, minis };
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

  it('its floating pages close with what shows them: a Peek on that session closes, its mini windows close, then any page left (Neon’s SF1-r3)', () => {
    const { tabs, peeks, minis } = browser({}, undefined, { w1: failing, w2: other });
    expect(peeks.close).toHaveBeenCalledTimes(1);
    expect(peeks.close).toHaveBeenCalledWith({ id: 'w1' });
    expect(minis.closeIn).toHaveBeenCalledWith(failing);
    expect(tabs.closeFloatingIn).toHaveBeenCalledWith(failing);
  });

  it('a Peek on that session becomes a tab in its window, held like any (Carbon’s SF6): its address, never lost', () => {
    const { peeks, dispatch } = browser({}, undefined, { w1: failing, w2: other });
    expect(peeks.close).toHaveBeenCalledWith({ id: 'w1' });
    expect(dispatch).toHaveBeenCalledWith({ t: 'tab.open', windowId: 'w1', url: 'https://peeked.test/' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a mini window on that session: a tab in its chord’s window (Carbon’s SF6), opened after the tabs are held, so it isn’t put to sleep too', () => {
    const state = { windows: { w1: { id: 'w1', activeChordId: 'c2', activeTab: {} }, w2: { id: 'w2', activeChordId: 'c1', activeTab: {} } }, nodes: {}, chords: { c1: { id: 'c1' } }, live: {} };
    const { dispatch, tabs } = browser({ n1: { session: failing, reducerSleeps: true } }, state, { w1: other, w2: other }, [{ nodeId: 'm1', chordId: 'c1', url: 'https://mini.test/' }]);
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'tab.open', windowId: 'w2', url: 'https://mini.test/' });
    expect(dispatch.mock.calls.findIndex(([c]) => c.t === 'tab.open')).toBeGreaterThan(dispatch.mock.calls.findIndex(([c]) => c.t === 'tab.sleep'));
    expect(tabs.sleep).not.toHaveBeenCalled();
  });

  it('a mini window whose chord no window shows: the window links open in shows that chord, then the tab', () => {
    const state = { windows: { w9: { id: 'w9', activeChordId: 'c2', activeTab: {} } }, nodes: {}, chords: { c1: { id: 'c1' } }, live: {} };
    const { dispatch } = browser({}, state, {}, [{ nodeId: 'm1', chordId: 'c1', url: 'https://mini.test/' }]);
    expect(dispatch.mock.calls.map(([c]) => c)).toEqual([
      { t: 'chord.activate', windowId: 'w9', chordId: 'c1' },
      { t: 'tab.open', windowId: 'w9', url: 'https://mini.test/' },
    ]);
  });

  it('another session’s tabs are left alone', () => {
    const { live } = browser({ n1: { session: failing, reducerSleeps: true }, n2: { session: other, reducerSleeps: true } });
    expect([...live]).toEqual(['n2']);
  });
});

describe('MiniWindows.closeIn (Neon’s SF1-r3, Carbon’s SF6 on #331)', () => {
  it('each mini window whose page is in that session: its page out at once, the window fading away, and what it showed handed back; others stay', async () => {
    const { MiniWindows } = await import('../../src/main/mini-window');
    const mini = (nodeId: string, session: object) => ({
      nodeId,
      target: 'c1',
      promoted: false,
      page: { webContents: { isDestroyed: () => false, session, getURL: () => `https://${nodeId}.test/` } },
      window: { close: vi.fn(), isDestroyed: () => false, contentView: { removeChildView: vi.fn() } },
      fadeAndClose: vi.fn(),
    });
    const held = mini('m1', failing);
    const kept = mini('m2', other);
    const self = Object.assign(Object.create(MiniWindows.prototype) as object, { open: new Map([['m1', held], ['m2', kept]]) });
    const gone = (MiniWindows.prototype as unknown as { closeIn(s: object): unknown }).closeIn.call(self, failing);
    expect(gone).toEqual([{ nodeId: 'm1', chordId: 'c1', url: 'https://m1.test/' }]);
    expect(held.window.contentView.removeChildView).toHaveBeenCalledWith(held.page);
    expect(held.fadeAndClose).toHaveBeenCalled();
    expect(kept.fadeAndClose).not.toHaveBeenCalled();
    expect(kept.window.close).not.toHaveBeenCalled();
  });
});
