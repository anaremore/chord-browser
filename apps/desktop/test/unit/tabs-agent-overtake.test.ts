/**
 * #277 (from #272's round 2; round 1 of #282): a load asked for over an agent tab's first page before it came (you, in
 * the address bar), or your Stop while it waits or is being primed (a blank page loaded, its service workers being
 * bypassed), fails the tab's hold for good: nothing acts there, and a hold failed is never armed again behind your back
 * (Neon's B1). The overtaking page is the tab's, its address and title reported (Neon's SF2). With the REAL hold
 * (agents/pickers.ts) on a fake debugger: a mocked one hid B1.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type Command, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeView, type FakeContents } from './fake-view';

/** Debugger commands held until the test lets them answer (by method). */
const holding = new Map<string, { promise: Promise<void>; release: () => void }>();
const hold = (method: string) => {
  let release = () => {};
  const promise = new Promise<void>((r) => (release = r));
  holding.set(method, { promise, release });
  return () => (holding.delete(method), release());
};

/** Every command any agent page's debugger was sent, by method. */
const sent: string[] = [];
/** The blank page's load, answered when the test says (null: at once). */
const blank = { held: null as null | Promise<void> };

/** A page with a debugger that answers every command (after any hold on it), and its address as last loaded. */
class AgentView extends FakeView {
  constructor() {
    super();
    const page = this.page as FakeContents & Record<string, unknown>;
    const events = new EventEmitter();
    let attached = false;
    let url = '';
    page['getURL'] = () => url;
    page.loadURL.mockImplementation((to: string) => {
      if (page.destroyed) throw new Error('Object has been destroyed');
      return loadInto(to);
    });
    const loadInto = async (to: string) => {
      url = to;
      if (to === 'about:blank' && blank.held) await blank.held;
    };
    page['debugger'] = {
      isAttached: () => attached,
      attach: () => void (attached = true),
      on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
      sendCommand: async (method: string) => {
        sent.push(method);
        await holding.get(method)?.promise;
        return method === 'Runtime.evaluate' ? { result: { value: true } } : undefined;
      },
    };
  }
}

vi.mock('electron', async () => ({
  WebContentsView: AgentView,
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
const pickers = await import('../../src/main/agents/pickers');
const NODE = 'a1' as NodeId;
const FIRST = 'https://first.test/';
const SECOND = 'https://second.test/';

afterEach(() => {
  for (const { release } of holding.values()) release();
  holding.clear();
  sent.length = 0;
  blank.held = null;
  vi.useRealTimers();
});

/** An agent's tab, its session waiting on `gate` (null: ready). */
function setup(gate: Promise<void> | null = null) {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: FIRST, title: '', section: 'today', chordId: 'ag' } as SidebarNode]), live: {}, windows: {}, chords: { ag: { id: 'ag' } }, settings: { tabCounts: {} } } as unknown as State;
  let waiting = gate;
  void gate?.then(() => (waiting = null));
  const commands: Command[] = [];
  const manager = new TabManager({
    state: () => state,
    dispatch: (c: Command) => void commands.push(c),
    sessionFor: () => ({}) as Session,
    proxyReady: () => waiting,
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
  return { manager, page, loaded, commands };
}

/** The hold's arming and the tab's priming as far as they go (real timers: a few event-loop turns). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('an agent tab’s first page overtaken, or stopped (#277, round 1 of #282)', () => {
  it('overtaken while primed: your load is the page, reported as the tab’s; the priming never lands over it; the hold failed for good', async () => {
    // The bypass (its last command) answers when the test says.
    const bypass = hold('Page.addScriptToEvaluateOnNewDocument');
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank']);
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual(['about:blank', SECOND]);
    expect(pickers.pickersLost(t.page)).toBe(true);
    expect(pickers.firstLoadPending(t.page)).toBe(false);
    // SF2: the overtaking page commits before the bypass answers: it's the tab's, not swallowed as the blank page.
    t.page.emit('did-navigate', {}, SECOND, 200);
    expect(t.commands).toContainEqual(expect.objectContaining({ t: 'tab.updated', nodeId: NODE, url: SECOND }));
    bypass();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', SECOND]);
  });

  it('its first page come: a later load is only a load (the hold stays on)', async () => {
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    t.page.emit('did-navigate', {}, FIRST, 200);
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual(['about:blank', FIRST, SECOND]);
    expect(pickers.pickersLost(t.page)).toBe(false);
  });

  it('Stop while it waits for its session (SF1): nothing loads, the hold is failed, and never armed again behind your back (B1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The first arming in flight when Stop comes: its interception answers only later.
    const interception = hold('Page.setInterceptFileChooserDialog');
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const t = setup(gate);
    await settle();
    expect(t.manager.stopWaiting(t.page as never)).toBe(true);
    expect(pickers.pickersLost(t.page)).toBe(true);
    expect(pickers.pickersUnsecured(t.page)).toBe(true);
    expect(pickers.firstLoadPending(t.page)).toBe(false);
    interception();
    open();
    await settle();
    // Every re-arm the hold would try (250 ms, doubling, 8 times) has had its time: still failed.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5000);
      await settle();
    }
    expect(t.loaded()).toEqual([]);
    expect(pickers.pickersLost(t.page)).toBe(true);
    // A page that loads later (you, in the address bar) doesn't arm it again either.
    t.page.emit('did-finish-load');
    await settle();
    vi.advanceTimersByTime(5000);
    await settle();
    expect(pickers.pickersLost(t.page)).toBe(true);
    expect(await pickers.retryPickers(t.page)).toBe(false);
  });

  it('Stop while it’s primed (Opus N1): the same, and the priming never loads the first address', async () => {
    const bypass = hold('Page.addScriptToEvaluateOnNewDocument');
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank']);
    expect(t.manager.stopWaiting(t.page as never)).toBe(true);
    expect(pickers.pickersLost(t.page)).toBe(true);
    expect(pickers.firstLoadPending(t.page)).toBe(false);
    bypass();
    await settle();
    expect(t.loaded()).toEqual(['about:blank']);
  });

  it('overtaken while its blank page loads (#287): no bypass asked for, no first address, the hold failed', async () => {
    let answer = () => {};
    blank.held = new Promise<void>((r) => (answer = r));
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank']);
    t.manager.navigate(NODE, SECOND);
    sent.length = 0;
    answer();
    await settle();
    expect(sent).not.toContain('Network.setBypassServiceWorker');
    expect(t.loaded()).toEqual(['about:blank', SECOND]);
    expect(pickers.pickersLost(t.page)).toBe(true);
  });

  it('a navigation once its first page has started loading (#287): only a load, the hold stays on (bypassed, it is held)', async () => {
    const t = setup();
    await settle();
    // Its first page asked for, not committed yet (still connecting).
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    expect(pickers.firstLoadPending(t.page)).toBe(true);
    t.manager.navigate(NODE, SECOND);
    expect(t.loaded()).toEqual(['about:blank', FIRST, SECOND]);
    expect(pickers.pickersLost(t.page)).toBe(false);
  });

  it('Reload while it waits for its session, or while it’s primed (round 1 of #292, Opus’s N1): its hold stays on, its first page loads', async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const t = setup(gate);
    await settle();
    t.manager.reload(t.page as never);
    expect(pickers.pickersLost(t.page)).toBe(false);
    expect(pickers.firstLoadPending(t.page)).toBe(true);
    const bypass = hold('Page.addScriptToEvaluateOnNewDocument');
    open();
    await settle();
    expect(t.loaded()).toEqual(['about:blank']);
    // Primed now: Reload again, still left alone.
    t.manager.reload(t.page as never);
    bypass();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    expect(pickers.pickersLost(t.page)).toBe(false);
  });

  it('Reload from the sidebar or the tab menu while its hold is arming (Neon’s B1, round 1 of #292): nothing loads unheld, its first page comes', async () => {
    // The hold's interception answers only later: its arming is in flight.
    const interception = hold('Page.setInterceptFileChooserDialog');
    const t = setup();
    t.manager.reload(t.page as never);
    expect(t.loaded()).toEqual([]);
    expect(pickers.pickersLost(t.page)).toBe(true);
    interception();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    expect(pickers.pickersLost(t.page)).toBe(false);
  });

  it('Reload once its first page has started loading, not come yet (Neon’s B1): never a second load over it', async () => {
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    t.manager.reload(t.page as never);
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    expect(t.page.reload).not.toHaveBeenCalled();
    expect(pickers.pickersLost(t.page)).toBe(false);
  });

  it('Stop while its hold is arming (Neon’s SF1): it’s overtaken, the hold failed, nothing loads after', async () => {
    const interception = hold('Page.setInterceptFileChooserDialog');
    const t = setup();
    expect(t.manager.stopWaiting(t.page as never)).toBe(true);
    expect(pickers.pickersLost(t.page)).toBe(true);
    interception();
    await settle();
    expect(t.loaded()).toEqual([]);
  });

  it('a navigation queued behind a new gate once its first page started (Neon’s SF5): still pending until that one loads', async () => {
    let waiting: Promise<void> | null = null;
    const t = setup();
    (t.manager as unknown as { deps: { proxyReady: () => unknown } }).deps.proxyReady = () => waiting;
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    let open = () => {};
    waiting = new Promise<void>((r) => (open = () => ((waiting = null), r())));
    t.manager.navigate(NODE, SECOND);
    // Its first page commits while the navigation waits: a tool call still waits for the page it asked for.
    t.page.emit('did-navigate', {}, FIRST, 200);
    expect(pickers.firstLoadPending(t.page)).toBe(true);
    open();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST, SECOND]);
    expect(pickers.firstLoadPending(t.page)).toBe(false);
  });

  it('Stop once its first page has started loading: only the page’s own Stop, the hold stays on', async () => {
    const t = setup();
    await settle();
    expect(t.loaded()).toEqual(['about:blank', FIRST]);
    expect(t.manager.stopWaiting(t.page as never)).toBe(false);
    expect(pickers.pickersLost(t.page)).toBe(false);
  });
});
