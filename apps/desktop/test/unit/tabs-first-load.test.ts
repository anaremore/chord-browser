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

  it.each(['back', 'forward'] as const)('%s while a load waits for its session (#287): the waiting load is dropped, then the page goes that way', async (way) => {
    const rules = held();
    const t = setup([rules]);
    const history = t.page.navigationHistory as unknown as Record<string, unknown>;
    history['goBack'] = vi.fn();
    history['goForward'] = vi.fn();
    t.manager.go(t.page as never, way);
    expect(history[way === 'back' ? 'goBack' : 'goForward']).toHaveBeenCalledOnce();
    rules.resolve();
    await tick();
    expect(t.loaded()).toEqual([]);
    expect(firstLoadPending(t.page)).toBe(false);
  });

  it('Stop on a page not waiting: nothing to drop (the page’s own Stop does the rest)', () => {
    const t = setup([]);
    expect(t.loaded()).toEqual([FIRST]);
    expect(t.manager.stopWaiting(t.page as never)).toBe(false);
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
