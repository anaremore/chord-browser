/**
 * Chord's side of one agent connection (S18 M1b): MCP over the endpoint, after
 * the hello. The connection is the agent: its own ControlAgent (the gate), so
 * its connection card, Stop and grants are the shared layer's. The first call
 * waits on the connection card (kind `connection`, subject the client's name):
 * an answer within CONTROL_WAIT_MS lets it go on, none answers *waiting* and
 * the card stays up for the retry, a no answers *denied* now and later.
 *
 * Until the Agent chord (M1c), the tools run against a stub scope: no tabs, and
 * nothing to read. Loaded only when the first connection arrives.
 */
import { AGENT_TOOLS, CONTROL_REFUSALS, CONTROL_WAIT_MS, TabRefs, agentToolList, agentToolsVersion, type AgentHello, type Grant, type NodeId } from '@chord/core';
import { ControlAgent, type CardPresenter, type ControlCard } from '../control/gate';
import type { ControlScope, ToolOutput } from '../control/scope';
import { runControlTool, type ControlBrowser } from '../control/tools';
import type { Send } from './endpoint';

type Message = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

export interface ConnectionDeps {
  /** Shows the connection card (until Settings → Agents and its card, M1d: the development hook). */
  present: CardPresenter;
  browser: ControlBrowser;
  /** How long a call waits on a card; CONTROL_WAIT_MS (tests shorten it). */
  waitMs?: number;
  log?(...args: unknown[]): void;
}

/** The client's name as it gives it (`clientInfo.title`, else `name`): a hint, never proof (S18 §3). */
export function clientName(hello: AgentHello): string {
  const info = hello.initialize?.['clientInfo'] as { title?: unknown; name?: unknown } | undefined;
  const name = typeof info?.title === 'string' && info.title.trim() ? info.title : typeof info?.name === 'string' ? info.name : '';
  return name.trim().slice(0, 60) || 'An agent';
}

/** An agent's scope until the Agent chord: it sees no tabs and may read nothing (M1c brings its own). */
export function stubScope(agent: ControlAgent): ControlScope {
  return {
    agent,
    refs: new TabRefs<NodeId>('a'),
    memory: { pdfs: new Map(), form: null, nextField: 1, read: new Set() },
    off: () => null,
    tabs: () => [],
    defaultTab: () => null,
    readable: () => false,
    neverSites: () => [],
    needsCard: () => null,
    mayInspect: () => 'Only your own tabs and tabs the user shares with you.',
    cardWaitMs: CONTROL_WAIT_MS,
    activity: async () => undefined,
  };
}

let lastAgent = 0;

export interface AgentConnection {
  readonly agent: ControlAgent;
  readonly name: string;
  message(m: Message): void;
  closed(): void;
}

export function agentConnection(hello: AgentHello, send: Send, deps: ConnectionDeps): AgentConnection {
  const name = clientName(hello);
  const agent = new ControlAgent(`agent:${++lastAgent}`, deps.present);
  const scope = stubScope(agent);
  const waitMs = deps.waitMs ?? CONTROL_WAIT_MS;
  /** This connection was allowed (once or always): later calls don't ask. */
  let allowed = false;
  /** Calls under way, by request id, for notifications/cancelled. */
  const calls = new Map<Message['id'], AbortController>();
  const reply = (id: Message['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const output = (out: ToolOutput) =>
    out.image ? { content: [{ type: 'image', data: out.image.data, mimeType: out.image.mimeType }], isError: Boolean(out.isError) } : { content: [{ type: 'text', text: out.text ?? '' }], isError: Boolean(out.isError) };

  // The bridge answered tools/list from its own build: if this Chord's list differs, the client asks again.
  if (hello.toolsVersion !== agentToolsVersion()) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });

  /** The connection card, once per connection (or for good, with Always or a no). */
  const connectionAnswer = async (signal: AbortSignal): Promise<'go' | Grant | 'waiting'> => {
    if (allowed) return 'go';
    const card: Omit<ControlCard, 'id'> = { kind: 'connection', tool: 'connect', description: `“${name}” wants to use Chord`, target: [], tab: null, subject: name };
    const answer = await agent.ask(card, signal, waitMs);
    if (answer === 'once' || answer === 'always') allowed = true;
    return answer;
  };

  const call = async (m: Message) => {
    const tool = typeof m.params?.['name'] === 'string' ? m.params['name'] : '';
    const args = (m.params?.['arguments'] && typeof m.params['arguments'] === 'object' ? m.params['arguments'] : {}) as Record<string, unknown>;
    const cancel = new AbortController();
    calls.set(m.id, cancel);
    try {
      const out = await agent.call(
        null,
        async (signal): Promise<ToolOutput> => {
          const answer = await connectionAnswer(AbortSignal.any([signal, cancel.signal]));
          if (answer === 'waiting') return { text: CONTROL_REFUSALS.waiting, isError: true };
          if (answer === 'deny') return { text: CONTROL_REFUSALS.denied, isError: true };
          if (!AGENT_TOOLS.some((t) => t.name === tool)) return { text: `There’s no tool called ${tool.slice(0, 60)}. Call tools/list.`, isError: true };
          if (tool === 'open_tab' || tool === 'close_tab') return { text: 'This build of Chord has no Agent chord yet, so it can’t open or close tabs.', isError: true };
          const result = await runControlTool(scope, deps.browser, tool, args);
          return toPlain(result);
        },
        (why) => ({ text: CONTROL_REFUSALS[why], isError: true }),
      );
      reply(m.id, output(out));
    } finally {
      calls.delete(m.id);
    }
  };

  return {
    agent,
    name,
    message(m) {
      if (m.method === 'tools/call') return void call(m);
      if (m.method === 'tools/list') return reply(m.id, { tools: agentToolList() });
      if (m.method === 'ping') return reply(m.id, {});
      if (m.method === 'notifications/cancelled') {
        calls.get(m.params?.['requestId'] as Message['id'])?.abort();
        return;
      }
      if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
    },
    closed() {
      // The client went: its cards come down, and anything it was waiting on answers no one.
      agent.cancelCards();
      for (const c of calls.values()) c.abort();
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

