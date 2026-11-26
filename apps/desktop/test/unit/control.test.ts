/**
 * The control layer in main (S18 M1a): the gate's agent (Stop answers a call
 * in flight at once, grants last, cards go with Stop, a pause holds calls)
 * and the tools' path through it, on a fake page: refs that are unknown or
 * closed, never-readable pages, cards, page_id, and Stop mid-read. Duet's own
 * behaviour is covered, unchanged, by assistant.spec.ts.
 */
import { EventEmitter } from 'node:events';
import { ACT_REFUSALS, ACT_SENDS_WAITING, sendsLater, AGENT_READ_DEFAULT, ASSISTANT_READ_MAX, bucketOf, CONTROL_REFUSALS, CONTROL_WAIT_MS, ELEMENT_REFUSALS, TabRefs, toolResult, type Grant, type NodeId, type State, type TabNode } from '@chord/core';
import type { WebContents, WebContentsView } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlAgent, type ControlCard } from '../../src/main/control/gate';
import type { ActHost, ControlScope, ToolMemory } from '../../src/main/control/scope';
import { FIND_NEAREST_NOTE, FIND_NONE_NOTE, heldStep, ONLY_TEXT, PART_REFUSALS, runControlTool, STILL_LOADING, stepSubmits, withOutline, type ControlBrowser } from '../../src/main/control/tools';
import { runBatch } from '../../src/main/control/batch';
import { byDeadline, HandedOver, laterContent, OpenCards, takeLater } from '../../src/main/control/handed-over';
import { INPUT_REDRAWN } from '../../src/main/control/act-steps';
import { focusToGiveBack, shownFor } from '../../src/main/control/page';
import { imageTokens } from '../../src/main/control/extract';
import { endUntil, holdSends, sendHoldDeps, failHeld, type SendAnswer, type SendWatch } from '../../src/main/control/sends';
import { NOT_SHARED } from '../../src/main/agents/scope';
import { siteOfUrl } from '../../src/main/agents/shares';

afterEach(() => vi.useRealTimers());

/** Tabs of yours whose lease was lost (control/user-watch.ts: a detach, the renderer gone), as page.lost() and deep.held() ask. */
const leaseLost = vi.hoisted(() => new WeakSet<object>());
vi.mock('../../src/main/control/user-watch', async (actual) => ({ ...(await actual<Record<string, unknown>>()), userLeaseLost: (contents: object) => leaseLost.has(contents) }));
/** A PDF's pages, when a test gives them (round 1 of #252): else the real extraction. */
const pdfPages = vi.hoisted(() => ({ pages: null as string[] | null }));
vi.mock('../../src/main/control/pdf', async (actual) => {
  const real = await actual<{ extractPdf: (...a: unknown[]) => Promise<unknown> }>();
  return { ...real, extractPdf: (...a: unknown[]) => (pdfPages.pages ? Promise.resolve({ pages: pdfPages.pages, totalPages: pdfPages.pages.length }) : real.extractPdf(...a)) };
});
afterEach(() => void (pdfPages.pages = null));
/** An outside agent's tab whose hold was lost (agents/pickers.ts), and whether trying again gets it back. */
const pickers = vi.hoisted(() => ({ lost: new WeakSet<object>(), retries: 0 }));
vi.mock('../../src/main/agents/pickers', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  pickersLost: (contents: object) => pickers.lost.has(contents),
  retryPickers: async (contents: object) => (pickers.retries++, pickers.lost.delete(contents), true),
}));

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

  it('a call held on a paused tab ends at once when the client gives up (round 1 of #145, SF3)', async () => {
    vi.useFakeTimers();
    const agent = new ControlAgent('a', presenter().present);
    agent.pause('n1', true);
    const giveUp = new AbortController();
    let ran = false;
    let settled = false;
    const held = agent.call('n1', async () => ((ran = true), 'ran'), (why) => why, giveUp.signal).finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    giveUp.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(held).resolves.toBe('stopped');
    // And it never runs, even once the user leaves the tab.
    agent.pause('n1', false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toBe(false);
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
    /** The page still loading (a wait for it, cancelled: SF3). */
    loading?: boolean;
    onCapture?: () => void;
    pdfLandsAt?: string;
    zoom: number;
    input: unknown[];
    text: string[];
    loads: string[];
    history: { url: string; skippable?: boolean }[];
    active: number;
    /** The debugger's answers (control/deep.ts): its hit test, a closed shadow root in the element, a file picker held. */
    deep: { hit?: unknown; closed?: boolean; picker?: boolean; unavailable?: boolean; posts?: boolean; ping?: boolean; persistent?: boolean; opens?: string[]; postsOnLoad?: boolean; postsTo?: string[] };
    debugging: string[];
    /** #143: the page commits another document (did-navigate), as a GET navigation of its own would. */
    navigate?: (url: string) => void;
    /** #143: the page goes (its tab closed). */
    destroy?: () => void;
    /** #143: a load that commits and never stops (its did-stop-loading never comes). */
    stallLoad?: boolean;
    /** #143: the page starts a navigation of its own (a step's after-load wait then waits for it). */
    startNavigation?: () => void;
    /** A debugger event, as Chromium would send it (a request the page makes, paused). */
    emitDebug?: (method: string, params: unknown, sessionId?: string) => void;
    emitDetach?: () => void;
    /** The page's renderer gone (render-process-gone, a crash). */
    crash?: () => void;
    /** The page's requests went (deep.ping, deep.posts): once per page. */
    sent?: boolean;
    /** Every debugger command, with its parameters. */
    commands?: [string, unknown][];
    /** Where a load of an address lands instead (a server redirect). */
    redirects?: Record<string, string>;
  } = { url, zoom: 1, input: [], text: [], loads: [], history: [{ url }], active: 0, deep: {}, debugging: [] };
  const debugEvents = new EventEmitter();
  let attached = false;
  at.navigate = (to) => {
    at.url = to;
    events.emit('did-navigate');
  };
  at.destroy = () => void events.emit('destroyed');
  at.startNavigation = () => {
    at.loading = true;
    events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://news.test/next' });
  };
  at.emitDebug = (method, params, sessionId) => void debugEvents.emit('message', {}, method, params, sessionId);
  // The debugger let go, as Chromium's does: no longer attached, and no command reaches the page after (#322's B3).
  let detached = false;
  at.emitDetach = () => {
    attached = false;
    detached = true;
    debugEvents.emit('detach', {}, 'target closed');
  };
  at.crash = () => void events.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  const go = (index: number) => {
    at.active = index;
    at.url = at.history[index]!.url;
    events.emit('did-navigate');
    if (at.stallLoad) at.loading = true;
    else events.emit('did-stop-loading');
  };
  const contents = {
    // Acting (S18 M2c): what an action sends, recorded.
    getZoomFactor: () => at.zoom,
    sendInputEvent: (e: unknown) => {
      at.input.push(e);
      // A page that sends as the agent acts (S18 M2d): its requests, paused by the tab's send hold, once its first input came.
      if (!at.sent && (at.deep.ping || at.deep.posts || at.deep.postsTo)) {
        at.sent = true;
        // #143: posts to several sites at once, each its own Send data card (askHeld asks them one after another).
        for (const [i, to] of (at.deep.postsTo ?? []).entries()) setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: `m${i}`, request: { method: 'POST', url: to }, resourceType: 'Fetch' }), 0);
        if (at.deep.ping) setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'b1', request: { method: 'POST', url: 'https://stats.test/collect' }, resourceType: 'Ping' }), 0);
        if (at.deep.posts) setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'r1', request: { method: 'POST', url: 'https://news.test/save' }, resourceType: 'Document' }), 0);
      }
    },
    setIgnoreMenuShortcuts: () => undefined,
    insertText: async (text: string) => void at.text.push(text),
    getTitle: () => 'Article',
    loadURL: async (to: string) => {
      // A page that sends as it's left (deep.postsOnLoad): its request paused by the tab's send hold, and the load waits on it.
      if (!at.sent && at.deep.postsOnLoad) {
        at.sent = true;
        setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'r2', request: { method: 'POST', url: 'https://news.test/beacon' }, resourceType: 'Fetch' }), 0);
        await new Promise((r) => setTimeout(r, 5));
      }
      at.loads.push(to);
      at.history = [...at.history.slice(0, at.active + 1), { url: at.redirects?.[to] ?? to }];
      go(at.history.length - 1);
    },
    navigationHistory: {
      canGoBack: () => at.active > 0,
      getActiveIndex: () => at.active,
      getEntryAtIndex: (i: number) => at.history[i],
      goToIndex: (i: number) => {
        // A page that sends as it's left (deep.postsOnLoad), going back too (#143's back card).
        if (!at.sent && at.deep.postsOnLoad) {
          at.sent = true;
          setTimeout(() => debugEvents.emit('message', {}, 'Fetch.requestPaused', { requestId: 'r2', request: { method: 'POST', url: 'https://news.test/beacon' }, resourceType: 'Fetch' }), 0);
          setTimeout(() => go(i), 5);
          return;
        }
        go(i);
      },
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
        if (detached) throw new Error('No target with given id found');
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
    isLoading: () => Boolean(at.loading),
    getURL: () => at.url,
    on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
    once: (e: string, f: (...a: unknown[]) => void) => events.once(e, f),
    off: (e: string, f: (...a: unknown[]) => void) => events.off(e, f),
    capturePage: async () => {
      at.onCapture?.();
      // Two pixels of different colors: a page drawn (extract.ts' oneColor); the view 1280 x 800.
      return { getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from('secret'), toBitmap: () => Buffer.from([1, 2, 3, 255, 9, 9, 9, 255]) };
    },
    executeJavaScriptInIsolatedWorld: (_world: number, [script]: { code: string }[]) =>
      // Whether the page shows anything yet (snapshot.ts' pageShows): it does.
      script!.code.includes('const has = () =>')
        ? Promise.resolve(true)
        : typeof read === 'function'
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
    waits?: boolean;
    needsCard?: boolean;
    answer?: Grant | 'hold';
    read?: Answer;
    cardWaitMs?: number;
    sendWaitMs?: number;
    /** #143: the call's own deadline (an outside agent's CALL_WAIT_MS): its answer by then, whatever card is still up. */
    callDeadlineMs?: number;
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
    tabs: { queueLoad: (_c: unknown, load: () => unknown) => void load(), get: view, ensure: (id) => (opts.onEnsure?.({ go, close }), view(id)) },
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
    // Held: answered by the test later (holds), or deny when taken down.
    return new Promise<Grant>((resolve) => {
      holds.push(resolve);
      signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });
  });
  /** Each held card's answer, for a test to give late. */
  const holds: ((g: Grant) => void)[] = [];
  const activity: string[] = [];
  // An outside agent's (a deadline): the sends a call answered before, and what became of them (#143).
  const memory: ToolMemory = { pdfs: new Map(), form: null, nextField: 1, read: new Set(), ...(opts.callDeadlineMs ? { sendsWaiting: new Set<NodeId>(), later: [] } : {}) };
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
    ...(opts.sendWaitMs ? { sendWaitMs: opts.sendWaitMs } : {}),
    ...(opts.callDeadlineMs ? { callDeadlineMs: opts.callDeadlineMs } : {}),
    ...(opts.waits === false ? {} : { waits: true }),
    ...(opts.sharedOn ? { siteOk: (_node: TabNode, url: string) => siteOfUrl(url) === opts.sharedOn, whyNot: () => NOT_SHARED } : {}),
    activity: async (_tool, summary) => void activity.push(summary),
  };
  const call = (name: string, args: Record<string, unknown> = {}) => runControlTool(scope, browser, name, args);
  /** A call the client can give up on (MCP's notifications/cancelled). */
  const callUntil = (name: string, args: Record<string, unknown>, cancelled: AbortSignal) => runControlTool(scope, browser, name, args, cancelled);
  return { scope, agent, call, callUntil, close, cards, activity, pages, go, browser, holds };
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

  it('read_tab’s range: an outside agent’s 20000 when it asks for none, the assistant’s 40000; length up to 40000; start reads on (S18 M2g-2, #206)', async () => {
    const TEXT = 'abcdefghij'.repeat(5_000);
    /** The range a read gives, by the scope's default and the call's arguments. */
    const range = async (readDefault: number | undefined, args: Record<string, unknown> = {}) => {
      const t = setup({ read: { text: TEXT } });
      if (readDefault !== undefined) (t.scope as { readDefault?: number }).readDefault = readDefault;
      return (JSON.parse((await t.call('read_tab', { tab_id: t.scope.refs.refFor('n1'), ...args })).text!) as { range: { start: number; end: number; total: number } }).range;
    };
    // [the scope, the call, the range it gives]
    const table: [string, number | undefined, Record<string, unknown>, { start: number; end: number; total: number }][] = [
      ['an outside agent, no length', AGENT_READ_DEFAULT, {}, { start: 0, end: 20_000, total: 50_000 }],
      ['an outside agent, reading on', AGENT_READ_DEFAULT, { start: 20_000 }, { start: 20_000, end: 40_000, total: 50_000 }],
      ['an outside agent, the last range', AGENT_READ_DEFAULT, { start: 40_000 }, { start: 40_000, end: 50_000, total: 50_000 }],
      ['an outside agent, the most it may ask for', AGENT_READ_DEFAULT, { length: ASSISTANT_READ_MAX }, { start: 0, end: 40_000, total: 50_000 }],
      ['an outside agent, more than that', AGENT_READ_DEFAULT, { length: ASSISTANT_READ_MAX + 1 }, { start: 0, end: 40_000, total: 50_000 }],
      ['an outside agent, one character', AGENT_READ_DEFAULT, { length: 1 }, { start: 0, end: 1, total: 50_000 }],
      ['an outside agent, past the end', AGENT_READ_DEFAULT, { start: 60_000 }, { start: 50_000, end: 50_000, total: 50_000 }],
      ['the assistant, no length', undefined, {}, { start: 0, end: 40_000, total: 50_000 }],
      // Never a way past the default or the minimum (round 1 of #252, SF-1): length 0 is one character; a length that
      // isn't a number is none asked for; a fraction is its whole part; so is a start.
      ['an outside agent, length 0', AGENT_READ_DEFAULT, { length: 0 }, { start: 0, end: 1, total: 50_000 }],
      ['an outside agent, length NaN', AGENT_READ_DEFAULT, { length: Number.NaN }, { start: 0, end: 20_000, total: 50_000 }],
      ['an outside agent, length Infinity', AGENT_READ_DEFAULT, { length: Number.POSITIVE_INFINITY }, { start: 0, end: 20_000, total: 50_000 }],
      ['an outside agent, length 2.7', AGENT_READ_DEFAULT, { length: 2.7 }, { start: 0, end: 2, total: 50_000 }],
      ['an outside agent, start 10.7', AGENT_READ_DEFAULT, { start: 10.7, length: 5 }, { start: 10, end: 15, total: 50_000 }],
      ['an outside agent, start NaN', AGENT_READ_DEFAULT, { start: Number.NaN, length: 5 }, { start: 0, end: 5, total: 50_000 }],
    ];
    for (const [who, readDefault, args, expected] of table) expect(await range(readDefault, args), who).toEqual(expected);
    expect(AGENT_READ_DEFAULT).toBe(20_000);
  });

  it('a PDF reads as a page does: an outside agent’s 20000 when it asks for none, the assistant’s 40000, length 0 one character (round 1 of #252, SF-1 and SF-3)', async () => {
    pdfPages.pages = ['abcdefghij'.repeat(5_000)];
    const pdf = async () => ({ title: 'Guide', url: 'https://news.test/a', contentType: 'application/pdf', text: '', selection: '' });
    const range = async (readDefault: number | undefined, args: Record<string, unknown> = {}) => {
      const t = setup({ read: pdf });
      if (readDefault !== undefined) (t.scope as { readDefault?: number }).readDefault = readDefault;
      const out = JSON.parse((await t.call('read_tab', { tab_id: t.scope.refs.refFor('n1'), ...args })).text!) as { range: { start: number; end: number } };
      return out.range.end - out.range.start;
    };
    expect(await range(AGENT_READ_DEFAULT)).toBe(20_000);
    expect(await range(undefined)).toBe(40_000);
    expect(await range(AGENT_READ_DEFAULT, { length: 0 })).toBe(1);
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

  it('a step’s retry after waiting joins its card still up, never a second; its Allow runs the retry once (Neon’s review of M2g-1, B1)', async () => {
    vi.useFakeTimers();
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const step = card({ kind: 'step', tool: 'click', subject: 'n1|p1|e4|click||false', tab: 'n1', target: ['https://shop.test/checkout'] });
    const asked = agent.ask(step, new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(asked).resolves.toBe('waiting');
    // The retry waits on the card already up.
    const retry = agent.ask(step, new AbortController().signal, 20_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(1);
    shown[0]!.answer('once');
    await expect(retry).resolves.toBe('once');
    // Spent by the retry: nothing kept for a third ask, which gets a card of its own.
    void agent.ask(step, new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(2);
    vi.useRealTimers();
  });

  it('a step’s late Allow is spent when another action runs on its tab, and kept (not lost) when asked from another page (Neon’s review of M2g-1, B1)', async () => {
    vi.useFakeTimers();
    const { shown, present } = presenter();
    const agent = new ControlAgent('a', present);
    const step = (target: string) => card({ kind: 'step', tool: 'click', subject: 'n1|p1|e4|click||false', tab: 'n1', target: [target] });
    const late = async (target: string) => {
      const asked = agent.ask(step(target), new AbortController().signal, 20);
      await vi.advanceTimersByTimeAsync(20);
      await expect(asked).resolves.toBe('waiting');
      shown.at(-1)!.answer('once');
      await vi.advanceTimersByTimeAsync(0);
    };
    // Another action on the tab meanwhile: the retry asks again.
    await late('https://shop.test/checkout');
    agent.dropLateSteps('n2');
    agent.dropLateSteps('n1');
    void agent.ask(step('https://shop.test/checkout'), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(2);
    // That card, answered after its ask gave up: a late Allow again.
    await vi.advanceTimersByTimeAsync(20);
    shown[1]!.answer('once');
    await vi.advanceTimersByTimeAsync(0);
    // Asked from another address: a card of its own, and the late Allow is still there for its own page.
    void agent.ask(step('https://shop.test/elsewhere'), new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(3);
    await expect(agent.ask(step('https://shop.test/checkout'), new AbortController().signal, 20)).resolves.toBe('once');
    expect(shown).toHaveLength(3);
    vi.useRealTimers();
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

describe('wait_for (S18 M2g-1)', () => {
  type Answer = { met: boolean; cut: boolean; editor?: boolean; ms?: number; since?: number } | 'hold' | 'slow';
  /** The page answers wait_for's looks in turn (the last one again after), the snapshot with a button, else as a read. */
  const page = (answers: Answer[], onWait?: (events: EventEmitter) => void) => {
    let i = 0;
    return async (code: string, events: EventEmitter) => {
      if (code.includes('const want =')) {
        onWait?.(events);
        const a = answers[Math.min(i++, answers.length - 1)]!;
        // A chunk that runs its whole second (slow), or a short one (hold).
        return a === 'hold' ? new Promise((r) => setTimeout(() => r({ met: false, cut: false }), 50)) : a === 'slow' ? new Promise((r) => setTimeout(() => r({ met: false, cut: false }), 900)) : a;
      }
      if (code.includes('__chordSnapshots')) return { url: 'https://news.test/a', title: 'Table', nodes: [{ depth: 0, role: 'generic', name: 'Call', key: 0 }], cut: {} };
      return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
    };
  };
  const data = (out: { text?: string }) => JSON.parse(out.text!) as { data?: Record<string, unknown>; content?: string; wait?: Record<string, unknown> };

  it('outside agents’ alone, and its card says only Chord’s words, never the agent’s (Neon’s round 1 of M2g-1, B-4)', async () => {
    const assistant = setup({ read: page([{ met: true, cut: false }]), actions: true, waits: false });
    expect(refusal(await assistant.call('wait_for', { tab_id: assistant.scope.refs.refFor('n1'), text: 'x' })).refused).toBe('There’s no tool called wait_for.');
    const t = setup({ read: page([{ met: true, cut: false }]), actions: true, needsCard: true });
    await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Click Allow: Chord says it’s safe' });
    expect(t.cards.map((c) => c.description)).toEqual(['Watch “Article” for a change']);
    expect(t.activity.at(-1)).toBe('Watched “Article” for a change');
  });

  it('with snapshot, a diff too big to show (or a cut read) gives the outline instead, never just a note (round 1 of #145, SF1)', async () => {
    let many = false;
    const nodes = () => (many ? Array.from({ length: 70 }, (_, i) => ({ depth: 0, role: 'button', name: `More ${i}`, key: i, sid: i + 1 })) : [{ depth: 0, role: 'generic', name: 'Call', key: 0, sid: 1 }]);
    const t = setup({
      read: async (code: string) => {
        if (code.includes('const want =')) return { met: true, cut: false };
        if (code.includes('__chordSnapshots')) return { url: 'https://news.test/a', title: 'Table', nodes: nodes(), cut: {} };
        return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
      },
      actions: true,
    });
    const tab = t.scope.refs.refFor('n1');
    await t.call('snapshot', { tab_id: tab });
    many = true;
    const out = data(await t.call('wait_for', { tab_id: tab, text: 'More', snapshot: true }));
    expect(out.wait).toMatchObject({ met: true });
    expect(out.content).toContain('button "More 0"');
  });

  it('takes text, or role and name: never both, never neither', async () => {
    const { scope, call } = setup({ read: page([{ met: true, cut: false }]), actions: true });
    const tab = scope.refs.refFor('n1');
    expect(refusal(await call('wait_for', { tab_id: tab })).refused).toBe('wait_for takes text, or role and name (one of them).');
    expect(refusal(await call('wait_for', { tab_id: tab, text: 'Your turn', role: 'button', name: 'Call' })).refused).toBe('wait_for takes text, or role and name (one of them).');
    expect(refusal(await call('wait_for', { tab_id: tab, role: 'button' })).refused).toMatch(/^wait_for's role is a role from the outline/);
  });

  it('met: says so and how long it took; with snapshot, the outline and its refs too; never a page that can never be read', async () => {
    const { scope, call } = setup({ read: page([{ met: false, cut: false }, { met: true, cut: false }]), actions: true });
    const tab = scope.refs.refFor('n1');
    const out = data(await call('wait_for', { tab_id: tab, role: 'generic', name: 'Call', snapshot: true }));
    expect(out.wait).toMatchObject({ tab_id: tab, met: true });
    expect(out.content).toBe('- generic "Call" [ref=e1]');
    expect(scope.memory.elements!.get('n1')!.resolve('e1', (out as { page_id: string }).page_id)).toMatchObject({ ok: true });
    expect(refusal(await call('wait_for', { tab_id: scope.refs.refFor('n2'), text: 'x' })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
  });

  it('not met by timeout_ms: says so (never an error); a look cut short says what it couldn’t tell, waiting for it to show or to go (S-3)', async () => {
    const { scope, call } = setup({ read: page([{ met: false, cut: true }]), actions: true });
    const out = data(await call('wait_for', { tab_id: scope.refs.refFor('n1'), text: 'Your turn', gone: true, timeout_ms: 100 }));
    expect(out.data).toMatchObject({ met: false, note: 'The page is too big to look at all of it, so it can’t be told whether that’s gone.' });
    const u = setup({ read: page([{ met: false, cut: true }]), actions: true });
    const shows = data(await u.call('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 100 }));
    expect(shows.data).toMatchObject({ met: false, note: 'The page is too big to look at all of it: it may be in the part not looked at.' });
  });

  it('a second wait started at the same moment is refused: the first holds the agent’s one wait from the start (S-2)', async () => {
    const t = setup({ read: page(['hold']), actions: true });
    const tab = t.scope.refs.refFor('n1');
    const [a, b] = await Promise.all([t.call('wait_for', { tab_id: tab, text: 'x', timeout_ms: 200 }), t.call('wait_for', { tab_id: tab, text: 'x', timeout_ms: 200 })]);
    expect([a, b].filter((o) => o.isError).map((o) => refusal(o).refused)).toEqual(['You’re waiting already: one wait at a time.']);
  });

  it('the client’s cancel ends it at once, not at the end of the page’s second; the user taking the tab over ends it too (S-2)', async () => {
    const u = setup({ read: page(['slow']), actions: true });
    const giveUp = new AbortController();
    vi.useFakeTimers();
    let settled = false;
    const waiting = u.callUntil('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 5000 }, giveUp.signal).finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(50);
    giveUp.abort();
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(true);
    expect(refusal(await waiting).refused).toBe(CONTROL_REFUSALS.stopped);
    vi.useRealTimers();
    // Taken over (its cards let go of: the user took the tab, the agent not paused).
    const t = setup({ read: page(['hold']), actions: true });
    const over = t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 3000 });
    await new Promise((r) => setTimeout(r, 20));
    t.agent.cancelCardsFor('n1');
    expect(refusal(await over).refused).toBe(ACT_REFUSALS.takenOver);
  });

  it('a look slower than a quarter of a chunk never stalls the wait: a chunk with no look counts down the throttle (round 1 of #145, SF2)', async () => {
    const codes: string[] = [];
    const answers = page([{ met: false, cut: false, ms: 300, since: 0 }, { met: false, cut: false, looked: false } as never, { met: true, cut: false, ms: 300, since: 0 }]);
    const t = setup({ read: async (code: string, events: EventEmitter) => (code.includes('const want =') && codes.push(code), answers(code, events)), actions: true });
    const out = data(await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 5000 }));
    expect(out.data).toMatchObject({ met: true });
    // 4 x 300 ms after the first look; then, a chunk (1 s) later with no look, the 200 ms left.
    expect(codes.map((c) => Number(/"after":(\d+)/.exec(c)?.[1]))).toEqual([0, 1200, 200]);
  });

  it('at most what’s left of the call’s time for cards (an outside agent’s: Codex gives a call 60 s) (round 1 of #145)', async () => {
    const t = setup({ read: page(['hold']), actions: true, cardWaitMs: 1500 });
    vi.useFakeTimers();
    let settled = false;
    const waiting = t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 20_000 }).finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled).toBe(true);
    expect(data(await waiting).data).toMatchObject({ met: false });
  });

  it('the client giving up while the page still loads ends it at once (round 1 of #145, SF3)', async () => {
    let looked = false;
    const u = setup({ read: page([{ met: true, cut: false }], () => void (looked = true)), actions: true });
    u.pages.get('n1')!.at.loading = true;
    const giveUp = new AbortController();
    vi.useFakeTimers();
    let settled = false;
    const waiting = u.callUntil('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 5000 }, giveUp.signal).finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(50);
    giveUp.abort();
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(true);
    expect(refusal(await waiting).refused).toBe(CONTROL_REFUSALS.stopped);
    // Its own wait for the page ended too (the call's signal), and nothing was looked at after (round 2 of #145).
    await vi.advanceTimersByTimeAsync(20);
    expect(u.pages.get('n1')!.events.listenerCount('did-stop-loading')).toBe(0);
    expect(looked).toBe(false);
  });

  it('the throttle carries from one second to the next: a slow look isn’t followed at once by another (S-2)', async () => {
    const codes: string[] = [];
    const answers = page([{ met: false, cut: false, ms: 100, since: 10 }, { met: true, cut: false, ms: 100, since: 10 }]);
    const t = setup({ read: async (code: string, events: EventEmitter) => (code.includes('const want =') && codes.push(code), answers(code, events)), actions: true });
    await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 3000 });
    const after = codes.map((c) => Number(/"after":(\d+)/.exec(c)?.[1]));
    // The first look at once; the next chunk's after 4 x 100 ms less the 10 since.
    expect(after[0]).toBe(0);
    expect(after[1]).toBe(390);
  });

  it('a page that is an editor (its body editable, or designMode on): never its text, only an element by role and name (Neon’s round 1 of M2g-1, B-3)', async () => {
    const { scope, call } = setup({ read: page([{ met: false, cut: false, editor: true }]), actions: true });
    const out = await call('wait_for', { tab_id: scope.refs.refFor('n1'), text: 'my password is', timeout_ms: 3000 });
    expect(refusal(out).refused).toBe('That page is an editor: what shows in it is what’s typed there, so wait_for looks only for an element by its role and name there.');
  });

  it('one wait at a time for an agent; Stop or the client giving up ends it', async () => {
    const t = setup({ read: page(['hold']), actions: true });
    const tab = t.scope.refs.refFor('n1');
    const first = t.call('wait_for', { tab_id: tab, text: 'Your turn', timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(refusal(await t.call('wait_for', { tab_id: tab, text: 'Your turn' })).refused).toBe('You’re waiting already: one wait at a time.');
    t.agent.stop();
    expect(refusal(await first).refused).toBe(CONTROL_REFUSALS.stopped);
    // The client giving up (notifications/cancelled): the same, at once.
    const u = setup({ read: page(['hold']), actions: true });
    const giveUp = new AbortController();
    const waiting = u.callUntil('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 5000 }, giveUp.signal);
    await new Promise((r) => setTimeout(r, 20));
    giveUp.abort();
    expect(refusal(await waiting).refused).toBe(CONTROL_REFUSALS.stopped);
  });

  it('a tab that can’t be read any more mid-wait ends it: a never-read address, or a scope that no longer reads it (round 1 of #145, SF7)', async () => {
    let moved = false;
    const t: ReturnType<typeof setup> = setup({ read: page(['hold', 'hold', 'hold'], () => { if (moved) return; moved = true; t.go('n1', 'https://private.test/inbox', true); }), actions: true });
    expect(refusal(await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'x', timeout_ms: 3000 })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    let gone = false;
    const u: ReturnType<typeof setup> = setup({ read: page(['hold', 'hold', 'hold'], () => { if (gone) return; gone = true; (u.scope as { readable: (n: TabNode) => boolean }).readable = () => false; }), actions: true });
    const out = await u.call('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'x', timeout_ms: 3000 });
    expect(out.isError).toBe(true);
    expect(refusal(out).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
  });

  it('the page going somewhere else while it waits ends it: not met, and said so', async () => {
    const t = setup({ read: page([{ met: false, cut: false }], (events) => events.emit('did-navigate')), actions: true });
    const out = data(await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 3000 }));
    expect(out.data).toMatchObject({ met: false, navigated: true });
  });

  it('the same document going to another address (a pushState) doesn’t end it: met, and its refs said to be stale', async () => {
    let moved = false;
    const doings: unknown[] = [];
    const t = setup({
      act: { doing: (_n, d) => void doings.push(d) },
      read: page([{ met: false, cut: false }, { met: true, cut: false }], (events) => {
        if (!moved) events.emit('did-navigate-in-page', {}, 'https://news.test/b', true);
        moved = true;
      }),
      actions: true,
    });
    const out = data(await t.call('wait_for', { tab_id: t.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 3000 }));
    expect(out.data).toMatchObject({ met: true, navigated: true, note: 'The page went to another address while you waited (the same document): refs from before are stale.' });
    // Both notes when both are so (S-3).
    let moved2 = false;
    const u = setup({ read: page([{ met: false, cut: true }], (events) => { if (!moved2) events.emit('did-navigate-in-page', {}, 'https://news.test/c', true); moved2 = true; }), actions: true });
    const both = data(await u.call('wait_for', { tab_id: u.scope.refs.refFor('n1'), text: 'Your turn', timeout_ms: 100 }));
    expect(both.data).toMatchObject({ met: false, navigated: true, note: 'The page is too big to look at all of it: it may be in the part not looked at. The page went to another address while you waited (the same document): refs from before are stale.' });
    // The bar says it waits (never what for: the agent's words), and stops saying so.
    expect(doings).toEqual([{ tool: 'wait_for' }, null]);
  });
});

describe('tab_screenshot’s size (S18 M2g-1: counted by its pixels)', () => {
  it('a PNG at most 1280 wide, its size said', async () => {
    const { scope, call } = setup({ read: { text: 'x' }, actions: true });
    const out = await call('tab_screenshot', { tab_id: scope.refs.refFor('n1') });
    expect(out.image).toMatchObject({ mimeType: 'image/png', width: 1280, height: 800 });
    expect(imageTokens(out.image!.width!, out.image!.height!)).toBe(1366);
  });
});

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

  it('gives the outline with the tab’s refs; each snapshot gives new ones (a page with no ids of its own), and the earlier ones go stale', async () => {
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

  it('a page that draws itself after it loads: an empty first look is taken once more when it shows something; still empty, said so (the owner, 2026-11-24)', async () => {
    // Empty the first time, drawn the second.
    let looks = 0;
    const drawing = async (code: string, events: EventEmitter) => (code.includes('__chordSnapshots') && looks++ === 0 ? { url: 'https://news.test/a', title: 'Lobby', nodes: [], cut: {} } : page(nodes)(code, events));
    const t = setup({ read: drawing, actions: true });
    const out = snap(await t.call('snapshot', { tab_id: t.scope.refs.refFor('n1') }));
    expect(looks).toBe(2);
    expect(out.content).toContain('button "Go" [ref=e2]');
    // Empty both times: the result says the page shows nothing yet, never an empty outline as if that were the page.
    const u = setup({ read: page([]), actions: true });
    expect(JSON.parse((await u.call('snapshot', { tab_id: u.scope.refs.refFor('n1') })).text!)).toMatchObject({ refs: 0, note: 'The page shows nothing yet (it may still be loading or drawing). Call snapshot again in a moment.' });
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
  // Long, and never rows alike (links and buttons by turns), so it isn't collapsed: it's read in ranges.
  const many = Array.from({ length: 3000 }, (_, i) => ({ depth: 0, role: i % 2 ? 'button' : 'link', name: `Row ${i}`, key: i }));
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

  it('a later range after a find is the whole outline’s, never the find’s (Neon’s round 1 of M2g-1, N-3)', async () => {
    const calls: string[] = [];
    const { scope, call } = setup({ read: page(calls), actions: true });
    const ref = scope.refs.refFor('n1');
    const found = snap(await call('snapshot', { tab_id: ref, find: 'Row 2999' }));
    expect(found.content).toContain('Row 2999');
    const whole = snap(await call('snapshot', { tab_id: ref }));
    const next = snap(await call('snapshot', { tab_id: ref, start: 100 }));
    expect(calls).toHaveLength(2);
    expect(next.range.total).toBe(whole.range.total);
    // And straight after the find: its range is of the page's whole outline too.
    const again = snap(await call('snapshot', { tab_id: ref, find: 'Row 2999' }));
    expect(snap(await call('snapshot', { tab_id: ref, start: 100 })).range.total).toBe(whole.range.total);
    expect(again.range.total).toBeLessThan(whole.range.total);
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
  type Twist = { ambiguous?: boolean; ambiguousAt?: Record<string, number>; ambiguousCompare?: boolean; goneWhy?: 'changed' | 'ambiguous' | 'row-empty'; compareWhy?: string; part?: (events: EventEmitter) => unknown; field?: Field; focused?: boolean; hit?: { role: string; name: string }; moved?: boolean; lost?: boolean; noMove?: boolean; there?: boolean; noMoveOff?: boolean; stray?: boolean; unguard?: 'timeout' | 'gone' | 'expired'; noRisk?: boolean; keydownPassed?: boolean; passed?: number; movedTimes?: number; unseen?: boolean; goneAfterKey?: boolean; pressUnseen?: boolean; watchedAt?: number; sent?: () => { type: string }[]; multiline?: boolean; codes?: string[]; replaced?: Record<string, number>; others?: number; unchanged?: boolean; has?: boolean; place?: (op: string) => { items: string; path: string; row?: string }; read?: { url?: string; cut?: Record<string, boolean>; meanwhile?: (events: EventEmitter) => void; extra?: unknown[] }; at?: { url: string } };
  const page = (steps: string[], onAct?: (events: EventEmitter, op: string) => void, twist: Twist = {}) => async (code: string, events: EventEmitter) => {
    // The page preload's guard (preload/agent-guard.ts): what it stopped, as if the focus moved between the check and the input.
    twist.codes?.push(code);
    if (code.includes('__chordAgentGuard')) {
      // A key's keydown, handled (agent-guard.ts' seen), at once; a press watched for, then seen. Each a step, marked
      // when it comes on the wrong side of the press (deleting a wait fails a test).
      const sent = () => twist.sent?.() ?? [];
      if (code.includes('.seen(')) {
        steps.push('seen');
        return !twist.unseen;
      }
      // The press is watched for before it's sent: a mouseUp after the watch began, then seen (else -early: the
      // watch came after the press, or the wait before it).
      if (code.includes('.pressMark(')) {
        steps.push('watchPress');
        twist.watchedAt = sent().length;
        return 0;
      }
      if (code.includes('.pressSeen(')) {
        steps.push(sent().slice(twist.watchedAt ?? 0).some((e) => e.type === 'mouseUp') ? 'pressSeen' : 'pressSeen-early');
        return !twist.pressUnseen;
      }
      const op = code.includes('.arm(') ? 'guard' : 'unguard';
      steps.push(op);
      onAct?.(events, op);
      if (op === 'guard') return true;
      if (twist.unguard === 'gone') return null;
      if (twist.unguard === 'expired') return { expired: true };
      if (twist.unguard === 'timeout') return new Promise(() => undefined);
      // Stopped the first movedTimes inputs only (the page took the focus, then let it be).
      if (twist.movedTimes !== undefined) return { moved: twist.movedTimes-- > 0, lost: false, keydownPassed: false, passed: 0 };
      return { moved: Boolean(twist.moved), lost: Boolean(twist.lost), keydownPassed: Boolean(twist.keydownPassed), passed: twist.passed ?? (twist.keydownPassed ? 1 : 0) };
    }
    // read_tab by a part's ref (#207): the part's script, as the test says it answers.
    if (code.includes('readText(el, true)')) {
      twist.codes?.push('part');
      return twist.part ? twist.part(events) : { ok: true, url: 'https://news.test/a', role: 'region', name: 'Orders', text: 'Order 12 shipped. Order 15 is on its way.' };
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
      const said = { role: el.role, name: el.name, ...(f ? { field: f } : {}), ...(twist.place ? twist.place(args.op) : {}) };
      // The page replaced the node, this many more times at this step (a re-render): found again only by point.
      // Look-alikes the page redrew (#211): which one can't be told.
      if (twist.ambiguous) return { ok: false, why: 'ambiguous' };
      // Where the text went, checked after it went in (#211's round 2: Fable's probe).
      if (args.op === 'values' && args.mode === 'compare' && twist.ambiguousCompare) return { ok: false, why: 'ambiguous' };
      if (args.op === 'values' && args.mode === 'compare' && twist.compareWhy) return { ok: false, why: twist.compareWhy };
      if (twist.ambiguousAt?.[args.op]) {
        twist.ambiguousAt[args.op]!--;
        return { ok: false, why: 'ambiguous' };
      }
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
      if (args.op === 'focused' && twist.goneAfterKey && (twist.sent?.() ?? []).some((e) => e.type === 'keyDown')) return { ok: false, why: twist.goneWhy ?? 'changed' };
      if (args.op === 'focus' || args.op === 'focused') return { ok: true, ...said, focused: twist.focused ?? true };
      // Where typing went (#112): this field changed, and others (a twist's count) did too.
      if (args.op === 'values') return args.mode === 'compare' ? { ok: true, ...said, changed: !twist.unchanged, has: Boolean(twist.has), others: twist.others ?? 0 } : { ok: true, ...said };
      if (args.op === 'choose') return el.options?.includes(args.option!) ? { ok: true, ...said, choice: args.option } : { ok: false, why: 'no-choice' };
      return { ok: true, ...said };
    }
    if (code.includes('__chordSnapshots')) twist.read?.meanwhile?.(events);
    if (code.includes('__chordSnapshots')) return { url: twist.read?.url ?? twist.at?.url ?? 'https://news.test/a', title: 'Shop', nodes: [...ELEMENTS.map((e, key) => ({ depth: 0, role: e.role, name: e.name, key, sid: key + 1 })), ...(twist.read?.extra ?? [])], cut: twist.read?.cut ?? {} };
    return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
  };
  const result = (out: { text?: string }) => JSON.parse(out.text!) as { data: Record<string, unknown> };

  async function acting(opts: { answer?: Grant | 'hold'; cardWaitMs?: number; sendWaitMs?: number; callDeadlineMs?: number; act?: Partial<ActHost>; onAct?: (events: EventEmitter, op: string) => void; twist?: Twist; onCard?: () => void; deep?: { hit?: unknown; closed?: boolean; picker?: boolean; unavailable?: boolean; posts?: boolean; ping?: boolean; persistent?: boolean; opens?: string[]; postsOnLoad?: boolean; postsTo?: string[] } } = {}) {
    const steps: string[] = [];
    const doings: unknown[] = [];
    const kept: string[] = [];
    const twist: Twist = opts.twist ?? {};
    const t = setup({
      read: page(steps, opts.onAct, twist),
      actions: true,
      answer: opts.answer ?? 'once',
      ...(opts.cardWaitMs ? { cardWaitMs: opts.cardWaitMs } : {}),
      ...(opts.sendWaitMs ? { sendWaitMs: opts.sendWaitMs } : {}),
      ...(opts.callDeadlineMs ? { callDeadlineMs: opts.callDeadlineMs } : {}),
      ...(opts.onCard ? { onCard: opts.onCard } : {}),
      act: { doing: (_n, d) => void doings.push(d), keepSite: (site) => void kept.push(site), ...opts.act },
    });
    const tab = t.scope.refs.refFor('n1');
    await t.call('snapshot', { tab_id: tab });
    const at = t.pages.get('n1')!.at;
    // The snapshot reads where the page is (round 1 of #232, SF4).
    twist.at = at;
    twist.sent ??= () => at.input as { type: string }[];
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

  it('a tab of yours: its lease begins only after the site card, right before the input; the tab leaving the screen meanwhile stops it (Neon’s B5 and B6 on #147)', async () => {
    const order: string[] = [];
    let here: string | null = null;
    const t = await acting({
      onCard: () => void order.push('card'),
      act: { mayAct: () => here, lease: { begin: async () => (order.push('lease'), null), end: () => void order.push('end'), going: () => undefined } },
    });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    expect(order).toEqual(['card', 'lease', 'end']);
    // The tab off screen after the check: nothing goes, though the action had begun.
    order.length = 0;
    const u = await acting({
      onCard: () => void (here = 'The user switched away from that tab. Stop, and tell them what’s left.'),
      act: { mayAct: () => (order.includes('checked') ? here : (order.push('checked'), null)), lease: { begin: async () => (order.push('lease'), null), end: () => void order.push('end'), going: () => undefined } },
    });
    expect(refusal(await u.call('click', { tab_id: u.tab, ref: 'e1' })).refused).toBe('The user switched away from that tab. Stop, and tell them what’s left.');
    expect(u.at.input).toEqual([]);
    expect(order).not.toContain('lease');
    here = null;
  });

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

  it('an element is named by its ref alone (by role and name was dropped from M2g-1): none, nothing pressed', async () => {
    const t = await acting();
    expect(refusal(await t.call('click', { tab_id: t.tab, role: 'link', name: 'Home' })).refused).toBe(ELEMENT_REFUSALS.unknown(''));
    expect(t.at.input).toEqual([]);
  });

  it('the diff’s read never comes from a page that became never-read meanwhile, on the same origin (round 1 of #145, SF7)', async () => {
    const twist: Twist = {};
    const t = await acting({ twist });
    let never: string[] = ['private.test'];
    (t.scope as { neverSites: () => readonly string[] }).neverSites = () => never;
    // The user adds the site to Never while the diff's read is under way.
    twist.read = { meanwhile: () => void (never = ['private.test', 'news.test']) };
    const out = await t.call('hover', { tab_id: t.tab, ref: 'e1' });
    expect(out.text).not.toContain('page_changes');
  });

  it('the diff after an action is read under a read’s rules: never a page that may not be read, another origin, or a read cut short (Neon’s round 1 of M2g-1, B-6)', async () => {
    // [the read the diff takes, what page_changes is]
    const table: [NonNullable<Twist['read']>, unknown][] = [
      [{ url: 'https://private.test/inbox' }, undefined],
      [{ url: 'https://other.test/a' }, undefined],
      // Its page and address are the answer's, said there once (#206).
      [{ cut: { elements: true } }, { note: 'The page is too big to compare all of it: call snapshot to see it.' }],
    ];
    for (const [read, says] of table) {
      const twist: Twist = {};
      const t = await acting({ twist });
      twist.read = read;
      const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
      expect(out.data['page_changes'], JSON.stringify(read)).toEqual(says);
      // Nothing of it kept: the agent's refs are its own snapshot's still.
      twist.read = {};
      expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'], JSON.stringify(read)).toBeUndefined();
    }
  });

  it('a navigation landing while the diff is read: navigated, its refs forgotten, the note, and no diff of the page it left (round 1 of #252, SF-2)', async () => {
    const twist: Twist = {};
    const t = await acting({ twist });
    const before = (JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { page_id: string }).page_id;
    // The page goes to another document as the diff reads it.
    twist.read = { extra: [{ depth: 0, role: 'button', name: 'Open late', key: 9, sid: 10 }], meanwhile: (events) => events.emit('did-navigate') };
    const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
    expect(out.data).toMatchObject({ navigated: true, note: 'The page changed: call snapshot again before using refs from before.' });
    expect(out.data['page_id']).not.toBe(before);
    expect(out.data['page_changes']).toBeUndefined();
    // Its refs went with the page.
    expect(t.scope.memory.elements!.get('n1')!.resolve('e1', out.data['page_id'] as string).ok).toBe(false);
  });

  it('a Never site landing while the diff is read: refused, nothing of where it went, and Stop meanwhile stops it (round 1 of #252, SF-2)', async () => {
    const twist: Twist = {};
    const t = await acting({ twist });
    twist.read = {
      meanwhile: (events) => {
        t.at.url = 'https://private.test/inbox';
        events.emit('did-navigate');
      },
    };
    const out = await t.call('hover', { tab_id: t.tab, ref: 'e1' });
    expect(out.isError).toBe(true);
    expect(refusal(out).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    expect(out.text).not.toContain('private.test');
    // Stop while the diff is read: stopped, not done.
    const stopping: Twist = {};
    const u = await acting({ twist: stopping });
    stopping.read = { meanwhile: () => void u.agent.stop() };
    expect(refusal(await u.call('hover', { tab_id: u.tab, ref: 'e1' })).refused).toBe(CONTROL_REFUSALS.stopped);
  });

  it('an action’s answer says its page and address once: page_changes keeps its own only where they differ (S18 M2g-2, #206)', async () => {
    const NEWS = { depth: 0, role: 'button', name: 'Open late tonight', key: 9, sid: 10 };
    // [what the diff's read is, what page_changes says besides its lines]
    const table: [string, NonNullable<Twist['read']>, Record<string, unknown>][] = [
      ['the same page and address', { extra: [NEWS] }, {}],
      // The page went to another address of the same document (a pushState) as the diff was read: that address is its own.
      ['another address of the same document', { extra: [NEWS], url: 'https://news.test/a#later' }, { url: 'https://news.test/a#later' }],
    ];
    for (const [what, read, own] of table) {
      const twist: Twist = {};
      const t = await acting({ twist });
      twist.read = read;
      const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
      expect(out.data, what).toMatchObject({ page_id: expect.any(String), url: 'https://news.test/a' });
      expect(out.data['page_changes'], what).toEqual({ ...own, lines: ['+ - button "Open late tonight" [ref=e10]'] });
      // Nothing changed: no page_changes at all.
      expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'], what).toBeUndefined();
    }
    // batch's answer: its last step's, the same way.
    const twist: Twist = {};
    const t = await acting({ twist });
    twist.read = { extra: [NEWS] };
    const batched = result(await runBatch(t.scope, t.browser, { tab_id: t.tab, steps: [{ tool: 'hover', ref: 'e1' }, { tool: 'hover', ref: 'e1' }] }, new AbortController().signal));
    expect(batched.data).toMatchObject({ page_id: expect.any(String), url: 'https://news.test/a', page_changes: { lines: ['+ - button "Open late tonight" [ref=e10]'] } });
    expect(Object.keys(batched.data['page_changes'] as object)).toEqual(['lines']);
  });

  it('after an action, what changed since the agent’s last snapshot (M2g-1: the default, never with no snapshot to compare)', async () => {
    const t = await acting();
    // acting() took a snapshot: nothing changed after a hover.
    // Its own envelope (S-4): which page and address it's of, and its lines.
    // Nothing changed: nothing extra at all, so a diff costs nothing then (the planner, round 2 of #145).
    expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes']).toBeUndefined();
    // The page shows a new button: its line, with its ref.
    ELEMENTS.push({ role: 'button', name: 'Raise' });
    try {
      const changes = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'] as { lines: string[] };
      expect(changes.lines).toEqual([`+ - button "Raise" [ref=e${ELEMENTS.length}]`]);
    } finally {
      ELEMENTS.pop();
    }
    // With no snapshot of the page to compare with (it went elsewhere), none: the agent calls snapshot.
    await (t.pages.get('n1')!.contents as unknown as { loadURL(u: string): Promise<void> }).loadURL('https://news.test/c');
    expect(refusal(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).refused).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
  });

  it('Stop while the element is described: nothing after it, not even the pointer’s move (round 2 of #145)', async () => {
    let fired = false;
    const t: Awaited<ReturnType<typeof acting>> = await acting({
      act: { siteAllowed: () => true },
      onAct: (_events, op) => {
        if (op === 'describe' && !fired && t) {
          fired = true;
          t.agent.stop();
        }
      },
    });
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(CONTROL_REFUSALS.stopped);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.steps).not.toContain('point');
    expect(t.at.input).toEqual([]);
  });

  it('the client giving up while read_form waits for the page: stopped, and the form is never read after (round 2 of #145)', async () => {
    const codes: string[] = [];
    const u = setup({ read: async (code: string) => (codes.push(code), { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' }), actions: true });
    u.pages.get('n1')!.at.loading = true;
    const giveUp = new AbortController();
    const reading = u.callUntil('read_form', { tab_id: u.scope.refs.refFor('n1') }, giveUp.signal);
    await new Promise((r) => setTimeout(r, 20));
    const before = codes.length;
    giveUp.abort();
    expect(refusal(await reading).refused).toBe(CONTROL_REFUSALS.stopped);
    await new Promise((r) => setTimeout(r, 50));
    expect(codes.length).toBe(before);
  });

  it('a new page’s ids never give an old ref to its element: they’re numbered above every ref before (round 1 of #145, SF7)', async () => {
    const t = await acting();
    await t.call('snapshot', { tab_id: t.tab });
    // The next page: the fixture's ids start at 1 again (sid key+1), as a new document's do.
    await (t.pages.get('n1')!.contents as unknown as { loadURL(u: string): Promise<void> }).loadURL('https://news.test/c');
    const after = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { content: string };
    expect(after.content).not.toContain('[ref=e1]');
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ELEMENT_REFUSALS.stale);
    expect(t.at.input).toEqual([]);
  });

  it('a late Allow is for the row it was asked in: the same ref, its node now in another unnamed row, asks again (#268’s review, B1)', async () => {
    let row = '["Order A"]';
    const t = await acting({ answer: 'hold', cardWaitMs: 30, act: { siteAllowed: () => true }, twist: { place: () => ({ items: '[]', path: '[]', row }) } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.waiting);
    // Allowed late, for Order A's row; the page then patches the node into Order B's.
    t.holds.at(-1)!('once');
    await new Promise((r) => setTimeout(r, 0));
    row = '["Order B"]';
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.waiting);
    expect(t.cards.filter((c) => c.kind === 'step')).toHaveLength(2);
    expect(t.at.text).toEqual([]);
    // In the row it was asked in, the late Allow is taken (the control): it types.
    const u = await acting({ answer: 'hold', cardWaitMs: 30, act: { siteAllowed: () => true }, twist: { place: () => ({ items: '[]', path: '[]', row: '["Order A"]' }) } });
    expect(refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.waiting);
    u.holds.at(-1)!('once');
    await new Promise((r) => setTimeout(r, 0));
    expect(result(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool', submit: true })).data['done']).toBeDefined();
    expect(u.at.text).toEqual(['wool']);
  });

  it('a late Allow is spent by another action on the tab: the step asks again, never runs on it (round 1 of #145, SF7)', async () => {
    const t = await acting({ answer: 'hold', cardWaitMs: 30, act: { siteAllowed: () => true } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.waiting);
    // The user allows it late; then the agent hovers (another action), and asks the step again.
    t.holds.at(-1)!('once');
    await new Promise((r) => setTimeout(r, 0));
    await t.call('hover', { tab_id: t.tab, ref: 'e1' });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'wool', submit: true })).refused).toBe(CONTROL_REFUSALS.waiting);
    expect(t.cards.filter((c) => c.kind === 'step')).toHaveLength(2);
    expect(t.at.text).toEqual([]);
  });

  it('no diff against a snapshot that was cut short: what it didn’t reach would show as new (round 1 of #145)', async () => {
    const twist: Twist = {};
    twist.read = { cut: { time: true } };
    const t = await acting({ twist });
    twist.read = {};
    expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes']).toMatchObject({ note: 'Your last snapshot of this page was cut short, so what changed can’t be told: call snapshot to see it.' });
  });

  it('a second diff says only what changed since the first, never the first again (round 2 of #145: rebase)', async () => {
    const t = await acting();
    ELEMENTS.push({ role: 'button', name: 'Raise' });
    try {
      expect((result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'] as { lines: string[] }).lines).toHaveLength(1);
      expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes']).toBeUndefined();
    } finally {
      ELEMENTS.pop();
    }
  });

  it('a call held on a paused tab ends when the client gives up, through the tools too, and never runs after (round 2 of #145)', async () => {
    const t = await acting({ act: { siteAllowed: () => true } });
    t.agent.pause('n1', true);
    const giveUp = new AbortController();
    const held = t.callUntil('click', { tab_id: t.tab, ref: 'e1' }, giveUp.signal);
    await new Promise((r) => setTimeout(r, 20));
    giveUp.abort();
    expect(refusal(await held).refused).toBe(CONTROL_REFUSALS.stopped);
    t.agent.pause('n1', false);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.at.input).toEqual([]);
  });

  it('a snapshot taken while the diff’s read was out wins: the diff gives nothing, and never rebases on top of it (round 2 of #145)', async () => {
    const twist: Twist = {};
    const t = await acting({ twist });
    const pageId = (JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { page_id: string }).page_id;
    const refs = t.scope.memory.elements!.get('n1')!;
    ELEMENTS.push({ role: 'button', name: 'Raise' });
    try {
      // Meanwhile the agent's own snapshot lands (its outline replaces the one the diff compares with).
      twist.read = { meanwhile: () => { twist.read = {}; refs.remember({ ...refs.outline(pageId)!, retrievedAt: 1 }); } };
      const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
      expect(out.data['page_changes']).toBeUndefined();
      expect(refs.outline(pageId)!.retrievedAt).toBe(1);
    } finally {
      ELEMENTS.pop();
    }
  });

  it('a diff too big to show is never committed: the agent’s refs and the next diff’s baseline stay its last snapshot’s (round 1 of #145, B1a)', async () => {
    const t = await acting();
    // The agent's own snapshot, and the token its e1 resolves to.
    const looked = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { page_id: string };
    const own = t.scope.memory.elements!.get('n1')!.resolve('e1', looked.page_id);
    const extra = Array.from({ length: 70 }, (_, i) => ({ role: 'button', name: `More ${i}` }));
    ELEMENTS.push(...extra);
    try {
      const first = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'] as { changed?: number; lines?: string[] };
      expect(first).toMatchObject({ changed: 70, note: 'Much of the page changed: call snapshot to see it.' });
      // Not seen, so not taken as seen: the next diff still compares with the agent's snapshot (before: lines: []).
      const second = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes'] as { changed?: number; lines?: string[] };
      expect(second).toMatchObject({ changed: 70 });
      // And the agent's refs resolve in its own snapshot, never in the unseen one.
      const pageId = (result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_id']) as string;
      expect(t.scope.memory.elements!.get('n1')!.resolve('e1', pageId)).toMatchObject({ ok: true, token: (own as { token: string }).token });
    } finally {
      ELEMENTS.splice(ELEMENTS.length - extra.length, extra.length);
    }
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
    // A new snapshot: an element still there keeps its ref (M2g-1); once the page went elsewhere, every ref is stale.
    await t.call('snapshot', { tab_id: t.tab });
    expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data['done']).toBe('Clicked “Home”');
    await (t.pages.get('n1')!.contents as unknown as { loadURL(u: string): Promise<void> }).loadURL('https://news.test/b');
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
    // And the click watched for before its checks and seen before the select; Enter's keydown seen before its check
    // (round 5 of #117: deleting a wait fails here).
    expect(t.steps).toEqual(['describe', 'describe', 'point', 'watchPress', 'hit', 'describe', 'pressSeen', 'select', 'guard', 'focused', 'values', 'unguard', 'values', 'describe', 'guard', 'focused', 'seen', 'focused', 'unguard']);
    expect(t.at.text).toEqual(['wool scarf']);
    expect((t.at.input as { type: string; keyCode?: string }[]).map((e) => `${e.type}${e.keyCode ? `:${e.keyCode}` : ''}`)).toEqual(['mouseMove', 'mouseDown', 'mouseUp', 'keyDown:Return', 'char:\r', 'keyUp:Return']);
    // replace: false keeps what's there.
    t.steps.length = 0;
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: ' red', replace: false });
    expect(t.steps).toEqual(['describe', 'point', 'watchPress', 'hit', 'describe', 'pressSeen', 'guard', 'focused', 'values', 'unguard', 'values']);
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
    ['click', 'a look-alike in its place under the point (#211)', { hit: { ok: false, why: 'ambiguous' } }, ACT_REFUSALS.ambiguousPlain],
    ['click', 'the debugger taken (DevTools busy)', { unavailable: true }, 'Chord couldn’t check that page right now (is its DevTools window busy?). The step may have gone in: call snapshot before you try it again.'],
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
      // Its keydown went through (the guard says so): only then is Enter that moved the focus done (B2 of round 5).
      twist.keydownPassed ??= true;
      const out = await t.call('press_key', { tab_id: t.tab, ref: 'e2', key });
      return { out, keys: (t.at.input as { type: string }[]).map((e) => e.type) };
    };
    const enter = await run('Enter');
    expect(result(enter.out).data).toMatchObject({ done: 'Pressed Enter in “Search”', focus: 'The page moved the focus away from that field after Enter. Enter was pressed once: call snapshot to see what it did, and don’t press it again.' });
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
    expect(refusal((await run('Enter', { moved: true, keydownPassed: false })).out).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
  });

  it('Enter’s keydown went through and the rest was stopped (the page took the focus after the check): done once, said so; any other key, a no (the review of #117, round 5)', async () => {
    const enter = await acting({ twist: { moved: true, keydownPassed: true } });
    expect(result(await enter.call('press_key', { tab_id: enter.tab, ref: 'e2', key: 'Enter' })).data).toMatchObject({ done: 'Pressed Enter in “Search”', focus: 'The page moved the focus away from that field after Enter. Enter was pressed once: call snapshot to see what it did, and don’t press it again.' });
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
    // Gone, a look-alike now in its place (#211's review: the reason, never one refusal's words, decides), or its row
    // saying nothing now (#273's round 3).
    for (const goneWhy of ['changed', 'ambiguous', 'row-empty'] as const) {
      const twist: Twist = { goneAfterKey: true, goneWhy };
      const t = await acting({ twist });
      twist.sent = () => t.at.input as { type: string }[];
      expect(refusal(await t.call('press_key', { tab_id: t.tab, ref: 'e1', key: 'Enter' })).refused, goneWhy).toBe('The page redrew that element while the key went in, so it may not have worked. Call snapshot and check before pressing it again.');
      // Its keydown, then only the key let go of; once.
      expect((t.at.input as { type: string }[]).map((e) => e.type), goneWhy).toEqual(['keyDown', 'keyUp']);
    }
  });

  it('a look-alike in its place after input went in: never “nothing was done”, said it may not have worked (#211’s round 2)', async () => {
    // Enter in a field (a comment box that sends on Enter, then redraws): its keydown went in.
    const twist: Twist = { goneAfterKey: true, goneWhy: 'ambiguous' };
    const t = await acting({ twist });
    twist.sent = () => t.at.input as { type: string }[];
    const keyed = refusal(await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Enter' })).refused;
    expect((t.at.input as { type: string }[]).map((e) => e.type)).toContain('keyDown');
    expect(keyed).toBe(INPUT_REDRAWN);
    // Typed text, then where it went answered by a look-alike: the text went in.
    const u = await acting({ twist: { ambiguousCompare: true } });
    const typed = refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'wool' })).refused;
    expect(u.at.text).toEqual(['wool']);
    expect(typed).toBe(INPUT_REDRAWN);
    // The same when where it went is answered by a row that says nothing now (#273's round 3).
    const w = await acting({ twist: { compareWhy: 'row-empty' } });
    expect(refusal(await w.call('type', { tab_id: w.tab, ref: 'e2', text: 'wool' })).refused).toBe(INPUT_REDRAWN);
    expect(w.at.text).toEqual(['wool']);
    // A value set (a time field: never clicked), then where it went answered by a look-alike: the value went in.
    ELEMENTS.push({ role: 'textbox', name: 'Delivery time', editable: true, field: field({ type: 'time' }), risk: { tag: 'input', type: 'time' } });
    try {
      const v = await acting({ twist: { ambiguousCompare: true } });
      expect(refusal(await v.call('type', { tab_id: v.tab, ref: `e${ELEMENTS.length}`, text: '18:30' })).refused).toBe(INPUT_REDRAWN);
      expect(v.steps).toContain('setValue');
      expect((v.at.input as { type: string }[]).filter((e) => e.type === 'mouseDown')).toEqual([]);
    } finally {
      ELEMENTS.pop();
    }
  });

  it('a look-alike redrawn before a key went in (nothing sent): as a node gone, found again and checked again by the retry (#211’s review)', async () => {
    const t = await acting({ twist: { ambiguousAt: { focused: 1 } } });
    expect(result(await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Tab' })).data['done']).toBe('Pressed Tab in “Search”');
    expect(t.steps.filter((x) => x === 'guard')).toHaveLength(2);
  });

  it('round 5 of #117 (Claude and Neon): a lost input is never tried again; Enter is done only if its keydown went through; tries end on Stop or a step that changed', async () => {
    const guards = (t: { steps: string[] }) => t.steps.filter((x) => x === 'guard').length;
    // B1: lost (its last event never came, maybe still on its way): never tried again, for any key.
    for (const [key, twist] of [
      ['Enter', { moved: true, lost: true, multiline: true }],
      ['Space', { moved: true, lost: true }],
      ['Enter', { moved: true, lost: true }],
    ] as [string, Twist][]) {
      const t = await acting({ twist });
      expect(refusal(await t.call('press_key', { tab_id: t.tab, ref: 'e2', key })).refused, key).toBeTruthy();
      expect(guards(t), `${key} ${JSON.stringify(twist)}`).toBe(1);
    }
    // B2: Enter whose keydown didn't go through (the focus moved, its keyup never came): a no, as lost, never done.
    const held: { t?: Awaited<ReturnType<typeof acting>> } = {};
    const notThrough: Twist = { lost: true, keydownPassed: false };
    const b2 = (held.t = await acting({
      twist: notThrough,
      onAct: (_e, op) => {
        const sent = (held.t?.at.input ?? []) as { type: string }[];
        if (op === 'focus') notThrough.focused = true;
        if (op === 'focused' && sent.some((e) => e.type === 'keyDown')) notThrough.focused = false;
      },
    }));
    expect(refusal(await b2.call('press_key', { tab_id: b2.tab, ref: 'e2', key: 'Enter' })).refused).toBe('The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.');
    // A clean second try: Enter stopped whole once, then it goes.
    const again = await acting({ twist: { movedTimes: 1 } });
    expect(result(await again.call('press_key', { tab_id: again.tab, ref: 'e2', key: 'Enter' })).data['done']).toBe('Pressed Enter in “Search”');
    expect(guards(again)).toBe(2);
    // Stop between tries: no second.
    let stop = () => undefined as void;
    let focuses = 0;
    const stopped = await acting({ twist: { movedTimes: 1 }, onAct: (_e, op) => void (op === 'focus' && ++focuses === 2 && stop()) });
    stop = () => stopped.agent.stop();
    expect(refusal(await stopped.call('press_key', { tab_id: stopped.tab, ref: 'e2', key: 'Tab' })).refused).toBe(CONTROL_REFUSALS.stopped);
    expect(guards(stopped)).toBe(1);
    // The field turned into a password field between tries: no second.
    const turning: Twist = { movedTimes: 1 };
    const sensitive = await acting({ twist: turning, onAct: (_e, op) => void (op === 'unguard' && (turning.field = field({ type: 'password' }))) });
    expect(refusal(await sensitive.call('press_key', { tab_id: sensitive.tab, ref: 'e2', key: 'Tab' })).refused).toBe('That field is now a password, code or card field: the user fills it. Ask them to.');
    expect(guards(sensitive)).toBe(1);
    // Text added to what's there (replace: false): never tried again (the caret could be elsewhere).
    const adding = await acting({ twist: { movedTimes: 1 } });
    expect(refusal(await adding.call('type', { tab_id: adding.tab, ref: 'e2', text: ' red', replace: false })).refused).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(guards(adding)).toBe(1);
    // The element replaced before anything was sent (its focus check says changed): found again, and it goes.
    let checks = 0;
    const replacedOnce: Twist = {};
    const redrawn = await acting({ twist: replacedOnce, onAct: (_e, op) => void (op === 'focused' && ++checks === 1 && (replacedOnce.replaced = { focused: 1 })) });
    expect(result(await redrawn.call('press_key', { tab_id: redrawn.tab, ref: 'e2', key: 'Tab' })).data['done']).toBe('Pressed Tab in “Search”');
    expect(guards(redrawn)).toBe(2);
    // A click the page never saw: nothing typed, nothing selected.
    const unseen = await acting({ twist: { pressUnseen: true } });
    expect(refusal(await unseen.call('type', { tab_id: unseen.tab, ref: 'e2', text: 'wool' })).refused).toBe('That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.');
    expect(unseen.steps).not.toContain('select');
    expect(unseen.at.text).toEqual([]);
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

  it('a page of yours closed during the action is never still shown: the focus goes to the page the window shows (#322’s B1)', () => {
    const win = {};
    const page = (destroyed: boolean) => ({ isDestroyed: () => destroyed });
    const yours = page(true);
    const shown = page(false);
    const window = { seen: (p: unknown) => p === yours, page: () => shown };
    const now = shownFor(yours, window);
    expect(now).toEqual({ stillShown: false, page: shown });
    expect(focusToGiveBack({ page: yours, window: win }, { page: null, window: win }, page(false), now)).toBe(shown);
    // Not closed, still shown: back to it.
    const open = page(false);
    expect(shownFor(open, { seen: (p) => p === open, page: () => shown }).stillShown).toBe(true);
    // A window that isn't a Chord window (nothing registered): as before.
    expect(shownFor(open, null)).toEqual({ stillShown: true, page: null });
  });

  it('focus never goes back to a page no longer shown, nor stays on the hidden agent’s tab (#115, B2)', () => {
    const win = {};
    // [what, the page that had it still shown, the focus now, where it goes]: the window's shown page is 'shown'.
    const rows: [string, boolean, string | null, string | null][] = [
      ['still shown, the agent’s page took it', true, 'agent', 'yours'],
      ['still shown, no page has it', true, null, 'yours'],
      ['you switched tabs meanwhile; the agent’s page took it: the page you see, never the agent’s', false, 'agent', 'shown'],
      ['you switched tabs meanwhile; no page has it: the page you see', false, null, 'shown'],
      ['you switched tabs, and your new page has it: left there', false, 'another', null],
    ];
    for (const [what, stillShown, now, back] of rows) {
      expect(focusToGiveBack({ page: 'yours', window: win }, { page: now, window: win }, 'agent', { stillShown, page: 'shown' }), what).toBe(back);
    }
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

  it.each([
    ['navigate', { url: 'https://news.test/b' }, ACT_REFUSALS.overtaken],
    ['back', {}, ACT_REFUSALS.backMoved],
  ] as const)('%s overtaken while it waited for the session (round 1 of #333, Opus’s N4): refused in its own words, nothing loaded', async (tool, args, refused) => {
    const t = await acting();
    // Somewhere to go back to.
    t.at.history = [{ url: 'https://news.test/before' }, { url: t.at.url }];
    t.at.active = 1;
    // The tab's gate: another load replaced this one before the session was ready.
    (t.browser.tabs as { queueLoad: unknown }).queueLoad = (_c: unknown, _load: unknown, overtaken?: () => void) => overtaken?.();
    expect(refusal(await t.call(tool, { tab_id: t.tab, ...args })).refused).toBe(refused);
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

  // #115's SF1, pinned (#322's B3): the card's signal aborts, and a late answer never lets what was held go.
  async function heldBetweenActions() {
    const t = await acting();
    const contents = t.pages.get('n1')!.contents;
    let signal: AbortSignal | null = null;
    let answer: (a: SendAnswer) => void = () => undefined;
    sendHoldDeps(contents, { whose: () => 'agent', ask: (_sites, _why, s) => ((signal = s), new Promise<SendAnswer>((done) => (answer = done))), siteOf: (u) => new URL(u).host });
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'k1', request: { method: 'POST', url: 'https://news.test/keepalive' }, resourceType: 'XHR' });
    await new Promise((r) => setTimeout(r, 0));
    expect(signal, JSON.stringify(t.at.debugging.slice(-6))).not.toBeNull();
    const continuedK1 = () => (t.at.commands ?? []).some(([m, p]) => m === 'Fetch.continueRequest' && (p as { requestId?: string }).requestId === 'k1');
    return { t, signal: () => signal!, answer: (a: SendAnswer) => answer(a), continuedK1 };
  }

  it('the debugger let go (a detach) with a send held between actions: its card comes down; a late Allow never lets it go (#115, SF1)', async () => {
    const h = await heldBetweenActions();
    h.t.at.emitDetach!();
    expect(h.signal().aborted, 'the card comes down').toBe(true);
    h.answer('once');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.continuedK1()).toBe(false);
  });

  it('the page’s renderer gone (a crash) with a send held between actions: what it held is failed, its card comes down; a late Allow never lets it go (#115, SF1)', async () => {
    const h = await heldBetweenActions();
    const failed = h.t.at.debugging.filter((m) => m === 'Fetch.failRequest').length;
    h.t.at.crash!();
    expect(h.signal().aborted, 'the card comes down').toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.t.at.debugging.filter((m) => m === 'Fetch.failRequest').length).toBe(failed + 1);
    h.answer('once');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.continuedK1()).toBe(false);
  });

  it('the page’s renderer gone (a crash) during an action: the action is cancelled, what it held failed; a late Allow and its end let nothing go (#115, SF1)', async () => {
    const t = await acting();
    const contents = t.pages.get('n1')!.contents;
    let asked = 0;
    sendHoldDeps(contents, { whose: () => 'agent', ask: () => (asked++, new Promise<SendAnswer>(() => undefined)), siteOf: (u) => new URL(u).origin });
    const watch = (await import('../../src/main/control/sends')).watchSends(contents, null)!;
    t.at.emitDebug!('Fetch.requestPaused', { requestId: 'k2', request: { method: 'POST', url: 'https://news.test/keepalive' }, resourceType: 'XHR' });
    await new Promise((r) => setTimeout(r, 0));
    expect(watch.held()).toHaveLength(1);
    const failed = t.at.debugging.filter((m) => m === 'Fetch.failRequest').length;
    t.at.crash!();
    expect(watch.cancelled.aborted).toBe(true);
    expect(watch.held()).toEqual([]);
    watch.allow({ origins: new Set(['https://news.test']) });
    watch.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.at.debugging.filter((m) => m === 'Fetch.failRequest').length).toBe(failed + 1);
    expect((t.at.commands ?? []).some(([m, p]) => m === 'Fetch.continueRequest' && (p as { requestId?: string }).requestId === 'k2')).toBe(false);
    expect(asked, 'nothing carried over to a card between actions').toBe(0);
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

    it('you take over a tab no window shows while its action’s send card is up: the action hears so, never done (Claude’s review 2 of #116)', async () => {
      // A tab no window shows isn't paused when you take it over (its row menu's Reload): its cards are let go of.
      const t: Awaited<ReturnType<typeof acting>> = await acting({ deep: { posts: true }, answer: 'hold', act: { siteAllowed: () => true }, onCard: () => void queueMicrotask(() => t.agent.cancelCardsFor('n1')) });
      expect(t.agent.state('n1').paused).toBe(false);
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.takenOver);
      expect(t.at.debugging).not.toContain('Fetch.continueRequest');
    });

    it('the lease lost while its send card was up (a detach, the renderer gone): Allow lets nothing go, and the action isn’t done (Neon’s B5, round 2 of #147)', async () => {
      const box: { contents?: object } = {};
      const t = await acting({ deep: { posts: true }, act: { siteAllowed: () => true }, onCard: () => void (box.contents && leaseLost.add(box.contents)) });
      box.contents = t.pages.get('n1')!.contents;
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.noCheck);
      expect(t.at.debugging).not.toContain('Fetch.continueRequest');
    });

    it('a tab of yours interrupted during a Send data card: that action refused, the next one in that tab goes (its new lease clears the old loss) (round 3 of #147)', async () => {
      const box: { contents?: object } = {};
      const lease = { begin: async () => (box.contents && leaseLost.delete(box.contents), null), end: () => undefined, going: () => undefined };
      const t = await acting({ deep: { posts: true }, act: { siteAllowed: () => true, lease }, onCard: () => void (box.contents && leaseLost.add(box.contents)) });
      box.contents = t.pages.get('n1')!.contents;
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.noCheck);
      t.at.deep = {};
      expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
    });

    it('an outside agent’s tab whose hold was lost gets it back by trying again, before anything refuses it (round 3 of #147)', async () => {
      const t = await acting();
      pickers.lost.add(t.pages.get('n1')!.contents);
      pickers.retries = 0;
      expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ done: 'Clicked “Home”' });
      expect(pickers.retries).toBeGreaterThan(0);
    });

    it('the lease lost right before the input: select_option chooses nothing, a date field’s value isn’t set, a click with no card isn’t done, a load isn’t done (Neon’s S3, round 3 of #147)', async () => {
      const box: { contents?: object } = {};
      const loseAt = (op: string, nth: number) => (_events: EventEmitter, at: string) => {
        if (at === op && --nth === 0 && box.contents) leaseLost.add(box.contents);
      };
      // select_option: lost at its check right before choosing.
      const s1 = await acting({ onAct: loseAt('describe', 2), act: { siteAllowed: () => true } });
      box.contents = s1.pages.get('n1')!.contents;
      expect(refusal(await s1.call('select_option', { tab_id: s1.tab, ref: 'e3', option: 'Express' })).refused).toBe(ACT_REFUSALS.noCheck);
      expect(s1.steps).not.toContain('choose');
      leaseLost.delete(box.contents);
      // A date field (set to its value, never typed): lost the same way.
      ELEMENTS.push({ role: 'textbox', name: 'Birthday', editable: true, risk: { tag: 'input', type: 'date' } });
      try {
        const s2 = await acting({ onAct: loseAt('describe', 2), act: { siteAllowed: () => true } });
        box.contents = s2.pages.get('n1')!.contents;
        expect(refusal(await s2.call('type', { tab_id: s2.tab, ref: `e${ELEMENTS.length}`, text: '1987-02-17' })).refused).toBe(ACT_REFUSALS.noCheck);
        expect(s2.steps).not.toContain('setValue');
        leaseLost.delete(box.contents);
      } finally {
        ELEMENTS.pop();
      }
      // A click with no card: lost as the page settles after it. It went in; it isn't done.
      const s3 = await acting({ onAct: loseAt('settle', 1), act: { siteAllowed: () => true } });
      box.contents = s3.pages.get('n1')!.contents;
      expect(refusal(await s3.call('click', { tab_id: s3.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.noCheck);
      leaseLost.delete(box.contents);
      // A load: lost while it loads.
      const lease = { begin: async () => (queueMicrotask(() => box.contents && leaseLost.add(box.contents)), null), end: () => undefined, going: () => undefined };
      const s4 = await acting({ act: { siteAllowed: () => true, lease } });
      box.contents = s4.pages.get('n1')!.contents;
      expect(refusal(await s4.call('navigate', { tab_id: s4.tab, url: 'https://news.test/b' })).refused).toBe(ACT_REFUSALS.noCheck);
      leaseLost.delete(box.contents);
    });

    it('what the page’s response to an action was caught doing (a dialog, a picker, unload) goes in the next result, so the model never says done when the page said no (Claude’s S1, round 2 of #150)', async () => {
      const caught = ['The page showed a dialog (confirm: “Delete?”); it was answered Cancel'];
      const t = await acting({ act: { siteAllowed: () => true, caught: () => caught.splice(0) } });
      expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data).toMatchObject({ caught: ['The page showed a dialog (confirm: “Delete?”); it was answered Cancel'] });
      expect(result(await t.call('click', { tab_id: t.tab, ref: 'e1' })).data['caught']).toBeUndefined();
    });

    it('a send card no one answers in an action comes down (Neon’s S11): no card left at the head of the queue', async () => {
      const t = await acting({ deep: { posts: true }, answer: 'hold', cardWaitMs: 30, act: { siteAllowed: () => true } });
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe('The user didn’t answer in time, so what the page was sending was dropped. Ask the user, then do that step again.');
      await new Promise((r) => setTimeout(r, 0));
      expect(t.agent.state('n1').cards).toEqual([]);
    });

    it('a Send data card waits its own full wait, never a call’s budget for cards, for an action and for navigate (Neon’s review of M2g-1, B2; round 1, B-5)', async () => {
      // An action's (fake timers: invariant 9, S-6): not answered by the call's 30 ms, answered at its own 400.
      const t = await acting({ deep: { posts: true }, answer: 'hold', cardWaitMs: 30, sendWaitMs: 400, act: { siteAllowed: () => true } });
      vi.useFakeTimers();
      let settled = false;
      const done = t.call('click', { tab_id: t.tab, ref: 'e1' }).finally(() => void (settled = true));
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(refusal(await done).refused).toBe(ACT_REFUSALS.sendsDropped);
      vi.useRealTimers();
      // navigate's, the same.
      const u = await acting({ deep: { postsOnLoad: true }, answer: 'hold', cardWaitMs: 30, sendWaitMs: 400, act: { siteAllowed: () => true } });
      vi.useFakeTimers();
      settled = false;
      const went = u.call('navigate', { tab_id: u.tab, url: 'https://news.test/b' }).finally(() => void (settled = true));
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(refusal(await went).refused).toBe(ACT_REFUSALS.sendsDropped);
      expect(u.cards.filter((c) => c.step?.why === 'send')).toHaveLength(1);
      // Its subject a JSON tuple (N-5).
      expect(JSON.parse(u.cards.find((c) => c.step?.why === 'send')!.subject)).toEqual(['n1', 'navigate', 'sends', expect.stringMatching(/^[0-9a-f]{8}$/)]);
    });

    // #143, on fake timers in real seconds: a client that gives up at 60 s (Codex's default), the call's deadline 50 s
    // (CALL_WAIT_MS), a Send data card that waits 90 s (its own sendWaitMs). Each failed on the code before HandedOver.
    describe('#143: a Send data card past the call’s deadline (HandedOver)', () => {
      const STEP = 'Clicked “Home”';
      /** A click whose page posts, its card held, the call answered by the client's 60 s. */
      async function handedOver(opts: { postsTo?: string[] } = {}) {
        const t = await acting({ deep: opts.postsTo ? { postsTo: opts.postsTo } : { posts: true }, answer: 'hold', cardWaitMs: 50_000, sendWaitMs: 90_000, callDeadlineMs: 50_000, act: { siteAllowed: () => true } });
        vi.useFakeTimers();
        let out: { text?: string; isError?: boolean } | undefined;
        void t.call('click', { tab_id: t.tab, ref: 'e1' }).then((o) => void (out = o));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(out, 'the call answered before the client’s 60 s').toBeDefined();
        const sendCards = () => t.cards.filter((c) => c.step?.why === 'send');
        const dropped = () => t.at.debugging.some((m: string) => m === 'Fetch.failRequest' || m === 'Fetch.fulfillRequest');
        const later = () => (t.scope.memory.later ?? []).map((l) => l.entry);
        return { t, out: out!, sendCards, dropped, later };
      }
      afterEach(() => void vi.useRealTimers());

      it('the call answers by its deadline: the step ran (not an error), what it sent waits; the card stays; another action there is refused; Allow sends it, once, and the next result says so', async () => {
        const { t, out, sendCards, later } = await handedOver();
        expect(out.isError).toBeFalsy();
        expect(JSON.parse(out.text!).data).toMatchObject({ done: STEP, sending: ACT_SENDS_WAITING, loading: true });
        expect(sendCards()).toHaveLength(1);
        expect(t.at.debugging).not.toContain('Fetch.continueRequest');
        expect(t.scope.memory.sendsWaiting?.has('n1')).toBe(true);
        expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.sendsPending);
        expect(later()).toEqual([]);
        t.holds.at(-1)!('once');
        await vi.advanceTimersByTimeAsync(0);
        expect(t.at.debugging).toContain('Fetch.continueRequest');
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'allowed', true)]);
        expect(later()[0]!.why).toBe('The step ran, and what it sent went: the user allowed it.');
        expect(t.scope.memory.sendsWaiting?.size).toBe(0);
        expect((t.at.input as { type: string }[]).filter((e) => e.type === 'mouseDown')).toHaveLength(1);
      });

      it('never answered: held until the card’s own wait, never before; then dropped, the card down, and “the user didn’t answer in time”', async () => {
        const { t, sendCards, dropped, later } = await handedOver();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(sendCards()).toHaveLength(1);
        expect(dropped()).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(dropped()).toBe(true);
        expect(t.agent.state('n1').cards).toEqual([]);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'no-answer', false)]);
        expect(later()[0]!.why).toBe('The step ran; what it sent didn’t go: the user didn’t answer in time.');
      });

      it('Don’t: dropped, and “the user said no”', async () => {
        const { t, dropped, later } = await handedOver();
        t.holds.at(-1)!('deny');
        await vi.advanceTimersByTimeAsync(0);
        expect(dropped()).toBe(true);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'no', false)]);
      });

      it('the tab closed while it waits (the live store, never the TabNode taken before): never “went”, the card down (Neon’s B1)', async () => {
        const { t, dropped, later } = await handedOver();
        t.close('n1');
        t.at.destroy!();
        await vi.advanceTimersByTimeAsync(0);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'closed', false)]);
        expect(dropped()).toBe(true);
        expect(t.agent.state('n1').cards).toEqual([]);
        // An Allow on the card after that sends nothing.
        t.holds.at(-1)!('once');
        await vi.advanceTimersByTimeAsync(0);
        expect(t.at.debugging).not.toContain('Fetch.continueRequest');
      });

      it('its session over while it waits (Keep, the agent gone: failHeld): never “went” (Neon’s B1)', async () => {
        const { t, later } = await handedOver();
        failHeld(t.pages.get('n1')!.contents);
        await vi.advanceTimersByTimeAsync(0);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'ended', false)]);
        expect(t.at.debugging).not.toContain('Fetch.continueRequest');
      });

      it('Stop while it waits: dropped, and “the user pressed Stop”', async () => {
        const { t, dropped, later } = await handedOver();
        t.agent.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(dropped()).toBe(true);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'stopped', false)]);
      });

      it('the page goes to another document while it waits (a GET navigation of its own): the card comes down at once, dropped, “the page moved on” (Neon’s SF3)', async () => {
        const { t, dropped, later } = await handedOver();
        t.at.navigate!('https://news.test/elsewhere');
        await vi.advanceTimersByTimeAsync(0);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'moved-on', false)]);
        expect(dropped()).toBe(true);
        expect(t.agent.state('n1').cards).toEqual([]);
      });

      it('three sites in one action: the first card’s Allow, the second’s Don’t: “some went, the rest didn’t” (Neon’s SF2)', async () => {
        const { t, later } = await handedOver({ postsTo: ['https://a.test/1', 'https://b.test/2', 'https://c.test/3'] });
        t.holds.at(-1)!('once');
        await vi.advanceTimersByTimeAsync(0);
        expect(later()).toEqual([]);
        t.holds.at(-1)!('deny');
        await vi.advanceTimersByTimeAsync(0);
        expect(later()).toEqual([sendsLater(t.tab, 'click', STEP, 'no', true)]);
        expect(later()[0]!.why).toBe('The step ran; some of what it sent went, the rest didn’t: the user said no.');
      });

      it('a batch whose step hands over stops there: done, sending and stopped_after, never the next step into sendsPending (Neon’s B2, Opus’s S1)', async () => {
        const t = await acting({ deep: { posts: true }, answer: 'hold', cardWaitMs: 50_000, sendWaitMs: 90_000, callDeadlineMs: 50_000, act: { siteAllowed: () => true } });
        vi.useFakeTimers();
        let out: { text?: string; isError?: boolean } | undefined;
        void runBatch(t.scope, t.browser, { tab_id: t.tab, steps: [{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: 'e1' }] }, new AbortController().signal).then((o) => void (out = o));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(out).toBeDefined();
        expect(out!.isError).toBeFalsy();
        expect(JSON.parse(out!.text!).data).toMatchObject({ done: [STEP], sending: ACT_SENDS_WAITING, stopped_after: 1 });
        expect((t.at.input as { type: string }[]).filter((e) => e.type === 'mouseDown')).toHaveLength(1);
      });

      it('navigate past its deadline: under way (loading), never an outline, its card on; Stop at the hand-over never hands over (Neon’s B4, Opus’s N2)', async () => {
        const t = await acting({ deep: { postsOnLoad: true }, answer: 'hold', cardWaitMs: 50_000, sendWaitMs: 90_000, callDeadlineMs: 50_000, act: { siteAllowed: () => true } });
        vi.useFakeTimers();
        let out: { text?: string; isError?: boolean } | undefined;
        void t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b' }).then((o) => void (out = o));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(out).toBeDefined();
        expect(JSON.parse(out!.text!).data).toMatchObject({ done: 'Going to news.test/b', loading: true, sending: ACT_SENDS_WAITING });
        // With snapshot: true, no outline (and no wait for one).
        let looked = false;
        const withIt = await withOutline(out!, 'navigate', async () => ((looked = true), { text: '{}' }));
        expect(looked).toBe(false);
        expect(withIt).toBe(out);
      });

      it('no card up at the deadline: answered as before, nothing said to wait, the tab free', async () => {
        const t = await acting({ callDeadlineMs: 1, act: { siteAllowed: () => true } });
        const out = await t.call('click', { tab_id: t.tab, ref: 'e1' });
        expect(out.isError).toBeFalsy();
        expect(JSON.parse(out.text!).data).not.toHaveProperty('sending');
        expect(t.scope.memory.sendsWaiting?.size).toBe(0);
        expect((await t.call('click', { tab_id: t.tab, ref: 'e1' })).isError).toBeFalsy();
      });

      it('a card answered at once (a call already stopped, a grant) is never “up”: no hand-over with no card (Neon’s B5)', async () => {
        const agent = new ControlAgent('t', async () => 'once');
        const cards = new OpenCards(agent, 'n1');
        const ask = cards.ask(async () => 'deny' as const);
        const answered = ask();
        expect(cards.isUp()).toBe(false);
        await answered;
        expect(cards.isUp()).toBe(false);
      });

      it('a call’s own answer never carries its outcome beside its *waits*: takeLater keeps that call’s, takes the rest', () => {
        const mine = {};
        const memory = { pdfs: new Map(), form: null, nextField: 1, read: new Set<NodeId>(), later: [{ from: mine, entry: sendsLater('a1', 'click', 'x', 'allowed', true) }, { from: {}, entry: sendsLater('a2', 'click', 'y', 'no', false) }] } as ToolMemory;
        expect(takeLater(memory, mine).map((e) => e.tab_id)).toEqual(['a2']);
        expect(takeLater(memory, {}).map((e) => e.tab_id)).toEqual(['a1']);
        expect(memory.later).toEqual([]);
      });

      // Round 2 of #266 (Neon, Opus). Each fails at 86d013b, or with its fix taken out.
      describe('round 2', () => {
        /** A step whose page posts, its card held, called on fake timers. `ms`: how long to let it run. */
        async function stepPast(o: { tool?: 'click' | 'navigate' | 'back'; deadline?: number; ms?: number; onCard?: (t: Awaited<ReturnType<typeof acting>>) => void; twist?: Twist; mayAct?: () => string | null; postsTo?: string[]; stopAt?: number; before?: (t: Awaited<ReturnType<typeof acting>>) => void; posts?: boolean; at?: { ms: number; run: (t: Awaited<ReturnType<typeof acting>>) => void } } = {}) {
          const box: { t?: Awaited<ReturnType<typeof acting>> } = {};
          const t = await acting({
            deep: o.posts === false ? {} : o.tool === 'navigate' || o.tool === 'back' ? { postsOnLoad: true } : o.postsTo ? { postsTo: o.postsTo } : { posts: true },
            answer: 'hold',
            cardWaitMs: 50_000,
            sendWaitMs: 90_000,
            callDeadlineMs: o.deadline ?? 50_000,
            onCard: () => o.onCard?.(box.t!),
            ...(o.twist ? { twist: o.twist } : {}),
            act: { siteAllowed: () => true, ...(o.mayAct ? { mayAct: o.mayAct } : {}) },
          });
          box.t = t;
          o.before?.(t);
          const codesAtCall = o.twist?.codes?.length ?? 0;
          vi.useFakeTimers();
          let out: { text?: string; isError?: boolean } | undefined;
          const args = o.tool === 'navigate' ? { tab_id: t.tab, url: 'https://news.test/b' } : o.tool === 'back' ? { tab_id: t.tab } : { tab_id: t.tab, ref: 'e1' };
          const stop = new AbortController();
          // Stop (the user's: the agent's Stop) at `stopAt`, on the fake clock.
          if (o.stopAt !== undefined) setTimeout(() => t.agent.stop(), o.stopAt);
          // Something that happens during the call, on the fake clock.
          if (o.at) setTimeout(() => o.at!.run(t), o.at.ms);
          void t.callUntil(o.tool ?? 'click', args, stop.signal).then((x) => void (out = x));
          await vi.advanceTimersByTimeAsync(o.ms ?? 60_000);
          const later = () => (t.scope.memory.later ?? []).map((l) => l.entry);
          return { t, out: () => out, later, codesSince: () => (o.twist?.codes ?? []).slice(codesAtCall) };
        }

        it('blocker 1: past the deadline with something held and no card up, byDeadline waits for the card without a timer, wakes when it opens, and leaves nothing behind', async () => {
          vi.useFakeTimers();
          const agent = new ControlAgent('t', () => new Promise<Grant>(() => undefined));
          const cards = new OpenCards(agent, 'n1');
          let settled: unknown;
          void byDeadline(new Promise(() => undefined), Date.now() + 1_000, cards, Promise.resolve(), () => 1).then((r) => void (settled = r));
          await vi.advanceTimersByTimeAsync(1_000);
          expect(settled).toBeUndefined();
          // Waiting for the card: no timer (a poller would keep one).
          expect(vi.getTimerCount(), 'a timer left waiting for the card').toBe(0);
          void cards.ask(() => agent.ask(card({ kind: 'step', subject: 'sends' }), new AbortController().signal))();
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toEqual({ later: true });
          expect(vi.getTimerCount()).toBe(0);
        });

        it('opened() with a stop already aborted waits for nothing and leaves nothing listening', async () => {
          const agent = new ControlAgent('t', async () => 'once');
          const cards = new OpenCards(agent, 'n1');
          const stop = new AbortController();
          stop.abort();
          let woke = false;
          void cards.opened(stop.signal).then(() => void (woke = true));
          void cards.ask(() => agent.ask(card({ kind: 'step', subject: 'sends' }), new AbortController().signal))();
          await new Promise((r) => setTimeout(r, 0));
          expect(woke).toBe(false);
        });

        it('blocker 2: navigate’s card allowed after the page moved on sends nothing, and says none went (never “some”)', async () => {
          const { t, later } = await stepPast({ tool: 'navigate' });
          t.holds.at(-1)!('once');
          await vi.advanceTimersByTimeAsync(0);
          expect(t.at.debugging).not.toContain('Fetch.continueRequest');
          expect(later()).toEqual([sendsLater(t.tab, 'navigate', 'Going to news.test/b', 'moved-on', false)]);
        });

        it('a refusal of the step’s own after its input (the page never saw the pointer arrive), past the deadline: no hand-over, the card down, nothing later', async () => {
          const { t, out, later } = await stepPast({ twist: { noMove: true } });
          expect(out()?.isError).toBe(true);
          expect(out()!.text).not.toContain('sending');
          expect(t.agent.state('n1').cards).toEqual([]);
          expect(t.scope.memory.sendsWaiting?.size).toBe(0);
          expect(later()).toEqual([]);
        });

        it('done() refusing after the hand-over (the page went where it can’t be read): withdrawn, no card left up, nothing later', async () => {
          const { t, out, later } = await stepPast({ onCard: (t) => t.go('n1', 'https://private.test/x', true) });
          expect(out()?.isError).toBe(true);
          expect(t.agent.state('n1').cards).toEqual([]);
          expect(t.scope.memory.sendsWaiting?.size).toBe(0);
          expect(later()).toEqual([]);
        });

        for (const tool of ['click', 'navigate'] as const) {
          it(`Stop right as ${tool} hands over (its own deadline moment): its cards down, nothing waits, and the answer and the outcome agree`, async () => {
            const at = { start: 0 };
            const { t, out, later } = await stepPast({
              tool,
              before: () => void (at.start = Date.now()),
              // Armed when the card opens: after byDeadline's own timer, so the hand-over comes first and Stop right after.
              onCard: (t) => void setTimeout(() => t.agent.stop(), at.start + 50_000 - Date.now()),
            });
            expect(t.agent.state('n1').cards).toEqual([]);
            expect(t.scope.memory.sendsWaiting?.size).toBe(0);
            // Said to wait: its outcome is Stop. Refused: nothing later.
            const said = JSON.parse(out()!.text!) as { data: { sending?: string } };
            if (said.data.sending) expect(later().map((e) => e.why)).toEqual(['The step ran; what it sent didn’t go: the user pressed Stop.']);
            else expect(later()).toEqual([]);
          });
        }

        it('should-fix 4: navigate checks the tab before it hands over (the user took it while the card was up): no hand-over', async () => {
          const { t, out, later } = await stepPast({ tool: 'navigate', onCard: (t) => t.agent.pause('n1', true) });
          expect(out()?.text ?? '').not.toContain('sending');
          expect(t.agent.state('n1').cards).toEqual([]);
          expect(later()).toEqual([]);
        });

        it('after a hand-over, no diff of the page and no wait for its load: answered at the deadline though the page never stops loading', async () => {
          const twist: Twist = { codes: [] };
          const { out, codesSince } = await stepPast({ twist, deadline: 2_000, ms: 2_500, onCard: (t) => t.at.startNavigation!() });
          expect(out(), 'answered by the deadline, not after the 10 s load').toBeDefined();
          expect(JSON.parse(out()!.text!).data).toMatchObject({ sending: ACT_SENDS_WAITING, loading: true });
          // No pageChanges: no snapshot read since the call began.
          expect(codesSince().filter((c) => c.includes('__chordSids')).length).toBe(0);
        });

        it('should-fix 6, byDeadline: past the deadline with the input done, no card up and nothing held, it answers now (`past`), never waiting on the step’s load', async () => {
          vi.useFakeTimers();
          const cards = { isUp: () => false, opened: () => new Promise<void>(() => undefined) } as unknown as OpenCards;
          let settled: unknown;
          void byDeadline(new Promise(() => undefined), Date.now() + 1_000, cards, Promise.resolve(), () => 0).then((r) => void (settled = r));
          await vi.advanceTimersByTimeAsync(1_000);
          expect(settled).toEqual({ past: true });
        });

        it('byDeadline: a card up at the deadline waits for the input before it hands over', async () => {
          vi.useFakeTimers();
          const cards = { isUp: () => true, opened: () => new Promise<void>(() => undefined) } as unknown as OpenCards;
          let inputOver: () => void = () => undefined;
          const input = new Promise<void>((over) => (inputOver = over));
          let settled: unknown;
          void byDeadline(new Promise(() => undefined), Date.now() + 1_000, cards, input, () => 0).then((r) => void (settled = r));
          await vi.advanceTimersByTimeAsync(5_000);
          expect(settled, 'never before the input is done').toBeUndefined();
          inputOver();
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toEqual({ later: true });
        });

        it('the page moving on after an Allow (nothing held, no card up), the step still loading: never “moved on”; “went” once it’s done', async () => {
          const { t, later } = await stepPast({ deadline: 2_000, ms: 2_500, onCard: (t) => t.at.startNavigation!() });
          t.holds.at(-1)!('once');
          await vi.advanceTimersByTimeAsync(0);
          // The step's still under way (its load): the hand-over hasn't settled, and still listens.
          expect(later()).toEqual([]);
          t.at.navigate!('https://news.test/after');
          await vi.advanceTimersByTimeAsync(0);
          expect(later(), 'settled as moved on with nothing held').toEqual([]);
          await vi.advanceTimersByTimeAsync(15_000);
          expect(later()).toEqual([sendsLater(t.tab, 'click', 'Clicked “Home”', 'allowed', true)]);
        });

        it('the user takes the tab while it waits: “took the tab”', async () => {
          const { t, later } = await stepPast();
          t.agent.pause('n1', true);
          failHeld(t.pages.get('n1')!.contents);
          await vi.advanceTimersByTimeAsync(0);
          expect(later()).toEqual([sendsLater(t.tab, 'click', 'Clicked “Home”', 'took-over', false)]);
        });

        it('nit: Keep on one tab while it waits (the tab no longer the agent’s): “took the tab”, never “ended”', async () => {
          let kept = false;
          const { t, later } = await stepPast({ mayAct: () => (kept ? 'That tab is the user’s now.' : null) });
          kept = true;
          failHeld(t.pages.get('n1')!.contents);
          await vi.advanceTimersByTimeAsync(0);
          expect(later()).toEqual([sendsLater(t.tab, 'click', 'Clicked “Home”', 'took-over', false)]);
        });

        it('the page sending to too many sites while it waits: some went, then “too many sites”', async () => {
          const sites = Array.from({ length: 25 }, (_, i) => `https://s${i}.test/x`);
          const { t, later } = await stepPast({ postsTo: sites });
          for (let i = 0; i < 3; i++) {
            t.holds.at(-1)!('once');
            await vi.advanceTimersByTimeAsync(0);
          }
          expect(later()).toEqual([sendsLater(t.tab, 'click', 'Clicked “Home”', 'too-many', true)]);
        });

        it('settle twice records once; withdraw after a settle (during done()) takes its entry back (should-fix 5)', async () => {
          const { t, later } = await stepPast();
          const memory = t.scope.memory;
          const entries = () => later().length;
          // The hand-over the call made: settle it twice through its ways out (Don't, then Stop).
          t.holds.at(-1)!('deny');
          await vi.advanceTimersByTimeAsync(0);
          t.agent.stop();
          await vi.advanceTimersByTimeAsync(0);
          expect(entries()).toBe(1);
          // settle itself, twice: one entry.
          const once = new HandedOver({ nodeId: 'n3', tab: 't3', tool: 'click', step: 'y', w: { held: () => [], deny: () => undefined, end: () => undefined, cancelled: new AbortController().signal } as unknown as SendWatch, allowed: () => 0, cards: new OpenCards(t.agent, 'n3'), cardsEnd: new AbortController(), memory, from: undefined, live: () => null, onLeave: () => () => undefined });
          once.settle('no');
          once.settle('stopped');
          expect(later().filter((e) => e.tab_id === 't3').map((e) => e.why)).toEqual(['The step ran; what it sent didn’t go: the user said no.']);
          memory.later = memory.later!.filter((l) => l.entry.tab_id !== 't3');
          // A HandedOver settled, then withdrawn: no entry left for a call that answered an error.
          const w = { held: () => [], deny: () => undefined, end: () => undefined, cancelled: new AbortController().signal } as unknown as SendWatch;
          const handed = new HandedOver({ nodeId: 'n2', tab: 't2', tool: 'click', step: 'x', w, allowed: () => 0, cards: new OpenCards(t.agent, 'n2'), cardsEnd: new AbortController(), memory, from: undefined, live: () => null, onLeave: () => () => undefined });
          handed.settle('moved-on');
          expect(entries()).toBe(2);
          handed.withdraw();
          expect(entries()).toBe(1);
        });

        it('nit: a batch’s hand-over step keeps `navigated`', async () => {
          const t = await acting({ deep: { posts: true }, answer: 'hold', cardWaitMs: 50_000, sendWaitMs: 90_000, callDeadlineMs: 50_000, act: { siteAllowed: () => true } });
          vi.useFakeTimers();
          let out: { text?: string } | undefined;
          void runBatch(t.scope, t.browser, { tab_id: t.tab, steps: [{ tool: 'click', ref: 'e1' }] }, new AbortController().signal).then((o) => void (out = o));
          await vi.advanceTimersByTimeAsync(60_000);
          expect(JSON.parse(out!.text!).data).toMatchObject({ navigated: false, sending: ACT_SENDS_WAITING });
        });

        it('nit: navigate’s hand-over answer says its page, address and title; its card reads as a sentence', async () => {
          const { t, out } = await stepPast({ tool: 'navigate' });
          expect(JSON.parse(out()!.text!).data).toEqual(expect.objectContaining({ page_id: expect.any(String), url: expect.any(String), title: expect.any(String) }));
          expect(t.cards.find((c) => c.step?.why === 'send')!.description).toBe('is going to news.test/b');
        });

        it('nit: back’s card reads as a sentence', async () => {
          const { t } = await stepPast({ tool: 'back', before: (t) => void (t.at.history = [{ url: 'https://news.test/before' }, { url: t.at.url }], t.at.active = 1) });
          expect(t.cards.find((c) => c.step?.why === 'send')!.description).toBe('is going back');
        });

        // The blocker of round 3: navigate's `past` (nothing held at the deadline, the page still loading) checks first.
        for (const [what, setUp, why] of [
          ['a redirect to a Never site', (t: Awaited<ReturnType<typeof acting>>) => void (t.at.redirects = { 'https://news.test/b': 'https://private.test/x' }), 'This page can never be read'],
          ['a paused tab', (t: Awaited<ReturnType<typeof acting>>) => t.agent.pause('n1', true), CONTROL_REFUSALS.paused],
          ['a lost hold', (t: Awaited<ReturnType<typeof acting>>) => void pickers.lost.add(t.pages.get('n1')!.contents), 'Chord couldn’t check that page right now'],
        ] as const) {
          it(`navigate past its deadline, still loading, on ${what}: refused, never “Going to…” with the page`, async () => {
            // A redirect is there before the call; a pause or a lost hold comes during it (the fake clock, at 1 s).
            const during = what !== 'a redirect to a Never site';
            const { t, out } = await stepPast({ tool: 'navigate', posts: false, deadline: 2_000, ms: 3_000, before: (t) => ((t.at.stallLoad = true), during ? undefined : setUp(t)), ...(during ? { at: { ms: 1_000, run: setUp } } : {}) });
            expect(out(), 'answered by the deadline').toBeDefined();
            expect(out()!.isError).toBe(true);
            expect(out()!.text).toContain(why.slice(0, 30));
            expect(out()!.text).not.toContain('private.test');
            pickers.lost.delete(t.pages.get('n1')!.contents);
          });
        }

        it('navigate past its deadline, still loading, readable: answered then, `loading`, never `sending`', async () => {
          const { out } = await stepPast({ tool: 'navigate', posts: false, deadline: 2_000, ms: 3_000, before: (t) => void (t.at.stallLoad = true) });
          expect(out()!.isError).toBeFalsy();
          expect(JSON.parse(out()!.text!).data).toMatchObject({ done: 'Going to news.test/b', loading: true });
          expect(JSON.parse(out()!.text!).data).not.toHaveProperty('sending');
        });

        it('click past its deadline (nothing held), the page it set off gone where it can’t be read: refused, never its page', async () => {
          const box: { t?: Awaited<ReturnType<typeof acting>> } = {};
          // The click sets off a navigation (afterActing waits for its load) to a Never site, still loading at the deadline.
          const t = await acting({ callDeadlineMs: 2_000, act: { siteAllowed: () => true }, onAct: (_e, op) => {
            if (op !== 'hit' || !box.t || box.t.at.loading) return;
            box.t.at.startNavigation!();
            box.t.go('n1', 'https://private.test/x', true);
          } });
          box.t = t;
          vi.useFakeTimers();
          let out: { text?: string; isError?: boolean } | undefined;
          void t.call('click', { tab_id: t.tab, ref: 'e1' }).then((x) => void (out = x));
          await vi.advanceTimersByTimeAsync(3_000);
          expect(out, 'answered by the deadline').toBeDefined();
          expect(out!.isError).toBe(true);
          expect(out!.text).not.toContain('private.test');
        });

        it('the next reply carries `later` inside the untrusted envelope; the hand-over reply never does (laterContent)', () => {
          const mine = {};
          const memory = { pdfs: new Map(), form: null, nextField: 1, read: new Set<NodeId>(), later: [{ from: mine, entry: sendsLater('a1', 'click', 'Clicked “x”', 'allowed', true) }] } as ToolMemory;
          expect(laterContent(memory, mine)).toEqual([]);
          const next = laterContent(memory, {});
          expect(next).toEqual([{ type: 'text', text: toolResult({ later: [sendsLater('a1', 'click', 'Clicked “x”', 'allowed', true)] }) }]);
          expect(JSON.parse(next[0]!.text).trust).toBe('untrusted');
        });
      });
    });

    it('a send card in an action holds live requests, so it waits CONTROL_WAIT_MS even where site and step cards wait as long as it takes (the assistant: D2, the reviews of #147)', async () => {
      const t = await acting({ deep: { posts: true }, answer: 'hold', act: { siteAllowed: () => true } });
      vi.useFakeTimers();
      const done = t.call('click', { tab_id: t.tab, ref: 'e1' });
      await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS + 50);
      expect(refusal(await done).refused).toBe(ACT_REFUSALS.sendsDropped);
      expect(t.at.debugging).not.toContain('Fetch.continueRequest');
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

  // ---------- batch (M2g-1; Neon's round 1, B-7) ----------

  describe('batch: each step through every gate, stopping at the first that can’t go', () => {
    type T = Awaited<ReturnType<typeof acting>>;
    const batch = (t: T, steps: unknown, cancelled = new AbortController().signal, tab: unknown = t.tab) => runBatch(t.scope, t.browser, { tab_id: tab, steps }, cancelled);
    const ok = (out: { text?: string }) => (JSON.parse(out.text!) as { data: Record<string, unknown> }).data;
    const clicks = (t: T) => t.at.input.filter((e) => (e as { type: string }).type === 'mouseDown').length;

    it('bounds, the tools it takes and each step’s shape, all checked before any step runs', async () => {
      const t = await acting({ act: { siteAllowed: () => true } });
      const table: [unknown, string][] = [
        [[], 'batch takes 1 to 20 steps.'],
        [Array.from({ length: 21 }, () => ({ tool: 'hover', ref: 'e1' })), 'batch takes 1 to 20 steps.'],
        [[{ tool: 'click', ref: 'e1' }, { tool: 'navigate', url: 'https://news.test/b' }], 'Step 2: batch takes click, type, press_key, select_option, hover.'],
        [[{ tool: 'click', ref: 'e1' }, 'click'], 'Step 2: each step is an object with its tool and arguments.'],
        ['steps', 'batch takes 1 to 20 steps.'],
        // Each step's own arguments too, before step 1 runs (round 1 of #145, SF6).
        [[{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: 'x1' }], 'Step 2: ref is an element’s ref from a snapshot (e1, e2…).'],
        [[{ tool: 'click', ref: 'e1' }, { tool: 'type', ref: 'e2' }], 'Step 2: type takes text, at most 5000 characters.'],
        [[{ tool: 'click', ref: 'e1' }, { tool: 'type', ref: 'e2', text: 'x'.repeat(5001) }], 'Step 2: type takes text, at most 5000 characters.'],
        [[{ tool: 'click', ref: 'e1' }, { tool: 'type', ref: 'e2', text: 'x', submit: 'yes' }], 'Step 2: submit and replace are true or false.'],
        // press_key's own words, which list the keys (batch's schema no longer does: M2g-2 slice 2).
        [[{ tool: 'click', ref: 'e1' }, { tool: 'press_key', ref: 'e2', key: 'F13' }], `Step 2: ${ACT_REFUSALS.key}`],
        // Its key missing: the same, before step 1 (Claude's review of #188).
        [[{ tool: 'click', ref: 'e1' }, { tool: 'press_key', ref: 'e2' }], `Step 2: ${ACT_REFUSALS.key}`],
        [[{ tool: 'click', ref: 'e1' }, { tool: 'select_option', ref: 'e3' }], 'Step 2: select_option takes option, its label (at most 500 characters).'],
        // Its ref too: one never given (round 2 of #145).
        [[{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: 'e99' }], 'Step 2: There’s no element e99 in that tab. Call snapshot for the page’s elements.'],
      ];
      for (const [steps, says] of table) expect((await batch(t, steps)).text, JSON.stringify(steps).slice(0, 60)).toBe(says);
      // None ran: a bad step 2 never leaves step 1 done.
      expect(clicks(t)).toBe(0);
    });

    it('a ref from before the page moved on is refused before any step runs (round 2 of #145)', async () => {
      const t = await acting({ act: { siteAllowed: () => true } });
      await (t.pages.get('n1')!.contents as unknown as { loadURL(u: string): Promise<void> }).loadURL('https://news.test/c');
      expect((await batch(t, [{ tool: 'hover', ref: 'e1' }, { tool: 'click', ref: 'e1' }])).text).toBe(`Step 1: ${ELEMENT_REFUSALS.stale}`);
      expect(clicks(t)).toBe(0);
    });

    it('the batch’s tab is every step’s: a step’s own tab_id is ignored', async () => {
      const t = await acting({ act: { siteAllowed: () => true } });
      const out = ok(await batch(t, [{ tool: 'click', ref: 'e1', tab_id: 'a9' }, { tool: 'hover', ref: 'e1' }]));
      expect(out).toMatchObject({ tab_id: t.tab, done: ['Clicked “Home”', 'Pointed at “Home”'] });
      expect(out['page_changes']).toBeUndefined();
    });

    it('the site card once for the batch; a risky step asks its own, and a no stops the batch there', async () => {
      const t = await acting();
      expect(ok(await batch(t, [{ tool: 'hover', ref: 'e1' }, { tool: 'click', ref: 'e1' }]))['done']).toEqual(['Pointed at “Home”', 'Clicked “Home”']);
      expect(t.cards.filter((c) => c.kind === 'site')).toHaveLength(1);
      const u = await acting({ answer: 'deny', act: { siteAllowed: () => true } });
      const out = await batch(u, [{ tool: 'hover', ref: 'e1' }, { tool: 'type', ref: 'e2', text: 'wool', submit: true }, { tool: 'click', ref: 'e1' }]);
      // The refusal in the untrusted envelope (round 1 of #145, SF6): what went is the page's words.
      expect(out.isError).toBe(true);
      expect(ok(out)).toEqual({ refused: 'Step 2 (type) was refused.', step: 2, tool: 'type', why: 'The user said no to this step. Don’t try it another way; ask the user what to do.', done: ['Pointed at “Home”'] });
      expect(clicks(u)).toBe(0);
    });

    it('a step refused for a look-alike stops the batch there, saying how to choose (#211)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist, act: { siteAllowed: () => true } });
      (t.scope as { findFlat?: boolean }).findFlat = true;
      const line = t.scope.activity;
      (t.scope as { activity: typeof line }).activity = async (...a) => {
        await line(...a);
        twist.ambiguous = true;
      };
      const out = await batch(t, [{ tool: 'hover', ref: 'e1' }, { tool: 'click', ref: 'e1' }, { tool: 'hover', ref: 'e1' }]);
      expect(out.isError).toBe(true);
      expect(ok(out)).toEqual({ refused: 'Step 2 (click) was refused.', step: 2, tool: 'click', why: ACT_REFUSALS.ambiguous, done: ['Pointed at “Home”'] });
      expect(clicks(t)).toBe(0);
    });

    it('what a step sends is held and asked about, as for its own call', async () => {
      const t = await acting({ deep: { posts: true }, answer: 'deny', act: { siteAllowed: () => true } });
      const out = await batch(t, [{ tool: 'click', ref: 'e1' }, { tool: 'hover', ref: 'e1' }]);
      expect(ok(out)).toMatchObject({ refused: 'Step 1 (click) was refused.', step: 1, tool: 'click', done: [] });
      expect(t.at.debugging).toContain('Fetch.fulfillRequest');
      expect(t.at.debugging).not.toContain('Fetch.continueRequest');
    });

    it('Stop, the client’s cancel, the user pausing the agent or taking the tab over: the next step never runs', async () => {
      // [what happens during step 1, what step 2 says]
      const cases: [string, (t: T, cancel: AbortController) => void, string][] = [
        ['stop', (t) => t.agent.stop(), CONTROL_REFUSALS.stopped],
        ['cancel', (_t, cancel) => cancel.abort(), CONTROL_REFUSALS.stopped],
        ['pause', (t) => t.agent.pause('n1', true), CONTROL_REFUSALS.paused],
        // The user took the tab over (a background reload too): its cards let go of, the agent not paused.
        ['takeover', (t) => t.agent.cancelCardsFor('n1'), ACT_REFUSALS.takenOver],
      ];
      for (const [what, during, says] of cases) {
        const cancel = new AbortController();
        const t: T = await acting({ act: { siteAllowed: () => true } });
        // Once step 1 is done (its line in what the agent did, the last thing a step does): between the steps.
        const line = t.scope.activity;
        let fired = false;
        (t.scope as { activity: typeof line }).activity = async (...a) => {
          await line(...a);
          if (!fired) {
            fired = true;
            during(t, cancel);
          }
        };
        const out = await batch(t, [{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: 'e1' }], cancel.signal);
        expect(out.isError, what).toBe(true);
        // Stop and the client's cancel end the whole call, step 1's answer too (stopped); the others stop it before step 2.
        if (what === 'stop' || what === 'cancel') expect(out.text, what).toContain(says);
        else expect(ok(out), what).toEqual({ refused: 'Step 2 (click) didn’t run.', step: 2, tool: 'click', why: says, done: ['Clicked “Home”'] });
        expect(clicks(t), what).toBe(1);
      }
    });

    it('what the page was caught doing at any step goes in the batch’s answer, never lost behind a later step’s done (#150)', async () => {
      const caught = ['The page showed a dialog (confirm: “Delete?”); it was answered Cancel'];
      const t = await acting({ act: { siteAllowed: () => true, caught: () => caught.splice(0) } });
      expect(ok(await batch(t, [{ tool: 'click', ref: 'e1' }, { tool: 'hover', ref: 'e1' }]))['caught']).toEqual(['The page showed a dialog (confirm: “Delete?”); it was answered Cancel']);
    });

    it('a step that took the page elsewhere stops the batch after it: the rest named refs of the page before', async () => {
      let fired = false;
      const t = await acting({
        act: { siteAllowed: () => true },
        onAct: (events, op) => {
          if (op === 'hit' && !fired) {
            fired = true;
            setTimeout(() => events.emit('did-navigate'), 0);
          }
        },
      });
      const out = ok(await batch(t, [{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: 'e1' }]));
      expect(out).toMatchObject({ done: ['Clicked “Home”'], stopped_after: 1, why: 'The page changed: call snapshot before the rest.' });
      expect(clicks(t)).toBe(1);
    });
  });

  it('a step’s key and its checks name the element: its name, its items and its place (Neon’s round 1 of M2g-1, B-2)', async () => {
    // The same ref (refs stay), its element moved to another row, or renamed: another step, never one a late Allow covers.
    let row = 'Draft 1';
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true }, twist: { place: () => ({ items: JSON.stringify([['row', row]]), path: '[["div",""]]' }) } });
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'go', submit: true });
    row = 'Production DB';
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'go', submit: true });
    const name = ELEMENTS[1]!.name;
    ELEMENTS[1]!.name = 'Search all';
    try {
      await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'go', submit: true });
    } finally {
      ELEMENTS[1]!.name = name;
    }
    const subjects = t.cards.filter((c) => c.kind === 'step').map((c) => c.subject);
    expect(subjects).toHaveLength(3);
    expect(new Set(subjects).size).toBe(3);
    // Moved between the check and the press (its place now another): nothing goes in.
    const u = await acting({ act: { siteAllowed: () => true }, twist: { place: () => ({ items: u.steps.filter((x) => x === 'describe').length > 1 ? '[["row","Production DB"]]' : '[["row","Draft 1"]]', path: '[]' }) } });
    expect(refusal(await u.call('click', { tab_id: u.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.stepChanged);
    expect(u.at.input.filter((e) => (e as { type: string }).type === 'mouseDown')).toEqual([]);
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

  it('the assistant leaving the site: a card every time, with the whole address; Don’t goes nowhere, Allow goes (M2e-2c, B3)', async () => {
    const leaving = (from: string, to: string) => new URL(from).host !== new URL(to).host;
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true, leaving } });
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'https://tracker.example/collect?q=secret' })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    expect(t.at.loads).toEqual([]);
    expect(t.cards.map((c) => [c.step?.why, c.step?.going])).toEqual([['leave', 'https://tracker.example/collect?q=secret']]);
    const u = await acting({ act: { siteAllowed: () => true, leaving } });
    await u.call('navigate', { tab_id: u.tab, url: 'https://tracker.example/collect?q=secret' });
    await u.call('navigate', { tab_id: u.tab, url: 'https://news.test/back' });
    // Asked again the second time, leaving again (never remembered), and it went each time.
    expect(u.cards.filter((c) => c.step?.why === 'leave')).toHaveLength(2);
    expect(u.at.loads).toHaveLength(2);
    // The same site: no card.
    const w = await acting({ act: { siteAllowed: () => true, leaving } });
    await w.call('navigate', { tab_id: w.tab, url: 'https://news.test/b' });
    expect(w.cards.filter((c) => c.step?.why === 'leave')).toEqual([]);
  });

  it('typing in a chat that read anything but this tab: the exact text shown first, every time; Don’t types nothing (M2e-2c, B3; the owner’s answer 6)', async () => {
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true, typeAsks: () => true } });
    expect(refusal(await t.call('type', { tab_id: t.tab, ref: 'e2', text: 'W-104388' })).refused).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    expect(t.at.text).toEqual([]);
    expect(t.cards.map((c) => [c.step?.typed, c.step?.taint])).toEqual([['W-104388', true]]);
    const u = await acting({ act: { siteAllowed: () => true, typeAsks: () => true } });
    await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'W-104388' });
    await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'W-104388' });
    expect(u.cards.filter((c) => c.step?.taint)).toHaveLength(2);
    expect(u.at.text).toEqual(['W-104388', 'W-104388']);
    // A chat that read only this tab: no card.
    const w = await acting({ act: { siteAllowed: () => true, typeAsks: () => false } });
    await w.call('type', { tab_id: w.tab, ref: 'e2', text: 'W-104388' });
    expect(w.cards.filter((c) => c.step?.taint)).toEqual([]);
  });

  it('typing in a chat that read elsewhere: every character it will type on the card, Show me there, and the page checked again after it (Neon’s B2, SF4 on #151)', async () => {
    const text = `${'Thanks for the order. '.repeat(110)}W-104388`;
    expect(text.length).toBeGreaterThan(2000);
    const t = await acting({ act: { siteAllowed: () => true, typeAsks: () => true } });
    await t.call('type', { tab_id: t.tab, ref: 'e2', text });
    const card = t.cards.find((c) => c.step?.taint)!;
    expect(card.step?.typed).toBe(text);
    expect(card.show).toBeTypeOf('function');
    expect(t.at.text).toEqual([text]);
    // The site added to the Never list while the card was up: nothing typed.
    const never: string[] = [];
    const u = await acting({ act: { siteAllowed: () => true, typeAsks: () => true }, onCard: () => void never.push('news.test') });
    u.scope.neverSites = () => never;
    expect(refusal(await u.call('type', { tab_id: u.tab, ref: 'e2', text: 'W-104388' })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    expect(u.at.text).toEqual([]);
  });

  it('the leaving card’s address is the whole one, made plain: no control or bidi characters, at most 2048; Back still goes where the card said (Neon’s B1, SF2 on #151)', async () => {
    const leaving = (from: string, to: string) => new URL(from).host !== new URL(to).host;
    const t = await acting({ answer: 'deny', act: { siteAllowed: () => true, leaving } });
    await t.call('navigate', { tab_id: t.tab, url: 'https://tracker.example/collect?q=gpj\u202E.exe&x=1#done' });
    const going = t.cards.find((c) => c.step?.why === 'leave')!.step!.going!;
    expect(going).toContain('tracker.example/collect?q=');
    expect(going).toContain('#done');
    // eslint-disable-next-line no-control-regex -- control characters are exactly what it must not have
    expect(going).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/);
    // A pushState while the leaving card is up: Back would go somewhere else than the card said, so it doesn't.
    let at: { history: { url: string }[]; active: number } | null = null;
    const u = await acting({ act: { siteAllowed: () => true, leaving }, onCard: () => void (at && ((at.history = [{ url: 'https://tracker.example/a' }, { url: 'https://news.test/a' }, { url: 'https://news.test/pushed' }]), (at.active = 2))) });
    at = u.at as never;
    u.at.history = [{ url: 'https://tracker.example/a' }, { url: 'https://news.test/a' }];
    u.at.active = 1;
    expect(refusal(await u.call('back', { tab_id: u.tab })).refused).toBeTruthy();
    expect(u.at.active).toBe(2);
  });

  it('a chat that read elsewhere: every navigate and back shows the whole address first, the same site too; one that didn’t, only leaving (Claude’s C-B3 on #151)', async () => {
    const leaving = (from: string, to: string) => new URL(from).host !== new URL(to).host;
    // [what, the chat read elsewhere, the call, whether it shows the address]
    const rows: [string, boolean, (t: Awaited<ReturnType<typeof acting>>) => Promise<unknown>, boolean][] = [
      ['the same site, read elsewhere', true, (t) => t.call('navigate', { tab_id: t.tab, url: 'https://news.test/?d=W-104388' }), true],
      ['the same site, nothing read elsewhere', false, (t) => t.call('navigate', { tab_id: t.tab, url: 'https://news.test/?d=W-104388' }), false],
      ['back on the same site, read elsewhere', true, (t) => ((t.at.history = [{ url: 'https://news.test/?d=W-104388' }, { url: 'https://news.test/a' }]), (t.at.active = 1), t.call('back', { tab_id: t.tab })), true],
      ['back on the same site, nothing read elsewhere', false, (t) => ((t.at.history = [{ url: 'https://news.test/?d=W-104388' }, { url: 'https://news.test/a' }]), (t.at.active = 1), t.call('back', { tab_id: t.tab })), false],
    ];
    for (const [what, tainted, run, asks] of rows) {
      const t = await acting({ answer: 'deny', act: { siteAllowed: () => true, leaving, typeAsks: () => tainted } });
      await run(t);
      const shown = t.cards.filter((c) => c.step?.going?.includes('d=W-104388'));
      expect(shown.length, what).toBe(asks ? 1 : 0);
      if (asks) expect(t.at.loads, what).toEqual([]);
    }
  });

  it('navigate to another site: one card, the leaving card with the whole address; never the destination’s site card nor its grant (the owner’s test of the 0.15 preview)', async () => {
    const leaving = (from: string, to: string) => new URL(from).host !== new URL(to).host;
    const away = 'https://wiki.example/w/index.php?search=chord+progression&ns0=1';
    // [what, the call, the chat read elsewhere, the cards it shows (kind, why, address)]
    const rows: [string, string, boolean, [string, string | undefined, string | undefined][]][] = [
      ['another site', away, false, [['step', 'leave', away]]],
      ['another site, an address that signs out', 'https://wiki.example/logout?next=%2F', false, [['step', 'leave', 'https://wiki.example/logout?next=%2F']]],
      ['the same site, not allowed yet: its site card', 'https://news.test/b?q=1', false, [['site', undefined, undefined]]],
      ['the same site in a chat that read elsewhere: its site card, then the whole address', 'https://news.test/b?q=1', true, [['site', undefined, undefined], ['step', 'leave', 'https://news.test/b?q=1']]],
    ];
    for (const [what, url, tainted, cards] of rows) {
      const t = await acting({ act: { siteAllowed: () => false, leaving, typeAsks: () => tainted } });
      await t.call('navigate', { tab_id: t.tab, url });
      expect(t.cards.map((c) => [c.kind, c.step?.why, c.step?.going]), what).toEqual(cards);
      // Going there grants nothing there: acting on its page later asks its own site card.
      expect(t.kept, what).toEqual([]);
      expect(t.at.loads, what).toEqual([url]);
    }
    // An outside agent (no leaving card: its own tabs): the destination's site card, as before.
    const u = await acting({ act: { siteAllowed: () => false } });
    await u.call('navigate', { tab_id: u.tab, url: away });
    expect(u.cards.map((c) => [c.kind, c.subject])).toEqual([['site', 'wiki.example']]);
  });

  it('navigate tells the lease where it goes, once its hold is on (Claude’s review of #151, Neon’s N2)', async () => {
    const told: string[] = [];
    const t = await acting({ act: { siteAllowed: () => true, lease: { begin: async () => null, end: () => undefined, going: (_n, url) => void told.push(url) } } });
    await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/out?to=x' });
    expect(told).toEqual(['https://news.test/out?to=x']);
  });

  it('a held step’s card: leaving shows the whole address and what sent the tab on; another step the short one (Neon’s B1, N5 on #151)', () => {
    const away = 'https://tracker.example/collect?secret=W-104388#done';
    expect(heldStep([{ url: away, why: 'leave' }], ['https://tracker.example'], 'leave', 'https://news.test/a', 'news.test/out')).toMatchObject({ why: 'leave', site: 'tracker.example', going: away, from: 'news.test/out' });
    expect(heldStep([{ url: away, why: 'leave' }], ['https://tracker.example'], 'leave', 'https://news.test/a')).toMatchObject({ going: away, from: 'A page on news.test' });
    expect(heldStep([{ url: 'https://news.test/account/delete?id=7', why: 'delete' }], ['https://news.test'], 'delete', 'https://news.test/a')).toMatchObject({ why: 'delete', going: 'news.test/account/delete' });
    expect(heldStep([], ['https://news.test', 'https://cdn.example'], null, 'https://news.test/a')).toMatchObject({ why: 'send', sends: ['news.test', 'cdn.example'] });
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

  describe('navigate with snapshot: true: the page it went to, as snapshot gives it (S18 M2g-2 slice 3a, #204)', () => {
    const NEVER_READ = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';
    const PASSWORD = { depth: 0, role: 'textbox', name: 'Password', key: 5, sid: 6, field: { type: 'password', autocomplete: 'current-password', name: 'pw', id: 'pw', label: 'Password', placeholder: '' } };
    type Body = { source?: string; trust?: string; content?: string; page_id?: string; refs?: number; navigate?: Record<string, unknown>; data?: Record<string, unknown> };
    /** An agent's tab of its own, gone to another page of the site; the read after it answering as the row says. */
    const go = async (row: { offered?: boolean; asked?: boolean; read?: NonNullable<Twist['read']> & { extra?: unknown[] }; redirect?: string; off?: boolean }) => {
      const twist: Twist = {};
      const t = await acting({ twist });
      if (row.offered !== false) (t.scope as { outlineOnGo?: boolean }).outlineOnGo = true;
      if (row.read) twist.read = row.read;
      if (row.redirect) t.at.redirects = { 'https://news.test/b': row.redirect };
      // Settings' Nothing, turned on as the outline is read (round 1 of #232, SF2).
      if (row.off) twist.read = { meanwhile: () => void ((t.scope as { off: () => string | null }).off = () => 'The user set you to read nothing, in Settings → Assistant.') };
      const out = await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b', ...(row.asked === false ? {} : { snapshot: true }) });
      return { t, out, body: JSON.parse(out.text!) as Body };
    };

    // [the page's state, the row, what the answer is]
    const table: [string, Parameters<typeof go>[0], (body: Body, t: Awaited<ReturnType<typeof acting>>) => void][] = [
      [
        'a page that reads: snapshot’s envelope, untouched, its refs issued; the action’s words under navigate, less what the envelope says',
        {},
        (body, t) => {
          expect(body).toMatchObject({ source: 'web_snapshot', trust: 'untrusted', tab_id: t.tab, url: 'https://news.test/b' });
          const home = /link "Home" \[ref=(e\d+)\]/.exec(body.content!)?.[1];
          expect(home).toBeDefined();
          expect(body.navigate).toEqual({ done: 'Went to news.test/b', navigated: true });
          expect(body.data).toBeUndefined();
          expect(t.scope.memory.elements!.get('n1')!.resolve(home, body.page_id!)).toMatchObject({ ok: true });
        },
      ],
      [
        'a password field on it: its line, never a ref (snapshotKeys)',
        { read: { extra: [PASSWORD] } },
        (body) => {
          const line = body.content!.split('\n').find((l) => l.includes('textbox "Password"'));
          expect(line).toBeDefined();
          expect(line).not.toMatch(/\[ref=/);
          expect(body.refs).toBe(body.content!.match(/\[ref=/g)!.length);
        },
      ],
      [
        'its read comes back from a site the user keeps private: no outline and no ref, the action’s answer saying why in Chord’s words',
        { read: { url: 'https://private.test/x' } },
        (body, t) => {
          expect(body.source).toBeUndefined();
          expect(body.content).toBeUndefined();
          expect(body.data).toMatchObject({ done: 'Went to news.test/b', navigated: true, no_outline: NEVER_READ });
          expect(JSON.stringify(body)).not.toContain('private.test');
          // Nothing of the read kept: no outline for the page, so no ref of it resolves.
          expect(t.scope.memory.elements!.get('n1')!.outline(body.data!['page_id'] as string)).toBeFalsy();
          expect(t.scope.memory.elements!.get('n1')!.resolve('e6', body.data!['page_id'] as string)).toMatchObject({ ok: false });
        },
      ],
      [
        'not asked for: as today (the note to call snapshot, no outline)',
        { asked: false },
        (body) => {
          expect(body.source).toBeUndefined();
          expect(body.data).toMatchObject({ navigated: true, note: 'The page changed: call snapshot again before using refs from before.' });
        },
      ],
      [
        'a scope that doesn’t offer it (the assistant without its flag): as today',
        { offered: false },
        (body) => {
          expect(body.source).toBeUndefined();
          expect(body.data).toMatchObject({ navigated: true, note: 'The page changed: call snapshot again before using refs from before.' });
        },
      ],
    ];
    it.each(table)('%s', async (_state, row, check) => {
      const { t, out, body } = await go(row);
      // The action happened either way: never an error.
      expect(out.isError).toBeFalsy();
      check(body, t);
    });

    it('it went to a Never site (redirected as it loaded): refused, as without snapshot, and no outline (round 1 of #232, SF4)', async () => {
      for (const asked of [true, false]) {
        const { out } = await go({ redirect: 'https://private.test/x', asked });
        expect(out.isError).toBe(true);
        expect(refusal(out).refused).toBe(NEVER_READ);
        expect(out.text).not.toContain('web_snapshot');
      }
    });

    it('a navigation that starts as the outline is read: no outline (never the page it’s leaving), and no second wait (round 1 of #232, SF1)', async () => {
      // The page goes elsewhere as it's read (a new document), and is loading.
      const started = await go({ read: { meanwhile: (events) => events.emit('did-navigate') } });
      expect(started.body.source).toBeUndefined();
      expect(started.body.data).toMatchObject({ navigated: true, no_outline: STILL_LOADING });
      // Loading when the outline would be taken: none, and no wait for it.
      const twist: Twist = {};
      const t = await acting({ twist });
      (t.scope as { outlineOnGo?: boolean }).outlineOnGo = true;
      twist.read = { meanwhile: () => void (t.at.loading = true) };
      // No second wait: a wait for the load (15 s) would outlast the test's own time limit.
      const out = JSON.parse((await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b', snapshot: true })).text!) as Body;
      expect(out.source).toBeUndefined();
      expect(out.data).toMatchObject({ no_outline: STILL_LOADING });
    });

    it('a page loading when the outline would be taken: no outline, and nothing read, never a wait for it (round 2 of #232, SF-R2-1)', async () => {
      // The page starts loading after navigate has answered, before the outline (its bar let go of: the action's end).
      let armed = false;
      const twist: Twist = {};
      const t = await acting({ twist, act: { doing: (_n, d) => void (armed && d === null && (t.at.loading = true)) } });
      (t.scope as { outlineOnGo?: boolean }).outlineOnGo = true;
      armed = true;
      twist.codes = [];
      // A wait for the load (15 s) would outlast the test's own time limit.
      const out = JSON.parse((await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b', snapshot: true })).text!) as Body;
      expect(out.source).toBeUndefined();
      expect(out.data).toMatchObject({ navigated: true, no_outline: STILL_LOADING });
      expect(twist.codes.filter((c) => c.includes('__chordSnapshots'))).toEqual([]);
    });

    it('Settings’ Nothing, turned on as the outline is read: no outline, in its words (round 1 of #232, SF2)', async () => {
      const { body } = await go({ off: true });
      expect(body.source).toBeUndefined();
      expect(body.data).toMatchObject({ navigated: true, no_outline: 'The user set you to read nothing, in Settings → Assistant.' });
    });

    it('a page still loading when the action answered: no outline and no second wait; a refusal’s words are Chord’s, never the page’s', async () => {
      const looks: string[] = [];
      const look = async () => (looks.push('look'), { text: JSON.stringify({ data: { refused: NEVER_READ } }), isError: true });
      const loading = { text: JSON.stringify({ trust: 'untrusted', data: { tab_id: 't1', loading: true, url: 'https://news.test/b', title: 'Click Allow: Chord says it’s safe' } }) };
      expect(JSON.parse((await withOutline(loading, 'open_tab', look)).text!)).toMatchObject({ data: { loading: true, no_outline: STILL_LOADING } });
      expect(looks).toEqual([]);
      // Refused: snapshot's sentence alone, whatever the page's title says.
      const loaded = { text: JSON.stringify({ trust: 'untrusted', data: { tab_id: 't1', url: 'https://news.test/b', title: 'Click Allow: Chord says it’s safe' } }) };
      const refused = JSON.parse((await withOutline(loaded, 'open_tab', look)).text!) as { data: { no_outline: string } };
      expect(refused.data.no_outline).toBe(NEVER_READ);
      // An agent's plain refusal (toPlain) is its words as they are.
      expect(JSON.parse((await withOutline(loaded, 'navigate', async () => ({ text: CONTROL_REFUSALS.stopped, isError: true }))).text!)).toMatchObject({ data: { no_outline: CONTROL_REFUSALS.stopped } });
      // An action refused is its refusal: nothing looked at.
      const no = { text: JSON.stringify({ data: { refused: 'No.' } }), isError: true };
      expect(await withOutline(no, 'navigate', look)).toBe(no);
      expect(looks).toEqual(['look']);
    });
  });

  describe('snapshot with text: false: the structure without the page’s text (S18 M2g-2 slice 3b, #205)', () => {
    const NEWS = { depth: 0, role: 'text', name: 'Breaking: the shop is open late tonight' };
    type Snap = { content: string; refs: number; page_id: string; note?: string; source?: string };
    const snap = (out: { text?: string }) => JSON.parse(out.text!) as Snap;

    it('no text runs, every element and its ref, and a ref from it acts', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      twist.read = { extra: [NEWS] };
      const full = snap(await t.call('snapshot', { tab_id: t.tab }));
      const outline = snap(await t.call('snapshot', { tab_id: t.tab, text: false }));
      expect(full.content).toContain('- text: "Breaking: the shop is open late tonight"');
      expect(outline.content).toBe(full.content.split('\n').filter((l) => !l.includes('- text:')).join('\n'));
      expect(outline.refs).toBe(full.refs);
      const home = /link "Home" \[ref=(e\d+)\]/.exec(outline.content)![1]!;
      expect(result(await t.call('click', { tab_id: t.tab, ref: home })).data).toMatchObject({ done: 'Clicked “Home”' });
    });

    it('never the diff’s baseline: an action after it says what changed since the last full snapshot', async () => {
      const twist: Twist = {};
      // acting() took a full snapshot: the baseline.
      const t = await acting({ twist });
      // The page shows a new text; the outline without text doesn't show it.
      twist.read = { extra: [NEWS] };
      const outline = snap(await t.call('snapshot', { tab_id: t.tab, text: false }));
      expect(outline.content).not.toContain('Breaking');
      // The diff after a click compares with the full snapshot before it: the text it never showed is new.
      const clicked = result(await t.call('click', { tab_id: t.tab, ref: /link "Home" \[ref=(e\d+)\]/.exec(outline.content)![1]! }));
      expect((clicked.data['page_changes'] as { lines: string[] }).lines).toEqual(['+ - text: "Breaking: the shop is open late tonight"']);
    });

    it('with no full snapshot of the page: an action says what changed can’t be told, never silence', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      // A new page (its refs and outline gone), seen only without its text.
      await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b' });
      const outline = snap(await t.call('snapshot', { tab_id: t.tab, text: false }));
      const clicked = result(await t.call('click', { tab_id: t.tab, ref: /link "Home" \[ref=(e\d+)\]/.exec(outline.content)![1]! }));
      expect(clicked.data['page_changes']).toMatchObject({ note: 'You have no full snapshot of this page to compare with, so what changed can’t be told: call snapshot without text: false to see it.' });
      // A full snapshot then: the next action's diff is a diff again.
      await t.call('snapshot', { tab_id: t.tab });
      const again = result(await t.call('click', { tab_id: t.tab, ref: /link "Home" \[ref=(e\d+)\]/.exec(outline.content)![1]! }));
      expect(again.data['page_changes']).toBeUndefined();
    });

    /** A tab whose snapshot answers `nodes()` each time it's read (cut as `cut()` says); `cards` what it asked. */
    const plain = (nodes: () => unknown[], opts: { needsCard?: boolean; cut?: () => Record<string, boolean>; onRead?: () => void; url?: string } = {}) => {
      let reads = 0;
      const t = setup({
        read: async (code: string) => (code.includes('__chordSnapshots') ? (reads++, opts.onRead?.(), { url: opts.url ?? 'https://news.test/a', title: 'Page', nodes: nodes(), cut: opts.cut?.() ?? {} }) : { title: 'Page', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' }),
        actions: true,
        ...(opts.needsCard ? { needsCard: true } : {}),
      });
      return { ...t, tab: t.scope.refs.refFor('n1'), reads: () => reads };
    };
    const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ depth: 0, role: 'button', name: `Button ${i}`, key: i, sid: i + 1 }));

    it('a page of nothing but text says so; never a find that matched nothing, nor one that matched only text, nor a read cut short (round 1 of #247)', async () => {
      // [the page, the call's arguments, the note]
      const table: [string, ReturnType<typeof plain>, Record<string, unknown>, string | undefined][] = [
        ['nothing but text', plain(() => [NEWS]), {}, ONLY_TEXT],
        // A find on a page of nothing but text: its outline is empty because of the find, not the page (round 2 of #247).
        ['nothing but text, a find that matches nothing', plain(() => [NEWS]), { find: 'zzz' }, undefined],
        ['controls, a find that matches nothing', plain(() => buttons(3)), { find: 'zzz' }, undefined],
        ['controls and text, a find that matches only the text', plain(() => [...buttons(3), NEWS]), { find: 'Breaking' }, undefined],
        ['text, the read cut before the structure', plain(() => [NEWS], { cut: () => ({ elements: true }) }), {}, 'The page is too big to read whole in one snapshot: this is its start.'],
      ];
      for (const [page, t, args, note] of table) {
        const out = snap(await t.call('snapshot', { tab_id: t.tab, text: false, ...args }));
        expect(out.note, page).toBe(note);
      }
      // Its later range, from the outline's slot, says it too, with no read (round 2 of #247).
      const poem = plain(() => [NEWS]);
      await poem.call('snapshot', { tab_id: poem.tab, text: false });
      expect(snap(await poem.call('snapshot', { tab_id: poem.tab, text: false, start: 1 })).note).toBe(ONLY_TEXT);
      expect(poem.reads()).toBe(1);
    });

    it('a full outline’s range after an outline without text is a new read, never the full one kept; a find’s range is of its kind (round 2 of #247, Fable’s S2 a and b)', async () => {
      // a. Full, then without text, then a full range: a third read (the full outline kept is another read's offsets).
      const t = plain(() => [...buttons(3), NEWS]);
      await t.call('snapshot', { tab_id: t.tab });
      await t.call('snapshot', { tab_id: t.tab, text: false });
      await t.call('snapshot', { tab_id: t.tab, start: 1 });
      expect(t.reads()).toBe(3);
      // b. A find without text, then a range: the range is the outline without text, never one with the page's text.
      const u = plain(() => [...buttons(3), NEWS]);
      await u.call('snapshot', { tab_id: u.tab, text: false, find: 'Button 1' });
      const range = snap(await u.call('snapshot', { tab_id: u.tab, text: false, start: 1 }));
      expect(u.reads()).toBe(1);
      expect(range.content).not.toMatch(/- text:/);
      expect(range.content).toContain('button "Button 2"');
    });

    it('its later ranges are of the outline it gave, one card for it: never the live page again, nor another outline’s offsets (round 1 of #247, Fable’s S1)', async () => {
      let many = true;
      const t = plain(() => buttons(many ? 6 : 2), { needsCard: true });
      const first = snap(await t.call('snapshot', { tab_id: t.tab, text: false }));
      const second = first.content.indexOf('\n') + 1;
      // The page shrinks between ranges: the next range is still the outline it gave, read once, one card asked.
      many = false;
      const range = snap(await t.call('snapshot', { tab_id: t.tab, text: false, start: second }));
      expect(range.content).toBe(first.content.slice(second));
      expect(t.reads()).toBe(1);
      expect(t.cards).toHaveLength(1);
      // A full outline's range now: the agent's latest read was without text, so its offsets are another outline's: the
      // page is read again (a card with it).
      snap(await t.call('snapshot', { tab_id: t.tab, start: second }));
      expect(t.reads()).toBe(2);
      expect(t.cards).toHaveLength(2);
      // After a full snapshot, an outline without text's range is never the old one's.
      snap(await t.call('snapshot', { tab_id: t.tab }));
      snap(await t.call('snapshot', { tab_id: t.tab, text: false, start: 1 }));
      expect(t.reads()).toBe(4);
    });

    it('after an outline without text, a diff’s notes say to call snapshot without text: false, so it never loops (round 1 of #247, Fable’s S2)', async () => {
      // Much changed since the full snapshot.
      const twist: Twist = {};
      const t = await acting({ twist });
      await t.call('snapshot', { tab_id: t.tab, text: false });
      twist.read = { extra: Array.from({ length: 70 }, (_, i) => ({ depth: 0, role: 'button', name: `New ${i}`, key: 100 + i, sid: 200 + i })) };
      expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes']).toMatchObject({ note: 'Much of the page changed: call snapshot without text: false to see it.' });
      // The full snapshot it compares with was cut short.
      const cut: Twist = { read: { cut: { elements: true } } };
      const u = await acting({ twist: cut });
      cut.read = {};
      await u.call('snapshot', { tab_id: u.tab, text: false });
      expect(result(await u.call('hover', { tab_id: u.tab, ref: 'e1' })).data['page_changes']).toMatchObject({ note: 'Your last full snapshot of this page was cut short, so what changed can’t be told: call snapshot without text: false to see it.' });
    });

    it('an outline without text landing while a diff’s read is out: the diff gives way, never issued on top of it (round 1 of #247, Neon’s SF2)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      const pageId = (JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { page_id: string }).page_id;
      const refs = t.scope.memory.elements!.get('n1')!;
      ELEMENTS.push({ role: 'button', name: 'Raise' });
      try {
        // Meanwhile the agent's outline without text lands (as the #145 round-2 test lands a full one): its refs issued,
        // its outline kept in its own slot, no baseline.
        twist.read = {
          meanwhile: () => {
            twist.read = {};
            refs.issue(pageId, 'outline', [0, 1, 2, 3, 4, 5], new Map([0, 1, 2, 3, 4, 5].map((k) => [k, k + 1])));
            refs.rememberTextless({ ...refs.outline(pageId)!, text: '- link "Home"' });
          },
        };
        const issuedBefore = refs.issues;
        const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
        expect(out.data['page_changes']).toBeUndefined();
        // Only the outline's refs were issued, never the diff's on top of them.
        expect(refs.issues).toBe(issuedBefore + 1);
      } finally {
        ELEMENTS.pop();
      }
    });

    it('read under every rule snapshot keeps, with text: false as without (round 1 of #247, Neon’s N2, Fable’s S3)', async () => {
      const NEVER_READ = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';
      const NOTHING = 'The user set you to read nothing, in Settings → Assistant.';
      // [the case, the tab, what it says, the tab's page as it's read (given the scope to change)]
      type Row = [string, string, string, (scope: { neverSites: () => readonly string[]; off: () => string | null }) => Parameters<typeof plain>[1]];
      const rows: Row[] = [
        ['a Never site added as it was read', 'n1', NEVER_READ, (scope) => ({ onRead: () => void (scope.neverSites = () => ['private.test', 'news.test']) })],
        ['a read from a Never address', 'n1', NEVER_READ, () => ({ url: 'https://private.test/inbox' })],
        ['Settings’ Nothing as it was read', 'n1', NOTHING, (scope) => ({ onRead: () => void (scope.off = () => NOTHING) })],
        ['a private window’s tab', 'n2', NEVER_READ, () => ({})],
      ];
      // (And a flat find, round 1 of #263: the same read, the same rules.)
      for (const text of [undefined, false, 'find']) {
        for (const [what, tab, says, page] of rows) {
          const holder: { scope?: { neverSites: () => readonly string[]; off: () => string | null } } = {};
          const opts = page(new Proxy({} as { neverSites: () => readonly string[]; off: () => string | null }, { set: (_o, k, v) => ((holder.scope as Record<string | symbol, unknown>)[k] = v, true) }));
          const t = plain(() => buttons(2), opts);
          holder.scope = t.scope as unknown as typeof holder.scope;
          if (text === 'find') (t.scope as { findFlat?: boolean }).findFlat = true;
          const out = await t.call('snapshot', { tab_id: t.scope.refs.refFor(tab), ...(text === false ? { text } : text === 'find' ? { find: 'Button' } : {}) });
          expect(refusal(out).refused, `${what}, text: ${String(text)}`).toBe(says);
          // Nothing of it kept: no refs issued at all.
          expect(t.scope.memory.elements?.get(tab)?.issues ?? 0, what).toBe(0);
        }
      }
      // A later range served from the outline's slot is read under them too (round 2 of #247, Fable's S2 c): the site
      // made Never, or Settings' Nothing, since the outline was given.
      const later: [string, (t: ReturnType<typeof plain>) => void, string][] = [
        ['the site made Never since', (t) => void ((t.scope as { neverSites: () => readonly string[] }).neverSites = () => ['private.test', 'news.test']), NEVER_READ],
        ['Settings’ Nothing since', (t) => void ((t.scope as { off: () => string | null }).off = () => NOTHING), NOTHING],
      ];
      for (const [what, since, says] of later) {
        const t = plain(() => buttons(4));
        await t.call('snapshot', { tab_id: t.tab, text: false });
        since(t);
        expect(refusal(await t.call('snapshot', { tab_id: t.tab, text: false, start: 1 })).refused, what).toBe(says);
        expect(t.reads(), what).toBe(1);
      }
    });
  });


  describe('read_tab by a part’s container ref (S18 M2g-2, #207)', () => {
    const ORDERS = { depth: 0, role: 'region', name: 'Orders', sid: 50, box: 0 };
    const NEVER_READ = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';
    /** An agent's tab whose page has a part (Orders), snapshot taken: the scope reads parts. */
    const withParts = async (opts: { boxes?: boolean } = {}) => {
      const twist: Twist = { read: { extra: [ORDERS] } };
      const t = await acting({ twist });
      if (opts.boxes !== false) (t.scope as { boxes?: boolean }).boxes = true;
      const snap = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { content: string; page_id: string };
      // Its c ref, numbered as element refs are (round 1 of #260): read from the outline.
      const part = /region "Orders" \[ref=(c\d+)\]/.exec(snap.content)?.[1] ?? 'c0';
      return { ...t, twist, snap, part };
    };
    type Part = { trust: string; source: string; content: string; part: { ref: string; role: string; name: string }; range: { start: number; end: number; total: number } };

    it('the outline gives the part a c ref, and read_tab reads just its text: untrusted, which part, in ranges', async () => {
      const t = await withParts();
      expect(t.snap.content).toMatch(/- region "Orders" \[ref=c\d+\]/);
      const out = JSON.parse((await t.call('read_tab', { tab_id: t.tab, ref: t.part })).text!) as Part;
      expect(out).toMatchObject({ trust: 'untrusted', source: 'web_page', content: 'Order 12 shipped. Order 15 is on its way.', part: { ref: t.part, role: 'region', name: 'Orders' } });
      // Capped and in ranges, as read_tab is.
      const range = JSON.parse((await t.call('read_tab', { tab_id: t.tab, ref: t.part, start: 9, length: 7 })).text!) as Part;
      expect(range.content).toBe('shipped');
      expect(range.range).toEqual({ start: 9, end: 16, total: 41 });
    });

    it('never given where the scope doesn’t read parts (the assistant): no c refs in its outline', async () => {
      const t = await withParts({ boxes: false });
      expect(t.snap.content).toContain('- region "Orders"');
      expect(t.snap.content).not.toMatch(/ref=c/);
    });

    it('refused, and never read, when it isn’t the part the outline showed, or the page may not be read', async () => {
      // [the case, what happens, what it says]
      const table: [string, (t: Awaited<ReturnType<typeof withParts>>) => Promise<unknown> | void, string][] = [
        ['a ref never given', () => undefined, PART_REFUSALS.unknown],
        ['the part changed in the page (its role, name, or gone)', (t) => void (t.twist.part = () => ({ ok: false, why: 'stale' })), PART_REFUSALS.stale],
        ['the page went to another document since the snapshot', (t) => void t.pages.get('n1')!.events.emit('did-navigate'), PART_REFUSALS.stale],
        ['the page went to another document as it was read', (t) => void (t.twist.part = (events) => (events.emit('did-navigate'), { ok: true, url: 'https://news.test/a', role: 'region', name: 'Orders', text: 'x' })), PART_REFUSALS.stale],
        ['the page an editor', (t) => void (t.twist.part = () => ({ ok: false, why: 'editor' })), PART_REFUSALS.editor],
        ['the site made Never since', (t) => void ((t.scope as { neverSites: () => readonly string[] }).neverSites = () => ['private.test', 'news.test']), NEVER_READ],
        ['the read from a Never address', (t) => void (t.twist.part = () => ({ ok: true, url: 'https://private.test/inbox', role: 'region', name: 'Orders', text: 'secret' })), NEVER_READ],
        ['Settings’ Nothing as it was read', (t) => void (t.twist.part = () => (((t.scope as { off: () => string | null }).off = () => 'The user set you to read nothing, in Settings → Assistant.'), { ok: true, url: 'https://news.test/a', role: 'region', name: 'Orders', text: 'x' })), 'The user set you to read nothing, in Settings → Assistant.'],
      ];
      for (const [what, arrange, says] of table) {
        const t = await withParts();
        await arrange(t);
        const out = await t.call('read_tab', { tab_id: t.tab, ref: what === 'a ref never given' ? 'c999999' : t.part });
        expect(out.isError, what).toBe(true);
        expect(refusal(out).refused, what).toBe(says);
        expect(out.text, what).not.toMatch(/secret|Order 12/);
      }
    });

    it('a c ref from the page before never reads one of this page: the page’s own ids start over, refs never do (round 1 of #260)', async () => {
      const t = await withParts();
      // The tab goes to another document with a part the page script numbers the same.
      await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b' });
      const b = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as { content: string };
      expect(b.content).toMatch(/- region "Orders" \[ref=c\d+\]/);
      expect(b.content).not.toContain(`[ref=${t.part}]`);
      t.twist.part = () => ({ ok: true, url: 'https://news.test/b', role: 'region', name: 'Orders', text: 'Page B’s orders.' });
      const old = await t.call('read_tab', { tab_id: t.tab, ref: t.part });
      expect(old.isError).toBe(true);
      expect(refusal(old).refused).toBe(PART_REFUSALS.unknown);
      expect(old.text).not.toContain('Page B');
    });

    it('Stop as it was read: stopped, and nothing of it kept (round 1 of #260)', async () => {
      const t = await withParts();
      (t.scope.memory as { readFrom?: Set<string> }).readFrom = new Set();
      t.twist.part = () => (t.agent.stop(), { ok: true, url: 'https://elsewhere.test/a', role: 'region', name: 'Orders', text: 'x' });
      expect(refusal(await t.call('read_tab', { tab_id: t.tab, ref: t.part })).refused).toBe(CONTROL_REFUSALS.stopped);
      // Never marked as read from where it was (what typing in a page checks), nor in the activity.
      expect([...t.scope.memory.readFrom!]).toEqual([]);
      expect(t.activity).not.toContain('Read a part of “Article”');
    });

    it('read, it’s marked as read from where it was, as any read is (round 1 of #260)', async () => {
      const t = await withParts();
      (t.scope.memory as { readFrom?: Set<string> }).readFrom = new Set();
      t.twist.part = () => ({ ok: true, url: 'https://news.test/a', role: 'region', name: 'Orders', text: 'x' });
      await t.call('read_tab', { tab_id: t.tab, ref: t.part });
      expect([...t.scope.memory.readFrom!]).toEqual(['https://news.test']);
    });

    it('an outside agent’s part over 20000 characters reads 20000 when it asks for no length, or one that isn’t a number (round 1 of #260)', async () => {
      const t = await withParts();
      (t.scope as { readDefault?: number }).readDefault = AGENT_READ_DEFAULT;
      t.twist.part = () => ({ ok: true, url: 'https://news.test/a', role: 'region', name: 'Orders', text: 'abcdefghij'.repeat(5_000) });
      for (const length of [undefined, Number.NaN]) {
        const out = JSON.parse((await t.call('read_tab', { tab_id: t.tab, ref: t.part, ...(length === undefined ? {} : { length }) })).text!) as Part;
        expect(out.range, String(length)).toEqual({ start: 0, end: 20_000, total: 50_000 });
      }
    });

    it('a c ref is read-only: every acting tool, and batch, refuses it before anything is pressed', async () => {
      const t = await withParts();
      const calls: [string, Record<string, unknown>][] = [
        ['click', {}],
        ['type', { text: 'hello' }],
        ['press_key', { key: 'Enter' }],
        ['select_option', { option: 'Express' }],
        ['hover', {}],
      ];
      t.steps.length = 0;
      for (const [tool, args] of calls) {
        const out = await t.call(tool, { tab_id: t.tab, ref: t.part, ...args });
        expect(refusal(out).refused, tool).toBe(PART_REFUSALS.act);
      }
      const batched = await runBatch(t.scope, t.browser, { tab_id: t.tab, steps: [{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: t.part }] }, new AbortController().signal);
      expect(batched.isError).toBe(true);
      expect(batched.text).toContain(PART_REFUSALS.act);
      // Nothing was described, pointed at or pressed.
      expect(t.steps).toEqual([]);
      expect(t.cards).toHaveLength(0);
    });
  });

  describe('find, flat, and only the refs shown acted on (S18 M2g-2, #208)', () => {
    /** Twelve rows alike after the page's elements: past ROWS_COLLAPSE, five shown, the rest said in one line. */
    const ROWS = Array.from({ length: 12 }, (_, i) => [
      { depth: 0, role: 'listitem', name: '', sid: 100 + 2 * i },
      { depth: 1, role: 'button', name: `Act ${i}`, key: 20 + i, sid: 101 + 2 * i },
    ]).flat();
    type Snap = { content: string; note?: string; page_id: string };
    const withRows = async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      twist.read = { extra: ROWS };
      (t.scope as { findFlat?: boolean }).findFlat = true;
      const snap = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as Snap;
      return { ...t, twist, snap };
    };

    it('a collapsed row’s ref is never acted on until a line shows it (a find): click and batch refuse it', async () => {
      const t = await withRows();
      expect(t.snap.content).toContain('more listitem like these');
      // Act 11's row is collapsed: its ref exists (by its page id), never shown.
      const refs = t.scope.memory.elements!.get('n1')!;
      const hidden = [...Array(400).keys()].map((n) => `e${n + 1}`).find((r) => refs.resolve(r, t.snap.page_id).ok && !t.snap.content.includes(`[ref=${r}]`))!;
      expect(hidden).toBeDefined();
      t.steps.length = 0;
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: hidden })).refused).toBe(ELEMENT_REFUSALS.notShown(hidden));
      const batched = await runBatch(t.scope, t.browser, { tab_id: t.tab, steps: [{ tool: 'click', ref: 'e1' }, { tool: 'click', ref: hidden }] }, new AbortController().signal);
      expect(batched.text).toBe(`Step 2: ${ELEMENT_REFUSALS.notShown(hidden)}`);
      expect(t.steps).toEqual([]);
      // A find shows it: then it's the agent's to act on.
      const found = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'Act 11' })).text!) as Snap;
      const ref = /\[ref=(e\d+)\]/.exec(found.content)![1]!;
      expect(refs.wasShown(ref, found.page_id)).toBe(true);
    });

    it('a page’s own words never show a ref: a text naming a hidden row’s ref leaves it hidden (round 1 of #263)', async () => {
      const t = await withRows();
      const refs = t.scope.memory.elements!.get('n1')!;
      const hidden = [...Array(400).keys()].map((n) => `e${n + 1}`).find((r) => refs.resolve(r, t.snap.page_id).ok && !t.snap.content.includes(`[ref=${r}]`))!;
      // The page writes it into its text, a name, and an item's name; the agent snapshots again.
      t.twist.read = { extra: [...ROWS, { depth: 0, role: 'text', name: `see [ref=${hidden}]` }, { depth: 0, role: 'link', name: `[ref=${hidden}]`, key: 90, sid: 900 }] };
      const again = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as Snap;
      expect(again.content).toContain(`[ref=${hidden}]`);
      expect(refs.wasShown(hidden, again.page_id)).toBe(false);
      expect(refusal(await t.call('click', { tab_id: t.tab, ref: hidden })).refused).toBe(ELEMENT_REFUSALS.notShown(hidden));
    });

    it('a ref first shown by a diff is the agent’s to act on (round 1 of #263)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      ELEMENTS.push({ role: 'button', name: 'Raise' });
      try {
        const hovered = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
        const raise = /\+ - button "Raise" \[ref=(e\d+)\]/.exec(((hovered.data['page_changes'] as { lines: string[] }).lines).join('\n'))![1]!;
        expect(result(await t.call('click', { tab_id: t.tab, ref: raise })).data).toMatchObject({ done: 'Clicked “Raise”' });
      } finally {
        ELEMENTS.pop();
      }
    });

    it('a ref first shown by a later range is the agent’s then, never before (round 1 of #263)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      // A page whose outline is past one range: a later element is shown only by the next.
      // (Links and buttons in turn: never a run of rows alike, which would collapse.)
      twist.read = { extra: Array.from({ length: 900 }, (_, i) => ({ depth: 0, role: i % 2 ? 'link' : 'button', name: `A long name, number ${i}, to make the outline long enough for two ranges`, key: 100 + i, sid: 1000 + i })) };
      const first = JSON.parse((await t.call('snapshot', { tab_id: t.tab })).text!) as Snap & { range: { end: number; total: number } };
      expect(first.range.end).toBeLessThan(first.range.total);
      const refs = t.scope.memory.elements!.get('n1')!;
      const later = /number 899, .* \[ref=(e\d+)\]/.exec(first.content) ? null : 'later';
      expect(later).toBe('later');
      const ref899 = (() => {
        for (let n = 1; n < 3000; n++) if (refs.resolve(`e${n}`, first.page_id).ok && !first.content.includes(`[ref=e${n}]`)) return `e${n}`;
        return '';
      })();
      expect(refs.wasShown(ref899, first.page_id)).toBe(false);
      const next = JSON.parse((await t.call('snapshot', { tab_id: t.tab, start: first.range.end })).text!) as Snap;
      expect(next.content).toContain(`[ref=${ref899}]`);
      expect(refs.wasShown(ref899, first.page_id)).toBe(true);
    });

    it('a flat find gives only its own lines’ part refs; a find of spaces is no find; a cut read keeps its note; after it, a diff says to snapshot without find (round 1 of #263)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      (t.scope as { findFlat?: boolean; boxes?: boolean }).findFlat = true;
      (t.scope as { boxes?: boolean }).boxes = true;
      twist.read = { extra: [{ depth: 0, role: 'region', name: 'Orders', sid: 60, box: 0 }, { depth: 0, role: 'region', name: 'Returns', sid: 61, box: 1 }] };
      const found = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'Orders' })).text!) as Snap;
      const shown = /region "Orders" \[ref=(c\d+)\]/.exec(found.content)![1]!;
      const refs = t.scope.memory.elements!.get('n1')!;
      expect(refs.resolveBox(shown, found.page_id).ok).toBe(true);
      // Returns' part was never on a line it showed: no ref for it.
      for (let n = 1; n < 2000; n++) if (`c${n}` !== shown) expect(refs.resolveBox(`c${n}`, found.page_id).ok).toBe(false);
      // A find of nothing but spaces: no find (the whole outline, as a snapshot is).
      const spaces = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: '   ' })).text!) as Snap;
      expect(spaces.content).toContain('combobox "Shipping"');
      expect(spaces.content).toContain('region "Returns"');
      // …and taken as a snapshot: the agent's latest read is no find (it's the diff's baseline again).
      expect(refs.lastWasFind(spaces.page_id)).toBe(false);
      // A read cut short, nothing matched: both said.
      twist.read = { cut: { elements: true } };
      const cut = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'zebra' })).text!) as Snap;
      expect(cut.note).toBe(`${FIND_NONE_NOTE} The page is too big to read whole in one snapshot: this is its start.`);
      // After a find, much changed: the note says to snapshot without find.
      twist.read = { extra: Array.from({ length: 70 }, (_, i) => ({ depth: 0, role: 'button', name: `New ${i}`, key: 200 + i, sid: 2000 + i })) };
      expect(result(await t.call('hover', { tab_id: t.tab, ref: 'e1' })).data['page_changes']).toMatchObject({ note: 'Much of the page changed: call snapshot without find to see it.' });
    });

    it('a diff never shows a ref its text names: neither a gone line’s, nor one a new text writes (round 2 of #263, S3)', async () => {
      const t = await withRows();
      const refs = t.scope.memory.elements!.get('n1')!;
      const hidden = [...Array(400).keys()].map((n) => `e${n + 1}`).find((r) => refs.resolve(r, t.snap.page_id).ok && !t.snap.content.includes(`[ref=${r}]`))!;
      // The page drops Shipping (a gone line names its ref) and shows a text naming the hidden row's ref.
      const without = [...ROWS, { depth: 0, role: 'text', name: `now see [ref=${hidden}]` }];
      t.twist.read = { extra: without };
      ELEMENTS.splice(2, 1);
      try {
        const out = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
        const lines = ((out.data['page_changes'] as { lines?: string[] }).lines ?? []).join('\n');
        expect(lines).toContain(`[ref=${hidden}]`);
        expect(refs.wasShown(hidden, t.snap.page_id)).toBe(false);
      } finally {
        ELEMENTS.splice(2, 0, { role: 'combobox', name: 'Shipping', select: true, options: ['Standard', 'Express', 'Pickup', 'Pickup'] });
      }
    });

    it('after a find, a diff’s notes say to snapshot without find: with no full snapshot of the page, and with one cut short (round 2 of #263)', async () => {
      // No full snapshot of the page: a new page, found in alone.
      const twist: Twist = {};
      const t = await acting({ twist });
      (t.scope as { findFlat?: boolean }).findFlat = true;
      await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/b' });
      const found = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'Home' })).text!) as Snap;
      const home = /\[ref=(e\d+)\]/.exec(found.content)![1]!;
      expect(result(await t.call('hover', { tab_id: t.tab, ref: home })).data['page_changes']).toMatchObject({ note: 'You have no full snapshot of this page to compare with, so what changed can’t be told: call snapshot without find to see it.' });
      // The full one cut short, then a find.
      const cut: Twist = { read: { cut: { elements: true } } };
      const u = await acting({ twist: cut });
      (u.scope as { findFlat?: boolean }).findFlat = true;
      cut.read = {};
      await u.call('snapshot', { tab_id: u.tab, find: 'Home' });
      expect(result(await u.call('hover', { tab_id: u.tab, ref: 'e1' })).data['page_changes']).toMatchObject({ note: 'Your last full snapshot of this page was cut short, so what changed can’t be told: call snapshot without find to see it.' });
    });

    it('a flat find is read unpinned: it never takes the agent’s full snapshot’s place in the page (round 2 of #263)', async () => {
      const twist: Twist = { codes: [] };
      const t = await acting({ twist });
      (t.scope as { findFlat?: boolean }).findFlat = true;
      twist.codes = [];
      await t.call('snapshot', { tab_id: t.tab, find: 'Home' });
      const reads = twist.codes.filter((c) => c.includes('__chordSnapshots') && c.includes('"owner"'));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((c) => c.includes('"pinned":false'))).toBe(true);
    });

    it('a flat find of a password field: its line, never a ref, never its value (round 1 of #263)', async () => {
      const twist: Twist = {};
      const t = await acting({ twist });
      (t.scope as { findFlat?: boolean }).findFlat = true;
      twist.read = { extra: [{ depth: 0, role: 'textbox', name: 'Password', key: 50, sid: 500, states: ['filled'], field: { type: 'password', autocomplete: 'current-password', name: 'pw', id: 'pw', label: 'Password', placeholder: '' } }] };
      const found = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'password' })).text!) as Snap;
      expect(found.content).toBe('- textbox "Password" [password: the user signs in]');
    });

    it('a find is flat, with its items; with no match, the nearest names and Chord’s own note; never the diff’s baseline', async () => {
      const t = await withRows();
      const found = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'Act 3' })).text!) as Snap;
      expect(found.content).toMatch(/^- button "Act 3" \[ref=e\d+\]$/);
      const none = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'the shipping options' })).text!) as Snap;
      expect(none.note).toBe(FIND_NEAREST_NOTE);
      expect(none.content).toContain('combobox "Shipping"');
      const nothing = JSON.parse((await t.call('snapshot', { tab_id: t.tab, find: 'zebra' })).text!) as Snap;
      expect(nothing).toMatchObject({ note: FIND_NONE_NOTE, content: '' });
      // The diff after an action compares with the last full snapshot, never a find's view: a text shown since is new.
      t.twist.read = { extra: [...ROWS, { depth: 0, role: 'text', name: 'Saved' }] };
      await t.call('snapshot', { tab_id: t.tab, find: 'Act 3' });
      const clicked = result(await t.call('hover', { tab_id: t.tab, ref: 'e1' }));
      expect((clicked.data['page_changes'] as { lines: string[] }).lines).toEqual(['+ - text: "Saved"']);
    });
  });

  it('look-alikes the page redrew: refused, saying how to choose, and nothing pressed (#211)', async () => {
    const twist: Twist = {};
    const t = await acting({ twist });
    twist.ambiguous = true;
    t.steps.length = 0;
    // Without the flat find (the packaged assistant's): never told to find by the row's words, which it can't.
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.ambiguousPlain);
    expect(t.steps).toEqual(['describe']);
    (t.scope as { findFlat?: boolean }).findFlat = true;
    t.steps.length = 0;
    expect(refusal(await t.call('click', { tab_id: t.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.ambiguous);
    expect(t.steps).toEqual(['describe']);
    // The debugger's look at the element (deep.open) says so too, never "no check" (#211's review).
    const u = await acting({ twist: { replaced: { describe: 1 } }, deep: { opens: ['ambiguous'] } });
    (u.scope as { findFlat?: boolean }).findFlat = true;
    expect(refusal(await u.call('click', { tab_id: u.tab, ref: 'e1' })).refused).toBe(ACT_REFUSALS.ambiguous);
    expect((u.at.input as { type: string }[]).filter((e) => e.type === 'mouseDown')).toEqual([]);
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
