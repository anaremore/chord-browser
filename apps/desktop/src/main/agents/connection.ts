/**
 * Chord's side of one agent connection (S18 M1b, M1c): MCP over the endpoint,
 * after the hello. The connection is the agent: its own ControlAgent (the
 * gate), so its connection card, Stop and grants are the shared layer's. The
 * first call waits on the connection card (kind `connection`, subject the
 * client's name): an answer within CONTROL_WAIT_MS lets it go on, none answers
 * *waiting* and the card stays up for the retry, a no answers *denied* now and
 * later.
 *
 * Its tools (M1c) are the shared layer's on its own tabs (scope.ts), plus
 * open_tab and close_tab, which only an agent has: they open and close tabs in
 * its Agent chord (chords.ts). What its tabs held (dialogs, pickers, popups,
 * downloads) comes with its next result. Loaded only when the first connection
 * arrives.
 */
import {
  ACT_REFUSALS,
  CONTROL_REFUSALS,
  CONTROL_WAIT_MS,
  addressWhy,
  barAddress,
  agentToolList,
  agentTools,
  agentToolsVersion,
  isNeverReadable,
  nodeOf,
  toolResult,
  uuidv7,
  type AgentHello,
  type Command,
  type Grant,
  type NodeId,
  type ProfileId,
} from '@chord/core';
import { ControlAgent, type CardPresenter, type ControlCard } from '../control/gate';
import { controlPage } from '../control/page';
import type { ToolOutput } from '../control/scope';
import { runControlTool, type ControlBrowser, pageLoaded } from '../control/tools';
import { pageOf } from '../view-page';
import type { AgentChords } from './chords';
import { siteOfUrl, type AgentShares } from './shares';
import { allowFirstLoad, forgetFirstLoad } from '../control/sends';
import { firstLoadPending, pickersUnsecured } from './pickers';
import type { Send } from './endpoint';
import { agentScope, NOT_YOURS } from './scope';

type Message = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

export interface ConnectionDeps {
  /** Shows the connection card (until Settings → Agents and its card, M1d: the development hook). */
  present: CardPresenter;
  browser: ControlBrowser;
  /** How long a call waits on a card; CONTROL_WAIT_MS (tests shorten it). */
  waitMs?: number;
  /** This build has M2's tools (agentActions); absent, it does. */
  actions?: boolean;
  log?(...args: unknown[]): void;
  /** The agents' chords (main); absent where nothing opens tabs. */
  chords?: AgentChords;
  dispatch?(command: Command): void;
  /** The *Never* list. */
  neverSites?(): readonly string[];
  /** Tabs the user shares with agents (M1e): made with the first share, so often none. */
  shares?(): AgentShares | null;
  /** The sign-ins of the window where the user let the agent in (M1d's card; the development hook: the window used last). */
  allowedProfile?(): ProfileId | null;
  /** How long open_tab waits for its page to load (LOAD_MS). */
  loadMs?: number;
  /** Acting (M2c): the sites it may act on for good (its allowance's), and keeping one (*Always on this site*). */
  sites?: { allowed(site: string): boolean; keep(site: string): void };
}

/** What open_tab waits for its page: at most this long (S18 §5). */
const LOAD_MS = 30_000;
const WEB_ADDRESS = /^https?:\/\/\S+$/i;

/** The client's name as it gives it (`clientInfo.title`, else `name`): a hint, never proof (S18 §3). */
export function clientName(hello: Pick<AgentHello, 'initialize'>): string {
  const info = hello.initialize?.['clientInfo'] as { title?: unknown; name?: unknown } | undefined;
  // Control and format characters (bidi overrides, zero-width ones) never reach a card, a bar or Settings.
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '');
  const name = clean(info?.title) || clean(info?.name);
  return name.slice(0, 60) || 'An agent';
}

let lastAgent = 0;

export interface AgentConnection {
  readonly agent: ControlAgent;
  readonly name: string;
  /** Let in (once or always): only then can tabs be shared with it. */
  readonly allowed: boolean;
  /** When it last called a tool (0: never). */
  readonly lastCallAt: number;
  /** A tab of its own it no longer has (you took it over): its ref now says the tab is closed. */
  forget(nodeId: NodeId): void;
  message(m: Message): void;
  closed(): void;
}

export function agentConnection(hello: Omit<AgentHello, 'token'>, send: Send, deps: ConnectionDeps): AgentConnection {
  const name = clientName(hello);
  const agent = new ControlAgent(`agent:${++lastAgent}`, deps.present);
  const neverSites = () => deps.neverSites?.() ?? [];
  const chordId = () => deps.chords?.chordOf(agent) ?? null;
  const scope = agentScope(agent, {
    actions: deps.actions ?? true,
    state: () => deps.browser.store.state,
    chordId,
    neverSites,
    shared: () => deps.shares?.()?.tabsOf(agent.id) ?? [],
    sharedSite: (id) => deps.shares?.()?.siteOf(id) ?? null,
    act: {
      siteAllowed: (site) => deps.sites?.allowed(site) ?? false,
      keepSite: (site) => deps.sites?.keep(site),
      doing: (nodeId, doing) => deps.chords?.doing(nodeId, doing),
    },
  });
  /** When it last called a tool: the share key shares with the agent that called last. */
  let lastCallAt = 0;
  const waitMs = deps.waitMs ?? CONTROL_WAIT_MS;
  /** This connection was allowed (once or always): later calls don't ask. */
  let allowed = false;
  /** The sign-ins its chord gets: the window where it was let in. */
  let profile: ProfileId | null = null;
  /** Calls under way, by request id, for notifications/cancelled. */
  const calls = new Map<Message['id'], AbortController>();
  const reply = (id: Message['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const output = (out: ToolOutput): { content: Record<string, unknown>[]; isError: boolean } =>
    out.image ? { content: [{ type: 'image', data: out.image.data, mimeType: out.image.mimeType }], isError: Boolean(out.isError) } : { content: [{ type: 'text', text: out.text ?? '' }], isError: Boolean(out.isError) };
  const refused = (why: keyof typeof CONTROL_REFUSALS): ToolOutput => ({ text: CONTROL_REFUSALS[why], isError: true });

  // The bridge answered tools/list from its own build: if this Chord's list differs, the client asks again.
  const actions = deps.actions ?? true;
  if (hello.toolsVersion !== agentToolsVersion(agentToolList(actions))) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

  /** The connection card, once per connection (or for good, with Always or a no). */
  const connectionAnswer = async (signal: AbortSignal): Promise<'go' | Grant | 'waiting'> => {
    if (allowed) return 'go';
    const card: Omit<ControlCard, 'id'> = { kind: 'connection', tool: 'connect', description: `“${name}” wants to use Chord`, target: [], tab: null, subject: name };
    const answer = await agent.ask(card, signal, waitMs);
    if (answer === 'once' || answer === 'always') {
      allowed = true;
      profile ??= deps.allowedProfile?.() ?? null;
    }
    return answer;
  };

  /** open_tab: a tab in its Agent chord, signed in as the user, once its page has loaded (at most LOAD_MS). */
  const openTab = async (args: Record<string, unknown>, callSignal: AbortSignal): Promise<ToolOutput> => {
    const url = typeof args['url'] === 'string' ? args['url'].trim() : '';
    if (!WEB_ADDRESS.test(url) || url.length > 2048) return { text: 'Only http and https addresses, up to 2,048 characters.', isError: true };
    if (isNeverReadable(url, neverSites())) return { text: 'That site is one the user keeps private, so it can’t be opened for you.', isError: true };
    // Still a read (no site card), but an address that deletes or signs out asks first, as navigate's does (the owner,
    // 2026-11-23): opening it would do it.
    const why = actions ? addressWhy(url) : null;
    if (why) {
      const site = siteOfUrl(url) ?? barAddress(url);
      const answer = await agent.ask(
        { kind: 'step', tool: 'open_tab', description: `open ${barAddress(url)}`, target: [url], tab: null, subject: `open|${url}`, step: { why, site, fields: [], more: 0 } },
        // The call's own signal (Neon's review 2 of #112): Stop or the agent cancelling takes the card down for it.
        callSignal,
        waitMs,
      );
      if (answer === 'waiting') return { text: CONTROL_REFUSALS.waiting, isError: true };
      if (answer === 'deny') return { text: ACT_REFUSALS.stepDenied, isError: true };
    }
    // Stopped while the card was up: no tab.
    if (callSignal.aborted || agent.isStopped) return refused('stopped');
    if (!deps.chords || !deps.dispatch) return { text: 'This Chord can’t open tabs for agents.', isError: true };
    const chord = deps.chords.chordFor(agent, name, profile);
    deps.shares?.()?.chordMade(agent.id, chord);
    const nodeId = uuidv7();
    deps.dispatch({ t: 'agent.tab.add', chordId: chord, nodeId, url });
    const ref = scope.refs.refFor(nodeId);
    return agent.call(
      nodeId,
      async (signal) => {
        const contents = pageOf(deps.browser.tabs.ensure(nodeId));
        if (!contents) return { text: 'That tab couldn’t be opened.', isError: true };
        // Its own address already asked about (the step card above): not asked again as it loads.
        if (why) allowFirstLoad(contents, url);
        const page = controlPage(contents);
        // Followed from the start, so page_id names the page it loads.
        void page.id;
        // Past its blank first page too (tabs.ts: service workers bypassed in it), at most LOAD_MS.
        await pageLoaded(contents, deps.loadMs ?? LOAD_MS, signal);
        // Its own address allowed for its first load only: whether that came or not, never after (the final pass).
        if (why) forgetFirstLoad(contents, url);
        if (signal.aborted) return refused('stopped');
        if (contents.isDestroyed()) return { text: 'That tab closed while it loaded.', isError: true };
        // Its hold couldn't be finished, or its page never came (round 4 and the final pass of #112): never a tab that
        // would send unheld, nor a blank one reported as opened. The blank tab goes.
        // (A slow page still loading is let be: it's reported loading, at the address asked for.)
        const loadingStill = contents.isLoading();
        if (pickersUnsecured(contents) || (!loadingStill && (firstLoadPending(contents) || !WEB_ADDRESS.test(contents.getURL())))) {
          deps.dispatch?.({ t: 'agent.tab.remove', nodeId });
          return { text: 'That tab couldn’t be opened safely, so it was closed. Try again, or ask the user.', isError: true };
        }
        // Redirected to a site the user keeps private: the tab goes, and nothing of where it ended up is said.
        // (Only a web address counts: a page still loading at the wait's end may show none yet.)
        const landed = page.url();
        if (WEB_ADDRESS.test(landed) && isNeverReadable(landed, neverSites())) {
          // Nor what it held on the way (a sign-in box, a dialog, a download): those would name the site.
          deps.chords?.dropNotes(nodeId);
          deps.dispatch?.({ t: 'agent.tab.remove', nodeId });
          return { text: 'That site is one the user keeps private, so it can’t be opened for you.', isError: true };
        }
        return { text: toolResult({ tab_id: ref, url: WEB_ADDRESS.test(page.url()) ? page.url() : url, title: contents.getTitle(), page_id: page.id, loading: contents.isLoading() }) };
      },
      refused,
    );
  };

  /** close_tab: one of its own tabs, never yours; through the gate on that tab, so it waits while you're using it. */
  const closeTab = async (args: Record<string, unknown>): Promise<ToolOutput> => {
    const state = deps.browser.store.state;
    const found = scope.refs.resolve(args['tab_id'], (id) => nodeOf(state, id)?.kind === 'tab');
    if (!found.ok) return { text: found.why === 'closed' ? CONTROL_REFUSALS.closed : 'No such tab. Use list_tabs.', isError: true };
    if (nodeOf(state, found.id)?.chordId !== chordId()) return { text: NOT_YOURS, isError: true };
    return agent.call(
      found.id,
      async (signal) => {
        if (signal.aborted) return refused('stopped');
        // Closed meanwhile (by you): nothing more to do.
        if (nodeOf(deps.browser.store.state, found.id)?.kind !== 'tab') return { text: CONTROL_REFUSALS.closed, isError: true };
        deps.dispatch?.({ t: 'agent.tab.remove', nodeId: found.id });
        return { text: 'Closed.' };
      },
      refused,
    );
  };

  /** What its tabs held since its last result, as untrusted data after it. */
  const held = (): Record<string, unknown>[] => {
    const notes = deps.chords?.drain(agent) ?? [];
    if (notes.length === 0) return [];
    const list = notes.map((n) => ({ tab_id: scope.refs.refFor(n.nodeId), what: n.what, detail: n.detail }));
    const note = 'Chord held or refused these in your tabs: page dialogs (answered at once: OK, Cancel, nothing typed), file pickers, new windows, downloads and sign-in boxes (cancelled: Chord doesn’t sign agents in).';
    return [{ type: 'text', text: JSON.stringify({ trust: 'untrusted', held: list, note }) }];
  };

  const call = async (m: Message) => {
    const tool = typeof m.params?.['name'] === 'string' ? m.params['name'] : '';
    const args = (m.params?.['arguments'] && typeof m.params['arguments'] === 'object' ? m.params['arguments'] : {}) as Record<string, unknown>;
    const cancel = new AbortController();
    calls.set(m.id, cancel);
    lastCallAt = Date.now();
    try {
      const out = await agent.call(
        null,
        async (signal): Promise<ToolOutput> => {
          const answer = await connectionAnswer(AbortSignal.any([signal, cancel.signal]));
          if (answer === 'waiting') return { text: CONTROL_REFUSALS.waiting, isError: true };
          if (answer === 'deny') return { text: CONTROL_REFUSALS.denied, isError: true };
          if (!agentTools(actions).some((t) => t.name === tool)) return { text: `There’s no tool called ${tool.slice(0, 60)}. Call tools/list.`, isError: true };
          if (tool === 'open_tab') return openTab(args, AbortSignal.any([signal, cancel.signal]));
          if (tool === 'close_tab') return closeTab(args);
          return toPlain(await runControlTool(scope, deps.browser, tool, args));
        },
        refused,
      );
      const answer = output(out);
      reply(m.id, { ...answer, content: [...answer.content, ...held()] });
    } finally {
      calls.delete(m.id);
    }
  };

  return {
    agent,
    name,
    get allowed() {
      return allowed;
    },
    get lastCallAt() {
      return lastCallAt;
    },
    forget(nodeId) {
      scope.refs.close(nodeId);
    },
    message(m) {
      if (m.method === 'tools/call') return void call(m);
      if (m.method === 'tools/list') return reply(m.id, { tools: agentToolList(actions) });
      if (m.method === 'ping') return reply(m.id, {});
      if (m.method === 'notifications/cancelled') {
        calls.get(m.params?.['requestId'] as Message['id'])?.abort();
        return;
      }
      if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
    },
    closed() {
      // The client went: its cards come down, and anything it was waiting on answers no one. Its chord stays: you're
      // asked whether to keep its tabs.
      agent.cancelCards();
      for (const c of calls.values()) c.abort();
      deps.shares?.()?.agentGone(agent.id);
      deps.chords?.done(agent);
    },
  };
}

/**
 * The shared layer answers in the assistant's shape: refusals as `{data: {refused}}` JSON.
 * An agent gets the sentence itself, as S18 §5 says a refusal reads.
 */
function toPlain(out: ToolOutput): ToolOutput {
  if (!out.isError || !out.text) return out;
  try {
    const data = (JSON.parse(out.text) as { data?: { refused?: unknown; error?: unknown } }).data;
    const text = typeof data?.refused === 'string' ? data.refused : typeof data?.error === 'string' ? data.error : null;
    return text ? { text, isError: true } : out;
  } catch {
    return out;
  }
}
