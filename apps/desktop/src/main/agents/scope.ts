/**
 * An outside agent's ControlScope (S18 M1c, M1e): the shared layer's tools, on
 * the agent's own tabs (`a1`…) and the tabs you share with it (`s1`…), with
 * refs of its own, never reused. Its reads need no card: the connection card
 * let it in, its tabs are its own, and a shared tab is one you gave it. Shared
 * tabs are only read (close_tab is its own tabs' alone); once you stop sharing
 * one, it hears so. Never-readable pages (Chord's own, a site on your *Never*
 * list) stay refused, and a tab on a *Never* site isn't even listed.
 */
import { ACT_REFUSALS, AGENT_READ_DEFAULT, CONTROL_WAIT_MS, isNeverReadable, nodeOf, nodesOfChord, TabRefs, type BarDoing, type NodeId, type State, type TabNode } from '@chord/core';
import type { ControlAgent } from '../control/gate';
import type { ControlScope } from '../control/scope';
import { siteOfUrl } from './shares';

export interface AgentScopeDeps {
  /** M2's tools are offered (agentActions). */
  actions?: boolean;
  state(): State;
  /** The agent's Agent chord, once it has one. */
  chordId(): string | null;
  /** The *Never* list (Settings → Assistant's): sites no agent reads either. */
  neverSites(): readonly string[];
  /** The tabs the user shares with it now, in the order they were shared (M1e). */
  shared?(): readonly NodeId[];
  /** The site a shared tab was shared on: it's never read anywhere else. */
  sharedSite?(nodeId: NodeId): string | null;
  /** Acting on pages (M2c): the sites it may act on for good, keeping one, and the bar's wording. Absent, no acting. */
  act?: { siteAllowed(site: string): boolean; keepSite(site: string): void; doing(nodeId: NodeId, doing: BarDoing | null): void };
}

/** A web address on the *Never* list (a blank or unloaded page is none). */
export function onNeverSite(url: string, sites: readonly string[]): boolean {
  return /^(https?|file):/i.test(url) && isNeverReadable(url, sites);
}

/** What an agent hears when it names a tab that isn't its own. */
export const NOT_YOURS = 'That tab isn’t yours: you can use only the tabs you opened (open_tab) and tabs the user shares with you.';

/** What an agent hears about a tab the user shared and then stopped sharing (or that left the site it was shared on). */
export const NOT_SHARED = 'The user isn’t sharing that tab with you any more. Use list_tabs for the tabs you can use.';

export function agentScope(agent: ControlAgent, deps: AgentScopeDeps): ControlScope {
  const own = (node: TabNode) => node.chordId === deps.chordId();
  const sharedNow = (id: NodeId) => deps.shared?.().includes(id) ?? false;
  /** Tabs it was ever given a shared ref for: once unshared, they're refused in those words. */
  const everShared = new Set<NodeId>();
  const refs = new TabRefs<NodeId>('a', (id) => {
    if (!sharedNow(id)) return 'a';
    everShared.add(id);
    return 's';
  });
  const mine = (node: TabNode) => own(node) || sharedNow(node.id);
  return {
    agent,
    refs,
    actions: deps.actions ?? false,
    // Acting (M2c): its own tabs only; a tab you share stays read-only (M2's answer).
    ...(deps.actions && deps.act
      ? {
          act: {
            mayAct: (node: TabNode) => (own(node) ? null : sharedNow(node.id) || everShared.has(node.id) ? ACT_REFUSALS.sharedReadOnly : NOT_YOURS),
            siteOf: siteOfUrl,
            siteAllowed: deps.act.siteAllowed,
            keepSite: deps.act.keepSite,
            doing: deps.act.doing,
          },
        }
      : {}),
    memory: { pdfs: new Map(), form: null, nextField: 1, read: new Set() },
    off: () => null,
    tabs: () => {
      const state = deps.state();
      const sites = deps.neverSites();
      const chordId = deps.chordId();
      const owned = chordId
        ? nodesOfChord(state, chordId)
            .filter((n): n is TabNode => n.kind === 'tab' && !onNeverSite(n.url, sites))
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((node) => ({ node, given: false }))
        : [];
      const shared = (deps.shared?.() ?? [])
        .map((id) => nodeOf(state, id))
        .filter((n): n is TabNode => n?.kind === 'tab' && !onNeverSite(n.url, sites))
        .map((node) => ({ node, given: true }));
      return [...owned, ...shared];
    },
    defaultTab: () => null,
    readable: (node) => mine(node) && !isNeverReadable(node.url, deps.neverSites()),
    // Its own tabs anywhere `readable` allows; a shared one only on the site it was shared on.
    siteOk: (node, url) => own(node) || (deps.sharedSite?.(node.id) ?? null) === siteOfUrl(url),
    whyNot: (node) => (!own(node) && everShared.has(node.id) ? NOT_SHARED : null),
    neverSites: () => deps.neverSites(),
    needsCard: () => null,
    mayInspect: (node) => (mine(node) ? null : everShared.has(node.id) ? NOT_SHARED : NOT_YOURS),
    cardWaitMs: CONTROL_WAIT_MS,
    sendWaitMs: CONTROL_WAIT_MS,
    waits: true,
    readDefault: AGENT_READ_DEFAULT,
    // Only where snapshot is (M2's tools: round 1 of #260): parts' refs, and navigate's and open_tab's outline.
    ...(deps.actions ? { boxes: true, outlineOnGo: true, findFlat: true } : {}),
    activity: async () => undefined,
  };
}
