/**
 * The assistant acting in a tab of yours (S18 M2e-2a): where it may act (the message's tab, on screen alone, never an
 * agent's), the lease on the tab's debugger and send hold, and the cards it shows in the chat.
 */
import { EventEmitter } from 'node:events';
import { assistantTools, emptyState, nodeOf, TabRefs, type NodeId, type State, type TabNode } from '@chord/core';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuetChat, DuetHost } from '../../src/main/assistant/scope';
import type { SendHoldDeps } from '../../src/main/control/sends';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {}, net: {}, nativeImage: {}, ClipboardItem: class {} }));
const { AGENT_TAB_REFUSALS, duetScope, USER_TAB_REFUSALS } = await import('../../src/main/assistant/scope');
const { ControlAgent } = await import('../../src/main/control/gate');
const { Store } = await import('../../src/main/store');
const watch = await import('../../src/main/control/user-watch');
const { AFTER_MS, askUserTabDownload, COMMAND_MS, endUserLease, onUserLease, onUserLeaseEnd, printTokenOf, PRINT_HOLD_MS, userLeaseLost, userTabActing, userTabCatching, userTabGoing, TAIL_MS } = watch;
const { PRINT_HOLD_WORLD, printAsks, printBinding, printHold, printUntil } = await import('../../src/main/agents/agent-scripts');
/** Each action's own end, by tab, as its begin handed it (round 3 of #147: an end belongs to its own lease). */
const actionEnds = new Map<object, (() => void)[]>();
const beginUserAction = async (...args: Parameters<typeof watch.beginUserAction>) => {
  const action = await watch.beginUserAction(...args);
  if (action.begun === 'on') actionEnds.set(args[0], [...(actionEnds.get(args[0]) ?? []), action.end]);
  return action.begun;
};
/** The oldest action still under way in the tab, ended. */
const endUserAction = (contents: object) => actionEnds.get(contents)?.shift()?.();
const { actCard, downloadShown, outlivesTurn, plainNote } = await import('../../src/main/assistant/service');

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
    elsewhere: false,
    readFrom: new Set(),
    listed: new Set(),
    windowId: 'w1',
    control: new ControlAgent('chat:1', async () => 'once'),
    pdfs: new Map(),
    form: null,
    nextField: 1,
    read: new Set(),
  };
  const looks = { on: true, alone: true };
  const lease = { begin: async () => null, end: () => undefined, going: () => undefined };
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
      offScreen: (node: TabNode) => (!looks.alone ? 'its window was minimized' : store.state.windows['w1']!.activeTab['c1'] === node.id ? null : 'another tab is on screen in its window'),
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
      ['the window minimized, or Peek over it: over for the message, saying which', (t) => void (t.looks.alone = false), (t) => t.mine, () => USER_TAB_REFUSALS.switched('its window was minimized')],
      ['you switched to another tab', (t) => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other }), (t) => t.mine, () => USER_TAB_REFUSALS.switched('another tab is on screen in its window')],
      ['you used the tab', (t) => void (t.chat.actEnded = USER_TAB_REFUSALS.tookOver), (t) => t.mine, () => USER_TAB_REFUSALS.tookOver],
    ];
    for (const [what, arrange, which, expected] of rows) {
      const t = setup();
      arrange(t);
      const node = t.tab(which(t));
      expect(t.scope.act!.mayAct(node), what).toBe(expected(t));
    }
  });

  it('never batch nor wait_for: outside agents’ alone, by the list it’s given and by its scope (M2g-1 beside M2e-2c)', () => {
    const names = assistantTools(true, true).map((t) => t.name);
    expect(names).toContain('click');
    expect(names).not.toContain('wait_for');
    expect(names).not.toContain('batch');
    expect((setup().scope as { waits?: boolean }).waits).toBeFalsy();
  });

  it('leaving the site asks, every time, with the address; the same site doesn’t (M2e-2c, B3)', () => {
    const t = setup();
    const leaving = t.scope.act!.leaving!;
    expect(leaving('https://game.example/table', 'https://game.example/rules')).toBe(false);
    expect(leaving('https://game.example/table', 'https://tracker.example/collect?q=secret')).toBe(true);
    expect(leaving('https://game.example/table', 'mailto:someone@example.test')).toBe(true);
    // From https to plain http on the same site is leaving too: what it carries goes in the clear (Neon's SF5 on #151).
    expect(leaving('https://game.example/table', 'http://game.example/collect?q=secret')).toBe(true);
    expect(leaving('http://game.example/table', 'https://game.example/rules')).toBe(false);
  });

  it('what taints is what it read, by site: the same tab read on another site, other tabs listed (Neon’s B3 on #151)', () => {
    const here = 'https://game.example/table';
    // [what, set up, whether its typing asks]
    const rows: [string, (t: ReturnType<typeof setup>) => void, boolean][] = [
      ['this tab, read here', (t) => (t.chat.read.add(t.mine), t.chat.readFrom!.add('https://game.example')), false],
      ['this tab, read when it was on another site', (t) => (t.chat.read.add(t.mine), t.chat.readFrom!.add('https://mail.example')), true],
      ['the list of tabs, with another tab in it', (t) => t.chat.listed!.add(t.other), true],
      ['the list of tabs, with only this one', (t) => t.chat.listed!.add(t.mine), false],
      ['something from elsewhere (history, an image, an earlier session)', (t) => void (t.chat.elsewhere = true), true],
    ];
    for (const [what, arrange, asks] of rows) {
      const t = setup();
      arrange(t);
      expect(t.scope.act!.typeAsks!(t.tab(t.mine), here), what).toBe(asks);
    }
  });

  it('a chat that read anything but the tab it acts on shows what it types first (M2e-2c, B3; the owner’s answer 6)', () => {
    const t = setup();
    const asks = () => t.scope.act!.typeAsks!(t.tab(t.mine), 'https://game.example/table');
    expect(asks()).toBe(false);
    // It read the tab it acts on: nothing to show.
    t.chat.read.add(t.mine);
    expect(asks()).toBe(false);
    // Another tab of yours, read in this chat (or an attached one, or an agent's you pointed at).
    t.chat.read.add(t.other);
    expect(asks()).toBe(true);
    // History or the archive, searched.
    const u = setup();
    u.chat.elsewhere = true;
    expect(u.scope.act!.typeAsks!(u.tab(u.mine), 'https://game.example/table')).toBe(true);
  });

  it('searching history or the archive marks the chat as having read elsewhere (Claude’s review of #151: a gate only the E2E caught)', async () => {
    const t = setup();
    await t.scope.search!('search_history', 'order');
    expect(t.chat.elsewhere).toBe(true);
    expect(t.scope.act!.typeAsks!(t.tab(t.mine), 'https://game.example/table')).toBe(true);
  });

  it('once off screen, not back for the rest of the message: switching back doesn’t let it act again', () => {
    const t = setup();
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    const gone = USER_TAB_REFUSALS.switched('another tab is on screen in its window');
    expect(t.scope.act!.mayAct(t.tab(t.mine))).toBe(gone);
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(t.scope.act!.mayAct(t.tab(t.mine))).toBe(gone);
  });
});

/** A tab of yours, with a debugger nobody has attached. */
function yourTab() {
  const debug = new EventEmitter();
  let attached = false;
  const sent: [string, string, string | undefined, unknown][] = [];
  let scripts = 0;
  let printSessions = 0;
  Object.assign(debug, {
    isAttached: () => attached,
    attach: () => void (attached = true),
    detach: () => {
      attached = false;
      debug.emit('detach', {}, 'target closed');
    },
    sendCommand: async (method: string, params: { requestId?: string }, sessionId?: string) => {
      sent.push([method, params?.requestId ?? '', sessionId, params]);
      // #338: each print script's own name, for its removal; the page's own target, and the lease's session on it.
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `script-${++scripts}` };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'the-page', type: 'page' } };
      if (method === 'Target.attachToTarget') return { sessionId: `print-${++printSessions}` };
      return undefined;
    },
  });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://game.example/table', debugger: debug }) as unknown as WebContents;
  const post = (requestId: string) => debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method: 'POST', url: 'https://game.example/move' }, resourceType: 'XHR' });
  const how = (requestId: string) => sent.find(([m, id]) => id === requestId && m.startsWith('Fetch.'))?.[0] ?? 'held';
  const notes: string[] = [];
  let clip = 'yours';
  /** The lease's deps with what M2e-2b's catches say (notes) and the clipboard as this tab's test sets it. */
  /** Whether what's on the clipboard can be put back (false: it held files). */
  let restorable = true;
  const tabDeps = (ask: SendHoldDeps['ask'] = async () => 'once') => ({
    ...deps(ask),
    note: (what: string, detail: string) => void notes.push(`${what}: ${detail}`),
    clipboard: { snapshot: async () => ({ text: clip }), same: async (s: unknown) => (s as { text: string }).text === clip, restore: async (s: unknown) => (restorable ? ((clip = (s as { text: string }).text), true) : false) },
  });
  /** The page copies (its copy event, from the preload): the clipboard is the page's now. */
  const pageCopies = (text: string) => {
    clip = text;
    watch.userTabCopied(contents);
  };
  const bypass = () => sent.filter(([m]) => m === 'Network.setBypassServiceWorker').at(-1)?.[3];
  return { contents, debug, sent, post, how, notes, deps: tabDeps, bypass, pageCopies, clip: { get: () => clip, set: (text: string) => void (clip = text), unrestorable: () => void (restorable = false) }, attached: () => attached };
}

const deps = (ask: SendHoldDeps['ask'] = async () => 'once') => ({ siteOf: (u: string) => new URL(u).origin, ask, note: () => undefined, askDownload: async () => false, siteOfPage: (u: string) => new URL(u).hostname });

describe('The lease on a tab of yours (S18 M2e-2a, C1)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('on for an action: the debugger, Fetch (requests only) and its catches on; what the page sends held and asked about for a moment after, then yours; off once its click can set nothing off (M2e-2b)', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    const asked: string[][] = [];
    expect(await beginUserAction(t.contents, 'chat:1', t.deps(async (sites) => (asked.push(sites), 'once')))).toBe('on');
    expect(t.attached()).toBe(true);
    expect(userTabActing(t.contents)).toBe(true);
    expect(t.sent.map(([m]) => m)).toEqual(expect.arrayContaining(['Fetch.enable', 'Target.setAutoAttach', 'Page.setInterceptFileChooserDialog', 'WebAuthn.enable', 'Network.setBypassServiceWorker']));
    expect(t.sent.find(([m]) => m === 'WebAuthn.enable')?.[3]).toEqual({ enableUI: false });
    expect(t.bypass()).toEqual({ bypass: true });
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
    expect(t.bypass()).toEqual({ bypass: false });
    expect(t.attached()).toBe(false);
    expect(userTabCatching(t.contents)).toBe(false);
  });

  it('what its click sets off is caught and said: a file picker, a dialog; FedCM left alone (Electron has no UI for it) (M2e-2b)', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    t.debug.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' });
    t.debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave the table?' });
    await tick();
    expect(t.notes).toEqual(['file: a file picker', 'dialog: confirm: “Leave the table?”']);
    // FedCM is left alone (Electron has no UI for it, and the page's request fails by itself): never enabled, never
    // dismissed (dismissing takes the app down: Neon's B2 on #150, checked in the build's E2E).
    expect(t.sent.some(([m]) => m.startsWith('FedCm.'))).toBe(false);
    endUserLease(t.contents);
  });

  it('the clipboard the page changed in the window is put back; one you change after your own input is yours (M2e-2b)', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    endUserAction(t.contents);
    t.pageCopies('the page’s');
    await vi.advanceTimersByTimeAsync(AFTER_MS + 10);
    expect(t.clip.get()).toBe('yours');
    expect(t.notes).toContain('clipboard: put back');
    const u = yourTab();
    await beginUserAction(u.contents, 'chat:1', u.deps());
    u.clip.set('copied by you');
    endUserLease(u.contents);
    await vi.advanceTimersByTimeAsync(0);
    expect(u.clip.get()).toBe('copied by you');
  });

  it('the clipboard is put back only when the page copied, only if it’s still what the page put there, and never cleared when it can’t be (Claude’s B2, round 2 of #150)', async () => {
    vi.useFakeTimers();
    // Changed with no copy from the page (you, in the chat or another app): yours, left alone.
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    t.clip.set('copied by you elsewhere');
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(AFTER_MS + 10);
    expect(t.clip.get()).toBe('copied by you elsewhere');
    // Never put back, but said once: a frame's copy (which the page's top frame never sees) changes it the same way
    // (the final check of #150).
    expect(t.notes.filter((n) => n.startsWith('clipboard:'))).toEqual(['clipboard: changed']);
    // The page copied, then you copied elsewhere: yours, left alone.
    const u = yourTab();
    await beginUserAction(u.contents, 'chat:1', u.deps());
    u.pageCopies('the page’s');
    await vi.advanceTimersByTimeAsync(100);
    u.clip.set('copied by you after');
    endUserAction(u.contents);
    await vi.advanceTimersByTimeAsync(AFTER_MS + 10);
    expect(u.clip.get()).toBe('copied by you after');
    // What can't be put back (it held files): never cleared, and the chat says so.
    const w = yourTab();
    w.clip.unrestorable();
    await beginUserAction(w.contents, 'chat:1', w.deps());
    w.pageCopies('the page’s');
    await vi.advanceTimersByTimeAsync(100);
    endUserAction(w.contents);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.clip.get()).toBe('the page’s');
    expect(w.notes).toContain('clipboard: not put back');
  });

  it('the clipboard is put back as each action ends, and whenever the lease ends but by your own input: Stop, a tab switch, the panel closed, the debugger gone (Neon’s B6 on #150)', async () => {
    // As the action ends: not 6 s later.
    vi.useFakeTimers();
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    t.pageCopies('the page’s');
    await vi.advanceTimersByTimeAsync(100);
    endUserAction(t.contents);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.clip.get()).toBe('yours');
    vi.useRealTimers();
    // Every end that isn't your hands: the chat's Stop (and a tab switch, the panel closed: endActing), the debugger gone.
    for (const end of ['stop', 'detach', 'gone'] as const) {
      const u = yourTab();
      await beginUserAction(u.contents, 'chat:1', u.deps());
      u.pageCopies('the page’s');
      await new Promise((r) => setTimeout(r, 100));
      if (end === 'stop') endUserLease(u.contents, 'chat:1');
      else if (end === 'detach') (u.contents.debugger as unknown as { detach(): void }).detach();
      else (u.contents as unknown as EventEmitter).emit('render-process-gone', {}, { reason: 'crashed' });
      for (let i = 0; i < 4; i++) await tick();
      expect(u.clip.get(), end).toBe('yours');
    }
  });

  it('whatever ends the lease, the service worker is back: your input, a lost renderer (M2e-2b, C3)', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    endUserLease(t.contents);
    for (let i = 0; i < 4; i++) await tick();
    expect(t.bypass()).toEqual({ bypass: false });
    const u = yourTab();
    await beginUserAction(u.contents, 'chat:1', u.deps());
    (u.contents as unknown as EventEmitter).emit('render-process-gone', {}, { reason: 'crashed' });
    for (let i = 0; i < 4; i++) await tick();
    expect(u.bypass()).toEqual({ bypass: false });
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

  it('a page the assistant went to sending your tab on to another site is held, and asks as leaving does (M2e-2c, B3)', async () => {
    const t = yourTab();
    const asked: (string | null)[] = [];
    await beginUserAction(t.contents, 'chat:1', t.deps(async (_sites, why) => (asked.push(why), 'deny')));
    userTabGoing(t.contents, 'https://game.example/out');
    const doc = (requestId: string, url: string) => t.debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method: 'GET', url }, resourceType: 'Document' });
    // Where it asked to go: on its way. The same site's redirect: too. Another site's: held, and asked.
    doc('d1', 'https://game.example/out?to=https://tracker.example/');
    doc('d2', 'https://game.example/landing');
    doc('d3', 'https://tracker.example/collect?q=secret');
    await new Promise((r) => setTimeout(r, 0));
    expect([t.how('d1'), t.how('d2')]).toEqual(['Fetch.continueRequest', 'Fetch.continueRequest']);
    expect(asked).toEqual(['leave']);
    expect(t.how('d3')).toBe('Fetch.fulfillRequest');
    endUserLease(t.contents);
  });

  it('where it went is held through the tail: the page’s own redirect right after its load still asks, http on the same site asks, and the next action starts clean (Neon’s SF3, SF5 on #151)', async () => {
    const t = yourTab();
    const asked: (string | null)[] = [];
    await beginUserAction(t.contents, 'chat:1', t.deps(async (_sites, why) => (asked.push(why), 'deny')));
    userTabGoing(t.contents, 'https://game.example/out');
    const doc = (requestId: string, url: string) => t.debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method: 'GET', url }, resourceType: 'Document' });
    // Its load is done (the action ends); a meta refresh or a timer sends the tab on, inside the tail.
    endUserAction(t.contents);
    doc('m1', 'https://tracker.example/collect?q=secret');
    doc('h1', 'http://game.example/collect?q=secret');
    await tick();
    expect(asked).toEqual(['leave', 'leave']);
    expect([t.how('m1'), t.how('h1')]).toEqual(['Fetch.fulfillRequest', 'Fetch.fulfillRequest']);
    // The next action (a click, going nowhere it named): a link to another site is no leaving card's.
    await beginUserAction(t.contents, 'chat:1', t.deps(async (_sites, why) => (asked.push(why), 'deny')));
    doc('c1', 'https://news.example/');
    await tick();
    expect(t.how('c1')).toBe('Fetch.continueRequest');
    expect(asked).toHaveLength(2);
    endUserLease(t.contents);
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
    // Chord's attachment let go of, so the reloaded tab's requests never wait on a hold no one answers (Claude's S1, round 2).
    await tick();
    await tick();
    expect(t.attached()).toBe(false);
    t.post('r9');
    expect(t.how('r9')).toBe('held');
  });

  it('a chat ending lets go of its own lease only; your hands end anyone’s; the owner hears it ended; an action under way hears it lost (Claude’s B1, round 2)', async () => {
    const t = yourTab();
    const heard: string[] = [];
    const off = onUserLeaseEnd((_c, owner) => void heard.push(owner));
    await beginUserAction(t.contents, 'chat:1', deps());
    endUserLease(t.contents, 'chat:2');
    expect(userTabActing(t.contents)).toBe(true);
    endUserLease(t.contents, 'chat:1');
    expect(userTabActing(t.contents)).toBe(false);
    // The action (begun, not ended) was under way: lost for it.
    expect(userLeaseLost(t.contents)).toBe(true);
    await tick();
    await beginUserAction(t.contents, 'chat:2', deps());
    endUserLease(t.contents);
    expect(userTabActing(t.contents)).toBe(false);
    expect(heard).toEqual(['chat:1', 'chat:2']);
    off();
  });

  it('the hold listens before Fetch is on: a request paused as it turns on is answered (yours: the input hasn’t gone) (Neon’s B1, round 2)', async () => {
    const t = yourTab();
    const sendCommand = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
    (t.debug as unknown as { sendCommand: typeof sendCommand }).sendCommand = async (m, p, s) => {
      await sendCommand(m, p, s);
      if (m === 'Fetch.enable' && !s) t.post('early');
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    expect(t.how('early')).toBe('Fetch.continueRequest');
    endUserLease(t.contents);
  });

  it('the debugger gone while the lease is set up: no lease, never one with nothing on (Neon’s B1, round 2)', async () => {
    const t = yourTab();
    const sendCommand = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
    (t.debug as unknown as { sendCommand: typeof sendCommand }).sendCommand = async (m, p, s) => {
      await sendCommand(m, p, s);
      if (m === 'Target.setAutoAttach' && !s) (t.contents.debugger as unknown as { detach(): void }).detach();
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('no');
    expect(userTabActing(t.contents)).toBe(false);
  });

  it('ended while it was being set up (your key, or the chat’s Stop): no lease (Neon’s B2, round 2)', async () => {
    for (const by of [undefined, 'chat:1']) {
      const t = yourTab();
      const begun = beginUserAction(t.contents, 'chat:1', deps());
      endUserLease(t.contents, by);
      expect(await begun).toBe('no');
      expect(userTabActing(t.contents)).toBe(false);
      expect(t.attached()).toBe(false);
    }
    // Another chat's end doesn't cancel it.
    const u = yourTab();
    const begun = beginUserAction(u.contents, 'chat:1', deps());
    endUserLease(u.contents, 'chat:2');
    expect(await begun).toBe('on');
    endUserLease(u.contents);
  });

  it('a command that never answers: no lease after COMMAND_MS, and the debugger queue isn’t held', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    (t.debug as unknown as { sendCommand: () => Promise<void> }).sendCommand = () => new Promise(() => undefined);
    const begun = beginUserAction(t.contents, 'chat:1', deps());
    await vi.advanceTimersByTimeAsync(COMMAND_MS * 4);
    expect(await begun).toBe('no');
    expect(t.attached()).toBe(false);
  });

  it('frames: one there as it begins that can’t be held means no lease; one attaching from another is awaited too; one gone is let go of (Neon’s S3, round 2)', async () => {
    const t = yourTab();
    const sendCommand = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
    (t.debug as unknown as { sendCommand: typeof sendCommand }).sendCommand = async (m, p, s) => {
      if (s === 'bad' && m === 'Fetch.enable') throw new Error('target closed');
      await sendCommand(m, p, s);
      if (m === 'Target.setAutoAttach' && !s) t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'bad', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('no');
    const u = yourTab();
    const send = (u.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
    (u.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      await send(m, p, s);
      // The outer frame's own frame comes as the outer one turns on auto-attach.
      if (m === 'Target.setAutoAttach' && !s) u.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'outer', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
      if (m === 'Target.setAutoAttach' && s === 'outer') u.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'inner', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    };
    expect(await beginUserAction(u.contents, 'chat:1', deps())).toBe('on');
    expect(u.sent.filter(([m]) => m === 'Runtime.runIfWaitingForDebugger').map(([, , s]) => s)).toEqual(['outer', 'inner']);
    endUserLease(u.contents);
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

  it('Allow for this chat outlives the lease: the next action’s sends to that origin go without a card; your taking the tab ends it (Claude’s S1 and Neon’s S5 on #147)', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    const kept = new Set<string>();
    let asked = 0;
    const ask: SendHoldDeps['ask'] = async () => (asked++, 'until');
    await beginUserAction(t.contents, 'chat:1', { ...deps(ask), kept });
    endUserAction(t.contents);
    t.post('r1');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.how('r1')).toBe('Fetch.continueRequest');
    expect([...kept]).toEqual(['https://game.example']);
    // Past the moment after and its catches: the lease ends; the chat's grant doesn't.
    await vi.advanceTimersByTimeAsync(AFTER_MS + 100);
    expect(userTabCatching(t.contents)).toBe(false);
    await beginUserAction(t.contents, 'chat:1', { ...deps(ask), kept });
    t.post('r2');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.how('r2')).toBe('Fetch.continueRequest');
    expect(asked).toBe(1);
    endUserLease(t.contents);
  });

  /** #338: the print scripts added, by session: [script, its params]. */
  const printAdds = (t: ReturnType<typeof yourTab>) =>
    t.sent.filter(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument').map(([, , session, params]) => ({ session, ...(params as { source: string; worldName?: string; runImmediately?: boolean }) }));
  /** #338: the identifiers the fake handed out, in order (script-1, script-2, …), and those taken out. */
  const removed = (t: ReturnType<typeof yourTab>) => t.sent.filter(([m]) => m === 'Page.removeScriptToEvaluateOnNewDocument').map(([, , , params]) => (params as { identifier: string }).identifier);

  it('#338: prints held in each frame while it’s on: the binding, the hold and its deadline in the hold’s world, then the page’s own stub, each after Page.enable answers, in the page and in a frame (Argon’s B3)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    const token = printTokenOf(t.contents);
    // Page.enable answers a moment later: nothing of the print's is sent before it has, in each session.
    const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
    const enabled = new Set<string | undefined>();
    const early: string[] = [];
    (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      if (m === 'Page.enable') {
        await new Promise((r) => setTimeout(r, 5));
        enabled.add(s);
      }
      if ((m === 'Page.addScriptToEvaluateOnNewDocument' || (m === 'Runtime.addBinding' && s === 'f1')) && !enabled.has(s)) early.push(`${m} ${s}`);
      return send(m, p, s);
    };
    const before = Date.now();
    await beginUserAction(t.contents, 'chat:1', deps());
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(early).toEqual([]);
    // The page's binding: in the lease's own session on it (print-1), Runtime on there, never in the page's own session,
    // which the click and page_diagnostics turn on and off (deep.ts).
    expect(t.sent.find(([m]) => m === 'Target.attachToTarget')?.[3]).toEqual({ targetId: 'the-page', flatten: true });
    expect(t.sent.filter(([m]) => m === 'Runtime.enable' || m === 'Runtime.addBinding').map(([m, , s]) => `${m} ${s}`)).toEqual(
      expect.arrayContaining(['Runtime.enable print-1', 'Runtime.addBinding print-1', 'Runtime.enable f1', 'Runtime.addBinding f1']),
    );
    expect(t.sent.some(([m, , s]) => m.startsWith('Runtime.') && m !== 'Runtime.runIfWaitingForDebugger' && s === undefined)).toBe(false);
    for (const [session, said] of [[undefined, 'print-1'], ['f1', 'f1']] as const) {
      expect(t.sent.find(([m, , s]) => m === 'Runtime.addBinding' && s === said)?.[3], String(session)).toEqual({ name: printBinding(token), executionContextName: PRINT_HOLD_WORLD });
      const adds = printAdds(t).filter((a) => a.session === session);
      expect(adds.map((a) => [a.worldName ?? 'page', a.runImmediately]), String(session)).toEqual([
        [PRINT_HOLD_WORLD, true],
        [PRINT_HOLD_WORLD, true],
        ['page', true],
      ]);
      expect(adds[0]!.source).toBe(printHold(token));
      const until = Number(/= (\d+);/.exec(adds[1]!.source)![1]);
      expect(until).toBeGreaterThanOrEqual(before + PRINT_HOLD_MS);
      expect(adds[2]!.source).toBe(printAsks(token));
    }
    endUserLease(t.contents);
    for (let i = 0; i < 8; i++) await tick();
  });

  it('#338: a held print is said once an action, in fixed words (Fable’s SF1, Argon’s SF3); another binding’s call isn’t; the next action’s print is said too', async () => {
    const t = yourTab();
    const token = printTokenOf(t.contents);
    await beginUserAction(t.contents, 'chat:1', t.deps());
    const held = (name = printBinding(token)) => t.debug.emit('message', {}, 'Runtime.bindingCalled', { name, payload: 'print', executionContextId: 7 });
    held();
    held();
    held('somethingElse');
    expect(t.notes).toEqual(['print: ']);
    endUserAction(t.contents);
    await beginUserAction(t.contents, 'chat:1', t.deps());
    held();
    expect(t.notes).toEqual(['print: ', 'print: ']);
    endUserLease(t.contents);
    for (let i = 0; i < 8; i++) await tick();
    held();
    expect(t.notes).toEqual(['print: ', 'print: ']);
  });

  it.each([
    ['someone else’s attachment', true],
    ['Chord’s own', false],
  ])('#338: at its end, on %s: prints let go in every frame (the deadline over) first; on someone else’s, every script and the binding out (Fable’s B1, Argon’s SF2)', async (_, theirs) => {
    const t = yourTab();
    if (theirs) (t.debug as unknown as { attach(): void }).attach();
    await beginUserAction(t.contents, 'chat:1', deps());
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    await tick();
    const added = t.sent.length;
    endUserLease(t.contents);
    for (let i = 0; i < 10; i++) await tick();
    const after = t.sent.slice(added);
    // The deadline over, in the page and the frame, at once.
    for (const session of [undefined, 'f1']) {
      const over = after.find(([m, , s, p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && s === session && (p as { source: string }).source === printUntil(printTokenOf(t.contents), 0));
      expect(over?.[3], String(session)).toMatchObject({ worldName: PRINT_HOLD_WORLD, runImmediately: true });
    }
    if (theirs) {
      // Every script the lease added, out: none runs in a new document after it.
      const ids = Array.from({ length: printAdds(t).length }, (_, i) => `script-${i + 1}`);
      expect(new Set(removed(t))).toEqual(new Set(ids));
      expect(t.sent.filter(([m]) => m === 'Runtime.removeBinding').map(([, , s]) => s)).toEqual(['f1']);
      // The lease's own session on the page, let go; the page's own session's Runtime never touched.
      expect(after.filter(([m]) => m === 'Target.detachFromTarget').map(([, , , p]) => p)).toEqual([{ sessionId: 'print-1' }]);
      expect(after.some(([m, , s]) => m === 'Runtime.disable' && s === undefined)).toBe(false);
      expect(t.attached()).toBe(true);
    } else expect(t.attached()).toBe(false);
  });

  it('#338: a lease superseded on someone else’s attachment takes its print scripts out; the next lease’s go at its own end: all of them, never one left to run (Opus’s S1a; Neon’s B4, round 3, adapted)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    let first = true;
    const off = onUserLease((contents) => {
      if (contents !== t.contents || !first) return;
      first = false;
      endUserLease(t.contents, 'chat:1');
    });
    const [one, two] = await Promise.all([beginUserAction(t.contents, 'chat:1', deps()), beginUserAction(t.contents, 'chat:2', deps(() => new Promise(() => undefined)))]);
    off();
    for (let i = 0; i < 8; i++) await tick();
    expect([one, two]).toEqual(['on', 'on']);
    endUserLease(t.contents);
    for (let i = 0; i < 10; i++) await tick();
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(printAdds(t).length).toBeGreaterThan(3);
    expect(kept).toEqual([]);
    // Each lease's own session on the page, let go too.
    const opened = t.sent.filter(([m]) => m === 'Target.attachToTarget').length;
    expect(opened).toBeGreaterThan(1);
    expect(t.sent.filter(([m]) => m === 'Target.detachFromTarget').length).toBe(opened);
  });

  it('#338: a frame that came mid-lease, its print script still being added as the lease ends: taken out as it answers, never left to run (Opus’s S1b)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
    let answer: () => void = () => undefined;
    const late = new Promise<void>((done) => (answer = done));
    (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      // The frame's page stub answers only once the lease's end has gone by.
      if (m === 'Page.addScriptToEvaluateOnNewDocument' && s === 'f1' && !(p as { worldName?: string }).worldName) await late;
      return send(m, p, s);
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    for (let i = 0; i < 6; i++) await tick();
    endUserLease(t.contents);
    for (let i = 0; i < 12; i++) await tick();
    answer();
    for (let i = 0; i < 12; i++) await tick();
    const added = printAdds(t).filter((a) => a.session === 'f1' && !a.worldName);
    expect(added).toHaveLength(1);
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(kept).toEqual([]);
  });

  it('#338: the lease ended while a print script was being added: taken out as it answers, never kept (Opus’s S1b)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
    let once = true;
    (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      // The page's stub answers only after the lease has been ended.
      if (m === 'Page.addScriptToEvaluateOnNewDocument' && once && (p as { source: string }).source.startsWith('(() => {\n  const Doc')) {
        once = false;
        endUserLease(t.contents);
      }
      return send(m, p, s);
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('no');
    for (let i = 0; i < 10; i++) await tick();
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(kept).toEqual([]);
  });

  it('a frame gone is let go of: on someone else’s attachment, Fetch goes off in the frames still there, not in one gone', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    await beginUserAction(t.contents, 'chat:1', deps());
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f2', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    await tick();
    t.debug.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'f1' });
    endUserLease(t.contents);
    for (let i = 0; i < 6; i++) await tick();
    expect(t.sent.filter(([m]) => m === 'Fetch.disable').map(([, , s]) => s)).toEqual(['f2', undefined]);
    // Someone else's attachment stays.
    expect(t.attached()).toBe(true);
  });

  it('an action’s end belongs to its own lease: one ending late, after its lease was replaced, leaves the new lease alone (Neon’s B3, round 3)', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    const first = await watch.beginUserAction(t.contents, 'chat:1', deps());
    endUserLease(t.contents);
    await vi.advanceTimersByTimeAsync(0);
    const second = await watch.beginUserAction(t.contents, 'chat:1', deps());
    expect(second.begun).toBe('on');
    // Action 1's late finally: nothing happens to lease 2 (no tail started, its action still counted).
    first.end();
    first.end();
    await vi.advanceTimersByTimeAsync(TAIL_MS * 4);
    expect(userTabActing(t.contents)).toBe(true);
    expect(t.attached()).toBe(true);
    // Its own end, once: the tail, then off.
    second.end();
    second.end();
    await vi.advanceTimersByTimeAsync(TAIL_MS + 100);
    expect(userTabActing(t.contents)).toBe(false);
  });

  it('a lease’s cleanup that runs after the next lease was set up leaves the next one alone, and hands it Chord’s attachment (Neon’s B4, round 3)', async () => {
    const t = yourTab();
    // The first lease ends the moment it's handed out, while the second's set-up is already waiting in the queue.
    let first = true;
    const off = onUserLease((contents) => {
      if (contents !== t.contents || !first) return;
      first = false;
      // Its own chat's Stop: the other chat's begin goes on.
      endUserLease(t.contents, 'chat:1');
    });
    const [one, two] = await Promise.all([beginUserAction(t.contents, 'chat:1', deps()), beginUserAction(t.contents, 'chat:2', deps(() => new Promise(() => undefined)))]);
    off();
    for (let i = 0; i < 6; i++) await tick();
    expect([one, two]).toEqual(['on', 'on']);
    // The second lease is whole: attached, its hold on (what the page sends is held for it).
    expect(userTabActing(t.contents)).toBe(true);
    expect(t.attached()).toBe(true);
    t.post('r1');
    await tick();
    expect(t.how('r1')).toBe('held');
    // Ended, it lets go of the attachment it was handed.
    endUserLease(t.contents);
    for (let i = 0; i < 6; i++) await tick();
    expect(t.attached()).toBe(false);
  });

  it('a catch that can’t be turned on fails closed: on the page, no lease; on a frame there as it begins, no lease, the frame left paused (Neon’s B3 on #150)', async () => {
    for (const method of ['Page.enable', 'Page.setInterceptFileChooserDialog', 'WebAuthn.enable', 'Network.enable', 'Network.setBypassServiceWorker', 'Page.addScriptToEvaluateOnNewDocument']) {
      const t = yourTab();
      const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
      (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
        if (m === method && !s) throw new Error('not supported');
        return send(m, p, s);
      };
      expect(await beginUserAction(t.contents, 'chat:1', t.deps()), method).toBe('no');
      expect(t.attached(), method).toBe(false);
    }
    for (const method of ['Page.enable', 'Page.setInterceptFileChooserDialog', 'WebAuthn.enable', 'Network.enable', 'Network.setBypassServiceWorker', 'Page.addScriptToEvaluateOnNewDocument']) {
      const t = yourTab();
      const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<void> }).sendCommand;
      (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
        if (m === method && s === 'f1') throw new Error('target closed');
        await send(m, p, s);
        if (m === 'Target.setAutoAttach' && !s) t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
      };
      expect(await beginUserAction(t.contents, 'chat:1', t.deps()), `frame ${method}`).toBe('no');
      expect(t.sent.some(([m, , s]) => m === 'Runtime.runIfWaitingForDebugger' && s === 'f1'), `frame ${method}`).toBe(false);
    }
  });

  it.each(['Target.getTargetInfo', 'Target.attachToTarget', 'Runtime.enable', 'Runtime.addBinding'])(
    '#338: the page’s binding can’t be had (%s fails): the lease is still on and prints still held in the page, only not said',
    async (method) => {
      const t = yourTab();
      const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
      (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
        if (m === method && (s === undefined || s.startsWith('print-'))) throw new Error('not allowed');
        return send(m, p, s);
      };
      expect(await beginUserAction(t.contents, 'chat:1', t.deps())).toBe('on');
      const token = printTokenOf(t.contents);
      expect(t.sent.filter(([m, , s]) => m === 'Page.addScriptToEvaluateOnNewDocument' && s === undefined).map(([, , , p]) => (p as { source: string }).source)).toEqual(
        expect.arrayContaining([printHold(token), printAsks(token)]),
      );
      endUserLease(t.contents);
      for (let i = 0; i < 8; i++) await tick();
    },
  );

  /** #346: a tab of yours whose page has a frame in another process (f1), announced as the first lease's auto-attach is on. */
  const withFrame = (t: ReturnType<typeof yourTab>, gate?: (m: string, p: unknown, s?: string) => Promise<void> | undefined) => {
    const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
    let announced = false;
    (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      // Sent as it's called (a gate only when there is one), so what's sent at once is seen at once.
      const held = gate?.(m, p, s);
      if (held) await held;
      const answer = await send(m, p, s);
      if (m === 'Target.setAutoAttach' && !s && !announced) {
        announced = true;
        t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f1', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
      }
      return answer;
    };
  };
  const untilZero = (t: ReturnType<typeof yourTab>, from = 0) =>
    t.sent.slice(from).filter(([m, , , p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && (p as { source: string }).source === printUntil(printTokenOf(t.contents), 0)).map(([, , s]) => s);

  it.each(['Runtime.enable', 'Runtime.addBinding'])('#346: a frame’s binding that can’t be had (%s fails there): the lease is on, and that frame’s prints still held, only not said (Fable’s nit 2, round 2)', async (method) => {
    const t = yourTab();
    withFrame(t, async (m, _p, s) => {
      if (m === method && s === 'f1') throw new Error('not allowed');
    });
    expect(await beginUserAction(t.contents, 'chat:1', t.deps())).toBe('on');
    const token = printTokenOf(t.contents);
    expect(printAdds(t).filter((a) => a.session === 'f1').map((a) => a.source)).toEqual(expect.arrayContaining([printHold(token), printAsks(token)]));
    endUserLease(t.contents);
    for (let i = 0; i < 8; i++) await tick();
  });

  it('#346: a lease superseded while it held a frame in another process: the lease now on takes the frame on (held there through it), and lets it go at its own end (Neon’s B2, round 2 = Opus’s SF-A)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    withFrame(t);
    const token = printTokenOf(t.contents);
    let first = true;
    const off = onUserLease((contents) => {
      if (contents !== t.contents || !first) return;
      first = false;
      endUserLease(t.contents, 'chat:1');
    });
    const [one, two] = await Promise.all([beginUserAction(t.contents, 'chat:1', deps()), beginUserAction(t.contents, 'chat:2', deps(() => new Promise(() => undefined)))]);
    off();
    for (let i = 0; i < 12; i++) await tick();
    expect([one, two]).toEqual(['on', 'on']);
    // The first lease's frame, held by the second: its own hold and stub there (a second set), Fetch on again.
    const holds = printAdds(t).filter((a) => a.session === 'f1' && a.source === printHold(token));
    expect(holds).toHaveLength(2);
    expect(t.sent.filter(([m, , s]) => m === 'Fetch.enable' && s === 'f1')).toHaveLength(2);
    // Held while the second is on: in the page and in that frame, the last deadline sent is the second's, ahead (the
    // first's end let prints go before the second was set up; the second's deadline came after it).
    const mid = t.sent.length;
    const lastUntil = (session: string | undefined) =>
      Number(/= (\d+);/.exec([...printAdds(t)].reverse().find((a) => a.session === session && /UNTIL\] = \d+/.test(a.source))!.source)![1]);
    expect(lastUntil(undefined)).toBeGreaterThan(Date.now());
    expect(lastUntil('f1')).toBeGreaterThan(Date.now());
    endUserLease(t.contents);
    for (let i = 0; i < 12; i++) await tick();
    // At the second's end: the deadline over in the page and in that frame; every print script out.
    expect(untilZero(t, mid)).toEqual(expect.arrayContaining([undefined, 'f1']));
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(kept).toEqual([]);
  });

  it('#346: as the lease ends, the deadline over in every frame before anything is awaited (your own Print as you take the tab back: Opus’s SF-B, round 2); that script taken out as it answers', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    withFrame(t);
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    const mid = t.sent.length;
    endUserLease(t.contents);
    // At once, not after a tick.
    expect(untilZero(t, mid)).toEqual([undefined, 'f1']);
    for (let i = 0; i < 12; i++) await tick();
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(kept).toEqual([]);
  });

  it('#346: an action’s renewal of the hold answered after the lease ended: taken out at once, never left to run in new documents (Neon’s SF1, round 2)', async () => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    const start = Date.now();
    let answer: () => void = () => undefined;
    const late = new Promise<void>((done) => (answer = done));
    withFrame(t, async (m, p) => {
      // The renewal's deadline (past the first's): answered only once the lease is over.
      const until = m === 'Page.addScriptToEvaluateOnNewDocument' ? Number(/= (\d+);/.exec((p as { source: string }).source)?.[1] ?? 0) : 0;
      if (until > start + PRINT_HOLD_MS + 60_000) await late;
    });
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    // The next action, six minutes on: the hold renewed.
    const now = vi.spyOn(Date, 'now').mockReturnValue(start + 6 * 60_000);
    try {
      expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
      endUserLease(t.contents);
      for (let i = 0; i < 12; i++) await tick();
      answer();
      for (let i = 0; i < 12; i++) await tick();
    } finally {
      now.mockRestore();
    }
    const renewals = printAdds(t).filter((a) => Number(/= (\d+);/.exec(a.source)?.[1] ?? 0) > start + PRINT_HOLD_MS + 60_000);
    expect(renewals.length).toBeGreaterThan(0);
    const kept = printAdds(t).map((_, i) => `script-${i + 1}`).filter((id) => !removed(t).includes(id));
    expect(kept).toEqual([]);
  });

  it.each(['Fetch.enable', 'Page.enable'])('#346: a frame still being held as the lease ends (%s answers after): nothing of the print’s turned on there after the end (Neon’s SF2, round 2)', async (method) => {
    const t = yourTab();
    (t.debug as unknown as { attach(): void }).attach();
    let answer: () => void = () => undefined;
    const late = new Promise<void>((done) => (answer = done));
    const send = (t.debug as unknown as { sendCommand: (m: string, p: unknown, s?: string) => Promise<unknown> }).sendCommand;
    (t.debug as unknown as { sendCommand: typeof send }).sendCommand = async (m, p, s) => {
      if (m === method && s === 'f2') await late;
      return send(m, p, s);
    };
    expect(await beginUserAction(t.contents, 'chat:1', deps())).toBe('on');
    // A frame that comes mid-lease.
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f2', waitingForDebugger: false, targetInfo: { type: 'iframe' } });
    await tick();
    endUserLease(t.contents);
    for (let i = 0; i < 12; i++) await tick();
    const mid = t.sent.length;
    answer();
    for (let i = 0; i < 12; i++) await tick();
    const after = t.sent.slice(mid).filter(([m, , s]) => s === 'f2' && ['Runtime.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument', ...(method === 'Fetch.enable' ? ['Page.enable'] : [])].includes(m));
    expect(after.map(([m]) => m)).toEqual([]);
  });

  it('a Send data card from the tail answered after the tail: Allow and Allow for this chat still send it (Neon’s B4 on #150)', async () => {
    for (const answer of ['once', 'until'] as const) {
      vi.useFakeTimers();
      const t = yourTab();
      const kept = new Set<string>();
      const ask: SendHoldDeps['ask'] = () => new Promise((done) => setTimeout(() => done(answer), TAIL_MS + 500));
      await beginUserAction(t.contents, 'chat:1', { ...t.deps(ask), kept });
      endUserAction(t.contents);
      t.post('r1');
      await vi.advanceTimersByTimeAsync(TAIL_MS + 600);
      expect(t.how('r1'), answer).toBe('Fetch.continueRequest');
      expect([...kept], answer).toEqual(answer === 'until' ? ['https://game.example'] : []);
      endUserLease(t.contents);
      vi.useRealTimers();
    }
  });

  it('a download card up keeps the lease on past its 6 s (up to 45 s), so the card isn’t taken down under you (Neon’s S1 on #150)', async () => {
    vi.useFakeTimers();
    const t = yourTab();
    let answer: (yes: boolean) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const askDownload = (_d: unknown, signal: AbortSignal) => (signals.push(signal), new Promise<boolean>((done) => (answer = done)));
    await beginUserAction(t.contents, 'chat:1', { ...t.deps(), askDownload });
    endUserAction(t.contents);
    const asked = askUserTabDownload(t.contents, { filename: 'file.zip', url: 'https://files.example/file.zip' });
    await vi.advanceTimersByTimeAsync(AFTER_MS + 5000);
    expect(userTabCatching(t.contents)).toBe(true);
    expect(signals[0]!.aborted).toBe(false);
    answer(true);
    expect(await asked).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(userTabCatching(t.contents)).toBe(false);
  });

  it('each action, the lease’s first or one that joins it, tells the vault to close its menu (Neon’s S2 on #150)', async () => {
    const t = yourTab();
    const heard: unknown[] = [];
    const off = onUserLease((contents) => void heard.push(contents));
    await beginUserAction(t.contents, 'chat:1', deps());
    await beginUserAction(t.contents, 'chat:1', deps());
    off();
    expect(heard).toEqual([t.contents, t.contents]);
    endUserLease(t.contents);
  });

  it('a page with unsaved changes that stays put is said in the chat; after the lease, it’s yours alone (Neon’s S4 on #150)', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    (t.contents as unknown as EventEmitter).emit('will-prevent-unload', { preventDefault: () => undefined });
    expect(t.notes).toEqual(['unload: the page has unsaved changes, so it stayed']);
    endUserLease(t.contents);
    await tick();
    (t.contents as unknown as EventEmitter).emit('will-prevent-unload', { preventDefault: () => undefined });
    expect(t.notes).toHaveLength(1);
  });

  it('a worker the page starts while the lease is on runs at once, during the lease or after it, never left waiting (Claude’s B1, round 2 of #150)', async () => {
    const t = yourTab();
    await beginUserAction(t.contents, 'chat:1', t.deps());
    // Workers are attached (and so paused at their start) as frames are.
    const auto = t.sent.find(([m, , s]) => m === 'Target.setAutoAttach' && !s)?.[3] as { filter: { type: string }[] };
    expect(auto.filter.map((f) => f.type)).toEqual(expect.arrayContaining(['iframe', 'worker']));
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'w1', waitingForDebugger: true, targetInfo: { type: 'worker' } });
    await tick();
    expect(t.sent.some(([m, , s]) => m === 'Runtime.runIfWaitingForDebugger' && s === 'w1')).toBe(true);
    // One that comes as the lease lets go (ended, its listener not yet off): run too.
    endUserLease(t.contents);
    t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'w2', waitingForDebugger: true, targetInfo: { type: 'worker' } });
    await tick();
    expect(t.sent.some(([m, , s]) => m === 'Runtime.runIfWaitingForDebugger' && s === 'w2')).toBe(true);
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
      showable: false,
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'click “Place order”', step: { why: 'pay', site: 'shop.example', fields: ['Shipping', 'Card'], more: 0 } })).toEqual({
      kind: 'step',
      title: 'Place the order on shop.example?',
      note: 'The assistant is about to click “Place order”.',
      lines: ['Goes with it: Shipping, Card'],
      danger: true,
      showable: false,
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'Clicked “Raise”', step: { why: 'send', site: 'https://game.example', fields: [], more: 0, sends: ['https://game.example'] }, show: () => undefined })).toEqual({
      kind: 'send',
      title: 'Send data to https://game.example?',
      note: 'The assistant clicked “Raise”, and the page is sending something to its site.',
      lines: ['Goes to: https://game.example'],
      danger: false,
      // Show me only where the card has something to point at (never a tail card's, nor a load's: the reviews of #147).
      showable: true,
    });
    // A risky step the page took after the last action (a tail card): said as the page's, never as the assistant's next step (round 2 of #147).
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'After the assistant’s last step here', step: { why: 'sign-out', site: 'game.example', fields: [], more: 0, idle: true, going: 'game.example/logout' } })?.note).toBe(
      'After the assistant’s last step, the page is going to game.example/logout.',
    );
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'After the assistant’s last step here', step: { why: 'delete', site: 'game.example', fields: [], more: 0, idle: true } })?.note).toBe(
      'After the assistant’s last step, the page is doing this on its own.',
    );
    expect(actCard({ ...base, kind: 'read', subject: 'read_tab', description: 'Read “Article”' })).toBeNull();
    // M2e-2c: leaving the site, with the whole address; what it types, in a chat that read elsewhere.
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'go to tracker.example/collect', step: { why: 'leave', site: 'tracker.example', fields: [], more: 0, going: 'https://tracker.example/collect?q=secret' } })).toEqual({
      kind: 'step',
      title: 'Go to tracker.example?',
      note: 'The assistant wants to open this in your tab:',
      lines: ['https://tracker.example/collect?q=secret'],
      danger: false,
      showable: false,
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'type in “Order number”', step: { why: 'confirm', site: 'shop.example', fields: [], more: 0, typed: 'W-104388', taint: true } })).toMatchObject({
      kind: 'step',
      title: 'Type this in “Order number”?',
      lines: [],
      long: '“W-104388”',
    });
  });

  it('a redirect’s leaving card says what sent the tab on, with the whole address; what it types is shown whole, however long (Neon’s B1, B2, N5 on #151)', () => {
    const away = 'https://tracker.example/collect?secret=W-104388&ref=abc#done';
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'go to shop.example/out', step: { why: 'leave', site: 'tracker.example', fields: [], more: 0, going: away, from: 'shop.example/out' } })).toMatchObject({
      title: 'Go to tracker.example?',
      note: 'shop.example/out sends your tab to:',
      lines: [away],
    });
    expect(actCard({ ...base, kind: 'step', subject: 's', description: 'After the assistant’s last step here', step: { why: 'leave', site: 'tracker.example', fields: [], more: 0, going: away, idle: true } })).toMatchObject({
      note: 'After the assistant’s last step, the page is sending your tab to:',
      lines: [away],
    });
    const text = `${'Thanks for the order. '.repeat(120)}W-104388`;
    const card = actCard({ ...base, kind: 'step', subject: 's', description: 'type in “Notes”', step: { why: 'confirm', site: 'shop.example', fields: [], more: 0, typed: text, taint: true } });
    expect(card?.long).toBe(`“${text}”`);
    expect(card?.long).toContain('W-104388');
  });
});

describe('What the clipboard note says, by what happened (the owner’s card-game run on 982ce10)', () => {
  it('each case its own words, so the model says what happened, never “probably”', async () => {
    const { USER_TAB_NOTES } = await import('../../src/main/assistant/service');
    expect(USER_TAB_NOTES.clipboard('put back')).toBe('The page copied something to your clipboard while the assistant acted; Chord put back what you had');
    expect(USER_TAB_NOTES.clipboard('not put back')).toBe('The page copied something to your clipboard while the assistant acted, and Chord couldn’t put back what you had; check it before you paste');
    expect(USER_TAB_NOTES.clipboard('changed')).toBe(
      'Your clipboard changed while the assistant acted, but not by the page itself: a frame inside the page copied something, or you copied something elsewhere. Chord left it as it is; check it before you paste',
    );
  });
});

describe('What the print note says (#338)', () => {
  it('fixed words, whatever the page did (the wording is the owner’s: kept)', async () => {
    const { USER_TAB_NOTES } = await import('../../src/main/assistant/service');
    expect(USER_TAB_NOTES.print('anything')).toBe('The page tried to print while the assistant acted; Chord didn’t print it');
  });
});

describe('The page’s words in the chat’s notes (Neon’s N1 on #150)', () => {
  it('one plain line: no control or bidi characters, at most 120 characters', () => {
    expect(plainNote('confirm: “Pay\n now?‮”')).toBe('confirm: “Pay now? ”');
    expect(plainNote('x'.repeat(300))).toHaveLength(120);
  });
});

describe('The cards a lease asks on its own outlive the turn; no other card does (Neon’s S5 on #150)', () => {
  it('by its whole subject, never a match inside an address', () => {
    expect(outlivesTurn('n1|tail|0a1b2c3d')).toBe(true);
    expect(outlivesTurn('n1|download|0a1b2c3d')).toBe(true);
    expect(outlivesTurn('n1|p2|navigate|leave|https://x.example/a|tail|0a1b2c3d')).toBe(false);
    expect(outlivesTurn('n1|p2|click|sends|https://x.example/|download|00000000')).toBe(false);
    expect(outlivesTurn('shop.example')).toBe(false);
  });
});

describe('A download card’s site and name (Neon’s SF1 and Claude’s S2, round 2 of #150)', () => {
  it('the site it comes from (a blob’s inner origin, a data: address the page’s), never “?”; the name cut in the middle, its extension kept', () => {
    const page = 'https://shop.example/orders';
    expect(downloadShown({ filename: 'invoice.pdf', url: 'https://files.example/x/invoice.pdf' }, page).site).toBe('files.example');
    expect(downloadShown({ filename: 'a.zip', url: 'blob:https://files.example/0b1c-22' }, page).site).toBe('files.example');
    expect(downloadShown({ filename: 'a.zip', url: 'data:application/zip;base64,UEs=' }, page).site).toBe('shop.example');
    expect(downloadShown({ filename: 'a.zip', url: 'not a url' }, page).site).toBe('shop.example');
    const long = downloadShown({ filename: `report${' '.repeat(3)}final${'x'.repeat(110)}.pdf .exe`, url: 'https://files.example/r' }, page).download;
    expect(long.endsWith('.exe')).toBe(true);
    expect(long).toContain('…');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).not.toMatch(/\s{2}/);
  });
});
