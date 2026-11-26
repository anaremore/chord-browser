/**
 * #189 (round 1 of #272): a page's load that waits for its session (its proxy, its chord's ad-blocking rules) never
 * lands over a newer one, waits again if the session isn't ready by then, shows the tab loading meanwhile, and tells
 * an agent's tool call that a load is on its way (agents/pickers.ts' firstLoadPending, which pageLoaded waits on).
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type Command, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { Session, WebContents, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView, type FakeContents } from './fake-view';

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: class extends EventEmitter {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/window', async () => {
  const { FakeView: View } = await import('./fake-view');
  return { createUiView: () => new View() };
});
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));
vi.mock('../../src/main/platform', () => ({ platform: 'linux', applyMaterial: vi.fn(), onUiScale: () => () => undefined, systemInfo: () => ({}), titleBarOverlay: () => ({}), trafficLightPosition: () => ({ x: 0, y: 0 }), windowChromeOptions: () => ({}) }));
const { TabManager } = await import('../../src/main/tabs');
const { pageGate } = await import('../../src/main/page-gate');
const { SafeBrowsingGuard } = await import('../../src/main/safe-browsing/guard');
const { firstLoadPending } = await import('../../src/main/agents/pickers');
const NODE = 'n1' as NodeId;
const FIRST = 'https://first.test/';
const SECOND = 'https://second.test/';

/** The session's waits, in order: proxyReady answers the first not yet over (as index.ts' does), else null. */
function setup(waits: Array<ReturnType<typeof held>>) {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: FIRST, title: '', section: 'today', chordId: 'c1' } as SidebarNode]), live: {}, windows: {}, chords: { c1: { id: 'c1' } }, settings: { tabCounts: {} } } as unknown as State;
  const commands: Command[] = [];
  const proxyReady = vi.fn(() => waits.find((w) => !w.over)?.promise ?? null);
  const manager = new TabManager({
    state: () => state,
    dispatch: (c: Command) => void commands.push(c),
    sessionFor: () => ({}) as Session,
    proxyReady,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
  } as never);
  const view = manager.ensure(NODE) as unknown as FakeView;
  const page = view.page as FakeContents;
  const loaded = () => page.loadURL.mock.calls.map(([url]) => url as string);
  return { manager, page, loaded, commands, proxyReady };
}

function held() {
  const wait = { over: false, promise: Promise.resolve(), resolve: () => {} };
  wait.promise = new Promise<void>((r) => (wait.resolve = () => ((wait.over = true), r())));
  return wait;
}
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('a page’s load waiting for its session (#189)', () => {
  it('a navigation asked for during the wait is the one that loads: the first never lands over it', async () => {
    const rules = held();
    const t = setup([rules]);
    // By the navigation the session is ready (its rules on), so it loads at once; the first's wait ends after.
    rules.over = true;
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual([SECOND]);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([SECOND]);
  });

  it('both waiting on one promise: only the newer loads', async () => {
    const rules = held();
    const t = setup([rules]);
    t.manager.navigate(NODE, SECOND);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([SECOND]);
  });

  it('a load main asks for itself (an upload into a new tab) replaces the tab’s own first load', async () => {
    const rules = held();
    const t = setup([rules]);
    const upload = vi.fn();
    t.manager.whenProxied(t.page as unknown as WebContents, upload);
    rules.resolve();
    await tick();
    expect(upload).toHaveBeenCalledOnce();
    expect(t.loaded()).toEqual([]);
  });

  it('the session not ready when its wait ends (its proxy changed meanwhile): waits again before loading', async () => {
    const rules = held();
    const proxy = held();
    const t = setup([rules, proxy]);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([]);
    proxy.resolve();
    await tick();
    expect(t.loaded()).toEqual([FIRST]);
  });

  it('while it waits, the tab shows loading, and a tool call knows a page is on its way', async () => {
    const rules = held();
    const t = setup([rules]);
    expect(t.commands).toContainEqual({ t: 'tab.live', nodeId: NODE, live: { loading: true } });
    expect(firstLoadPending(t.page)).toBe(true);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([FIRST]);
    expect(firstLoadPending(t.page)).toBe(false);
  });

  it('Stop during the wait (#277): its load is dropped, the tab stops showing loading, nothing left pending', async () => {
    const rules = held();
    const t = setup([rules]);
    expect(t.manager.stopWaiting(t.page as never)).toBe(true);
    expect(t.commands.at(-1)).toEqual({ t: 'tab.live', nodeId: NODE, live: { loading: false } });
    expect(firstLoadPending(t.page)).toBe(false);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([]);
    // A load asked for after Stop goes as usual.
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual([SECOND]);
  });

  it('Reload after Stop on a page that never loaded (round 1 of #282): its tab’s address loads; a page with history reloads', async () => {
    const rules = held();
    const t = setup([rules]);
    t.manager.stopWaiting(t.page as never);
    rules.resolve();
    await tick();
    t.manager.reload(t.page as never);
    expect(t.loaded()).toEqual([FIRST]);
    expect(t.page.reload).not.toHaveBeenCalled();
    // Once it has history, Reload is the page's own.
    Object.assign(t.page.navigationHistory, { length: () => 1, getEntryAtIndex: () => ({ url: FIRST }) });
    t.manager.reload(t.page as never);
    expect(t.page.reload).toHaveBeenCalledOnce();
  });

  it('Reload while a navigation waits for its session (round 1 of #292, SF3; Neon’s B2): it takes that load’s place, and reloads once the session is ready', async () => {
    const rules = held();
    const t = setup([]);
    Object.assign(t.page.navigationHistory, { length: () => 1, getEntryAtIndex: () => ({ url: FIRST }) });
    rules.over = false;
    const waits = [rules];
    // The session waits again (its proxy set anew), and a navigation is queued behind it.
    (t.manager as unknown as { deps: { proxyReady: () => unknown } }).deps.proxyReady = () => waits.find((w) => !w.over)?.promise ?? null;
    t.manager.navigate(NODE, SECOND);
    t.manager.reload(t.page as never);
    expect(t.page.reload).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(t.page.reload).toHaveBeenCalledOnce();
    expect(t.loaded()).not.toContain(SECOND);
  });

  it('Hard Reload (round 1 of #292, SF2): the same, ignoring the cache; a page that never loaded loads its address', async () => {
    const t = setup([]);
    const page = t.page as unknown as { reloadIgnoringCache: ReturnType<typeof vi.fn> };
    page.reloadIgnoringCache = vi.fn();
    Object.assign(t.page.navigationHistory, { length: () => 1, getEntryAtIndex: () => ({ url: FIRST }) });
    t.manager.reload(t.page as never, { ignoreCache: true });
    expect(page.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(t.page.reload).not.toHaveBeenCalled();
    Object.assign(t.page.navigationHistory, { length: () => 0 });
    t.page.loadURL.mockClear();
    t.manager.reload(t.page as never, { ignoreCache: true });
    expect(t.loaded()).toEqual([FIRST]);
  });

  it('Reload while the tab’s own first load still waits (round 1 of #292, Opus’s N1): left alone, it loads once', async () => {
    const rules = held();
    const t = setup([rules]);
    t.manager.reload(t.page as never);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([FIRST]);
    expect(t.page.reload).not.toHaveBeenCalled();
  });

  it.each(['reload', 'back', 'forward'] as const)('%s while its session waits again (Neon’s B2, round 1 of #292): after it’s ready, never before', async (what) => {
    const rules = held();
    const t = setup([]);
    const history = t.page.navigationHistory as unknown as Record<string, unknown>;
    Object.assign(history, { length: () => 2, getEntryAtIndex: () => ({ url: FIRST }), canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() });
    const waits = [rules];
    (t.manager as unknown as { deps: { proxyReady: () => unknown } }).deps.proxyReady = () => waits.find((w) => !w.over)?.promise ?? null;
    if (what === 'reload') t.manager.reload(t.page as never);
    else t.manager.go(t.page as never, what);
    const done = () => (what === 'reload' ? t.page.reload : history[what === 'back' ? 'goBack' : 'goForward']) as ReturnType<typeof vi.fn>;
    expect(done()).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(done()).toHaveBeenCalledOnce();
  });

  it('Back or Forward with nowhere to go: nothing, and a load waiting isn’t dropped for it (round 2 of #292)', async () => {
    const rules = held();
    const t = setup([rules]);
    Object.assign(t.page.navigationHistory, { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() });
    t.manager.go(t.page as never, 'back');
    rules.resolve();
    await tick();
    // The tab's first load, which was waiting, still came.
    expect(t.loaded()).toEqual([FIRST]);
  });

  it('Back once its session is ready, but nothing left to go back to by then: nothing, and the tab stops showing loading', async () => {
    const rules = held();
    const t = setup([]);
    let can = true;
    const goBack = vi.fn();
    Object.assign(t.page.navigationHistory, { canGoBack: () => can, goBack });
    (t.manager as unknown as { deps: { proxyReady: () => unknown } }).deps.proxyReady = () => (rules.over ? null : rules.promise);
    t.manager.go(t.page as never, 'back');
    can = false;
    rules.resolve();
    await tick();
    expect(goBack).not.toHaveBeenCalled();
    // Its spinner, put on while it waited, comes off (round 2 of #292).
    expect(t.commands.filter((c) => c.t === 'tab.live').at(-1)).toEqual({ t: 'tab.live', nodeId: NODE, live: { loading: false } });
  });

  it('closed while a load waits (Neon’s SF2): the close takes a moment, and no load starts in it', async () => {
    const rules = held();
    const t = setup([rules]);
    // Electron's close isn't at once: the page is still there while it goes.
    t.page.close.mockImplementation(() => undefined);
    t.manager.destroy(NODE);
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([]);
  });

  it('a floating page (Peek, a mini window) closed while its load waits (round 2 of #292): no load starts in its close', async () => {
    const rules = held();
    const t = setup([rules]);
    const view = t.manager.createFloating('f1' as NodeId, { session: {} as Session, url: SECOND, private: false }) as unknown as FakeView;
    const page = view.page as FakeContents;
    page.close.mockImplementation(() => undefined);
    t.manager.closeFloating('f1' as NodeId);
    rules.resolve();
    await tick();
    expect(page.loadURL).not.toHaveBeenCalled();
  });

  it('Reload, Back or Forward on a page already gone (Neon’s SF3: its menu outlived it): nothing', () => {
    const t = setup([]);
    t.page.loadURL.mockClear();
    t.page.destroyed = true;
    const goBack = vi.fn();
    // As Electron's does: a page gone throws on its history (round 2 of #292).
    const gone = () => {
      throw new Error('Object has been destroyed');
    };
    Object.assign(t.page.navigationHistory, { goBack, canGoBack: gone, canGoForward: gone, length: gone, getEntryAtIndex: gone });
    expect(() => t.manager.reload(t.page as never)).not.toThrow();
    expect(() => t.manager.go(t.page as never, 'back')).not.toThrow();
    expect(t.page.reload).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
    expect(t.loaded()).toEqual([]);
  });

  it('Reload after Stop while it was primed (#287): a history of only the blank page is no history, so its address loads', () => {
    const t = setup([]);
    const history = t.page.navigationHistory as unknown as { length: () => number; getEntryAtIndex: (i: number) => { url: string } | null };
    history.length = () => 1;
    history.getEntryAtIndex = () => ({ url: 'about:blank' });
    t.page.loadURL.mockClear();
    t.manager.reload(t.page as never);
    expect(t.loaded()).toEqual([FIRST]);
    expect(t.page.reload).not.toHaveBeenCalled();
  });

  it.each(['back', 'forward'] as const)('%s while a load waits for its session (#287; Neon’s B2): it takes that load’s place, and goes once the session is ready', async (way) => {
    const rules = held();
    const t = setup([rules]);
    const history = t.page.navigationHistory as unknown as Record<string, unknown>;
    Object.assign(history, { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() });
    t.manager.go(t.page as never, way);
    expect(history[way === 'back' ? 'goBack' : 'goForward']).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(history[way === 'back' ? 'goBack' : 'goForward']).toHaveBeenCalledOnce();
    expect(t.loaded()).toEqual([]);
    expect(firstLoadPending(t.page)).toBe(false);
  });

  it('Stop on a page not waiting: nothing to drop (the page’s own Stop does the rest)', () => {
    const t = setup([]);
    expect(t.loaded()).toEqual([FIRST]);
    expect(t.manager.stopWaiting(t.page as never)).toBe(false);
  });

  it('a wait that rejects (#299; the gate never gives one since round 1 of #323, so a backstop): over, the page loads; asked again, the same rejected wait doesn’t spin', async () => {
    const failed = Promise.reject(new Error('a wait that rejects'));
    failed.catch(() => {});
    const t = setup([]);
    t.page.loadURL.mockClear();
    // The gate keeps answering the same rejected wait (page-gate.ts keeps one promise per session).
    (t.manager as unknown as { deps: { proxyReady: () => unknown } }).deps.proxyReady = () => failed;
    t.manager.navigate(NODE, SECOND);
    await tick();
    await tick();
    expect(t.loaded()).toEqual([SECOND]);
    expect(firstLoadPending(t.page)).toBe(false);
  });

  it('the rules’ wait failing while the proxy is still being set (Opus’s B1 on #323): nothing loads until the proxy is', async () => {
    const proxy = held();
    const failed = Promise.reject(new Error('the rules couldn’t be turned on'));
    failed.catch(() => {});
    const t = setup([]);
    t.page.loadURL.mockClear();
    const gate = pageGate<Session>({ proxy: () => (proxy.over ? null : proxy.promise), rules: () => failed });
    (t.manager as unknown as { deps: { proxyReady: unknown } }).deps.proxyReady = gate;
    t.manager.navigate(NODE, SECOND);
    await tick();
    await tick();
    expect(t.loaded()).toEqual([]);
    proxy.resolve();
    await tick();
    await tick();
    expect(t.loaded()).toEqual([SECOND]);
  });

  it.each([
    ['Reload', {}],
    ['Hard Reload', { ignoreCache: true }],
  ])('%s in a mini window or a Peek during its first load (Opus’s SF1 on #323): its page still loads, once', async (_, options) => {
    const rules = held();
    const t = setup([rules]);
    const view = t.manager.createFloating('f1' as NodeId, { session: {} as Session, url: SECOND, private: false }) as unknown as FakeView;
    const page = view.page as FakeContents;
    t.manager.reload(page as never, options);
    rules.resolve();
    await tick();
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual([SECOND]);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('Reload in a mini window stopped before its first load (Opus’s SF1): its address loads, once the session is ready', async () => {
    const rules = held();
    const t = setup([rules]);
    const view = t.manager.createFloating('f1' as NodeId, { session: {} as Session, url: SECOND, private: false }) as unknown as FakeView;
    const page = view.page as FakeContents;
    t.manager.stopWaiting(page as never);
    t.manager.reload(page as never);
    expect(page.loadURL).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual([SECOND]);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('a load waiting, then Back (a mini window’s, or the menu’s), then the session ready (Opus’s N2): back, and no stale load', async () => {
    const rules = held();
    const t = setup([rules]);
    t.page.loadURL.mockClear();
    t.manager.navigate(NODE, SECOND);
    rules.over = false;
    const goBack = vi.fn();
    Object.assign(t.page.navigationHistory, { canGoBack: () => true, goBack });
    t.manager.go(t.page as never, 'back');
    rules.resolve();
    await tick();
    expect(goBack).toHaveBeenCalledOnce();
    expect(t.loaded()).toEqual([]);
  });

  it('a load waiting, then Back to safety (it drops the load and leaves), then the session ready (Opus’s N2): no stale load', async () => {
    const rules = held();
    const t = setup([rules]);
    t.page.loadURL.mockClear();
    const goBack = vi.fn();
    Object.assign(t.page.navigationHistory, { canGoBack: () => true, goBack });
    // Safe Browsing's own guard, its stopWaiting the tab manager's (as browser.ts wires it).
    const guard = new SafeBrowsingGuard({ state: () => ({ live: {} }), dispatch: vi.fn(), enabled: () => true, check: vi.fn(), isTab: () => true, contentsOf: () => undefined, handOver: vi.fn(), closeTab: vi.fn(), stopWaiting: (c: WebContents) => void t.manager.stopWaiting(c) } as never);
    (guard as unknown as { leave(c: unknown, w: object): void }).leave(t.page, { own: false });
    rules.resolve();
    await tick();
    expect(goBack).toHaveBeenCalledOnce();
    expect(t.loaded()).toEqual([]);
  });

  it('a restored history that fails while the session changes (Neon’s NN2 on #323): its address loads once the session is ready', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    t.manager.destroy(NODE);
    t.manager.restoreHistoryOnLoad(NODE, { entries: [{ url: FIRST, title: '' }], index: 0 } as never);
    const rules = held();
    waits.push(rules);
    const page = (t.manager.ensure(NODE) as unknown as FakeView).page as FakeContents;
    let fail!: (e: Error) => void;
    (page.navigationHistory as unknown as { restore: unknown }).restore = vi.fn(() => new Promise((_r, reject) => (fail = reject)));
    rules.resolve();
    await tick();
    const proxy = held();
    waits.push(proxy);
    fail(new Error('no'));
    await tick();
    expect(page.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual([FIRST]);
  });

  it('a navigation while a restored history is on its way, then the restore failing (Neon’s round 2 of #323): the navigation stays', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    t.manager.destroy(NODE);
    t.manager.restoreHistoryOnLoad(NODE, { entries: [{ url: FIRST, title: '' }], index: 0 } as never);
    let fail!: (e: Error) => void;
    const rules = held();
    waits.push(rules);
    const page = (t.manager.ensure(NODE) as unknown as FakeView).page as FakeContents;
    (page.navigationHistory as unknown as { restore: unknown }).restore = vi.fn(() => new Promise((_r, reject) => (fail = reject)));
    rules.resolve();
    await tick();
    t.manager.navigate(NODE, SECOND);
    fail(new Error('no'));
    await tick();
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual([SECOND]);
  });

  it('Back or Forward waiting for the session (Neon’s round 2 of #323): Safe Browsing hears of it, as of a navigation', async () => {
    const rules = held();
    const t = setup([rules]);
    const navigationQueued = vi.fn();
    (t.manager as unknown as { deps: { navigationQueued: unknown } }).deps.navigationQueued = navigationQueued;
    Object.assign(t.page.navigationHistory, { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() });
    t.manager.go(t.page as never, 'back');
    expect(navigationQueued).toHaveBeenCalledWith(t.page);
    navigationQueued.mockClear();
    rules.resolve();
    await tick();
    // The session ready: no wait, nothing to tell.
    t.manager.go(t.page as never, 'forward');
    expect(navigationQueued).not.toHaveBeenCalled();
  });

  it('a page on its way to an unsafe address, then your navigation waiting for the session (Opus’s L1, round 2 of #323): it never arrives unwarned; yours loads after', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    const stop = vi.fn();
    Object.assign(t.page, { stop, session: { isPersistent: () => true } });
    let answer!: (v: unknown) => void;
    const guard = new SafeBrowsingGuard({ state: () => t.manager['deps'].state(), dispatch: (c: Command) => void t.commands.push(c), enabled: () => true, check: () => new Promise((r) => (answer = r)), isTab: () => true, contentsOf: () => t.page, handOver: vi.fn(), closeTab: vi.fn(), stopWaiting: (c: WebContents) => void t.manager.stopWaiting(c), navigate: (n: NodeId, u: string) => t.manager.navigate(n, u) } as never);
    (t.manager as unknown as { deps: { navigationQueued: unknown } }).deps.navigationQueued = (c: WebContents) => guard.navigationQueued(c);
    guard.attach(t.page as never, NODE);
    // The page heads to an address whose check is still out.
    t.page.emit('did-start-navigation', { url: 'https://unsafe.test/', isMainFrame: true, isSameDocument: false });
    // The session starts changing; you type another address, which waits.
    const proxy = held();
    waits.push(proxy);
    t.page.loadURL.mockClear();
    t.manager.navigate(NODE, SECOND);
    // The unsafe navigation is stopped: it can't arrive while its answer no longer counts.
    expect(stop).toHaveBeenCalledOnce();
    // Stopping it doesn't end the tab's loading: your page is on its way.
    t.page.emit('did-stop-loading');
    expect(t.commands.filter((c) => c.t === 'tab.live').at(-1)).toMatchObject({ live: { loading: true } });
    answer({ verdict: 'unsafe', kind: 'malware' });
    await tick();
    expect(t.page.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(t.loaded()).toEqual([SECOND]);
  });

  it('your navigation waiting when the page before has arrived (nothing in flight): nothing stopped', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    const stop = vi.fn();
    Object.assign(t.page, { stop, session: { isPersistent: () => true } });
    const guard = new SafeBrowsingGuard({ state: () => t.manager['deps'].state(), dispatch: vi.fn(), enabled: () => true, check: async () => ({ verdict: 'safe' }), isTab: () => true, contentsOf: () => t.page, handOver: vi.fn(), closeTab: vi.fn(), navigate: vi.fn() } as never);
    (t.manager as unknown as { deps: { navigationQueued: unknown } }).deps.navigationQueued = (c: WebContents) => guard.navigationQueued(c);
    guard.attach(t.page as never, NODE);
    t.page.emit('did-start-navigation', { url: FIRST, isMainFrame: true, isSameDocument: false });
    t.page.emit('did-navigate', {}, FIRST, 200);
    waits.push(held());
    t.manager.navigate(NODE, SECOND);
    expect(stop).not.toHaveBeenCalled();
  });

  it('a link that wants a new tab, in a mini window or a Peek (#326): it loads there once the session is ready', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    const view = t.manager.createFloating('f1' as NodeId, { session: {} as Session, url: SECOND, private: false }) as unknown as FakeView;
    const page = view.page as FakeContents;
    page.loadURL.mockClear();
    const proxy = held();
    waits.push(proxy);
    const open = page.setWindowOpenHandler.mock.calls[0]![0] as (d: object) => { action: string };
    expect(open({ url: 'https://third.test/', disposition: 'foreground-tab', features: '', frameName: '', referrer: {}, postBody: null }).action).toBe('deny');
    expect(page.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual(['https://third.test/']);
  });

  it('a page that crashed, reloaded by itself (#326): once the session is ready', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    // A page that had loaded: its history has it.
    Object.assign(t.page.navigationHistory, { length: () => 1, getEntryAtIndex: () => ({ url: FIRST }) });
    const proxy = held();
    waits.push(proxy);
    t.page.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(t.page.reload).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(t.page.reload).toHaveBeenCalledOnce();
  });

  it('a page opened again at an address (a PDF citation’s page, #326): loaded, then reloaded, once the session is ready', async () => {
    const waits: Array<ReturnType<typeof held>> = [];
    const t = setup(waits);
    t.page.loadURL.mockClear();
    const proxy = held();
    waits.push(proxy);
    t.manager.reopenAt(t.page as never, 'https://first.test/doc.pdf#page=3');
    expect(t.page.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(t.loaded()).toEqual(['https://first.test/doc.pdf#page=3']);
    expect(t.page.reload).toHaveBeenCalledOnce();
  });

  it('closed during the wait: nothing loads, nothing left pending', async () => {
    const rules = held();
    const t = setup([rules]);
    t.page.destroy();
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([]);
    expect(firstLoadPending(t.page)).toBe(false);
  });
});
