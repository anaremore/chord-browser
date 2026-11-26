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

  it('Back once its session is ready, but nothing left to go back to by then: nothing', async () => {
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

  it('Reload, Back or Forward on a page already gone (Neon’s SF3: its menu outlived it): nothing', () => {
    const t = setup([]);
    t.page.loadURL.mockClear();
    t.page.destroyed = true;
    const goBack = vi.fn();
    Object.assign(t.page.navigationHistory, { goBack, canGoBack: () => true });
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

  it('a wait that rejects (#299): over, the page loads; asked again, the same rejected wait doesn’t spin', async () => {
    const failed = Promise.reject(new Error('the proxy couldn’t be set'));
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
