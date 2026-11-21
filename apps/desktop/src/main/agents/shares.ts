/**
 * Tabs you share with an outside agent (S18 M1e; mocks/agents-s18-m1.html §3).
 * In memory only, like the agents' chords: made with the first share, gone at
 * quit. A shared tab stays yours, in your chord: the agent can list it (`s1`…)
 * and read it (read_tab, tab_screenshot, read_form, page_diagnostics,
 * read_selection), never close or change it.
 *
 * Sharing ends when you stop it (the bar's Stop sharing, the tab menu, the
 * key), when the tab closes, when it leaves the site it was shared on (or goes
 * to one you keep private), when it stops being a tab of yours (moved to a
 * private window's chord), or when the agent goes.
 *
 * Each shared tab's bar says so (LiveTab.agent, state `shared`); a tab whose
 * page was made again (it slept) gets it back.
 */
import { hostOf, isAgentChord, isNeverReadable, nodeOf, siteOf, type Command, type NodeId, type State, type TabNode } from '@chord/core';
import type { Change } from '../store';

export interface AgentSharesDeps {
  store: { readonly state: State; dispatch(command: Command): void; subscribe(listener: (change: Change) => void): () => void };
  neverSites(): readonly string[];
  /** A share ended: the agent's ref for the tab says so from now on. */
  ended?(nodeId: NodeId, agentId: string): void;
}

/** Who a tab is shared with. */
export interface SharedWith {
  agentId: string;
  name: string;
  /** The agent's chord, if it has one (the bar's). */
  chordId: string;
}

interface Share extends SharedWith {
  /** The site it was shared on: leaving it ends the share. */
  site: string;
}

/** A web address's site (example.co.uk for www.example.co.uk); null for anything else. */
export function siteOfUrl(url: string): string | null {
  if (!/^https?:/i.test(url)) return null;
  const host = hostOf(url);
  return host ? siteOf(host) : null;
}

/** Whether a tab of yours can be shared now: a web page of your own chord (not a private window's), on a site you don't keep private. */
export function shareable(state: State, nodeId: NodeId, neverSites: readonly string[]): boolean {
  const node = nodeOf(state, nodeId);
  if (node?.kind !== 'tab' || isAgentChord(state, node.chordId)) return false;
  const chord = state.chords[node.chordId];
  if (!chord || chord.private) return false;
  return siteOfUrl(node.url) !== null && !isNeverReadable(node.url, neverSites);
}

export class AgentShares {
  private readonly shares = new Map<NodeId, Share>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: AgentSharesDeps) {
    this.unsubscribe = deps.store.subscribe((change) => {
      if (this.shares.size === 0) return;
      if (!change.patches.some((p) => p.path[0] === 'nodes' || p.path[0] === 'live' || p.path[0] === 'chords' || p.path[0] === 'settings')) return;
      this.settle();
    });
  }

  /** Share it (in place of any agent it was shared with). False if it can't be. */
  share(nodeId: NodeId, agent: SharedWith): boolean {
    const state = this.deps.store.state;
    if (!shareable(state, nodeId, this.deps.neverSites())) return false;
    const before = this.shares.get(nodeId);
    if (before && before.agentId !== agent.agentId) this.end(nodeId);
    const node = nodeOf(state, nodeId) as TabNode;
    this.shares.set(nodeId, { ...agent, site: siteOfUrl(node.url)! });
    this.showBar(nodeId);
    return true;
  }

  unshare(nodeId: NodeId): void {
    if (this.shares.has(nodeId)) this.end(nodeId);
  }

  /** How many tabs are shared now. */
  get count(): number {
    return this.shares.size;
  }

  /** The site a tab was shared on (nothing from another site is ever read from it); null if it isn't shared. */
  siteOf(nodeId: NodeId): string | null {
    return this.shares.get(nodeId)?.site ?? null;
  }

  /** Who the tab is shared with, if anyone. */
  sharedWith(nodeId: NodeId): SharedWith | null {
    const share = this.shares.get(nodeId);
    return share ? { agentId: share.agentId, name: share.name, chordId: share.chordId } : null;
  }

  /** The tabs shared with an agent, in the order they were shared. */
  tabsOf(agentId: string): NodeId[] {
    return [...this.shares].filter(([, s]) => s.agentId === agentId).map(([id]) => id);
  }

  /** The agent's connection ended: its shares end too. */
  agentGone(agentId: string): void {
    for (const id of this.tabsOf(agentId)) this.end(id);
  }

  /** The agent made its chord: the bar's "Let … continue" (when it's stopped) names it. */
  chordMade(agentId: string, chordId: string): void {
    for (const [id, share] of this.shares) {
      if (share.agentId !== agentId || share.chordId === chordId) continue;
      share.chordId = chordId;
      this.showBar(id);
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const id of [...this.shares.keys()]) this.end(id);
  }

  /** After a change: shares whose tab closed, left its site or stopped being yours end; a bar lost with its page comes back. */
  private settle(): void {
    const state = this.deps.store.state;
    for (const [id, share] of [...this.shares]) {
      const node = nodeOf(state, id);
      const stays = node?.kind === 'tab' && shareable(state, id, this.deps.neverSites()) && siteOfUrl(node.url) === share.site;
      if (!stays) this.end(id);
      else if (state.live[id] && state.live[id]!.agent?.state !== 'shared') this.showBar(id);
    }
  }

  private showBar(nodeId: NodeId): void {
    const share = this.shares.get(nodeId);
    const live = this.deps.store.state.live[nodeId];
    if (!share || !live) return;
    const agent = { name: share.name, chordId: share.chordId, state: 'shared' as const };
    const now = live.agent;
    if (now && now.state === 'shared' && now.name === agent.name && now.chordId === agent.chordId) return;
    this.deps.store.dispatch({ t: 'tab.live', nodeId, live: { agent } });
  }

  private end(nodeId: NodeId): void {
    const share = this.shares.get(nodeId);
    if (!share) return;
    this.shares.delete(nodeId);
    if (this.deps.store.state.live[nodeId]?.agent?.state === 'shared') this.deps.store.dispatch({ t: 'tab.live', nodeId, live: { agent: null } });
    this.deps.ended?.(nodeId, share.agentId);
  }
}
