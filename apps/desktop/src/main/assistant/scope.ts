/**
 * The assistant's ControlScope (S18 M1a): Duet's front door to the shared
 * control layer (main/control/). The agent is the chat; what it may read is
 * the chat's scope (Settings → Assistant, or the panel's menu), the tabs
 * attached to its messages, and readNeedsApproval, as they always were.
 */
import { nodeList, nodeOf, readNeedsApproval, type AssistantScope, type AssistantThread, type AssistantToolName, type NodeId, type TabNode, type TabRefs, type WindowId } from '@chord/core';
import type { ControlAgent } from '../control/gate';
import type { ControlScope, FillProposals, ToolMemory } from '../control/scope';
import type { ControlBrowser } from '../control/tools';

/** What of a chat its scope reads. */
export interface DuetChat extends ToolMemory {
  chordId: string;
  thread: AssistantThread | null;
  /** Opaque tab handles ("t3") ↔ node ids, so the model never sees titles or URLs it didn't ask for. */
  refs: TabRefs<NodeId>;
  /** Tabs attached to any message in the chat: readable without asking. */
  attached: Set<NodeId>;
  /** Tabs attached to the message being answered (S18 M2e-1): an agent's tab is read only while one points at it. */
  pointed: Set<NodeId>;
  /** The window the last message came from: its tab on screen is the one forms and diagnostics work on. */
  windowId: WindowId | null;
  /** The chat's gate: its grants ("Allow for this chat"), cards and Stop. */
  control: ControlAgent;
}

/** What the assistant's service gives its scope. */
export interface DuetHost {
  readonly browser: ControlBrowser;
  /** Settings → Assistant's *Nothing* and *Never* list. */
  settings(): { readsNothing: boolean; neverSites: readonly string[] };
  /** Not a private window, a chord where the assistant is off, or a *Never* site. */
  readable(node: TabNode): boolean;
  /** The outside agent whose tab this is (an Agent chord's: S18), by its name, or null for a tab of yours. */
  agentOf(node: TabNode): string | null;
  activeTab(windowId: WindowId): TabNode | null;
  activity(chat: DuetChat, tool: string, summary: string, detail: string, ok: boolean): Promise<void>;
  search(chat: DuetChat, tool: 'search_history' | 'search_archive', query: string): Promise<Record<string, string>[]>;
  fills(chat: DuetChat): FillProposals;
}

/**
 * An outside agent's tab, for the assistant (S18 M2e-1): read only when the user points at it (it's attached: on screen
 * when the message was sent, or added to the message), never acted in or filled.
 */
export const AGENT_TAB_REFUSALS = {
  read: (agent: string) => `That tab is ${agent}’s. You read an agent’s tab only when the user points you at it: ask them to attach it, or to switch to it and ask again.`,
  act: (agent: string) => `That tab is ${agent}’s. Keep it first to make it yours, then I can act in it.`,
} as const;

export function duetScope(chat: DuetChat, host: DuetHost, actions = false): ControlScope {
  const state = () => host.browser.store.state;
  const granted = (tool: AssistantToolName) => chat.control.granted('read', tool) === 'always';
  /** An agent's tab the user hasn't pointed at: left out of everything the chat sees. */
  const unpointed = (node: TabNode) => host.agentOf(node) !== null && !chat.pointed.has(node.id);
  const readable = (node: TabNode) => host.readable(node) && !unpointed(node);
  return {
    agent: chat.control,
    actions,
    refs: chat.refs,
    memory: chat,
    off: () => (host.settings().readsNothing ? 'The user set you to read nothing, in Settings → Assistant.' : null),
    tabs: () => {
      const scope: AssistantScope = chat.thread?.scope ?? 'ask';
      const nodes = nodeList(state()).filter((n): n is TabNode => n.kind === 'tab' && readable(n));
      // An agent's tab the message points at is listed whatever the scope (it's given, as an attached tab is).
      return (scope === 'all' ? nodes : nodes.filter((n) => n.chordId === chat.chordId || (host.agentOf(n) !== null && chat.pointed.has(n.id)))).map((node) => ({ node, given: chat.attached.has(node.id) }));
    },
    defaultTab: () => {
      for (const id of chat.attached) {
        const node = nodeOf(state(), id);
        if (node?.kind === 'tab' && !unpointed(node)) return node;
      }
      return null;
    },
    readable,
    whyNot: (node) => {
      const agent = host.agentOf(node);
      // Never readable anyway (a *Never* site, a Chord page): the usual refusal, not a hint to point at it.
      return agent !== null && host.readable(node) && unpointed(node) ? AGENT_TAB_REFUSALS.read(agent) : null;
    },
    neverSites: () => host.settings().neverSites,
    // The chat's grants are per tool ("Allow for this chat"), as they always were.
    needsCard: (tool, node) =>
      readNeedsApproval({
        scope: chat.thread?.scope ?? 'ask',
        attached: node ? chat.attached.has(node.id) : false,
        sameChord: node ? node.chordId === chat.chordId : true,
        tool,
        granted: granted(tool),
      })
        ? { kind: 'read', subject: tool }
        : null,
    // The tab on screen is read live, at each check (before the card, after it, after the read), never kept: the user may
    // switch tabs while a card waits, and only what's on screen at that moment may be inspected.
    mayInspect: (node, tool) => {
      // Filling a form is acting: never in an agent's tab, even one the user pointed at.
      const agent = host.agentOf(node);
      if (agent !== null && tool === 'propose_fill') return AGENT_TAB_REFUSALS.act(agent);
      const onScreen = chat.windowId ? host.activeTab(chat.windowId)?.id : undefined;
      if (onScreen === node.id) return null;
      return tool === 'page_diagnostics'
        ? "Only the tab on screen's problems can be read. Ask the user to switch to it, then to ask again."
        : 'Forms are filled only on the tab on screen. Ask the user to switch to it, then to ask again.';
    },
    activity: (tool, summary, detail, ok) => host.activity(chat, tool, summary, detail, ok),
    search: (tool, query) => host.search(chat, tool, query),
    fills: host.fills(chat),
  };
}
