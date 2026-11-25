/**
 * Outside agents' chords in main (S18 M1c): what an agent may see and read,
 * its bar (working, paused while you type, stopped) and throttling, Keep and
 * Close all with Undo when it's done, dialogs and file pickers held in its
 * tabs, downloads refused, the vault off there, and nothing at all until an
 * agent connects.
 */
import { EventEmitter } from 'node:events';
import { AGENT_BAR_HEIGHT, CONTROL_REFUSALS, agentToolList, agentToolsVersion, emptyState, findShortcut, nodeList, nodeOf, type Command, type State, type TabNode } from '@chord/core';
import { size } from '@chord/tokens';
import type { Toast } from '@chord/ipc';
import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentChords, type Going } from '../../src/main/agents/chords';
import { AGENT_PROGRESS, agentConnection } from '../../src/main/agents/connection';
import { AuthBroker } from '../../src/main/http-auth';
import { agentScope, NOT_YOURS } from '../../src/main/agents/scope';
import { ControlAgent, type CardPresenter } from '../../src/main/control/gate';
import { DownloadManager } from '../../src/main/downloads';
import { PasswordService } from '../../src/main/passwords/service';
import { Store } from '../../src/main/store';
import { holdForAgent } from '../../src/preload/agent-hold';
import { holdSends } from '../../src/main/control/sends';
import { pageLoaded } from '../../src/main/control/tools';

afterEach(() => vi.useRealTimers());

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

/** A store with your chord and one window, a tab of yours, and the pages main has made. */
function setup(neverSites: string[] = [], present: CardPresenter = async () => 'once') {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://mine.test/' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  const toasts: Toast[] = [];
  const pages = new Map<string, EventEmitter & { throttled: boolean }>();
  const page = (nodeId: string) => {
    let p = pages.get(nodeId);
    if (!p) {
      const emitter = new EventEmitter() as EventEmitter & { throttled: boolean };
      emitter.throttled = true;
      pages.set(nodeId, (p = emitter));
    }
    // A page with no address yet, unless a test gives it one.
    if (!('getURL' in p)) Object.assign(p, { getURL: () => '' });
    return Object.assign(p, { isDestroyed: () => false, setBackgroundThrottling: (on: boolean) => (p!.throttled = on) }) as unknown as WebContents;
  };
  const chords = new AgentChords({ store, page, lastWindow: () => ({ id: 'w1', toast: (t) => void toasts.push(t) }), neverSites: () => neverSites });
  const agent = new ControlAgent('agent:1', present);
  const chordId = chords.chordFor(agent, 'Claude Code', null);
  const open = (nodeId: string, url = `https://agent.test/${nodeId}`) => store.dispatch({ t: 'agent.tab.add', chordId, nodeId, url });
  open('a1');
  open('a2');
  return { store, mine, chords, agent, chordId, toasts, pages, page, open };
}

const agentLive = (store: Store, nodeId: string) => store.state.live[nodeId]?.agent ?? null;

describe('What an agent sees', () => {
  it('only its own tabs, readable unless they’re never readable, and inspected only if they’re its own', () => {
    const t = setup();
    const scope = agentScope(t.agent, { state: () => t.store.state, chordId: () => t.chordId, neverSites: () => ['bank.test'] });
    expect(scope.tabs().map(({ node }) => node.id)).toEqual(['a1', 'a2']);
    const tab = (id: string) => nodeOf(t.store.state, id) as TabNode;
    t.open('a3', 'https://www.bank.test/statements');
    // [tab, readable, what forms and diagnostics say]
    const table: [string, boolean, string | null][] = [
      ['a1', true, null],
      ['a3', false, null],
      [t.mine, false, NOT_YOURS],
    ];
    for (const [id, readable, inspect] of table) {
      expect(scope.readable(tab(id)), id).toBe(readable);
      expect(scope.mayInspect(tab(id), 'read_form'), id).toBe(inspect);
    }
    expect(scope.needsCard('read_tab', tab('a1'))).toBeNull();
    expect(scope.refs.refFor('a1')).toBe('a1');
  });
});

describe('The bar, throttling and your hands', () => {
  it('working while a call runs on a tab (at full speed), and for AGENT_STEADY_MS after; idle then; stopped on every tab until it continues', async () => {
    vi.useFakeTimers();
    const t = setup();
    let finish!: () => void;
    const running = t.agent.call('a1', () => new Promise<void>((r) => (finish = r)), () => undefined);
    expect(agentLive(t.store, 'a1')).toMatchObject({ state: 'working', name: 'Claude Code', chordId: t.chordId });
    expect(agentLive(t.store, 'a2')).toBeNull();
    expect(t.pages.get('a1')!.throttled).toBe(false);
    finish();
    await running;
    // Still worked on a while (the frame steady between actions), then idle.
    expect(agentLive(t.store, 'a1')).toMatchObject({ state: 'working' });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(agentLive(t.store, 'a1')).toBeNull();
    expect(t.pages.get('a1')!.throttled).toBe(true);
    t.chords.stopAll();
    expect([agentLive(t.store, 'a1')?.state, agentLive(t.store, 'a2')?.state]).toEqual(['stopped', 'stopped']);
    await expect(t.agent.call('a1', async () => 'ran', (why) => why)).resolves.toBe('stopped');
    t.chords.continue(t.chordId);
    expect(agentLive(t.store, 'a1')).toBeNull();
    await expect(t.agent.call('a1', async () => 'ran', (why) => why)).resolves.toBe('ran');
    vi.useRealTimers();
  });

  it('a key you press in its tab pauses the agent there until you leave the tab, or let it continue', async () => {
    vi.useFakeTimers();
    const t = setup();
    const contents = t.page('a1');
    t.chords.wire(contents, 'a1');
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    (contents as unknown as EventEmitter).emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    expect(agentLive(t.store, 'a1')?.state).toBe('paused');
    // Its call on that tab waits, and after the wait says the user is using it.
    const held = t.agent.call('a1', async () => 'ran', (why) => why);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(held).resolves.toBe('paused');
    expect(CONTROL_REFUSALS.paused).toContain('using this tab');
    // Its other tabs aren't held.
    await expect(t.agent.call('a2', async () => 'ran', (why) => why)).resolves.toBe('ran');
    // You leave the tab: it goes on.
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(agentLive(t.store, 'a1')).toBeNull();
    // Paused again, then "Let Claude Code continue".
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    (contents as unknown as EventEmitter).emit('before-input-event', {}, { type: 'keyDown', key: 'b' });
    t.chords.continue(t.chordId);
    expect(agentLive(t.store, 'a1')).toBeNull();
  });

  it('leaving its page never asks (beforeunload)', () => {
    const t = setup();
    const contents = t.page('a1');
    t.chords.wire(contents, 'a1');
    const event = { preventDefault: vi.fn() };
    (contents as unknown as EventEmitter).emit('will-prevent-unload', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('Your hand on an agent’s tab (S18 M2e-1)', () => {
  /** A card no one answers: up until it's taken down. */
  const unanswered: CardPresenter = (_card, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
  const card = (tab: string, kind: 'site' | 'step', subject: string) => ({ kind, tool: 'click', description: '', target: [`https://agent.test/${tab}`], tab, subject });
  const never = new AbortController().signal;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** The tab's page with its lifelong send hold on (control/sends.ts, over a fake debugger), wired to its chord. */
  function held(t: ReturnType<typeof setup>, nodeId: string) {
    const contents = t.page(nodeId);
    const debug = new EventEmitter();
    const answered: [string, string][] = [];
    Object.assign(contents, {
      getURL: () => `https://agent.test/${nodeId}`,
      // Behind it, a page of the site's; ahead, nothing.
      navigationHistory: { getActiveIndex: () => 1, getEntryAtIndex: (i: number) => (i === 0 ? { url: 'https://agent.test/before' } : i === 1 ? { url: `https://agent.test/${nodeId}` } : null) },
      debugger: Object.assign(debug, {
        isAttached: () => true,
        sendCommand: async (method: string, params: { requestId?: string }) => void answered.push([method, params.requestId ?? '']),
      }),
    });
    holdSends(contents);
    t.chords.wire(contents, nodeId);
    let n = 0;
    /** What the page sends now (a POST to its site, or a load): its request id. */
    /** `session`: a frame in another process (its own debugger session); none, the page's own target. */
    const send = (type = 'XHR', method = 'POST', session?: string, url = `https://agent.test/${nodeId}/save`) => {
      const requestId = `r${++n}`;
      debug.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { method, url }, resourceType: type }, session);
      return requestId;
    };
    const how = (requestId: string) => answered.find(([, id]) => id === requestId)?.[0] ?? 'held';
    const events = contents as unknown as EventEmitter;
    return { contents, send, how, events };
  }

  const show = (t: ReturnType<typeof setup>, nodeId: string) => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId });

  // [what you did, whether a window shows the tab, where it takes the page]
  const takeovers: [string, boolean, Going][] = [
    ['the toolbar’s Back, on the tab you see', true, 'back'],
    ['the app menu’s Reload, on the tab you see', true, 'reload'],
    ['an address you typed for the tab you see', true, { url: 'https://agent.test/next' }],
    ['the row menu’s Reload, on a tab no window shows', false, 'reload'],
    ['a key in the page you see', true, 'stay'],
  ];
  for (const [what, shown, going] of takeovers) {
    it(`${what}: the held send fails, its card comes down; paused only where you see it`, async () => {
      const t = setup([], unanswered);
      const tab = held(t, 'a1');
      if (shown) show(t, 'a1');
      const waiting = tab.send();
      await tick();
      expect(tab.how(waiting)).toBe('held');
      const step = t.agent.ask(card('a1', 'step', 'a1|p1|e4|click'), never);
      if (going !== 'stay') t.chords.takeOver('a1', tab.contents, going);
      else tab.events.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
      expect(tab.how(waiting)).toBe('Fetch.failRequest');
      await expect(step).resolves.toBe('deny');
      expect(t.agent.state('a1').paused).toBe(shown);
      // Not shown: still the agent's, so what the page sends next is held again (Neon's B1 on #116).
      if (!shown) {
        const next = tab.send('XHR');
        await tick();
        expect(tab.how(next)).toBe('Fetch.failRequest'); // the outgoing page's: no one's until the next one loads
        tab.events.emit('did-navigate', {}, 'https://agent.test/a1');
        tab.events.emit('did-stop-loading');
        const after = tab.send();
        await tick();
        expect(tab.how(after)).toBe('held');
      }
    });
  }

  it('moving the page yourself: everything the outgoing page sends fails but the address you asked for, once; then the new page’s are yours', async () => {
    const t = setup();
    const tab = held(t, 'a1');
    show(t, 'a1');
    t.chords.takeOver('a1', tab.contents, { url: 'https://agent.test/logout' });
    // Its pagehide's keepalive POST and beacon, a form it posts, a frame's, an address that signs out: no one's, though
    // you have the tab (Neon's round 2 on #116).
    expect(tab.how(tab.send('XHR'))).toBe('Fetch.failRequest');
    expect(tab.how(tab.send('Ping'))).not.toBe('Fetch.continueRequest');
    expect(tab.how(tab.send('Document', 'POST'))).toBe('Fetch.fulfillRequest'); // dropped: a document answered with nothing
    expect(tab.how(tab.send('Document', 'POST', 'frame-1', 'https://agent.test/logout'))).toBe('Fetch.fulfillRequest');
    expect(tab.how(tab.send('Document', 'GET', undefined, 'https://agent.test/account/delete'))).toBe('Fetch.fulfillRequest');
    // A page's ordinary load is a read: it never reaches the hold's question.
    expect(tab.how(tab.send('Document', 'GET', undefined, 'https://agent.test/next'))).toBe('Fetch.continueRequest');
    // The address you typed (it signs out, so it asks the hold): yours, once.
    expect(tab.how(tab.send('Document', 'GET', undefined, 'https://agent.test/logout'))).toBe('Fetch.continueRequest');
    expect(tab.how(tab.send('Document', 'GET', undefined, 'https://agent.test/logout'))).toBe('Fetch.fulfillRequest');
    // A pushState or a hash of the outgoing page clears nothing.
    tab.events.emit('did-navigate-in-page', {}, 'https://agent.test/a1#x', true);
    expect(tab.how(tab.send())).toBe('Fetch.failRequest');
    // Committed and loaded: what it sends is yours.
    tab.events.emit('did-navigate', {}, 'https://agent.test/logout');
    tab.events.emit('did-stop-loading');
    expect(tab.how(tab.send())).toBe('Fetch.continueRequest');
  });

  it('your move that doesn’t happen (window.stop(), a failed load, no commit in time) gives the tab back to the agent, held, never to you', async () => {
    vi.useFakeTimers();
    for (const how of ['stopped', 'stalled'] as const) {
      const t = setup([], unanswered);
      const tab = held(t, 'a1');
      show(t, 'a1');
      t.chords.takeOver('a1', tab.contents, 'reload');
      expect(t.agent.state('a1').paused).toBe(true);
      // window.stop() of the outgoing page (ERR_ABORTED), or a server that never answers (or a 204).
      if (how === 'stopped') tab.events.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://agent.test/a1', true);
      else await vi.advanceTimersByTimeAsync(15_000);
      expect(t.agent.state('a1').paused, how).toBe(false);
      // The old page's next send: the agent's, so held (a card asks), not yours.
      const next = tab.send();
      await vi.advanceTimersByTimeAsync(0);
      expect(tab.how(next), how).toBe('held');
      t.agent.cancelCards();
    }
  });

  it('a load failing in a tab you didn’t move: nothing (your pause stays)', () => {
    const t = setup();
    const tab = held(t, 'a1');
    show(t, 'a1');
    tab.events.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    tab.events.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://agent.test/a1', true);
    expect(t.agent.state('a1').paused).toBe(true);
  });

  it('the page navigating itself never takes it over (Neon’s B6), shown or not: what it sends stays held', async () => {
    for (const shown of [true, false]) {
      const t = setup([], unanswered);
      const tab = held(t, 'a1');
      if (shown) show(t, 'a1');
      // A page's own location.reload(), meta refresh or timed redirect: navigation events, no input, no button of Chord's.
      for (const event of ['did-start-navigation', 'did-redirect-navigation', 'did-navigate', 'did-navigate-in-page', 'did-finish-load', 'did-stop-loading']) tab.events.emit(event, {}, 'https://agent.test/elsewhere', true, true);
      const sent = tab.send();
      await tick();
      expect(tab.how(sent), `shown: ${shown}`).toBe('held');
      expect(t.agent.state('a1').paused).toBe(false);
      t.agent.cancelCards();
    }
  });

  it('a site card two tabs wait on: taking one over answers its ask no and leaves the card up for the other; both gone, it comes down', async () => {
    let presented: AbortSignal | null = null;
    let answerCard: (grant: 'once') => void = () => undefined;
    const t = setup([], (_card, signal) => {
      presented = signal;
      return new Promise((resolve) => {
        answerCard = resolve;
        signal.addEventListener('abort', () => resolve('deny'), { once: true });
      });
    });
    const a1 = t.agent.ask(card('a1', 'site', 'agent.test'), never);
    const a2 = t.agent.ask(card('a2', 'site', 'agent.test'), never);
    t.chords.takeOver('a1');
    await expect(a1).resolves.toBe('deny');
    expect(t.agent.hasOpenCard('site', 'agent.test')).toBe(true);
    // Answered for a2: a1's action (asked before you took the tab) never gets the yes.
    answerCard('once');
    await expect(a2).resolves.toBe('once');
    // Again, and both tabs let go of: no card left up with no one waiting.
    const b1 = t.agent.ask(card('a1', 'site', 'other.test'), never);
    const b2 = t.agent.ask(card('a2', 'site', 'other.test'), never);
    t.chords.takeOver('a1');
    t.chords.takeOver('a2');
    await expect(Promise.all([b1, b2])).resolves.toEqual(['deny', 'deny']);
    expect(presented!.aborted).toBe(true);
    expect(t.agent.hasOpenCard('site', 'other.test')).toBe(false);
  });

  it('a card let go of by its only tab is gone at once: an ask right after gets a card of its own (Neon’s round 2 S2)', async () => {
    const shown: string[] = [];
    const t = setup([], (c, signal) => {
      shown.push(c.tab ?? '');
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
    });
    const a1 = t.agent.ask(card('a1', 'site', 'agent.test'), never);
    t.chords.takeOver('a1');
    // Before the taken-down card's answer settles: a2's ask isn't joined to it.
    const a2 = t.agent.ask(card('a2', 'site', 'agent.test'), never);
    await expect(a1).resolves.toBe('deny');
    await tick();
    expect(shown).toEqual(['a1', 'a2']);
    expect(t.agent.hasOpenCard('site', 'agent.test')).toBe(true);
    t.agent.cancelCards();
    await a2;
  });

  it('closing the tab (or Close all, or a Never site) answers its cards no at once, unpauses it, and fails what it held', async () => {
    for (const close of ['tab.close', 'agent.tab.remove'] as const) {
      const t = setup([], unanswered);
      const tab = held(t, 'a1');
      show(t, 'a1');
      tab.events.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
      expect(t.agent.state('a1').paused).toBe(true);
      tab.events.emit('before-input-event', {}, { type: 'keyDown', key: 'b' });
      // You let it go on; then it holds a POST between actions, and asks.
      t.chords.continue(t.chordId);
      const post = tab.send();
      await tick();
      expect(tab.how(post)).toBe('held');
      const step = t.agent.ask(card('a1', 'step', 'a1|p1|e4|click'), never);
      const site = t.agent.ask(card('a1', 'site', 'agent.test'), never);
      t.chords.doing('a1', { tool: 'click', name: 'Save', role: 'button' });
      t.store.dispatch(close === 'tab.close' ? { t: 'tab.close', windowId: 'w1', nodeId: 'a1' } : { t: 'agent.tab.remove', nodeId: 'a1' });
      await expect(Promise.all([step, site])).resolves.toEqual(['deny', 'deny']);
      expect(tab.how(post)).toBe('Fetch.failRequest');
      expect(t.agent.state('a1').paused).toBe(false);
      expect(t.agent.hasOpenCard('site', 'agent.test')).toBe(false);
    }
  });

  it('a page closed while an action waits on its load: the wait ends at once, not at its limit', async () => {
    let destroyed = false;
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, isLoading: () => true }) as unknown as WebContents;
    // On fake timers, so no wall clock decides it (issue #85): the wait ends as the page goes, 20 ms in, not at 10 s.
    vi.useFakeTimers();
    try {
      let ended = false;
      const waiting = pageLoaded(contents, 10_000).then(() => (ended = true));
      setTimeout(() => {
        destroyed = true;
        (contents as unknown as EventEmitter).emit('destroyed');
      }, 20);
      await vi.advanceTimersByTimeAsync(19);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toBe(true);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tab of yours: nothing', () => {
    const t = setup();
    t.chords.takeOver(t.mine);
    t.chords.takeOverPage(t.page(t.mine));
    expect(t.agent.state(t.mine).paused).toBe(false);
  });
});

describe('When the agent’s done', () => {
  it('asks to keep its tabs: Keep moves them into the window’s chord', () => {
    const t = setup();
    t.chords.done(t.agent);
    expect(t.toasts).toEqual([
      expect.objectContaining({
        message: 'Claude Code finished. Keep these tabs?',
        action: { label: 'Keep', command: { t: 'agents.keep', windowId: 'w1', chordId: t.chordId } },
        secondary: { label: 'Close all', command: { t: 'agents.closeAll', chordId: t.chordId } },
      }),
    ]);
    // No bar once it's done.
    expect(agentLive(t.store, 'a1')).toBeNull();
    t.chords.keep('w1', t.chordId);
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
    expect((nodeOf(t.store.state, 'a1') as TabNode).chordId).toBe('c1');
  });

  it('Close all closes them with Undo, which brings them back', () => {
    const t = setup();
    t.chords.done(t.agent);
    t.chords.closeAll(t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toBeUndefined();
    const undo = t.toasts.at(-1)!;
    expect(undo).toMatchObject({ message: 'Closed 2 tabs', action: { label: 'Undo' } });
    t.chords.undoClose((undo.action as { command: { token: string } }).command.token);
    expect(nodeOf(t.store.state, 'a2')).toMatchObject({ chordId: t.chordId });
    // Back as a finished agent's chord: closing its last tab ends it.
    t.store.dispatch({ t: 'tab.close', windowId: 'w1', nodeId: 'a1' });
    t.store.dispatch({ t: 'tab.close', windowId: 'w1', nodeId: 'a2' });
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
  });

  it('with no tabs left, its chord just goes, without asking', () => {
    const t = setup();
    t.store.dispatch({ t: 'agent.tab.remove', nodeId: 'a1' });
    t.store.dispatch({ t: 'agent.tab.remove', nodeId: 'a2' });
    t.chords.done(t.agent);
    expect(t.toasts).toEqual([]);
    expect(t.store.state.chords[t.chordId]).toBeUndefined();
  });
});

describe('What its tabs held', () => {
  it('page dialogs answer at once, file pickers open nothing, and each is reported', async () => {
    const page = globalThis as unknown as Record<string, unknown>;
    const saved = { alert: page['alert'], confirm: page['confirm'], prompt: page['prompt'], showOpenFilePicker: page['showOpenFilePicker'] };
    const native = vi.fn(() => 'native');
    Object.assign(page, { alert: native, confirm: native, prompt: native, showOpenFilePicker: native });
    try {
      const held: [string, string][] = [];
      holdForAgent((kind, detail) => void held.push([kind, detail]));
      const call = (name: string, ...args: unknown[]) => (page[name] as (...a: unknown[]) => unknown)(...args);
      expect(call('alert', 'Hello')).toBeUndefined();
      expect(call('confirm', 'Leave?')).toBe(false);
      expect(call('prompt', 'Name?')).toBeNull();
      await expect(call('showOpenFilePicker')).rejects.toMatchObject({ name: 'AbortError' });
      expect(native).not.toHaveBeenCalled();
      expect(held).toEqual([
        ['dialog', 'alert: Hello'],
        ['dialog', 'confirm: Leave?'],
        ['dialog', 'prompt: Name?'],
        ['file', 'showOpenFilePicker'],
      ]);
    } finally {
      Object.assign(page, saved);
    }
  });

  it('a download an agent’s tab starts is refused before anything is written, and the agent hears of it', () => {
    const session = new EventEmitter();
    const agentPage = {} as WebContents;
    const refused: string[] = [];
    const commands: Command[] = [];
    const downloads = new DownloadManager({
      state: () => emptyState(),
      dispatch: (c) => void commands.push(c),
      newId: () => 'd1',
      defaultSession: () => session as unknown as Session,
      refuse: (contents, _url, filename) => (contents === agentPage ? (refused.push(filename), true) : false),
    });
    downloads.attach(session as unknown as Session);
    const event = { preventDefault: vi.fn() };
    const item = { getURL: () => 'https://agent.test/f.zip', getFilename: () => 'f.zip', setSavePath: vi.fn() };
    session.emit('will-download', event, item, agentPage);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(refused).toEqual(['f.zip']);
    expect(commands).toEqual([]);
  });
});

describe('The vault in an agent’s tab', () => {
  it('a sign-in page there gets nothing: no menu, no password, no save, no generator, even when chord-data would answer', async () => {
    const chords: Record<string, { id: string; profileId: string; agent?: unknown }> = {
      mine: { id: 'mine', profileId: 'default' },
      ag: { id: 'ag', profileId: 'default', agent: { name: 'Claude Code' } },
    };
    const login = { id: 'l1', origin: 'https://shop.test', username: 'ada', realm: null, note: '', createdAt: 0, updatedAt: 0, lastUsed: null, chordUsed: null };
    // A chord-data that would hand over the password to anyone who asked.
    const careless = new PasswordService({
      chord: (id: string) => chords[id] ?? null,
      extensions: () => ({}),
      settings: () => ({ enabled: true, lockAfter: 'never', onChords: [], offChords: [] }) as never,
      keys: { available: async () => true, wrap: async () => '', unwrap: async () => new Uint8Array() },
      clipboard: { writeText: () => undefined, readText: () => '' },
      changed: () => undefined,
      data: async (op: { op: string }) => {
        if (op.op === 'status') return { status: { state: 'open', kept: false, count: 1 }, generation: 0, held: false };
        if (op.op === 'forSite') return { logins: [login], unreadable: 0 };
        if (op.op === 'fill') return { password: 'Sekrit', loginOrigin: login.origin, loginRealm: null };
        return {};
      },
    } as never);
    expect(await careless.accountsFor(login.origin, 'ag')).toEqual({ state: 'off' });
    expect(await careless.passwordFor('l1', login.origin, 'ag')).toBeNull();
    expect(await careless.generatorFor(login.origin, 'ag')).toBe('off');
    expect(await careless.candidateFor({ origin: login.origin, username: 'ada', password: 'new', chordId: 'ag' })).toEqual({ kind: 'off' });
    // The same page in your chord is offered the sign-in: it's the agent's chord that keeps the vault shut.
    expect((await careless.accountsFor(login.origin, 'mine')).state).not.toBe('off');
  });
});

describe('Stop everything, and the bar’s size', () => {
  it('Ctrl+. and ⌘. stop every agent and assistant reply, and no page can keep the keys', () => {
    const press = (mac: boolean) => ({ type: 'keyDown', key: '.', code: 'Period', control: !mac, meta: mac, alt: false, shift: false });
    expect(findShortcut(press(false), 'win32')).toMatchObject({ id: 'agents.stopAll', kind: 'reserved' });
    expect(findShortcut(press(true), 'darwin')).toMatchObject({ id: 'agents.stopAll', kind: 'reserved' });
  });

  it('main lowers the page by the height the shell draws the bar at', () => {
    expect(size.agentBar).toBe(AGENT_BAR_HEIGHT);
  });
});

describe('Review 1 of #77', () => {
  it('an agent’s tab gets no sign-in box: the request is cancelled, and the agent hears why', () => {
    const broker = new AuthBroker();
    const refused: string[] = [];
    broker.connect({
      nodeFor: (contents) => (contents as unknown as { nodeId: string }).nodeId as never,
      onChange: vi.fn(),
      agentTab: (nodeId) => nodeId === 'a1',
      agentRefused: (_nodeId, detail) => void refused.push(detail),
    });
    const pageAt = (url: string, nodeId: string) => ({ nodeId, getURL: () => url, isDestroyed: () => false }) as unknown as WebContents;
    const details = { url: 'https://intranet.test/', pid: 1, isRequestForNavigation: true, firstAuthAttempt: true, responseHeaders: {} } as never;
    const info = { isProxy: false, scheme: 'basic', host: 'intranet.test', port: 443, realm: 'Staff' } as never;
    // Not answered by Chord: Electron's default cancels it.
    expect(broker.login(pageAt('https://intranet.test/', 'a1'), details, info, vi.fn())).toBe(false);
    expect(broker.promptFor('a1' as never)).toBeNull();
    expect(refused).toEqual(['The site https://intranet.test asked for a sign-in; Chord doesn’t sign agents in.']);
    // Your tab still gets its box.
    expect(broker.login(pageAt('https://intranet.test/', 'mine'), details, info, vi.fn())).toBe(true);
  });

  it('a call that asked for progress hears it while a card waits on the user, and none after its answer (#143)', async () => {
    vi.useFakeTimers();
    const t = setup();
    type Sent = { id?: number; method?: string; params?: { progressToken?: unknown; progress?: number; message?: string } };
    const sent: Sent[] = [];
    let allow: (grant: 'once') => void = () => undefined;
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) }, (m) => void sent.push(m as never), {
      present: () => new Promise((done) => (allow = done)),
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
      progressMs: 1000,
    });
    const progress = () => sent.filter((m) => m.method === 'notifications/progress');
    // The connection card is up: each beat says so, with the client's token, counting up.
    connection.message({ id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {}, _meta: { progressToken: 'p1' } } });
    await vi.advanceTimersByTimeAsync(3500);
    expect(progress().map((m) => m.params)).toEqual([1, 2, 3].map((progress) => ({ progressToken: 'p1', progress, message: AGENT_PROGRESS.card })));
    // Allowed: the answer, and no beat after it.
    allow('once');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find((m) => m.id === 1)).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(progress()).toHaveLength(3);
    // A call without a token hears none; nor one whose token is past its bound.
    connection.message({ id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
    connection.message({ id: 3, method: 'tools/call', params: { name: 'list_tabs', arguments: {}, _meta: { progressToken: 'x'.repeat(300) } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.find((m) => m.id === 2)).toBeDefined();
    expect(progress()).toHaveLength(3);
    // Stop while a card waits: the call answers stopped, and no beat comes after (round 1 of #145).
    connection.message({ id: 4, method: 'tools/call', params: { name: 'open_tab', arguments: { url: 'https://agent.test/x' }, _meta: { progressToken: 'p4' } } });
    await vi.advanceTimersByTimeAsync(1500);
    const before = progress().length;
    connection.agent.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find((m) => m.id === 4)).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(progress()).toHaveLength(before);
    vi.useRealTimers();
  });

  it('progress names a card only when it’s this call’s (its tab’s, or the agent-wide one), and stops on the client’s cancel (Neon’s review of M2g-1, S4)', async () => {
    vi.useFakeTimers();
    const t = setup();
    type Sent = { id?: number; method?: string; params?: { progressToken?: unknown; progress?: number; message?: string } };
    const sent: Sent[] = [];
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) }, (m) => void sent.push(m as never), {
      present: (card) => (card.kind === 'connection' ? Promise.resolve('once') : new Promise(() => undefined)),
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
      progressMs: 1000,
    });
    const chordId = t.chords.chordFor(connection.agent, 'Claude Code', null);
    t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'b1', url: 'https://agent.test/b1' });
    connection.message({ id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'b2', url: 'https://agent.test/b2' });
    // A call on b1 (a1) waits: the user has that tab. A card is up on b2 meanwhile: not this call's.
    connection.agent.pause('b1', true);
    void connection.agent.ask({ kind: 'step', tool: 'click', description: 'click “Buy”', target: ['https://agent.test/b2'], tab: 'b2', subject: 'b2|step' }, new AbortController().signal);
    connection.message({ id: 2, method: 'tools/call', params: { name: 'close_tab', arguments: { tab_id: 'a1' }, _meta: { progressToken: 7 } } });
    await vi.advanceTimersByTimeAsync(2500);
    const progress = () => sent.filter((m) => m.method === 'notifications/progress');
    expect(progress().map((m) => m.params?.message)).toEqual([AGENT_PROGRESS.working, AGENT_PROGRESS.working]);
    // A card on its own tab: that's this call's.
    void connection.agent.ask({ kind: 'step', tool: 'click', description: 'click “Fold”', target: ['https://agent.test/b1'], tab: 'b1', subject: 'b1|step' }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(progress().at(-1)?.params).toEqual({ progressToken: 7, progress: 3, message: AGENT_PROGRESS.card });
    // The client cancels: no beat after.
    connection.message({ method: 'notifications/cancelled', params: { requestId: 2 } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(progress()).toHaveLength(3);
    vi.useRealTimers();
  });

  it('one call waits on its cards 50 s in all: a step card after a slow connection card gets what’s left, then waiting (#143)', async () => {
    vi.useFakeTimers();
    const t = setup();
    const sent: { id?: number; result?: { content: { text: string }[]; isError: boolean } }[] = [];
    const answers: ((grant: 'once') => void)[] = [];
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Codex' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) }, (m) => void sent.push(m as never), {
      present: () => new Promise((done) => void answers.push(done)),
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
    });
    // open_tab of an address that signs out: the connection card, answered after 40 s, then the step card.
    connection.message({ id: 1, method: 'tools/call', params: { name: 'open_tab', arguments: { url: 'https://mail.test/logout' } } });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(answers).toHaveLength(1);
    answers[0]!('once');
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(2);
    // The step card waits what's left of the 50 s (10 s), not its own 45: the call answers waiting by 50 s, under
    // Codex's 60.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sent.find((m) => m.id === 1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sent.find((m) => m.id === 1)?.result?.content[0]?.text).toBe(CONTROL_REFUSALS.waiting);
    vi.useRealTimers();
  });

  it('close_tab waits while you use the tab: it answers paused, and the tab stays', async () => {
    vi.useFakeTimers();
    const t = setup();
    const sent: { id?: number; result?: { content: { text: string }[]; isError: boolean } }[] = [];
    const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) }, (m) => void sent.push(m as never), {
      present: async () => 'once',
      browser: { store: t.store, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } },
      chords: t.chords,
      dispatch: (c) => t.store.dispatch(c),
    });
    const chordId = t.chords.chordFor(connection.agent, 'Claude Code', null);
    t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'b1', url: 'https://agent.test/b1' });
    const answer = async (id: number, name: string, args: Record<string, unknown> = {}) => {
      connection.message({ id, method: 'tools/call', params: { name, arguments: args } });
      await vi.advanceTimersByTimeAsync(0);
    };
    await answer(1, 'list_tabs');
    connection.agent.pause('b1', true);
    await answer(2, 'close_tab', { tab_id: 'a1' });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sent.find((m) => m.id === 2)?.result).toMatchObject({ isError: true, content: [{ text: CONTROL_REFUSALS.paused }] });
    expect(nodeOf(t.store.state, 'b1')).toBeDefined();
    // Asked again, and the client gives up while it waits (round 1 of #145, SF3): it never closes the tab later.
    connection.agent.pause('b1', true);
    await answer(4, 'close_tab', { tab_id: 'a1' });
    connection.message({ method: 'notifications/cancelled', params: { requestId: 4 } });
    await vi.advanceTimersByTimeAsync(0);
    connection.agent.pause('b1', false);
    await vi.advanceTimersByTimeAsync(10);
    expect(nodeOf(t.store.state, 'b1')).toBeDefined();
    // Once you leave it, it closes.
    connection.agent.pause('b1', false);
    await answer(3, 'close_tab', { tab_id: 'a1' });
    expect(sent.find((m) => m.id === 3)?.result).toMatchObject({ isError: false, content: [{ text: 'Closed.' }] });
    expect(nodeOf(t.store.state, 'b1')).toBeUndefined();
  });

  it('the frame stays on while the agent works: never off and on between its actions, off once it’s quiet AGENT_STEADY_MS, at once on Stop (the owner, 2026-11-24)', async () => {
    vi.useFakeTimers();
    const t = setup();
    // What the tab's bar and frame were each time they changed (null: off).
    const seen: (string | null)[] = [];
    const dispatch = t.store.dispatch.bind(t.store);
    t.store.dispatch = ((c: Command) => {
      if (c.t === 'tab.live' && c.nodeId === 'a1') seen.push((c.live as { agent: { state: string } | null }).agent?.state ?? null);
      return dispatch(c);
    }) as typeof t.store.dispatch;
    const act = (name: string) =>
      t.agent.call(
        'a1',
        async () => {
          t.chords.doing('a1', { tool: 'click', name, role: 'button' });
          await vi.advanceTimersByTimeAsync(100);
          t.chords.doing('a1', null);
        },
        () => undefined,
      );
    // Three moves, the model thinking 5 to 20 s between them: on the whole time.
    await act('Fold');
    await vi.advanceTimersByTimeAsync(5_000);
    await act('Call');
    await vi.advanceTimersByTimeAsync(20_000);
    await act('Raise');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(null);
    expect(agentLive(t.store, 'a1')).toMatchObject({ state: 'working' });
    // Quiet past AGENT_STEADY_MS: off.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(agentLive(t.store, 'a1')).toBeNull();
    // Working again, then Stop: shown as stopped at once, never left on as working.
    await act('Check');
    t.agent.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentLive(t.store, 'a1')).toMatchObject({ state: 'stopped' });
    vi.useRealTimers();
  });

  it('Keep and Close all wait until the agent is done; Undo asks again; a page made while it works runs at full speed', async () => {
    const t = setup();
    // Still at work: a toast from before can't take its tabs.
    t.chords.keep('w1', t.chordId);
    t.chords.closeAll(t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toMatchObject({ chordId: t.chordId });
    // A page made while a call runs on its tab gets full speed at once.
    let finish!: () => void;
    const running = t.agent.call('a1', () => new Promise<void>((r) => (finish = r)), () => undefined);
    const late = t.page('a1');
    (late as unknown as { throttled: boolean }).throttled = true;
    t.chords.wire(late, 'a1');
    expect((late as unknown as { throttled: boolean }).throttled).toBe(false);
    finish();
    await running;
    t.chords.done(t.agent);
    t.chords.closeAll(t.chordId);
    const undo = t.toasts.at(-1)!;
    t.chords.undoClose((undo.action as { command: { token: string } }).command.token);
    expect(t.toasts.at(-1)).toMatchObject({ message: 'Claude Code finished. Keep these tabs?' });
    // And Keep works on the chord that came back.
    t.chords.keep('w1', t.chordId);
    expect(nodeOf(t.store.state, 'a1')).toMatchObject({ chordId: 'c1' });
  });
});

type Reply = { id?: number; result?: { content: { text: string }[]; isError: boolean } };

/** An agent connected to `t`'s chords, its tabs' page the one `contents` (loading, at no address yet), the Never list bank.test. */
function connected(t: ReturnType<typeof setup>, loadMs?: number) {
  const events = new EventEmitter();
  const page = { at: '', loading: true };
  const contents = Object.assign(events, { isDestroyed: () => false, isLoading: () => page.loading, getURL: () => page.at, getTitle: () => 'Statements for Ada' }) as unknown as WebContents;
  const sent: Reply[] = [];
  const connection = agentConnection({ type: 'hello', initialize: { clientInfo: { title: 'Claude Code' } }, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) }, (m) => void sent.push(m as never), {
    present: async () => 'once',
    browser: { store: t.store, tabs: { get: () => undefined, ensure: () => ({ webContents: contents }) as never }, readers: { viewFor: () => undefined } },
    chords: t.chords,
    dispatch: (c) => t.store.dispatch(c),
    neverSites: () => ['bank.test'],
    ...(loadMs ? { loadMs } : {}),
  });
  const reply = async (id: number, name: string, args: Record<string, unknown> = {}) => {
    connection.message({ id, method: 'tools/call', params: { name, arguments: args } });
    await vi.waitFor(() => expect(sent.find((m) => m.id === id)).toBeDefined());
    return sent.find((m) => m.id === id)!.result!;
  };
  const tabs = () => nodeList(t.store.state).filter((n) => n.kind === 'tab' && n.chordId === t.chords.chordOf(connection.agent));
  return { connection, events, page, sent, reply, tabs };
}

const PRIVATE = /bank|statements|Ada/i;
const signIn = (url: string) => `The site ${new URL(url).origin} asked for a sign-in; Chord doesn’t sign agents in.`;

describe('open_tab and a Never site (security review)', () => {
  // [address asked for, where the page ends up (asking for a sign-in on the way), what the agent hears, whether its tab stays]
  const table: [string, string, string, boolean][] = [
    ['https://bank.test/', 'https://bank.test/', 'That site is one the user keeps private, so it can’t be opened for you.', false],
    ['https://agent.test/go', 'https://www.bank.test/statements', 'That site is one the user keeps private, so it can’t be opened for you.', false],
    ['https://agent.test/go', 'https://agent.test/home', 'https://agent.test/home', true],
  ];
  it.each(table)('%s, landing on %s: %s; the whole reply says nothing of a Never site', async (asked, landed, said, stays) => {
    const t = setup(['bank.test']);
    const a = connected(t);
    const replied = a.reply(1, 'open_tab', { url: asked });
    await vi.waitFor(() => expect(a.events.listenerCount('did-stop-loading') + a.sent.length).toBeGreaterThan(0));
    // On the way, the site it lands on asks for a sign-in (the note names it); then it finishes loading there.
    const [tab] = a.tabs();
    if (tab) t.chords.note(tab.id, 'signin', signIn(landed));
    a.page.at = landed;
    a.page.loading = false;
    a.events.emit('did-stop-loading');
    const result = await replied;
    expect(result.isError).toBe(!stays);
    expect(result.content[0]!.text).toContain(said);
    if (stays) expect(JSON.stringify(result)).toContain(signIn(landed));
    else expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(a.tabs()).toHaveLength(stays ? 1 : 0);
    // Nothing of it comes later either.
    expect(JSON.stringify(await a.reply(2, 'list_tabs'))).not.toMatch(PRIVATE);
  });

  it('a tab that goes to a Never site after open_tab returned (its wait ended while it loaded) closes, and list_tabs and later replies never show it', async () => {
    const t = setup(['bank.test']);
    const a = connected(t, 20);
    const opened = await a.reply(1, 'open_tab', { url: 'https://agent.test/slow' });
    expect(JSON.parse(opened.content[0]!.text)).toMatchObject({ data: { loading: true } });
    const [tab] = a.tabs();
    // It redirects there: a sign-in box on the way, then it commits.
    a.page.at = 'https://bank.test/login';
    t.chords.note(tab!.id, 'signin', signIn('https://bank.test/login'));
    t.store.dispatch({ t: 'tab.updated', nodeId: tab!.id, url: 'https://bank.test/login', title: 'Statements for Ada' });
    expect(a.tabs()).toHaveLength(0);
    const listed = await a.reply(2, 'list_tabs');
    expect(JSON.stringify(listed)).not.toMatch(PRIVATE);
    expect(JSON.parse(listed.content[0]!.text)).toMatchObject({ data: { tabs: [] } });
    expect(JSON.stringify(await a.reply(3, 'read_tab', { tab_id: 'a1' }))).not.toMatch(PRIVATE);
  });

  it('list_tabs while a tab is on a Never site, before anything closes it: not listed, and nothing it held is told', () => {
    // These chords don't close it (no Never list of their own): the scope still leaves it out.
    const t = setup();
    const scope = agentScope(t.agent, { state: () => t.store.state, chordId: () => t.chordId, neverSites: () => ['bank.test'] });
    t.store.dispatch({ t: 'tab.updated', nodeId: 'a1', url: 'https://bank.test/' });
    expect(scope.tabs().map(({ node }) => node.id)).toEqual(['a2']);
    const closing = setup(['bank.test']);
    const page = closing.page('a1') as unknown as { getURL?: () => string };
    page.getURL = () => 'https://bank.test/';
    closing.chords.note('a1', 'download', 'statement-ada.pdf');
    closing.chords.note('a2', 'dialog', 'alert: hi');
    expect(closing.chords.drain(closing.agent).map((n) => n.nodeId)).toEqual(['a2']);
  });
});

describe('S18 M1d', () => {
  it('a site asking again and again for a sign-in is one note per tab and origin until the agent hears it', () => {
    const t = setup();
    const asked = (origin: string) => `The site ${origin} asked for a sign-in; Chord doesn’t sign agents in.`;
    for (let i = 0; i < 5; i++) t.chords.note('a1', 'signin', asked('https://a.test'));
    t.chords.note('a1', 'signin', asked('https://b.test'));
    t.chords.note('a2', 'signin', asked('https://a.test'));
    t.chords.note('a1', 'dialog', 'alert: hi');
    t.chords.note('a1', 'dialog', 'alert: hi');
    expect(t.chords.drain(t.agent).map((n) => `${n.nodeId} ${n.what} ${n.detail.slice(9, 23)}`)).toEqual([
      'a1 signin https://a.test',
      'a1 signin https://b.test',
      'a2 signin https://a.test',
      'a1 dialog ',
      'a1 dialog ',
    ]);
    // Heard: the next ask is a new note.
    t.chords.note('a1', 'signin', asked('https://a.test'));
    expect(t.chords.drain(t.agent)).toHaveLength(1);
  });
});

describe('S18 M1e: Never sites (review of #83)', () => {
  it('a popup or a download from a site the user keeps private is never named in a note', () => {
    const t = setup(['bank.test']);
    t.chords.note('a1', 'popup', 'https://login.bank.test/secret?id=42');
    t.chords.note('a1', 'popup', 'https://news.test/story');
    t.chords.note('a1', 'download', 'statement-2026.pdf', 'https://bank.test/statements/2026.pdf');
    t.chords.note('a1', 'download', 'notes.txt', 'https://files.test/notes.txt');
    expect(t.chords.drain(t.agent).map((n) => `${n.what}: ${n.detail}`)).toEqual([
      'popup: a site the user keeps private',
      'popup: https://news.test/story',
      'download: a file from a site the user keeps private',
      'download: notes.txt',
    ]);
  });

  it('a site added to the Never list closes the agent tabs already on it', () => {
    const never: string[] = [];
    const t = setup(never);
    t.store.dispatch({ t: 'tab.updated', nodeId: 'a1', url: 'https://bank.test/home' });
    expect(nodeOf(t.store.state, 'a1')).toBeDefined();
    never.push('bank.test');
    t.store.dispatch({ t: 'settings.set', settings: { assistant: { neverSites: ['bank.test'] } } });
    expect(nodeOf(t.store.state, 'a1')).toBeUndefined();
    expect(nodeOf(t.store.state, 'a2')).toBeDefined();
  });

  it('you take an agent’s tab to a Never site: it becomes yours, and the agent hears it closed; the agent going there still closes it', () => {
    // [you acted in it just now, what becomes of it]
    const table: [boolean, 'yours' | 'closed'][] = [
      [true, 'yours'],
      [false, 'closed'],
    ];
    for (const [acted, outcome] of table) {
      let now = 1_000_000;
      const t = setup(['bank.test']);
      const handed: string[] = [];
      const chords = new AgentChords({ store: t.store, page: t.page, lastWindow: () => null, neverSites: () => ['bank.test'], now: () => now });
      chords.onHandedOver = (id) => void handed.push(id);
      const agent = new ControlAgent('agent:2', async () => 'once');
      const chordId = chords.chordFor(agent, 'Codex', null);
      t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'b1', url: 'https://agent.test/b1' });
      t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'b1' });
      expect(t.store.state.windows['w1']!.agentTab).toBe('b1');
      if (acted) chords.userActed('b1');
      now += 5_000;
      t.store.dispatch({ t: 'tab.updated', nodeId: 'b1', url: 'https://bank.test/login' });
      if (outcome === 'yours') {
        expect(nodeOf(t.store.state, 'b1')).toMatchObject({ chordId: 'c1', section: 'today' });
        expect(handed).toEqual(['b1']);
      } else {
        expect(nodeOf(t.store.state, 'b1')).toBeUndefined();
        expect(handed).toEqual([]);
      }
    }
  });

  it('your key or click long ago doesn’t count: the agent took it there', () => {
    let now = 1_000_000;
    const t = setup(['bank.test']);
    const chords = new AgentChords({ store: t.store, page: t.page, lastWindow: () => null, neverSites: () => ['bank.test'], now: () => now });
    const agent = new ControlAgent('agent:3', async () => 'once');
    const chordId = chords.chordFor(agent, 'Codex', null);
    t.store.dispatch({ t: 'agent.tab.add', chordId, nodeId: 'c9', url: 'https://agent.test/c9' });
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'c9' });
    chords.userActed('c9');
    now += 60_000;
    t.store.dispatch({ t: 'tab.updated', nodeId: 'c9', url: 'https://bank.test/login' });
    expect(nodeOf(t.store.state, 'c9')).toBeUndefined();
  });
});
