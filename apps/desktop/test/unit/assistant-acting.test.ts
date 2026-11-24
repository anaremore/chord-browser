/**
 * The assistant acting in a tab of yours (S18 M2e-2a): where it may act (the message's tab, on screen alone, never an
 * agent's), the lease on the tab's debugger and send hold, and the cards it shows in the chat.
 */
import { EventEmitter } from 'node:events';
import { emptyState, nodeOf, TabRefs, type NodeId, type State, type TabNode } from '@chord/core';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuetChat, DuetHost } from '../../src/main/assistant/scope';
import type { SendHoldDeps } from '../../src/main/control/sends';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {}, net: {}, nativeImage: {}, ClipboardItem: class {} }));
const { AGENT_TAB_REFUSALS, duetScope, USER_TAB_REFUSALS } = await import('../../src/main/assistant/scope');
const { ControlAgent } = await import('../../src/main/control/gate');
const { Store } = await import('../../src/main/store');
const { beginUserAction, endUserAction, endUserLease, userLeaseLost, userTabActing, TAIL_MS } = await import('../../src/main/control/user-watch');
const { actCard } = await import('../../src/main/assistant/service');

afterEach(() => vi.useRealTimers());

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

function setup() {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['ag'] = { id: 'ag', profileId: 'default', name: 'Claude Code', icon: '✳', theme, rank: 'a1', createdAt: 1, agent: { name: 'Claude Code' } };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://game.example/table' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://shop.example/', background: true });
  const other = Object.values(store.state.nodes).flatMap((b) => Object.values(b)).find((n) => n.kind === 'tab' && n.id !== mine)!.id;
  store.dispatch({ t: 'agent.tab.add', chordId: 'ag', nodeId: 'a1', url: 'https://shop.example/checkout' });
  const chat: DuetChat = {
    chordId: 'c1',
    thread: null,
    refs: new TabRefs<NodeId>('t'),
    attached: new Set(),
    pointed: new Set(),
    actTab: { nodeId: mine, windowId: 'w1' },
    actEnded: null,
    windowId: 'w1',
    control: new ControlAgent('chat:1', async () => 'once'),
    pdfs: new Map(),
    form: null,
    nextField: 1,
    read: new Set(),
  };
  const looks = { on: true, alone: true };
  const lease = { begin: async () => null, end: () => undefined };
  const host = {
    browser: { store } as unknown as DuetHost['browser'],
    settings: () => ({ readsNothing: false, neverSites: [] }),
    readable: () => true,
    agentOf: (node: TabNode) => store.state.chords[node.chordId]?.agent?.name ?? null,
    activeTab: () => nodeOf(store.state, store.state.windows['w1']!.activeTab['c1']!) as TabNode,
    activity: async () => undefined,
    search: async () => [],
    fills: () => ({ refuse: () => null, show: async () => undefined }),
    acting: () => ({
      on: () => looks.on,
      shownAlone: (node: TabNode) => looks.alone && store.state.windows['w1']!.activeTab['c1'] === node.id,
      siteOf: (url: string) => new URL(url).hostname,
      siteAllowed: () => false,
      keepSite: () => undefined,
      doing: () => undefined,
      lease,
    }),
  } satisfies DuetHost;
  const tab = (id: string) => nodeOf(store.state, id) as TabNode;
  return { store, chat, looks, scope: duetScope(chat, host, true), mine, other, tab };
}

describe('Where the assistant may act (S18 M2e-2a, A1)', () => {
  it('only the message’s tab, while it’s on screen alone; never an agent’s; switching away ends it for the message', () => {
    // [what, set up, the tab asked about, the refusal or null]
    const rows: [string, (t: ReturnType<typeof setup>) => void, (t: ReturnType<typeof setup>) => string, (t: ReturnType<typeof setup>) => string | null][] = [
      ['the message’s tab, on screen', () => undefined, (t) => t.mine, () => null],
      ['another tab of yours', () => undefined, (t) => t.other, () => USER_TAB_REFUSALS.notThatTab('https://game.example/table')],
      ['an agent’s tab', () => undefined, () => 'a1', () => AGENT_TAB_REFUSALS.act('Claude Code')],
      ['no message (between turns)', (t) => void (t.chat.actTab = null), (t) => t.mine, () => USER_TAB_REFUSALS.noMessage],
      ['acting turned off', (t) => void (t.looks.on = false), (t) => t.mine, () => USER_TAB_REFUSALS.off],
      ['the window minimized, or Peek over it: over for the message', (t) => void (t.looks.alone = false), (t) => t.mine, () => USER_TAB_REFUSALS.switched],
      ['you switched to another tab', (t) => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other }), (t) => t.mine, () => USER_TAB_REFUSALS.switched],
      ['you used the tab', (t) => void (t.chat.actEnded = USER_TAB_REFUSALS.tookOver), (t) => t.mine, () => USER_TAB_REFUSALS.tookOver],
    ];
    for (const [what, arrange, which, expected] of rows) {
      const t = setup();
      arrange(t);
      const node = t.tab(which(t));
      expect(t.scope.act!.mayAct(node), what).toBe(expected(t));
    }
  });

  it('once off screen, not back for the rest of the message: switching back doesn’t let it act again', () => {
    const t = setup();
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    expect(t.scope.act!.mayAct(t.tab(t.mine))).toBe(USER_TAB_REFUSALS.switched);
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(t.scope.act!.mayAct(t.tab(t.mine))).toBe(USER_TAB_REFUSALS.switched);
  });
});

/** A tab of yours, with a debugger nobody has attached. */
function yourTab() {
  const debug = new EventEmitter();
  let attached = false;
  const sent: [string, string][] = [];
  Object.assign(debug, {
    isAttached: () => attached,
    attach: () => void (attached = true),
    detach: () => {
      attached = false;
      debug.emit('detach', {}, 'target closed');
    },
    sendCommand: async (method: string, params: { requestId?: string }) => void sent.push([method, params?.requestId ?? '']),
  });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://game.example/table', debugger: debug }) as unknown as WebContents;
  const post = (requestId: string) => debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method: 'POST', url: 'https://game.example/move' }, resourceType: 'XHR' });
  const how = (requestId: string) => sent.find(([m, id]) => id === requestId && m.startsWith('Fetch.'))?.[0] ?? 'held';
  return { contents, debug, sent, post, how, attached: () => attached };
}

const deps = (ask: SendHoldDeps['ask'] = async () => 'once') => ({ siteOf: (u: string) => new URL(u).origin, ask });

describe('The lease on a tab of yours (S18 M2e-2a, C1)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('on for an action: the debugger and Fetch (requests only) on, what the page sends held and asked about in the chat; off a moment after', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    const asked: string[][] = [];
    expect(await beginUserAction(t.contents, 'chat:1', deps(async (sites) => (asked.push(sites), 'once')))).toBe('on');
    expect(t.attached()).toBe(true);
    expect(userTabActing(t.contents)).toBe(true);
    expect(t.sent.map(([m]) => m)).toEqual(expect.arrayContaining(['Fetch.enable', 'Target.setAutoAttach']));
    endUserAction(t.contents);
    // In the moment after the action, what the page sends is still asked about.
    t.post('r1');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual([['https://game.example']]);
    expect(t.how('r1')).toBe('Fetch.continueRequest');
    await vi.advanceTimersByTimeAsync(TAIL_MS + 100);
    // Let go of: Chord's own attachment detached, and the tab as it always was.
    expect(t.attached()).toBe(false);
    expect(userTabActing(t.contents)).toBe(false);
  });

  it('your input ends it at once: what was held for the assistant fails, and what the page sends while it lets go is yours (Neon’s B4 on #147)', async () => {
    const t = yourTab();
    expect(await beginUserAction(t.contents, 'chat:1', deps(() => new Promise(() => undefined)))).toBe('on');
    t.post('r1');
    await tick();
    expect(t.how('r1')).toBe('held');
    endUserLease(t.contents);
    expect(t.how('r1')).toBe('Fetch.failRequest');
    // Paused before Fetch is off: yours, it goes (never left waiting, never failed).
    t.post('r2');
    expect(t.how('r2')).toBe('Fetch.continueRequest');
    await tick();
    expect(userTabActing(t.contents)).toBe(false);
    expect(t.attached()).toBe(false);
  });

  it('one owner: another chat acting in the tab meanwhile is refused, even when both begin at once (Neon’s B3 on #147, E8)', async () => {
    const t = yourTab();
    const [one, two] = await Promise.all([beginUserAction(t.contents, 'chat:1', deps()), beginUserAction(t.contents, 'chat:2', deps())]);
    expect([one, two]).toEqual(['on', 'busy']);
    expect(t.sent.filter(([m]) => m === 'Fetch.enable')).toHaveLength(1);
    // Its own next action joins.
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    expect(t.sent.filter(([m]) => m === 'Fetch.enable')).toHaveLength(1);
    endUserLease(t.contents);
  });

  it('the debugger let go mid-lease (DevTools, a detach): lost, the action hears it, never rejoined (Neon’s B1 on #147)', async () => {
    const t = yourTab();
    const asked: string[][] = [];
    await beginUserAction(t.contents, 'chat:1', deps((sites) => (asked.push(sites), new Promise(() => undefined))));
    (t.contents.debugger as unknown as { detach(): void }).detach();
    // (What was paused when the debugger let go is Chromium's to continue: a stated limit in the record.)
    expect(userTabActing(t.contents)).toBe(false);
    // The hold is gone with it: nothing it sees from now is asked about as the assistant's.
    t.post('r2');
    await tick();
    expect(asked).toEqual([]);
    expect(userLeaseLost(t.contents)).toBe(true);
    // The next action has a lease of its own (attached again), and isn't lost.
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    expect(userLeaseLost(t.contents)).toBe(false);
    endUserLease(t.contents);
  });

  it('the page’s renderer gone mid-lease: lost, the same', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', deps());
    (t.contents as unknown as EventEmitter).emit('render-process-gone', {}, { reason: 'crashed' });
    expect(userTabActing(t.contents)).toBe(false);
    expect(userLeaseLost(t.contents)).toBe(true);
  });

  it('a frame that can’t be held stays paused at its start, never run unheld (Claude’s S3 on #147)', async () => {
    const t = yourTab();
    const sendCommand = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
    (t.debug as unknown as { sendCommand: typeof sendCommand }).sendCommand = async (m, p, s) => {
      if (s === 'f1' && m === 'Fetch.enable') throw new Error('target closed');
      return sendCommand(m, p, s);
    };
    await beginUserAction(t.contents, 'chat:1', deps());
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f2', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    await tick();
    await tick();
    const resumed = t.sent.filter(([m]) => m === 'Runtime.runIfWaitingForDebugger').length;
    expect(resumed).toBe(1);
    endUserLease(t.contents);
  });

  it('a second action joins the lease, and the lease lasts until the last one’s moment after', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', deps());
    await beginUserAction(t.contents, 'chat:1', deps());
    expect(t.sent.filter(([m]) => m === 'Fetch.enable')).toHaveLength(1);
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(TAIL_MS + 100);
    expect(userTabActing(t.contents)).toBe(true);
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(TAIL_MS + 100);
    expect(userTabActing(t.contents)).toBe(false);
  });

  it('a debugger it can’t have (your DevTools): no lease, nothing pressed or typed', async () => {
    const t = yourTab();
    (t.contents.debugger as unknown as { attach: () => void }).attach = () => {
      throw new Error('Another debugger is already attached');
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps(async () => 'deny'))).toBe('no');
    expect(userTabActing(t.contents)).toBe(false);
  });
});

describe('The acting cards in the chat (S18 M2e-2a)', () => {
  const base = { id: 'c1', tool: 'click', target: ['https://game.example/table'], tab: 'n1' };
  it('each in Chord’s words: the site card, a risky step, what an action sends', () => {
    expect(actCard({ ...base, kind: 'site', subject: 'game.example', description: 'click “Raise”' })).toEqual({
      kind: 'site',
      title: 'Let the assistant click and type on game.example?',
      note: 'It wants to click “Raise”.',
      lines: ['It asks before anything it does sends data, and before it submits, pays, sends or deletes.'],
      danger: false,
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'click “Place order”', step: { why: 'pay', site: 'shop.example', fields: ['Shipping', 'Card'], more: 0 } })).toEqual({
      kind: 'step',
      title: 'Place the order on shop.example?',
      note: 'The assistant is about to click “Place order”.',
      lines: ['Goes with it: Shipping, Card'],
      danger: true,
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'Clicked “Raise”', step: { why: 'send', site: 'https://game.example', fields: [], more: 0, sends: ['https://game.example'] } })).toEqual({
      kind: 'send',
      title: 'Send data to https://game.example?',
      note: 'The assistant clicked “Raise”, and the page is sending something to its site.',
      lines: ['Goes to: https://game.example'],
      danger: false,
    });
    expect(actCard({ ...base, kind: 'read', subject: 'read_tab', description: 'Read “Article”' })).toBeNull();
  });
});
