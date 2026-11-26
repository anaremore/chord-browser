/**
 * The assistant's ControlScope (S18 M1a): Duet's front door to the shared
 * control layer (main/control/). The agent is the chat; what it may read is
 * the chat's scope (Settings → Assistant, or the panel's menu), the tabs
 * attached to its messages, and readNeedsApproval, as they always were.
 */
import { nodeList, nodeOf, readNeedsApproval, splitOf, type AssistantScope, type AssistantThread, type AssistantToolName, type NodeId, type TabNode, type TabRefs, type WindowId } from '@chord/core';
import type { ControlAgent } from '../control/gate';
import type { ActHost, ControlScope, FillProposals, ToolMemory } from '../control/scope';
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
  /**
   * The message's tab (S18 M2e-2a, A1): the tab on screen in the window the message came from, when it was sent. The
   * assistant acts there only, while it's still on screen; null between turns.
   */
  actTab: { nodeId: NodeId; windowId: WindowId } | null;
  /** Why acting ended for this message (you switched away, used the tab, or turned acting off), or null. */
  actEnded: string | null;
  /**
   * The chat read from elsewhere than the tabs it read (M2e-2c, B3): it searched history or the archive, a message had an
   * image, or it has turns from before this session (resumed, continued, imported: Neon's B3 on #151, failing closed). What
   * it types, and every address it goes to, is shown first from then on.
   */
  elsewhere: boolean;
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
  /**
   * Acting in the tab on screen (S18 M2e-2a): absent where the build or Settings → Assistant's *Click and type on pages*
   * says no. `offScreen`: null while the tab is on screen in that window (no Peek over it, the window not minimized),
   * else what was seen instead, in a few words (*another tab is on screen*).
   */
  acting?(chat: DuetChat): {
    on(): boolean;
    offScreen(node: TabNode, windowId: WindowId): string | null;
    /** A step refused for a reason latched earlier in the message (the chat may say it now: your taking the tab). */
    latched?(why: string): void;
    /** What the lease caught in the tab since its last result (ActHost.caught). */
    caught?(node: TabNode): string[];
    siteOf(url: string): string | null;
    siteAllowed(site: string): boolean;
    keepSite(site: string): void;
    doing: ActHost['doing'];
    lease: NonNullable<ActHost['lease']>;
  };
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

/** Why the assistant can't act in a tab of yours (S18 M2e-2a): one sentence each, to the model. */
export const USER_TAB_REFUSALS = {
  off: 'The user turned off clicking and typing on pages, in Settings → Assistant. Tell them what to do instead.',
  noMessage: 'Act only for a message of the user’s that asks you to.',
  notThatTab: (title: string) => `You can act only in the tab that was on screen when the user wrote (“${title}”). Ask them to switch to the tab they mean, then to ask again.`,
  /** What was seen (the owner's preview: a refusal must say which, so a real switch is told from anything else). */
  switched: (seen: string) =>
    `That tab left the screen while you were working on this message (${seen}), so acting stopped for it. Stop, and tell the user that: they switched away while you were working, what you did and what’s left, and that if they ask again with the tab on screen you’ll pick up from there.`,
  split: 'Acting works on a tab shown alone, not in a split. Ask the user to show the tab on its own.',
  tookOver: 'The user took over the tab. Stop, and tell them what you did and what’s left.',
  left: 'The user left this chat or closed the assistant, so acting stopped. Stop, and tell them what you did and what’s left.',
} as const;

export function duetScope(chat: DuetChat, host: DuetHost, actions = false, goOutline = false): ControlScope {
  const state = () => host.browser.store.state;
  const granted = (tool: AssistantToolName) => chat.control.granted('read', tool) === 'always';
  /** An agent's tab the user hasn't pointed at: left out of everything the chat sees. */
  const unpointed = (node: TabNode) => host.agentOf(node) !== null && !chat.pointed.has(node.id);
  const readable = (node: TabNode) => host.readable(node) && !unpointed(node);
  return {
    agent: chat.control,
    actions,
    // navigate's snapshot: true, behind its own flag (S18 M2g-2 slice 3a, #204).
    ...(goOutline ? { outlineOnGo: true } : {}),
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
    // Acting in the tab on screen (S18 M2e-2a): only the message's tab, only while it's on screen there, alone.
    ...(actions && host.acting
      ? (() => {
          const acting = host.acting(chat);
          const act: ActHost = {
            mayAct: (node) => {
              if (!acting.on()) return USER_TAB_REFUSALS.off;
              const agent = host.agentOf(node);
              if (agent !== null) return AGENT_TAB_REFUSALS.act(agent);
              if (chat.actEnded) {
                acting.latched?.(chat.actEnded);
                return chat.actEnded;
              }
              const at = chat.actTab;
              if (!at) return USER_TAB_REFUSALS.noMessage;
              if (at.nodeId !== node.id) {
                const named = nodeOf(state(), at.nodeId);
                return USER_TAB_REFUSALS.notThatTab(named?.kind === 'tab' ? named.title || named.url : 'it was closed');
              }
              // Off screen once (switched away, a popup took the screen, another window): for the rest of this message.
              // In a split: said, not latched (you may close the split). Anything else off screen (another tab, Peek,
              // minimized, another window): over for this message (Neon's B6 on #147).
              if (splitOf(state(), node.id)) return USER_TAB_REFUSALS.split;
              const seen = acting.offScreen(node, at.windowId);
              if (seen) {
                chat.actEnded = USER_TAB_REFUSALS.switched(seen);
                return chat.actEnded;
              }
              return null;
            },
            siteOf: acting.siteOf,
            siteAllowed: acting.siteAllowed,
            keepSite: acting.keepSite,
            doing: acting.doing,
            lease: acting.lease,
            ...(acting.caught ? { caught: acting.caught } : {}),
            // Another site than the page's: asks every time, with the address (M2e-2c, B3; the owner's answer 2).
            // From https to plain http on the same site too: what the address carries goes in the clear (Neon's SF5 on #151).
            leaving: (from, to) => {
              const there = acting.siteOf(to);
              return there === null || there !== acting.siteOf(from) || (/^https:/i.test(from) && /^http:/i.test(to));
            },
            // A chat that read anything but the tab it acts on as it is now (another tab, this one on another site, the
            // list of tabs, history, the archive, an image, an earlier session): what it types is shown first, every time
            // (M2e-2c, B3; the owner's answer 6; Neon's B3 on #151).
            typeAsks: (node, url) => {
              if (chat.elsewhere || [...chat.read].some((id) => id !== node.id) || [...(chat.listed ?? [])].some((id) => id !== node.id)) return true;
              const here = acting.siteOf(url);
              return [...(chat.readFrom ?? [])].some((origin) => here === null || acting.siteOf(origin) !== here);
            },
          };
          return { act };
        })()
      : {}),
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
    search: (tool, query) => {
      chat.elsewhere = true;
      return host.search(chat, tool, query);
    },
    fills: host.fills(chat),
  };
}
