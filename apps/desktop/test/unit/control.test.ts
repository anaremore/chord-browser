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
import type { ControlScope, ToolMemory } from '../../src/main/control/scope';
import { runControlTool, type ControlBrowser } from '../../src/main/control/tools';

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
  const contents = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
    once: (e: string, f: (...a: unknown[]) => void) => events.once(e, f),
    off: (e: string, f: (...a: unknown[]) => void) => events.off(e, f),
    executeJavaScriptInIsolatedWorld: (_world: number, [script]: { code: string }[]) =>
      typeof read === 'function'
        ? read(script!.code, events)
        : read === 'hang'
          ? new Promise(() => undefined)
          : Promise.resolve({ title: 'Article', url, contentType: 'text/html', text: read.text, selection: '' }),
  };
  return { contents: contents as unknown as WebContents, events };
}

function setup(opts: { needsCard?: boolean; answer?: Grant | 'hold'; read?: Answer; cardWaitMs?: number } = {}) {
  const nodes = [tab('n1', 'https://news.test/a'), tab('n2', 'https://private.test/'), tab('n3', 'https://news.test/b')];
  let state = stateWith(nodes);
  const pages = new Map<NodeId, ReturnType<typeof fakePage>>(nodes.map((n) => [n.id, fakePage(n.url, opts.read ?? { text: `Text of ${n.id}` })]));
  const view = (id: NodeId) => (pages.has(id) ? ({ webContents: pages.get(id)!.contents } as WebContentsView) : undefined);
  const browser: ControlBrowser = {
    store: {
      get state() {
        return state;
      },
    },
    tabs: { get: view, ensure: view },
    readers: { viewFor: () => undefined },
  };
  const cards: ControlCard[] = [];
  const agent = new ControlAgent('test', (c, signal) => {
    cards.push(c);
    if (opts.answer !== 'hold') return Promise.resolve(opts.answer ?? 'once');
    return new Promise<Grant>((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
  });
  const activity: string[] = [];
  const memory: ToolMemory = { pdfs: new Map(), form: null, nextField: 1, read: new Set() };
  const scope: ControlScope = {
    agent,
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
    activity: async (_tool, summary) => void activity.push(summary),
  };
  const call = (name: string, args: Record<string, unknown> = {}) => runControlTool(scope, browser, name, args);
  const close = (id: NodeId) => {
    state = stateWith(nodes.filter((n) => n.id !== id));
  };
  return { scope, agent, call, close, cards, activity, pages };
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
