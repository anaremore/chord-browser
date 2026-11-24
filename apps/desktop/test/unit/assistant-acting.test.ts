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
const { AFTER_MS, TAIL_MS, beginUserAction, endUserAction, endUserLease, userTabActing, userTabCatching } = await import('../../src/main/control/user-watch');
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
      ['in a split, or the window minimized', (t) => void (t.looks.alone = false), (t) => t.mine, () => USER_TAB_REFUSALS.split],
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
  const sent: [string, string, unknown][] = [];
  Object.assign(debug, {
    isAttached: () => attached,
    attach: () => void (attached = true),
    detach: () => void (attached = false),
    sendCommand: async (method: string, params: { requestId?: string }) => void sent.push([method, params?.requestId ?? '', params]),
  });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://game.example/table', debugger: debug }) as unknown as WebContents;
  const post = (requestId: string) => debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method: 'POST', url: 'https://game.example/move' }, resourceType: 'XHR' });
  const how = (requestId: string) => sent.find(([m, id]) => id === requestId && m.startsWith('Fetch.'))?.[0] ?? 'held';
  const notes: string[] = [];
  let clip = 'yours';
  const deps = (ask: SendHoldDeps['ask'] = async () => 'once') => ({
    siteOf: (u: string) => new URL(u).origin,
    ask,
    note: (what: string, detail: string) => void notes.push(`${what}: ${detail}`),
    askDownload: async () => false,
    clipboard: { read: () => clip, write: (text: string) => void (clip = text) },
  });
  return { contents, debug, sent, post, how, notes, deps, clip: { get: () => clip, set: (text: string) => void (clip = text) }, attached: () => attached };
}

describe('The lease on a tab of yours (S18 M2e-2a, C1; M2e-2b, A6)', () => {
  it('on for an action: the debugger, Fetch (requests only) and its catches on; what the page sends held and asked about for a moment after, then yours; off once its click can set nothing off', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    const asked: string[][] = [];
    expect(await beginUserAction(t.contents, t.deps(async (sites) => (asked.push(sites), 'once')))).toBe(true);
    expect(t.attached()).toBe(true);
    expect(userTabActing(t.contents)).toBe(true);
    const methods = t.sent.map(([m]) => m);
    expect(methods).toEqual(expect.arrayContaining(['Fetch.enable', 'Target.setAutoAttach', 'Page.setInterceptFileChooserDialog', 'WebAuthn.enable', 'FedCm.enable', 'Network.setBypassServiceWorker']));
    expect(t.sent.find(([m]) => m === 'WebAuthn.enable')?.[2]).toEqual({ enableUI: false });
    expect(t.sent.find(([m]) => m === 'Network.setBypassServiceWorker')?.[2]).toEqual({ bypass: true });
    endUserAction(t.contents);
    // In the moment after the action, what the page sends is still asked about.
    t.post('r1');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual([['https://game.example']]);
    expect(t.how('r1')).toBe('Fetch.continueRequest');
    // After it, the page's own sends are yours again (no card), but its click can still set things off.
    await vi.advanceTimersByTimeAsync(TAIL_MS + 10);
    t.post('r2');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.how('r2')).toBe('Fetch.continueRequest');
    expect(asked).toHaveLength(1);
    expect(userTabActing(t.contents)).toBe(false);
    expect(userTabCatching(t.contents)).toBe(true);
    await vi.advanceTimersByTimeAsync(AFTER_MS);
    // Let go of: the service worker back first, Chord's own attachment detached, the tab as it always was.
    expect(t.sent.filter(([m]) => m === 'Network.setBypassServiceWorker').at(-1)?.[2]).toEqual({ bypass: false });
    expect(t.attached()).toBe(false);
    expect(userTabCatching(t.contents)).toBe(false);
  });

  it('what its click sets off is caught and said: a file picker, a dialog, a sign-in with another site (dismissed)', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, t.deps());
    t.debug.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' });
    t.debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave the table?' });
    t.debug.emit('message', {}, 'FedCm.dialogShown', { dialogId: 'd1', accounts: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.notes).toEqual(['file: a file picker', 'dialog: confirm: “Leave the table?”', 'signin: a sign-in with another site']);
    expect(t.sent.find(([m]) => m === 'FedCm.dismissDialog')?.[2]).toEqual({ dialogId: 'd1' });
    endUserLease(t.contents);
  });

  it('the clipboard the page changed in the window is put back; one you change after your own input is yours', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    await beginUserAction(t.contents, t.deps());
    endUserAction(t.contents);
    t.clip.set('the page’s');
    await vi.advanceTimersByTimeAsync(AFTER_MS + 10);
    expect(t.clip.get()).toBe('yours');
    expect(t.notes).toContain('clipboard: the clipboard, put back');
    // Your input ends it first: what you copy is yours.
    const u = yourTab();
    await beginUserAction(u.contents, u.deps());
    u.clip.set('copied by you');
    endUserLease(u.contents);
    await vi.advanceTimersByTimeAsync(0);
    expect(u.clip.get()).toBe('copied by you');
  });

  it('your input ends it at once: what was held for the assistant fails, the service worker is back, and nothing of yours is held from then', async () => {
    const t = yourTab();
    expect(await beginUserAction(t.contents, t.deps(() => new Promise(() => undefined)))).toBe(true);
    t.post('r1');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.how('r1')).toBe('held');
    endUserLease(t.contents);
    expect(t.how('r1')).toBe('Fetch.failRequest');
    await new Promise((r) => setTimeout(r, 0));
    expect(userTabCatching(t.contents)).toBe(false);
    expect(t.sent.filter(([m]) => m === 'Network.setBypassServiceWorker').at(-1)?.[2]).toEqual({ bypass: false });
    expect(t.attached()).toBe(false);
  });

  it('a second action joins the lease, and the lease lasts until the last one’s moment after', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    await beginUserAction(t.contents, t.deps());
    await beginUserAction(t.contents, t.deps());
    expect(t.sent.filter(([m]) => m === 'Fetch.enable')).toHaveLength(1);
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(AFTER_MS + 100);
    expect(userTabActing(t.contents)).toBe(true);
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(AFTER_MS + 100);
    expect(userTabCatching(t.contents)).toBe(false);
  });

  it('a debugger it can’t have (your DevTools): no lease, nothing pressed or typed', async () => {
    const t = yourTab();
    (t.contents.debugger as unknown as { attach: () => void }).attach = () => {
      throw new Error('Another debugger is already attached');
    };
    expect(await beginUserAction(t.contents, t.deps(async () => 'deny'))).toBe(false);
    expect(userTabCatching(t.contents)).toBe(false);
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
