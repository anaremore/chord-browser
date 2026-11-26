/**
 * #277 (from #272's round 2): a load asked for over an agent tab's first page while that page is still being primed (a
 * blank page loaded, its service workers being bypassed) is the page from then on. The priming never lands the first
 * address over it, and the tab's hold is failed (nothing acts there): a page loaded without the bypass.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type Command, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView, type FakeContents } from './fake-view';
import type * as PickersModule from '../../src/main/agents/pickers';

type Pickers = typeof PickersModule;

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
/** The hold armed at once; the bypass answered when the test says. */
const bypass = { answer: (_ok: boolean) => {} };
vi.mock('../../src/main/agents/pickers', async (actual) => ({
  ...(await actual<Pickers>()),
  holdFilePickers: () => Promise.resolve(),
  bypassServiceWorkers: () => new Promise<boolean>((resolve) => (bypass.answer = resolve)),
  holdFailed: vi.fn(),
}));
const { TabManager } = await import('../../src/main/tabs');
const pickers = await import('../../src/main/agents/pickers');
const NODE = 'a1' as NodeId;
const FIRST = 'https://first.test/';
const SECOND = 'https://second.test/';

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: FIRST, title: '', section: 'today', chordId: 'ag' } as SidebarNode]), live: {}, windows: {}, chords: { ag: { id: 'ag' } }, settings: { tabCounts: {} } } as unknown as State;
  const manager = new TabManager({
    state: () => state,
    dispatch: (_c: Command) => undefined,
    sessionFor: () => ({}) as Session,
    proxyReady: () => null,
    agentTab: () => true,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
  } as never);
  const page = (manager.ensure(NODE) as unknown as FakeView).page as FakeContents;
  const loaded = () => page.loadURL.mock.calls.map(([url]) => url as string);
  return { manager, page, loaded };
}

describe('an agent tab’s first page overtaken while it’s primed (#277)', () => {
  it('your load is the page; the priming never lands the first address over it; the hold is failed', async () => {
    vi.mocked(pickers.holdFailed).mockClear();
    const t = setup();
    await tick();
    // Primed so far: the blank page, the bypass asked for.
    expect(t.loaded()).toEqual(['about:blank']);
    expect(pickers.firstLoadPending(t.page)).toBe(true);
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual(['about:blank', SECOND]);
    expect(pickers.holdFailed).toHaveBeenCalledWith(t.page);
    expect(pickers.firstLoadPending(t.page)).toBe(false);
    bypass.answer(true);
    await tick();
    expect(t.loaded()).toEqual(['about:blank', SECOND]);
  });

  it('its first page come: a later load is only a load (the hold stays)', async () => {
    vi.mocked(pickers.holdFailed).mockClear();
    const t = setup();
    await tick();
    bypass.answer(true);
    await tick();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    t.page.emit('did-navigate', {}, FIRST);
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual(['about:blank', FIRST, SECOND]);
    expect(pickers.holdFailed).not.toHaveBeenCalled();
  });
});
