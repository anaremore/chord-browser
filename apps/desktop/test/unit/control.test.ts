/**
 * The control layer in main (S18 M1a): the gate's agent (Stop answers a call
 * in flight at once, grants last, cards go with Stop, a pause holds calls)
 * and the tools' path through it, on a fake page: refs that are unknown or
 * closed, never-readable pages, cards, page_id, and Stop mid-read. Duet's own
 * behaviour is covered, unchanged, by assistant.spec.ts.
 */
import { EventEmitter } from 'node:events';
import { bucketOf, CONTROL_REFUSALS, TabRefs, type Grant, type NodeId, type State, type TabNode } from '@chord/core';
import type { WebContents, WebContentsView } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlAgent, type ControlCard } from '../../src/main/control/gate';
import type { ActHost, ControlScope, ToolMemory } from '../../src/main/control/scope';
import { runControlTool, stepSubmits, type ControlBrowser } from '../../src/main/control/tools';
import { focusToGiveBack } from '../../src/main/control/page';
import { endUntil, holdSends, sendHoldDeps, failHeld, type SendAnswer } from '../../src/main/control/sends';
import { NOT_SHARED } from '../../src/main/agents/scope';
import { siteOfUrl } from '../../src/main/agents/shares';

afterEach(() => vi.useRealTimers());

const card = (over: Partial<Omit<ControlCard, 'id'>> = {}): Omit<ControlCard, 'id'> => ({ kind: 'read', tool: 'read_tab', description: 'Read “A”', target: [], tab: 'n1', subject: 'read_tab', ...over });

/** A presenter that keeps each card's answer for the test to give. */
function presenter() {
  const shown: { card: ControlCard; answer(grant: Grant): void; signal: AbortSignal }[] = [];
  const present = (c: ControlCard, signal: AbortSignal) =>
    new Promise<Grant>((resolve) => {
      shown.push({ card: c, answer: resolve, signal });
      signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });
  return { shown, present };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ControlAgent', () => {
  it('Stop answers a call in flight at once, refuses new ones, and lets go on resume', async () => {
    const agent = new ControlAgent('a', presenter().present);
    let finish!: (v: string) => void;
    const running = agent.call('n1', () => new Promise<string>((r) => (finish = r)), (why) => `refused:${why}`);
    expect(agent.kind('n1')).toBe('working');
    agent.stop();
    await expect(running).resolves.toBe('refused:stopped');
    expect(agent.kind('n1')).toBe('stopped');
    expect(agent.kind(null)).toBe('stopped');
    // The work ending later changes nothing.
    finish('late');
    await expect(agent.call('n2', async () => 'ran', (why) => `refused:${why}`)).resolves.toBe('refused:stopped');
    agent.resume();
    await expect(agent.call('n2', async () => 'ran', (why) => `refused:${why}`)).resolves.toBe('ran');
    expect(agent.kind('n1')).toBe('idle');
  });

  it('gives each call the signal Stop aborts', async () => {
    const agent = new ControlAgent('a', presenter().present);
    let seen!: AbortSignal;
    const running = agent.call(null, (signal) => ((seen = signal), new Promise<string>(() => undefined)), () => 'stopped');
    agent.stop();
    await running;
    expect(seen.aborted).toBe(true);
  });

  // [the user's answer, what ask returns, whether the next ask shows a card]
  const answers: [Grant, Grant, boolean][] = [
    ['once', 'once', true],
    ['always', 'always', false],
    ['deny', 'deny', true],
  ];
  it.each(answers)('a read card answered %s', async (answer, returned, asksAgain) => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const asked = agent.ask(card(), new AbortController().signal);
    await tick();
    expect(shown).toHaveLength(1);
    expect(agent.kind('n1')).toBe('waiting');
    shown[0]!.answer(answer);
    await expect(asked).resolves.toBe(returned);
    expect(agent.kind('n1')).toBe('idle');
    void agent.ask(card(), new AbortController().signal);
    await tick();
    expect(shown.length === 2).toBe(asksAgain);
  });

  it('remembers a denied connection, and an allowed one, for the agent’s life', async () => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const first = agent.ask(card({ kind: 'connection', tab: null, subject: 'claude' }), new AbortController().signal);
    await tick();
    shown[0]!.answer('deny');
    await first;
    await expect(agent.ask(card({ kind: 'connection', tab: null, subject: 'claude' }), new AbortController().signal)).resolves.toBe('deny');
    expect(shown).toHaveLength(1);
    expect(agent.granted('connection', 'claude')).toBe('deny');
  });

  it('takes cards down as a no on Stop and on cancelCards; a call whose own signal aborts answers no and leaves the card up', async () => {
    for (const end of ['stop', 'cancel', 'signal'] as const) {
      const { shown, present } = presenter();
      const agent = new ControlAgent('a', present);
      const call = new AbortController();
      const asked = agent.ask(card(), call.signal);
      await tick();
      if (end === 'stop') agent.stop();
      else if (end === 'cancel') agent.cancelCards();
      else call.abort();
      await expect(asked).resolves.toBe('deny');
      expect(shown[0]!.signal.aborted).toBe(end !== 'signal');
      expect(agent.hasOpenCard('read', 'read_tab', 'n1')).toBe(end === 'signal');
      // Nothing was kept for good.
      expect(agent.granted('read', 'read_tab')).toBeUndefined();
    }
  });

  it('a site card is the agent’s for the site: two tabs’ asks wait on one card, and one answer settles both (M2c)', async () => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const signal = new AbortController().signal;
    const first = agent.ask(card({ kind: 'site', tool: 'click', subject: 'shop.example', tab: 'n1' }), signal);
    const second = agent.ask(card({ kind: 'site', tool: 'type', subject: 'shop.example', tab: 'n2' }), signal);
    await tick();
    expect(shown).toHaveLength(1);
    // The card names the first tab's action; both tabs' bars say they're waiting.
    expect(shown[0]!.card.tool).toBe('click');
    expect([agent.state('n1').cards.length, agent.state('n2').cards.length]).toEqual([1, 1]);
    shown[0]!.answer('once');
    await expect(first).resolves.toBe('once');
    expect([agent.state('n1').cards.length, agent.state('n2').cards.length]).toEqual([0, 0]);
    await expect(second).resolves.toBe('once');
    // Another site is its own card.
    void agent.ask(card({ kind: 'site', tool: 'click', subject: 'other.example', tab: 'n1' }), signal);
    await tick();
    expect(shown).toHaveLength(2);
  });

  it('holds a paused tab’s calls until the user leaves it, or answers paused after 45 s', async () => {
    vi.useFakeTimers();
    const agent = new ControlAgent('a', presenter().present);
    agent.pause('n1', true);
    expect(agent.kind('n1')).toBe('paused');
    const held = agent.call('n1', async () => 'ran', (why) => why);
    // Other tabs aren't held.
    await expect(agent.call('n2', async () => 'ran', (why) => why)).resolves.toBe('ran');
    agent.pause('n1', false);
    await expect(held).resolves.toBe('ran');
    agent.pause('n1', true);
    const waiting = agent.call('n1', async () => 'ran', (why) => why);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(waiting).resolves.toBe('paused');
  });
});

/* ---------- The tools through the gate, on a fake page ---------- */

const tab = (id: string, url: string, title = 'Article'): TabNode => ({ id, kind: 'tab', chordId: 'c1', url, title }) as TabNode;

function stateWith(nodes: TabNode[]): State {
  const buckets: Record<string, Record<string, TabNode>> = {};
  for (const n of nodes) (buckets[bucketOf(n.id)] ??= {})[n.id] = n;
  return { nodes: buckets } as unknown as State;
}

type Answer = 'hang' | { text: string } | ((code: string, events: EventEmitter) => Promise<unknown>);

/** A page that answers the extractor with `read`, never (`hang`), or as a test's function does. */
function fakePage(url: string, read: Answer) {
  const events = new EventEmitter();
  // history: the tab's entries as Chromium keeps them (skippable: added by the page without a gesture, which goBack skips).
  const at: {
    url: string;
    onCapture?: () => void;
    pdfLandsAt?: string;
    zoom: number;
    input: unknown[];
    text: string[];
    loads: string[];
    history: { url: string; skippable?: boolean }[];
    active: number;
    /** The debugger's answers (control/deep.ts): its hit test, a closed shadow root in the element, a file picker held. */
    deep: { hit?: unknown; closed?: boolean; picker?: boolean; unavailable?: boolean; posts?: boolean; ping?: boolean; persistent?: boolean; opens?: string[] };
    debugging: string[];
    /** A debugger event, as Chromium would send it (a request the page makes, paused). */
    emitDebug?: (method: string, params: unknown, sessionId?: string) => void;
    /** The page's requests went (deep.ping, deep.posts): once per page. */
    sent?: boolean;
    /** Every debugger command, with its parameters. */
    commands?: [string, unknown][];
  } = { url, zoom: 1, input: [], text: [], loads: [], history: [{ url }], active: 0, deep: {}, debugging: [] };
  const debugEvents = new EventEmitter();
  let attached = false;
  at.emitDebug = (method, params, sessionId) => void debugEvents.emit('message', {}, method, params, sessionId);
  const go = (index: number) => {
    at.active = index;
    at.url = at.history[index]!.url;
    events.emit('did-navigate');
    events.emit('did-stop-loading');
  };
  const contents = {
    // Acting (S18 M2c): what an action sends, recorded.
    getZoomFactor: () => at.zoom,
    sendInputEvent: (e: unknown) => {
      at.input.push(e);
      // A page that sends as the agent acts (S18 M2d): its requests, paused by the tab's send hold, once its first input came.
      if (!at.sent && (at.deep.ping || at.deep.posts)) {
        at.sent = true;
        if (at.deep.ping) setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'b1', request: { method: 'POST', url: 'https://stats.test/collect' }, resourceType: 'Ping' }), 0);
        if (at.deep.posts) setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'r1', request: { method: 'POST', url: 'https://news.test/save' }, resourceType: 'Document' }), 0);
      }
    },
    setIgnoreMenuShortcuts: () => undefined,
    insertText: async (text: string) => void at.text.push(text),
    getTitle: () => 'Article',
    loadURL: async (to: string) => {
      at.loads.push(to);
      at.history = [...at.history.slice(0, at.active + 1), { url: to }];
      go(at.history.length - 1);
    },
    navigationHistory: {
      canGoBack: () => at.active > 0,
      getActiveIndex: () => at.active,
      getEntryAtIndex: (i: number) => at.history[i],
      goToIndex: (i: number) => go(i),
      // Chromium's: past the entries the page added without a gesture.
      goBack: () => {
        let i = at.active - 1;
        while (i > 0 && at.history[i]!.skippable) i--;
        go(i);
      },
    },
    // A PDF's bytes, fetched through the tab's session: it ends up at `pdfLandsAt` (a redirect), else where it was asked.
    session: {
      fetch: async (asked: string) => {
        const response = new Response('%PDF-1.4');
        Object.defineProperty(response, 'url', { value: at.pdfLandsAt ?? asked });
        return response;
      },
    },
    // The debugger, as Chromium's DevTools protocol answers deep.ts.
    debugger: {
      isAttached: () => attached,
      attach: () => {
        if (at.deep.unavailable) throw new Error('Another debugger is already attached');
        attached = true;
      },
      detach: () => void (attached = false),
      on: (e: string, f: (...a: unknown[]) => void) => debugEvents.on(e, f),
      off: (e: string, f: (...a: unknown[]) => void) => debugEvents.off(e, f),
      sendCommand: async (method: string, params?: { expression?: string }) => {
        at.debugging.push(method);
        (at.commands ??= []).push([method, params]);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
        if (method === 'Runtime.enable') debugEvents.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7, auxData: { frameId: 'F', type: 'isolated' } } });
        if (method === 'Runtime.evaluate') {
          if (params?.expression?.includes('instanceof Map')) return { result: { value: true } };
          // deep.open's look at the element: what the page answers, in turn (the node replaced, the snapshot gone).
          const opened = params?.expression?.includes("'replaced'") ? at.deep.opens?.shift() : undefined;
          return opened ? { result: { type: 'string', value: opened } } : { result: { objectId: 'el' } };
        }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'F' };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'hit' } };
        if (method === 'Runtime.callFunctionOn') {
          if (at.deep.picker) debugEvents.emit('message', {}, 'Page.fileChooserOpened', {});
          return { result: { value: at.deep.hit ?? { ok: true } } };
        }
        if (method === 'DOM.describeNode') return { node: at.deep.closed ? { children: [{ shadowRoots: [{ shadowRootType: 'closed' }] }] } : { shadowRoots: [{ shadowRootType: 'open' }] } };
        return {};
      },
    },
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => at.url,
    on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
    once: (e: string, f: (...a: unknown[]) => void) => events.once(e, f),
    off: (e: string, f: (...a: unknown[]) => void) => events.off(e, f),
    capturePage: async () => {
      at.onCapture?.();
      return { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from('secret') };
    },
    executeJavaScriptInIsolatedWorld: (_world: number, [script]: { code: string }[]) =>
      typeof read === 'function'
        ? read(script!.code, events)
        : read === 'hang'
          ? new Promise(() => undefined)
          : Promise.resolve({ title: 'Article', url, contentType: 'text/html', text: read.text, selection: '' }),
  };
  return { contents: contents as unknown as WebContents, events, at };
}

/** The tab goes to `url`: its page, and its saved address too unless `pageOnly` (a redirect the store hasn't heard of yet). */
type Go = (id: NodeId, url: string, pageOnly?: boolean) => void;
/** What a test does to a tab meanwhile: it goes somewhere, or closes. */
type Meanwhile = { go: Go; close(id: NodeId): void };

function setup(
  opts: {
    needsCard?: boolean;
    answer?: Grant | 'hold';
    read?: Answer;
    cardWaitMs?: number;
    onCard?: (t: Meanwhile) => void;
    onEnsure?: (t: Meanwhile) => void;
    onCapture?: (t: Meanwhile) => void;
    /** A scope that reads only on this site, as an outside agent's does a shared tab (S18 M1e). */
    sharedOn?: string;
    /** A scope that offers M2's tools (S18 M2b). */
    actions?: boolean;
    /** A scope that lets its agent act (S18 M2c), and what it says. */
    act?: Partial<ActHost>;
    /** Where a PDF's download ends up. */
    pdfLandsAt?: string;
  } = {},
) {
  let nodes = [tab('n1', 'https://news.test/a'), tab('n2', 'https://private.test/'), tab('n3', 'https://news.test/b')];
  let state = stateWith(nodes);
  const pages = new Map<NodeId, ReturnType<typeof fakePage>>(nodes.map((n) => [n.id, fakePage(n.url, opts.read ?? { text: `Text of ${n.id}` })]));
  const view = (id: NodeId) => (pages.has(id) ? ({ webContents: pages.get(id)!.contents } as WebContentsView) : undefined);
  const browser: ControlBrowser = {
    store: {
      get state() {
        return state;
      },
    },
    tabs: { get: view, ensure: (id) => (opts.onEnsure?.({ go, close }), view(id)) },
    readers: { viewFor: () => undefined },
  };
  const cards: ControlCard[] = [];
  function close(id: NodeId) {
    state = stateWith(nodes.filter((n) => n.id !== id));
  }
  for (const page of pages.values()) {
    page.at.onCapture = () => opts.onCapture?.({ go, close });
    if (opts.pdfLandsAt) page.at.pdfLandsAt = opts.pdfLandsAt;
  }
  const go: Go = (id, url, pageOnly = false) => {
    pages.get(id)!.at.url = url;
    if (pageOnly) return;
    nodes = nodes.map((n) => (n.id === id ? { ...n, url } : n));
    state = stateWith(nodes);
  };
  const agent = new ControlAgent('test', (c, signal) => {
    cards.push(c);
    opts.onCard?.({ go, close });
    if (opts.answer !== 'hold') return Promise.resolve(opts.answer ?? 'once');
    return new Promise<Grant>((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
  });
  const activity: string[] = [];
  const memory: ToolMemory = { pdfs: new Map(), form: null, nextField: 1, read: new Set() };
  const scope: ControlScope = {
    agent,
    ...(opts.actions ? { actions: true } : {}),
    ...(opts.act ? { act: { mayAct: () => null, siteOf: (url: string) => siteOfUrl(url), siteAllowed: () => false, keepSite: () => undefined, doing: () => undefined, ...opts.act } } : {}),
    refs: new TabRefs<NodeId>('t'),
    memory,
    off: () => null,
    tabs: () => nodes.filter((n) => n.id !== 'n2').map((node) => ({ node, given: node.id === 'n1' })),
    defaultTab: () => nodes[0]!,
    readable: (node) => !node.url.includes('private.test'),
    neverSites: () => ['private.test'],
    needsCard: (tool) => (opts.needsCard ? { kind: 'read', subject: tool } : null),
    mayInspect: (node) => (node.id === 'n1' ? null : 'Not that one.'),
    ...(opts.cardWaitMs ? { cardWaitMs: opts.cardWaitMs } : {}),
    ...(opts.sharedOn ? { siteOk: (_node: TabNode, url: string) => siteOfUrl(url) === opts.sharedOn, whyNot: () => NOT_SHARED } : {}),
    activity: async (_tool, summary) => void activity.push(summary),
  };
  const call = (name: string, args: Record<string, unknown> = {}) => runControlTool(scope, browser, name, args);
  return { scope, agent, call, close, cards, activity, pages, go };
}

const refusal = (out: { text?: string }) => (JSON.parse(out.text!) as { data: { refused?: string; error?: string } }).data;

describe('The tools, through the gate', () => {
  it('refuse a ref never given, a closed tab’s ref, and a page that can never be read', async () => {
    const { scope, call, close } = setup();
    const [r1, r2, r3] = ['n1', 'n2', 'n3'].map((id) => scope.refs.refFor(id));
    close('n3');
    // [tool call, what it says]
    const table: [string, Record<string, unknown>, string][] = [
      ['read_tab', { tab_id: 't9' }, 'No such tab. Use list_tabs or an attached tab id.'],
      ['read_tab', { tab_id: r3 }, CONTROL_REFUSALS.closed],
      ['page_diagnostics', { tab_id: 't9' }, 'No such tab. Use the tab id from "Attached:".'],
      ['read_form', { tab_id: r3 }, CONTROL_REFUSALS.closed],
      ['read_tab', { tab_id: r2 }, 'This page can never be read (a private window, a Chord page, or a site the user keeps private).'],
      ['tab_screenshot', { tab_id: r2 }, 'This page can never be read (a private window, a Chord page, or a site the user keeps private).'],
    ];
    for (const [tool, args, said] of table) {
      const out = await call(tool, args);
      expect(out.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(refusal(out).refused).toBe(said);
    }
    expect(r1).toBe('t1');
    expect(refusal(await call('no_such_tool')).error).toBe('Unknown tool no_such_tool');
    // Not offered by this scope (no search, no fill card).
    expect(refusal(await call('search_history', { query: 'x' })).error).toBe('Unknown tool search_history');
  });

  it('reads a tab with its page_id, which changes when the page navigates', async () => {
    const { scope, call, pages, activity } = setup();
    const ref = scope.refs.refFor('n1');
    const first = JSON.parse((await call('read_tab', { tab_id: ref })).text!) as { tab_id: string; page_id: string; content: string };
    expect(first).toMatchObject({ tab_id: 't1', content: 'Text of n1', trust: 'untrusted' });
    expect(first.page_id).toMatch(/^p\d+$/);
    const again = JSON.parse((await call('read_tab', { tab_id: ref })).text!) as { page_id: string };
    expect(again.page_id).toBe(first.page_id);
    pages.get('n1')!.events.emit('did-navigate');
    const moved = JSON.parse((await call('read_tab', { tab_id: ref })).text!) as { page_id: string };
    expect(moved.page_id).not.toBe(first.page_id);
    pages.get('n1')!.events.emit('did-navigate-in-page', {}, 'https://news.test/a#2', false);
    expect((JSON.parse((await call('read_tab', { tab_id: ref })).text!) as { page_id: string }).page_id).toBe(moved.page_id);
    expect(activity).toEqual(['Read “Article”', 'Read “Article”', 'Read “Article”', 'Read “Article”']);
    expect([...scope.memory.read]).toEqual(['n1']);
  });

  it('lists the scope’s tabs with refs that last', async () => {
    const { call } = setup();
    const listed = JSON.parse((await call('list_tabs')).text!) as { data: { tabs: { tab_id: string; site: string; attached: boolean }[] } };
    expect(listed.data.tabs).toEqual([
      { tab_id: 't1', title: 'Article', site: 'news.test', attached: true },
      { tab_id: 't2', title: 'Article', site: 'news.test', attached: false },
    ]);
  });

  it('asks first where the scope says so: a no is refused, and the card names the tab', async () => {
    const { scope, call, cards } = setup({ needsCard: true, answer: 'deny' });
    const out = await call('read_tab', { tab_id: scope.refs.refFor('n1') });
    expect(refusal(out).refused).toBe('The user said no to reading that tab. Carry on without it, or ask them.');
    expect(cards).toEqual([expect.objectContaining({ kind: 'read', tool: 'read_tab', description: 'Read “Article”', target: ['https://news.test/a'], tab: 'n1', subject: 'read_tab' })]);
  });

  it('Stop answers a read in flight at once with the stopped refusal, and adds nothing to the chat', async () => {
    const { scope, agent, call, activity } = setup({ read: 'hang' });
    const reading = call('read_tab', { tab_id: scope.refs.refFor('n1') });
    await tick();
    expect(agent.kind('n1')).toBe('working');
    agent.stop();
    const out = await reading;
    expect(out.isError).toBe(true);
    expect(refusal(out).refused).toBe(CONTROL_REFUSALS.stopped);
    expect(refusal(await call('list_tabs')).refused).toBe(CONTROL_REFUSALS.stopped);
    expect(activity).toEqual([]);
    agent.resume();
    expect((await call('list_tabs')).isError).toBeUndefined();
  });
});

describe('The tools, review items from #75', () => {
  it('leave page_id out when the page navigated during the read, and follow navigations from before the first read', async () => {
    const { scope, call } = setup({
      read: async (_code, events) => {
        events.emit('did-navigate');
        return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'moved', selection: '' };
      },
    });
    const out = JSON.parse((await call('read_tab', { tab_id: scope.refs.refFor('n1') })).text!) as Record<string, unknown>;
    expect(out['content']).toBe('moved');
    expect(out).not.toHaveProperty('page_id');
  });

  it('keep nothing in the agent’s memory from a call cut off by Stop', async () => {
    let answer!: (v: unknown) => void;
    const { scope, agent, call } = setup({ read: () => new Promise((r) => (answer = r)) });
    const reading = call('read_form', { tab_id: scope.refs.refFor('n1') });
    await tick();
    agent.stop();
    expect(refusal(await reading).refused).toBe(CONTROL_REFUSALS.stopped);
    // The page answers after Stop: nothing of it is kept.
    answer({ url: 'https://news.test/a', forms: [], controls: [], truncated: false });
    await tick();
    expect(scope.memory.form).toBeNull();
    expect(scope.memory.nextField).toBe(1);
  });

  it('answer waiting after the scope’s wait, and a retry waits on the same card', async () => {
    const { scope, call, cards, agent } = setup({ needsCard: true, answer: 'hold', cardWaitMs: 20 });
    const ref = scope.refs.refFor('n1');
    expect(refusal(await call('read_tab', { tab_id: ref })).refused).toBe(CONTROL_REFUSALS.waiting);
    expect(refusal(await call('read_tab', { tab_id: ref })).refused).toBe(CONTROL_REFUSALS.waiting);
    expect(cards).toHaveLength(1);
    expect(agent.hasOpenCard('read', 'read_tab', 'n1')).toBe(true);
    // A different subject is a card of its own.
    expect(refusal(await call('tab_screenshot', { tab_id: ref })).refused).toBe(CONTROL_REFUSALS.waiting);
    expect(cards).toHaveLength(2);
  });

  it('let the scope decide where forms and diagnostics may look', async () => {
    const { scope, call } = setup();
    expect(refusal(await call('read_form', { tab_id: scope.refs.refFor('n3') })).refused).toBe('Not that one.');
    expect(refusal(await call('page_diagnostics', { tab_id: scope.refs.refFor('n3') })).refused).toBe('Not that one.');
  });
});

describe('Cards, review 1 of #76', () => {
  it('two reads of different tabs at once get a card each, and Allow once on one never reads the other', async () => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const a = agent.ask(card({ tab: 'n1', description: 'Read “A”' }), new AbortController().signal);
    const b = agent.ask(card({ tab: 'n2', description: 'Read “B”' }), new AbortController().signal);
    await tick();
    expect(shown.map((s) => [s.card.tab, s.card.description])).toEqual([
      ['n1', 'Read “A”'],
      ['n2', 'Read “B”'],
    ]);
    shown[0]!.answer('once');
    await expect(a).resolves.toBe('once');
    // B's card is still up, unanswered.
    expect(agent.hasOpenCard('read', 'read_tab', 'n2')).toBe(true);
    shown[1]!.answer('deny');
    await expect(b).resolves.toBe('deny');
    // Allow for this chat still covers the tool on every tab.
    const c = agent.ask(card({ tab: 'n3' }), new AbortController().signal);
    await tick();
    shown[2]!.answer('always');
    await c;
    await expect(agent.ask(card({ tab: 'n4' }), new AbortController().signal)).resolves.toBe('always');
    expect(shown).toHaveLength(3);
  });

  it('the same tab’s retry shares the card, and a once given after the waiting answer is kept for that retry, once', async () => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    await expect(agent.ask(card(), new AbortController().signal, 20)).resolves.toBe('waiting');
    expect(agent.hasOpenCard('read', 'read_tab', 'n1')).toBe(true);
    // The user allows it once, after the call already answered waiting.
    shown[0]!.answer('once');
    await tick();
    expect(agent.hasOpenCard('read', 'read_tab', 'n1')).toBe(false);
    await expect(agent.ask(card(), new AbortController().signal, 20)).resolves.toBe('once');
    expect(shown).toHaveLength(1);
    // Used once: the next read asks again.
    void agent.ask(card(), new AbortController().signal, 20);
    await tick();
    expect(shown).toHaveLength(2);
  });

  it('step cards never coalesce: two calls for one step ask two cards, and one Allow runs one (Neon’s review of #112)', async () => {
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const step = card({ kind: 'step', tool: 'click', subject: 'n1|p1|e4|click||false', tab: 'n1', target: ['https://shop.test/checkout'] });
    const first = agent.ask(step, new AbortController().signal);
    const second = agent.ask(step, new AbortController().signal);
    await tick();
    expect(shown).toHaveLength(2);
    shown[0]!.answer('once');
    await expect(first).resolves.toBe('once');
    let settled = false;
    void second.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    shown[1]!.answer('deny');
    await expect(second).resolves.toBe('deny');
  });

  it('a step’s late Allow counts for that same step only (tab, page, ref, action), for 2 minutes (S18 M2d)', async () => {
    vi.useFakeTimers();
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const step = (subject: string) => card({ kind: 'step', tool: 'click', subject, tab: 'n1', target: ['https://shop.test/checkout'] });
    const late = async (subject: string) => {
      const asked = agent.ask(step(subject), new AbortController().signal, 20);
      await vi.advanceTimersByTimeAsync(20);
      await expect(asked).resolves.toBe('waiting');
      shown.at(-1)!.answer('once');
      await vi.advanceTimersByTimeAsync(0);
    };
    await late('n1|p1|e4|click||false');
    // Another step (another ref) asks its own card; then the same step, within 2 minutes, takes the late Allow.
    void agent.ask(step('n1|p1|e5|click||false'), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(agent.ask(step('n1|p1|e4|click||false'), new AbortController().signal, 20)).resolves.toBe('once');
    expect(shown).toHaveLength(2);
    // Past 2 minutes it's gone.
    await late('n1|p2|e4|click||false');
    await vi.advanceTimersByTimeAsync(120_001);
    void agent.ask(step('n1|p2|e4|click||false'), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(4);
    // Never remembered: the same step asks again after its Allow was taken.
    void agent.ask(step('n1|p1|e4|click||false'), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(5);
  });

  it('a late Always on this site is carried to the retry, not lost to a second card; kept only by the action (keep)', async () => {
    vi.useFakeTimers();
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const site = { kind: 'site' as const, tool: 'click', subject: 'shop.test', tab: 'n1', target: ['https://shop.test/'] };
    const asked = agent.ask(card(site), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(asked).resolves.toBe('waiting');
    shown.at(-1)!.answer('always');
    await vi.advanceTimersByTimeAsync(0);
    // Not kept yet: the action it was for hasn't run.
    expect(agent.granted('site', 'shop.test')).toBeUndefined();
    await expect(agent.ask(card(site), new AbortController().signal, 20)).resolves.toBe('always');
    expect(shown).toHaveLength(1);
  });

  it('a late once answers only for the tab and address its card named, and only soon after', async () => {
    vi.useFakeTimers();
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const late = async (over: Partial<Omit<ControlCard, 'id'>>) => {
      const asked = agent.ask(card(over), new AbortController().signal, 20);
      await vi.advanceTimersByTimeAsync(20);
      await expect(asked).resolves.toBe('waiting');
      shown.at(-1)!.answer('once');
      await vi.advanceTimersByTimeAsync(0);
    };
    // A real late once on n1: another tab's read asks for itself.
    await late({ tab: 'n1', target: ['https://a.test/'] });
    void agent.ask(card({ tab: 'n2', target: ['https://a.test/'] }), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.map((s) => s.card.tab)).toEqual(['n1', 'n2']);
    // n1 has gone to another address since: its late once doesn't cover the new page.
    await late({ tab: 'n3', target: ['https://a.test/'] });
    void agent.ask(card({ tab: 'n3', target: ['https://b.test/'] }), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(4);
    // Past the wait, it's gone.
    await late({ tab: 'n4', target: ['https://a.test/'] });
    await vi.advanceTimersByTimeAsync(45_001);
    void agent.ask(card({ tab: 'n4', target: ['https://a.test/'] }), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(6);
    // In time and for the same address, it answers.
    await late({ tab: 'n5', target: ['https://a.test/'] });
    await expect(agent.ask(card({ tab: 'n5', target: ['https://a.test/'] }), new AbortController().signal, 20)).resolves.toBe('once');
    expect(shown).toHaveLength(7);
  });
});

describe('Never read, through a redirect (security review)', () => {
  const NEVER = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';
  const formAt = (url: string) => async () => ({ url, forms: [], controls: [], truncated: false });
  const readAt = (url: string) => async () => ({ title: 'Inbox', url, contentType: 'text/html', text: 'secret', selection: 'secret' });
  // [tool, how the tab got to the Never site, the setup that makes it so, what it says (the Never refusal unless given)]
  const table: [string, string, Parameters<typeof setup>[0], string?][] = [
    ['read_tab', 'navigated while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', 'https://private.test/inbox') }],
    ['read_selection', 'navigated while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', 'https://private.test/inbox') }],
    ['tab_screenshot', 'navigated while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', 'https://private.test/inbox') }],
    ['read_form', 'navigated while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', 'https://private.test/inbox') }],
    ['read_tab', 'redirected as it loaded', { onEnsure: ({ go }) => go('n1', 'https://private.test/inbox', true) }],
    ['tab_screenshot', 'redirected as it loaded', { onEnsure: ({ go }) => go('n1', 'https://mail.private.test/', true) }],
    ['read_form', 'redirected as it loaded', { onEnsure: ({ go }) => go('n1', 'https://private.test/inbox', true) }],
    ['read_tab', 'redirected during the read', { read: readAt('https://private.test/inbox') }],
    ['read_selection', 'redirected during the read', { read: readAt('https://private.test/inbox') }],
    ['read_form', 'redirected during the read', { read: formAt('https://private.test/inbox') }],
    ['read_selection', 'redirected as it loaded', { onEnsure: ({ go }) => go('n1', 'https://private.test/inbox', true) }],
    ['tab_screenshot', 'redirected while the picture was taken', { onCapture: ({ go }) => go('n1', 'https://private.test/inbox', true) }],
    ['tab_screenshot', 'closed while the picture was taken', { onCapture: ({ close }) => close('n1') }, CONTROL_REFUSALS.closed],
    // A blank or unloaded page isn't a Never site: the read's own words, as Duet has always said them.
    ['read_tab', 'was left blank as it loaded', { onEnsure: ({ go }) => go('n1', 'about:blank', true) }, 'That tab could not be loaded.'],
    ['tab_screenshot', 'was left blank as it loaded', { onEnsure: ({ go }) => go('n1', '', true) }, 'That tab could not be loaded.'],
    ['read_form', 'was left blank as it loaded', { onEnsure: ({ go }) => go('n1', 'about:blank', true) }, 'That page could not be read.'],
  ];
  it.each(table)('%s on a tab that %s: refused, and nothing read is kept', async (tool, _how, opts, said = NEVER) => {
    const { scope, call, activity } = setup(opts);
    const out = await call(tool, { tab_id: scope.refs.refFor('n1') });
    expect(out.isError).toBe(true);
    expect(out.image).toBeUndefined();
    expect(refusal(out).refused).toBe(said);
    expect(out.text).not.toContain('secret');
    expect([...scope.memory.read]).toEqual([]);
    expect(scope.memory.form).toBeNull();
    expect(activity).toEqual([]);
  });
});

describe('A shared tab is read only on its site (S18 M1e, review 1 of #96)', () => {
  const ELSEWHERE = 'https://elsewhere.test/page';
  const formAt = (url: string) => async () => ({ url, forms: [], controls: [], truncated: false });
  const readAt = (url: string) => async () => ({ title: 'Elsewhere', url, contentType: 'text/html', text: 'secret', selection: 'secret' });
  // [tool, how the tab left news.test, the setup that makes it so]
  const table: [string, string, Parameters<typeof setup>[0]][] = [
    ['read_tab', 'went elsewhere while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', ELSEWHERE) }],
    ['read_tab', 'was redirected as it loaded', { onEnsure: ({ go }) => go('n1', ELSEWHERE, true) }],
    ['read_tab', 'committed elsewhere mid-read', { read: readAt(ELSEWHERE) }],
    ['read_selection', 'committed elsewhere mid-read', { read: readAt(ELSEWHERE) }],
    ['read_form', 'was redirected as it loaded', { onEnsure: ({ go }) => go('n1', ELSEWHERE, true) }],
    ['read_form', 'committed elsewhere mid-read', { read: formAt(ELSEWHERE) }],
    ['tab_screenshot', 'was redirected as it loaded', { onEnsure: ({ go }) => go('n1', ELSEWHERE, true) }],
    ['tab_screenshot', 'went elsewhere while the picture was taken', { onCapture: ({ go }) => go('n1', ELSEWHERE, true) }],
    ['page_diagnostics', 'went elsewhere while the card was up', { needsCard: true, onCard: ({ go }) => go('n1', ELSEWHERE, true) }],
  ];
  it.each(table)('%s on a tab shared on news.test that %s: refused as no longer shared, and nothing read is kept', async (tool, _how, opts) => {
    const { scope, call, activity } = setup({ ...opts, sharedOn: 'news.test' });
    const out = await call(tool, { tab_id: scope.refs.refFor('n1') });
    expect(out.isError).toBe(true);
    expect(out.image).toBeUndefined();
    expect(refusal(out).refused).toBe(NOT_SHARED);
    expect(out.text).not.toContain('secret');
    expect([...scope.memory.read]).toEqual([]);
    expect(scope.memory.form).toBeNull();
    expect(activity).toEqual([]);
  });

  it('a shared PDF whose download ends up on another site: refused as no longer shared, not as never readable (#96)', async () => {
    const pdfRead = async () => ({ title: 'Guide', url: 'https://news.test/a', contentType: 'application/pdf', text: '', selection: '' });
    const { scope, call, activity } = setup({ sharedOn: 'news.test', read: pdfRead, pdfLandsAt: 'https://elsewhere.test/guide.pdf' });
    const out = await call('read_tab', { tab_id: scope.refs.refFor('n1') });
    expect(out.isError).toBe(true);
    expect(refusal(out).refused).toBe(NOT_SHARED);
    expect(activity).toEqual([]);
  });

  it('on its own site (another page of it) the read goes through', async () => {
    const { scope, call } = setup({ sharedOn: 'news.test', read: readAt('https://www.news.test/other') });
    const out = await call('read_tab', { tab_id: scope.refs.refFor('n1') });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('secret');
  });
});

/* ---------- snapshot (S18 M2b) ---------- */

describe('snapshot through the gate (S18 M2b)', () => {
  /** The page answers the snapshot script with these nodes (and anything else as a plain read). */
  const page = (nodes: unknown[], onSnapshot?: (events: EventEmitter, code: string) => void) => async (code: string, events: EventEmitter) => {
    if (!code.includes('__chordSnapshots')) return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
    onSnapshot?.(events, code);
    return { url: 'https://news.test/a', title: 'Orders', nodes, cut: {} };
  };
  const nodes = [
    { depth: 0, role: 'link', name: 'Home', key: 0 },
    { depth: 0, role: 'textbox', name: 'Password', key: 1, states: ['empty'], field: { type: 'password' } },
    { depth: 0, role: 'button', name: 'Go', key: 2 },
  ];
  type Snap = { source: string; tab_id: string; page_id?: string; refs: number; content: string };
  const snap = (out: { text?: string }) => JSON.parse(out.text!) as Snap;

  it('is unknown where the scope doesn’t offer M2’s tools (a packaged build before it ships)', async () => {
    const { scope, call } = setup({ read: page(nodes) });
    const out = await call('snapshot', { tab_id: scope.refs.refFor('n1') });
    expect(out.isError).toBe(true);
    expect(refusal(out).error).toBe('Unknown tool snapshot');
  });

  it('gives the outline with the tab’s refs; each snapshot gives new ones, and the earlier ones go stale', async () => {
    const { scope, call, activity } = setup({ read: page(nodes), actions: true });
    const ref = scope.refs.refFor('n1');
    const first = snap(await call('snapshot', { tab_id: ref }));
    expect(first).toMatchObject({ source: 'web_snapshot', tab_id: ref, refs: 2 });
    expect(first.page_id).toMatch(/^p\d+$/);
    // The password field gets no ref, not even an unshown one: the numbers go on without it.
    expect(first.content).toBe('- link "Home" [ref=e1]\n- textbox "Password" [password: the user signs in]\n- button "Go" [ref=e2]');
    expect(activity).toEqual(['Looked over “Article”']);
    const second = snap(await call('snapshot', { tab_id: ref }));
    expect(second.content).toContain('[ref=e3]');
    const refs = scope.memory.elements!.get('n1')!;
    expect(refs.resolve('e1', first.page_id!)).toEqual({ ok: false, why: 'stale' });
    expect(refs.resolve('e3', second.page_id!)).toMatchObject({ ok: true, key: 0 });
    expect(refs.resolve('e5', second.page_id!)).toEqual({ ok: false, why: 'unknown' });
    expect(scope.memory.read.has('n1')).toBe(true);
  });

  it('a page that moved on while it was read: no page_id, and its refs are never good', async () => {
    const { scope, call } = setup({ read: page(nodes, (events) => events.emit('did-navigate')), actions: true });
    const out = snap(await call('snapshot', { tab_id: scope.refs.refFor('n1') }));
    expect(out.page_id).toBeUndefined();
    expect(scope.memory.elements!.get('n1')!.resolve('e1', 'p1')).toEqual({ ok: false, why: 'stale' });
  });

  it('is read as read_tab is: never a page that can never be read, and the scope’s card first', async () => {
    const { scope, call, cards } = setup({ read: page(nodes), actions: true, needsCard: true, answer: 'deny' });
    expect(refusal(await call('snapshot', { tab_id: scope.refs.refFor('n2') })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    const denied = await call('snapshot', { tab_id: scope.refs.refFor('n1') });
    expect(refusal(denied).refused).toBe('The user said no to reading that tab. Carry on without it, or ask them.');
    expect(cards.map((c) => [c.tool, c.description])).toEqual([['snapshot', 'Look over “Article”']]);
    expect(scope.memory.elements?.size ?? 0).toBe(0);
  });

  it('a page that doesn’t answer is a refusal, not a turn that never ends', async () => {
    const { scope, call } = setup({ read: async () => null, actions: true });
    expect(refusal(await call('snapshot', { tab_id: scope.refs.refFor('n1') })).refused).toBe('That page could not be read.');
  });
});

describe('snapshot, review 1 of #104', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ depth: 0, role: 'link', name: `Row ${i}`, key: i }));
  const page = (calls: string[], go?: () => void) => async (code: string, events: EventEmitter) => {
    if (!code.includes('__chordSnapshots')) return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
    calls.push(code);
    if (go) events.emit('did-navigate');
    return { url: 'https://news.test/a', title: 'Rows', nodes: many, cut: {} };
  };
  type Snap = { refs: number; page_id?: string; retrieved_at: string; range: { start: number; end: number; total: number }; content: string };
  const snap = (out: { text?: string }) => JSON.parse(out.text!) as Snap;

  it('a later range comes from the same outline: no second read, no card, no activity, and the first range’s refs stay good', async () => {
    const calls: string[] = [];
    const { scope, call, cards, activity } = setup({ read: page(calls), actions: true, needsCard: true, answer: 'once' });
    const ref = scope.refs.refFor('n1');
    const first = snap(await call('snapshot', { tab_id: ref }));
    expect(first.range.end).toBeLessThan(first.range.total);
    await new Promise((r) => setTimeout(r, 5));
    const next = snap(await call('snapshot', { tab_id: ref, start: first.range.end }));
    expect(next.range.start).toBe(first.range.end);
    expect(next.page_id).toBe(first.page_id);
    // As of when the snapshot was taken, not when the range was asked for.
    expect(next.retrieved_at).toBe(first.retrieved_at);
    expect(calls).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(activity).toHaveLength(1);
    expect(scope.memory.elements!.get('n1')!.resolve('e1', first.page_id!)).toMatchObject({ ok: true });
    // Each owner keeps its own latest snapshot in the page: the script is told whose it is.
    expect(calls[0]).toContain('"owner":"test"');
  });

  it('a later range after the page moved on reads the page again', async () => {
    const calls: string[] = [];
    const { scope, call, pages } = setup({ read: page(calls), actions: true });
    const ref = scope.refs.refFor('n1');
    const first = snap(await call('snapshot', { tab_id: ref }));
    pages.get('n1')!.events.emit('did-navigate');
    const next = snap(await call('snapshot', { tab_id: ref, start: first.range.end }));
    expect(calls).toHaveLength(2);
    expect(next.page_id).not.toBe(first.page_id);
    expect(scope.memory.elements!.get('n1')!.resolve('e1', next.page_id!)).toEqual({ ok: false, why: 'stale' });
  });

  it('refs of a tab that closed go with it', async () => {
    const { scope, call, close } = setup({ read: page([]), actions: true });
    await call('snapshot', { tab_id: scope.refs.refFor('n1') });
    expect(scope.memory.elements!.has('n1')).toBe(true);
    close('n1');
    await call('snapshot', { tab_id: scope.refs.refFor('n3') });
    expect([...scope.memory.elements!.keys()]).toEqual(['n3']);
  });
});

/* ---------- Acting (S18 M2c) ---------- */

describe('acting through the gate (S18 M2c)', () => {
  /** The page's elements, by key: what the snapshot says, and how each act step answers. */
  type Field = { type: string; autocomplete?: string; name?: string; id?: string; label?: string; placeholder?: string };
  type Risk = { tag: string; type: string; href: string; text?: string; multiline: boolean; submits: boolean; form: { method: string; search: boolean; action: string; url?: string; fields: (Field & { text: boolean })[] } | null };
  type El = { role: string; name: string; editable?: boolean; select?: boolean; disabled?: boolean; options?: string[]; cover?: { role: string; name: string }; field?: Field; risk?: Partial<Risk> };
  /** What the page says the step is (S18 M2d): a link's address, a field's form; nothing risky unless a row says so. */
  const riskOf = (el: El): Risk => ({ tag: el.role === 'link' ? 'a' : el.editable ? 'input' : 'div', type: '', href: el.role === 'link' ? '/home' : '', text: '', multiline: false, submits: false, form: null, ...el.risk });
  const field = (f: Field) => ({ autocomplete: '', name: '', id: '', label: '', placeholder: '', ...f });
  const ELEMENTS: El[] = [
    { role: 'link', name: 'Home' },
    { role: 'searchbox', name: 'Search', editable: true, field: field({ type: 'search' }) },
    { role: 'combobox', name: 'Shipping', select: true, options: ['Standard', 'Express', 'Pickup', 'Pickup'] },
    { role: 'button', name: 'Cancel', disabled: true },
    { role: 'button', name: 'Buy', cover: { role: 'dialog', name: 'Cookie settings' } },
  ];
  /** A page answering the snapshot script with ELEMENTS, and each act step; `steps` records them. */
  /** How a test changes the page's answers: a field turned sensitive, the focus elsewhere, something over the point. */
  type Twist = { field?: Field; focused?: boolean; hit?: { role: string; name: string }; moved?: boolean; lost?: boolean; noMove?: boolean; there?: boolean; noMoveOff?: boolean; stray?: boolean; unguard?: 'timeout' | 'gone' | 'expired'; noRisk?: boolean; keydownPassed?: boolean; passed?: number; movedTimes?: number; unseen?: boolean; goneAfterKey?: boolean; sent?: () => { type: string }[]; multiline?: boolean; codes?: string[]; replaced?: Record<string, number>; others?: number; unchanged?: boolean; has?: boolean };
  const page = (steps: string[], onAct?: (events: EventEmitter, op: string) => void, twist: Twist = {}) => async (code: string, events: EventEmitter) => {
    // The page preload's guard (preload/agent-guard.ts): what it stopped, as if the focus moved between the check and the input.
    twist.codes?.push(code);
    if (code.includes('__chordAgentGuard')) {
      // A key's keydown, handled (agent-guard.ts' seen): at once.
      if (code.includes('.seen(')) return !twist.unseen;
      const op = code.includes('.arm(') ? 'guard' : 'unguard';
      steps.push(op);
      onAct?.(events, op);
      if (op === 'guard') return true;
      if (twist.unguard === 'gone') return null;
      if (twist.unguard === 'expired') return { expired: true };
      if (twist.unguard === 'timeout') return new Promise(() => undefined);
      // Stopped the first movedTimes inputs only (the page took the focus, then let it be).
      if (twist.movedTimes !== undefined) return { moved: twist.movedTimes-- > 0, lost: false, keydownPassed: false, passed: 0 };
      return { moved: Boolean(twist.moved), lost: Boolean(twist.lost), keydownPassed: Boolean(twist.keydownPassed), passed: twist.passed ?? 0 };
    }
    if (code.includes('new MutationObserver(() =>')) {
      onAct?.(events, 'settle');
      return true;
    }
    const args = JSON.parse(code.slice(code.lastIndexOf('})(') + 3, -1)) as { op?: string; key?: number; option?: string; token?: string; mode?: string };
    if (args.op) {
      steps.push(args.op);
      onAct?.(events, args.op);
      const el = ELEMENTS[args.key!]!;
      const f = twist.field ?? el.field;
      const said = { role: el.role, name: el.name, ...(f ? { field: f } : {}) };
      // The page replaced the node, this many more times at this step (a re-render): found again only by point.
      if (twist.replaced?.[args.op] && !(args as { refind?: boolean }).refind) {
        twist.replaced[args.op]!--;
        return { ok: false, why: 'replaced' };
      }
      if (args.op === 'describe') {
        if (args.option !== undefined) {
          if (!el.select) return { ok: false, why: 'not-select' };
          const found = el.options?.filter((o) => o === args.option).length ?? 0;
          if (found !== 1) return { ok: false, why: found ? 'two-choices' : 'no-choice' };
        }
        return { ok: true, ...said, editable: Boolean(el.editable), select: Boolean(el.select), disabled: Boolean(el.disabled), ...(args.option !== undefined ? { choice: args.option } : twist.noRisk ? {} : { risk: { ...riskOf(el), ...(twist.multiline ? { multiline: true } : {}) } }) };
      }
      if (args.op === 'point') return el.cover ? { ok: false, why: 'covered', cover: el.cover } : { ok: true, ...said, x: 10, y: 20 };
      if (args.op === 'hit' && twist.noMove) return { ok: false, why: 'no-move' };
      // The pointer at the point already: no move the first time; then the move off (seen, unless the page swallows it).
      // Or another move came after the action's (the real cursor's, on Windows): not seen as the last, the first time.
      if (args.op === 'hit' && (twist.there || twist.stray)) {
        const hits = steps.filter((x) => x === 'hit').length;
        if (hits === 1) return { ok: false, why: 'no-move', ...(twist.there ? { there: true } : {}) };
        if (hits === 2) return twist.noMoveOff ? { ok: false, why: 'no-move' } : { ok: true, ...said };
      }
      if (args.op === 'hit') return twist.hit ? { ok: false, why: 'covered', cover: twist.hit } : { ok: true, ...said };
      if (args.op === 'focused' && twist.goneAfterKey && (twist.sent?.() ?? []).some((e) => e.type === 'keyDown')) return { ok: false, why: 'changed' };
      if (args.op === 'focus' || args.op === 'focused') return { ok: true, ...said, focused: twist.focused ?? true };
      // Where typing went (#112): this field changed, and others (a twist's count) did too.
      if (args.op === 'values') return args.mode === 'compare' ? { ok: true, ...said, changed: !twist.unchanged, has: Boolean(twist.has), others: twist.others ?? 0 } : { ok: true, ...said };
      if (args.op === 'choose') return el.options?.includes(args.option!) ? { ok: true, ...said, choice: args.option } : { ok: false, why: 'no-choice' };
      return { ok: true, ...said };
    }
    if (code.includes('__chordSnapshots')) return { url: 'https://news.test/a', title: 'Shop', nodes: ELEMENTS.map((e, key) => ({ depth: 0, role: e.role, name: e.name, key })), cut: {} };
    return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
  };
  const result = (out: { text?: string }) => JSON.parse(out.text!) as { data: Record<string, unknown> };

  async function acting(opts: { answer?: Grant | 'hold'; cardWaitMs?: number; act?: Partial<ActHost>; onAct?: (events: EventEmitter, op: string) => void; twist?: Twist; onCard?: () => void; deep?: { hit?: unknown; closed?: boolean; picker?: boolean; unavailable?: boolean; posts?: boolean; ping?: boolean; persistent?: boolean; opens?: string[] } } = {}) {
    const steps: string[] = [];
    const doings: unknown[] = [];
    const kept: string[] = [];
    const t = setup({
      read: page(steps, opts.onAct, opts.twist),
      actions: true,
      answer: opts.answer ?? 'once',
      ...(opts.cardWaitMs ? { cardWaitMs: opts.cardWaitMs } : {}),
      ...(opts.onCard ? { onCard: opts.onCard } : {}),
      act: { doing: (_n, d) => void doings.push(d), keepSite: (site) => void kept.push(site), ...opts.act },
    });
    const tab = t.scope.refs.refFor('n1');
    await t.call('snapshot', { tab_id: tab });
    const at = t.pages.get('n1')!.at;
    at.deep = opts.deep ?? {};
    // An agent's tab: its debugger attached for its whole life, and what it sends held (agents/pickers.ts, sends.ts).
    const contents = t.pages.get('n1')!.contents;
    try {
      (contents as unknown as { debugger: { attach(): void } }).debugger.attach();
    } catch {
      // DevTools has it (deep.unavailable): no hold to watch with.
    }
    holdSends(contents);
    return { ...t, tab, steps, doings, kept, at };
  }

  it('is unknown where the scope doesn’t let its agent act (the assistant, until M2e)', async () => {
    const { scope, call } = setup({ read: page([]), actions: true });
    expect(refusal(await call('click', { tab_id: scope.refs.refFor('n1'), ref: 'e1' })).error).toBe('Unknown tool click');
  });

  it('a click: the site card first, the element checked and pointed at, a click at its middle scaled by the zoom, the bar and the activity line', async () => {
    const t = await acting();
    t.at.zoom = 1.5;
    const out = await t.call('click', { tab_id: t.tab, ref: 'e1' });
    expect(out.isError).toBeFalsy();
    expect(result(out).data).toMatchObject({ tab_id: t.tab, done: 'Clicked “Home”', navigated: false, url: 'https://news.test/a' });
    expect(t.cards.map((c) => [c.kind, c.subject, c.description, c.tab])).toEqual([['site', 'news.test', 'click “Home”', 'n1']]);
    // Described again right before the press (#112: the pointer's move can change the step).
    expect(t.steps).toEqual(['describe', 'point', 'hit', 'describe']);
    expect(t.at.input).toEqual([
      { type: 'mouseMove', x: 15, y: 30 },
      { type: 'mouseDown', x: 15, y: 30, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 15, y: 30, button: 'left', clickCount: 1 },
    ]);
    expect(t.doings).toEqual([{ tool: 'click', name: 'Home', role: 'link' }, null]);
    expect(t.activity.at(-1)).toBe('Clicked “Home”');
    // Allow for now lasts as long as the agent: no second card on the site.
    expect((await t.call('hover', { tab_id: t.tab, ref: 'e1' })).isError).toBeFalsy();
    expect(t.cards).toHaveLength(1);
    expect(t.kept).toEqual([]);
  });

  it('a no on the site lasts as long as the agent: no card again, the same refusal', async () => {
    const t = await acting({ answer: 'deny' });
    const site = 'The user didn’t let you act on news.test. Don’t act there again unless the user asks you to.';
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(site);
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(site);
    expect(t.cards).toHaveLength(1);
    expect(t.at.input).toEqual([]);
  });

  it('Always on this site is kept with the agent; a site kept before asks nothing', async () => {
    const always = await acting({ answer: 'always' });
    await always.call('click', { tab_id: always.tab, ref: 'e1' });
    expect(always.kept).toEqual(['news.test']);
    const known = await acting({ act: { siteAllowed: (site) => site === 'news.test' } });
    expect((await known.call('click', { tab_id: known.tab, ref: 'e1' })).isError).toBeFalsy();
    expect(known.cards).toEqual([]);
  });

  it('refuses, before anything is sent: a ref never made, a stale one, a shared tab, a covered or disabled element, text where none goes', async () => {
    const t = await acting({ act: { mayAct: (node) => (node.id === 'n3' ? 'shared' : null) } });
    // [tool call, what it says]
    const table: [string, Record<string, unknown>, string][] = [
      ['click', { ref: 'e99' }, 'There’s no element e99 in that tab. Call snapshot for the page’s elements.'],
      ['click', { ref: 'e4' }, 'That element is disabled.'],
      ['click', { ref: 'e5' }, 'Something is covering that element: dialog “Cookie settings”. Deal with it first, or call snapshot again.'],
      ['type', { ref: 'e1', text: 'hi' }, 'That element doesn’t take text.'],
      ['type', { ref: 'e2', text: 'x'.repeat(5001) }, 'type takes text of at most 5000 characters.'],
      ['press_key', { ref: 'e2', key: 'Ctrl+W' }, 'press_key takes one of: Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown. Put text in with type.'],
      ['select_option', { ref: 'e1', option: 'x' }, 'That element isn’t a list of choices. Use click for it.'],
      // Never the agent's words back: a choice not on the page isn't quoted (and asks no card).
      ['select_option', { ref: 'e3', option: 'Overnight' }, 'That list has no such choice. Call snapshot for its choices.'],
    ];
    for (const [tool, args, says] of table) expect(refusal(await t.call(tool, { tab_id: t.tab, ...args })).refused, `${tool} ${JSON.stringify(args)}`).toBe(says);
    expect(t.at.input).toEqual([]);
    expect(refusal(await t.call('click', { tab_id: t.scope.refs.refFor('n3'), ref: 'e1' })).refused).toBe('shared');
    // A new snapshot: the earlier refs are stale.
    await t.call('snapshot', { tab_id: t.tab });
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
  });

  it('type: a click into the field, its contents selected, the text put in as text, and Enter to submit', async () => {
    const t = await acting();
    const out = await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool scarf', submit: true });
    expect(result(out).data['done']).toBe('Typed in “Search”');
    // Each input with the page preload's guard up (guard, the focus checked, the input, unguard).
    // Enter's keydown first, then everything checked again before its character (a keydown handler can move the focus).
    // A text field in no form with submit is a send (M2d): the step card, then the element described again after it.
    // And every field's value remembered before the text, then compared after it (#112: where the text went).
    // And the step checked again right before Enter (Neon's review 2 of #112).
    expect(t.steps).toEqual(['describe', 'describe', 'point', 'hit', 'describe', 'select', 'guard', 'focused', 'values', 'unguard', 'values', 'describe', 'guard', 'focused', 'focused', 'unguard']);
    expect(t.at.text).toEqual(['wool scarf']);
    expect((t.at.input as { type: string; keyCode?: string }[]).map((e) => `${e.type}${e.keyCode ? `:${e.keyCode}` : ''}`)).toEqual(['mouseMove', 'mouseDown', 'mouseUp', 'keyDown:Return', 'char:\r', 'keyUp:Return']);
    // replace: false keeps what's there.
    t.steps.length = 0;
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: ' red', replace: false });
    expect(t.steps).toEqual(['describe', 'point', 'hit', 'describe', 'guard', 'focused', 'values', 'unguard', 'values']);
  });

  it('press_key focuses the element and sends the key; select_option chooses by label', async () => {
    const t = await acting();
    await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Escape' });
    // Focused, then the guard up and the focus checked under it (the guard takes what has the focus as the element).
    // A key that types nothing goes in at once (its keydown may move the focus: that's it working).
    expect(t.steps).toEqual(['describe', 'point', 'focus', 'describe', 'guard', 'focused', 'unguard']);
    expect(t.at.input).toEqual([
      { type: 'keyDown', keyCode: 'Escape' },
      { type: 'keyUp', keyCode: 'Escape' },
    ]);
    const chose = await t.call('select_option', { tab_id: t.tab, ref: 'e3', option: 'Express' });
    expect(result(chose).data['done']).toBe('Chose “Express” in “Shipping”');
  });

  it('an action that took the page somewhere else says so, and the tab’s refs go stale', async () => {
    // The click takes the page somewhere: it has navigated by the time the page settles.
    const t = await acting({ onAct: (events, op) => void (op === 'settle' && events.emit('did-navigate')) });
    const out = result(await t.call('click', { tab_id: t.tab, ref: 'e1' }));
    expect(out.data).toMatchObject({ navigated: true, note: 'The page changed: call snapshot again before using refs from before.' });
    expect(refusal(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
  });

  it('a page that moved on between the check and the input: nothing is sent', async () => {
    const t = await acting({ onAct: (events, op) => void (op === 'point' && events.emit('did-navigate')) });
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    expect(t.at.input).toEqual([]);
  });

  // ---------- Neon's review of #110 ----------

  it('the page went to another site while the element was described: no card for that site, nothing kept, nothing sent', async () => {
    const t: Awaited<ReturnType<typeof acting>> = await acting({
      onAct: (events, op) => {
        if (op !== 'describe' || !t || t.at.url.includes('bank.test')) return;
        t.at.url = 'https://bank.test/login';
        events.emit('did-navigate');
      },
    });
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    expect(t.cards).toEqual([]);
    expect([t.agent.granted('site', 'bank.test'), t.agent.granted('site', 'news.test')]).toEqual([undefined, undefined]);
    expect(t.at.input).toEqual([]);
  });

  it('a yes on the card is kept only once the action runs on that page: the page moving on meanwhile keeps nothing (a no is kept)', async () => {
    const held: { t?: Awaited<ReturnType<typeof acting>> } = {};
    const move = () => {
      held.t!.at.url = 'https://news.test/other';
      held.t!.pages.get('n1')!.events.emit('did-navigate');
    };
    const t = (held.t = await acting({ onCard: () => move() }));
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    expect(t.agent.granted('site', 'news.test')).toBeUndefined();
    expect(t.at.input).toEqual([]);
    // It runs: kept for the agent's life.
    const u = await acting();
    await u.call('click', { tab_id: u.tab, ref: 'e1' });
    expect(u.agent.granted('site', 'news.test')).toBe('always');
    // A no is kept whatever became of the page.
    const v = await acting({ answer: 'deny' });
    await v.call('click', { tab_id: v.tab, ref: 'e1' });
    expect(v.agent.granted('site', 'news.test')).toBe('deny');
  });

  // [what the debugger sees, what the agent hears]: nothing is pressed or typed.
  const deepRows: [string, string, { hit?: unknown; closed?: boolean; unavailable?: boolean }, string][] = [
    ['click', 'a frame in a closed shadow root under the point', { hit: { ok: false, why: 'covered', cover: { role: 'frame', name: 'Inner ad' } } }, 'Something is covering that element: frame “Inner ad”. Deal with it first, or call snapshot again.'],
    ['click', 'a file input in a closed shadow root under the point', { hit: { ok: false, why: 'file' } }, 'That opens a file picker: agents never choose files. Ask the user to.'],
    ['type', 'a closed shadow root in the field', { closed: true }, 'Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.'],
    ['click', 'a closed shadow root in the element (#112)', { closed: true }, 'Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.'],
    ['press_key', 'a closed shadow root in the field', { closed: true }, 'Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.'],
    ['click', 'the debugger taken (DevTools busy)', { unavailable: true }, 'Chord couldn’t check that page right now (is its DevTools window busy?), so nothing was done. Try again in a moment.'],
  ];
  it.each(deepRows)('%s, when the debugger finds %s: refused, nothing sent', async (tool, _what, deep, says) => {
    const t = await acting({ deep });
    const args = tool === 'type' ? { ref: 'e2', text: 'secret' } : tool === 'press_key' ? { ref: 'e2', key: 'Space' } : { ref: 'e1' };
    expect(refusal(await t.call(tool, { tab_id: t.tab, ...args })).refused).toBe(says);
    expect(t.at.text).toEqual([]);
    expect((t.at.input as { type: string }[]).filter((e) => e.type !== 'mouseMove')).toEqual([]);
    // Chord's world found (Runtime enabled and disabled at once, the page's console kept), and what the session held of
    // the page let go of after.
    if (!deep.unavailable) {
      expect(t.at.debugging.slice(0, 3)).toEqual(['Page.getFrameTree', 'Runtime.enable', 'Runtime.disable']);
      expect(t.at.debugging).not.toContain('Runtime.discardConsoleEntries');
      expect(t.at.debugging).toContain('Runtime.releaseObjectGroup');
      // Nothing was held: no card about sending.
      expect(t.cards.filter((c) => c.step?.sends)).toEqual([]);
    }
  });

  it('a second click at the point: the pointer moves off and back, and the page must see both moves before the press', async () => {
    const t = await acting({ twist: { there: true } });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    expect((t.at.input as { type: string; x: number }[]).map((e) => `${e.type} ${e.x}`)).toEqual(['mouseMove 10', 'mouseMove 13', 'mouseMove 10', 'mouseDown 10', 'mouseUp 10']);
    expect(t.steps).toEqual(['describe', 'point', 'hit', 'hit', 'hit', 'describe']);
    // Not seen off the point (a page swallowing moves there): no press.
    const u = await acting({ twist: { there: true, noMoveOff: true } });
    expect(refusal(await u.call('click', { tab_id: u.tab, ref: 'e1' })).refused).toBe('The page didn’t see the pointer arrive, so nothing was clicked. Call snapshot again, then try once more.');
    expect((u.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove', 'mouseMove']);
  });

  it('another move after the action’s (the real cursor’s, on Windows: #112): off and back, both seen, then the press', async () => {
    const t = await acting({ twist: { stray: true } });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    expect((t.at.input as { type: string; x: number }[]).map((e) => `${e.type} ${e.x}`)).toEqual(['mouseMove 10', 'mouseMove 13', 'mouseMove 10', 'mouseDown 10', 'mouseUp 10']);
    // And typing goes on from there (the search on CI's Windows x64).
    const u = await acting({ twist: { stray: true } });
    expect(result(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool' })).data).toMatchObject({ done: 'Typed in “Search”' });
    expect(u.at.text).toEqual(['wool']);
  });

  it('the guard always comes down, even when the input fails; a guard that doesn’t answer is a no', async () => {
    const t = await acting({ twist: { unguard: 'timeout' } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
    expect((t.at.input as { type: string }[]).filter((e) => e.type === 'keyDown')).toEqual([]);
    // No guard in the same document (its own ran out, or the user took the tab): a no.
    const u = await acting({ twist: { unguard: 'expired' } });
    expect(refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool' })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
    // Another document (a submit's Enter navigated, committed): the guard went with it, and that's done.
    const v = await acting({ twist: { unguard: 'gone' }, onAct: (events, op) => void (op === 'unguard' && events.emit('did-navigate')) });
    expect(result(await v.call('type', { tab_id: v.tab, ref: 'e2', text: 'wool' })).data).toMatchObject({ done: 'Typed in “Search”' });
  });

  it('Enter on what isn’t a field: you take the tab after its keydown, so a no, and no character', async () => {
    const held: { t?: Awaited<ReturnType<typeof acting>> } = {};
    const t = (held.t = await acting({
      onAct: (_events, op) => {
        const sent = (held.t?.at.input ?? []) as { type: string }[];
        if (op === 'focused' && sent.some((e) => e.type === 'keyDown')) held.t!.agent.pause('n1', true);
      },
    }));
    expect(refusal(await t.call('press_key', { tab_id: t.tab, ref: 'e1', key: 'Enter' })).refused).toBe(CONTROL_REFUSALS.paused);
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('Enter in a one-line field whose keydown moved the focus (a game takes the bet, then focuses its table): done once, said so, no character', async () => {
    // The focus elsewhere once Enter's keydown is in (the owner's retest of #117, round 3: refused, the agent pressed again).
    const run = async (key: string, twist: Twist = {}) => {
      const held: { t?: Awaited<ReturnType<typeof acting>> } = {};
      const t = (held.t = await acting({
        twist,
        onAct: (_events, op) => {
          const sent = (held.t?.at.input ?? []) as { type: string }[];
          if (op === 'focus') twist.focused = true;
          if (op === 'focused' && sent.some((e) => e.type === 'keyDown')) twist.focused = false;
        },
      }));
      const out = await t.call('press_key', { tab_id: t.tab, ref: 'e2', key });
      return { out, keys: (t.at.input as { type: string }[]).map((e) => e.type) };
    };
    const enter = await run('Enter');
    expect(result(enter.out).data).toMatchObject({ done: 'Pressed Enter in “Search”', focus: 'The page moved the focus away from that field after Enter. Enter was pressed once; don’t press it again.' });
    expect(enter.keys).toEqual(['keyDown', 'keyUp']);
    // Its keyup reached a frame (lost): still that, done.
    expect(result((await run('Enter', { lost: true })).out).data['done']).toBe('Pressed Enter in “Search”');
    // A field that takes more lines (Enter types a new line there), or Space (it types): a no, and no character.
    const multi = await run('Enter', { multiline: true });
    expect(refusal(multi.out).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(multi.keys).toEqual(['keyDown', 'keyUp']);
    const space = await run('Space');
    expect(refusal(space.out).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(space.keys).toEqual(['keyDown', 'keyUp']);
    // The keydown itself stopped by the guard (the focus moved before it): never done.
    expect(refusal((await run('Enter', { moved: true })).out).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
  });

  it('Enter’s keydown went through and the rest was stopped (the page took the focus after the check): done once, said so; any other key, a no (the review of #117, round 5)', async () => {
    const enter = await acting({ twist: { moved: true, keydownPassed: true } });
    expect(result(await enter.call('press_key', { tab_id: enter.tab, ref: 'e2', key: 'Enter' })).data).toMatchObject({ done: 'Pressed Enter in “Search”', focus: 'The page moved the focus away from that field after Enter. Enter was pressed once; don’t press it again.' });
    const space = await acting({ twist: { moved: true, keydownPassed: true } });
    expect(refusal(await space.call('press_key', { tab_id: space.tab, ref: 'e2', key: 'Space' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    const multi = await acting({ twist: { moved: true, keydownPassed: true, multiline: true } });
    expect(refusal(await multi.call('press_key', { tab_id: multi.tab, ref: 'e2', key: 'Enter' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    // Its keydown stopped (nothing went through): a no.
    const stopped = await acting({ twist: { moved: true } });
    expect(refusal(await stopped.call('press_key', { tab_id: stopped.tab, ref: 'e2', key: 'Enter' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
  });

  it('a key or text the guard stopped whole (the page took the focus first): the element focused again, and it goes once more; never once any of it reached the page (the review of #117, round 6)', async () => {
    // Stopped once, nothing reached the page: focused again, the step checked again, and it goes.
    const t = await acting({ twist: { movedTimes: 1 } });
    expect(result(await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Tab' })).data['done']).toBe('Pressed Tab in “Search”');
    expect(t.steps.filter((x) => x === 'guard')).toHaveLength(2);
    expect(t.steps.filter((x) => x === 'focus')).toHaveLength(2);
    const u = await acting({ twist: { movedTimes: 1 } });
    expect(result(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool' })).data['done']).toBe('Typed in “Search”');
    expect(u.steps.filter((x) => x === 'select')).toHaveLength(2);
    // Something of it reached the page (an event went through): a no, never tried again.
    const v = await acting({ twist: { moved: true, passed: 1 } });
    expect(refusal(await v.call('press_key', { tab_id: v.tab, ref: 'e2', key: 'Tab' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(v.steps.filter((x) => x === 'guard')).toHaveLength(1);
    // A keydown the guard hadn't seen yet (late, maybe still coming), or an input whose last event never came (lost):
    // never tried again, as it could land twice (Claude's review 5 of #117).
    const late = await acting({ twist: { moved: true, unseen: true } });
    expect(refusal(await late.call('press_key', { tab_id: late.tab, ref: 'e2', key: 'Enter' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(late.steps.filter((x) => x === 'guard')).toHaveLength(1);
    const lost = await acting({ twist: { moved: true, lost: true } });
    expect(refusal(await lost.call('press_key', { tab_id: lost.tab, ref: 'e2', key: 'Tab' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(lost.steps.filter((x) => x === 'guard')).toHaveLength(1);
    // Every try stopped: at most PRESS_TRIES (5), then a no.
    const w = await acting({ twist: { moved: true } });
    expect(refusal(await w.call('press_key', { tab_id: w.tab, ref: 'e2', key: 'Tab' })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(w.steps.filter((x) => x === 'guard')).toHaveLength(5);
  });

  it('Enter on a button the page redrew between its keydown and the rest: said it may not have worked, never done, never pressed again (#117)', async () => {
    const twist: Twist = { goneAfterKey: true };
    const t = await acting({ twist });
    twist.sent = () => t.at.input as { type: string }[];
    expect(refusal(await t.call('press_key', { tab_id: t.tab, ref: 'e1', key: 'Enter' })).refused).toBe('The page redrew that element while the key went in, so it may not have worked. Call snapshot and check before pressing it again.');
    // Its keydown, then only the key let go of; once.
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('the guard is armed with a mark only main knows, and the focus check fires it at the element', async () => {
    const codes: string[] = [];
    const t = await acting({ twist: { codes } });
    const marks: string[] = [];
    await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Tab' });
    for (const code of codes) {
      const armed = /\.arm\("keyup", "(chord-guard-[0-9a-f]{32})"\)/.exec(code);
      if (armed) marks.push(armed[1]!);
      const checked = /"op":"focused","guard":"(chord-guard-[0-9a-f]{32})"/.exec(code);
      if (checked) marks.push(checked[1]!);
    }
    expect(marks).toHaveLength(2);
    expect(marks[0]).toBe(marks[1]);
  });

  it('a node the page replaced on the way to the press: tried again from the pointer’s move, at most PRESS_TRIES (5) times, never once pressed (the review of #117)', async () => {
    const CHANGED = 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.';
    // Replaced at the hit test once: pointed at again, and pressed.
    const t = await acting({ twist: { replaced: { hit: 1 } } });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data['done']).toBe('Clicked “Home”');
    expect(t.steps).toEqual(['describe', 'point', 'hit', 'point', 'hit', 'describe']);
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove', 'mouseMove', 'mouseDown', 'mouseUp']);
    // At the step's last check (its own why, not another step's), and at the debugger's look (deep.open): the same.
    const u = await acting({ twist: { replaced: { describe: 1 } }, deep: { opens: ['replaced'] } });
    expect(result(await u.call('click', { tab_id: u.tab, ref: 'e1' })).data['done']).toBe('Clicked “Home”');
    expect(u.steps).toEqual(['describe', 'point', 'hit', 'point', 'hit', 'describe', 'point', 'hit', 'describe']);
    // Every time: changed, and nothing pressed.
    const v = await acting({ twist: { replaced: { hit: 5 } } });
    expect(refusal(await v.call('click', { tab_id: v.tab, ref: 'e1' })).refused).toBe(CHANGED);
    expect((v.at.input as { type: string }[]).map((e) => e.type)).toEqual(Array(5).fill('mouseMove'));
    // deep.open's other answers are never tried again: the snapshot gone (stale), a node it can't find again (changed).
    const w = await acting({ deep: { opens: ['stale'] } });
    expect(refusal(await w.call('click', { tab_id: w.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    expect(w.steps.filter((x) => x === 'point')).toHaveLength(1);
    const x = await acting({ deep: { opens: ['changed'] } });
    expect(refusal(await x.call('click', { tab_id: x.tab, ref: 'e1' })).refused).toBe(CHANGED);
    expect(x.steps.filter((s2) => s2 === 'point')).toHaveLength(1);
  });

  it('Stop while the press is tried again: no other move of the pointer, nothing pressed', async () => {
    let stop = () => undefined as void;
    const t = await acting({ twist: { replaced: { hit: 2 } }, onAct: (_events, op) => void (op === 'hit' && stop()) });
    stop = () => t.agent.stop();
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(CONTROL_REFUSALS.stopped);
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove']);
  });

  it('a key, a choice, a value: a node replaced before the input is looked for again from the pointer’s move too', async () => {
    const t = await acting({ twist: { replaced: { focus: 1 } } });
    expect(result(await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Tab' })).data['done']).toBe('Pressed Tab in “Search”');
    expect(t.steps.slice(0, 5)).toEqual(['describe', 'point', 'focus', 'point', 'focus']);
    const u = await acting({ twist: { replaced: { describe: 1 } } });
    expect(result(await u.call('select_option', { tab_id: u.tab, ref: 'e3', option: 'Express' })).data['done']).toBe('Chose “Express” in “Shipping”');
    expect(u.steps).toEqual(['describe', 'point', 'describe', 'point', 'describe', 'choose']);
    // Every try: changed, nothing chosen.
    const v = await acting({ twist: { replaced: { describe: 5 } } });
    expect(refusal(await v.call('select_option', { tab_id: v.tab, ref: 'e3', option: 'Express' })).refused).toBe('That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.');
    expect(v.steps).not.toContain('choose');
  });

  it('no guard there, but no document committed either: a no', async () => {
    const t = await acting({ twist: { unguard: 'gone' } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool' })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
  });

  it('a navigation that starts and never commits (a 204, a download, window.stop): not another document, so a no', async () => {
    const t = await acting({ twist: { unguard: 'expired' }, onAct: (events, op) => void (op === 'unguard' && events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })) });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool' })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
  });

  it('focus goes back only while the same Chord window is in front, only to the page that had it', () => {
    const win = {};
    const other = {};
    const rows: [string, { page: string | null; window: object | null }, { page: string | null; window: object | null }, string | null][] = [
      ['the agent’s page took it', { page: 'yours', window: win }, { page: 'agent', window: win }, 'yours'],
      ['no page has it', { page: 'yours', window: win }, { page: null, window: win }, 'yours'],
      ['Chord isn’t in front any more (another app)', { page: 'yours', window: win }, { page: null, window: null }, null],
      ['another Chord window is in front', { page: 'yours', window: win }, { page: null, window: other }, null],
      ['Chord wasn’t in front to begin with', { page: 'yours', window: null }, { page: 'agent', window: win }, null],
      ['you went to another page meanwhile', { page: 'yours', window: win }, { page: 'another', window: win }, null],
    ];
    for (const [what, before, now, back] of rows) expect(focusToGiveBack(before, now, 'agent'), what).toBe(back);
  });

  it('the guard’s own script went with the old document (it never answers): another document, so done', async () => {
    const w = await acting({ twist: { unguard: 'timeout' }, onAct: (events, op) => void (op === 'unguard' && events.emit('did-navigate')) });
    expect(result(await w.call('type', { tab_id: w.tab, ref: 'e2', text: 'wool' })).data).toMatchObject({ done: 'Typed in “Search”', navigated: true });
  });

  it('a field the page made a password field while the card was up: select_option and click refuse it at the point', async () => {
    const twist: Twist = {};
    const t = await acting({ twist, onCard: () => void (twist.field = field({ type: 'password' })) });
    expect(refusal(await t.call('select_option', { tab_id: t.tab, ref: 'e3', option: 'Express' })).refused).toBe('That field is now a password, code or card field: the user fills it. Ask them to.');
    expect(t.steps).not.toContain('choose');
  });

  it('navigate and back: a pause that comes after the tab was loaded sends nothing', async () => {
    const t: Awaited<ReturnType<typeof acting>> = await acting({ act: { doing: (_n, d) => void (d && t!.agent.pause('n1', true)) } });
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b' })).refused).toBe(CONTROL_REFUSALS.paused);
    expect(t.at.loads).toEqual([]);
  });

  // ---------- Risky steps (S18 M2d) ----------

  it('a risky step asks every time (the step card, never remembered): Don’t sends nothing; Allow goes', async () => {
    ELEMENTS.push({ role: 'button', name: 'Delete draft' });
    try {
      const ref = `e${ELEMENTS.length}`;
      const t = await acting({ answer: 'deny', act: { siteAllowed: () => true } });
      expect(refusal(await t.call('click', { tab_id: t.tab, ref })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
      expect(t.at.input.filter((e) => (e as { type: string }).type === 'mouseDown')).toEqual([]);
      const step = t.cards.find((c) => c.kind === 'step')!;
      expect([step.description, step.step]).toEqual(['click “Delete draft”', { why: 'delete', site: 'news.test', fields: [], more: 0 }]);
      // Allowed: it goes, and the next time asks again.
      const u = await acting();
      await u.call('click', { tab_id: u.tab, ref });
      await u.call('click', { tab_id: u.tab, ref });
      expect(u.cards.filter((c) => c.kind === 'step')).toHaveLength(2);
      expect(u.at.input.filter((e) => (e as { type: string }).type === 'mouseDown')).toHaveLength(2);
    } finally {
      ELEMENTS.pop();
    }
  });

  it('a form’s submit asks, whatever the button says (a misleading Continue), with what goes with it by label', async () => {
    const f = (label: string, type = 'text') => ({ ...field({ type, label }), text: true });
    ELEMENTS.push({ role: 'button', name: 'Continue', risk: { tag: 'button', type: 'submit', submits: true, form: { method: 'post', search: false, action: '/account', fields: [f('Name'), f('Email'), f('Reason')] } } });
    try {
      const t = await acting({ answer: 'deny', act: { siteAllowed: () => true } });
      await t.call('click', { tab_id: t.tab, ref: `e${ELEMENTS.length}` });
      expect(t.cards.find((c) => c.kind === 'step')!.step).toEqual({ why: 'submit', site: 'news.test', fields: ['Name', 'Email', 'Reason'], more: 0 });
    } finally {
      ELEMENTS.pop();
    }
  });

  it('nothing said of the step by the page: asks, as a form’s submit (fails closed)', async () => {
    ELEMENTS.push({ role: 'button', name: 'Next', risk: undefined });
    const t = await acting({ answer: 'deny', twist: { noRisk: true }, act: { siteAllowed: () => true } });
    try {
      await t.call('click', { tab_id: t.tab, ref: `e${ELEMENTS.length}` });
      expect(t.cards.find((c) => c.kind === 'step')!.step?.why).toBe('submit');
    } finally {
      ELEMENTS.pop();
    }
  });

  it('an act step whose page sends data as it clicks (its own script): held, and one card asks where it goes (the owner’s default)', async () => {
    // Allowed: what was held goes.
    const t = await acting({ deep: { posts: true } });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    const sent = t.cards.filter((c) => c.step?.sends);
    expect(sent.map((c) => [c.description, c.step?.sends])).toEqual([['Clicked “Home”', ['news.test']]]);
    expect(t.at.debugging).toContain('Fetch.continueRequest');
    // Don't: dropped (a document answered with nothing: the page stays), and the agent hears the step was declined.
    const u = await acting({ deep: { posts: true }, answer: 'deny', act: { siteAllowed: () => true } });
    expect(refusal(await u.call('click', { tab_id: u.tab, ref: 'e1' })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    expect(u.at.debugging).toContain('Fetch.fulfillRequest');
    expect(u.at.debugging).not.toContain('Fetch.continueRequest');
  });

  it('a report (a beacon, a ping) is dropped, never asked about', async () => {
    const t = await acting({ deep: { ping: true } });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    expect(t.cards.filter((c) => c.step?.sends)).toEqual([]);
    expect(t.at.debugging).toContain('Fetch.failRequest');
  });

  it('what the page sends between actions is held and asked about (the owner, 2026-11-23); a no fails it, and the next result says so', async () => {
    const t = await acting();
    await t.call('click', { tab_id: t.tab, ref: 'e1' });
    const contents = t.pages.get('n1')!.contents;
    // Held until the tab's chord can ask: nothing answered yet.
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'late1', request: { method: 'POST', url: 'https://news.test/autosave' }, resourceType: 'XHR' });
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'late2', request: { method: 'POST', url: 'https://news.test/autosave' }, resourceType: 'XHR' });
    const answered = () => t.at.debugging.filter((m) => m === 'Fetch.failRequest' || m === 'Fetch.continueRequest').length;
    const before = answered();
    await new Promise((r) => setTimeout(r, 0));
    expect(answered()).toBe(before);
    // One card for both (the same site), and a no fails them.
    const asked: string[][] = [];
    sendHoldDeps(contents, { whose: () => 'agent', ask: async (sites) => (asked.push(sites), 'deny' as const), siteOf: (u) => new URL(u).host });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([['news.test']]);
    expect(answered()).toBe(before + 2);
    const next = result(await t.call('click', { tab_id: t.tab, ref: 'e1' }));
    expect(next.data['dropped']).toBe('Since your last action here, the page tried to send data and it wasn’t sent (the user said no, didn’t answer, or took the tab). If something didn’t save, ask the user.');
    // Taken: the one after says nothing.
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data['dropped']).toBeUndefined();
  });

  it('between actions: Allow lets go only the sites its card named; a send to another site waits for its own card; yours go; taking the tab fails what’s held', async () => {
    const t = await acting();
    const contents = t.pages.get('n1')!.contents;
    let whose: 'agent' | 'user' = 'agent';
    const asked: string[][] = [];
    let answer: (yes: SendAnswer) => void = () => undefined;
    sendHoldDeps(contents, { whose: () => whose, ask: (sites) => (asked.push(sites), new Promise<SendAnswer>((done) => (answer = done))), siteOf: (u) => new URL(u).host });
    const paused = (id: string, url: string) => t.at.emitDebug!('Fetch.requestPaused', { requestId: id, request: { method: 'POST', url }, resourceType: 'XHR' });
    paused('a1', 'https://news.test/save');
    paused('a2', 'https://news.test/save');
    paused('b1', 'https://tracker.test/x');
    expect(asked).toEqual([['news.test']]);
    const continued = () => t.at.debugging.filter((m) => m === 'Fetch.continueRequest').length;
    const before = continued();
    answer('once');
    await new Promise((r) => setTimeout(r, 0));
    // The two for news.test went; tracker.test asks on its own card.
    expect(continued()).toBe(before + 2);
    expect(asked).toEqual([['news.test'], ['tracker.test']]);
    // You take the tab: what's held fails, the card comes down, and what you send goes.
    const failed = t.at.debugging.filter((m) => m === 'Fetch.failRequest').length;
    whose = 'user';
    failHeld(contents);
    expect(t.at.debugging.filter((m) => m === 'Fetch.failRequest').length).toBe(failed + 1);
    paused('u1', 'https://news.test/mine');
    expect(continued()).toBe(before + 3);
  });

  it('Allow until done (the owner, 2026-11-23): no more cards for those sites from this tab; a new site, a delete address, your taking the tab, and the agent’s end each ask again', async () => {
    const t = await acting();
    const contents = t.pages.get('n1')!.contents;
    let whose: 'agent' | 'user' = 'agent';
    const asked: string[][] = [];
    let next: SendAnswer = 'until';
    sendHoldDeps(contents, { whose: () => whose, ask: async (sites) => (asked.push(sites), next), siteOf: (u) => new URL(u).host });
    const continued = () => t.at.debugging.filter((m) => m === 'Fetch.continueRequest').length;
    const paused = async (id: string, url: string, method = 'POST') => {
      t.at.emitDebug!('Fetch.requestPaused', { requestId: id, request: { method, url }, resourceType: method === 'GET' ? 'Document' : 'XHR' });
      await new Promise((r) => setTimeout(r, 0));
    };
    await paused('p1', 'https://news.test/poll');
    expect(asked).toEqual([['news.test']]);
    const base = continued();
    // The polls after it: no card, they go.
    await paused('p2', 'https://news.test/poll');
    await paused('p3', 'https://news.test/poll');
    expect(asked.length).toBe(1);
    expect(continued()).toBe(base + 2);
    // A new site asks; a document to a delete address on that same site asks as its step.
    next = 'deny';
    await paused('n1', 'https://tracker.test/x');
    await paused('d1', 'https://news.test/account/delete', 'GET');
    expect(asked).toEqual([['news.test'], ['tracker.test'], ['news.test']]);
    // Your taking the tab ends it: once the agent has it again, the site asks again.
    whose = 'user';
    failHeld(contents);
    whose = 'agent';
    await paused('p4', 'https://news.test/poll');
    expect(asked.length).toBe(4);
    // And the agent's end (its connection) ends it too.
    next = 'until';
    await paused('p5', 'https://news.test/poll');
    await paused('p6', 'https://news.test/poll');
    expect(asked.length).toBe(5);
    endUntil(contents);
    next = 'deny';
    await paused('p7', 'https://news.test/poll');
    expect(asked.length).toBe(6);
  });

  // The owner, 2026-11-23: a card covers exactly the origins it names (scheme, host, port), never their whole site;
  // another subdomain is the user's question, on a card of its own.
  it.each([
    ['https://a.example.com', 'the same origin', 'https://a.example.com/save', 0],
    ['https://a.example.com', 'another subdomain', 'https://b.example.com/save', 1],
    ['https://a.example.com', 'the same host over http', 'http://a.example.com/save', 1],
    ['https://a.example.com', 'another port', 'https://a.example.com:8443/save', 1],
    ['https://www.example.com', 'api of an allowed www', 'https://api.example.com/save', 1],
  ] as const)('Allow until done on %s, then a send to %s: %i more card(s)', async (first, _what, next, more) => {
    const t = await acting();
    const contents = t.pages.get('n1')!.contents;
    const asked: string[][] = [];
    sendHoldDeps(contents, { whose: () => 'agent', ask: async (sites) => (asked.push(sites), 'until' as const), siteOf: (u) => new URL(u).origin });
    const paused = async (id: string, to: string) => {
      t.at.emitDebug!('Fetch.requestPaused', { requestId: id, request: { method: 'POST', url: to }, resourceType: 'XHR' });
      await new Promise((r) => setTimeout(r, 0));
    };
    await paused('first', `${first}/save`);
    expect(asked).toEqual([[first]]);
    await paused('next', next);
    expect(asked.length - 1).toBe(more);
    if (more) expect(asked[1]).toEqual([new URL(next).origin]);
  });

  // Round 4 of #112 (Claude and Neon), each confirmed failing first.
  describe('round 4: what still went unasked', () => {
    /** A tab between actions, its chord asking: what each card named, and what it said. */
    const between = async (answers: SendAnswer[] = []) => {
      const t = await acting();
      const contents = t.pages.get('n1')!.contents;
      const asked: { sites: string[]; why: string | null }[] = [];
      sendHoldDeps(contents, { whose: () => 'agent', ask: async (sites, why) => (asked.push({ sites, why }), answers.shift() ?? 'deny'), siteOf: (u) => new URL(u).origin });
      const paused = async (id: string, url: string, method = 'POST', extra: Record<string, unknown> = {}) => {
        t.at.emitDebug!('Fetch.requestPaused', { requestId: id, request: { method, url, ...extra }, resourceType: 'XHR' });
        await new Promise((r) => setTimeout(r, 0));
      };
      const continued = (id: string) => (t.at.commands ?? []).some(([m, p]) => m === 'Fetch.continueRequest' && (p as { requestId?: string }).requestId === id);
      return { t, asked, paused, continued };
    };

    it('a risky step that doesn’t submit never lets its form’s address go: the page’s own POST there asks (Neon’s S9)', async () => {
      const f = (label: string) => ({ ...field({ type: 'text', label }), text: true });
      ELEMENTS.push({ role: 'button', name: 'Delete draft', risk: { tag: 'button', type: 'button', submits: false, form: { method: 'post', search: false, action: '/form', url: 'https://news.test/form', fields: [f('Title')] } } });
      try {
        const t = await acting({ act: { siteAllowed: () => true } });
        const clicking = t.call('click', { tab_id: t.tab, ref: `e${ELEMENTS.length}` });
        await vi.waitFor(() => expect(t.at.input.length).toBeGreaterThan(0));
        t.at.emitDebug!('Fetch.requestPaused', { requestId: 'f1', request: { method: 'POST', url: 'https://news.test/form' }, resourceType: 'XHR' });
        await clicking;
        expect(t.cards.filter((c) => c.step?.sends).map((c) => c.step?.sends)).toEqual([['news.test']]);
      } finally {
        ELEMENTS.pop();
      }
    });

    it('a send card no one answers in an action comes down (Neon’s S11): no card left at the head of the queue', async () => {
      const t = await acting({ deep: { posts: true }, answer: 'hold', cardWaitMs: 30, act: { siteAllowed: () => true } });
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('The user didn’t answer in time, so what the page was sending was dropped. Ask the user, then do that step again.');
      await new Promise((r) => setTimeout(r, 0));
      expect(t.agent.state('n1').cards).toEqual([]);
    });

    it('a document’s response gets one clean policy: the page’s own (malformed or not) is dropped, deferred sends, passkeys, payments and sign-in dialogs off (the final pass)', async () => {
      const { t } = await between();
      t.at.emitDebug!('Fetch.requestPaused', { requestId: 'doc', request: { method: 'GET', url: 'https://news.test/' }, resourceType: 'Document', responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'permissions-policy', value: '@' }, { name: 'Permissions-Policy', value: 'camera=()' }] });
      await new Promise((r) => setTimeout(r, 0));
      const [, sent] = (t.at.commands ?? []).find(([m]) => m === 'Fetch.continueResponse')!;
      const headers = (sent as { responseHeaders: { name: string; value: string }[] }).responseHeaders;
      const policies = headers.filter((h) => h.name.toLowerCase() === 'permissions-policy');
      expect(policies).toEqual([{ name: 'Permissions-Policy', value: 'deferred-fetch=(), deferred-fetch-minimal=(), publickey-credentials-get=(), publickey-credentials-create=(), payment=(), identity-credentials-get=()' }]);
      expect(headers).toContainEqual({ name: 'Content-Type', value: 'text/html' });
    });

    it('a response that failed (a network error) is let go at once: no card, never taken for a request', async () => {
      const { t, asked, continued } = await between();
      t.at.emitDebug!('Fetch.requestPaused', { requestId: 'err', request: { method: 'POST', url: 'https://news.test/save' }, resourceType: 'Document', responseErrorReason: 'Failed' });
      await new Promise((r) => setTimeout(r, 0));
      expect(continued('err')).toBe(true);
      expect(asked).toEqual([]);
    });

    it('no one’s to ask (the tab closing) wins over an action’s Allow: what it sends on its way out fails', async () => {
      const t = await acting({ act: { siteAllowed: () => true } });
      const contents = t.pages.get('n1')!.contents;
      let whose: 'agent' | 'none' = 'agent';
      sendHoldDeps(contents, { whose: () => whose, ask: async () => 'deny', siteOf: (u) => new URL(u).origin });
      const watch = (await import('../../src/main/control/sends')).watchSends(contents, null)!;
      watch.allow({ origins: new Set(['https://news.test']) });
      whose = 'none';
      t.at.emitDebug!('Fetch.requestPaused', { requestId: 'bye', request: { method: 'POST', url: 'https://news.test/bye' }, resourceType: 'Fetch' });
      await new Promise((r) => setTimeout(r, 0));
      expect((t.at.commands ?? []).some(([m, p]) => m === 'Fetch.continueRequest' && (p as { requestId?: string }).requestId === 'bye')).toBe(false);
      watch.end();
    });

    // Neon's final pass: only what classifyStep counts as sending a form lets its address go, never any other key.
    it.each([
      ['click a submit button', 'click', {}, { risk: { submits: true, tag: 'button' } }, true],
      ['click a plain button', 'click', {}, { risk: { submits: false, tag: 'button' } }, false],
      ['Enter in a field', 'press_key', { key: 'Enter' }, { editable: true, risk: { tag: 'input' } }, true],
      ['Tab in a field', 'press_key', { key: 'Tab' }, { editable: true, risk: { tag: 'input' } }, false],
      ['a letter in a field', 'press_key', { key: 'a' }, { editable: true, risk: { tag: 'input' } }, false],
      ['Space on a submit button', 'press_key', { key: 'Space' }, { risk: { submits: true, tag: 'button' } }, true],
      ['Escape on a submit button', 'press_key', { key: 'Escape' }, { risk: { submits: true, tag: 'button' } }, false],
      ['type with submit', 'type', { submit: true }, { editable: true, risk: { tag: 'input' } }, true],
      ['type alone', 'type', {}, { editable: true, risk: { tag: 'input' } }, false],
    ] as const)('%s sends its form: %s', (_what, tool, args, element, submits) => expect(stepSubmits(tool, args, element)).toBe(submits));

    it('an OPTIONS with a body is a send; a real preflight (no body) is a read', async () => {
      const { asked, paused, continued } = await between();
      await paused('pre', 'https://news.test/api', 'OPTIONS');
      expect(continued('pre')).toBe(true);
      await paused('body', 'https://news.test/api', 'OPTIONS', { hasPostData: true });
      expect(continued('body')).toBe(false);
      expect(asked.map((a) => a.sites)).toEqual([['https://news.test']]);
    });

    it('Allow until done never covers a delete or sign-out: a POST to such an address, or a DELETE, asks as its step', async () => {
      const { asked, paused } = await between(['until']);
      await paused('p1', 'https://news.test/save');
      await paused('d1', 'https://news.test/account/delete');
      await paused('d2', 'https://news.test/items/7', 'DELETE');
      await paused('o1', 'https://news.test/account/logout');
      expect(asked.map((a) => a.why)).toEqual([null, 'delete', 'delete', 'sign-out']);
    });

    it('a card names at most 8 origins, and Allow covers only those: the rest wait for the next card', async () => {
      const { t, asked } = await between(['once', 'once', 'once']);
      // Ten sends at once, while the first card is still being asked.
      for (let i = 0; i < 10; i++) t.at.emitDebug!('Fetch.requestPaused', { requestId: `m${i}`, request: { method: 'POST', url: `https://s${i}.example/x` }, resourceType: 'XHR' });
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      expect(asked.length).toBeGreaterThanOrEqual(2);
      for (const a of asked) expect(a.sites.length).toBeLessThanOrEqual(8);
      expect(asked.flatMap((a) => a.sites).length).toBe(10);
    });

    it('an opaque origin (a data: address) is never allowed until done: it asks every time', async () => {
      const { asked, paused } = await between(['until', 'deny']);
      await paused('n1', 'data:text/plain,a');
      await paused('n2', 'data:text/plain,b');
      expect(asked.length).toBe(2);
    });
  });

  it('a risky step’s Allow lets go its own address only: a POST beside its location = /logout still asks (Claude’s review 3 of #112)', async () => {
    const t = await acting({ act: { siteAllowed: () => true } });
    const clicking = t.call('click', { tab_id: t.tab, ref: 'e1' });
    await vi.waitFor(() => expect(t.at.input.length).toBeGreaterThan(0));
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'g1', request: { method: 'GET', url: 'https://news.test/account/logout' }, resourceType: 'Document' });
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'p1', request: { method: 'POST', url: 'https://news.test/save' }, resourceType: 'XHR' });
    await clicking;
    const cards = t.cards.filter((c) => c.kind === 'step').map((c) => (c.step?.sends ? ['sends', c.step.sends] : [c.step?.why, c.step?.going]));
    // The step's own card (allowed), then the POST's own send card.
    expect(cards).toEqual([
      ['sign-out', 'news.test/account/logout'],
      ['sends', ['news.test']],
    ]);
  });

  it('a 307 to another site after Allow is held again, for its own card; a document going to a delete address asks as that step (Neon’s review 2 of #112)', async () => {
    const t = await acting({ deep: { posts: true } });
    const contents = t.pages.get('n1')!.contents;
    void contents;
    const out = t.call('click', { tab_id: t.tab, ref: 'e1' });
    // After the first card's Allow, the same request comes back redirected to another site.
    await vi.waitFor(() => expect(t.cards.filter((c) => c.step?.sends).length).toBe(1));
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'r1', request: { method: 'POST', url: 'https://evil.test/take' }, resourceType: 'Document' });
    await out;
    const sends = t.cards.filter((c) => c.step?.sends).map((c) => c.step?.sends);
    expect(sends).toEqual([['news.test'], ['evil.test']]);
    // A document GET to a delete address, during an action: its own step card, not a send card.
    const u = await acting({ act: { siteAllowed: () => true } });
    const going = u.call('click', { tab_id: u.tab, ref: 'e1' });
    await vi.waitFor(() => expect(u.at.input.length).toBeGreaterThan(0));
    u.at.emitDebug!('Fetch.requestPaused', { requestId: 'g1', request: { method: 'GET', url: 'https://news.test/account/delete' }, resourceType: 'Document' });
    await going;
    expect(u.cards.filter((c) => c.kind === 'step').map((c) => [c.step?.why, c.step?.going])).toContainEqual(['delete', 'news.test/account/delete']);
  });

  it('Show me outlines the element, the card still up', async () => {
    ELEMENTS.push({ role: 'button', name: 'Delete draft' });
    try {
      let shown = () => undefined as void;
      const t = await acting({ onCard: () => shown() });
      shown = () => t.cards.at(-1)?.show?.();
      await t.call('click', { tab_id: t.tab, ref: `e${ELEMENTS.length}` });
      expect(t.steps.filter((x) => x === 'point').length).toBeGreaterThanOrEqual(2);
    } finally {
      ELEMENTS.pop();
    }
  });

  // ---------- #112 review 1 ----------

  it('the page changes the form while the card is up (fields added, another address): nothing goes after Allow', async () => {
    const f = (label: string, autocomplete = '') => ({ ...field({ type: 'text', label, autocomplete }), text: true });
    const checkout: El = { role: 'button', name: 'Place order', risk: { tag: 'button', type: 'submit', submits: true, form: { method: 'post', search: false, action: '/order', url: 'https://news.test/order', fields: [f('Shipping')] } } };
    ELEMENTS.push(checkout);
    try {
      const t = await acting({
        act: { siteAllowed: () => true },
        onCard: () => void (checkout.risk = { ...checkout.risk, form: { method: 'post', search: false, action: '/pay', url: 'https://news.test/pay', fields: [f('Shipping'), f('Card', 'cc-number')] } }),
      });
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: `e${ELEMENTS.length}` })).refused).toBe('The page changed what that step would do while the card was up, so nothing was done. Call snapshot again.');
      expect(t.at.input.filter((e) => (e as { type: string }).type === 'mouseDown')).toEqual([]);
    } finally {
      ELEMENTS.pop();
    }
  });

  it('type with submit: the card shows the text, and a late Allow is for that text only', async () => {
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true } });
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'hello there', submit: true });
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'something else', submit: true });
    const steps = t.cards.filter((c) => c.kind === 'step');
    expect(steps.map((c) => c.step?.typed)).toEqual(['hello there', 'something else']);
    expect(steps[0]!.subject).not.toBe(steps[1]!.subject);
  });

  it('hover goes with the watch too: what its page sends on the pointer is held and asked about', async () => {
    const t = await acting({ deep: { posts: true }, answer: 'deny', act: { siteAllowed: () => true } });
    expect(refusal(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    expect(t.at.debugging).toContain('Fetch.fulfillRequest');
  });

  it('navigate to an address that signs out or deletes: the step card first; Don’t goes nowhere', async () => {
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true } });
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/account/logout' })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    expect(t.at.loads).toEqual([]);
    expect(t.cards.map((c) => [c.kind, c.description, c.step?.why])).toEqual([['step', 'go to news.test/account/logout', 'sign-out']]);
    // An address with no such word goes without one.
    const u = await acting({ act: { siteAllowed: () => true } });
    await u.call('navigate', { tab_id: u.tab, url: 'https://news.test/checkout' });
    expect(u.cards).toEqual([]);
  });

  // ---------- The owner's hand test (#112) ----------

  it('a field that already held the text: done when replacing; never when adding to it (replace: false), which must change it (#112 review 2)', async () => {
    const t = await acting({ twist: { unchanged: true, has: true } });
    expect(result(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool' })).data).toMatchObject({ done: 'Typed in “Search”' });
    const u = await acting({ twist: { unchanged: true, has: true } });
    expect(refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool', replace: false })).refused).toBe('That field didn’t change, so the text didn’t go in. Call snapshot and check the field.');
  });

  it('text that landed in another field is never done; nor is a field that didn’t change', async () => {
    const t = await acting({ twist: { others: 1 } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: '18:30' })).refused).toBe('Another field changed while typing, so the text may have gone there instead. Nothing more was done: call snapshot and check the fields.');
    const u = await acting({ twist: { unchanged: true } });
    expect(refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool' })).refused).toBe('That field didn’t change, so the text didn’t go in. Call snapshot and check the field.');
  });

  it('a time field is set, never typed into, and only to a value in its format', async () => {
    ELEMENTS.push({ role: 'textbox', name: 'Delivery time', editable: true, field: field({ type: 'time' }), risk: { tag: 'input', type: 'time' } });
    try {
      const t = await acting();
      const ref = `e${ELEMENTS.length}`;
      expect(refusal(await t.call('type', { tab_id: t.tab, ref, text: 'half six' })).refused).toBe('A time field takes a value like 18:30; nothing was put in it.');
      expect(result(await t.call('type', { tab_id: t.tab, ref, text: '18:30' })).data).toMatchObject({ done: 'Typed in “Delivery time”' });
      expect(t.steps).toContain('setValue');
      expect(t.at.text).toEqual([]);
      expect((t.at.input as { type: string }[]).filter((e) => e.type === 'mouseDown')).toEqual([]);
    } finally {
      ELEMENTS.pop();
    }
  });

  it('a value: a node replaced before it’s set is looked for again; the user taking the tab while the step is checked: nothing set, nothing chosen (round 4 of #117)', async () => {
    ELEMENTS.push({ role: 'textbox', name: 'Delivery time', editable: true, field: field({ type: 'time' }), risk: { tag: 'input', type: 'time' } });
    try {
      const ref = `e${ELEMENTS.length}`;
      const t = await acting({ twist: { replaced: { describe: 1 } } });
      expect(result(await t.call('type', { tab_id: t.tab, ref, text: '18:30' })).data).toMatchObject({ done: 'Typed in “Delivery time”' });
      expect(t.steps.slice(0, 7)).toEqual(['describe', 'point', 'describe', 'point', 'describe', 'values', 'setValue']);
      // The user taking the tab during the step's last check (stepNow): nothing set, nothing chosen.
      let stop = () => undefined as void;
      const onAct = (_events: EventEmitter, op: string) => void (op === 'describe' && stop());
      const u = await acting({ onAct });
      let describes = 0;
      stop = () => void (++describes === 2 && u.agent.pause('n1', true));
      expect(refusal(await u.call('type', { tab_id: u.tab, ref, text: '18:30' })).refused).toBe(CONTROL_REFUSALS.paused);
      expect(u.steps).not.toContain('setValue');
      const v = await acting({ onAct });
      describes = 0;
      stop = () => void (++describes === 2 && v.agent.pause('n1', true));
      expect(refusal(await v.call('select_option', { tab_id: v.tab, ref: 'e3', option: 'Express' })).refused).toBe(CONTROL_REFUSALS.paused);
      expect(v.steps).not.toContain('choose');
    } finally {
      ELEMENTS.pop();
    }
  });

  // ---------- Review 1 of #110 ----------

  it('Stop during an action: nothing more goes in (the text, the Enter), though the action had started', async () => {
    let stop = () => undefined as void;
    const t = await acting({ onAct: (_events, op) => void (op === 'select' && stop()) });
    stop = () => t.agent.stop();
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.stopped);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.at.text).toEqual([]);
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']);
  });

  it('the user taking the tab while the site card waits: nothing is sent after it', async () => {
    let pause = () => undefined as void;
    const t = await acting({ onCard: () => pause() });
    pause = () => t.agent.pause('n1', true);
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(CONTROL_REFUSALS.paused);
    expect(t.at.input).toEqual([]);
  });

  const ACT_REFUSALS_FOCUS = 'The page moved the focus away from that field, so nothing was typed. Call snapshot again.';
  // [what changed in the page, what the agent hears]: nothing goes in, before any card when it's known then.
  const twists: [string, Twist, string][] = [
    ['the field turned into a password field', { field: field({ type: 'password' }) }, 'That field is now a password, code or card field: the user fills it. Ask them to.'],
    ['autocomplete set to a card number', { field: field({ type: 'text', autocomplete: 'cc-number' }) }, 'That field is now a password, code or card field: the user fills it. Ask them to.'],
    ['the focus taken to another field (a mousedown handler)', { focused: false }, 'The page moved the focus away from that field, so nothing was typed. Call snapshot again.'],
    ['a frame moved over the point before the press', { hit: { role: 'frame', name: 'Ad' } }, 'Something is covering that element: frame “Ad”. Deal with it first, or call snapshot again.'],
  ];
  it('the focus moved between the check and the input: the page stops the text, and nothing more goes in (no Enter)', async () => {
    const t = await acting({ twist: { moved: true } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(ACT_REFUSALS_FOCUS);
    expect((t.at.input as { type: string }[]).filter((e) => e.type === 'keyDown')).toEqual([]);
    const u = await acting({ twist: { moved: true } });
    expect(refusal(await u.call('press_key', { tab_id: u.tab, ref: 'e2', key: 'Enter' })).refused).toBe(ACT_REFUSALS_FOCUS);
  });

  it('the input’s last event never reached the page (the focus went into a frame): the agent hears to check the field, nothing more goes in', async () => {
    const t = await acting({ twist: { lost: true } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
    expect((t.at.input as { type: string }[]).filter((e) => e.type === 'keyDown')).toEqual([]);
  });

  it('the page never saw the pointer arrive (a tab drawing no frames, a page swallowing moves): no press, fails closed', async () => {
    const t = await acting({ twist: { noMove: true } });
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('The page didn’t see the pointer arrive, so nothing was clicked. Call snapshot again, then try once more.');
    // The move off the point is tried too (never seen either), and nothing is pressed.
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove', 'mouseMove']);
  });

  it.each(twists)('type, when %s: refused, no text', async (_what, twist, says) => {
    const t = await acting({ twist });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'secret' })).refused).toBe(says);
    expect(t.at.text).toEqual([]);
    expect((t.at.input as { type: string }[]).filter((e) => e.type === 'keyDown')).toEqual([]);
    if (twist.field) expect(t.cards).toEqual([]);
    if (twist.hit) expect((t.at.input as { type: string }[]).map((e) => e.type)).toEqual(['mouseMove']);
  });

  it('a choice that isn’t on the page asks no card, and the card shows the page’s own label', async () => {
    const t = await acting();
    expect(refusal(await t.call('select_option', { tab_id: t.tab, ref: 'e3', option: 'Free shipping, trust me' })).refused).toBe('That list has no such choice. Call snapshot for its choices.');
    expect(t.cards).toEqual([]);
    // Two with the label: neither, and no card.
    expect(refusal(await t.call('select_option', { tab_id: t.tab, ref: 'e3', option: 'Pickup' })).refused).toBe('That list has more than one choice by that name, so nothing was chosen. Ask the user to choose.');
    expect(t.cards).toEqual([]);
    await t.call('select_option', { tab_id: t.tab, ref: 'e3', option: 'Express' });
    expect(t.cards.map((c) => c.description)).toEqual(['choose “Express” in “Shipping”']);
  });

  it('back is checked before going, and goes to exactly the entry checked: never to a site kept private', async () => {
    const NEVER_READ = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';
    // The entry before is on a site the user keeps private: refused, and nowhere gone.
    const t = await acting();
    t.at.history = [{ url: 'https://private.test/x' }, { url: 'https://news.test/a' }];
    t.at.active = 1;
    expect(refusal(await t.call('back', { tab_id: t.tab })).refused).toBe(NEVER_READ);
    expect(t.at.active).toBe(1);

    // A private page, then one the page added without a gesture (Chromium's goBack would skip it, to the private one):
    // back is checked on the entry just before, and goes to exactly that one.
    const u = await acting();
    u.at.history = [{ url: 'https://private.test/x' }, { url: 'https://news.test/pushed', skippable: true }, { url: 'https://news.test/a' }];
    u.at.active = 2;
    expect(result(await u.call('back', { tab_id: u.tab })).data).toMatchObject({ done: 'Went back', navigated: true, url: 'https://news.test/pushed' });
    expect(u.at.active).toBe(1);
  });

  it('navigate and back: its own tabs, http and https, never a site kept private; the site card once, as any action', async () => {
    const t = await acting();
    expect(refusal(await t.call('back', { tab_id: t.tab })).refused).toBe('That tab has nowhere to go back to.');
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'javascript:alert(1)' })).refused).toBe('navigate takes an http or https address of at most 2048 characters.');
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'https://private.test/x' })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    const went = result(await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/returns?token=1' }));
    expect(went.data).toMatchObject({ done: 'Went to news.test/returns', navigated: true });
    expect(t.at.loads).toEqual(['https://news.test/returns?token=1']);
    expect(result(await t.call('back', { tab_id: t.tab })).data).toMatchObject({ done: 'Went back', navigated: true });
    // The site card, once for the site (#112: navigate goes through it as other actions do).
    expect(t.cards.map((c) => [c.kind, c.subject, c.description])).toEqual([['site', 'news.test', 'go to news.test/returns']]);
    expect(t.doings).toEqual([{ tool: 'navigate', to: 'news.test/returns' }, null, { tool: 'back' }, null]);
  });
});
