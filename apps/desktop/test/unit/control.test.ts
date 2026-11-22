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
import { runControlTool, type ControlBrowser } from '../../src/main/control/tools';
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
  const at: { url: string; onCapture?: () => void; pdfLandsAt?: string; zoom: number; input: unknown[]; text: string[]; loads: string[]; back: number } = { url, zoom: 1, input: [], text: [], loads: [], back: 0 };
  const contents = {
    // Acting (S18 M2c): what an action sends, recorded.
    getZoomFactor: () => at.zoom,
    sendInputEvent: (e: unknown) => void at.input.push(e),
    setIgnoreMenuShortcuts: () => undefined,
    insertText: async (text: string) => void at.text.push(text),
    getTitle: () => 'Article',
    loadURL: async (to: string) => {
      at.loads.push(to);
      at.url = to;
      events.emit('did-navigate');
      events.emit('did-stop-loading');
    },
    navigationHistory: {
      canGoBack: () => at.loads.length > 0,
      goBack: () => {
        at.back++;
        events.emit('did-navigate');
        events.emit('did-stop-loading');
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
  type El = { role: string; name: string; editable?: boolean; select?: boolean; disabled?: boolean; options?: string[]; cover?: { role: string; name: string } };
  const ELEMENTS: El[] = [
    { role: 'link', name: 'Home' },
    { role: 'searchbox', name: 'Search', editable: true },
    { role: 'combobox', name: 'Shipping', select: true, options: ['Standard', 'Express'] },
    { role: 'button', name: 'Cancel', disabled: true },
    { role: 'button', name: 'Buy', cover: { role: 'dialog', name: 'Cookie settings' } },
  ];
  /** A page answering the snapshot script with ELEMENTS, and each act step; `steps` records them. */
  const page = (steps: string[], onAct?: (events: EventEmitter, op: string) => void) => async (code: string, events: EventEmitter) => {
    if (code.includes('new MutationObserver(() =>')) {
      onAct?.(events, 'settle');
      return true;
    }
    const args = JSON.parse(code.slice(code.lastIndexOf('})(') + 3, -1)) as { op?: string; key?: number; option?: string; token?: string };
    if (args.op) {
      steps.push(args.op);
      onAct?.(events, args.op);
      const el = ELEMENTS[args.key!]!;
      const said = { role: el.role, name: el.name };
      if (args.op === 'describe') return { ok: true, ...said, editable: Boolean(el.editable), select: Boolean(el.select), disabled: Boolean(el.disabled) };
      if (args.op === 'point') return el.cover ? { ok: false, why: 'covered', cover: el.cover } : { ok: true, ...said, x: 10, y: 20 };
      if (args.op === 'choose') return el.options?.includes(args.option!) ? { ok: true, ...said, choice: args.option } : { ok: false, why: 'no-choice' };
      return { ok: true, ...said };
    }
    if (code.includes('__chordSnapshots')) return { url: 'https://news.test/a', title: 'Shop', nodes: ELEMENTS.map((e, key) => ({ depth: 0, role: e.role, name: e.name, key })), cut: {} };
    return { title: 'Article', url: 'https://news.test/a', contentType: 'text/html', text: 'x', selection: '' };
  };
  const result = (out: { text?: string }) => JSON.parse(out.text!) as { data: Record<string, unknown> };

  async function acting(opts: { answer?: Grant; act?: Partial<ActHost>; onAct?: (events: EventEmitter, op: string) => void } = {}) {
    const steps: string[] = [];
    const doings: unknown[] = [];
    const kept: string[] = [];
    const t = setup({
      read: page(steps, opts.onAct),
      actions: true,
      answer: opts.answer ?? 'once',
      act: { doing: (_n, d) => void doings.push(d), keepSite: (site) => void kept.push(site), ...opts.act },
    });
    const tab = t.scope.refs.refFor('n1');
    await t.call('snapshot', { tab_id: tab });
    return { ...t, tab, steps, doings, kept, at: t.pages.get('n1')!.at };
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
    expect(t.steps).toEqual(['describe', 'point']);
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
      ['select_option', { ref: 'e3', option: 'Overnight' }, 'There’s no choice “Overnight” in that list. Call snapshot for its choices.'],
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
    expect(t.steps).toEqual(['describe', 'point', 'select']);
    expect(t.at.text).toEqual(['wool scarf']);
    expect((t.at.input as { type: string; keyCode?: string }[]).map((e) => `${e.type}${e.keyCode ? `:${e.keyCode}` : ''}`)).toEqual(['mouseMove', 'mouseDown', 'mouseUp', 'keyDown:Return', 'char:\r', 'keyUp:Return']);
    // replace: false keeps what's there.
    t.steps.length = 0;
    await t.call('type', { tab_id: t.tab, ref: 'e2', text: ' red', replace: false });
    expect(t.steps).toEqual(['describe', 'point']);
  });

  it('press_key focuses the element and sends the key; select_option chooses by label', async () => {
    const t = await acting();
    await t.call('press_key', { tab_id: t.tab, ref: 'e2', key: 'Escape' });
    expect(t.steps).toEqual(['describe', 'point', 'focus']);
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

  it('navigate and back: its own tabs, http and https, never a site kept private; no site card', async () => {
    const t = await acting();
    expect(refusal(await t.call('back', { tab_id: t.tab })).refused).toBe('That tab has nowhere to go back to.');
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'javascript:alert(1)' })).refused).toBe('navigate takes an http or https address of at most 2048 characters.');
    expect(refusal(await t.call('navigate', { tab_id: t.tab, url: 'https://private.test/x' })).refused).toBe('This page can never be read (a private window, a Chord page, or a site the user keeps private).');
    const went = result(await t.call('navigate', { tab_id: t.tab, url: 'https://news.test/returns?token=1' }));
    expect(went.data).toMatchObject({ done: 'Went to news.test/returns', navigated: true });
    expect(t.at.loads).toEqual(['https://news.test/returns?token=1']);
    expect(result(await t.call('back', { tab_id: t.tab })).data).toMatchObject({ done: 'Went back', navigated: true });
    expect(t.cards).toEqual([]);
    expect(t.doings).toEqual([{ tool: 'navigate', to: 'news.test/returns' }, null, { tool: 'back' }, null]);
  });
});
