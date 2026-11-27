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
import { imageTokens } from '../control/extract';
import { runBatch } from '../control/batch';
import { noteResult, tokensOf } from '../control/phases';
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
  type ProfileId } from '@chord/core';
import { ControlAgent, type CardPresenter, type ControlCard } from '../control/gate';
import { controlPage } from '../control/page';
import type { ToolOutput } from '../control/scope';
import { runControlTool, type ControlBrowser, pageLoaded, withOutline } from '../control/tools';
import { pageOf } from '../view-page';
import type { AgentChords } from './chords';
import { siteOfUrl, type AgentShares } from './shares';
import { allowFirstLoad, forgetFirstLoad } from '../control/sends';
import { laterContent } from '../control/handed-over';
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
  /** How often a call that asked for progress hears it (PROGRESS_MS; tests shorten it). */
  progressMs?: number;
  /** How long one call takes in all, its cards' waits included (CALL_WAIT_MS; tests shorten it). */
  callWaitMs?: number;
}

/**
 * How long one call takes in all (#143): the connection's, a site's and a step's cards can come one after another,
 * 45 s each, and a client gives up on a call before that (Codex at 60 s by default). Past it, the call answers
 * *waiting* and the card stays up: the user's Allow counts for the agent's retry of that same step (M2d's late Allow).
 * A card asked at the very end still shows, for CARD_WAIT_MIN_MS. A step's Send data cards are never cut (sendWaitMs:
 * no answer drops what the page sent): past it, the call answers that the step ran and what it sent waits, and they
 * go on, handed over (control/handed-over.ts).
 */
const CALL_WAIT_MS = 50_000;
const CARD_WAIT_MIN_MS = 1_000;

/**
 * A call that carries a progressToken hears this often that it's still under way (#143): what a client counts as
 * activity (Claude Code's idle limit), and how its user sees that Chord waits on them, not that it hung.
 */
const PROGRESS_MS = 5_000;
/** A progressToken longer than this isn't echoed back (it's the client's; a string one is usually a few characters). */
const PROGRESS_TOKEN_MAX = 256;
export const AGENT_PROGRESS = {
  card: 'Waiting for the user to answer Chord’s card.',
  working: 'Still working in Chord.',
} as const;

/** What open_tab waits for its page: at most this long (S18 §5). */
const LOAD_MS = 30_000;
const WEB_ADDRESS = /^https?:\/\/\S+$/i;
/** open_tab's refusal for a site the user keeps private: never anything of the site. */
const NEVER_OPEN = 'That site is one the user keeps private, so it can’t be opened for you.';
/** snapshot's own refusal for a page that may never be read (control/tools.ts). */
const NEVER_READ = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';

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
  const connectionAnswer = async (signal: AbortSignal, wait: number): Promise<'go' | Grant | 'waiting'> => {
    if (allowed) return 'go';
    const card: Omit<ControlCard, 'id'> = { kind: 'connection', tool: 'connect', description: `“${name}” wants to use Chord`, target: [], tab: null, subject: name };
    const answer = await agent.ask(card, signal, wait);
    if (answer === 'once' || answer === 'always') {
      allowed = true;
      profile ??= deps.allowedProfile?.() ?? null;
    }
    return answer;
  };

  /** open_tab: a tab in its Agent chord, signed in as the user, once its page has loaded (at most LOAD_MS). */
  const openTab = async (args: Record<string, unknown>, callSignal: AbortSignal, cardWait: () => number): Promise<ToolOutput> => {
    const url = typeof args['url'] === 'string' ? args['url'].trim() : '';
    if (!WEB_ADDRESS.test(url) || url.length > 2048) return { text: 'Only http and https addresses, up to 2,048 characters.', isError: true };
    if (isNeverReadable(url, neverSites())) return { text: NEVER_OPEN, isError: true };
    // Still a read (no site card), but an address that deletes or signs out asks first, as navigate's does (the owner,
    // 2026-11-23): opening it would do it.
    const why = actions ? addressWhy(url) : null;
    if (why) {
      const site = siteOfUrl(url) ?? barAddress(url);
      const answer = await agent.ask(
        { kind: 'step', tool: 'open_tab', description: `open ${barAddress(url)}`, target: [url], tab: null, subject: JSON.stringify(['open', url]), step: { why, site, fields: [], more: 0 } },
        // The call's own signal (Neon's review 2 of #112): Stop or the agent cancelling takes the card down for it.
        callSignal,
        cardWait(),
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
        const page = controlPage(contents, deps.browser.tabs);
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
        if (WEB_ADDRESS.test(landed) && isNeverReadable(landed, neverSites())) return closeNever(nodeId);
        return { text: toolResult({ tab_id: ref, url: WEB_ADDRESS.test(page.url()) ? page.url() : url, title: contents.getTitle(), page_id: page.id, loading: contents.isLoading() }) };
      },
      refused,
      // The client giving up ends its wait for the page too (round 2 of #145).
      callSignal,
    );
  };

  /**
   * A tab of its own that went to a site the user keeps private: it goes, with what it held on the way (a sign-in box, a
   * dialog, a download: those would name the site), and the agent hears only that it's private.
   */
  const closeNever = (nodeId: string): ToolOutput => {
    deps.chords?.dropNotes(nodeId);
    if (nodeOf(deps.browser.store.state, nodeId)?.kind === 'tab') deps.dispatch?.({ t: 'agent.tab.remove', nodeId });
    return { text: NEVER_OPEN, isError: true };
  };

  /**
   * open_tab's snapshot: true, once the outline is taken or refused (round 1 of #232, B1): a page that went to a Never
   * site meanwhile (a client redirect as it was read), or whose read came from one, is as open_tab landing there.
   */
  const afterLook = (ref: unknown, looked: ToolOutput): ToolOutput => {
    const found = scope.refs.resolve(ref, () => true);
    if (!found.ok) return looked;
    const node = nodeOf(deps.browser.store.state, found.id);
    const urls = [pageOf(deps.browser.tabs.get(found.id))?.getURL() ?? '', node?.kind === 'tab' ? node.url : ''];
    const body = (JSON.parse(looked.text ?? '{}') as { url?: unknown; data?: { no_outline?: unknown } });
    if (typeof body.url === 'string') urls.push(body.url);
    const never = body.data?.no_outline === NEVER_READ || urls.some((u) => WEB_ADDRESS.test(u) && isNeverReadable(u, neverSites()));
    return never ? closeNever(found.id) : looked;
  };

  /** close_tab: one of its own tabs, never yours; through the gate on that tab, so it waits while you're using it. */
  const closeTab = async (args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolOutput> => {
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
      // The client giving up while it waits (a paused tab): it never closes the tab later (round 1 of #145, SF3).
      cancelled,
    );
  };

  /** #143: what became of sends whose step's call answered before their card did, since its last result: Chord's words. */
  // Inside the untrusted envelope: each step is in the page's words (Neon's B6, Opus's S3).
  const later = (from: object): { type: 'text'; text: string }[] => laterContent(scope.memory, from);

  /** What its tabs held since its last result, as untrusted data after it. */
  const held = (): Record<string, unknown>[] => {
    const notes = deps.chords?.drain(agent) ?? [];
    if (notes.length === 0) return [];
    const list = notes.map((n) => ({ tab_id: scope.refs.refFor(n.nodeId), what: n.what, detail: n.detail }));
    const note = 'Chord held or refused these in your tabs: page dialogs (answered at once: OK, Cancel, nothing typed), file pickers, new windows, downloads and sign-in boxes (cancelled: Chord doesn’t sign agents in).';
    return [{ type: 'text', text: JSON.stringify({ trust: 'untrusted', held: list, note }) }];
  };

  /**
   * batch (M2g-1, the owner's token goal: fewer calls): its steps in order, each through the same layer as its own call
   * (every check, card, the send hold and the guard), on the batch's tab. The first step refused stops it. One compact
   * answer: what each step did, and the page after; or which step was refused, and why.
   */
  const call = async (m: Message) => {
    const tool = typeof m.params?.['name'] === 'string' ? m.params['name'] : '';
    const args = (m.params?.['arguments'] && typeof m.params['arguments'] === 'object' ? m.params['arguments'] : {}) as Record<string, unknown>;
    const cancel = new AbortController();
    calls.set(m.id, cancel);
    lastCallAt = Date.now();
    // What's left of the call's wait on cards, for the next card it asks (CALL_WAIT_MS).
    const started = Date.now();
    const cardWait = () => Math.min(waitMs, Math.max(CARD_WAIT_MIN_MS, (deps.callWaitMs ?? CALL_WAIT_MS) - (Date.now() - started)));
    // #143: the whole call answers by CALL_WAIT_MS, Send data cards included (they go on after it, for the user).
    const callToken = {};
    const callScope: typeof scope = Object.create(scope, { cardWaitMs: { get: cardWait }, callDeadlineMs: { get: () => Math.max(0, (deps.callWaitMs ?? CALL_WAIT_MS) - (Date.now() - started)) }, callToken: { value: callToken }, sendWaitMs: { value: waitMs } });
    // Progress, when the client asked for it (MCP's progressToken, a string or a number, bounded): every PROGRESS_MS
    // until the answer or the client's cancel, saying whether a card this call waits on is up: one for its tab, or the
    // agent-wide one (the connection's) (#143; Neon's review of M2g-1, S4).
    const token = (m.params?.['_meta'] as { progressToken?: unknown } | undefined)?.progressToken;
    const tokenOk = (typeof token === 'string' && token.length > 0 && token.length <= PROGRESS_TOKEN_MAX) || (typeof token === 'number' && Number.isFinite(token));
    const tabOf = () => {
      const found = scope.refs.resolve(args['tab_id'], () => true);
      return found.ok ? found.id : null;
    };
    let beats = 0;
    const beat = tokenOk
      ? setInterval(() => {
          const tab = tabOf();
          const card = agent.state(null).cards.length > 0 || (tab !== null && agent.state(tab).cards.length > 0);
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message: card ? AGENT_PROGRESS.card : AGENT_PROGRESS.working } });
        }, deps.progressMs ?? PROGRESS_MS)
      : null;
    // Never what keeps the process up (round 1 of #145).
    beat?.unref?.();
    if (beat) cancel.signal.addEventListener('abort', () => clearInterval(beat), { once: true });
    try {
      const out = await agent.call(
        null,
        async (signal): Promise<ToolOutput> => {
          const answer = await connectionAnswer(AbortSignal.any([signal, cancel.signal]), cardWait());
          if (answer === 'waiting') return { text: CONTROL_REFUSALS.waiting, isError: true };
          if (answer === 'deny') return { text: CONTROL_REFUSALS.denied, isError: true };
          if (!agentTools(actions).some((t) => t.name === tool)) return { text: `There’s no tool called ${tool.slice(0, 60)}. Call tools/list.`, isError: true };
          if (tool === 'open_tab') {
            const opened = await openTab(args, AbortSignal.any([signal, cancel.signal]), cardWait);
            // With snapshot: true, the page as snapshot gives it (S18 M2g-2 slice 3a, #204): snapshot's own call, through
            // the gate on the new tab, every read rule with it. Only where snapshot is (M2's tools).
            if (args['snapshot'] !== true || !actions || opened.isError) return opened;
            const tab = (JSON.parse(opened.text ?? '{}') as { data?: { tab_id?: unknown } }).data?.tab_id;
            const looked = await withOutline(opened, 'open_tab', () => runControlTool(callScope, deps.browser, 'snapshot', { tab_id: tab }, cancel.signal, true));
            return afterLook(tab, looked);
          }
          if (tool === 'close_tab') return closeTab(args, cancel.signal);
          if (tool === 'batch') return runBatch(callScope, deps.browser, args, cancel.signal);
          return toPlain(await runControlTool(callScope, deps.browser, tool, args, cancel.signal));
        },
        refused,
        cancel.signal,
      );
      const answer = output(out);
      if (beat) clearInterval(beat);
      // What settled since the agent's last result: never this call's own hand-over, whose answer says it waits.
      const result = { ...answer, content: [...answer.content, ...held(), ...later(callToken)] };
      // What the result costs the agent, by tool (the owner, 2026-11-24: as few tokens as can be): in the log, and kept
      // for the eval journeys (phases.ts).
      // A picture by its pixels, not its bytes (a model sees the image, never its base64).
      const chars = JSON.stringify(result.content).length;
      const shot = out.image?.width && out.image.height ? out.image : null;
      const tokens = shot ? imageTokens(shot.width!, shot.height!) + tokensOf(JSON.stringify(result.content.slice(1)).length) : tokensOf(chars);
      noteResult(tool, chars, tokens);
      deps.log?.('result', tool, `${chars} chars`, `~${tokens} tokens`);
      reply(m.id, result);
    } finally {
      if (beat) clearInterval(beat);
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
