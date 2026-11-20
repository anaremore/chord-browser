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

  it('takes cards down as a no on Stop, on cancelCards, and when the call’s own signal aborts', async () => {
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
      expect(shown[0]!.signal.aborted).toBe(true);
      // Nothing was kept for good.
      expect(agent.granted('read', 'read_tab')).toBeUndefined();
    }
  });

  it('holds a paused tab’s calls until the user leaves it, or answers waiting after 45 s', async () => {
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
    await expect(waiting).resolves.toBe('waiting');
  });
});

/* ---------- The tools through the gate, on a fake page ---------- */

const tab = (id: string, url: string, title = 'Article'): TabNode => ({ id, kind: 'tab', chordId: 'c1', url, title }) as TabNode;

function stateWith(nodes: TabNode[]): State {
  const buckets: Record<string, Record<string, TabNode>> = {};
  for (const n of nodes) (buckets[bucketOf(n.id)] ??= {})[n.id] = n;
  return { nodes: buckets } as unknown as State;
}

/** A page that answers the extractor with `read`, or never (`hang`). */
function fakePage(url: string, read: 'hang' | { text: string }) {
  const events = new EventEmitter();
  const contents = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
    once: (e: string, f: (...a: unknown[]) => void) => events.once(e, f),
    off: (e: string, f: (...a: unknown[]) => void) => events.off(e, f),
    executeJavaScriptInIsolatedWorld: () =>
      read === 'hang' ? new Promise(() => undefined) : Promise.resolve({ title: 'Article', url, contentType: 'text/html', text: read.text, selection: '' }),
  };
  return { contents: contents as unknown as WebContents, events };
}

function setup(opts: { needsCard?: boolean; answer?: Grant; read?: 'hang' | { text: string } } = {}) {
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
  const agent = new ControlAgent('test', async (c) => (cards.push(c), opts.answer ?? 'once'));
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
    needsCard: () => Boolean(opts.needsCard),
    onScreen: () => 'n1',
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
