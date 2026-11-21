/**
 * An outside agent's ControlScope (S18 M1c): the shared layer's tools, on the
 * agent's own tabs. It sees only its Agent chord's tabs (and, with M1e, tabs
 * you share with it), with refs of its own (`a1`, never reused). Its reads
 * need no card: the connection card let it in, and its tabs are its own.
 * Never-readable pages (Chord's own, a site on your *Never* list) stay refused.
 */
import { CONTROL_WAIT_MS, isNeverReadable, nodeList, TabRefs, type NodeId, type State, type TabNode } from '@chord/core';
import type { ControlAgent } from '../control/gate';
import type { ControlScope } from '../control/scope';

export interface AgentScopeDeps {
  state(): State;
  /** The agent's Agent chord, once it has one. */
  chordId(): string | null;
  /** The *Never* list (Settings → Assistant's): sites no agent reads either. */
  neverSites(): readonly string[];
}

/** What an agent hears when it names a tab that isn't its own. */
export const NOT_YOURS = 'That tab isn’t yours: you can use only the tabs you opened (open_tab) and tabs the user shares with you.';

export function agentScope(agent: ControlAgent, deps: AgentScopeDeps): ControlScope {
  const own = (node: TabNode) => node.chordId === deps.chordId();
  return {
    agent,
    refs: new TabRefs<NodeId>('a'),
    memory: { pdfs: new Map(), form: null, nextField: 1, read: new Set() },
    off: () => null,
    tabs: () => {
      const chordId = deps.chordId();
      if (!chordId) return [];
      return nodeList(deps.state())
        .filter((n): n is TabNode => n.kind === 'tab' && n.chordId === chordId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((node) => ({ node, given: false }));
    },
    defaultTab: () => null,
    readable: (node) => own(node) && !isNeverReadable(node.url, deps.neverSites()),
    neverSites: () => deps.neverSites(),
    needsCard: () => null,
    mayInspect: (node) => (own(node) ? null : NOT_YOURS),
    cardWaitMs: CONTROL_WAIT_MS,
    activity: async () => undefined,
  };
}
