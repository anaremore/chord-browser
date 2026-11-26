/**
 * #300 and #299 (Opus's round 1 of #292): the navigations that went around the session's gate, and a gate whose wait
 * rejects.
 * - #300: a mini window's Back, Forward and Reload go through the tab manager's (tabs.go, tabs.reload: a load waiting
 *   for its session is dropped first, and they wait for it); Safe Browsing's Back to safety drops a waiting load before
 *   it leaves the flagged page.
 * - #299: a wait that rejects is over, never a page left blank; asked again, a source that keeps answering the same
 *   rejected wait doesn't spin.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Electron as far as these modules touch it at load: anything answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { MiniWindows } = await import('../../src/main/mini-window');
const { SafeBrowsingGuard } = await import('../../src/main/safe-browsing/guard');
const { Peeks } = await import('../../src/main/peek');
const { setFirstLoadPending } = await import('../../src/main/agents/pickers');

const FLAGGED = 'https://flagged.test/';
const BEFORE = 'https://before.test/';

/** A page as the guard sees it: its navigations' events, its address, its history. */
function guardPage(url: string, canGoBack = true) {
  const events = new EventEmitter();
  return Object.assign(events, {
    getURL: () => url,
    isDestroyed: () => false,
    stop: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    session: { isPersistent: () => true },
    navigationHistory: { canGoBack: () => canGoBack, goBack: vi.fn() },
  });
}

/** The guard on one tab (n1) showing `threat` (or none), with its deps as spies. */
function guardOn(contents: ReturnType<typeof guardPage>, threat: object | null, check: () => Promise<unknown> = async () => ({ verdict: 'safe' })) {
  const live: Record<string, unknown> = { n1: { threat } };
  const deps = {
    state: () => ({ live }),
    dispatch: vi.fn(),
    enabled: () => true,
    check: vi.fn(check),
    isTab: () => true,
    contentsOf: () => contents,
    handOver: vi.fn(),
    closeTab: vi.fn(),
    stopWaiting: vi.fn(),
    navigate: vi.fn(),
  };
  const guard = new SafeBrowsingGuard(deps as never);
  return { guard, deps };
}

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

describe('Safe Browsing’s warning and a load waiting for the session (Neon’s round 1 of #323)', () => {
  it('Visit anyway (NB1): through the tab manager’s navigate, which waits for the session; never the page’s own load', () => {
    const contents = guardPage('about:blank');
    const { guard, deps } = guardOn(contents, { kind: 'malware', url: FLAGGED, frameUrl: null });
    guard.proceed('n1' as never);
    expect(deps.navigate).toHaveBeenCalledWith('n1', FLAGGED);
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it('Back to safety once the page already left the flagged one (NSF1a, the common path): a load waiting is dropped too', () => {
    const contents = guardPage(BEFORE);
    const { guard, deps } = guardOn(contents, { kind: 'malware', url: FLAGGED, frameUrl: null });
    guard.back('n1' as never);
    expect(deps.stopWaiting).toHaveBeenCalledWith(contents);
  });

  it('a check still out for the page before (NSF1b): a navigation you asked for, queued for the session, isn’t dropped by its answer', async () => {
    let answer!: (v: unknown) => void;
    const contents = guardPage(BEFORE);
    const { guard, deps } = guardOn(contents, { kind: 'malware', url: 'https://older.test/', frameUrl: null }, () => new Promise((r) => (answer = r)));
    guard.attach(contents as never, 'n1' as never);
    contents.emit('did-start-navigation', { url: FLAGGED, isMainFrame: true, isSameDocument: false });
    deps.dispatch.mockClear();
    // You asked for another page; it waits for the session (tabs.navigate, whenProxied).
    guard.navigationQueued(contents as never);
    // The warning still up, about the page before, goes; the navigation still on its way stops (Opus's L1, round 2).
    expect(deps.dispatch).toHaveBeenCalledWith({ t: 'tab.live', nodeId: 'n1', live: { threat: null } });
    expect(contents.stop).toHaveBeenCalledOnce();
    answer({ verdict: 'unsafe', kind: 'malware' });
    await new Promise((r) => setImmediate(r));
    // The late answer: no warning, nothing stopped or dropped for it.
    expect(deps.stopWaiting).not.toHaveBeenCalled();
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(deps.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ live: expect.objectContaining({ threat: expect.objectContaining({ url: FLAGGED }) }) }));
  });
});

describe('a mini window fading out after Open in (Neon’s NN1 on #323)', () => {
  it('its keys no longer act on the page, which is a tab now', () => {
    const page = { isDestroyed: () => false, navigationHistory: {}, reload: vi.fn() };
    const tabs = { go: vi.fn(), reload: vi.fn() };
    const self = Object.assign(Object.create(MiniWindows.prototype) as object, { forContents: () => ({ promoted: true, page: { webContents: page }, window: { close: vi.fn() } }), deps: { tabs } });
    expect((MiniWindows.prototype as unknown as { run(a: string, c: unknown): boolean }).run.call(self, 'nav.back', page)).toBe(false);
    expect(tabs.go).not.toHaveBeenCalled();
  });
});

describe('Peek’s Open in Today while its page waits for the session (Neon’s NSF2 on #323)', () => {
  it('the tab gets the address it’s on its way to, and shows loading', () => {
    const contents = { isDestroyed: () => false, isLoading: () => false, getURL: () => '', getTitle: () => '', navigationHistory: { canGoBack: () => false, canGoForward: () => false } };
    setFirstLoadPending(contents as never, true);
    const dispatch = vi.fn();
    const tabs = { adopt: vi.fn(() => ({ webContents: contents })), floatingAddress: vi.fn(() => 'https://peeked.test/') };
    const peeks = new Peeks({ state: vi.fn(), dispatch, tabs, sessionFor: vi.fn(), animates: () => false, adopted: vi.fn(), changed: vi.fn() } as never);
    (peeks as unknown as { open: Map<string, object> }).open.set('w1', { nodeId: 'p1', chordId: 'c1' });
    peeks.expand({ id: 'w1', growPeekToFrame: (_a: boolean, done: () => void) => done(), closePeek: vi.fn() } as never);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ t: 'tab.adopt', nodeId: 'p1', url: 'https://peeked.test/', live: expect.objectContaining({ loading: true }) }));
  });
});

