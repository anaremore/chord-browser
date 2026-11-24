/**
 * Outside agents' chords in main (S18 M1c): an Agent chord per connection,
 * made the first time the agent opens a tab, with the sign-ins of the window
 * where the user let it in. It lives in memory only (core's `agent.*`
 * commands), and the sidebar shows it below your chord.
 *
 * - **The bar** follows the agent's gate: a tab it's working on, a tab you're
 *   using (paused), or every tab once you press Stop (LiveTab.agent). Idle,
 *   no bar.
 * - **Throttling**: a tab the agent works on runs at full speed while it does,
 *   though it's hidden; then it's throttled again, as every hidden page is.
 * - **Your hands first**: a key you press in an agent's tab pauses the agent
 *   there until you leave the tab or let it continue.
 * - **Held, for the agent**: dialogs, file pickers, popups and downloads its
 *   tabs tried go into its next result, never one from a tab now on a site the
 *   user keeps private.
 * - **Never read**: a tab that goes to a site on the *Never* list (a redirect,
 *   a page's own script, or the list gaining its site) closes at once, and
 *   what it held goes with it. One *you* took there (you typed the address or
 *   clicked through, in the last USER_MS) isn't closed under you: it becomes a
 *   tab of yours, in the window's chord, and the agent hears it's closed. A
 *   note naming such a site (a popup, a download) never names it.
 * - **When it's done** (its connection ends): a toast asks *Keep these tabs?*
 *   Keep moves them into your chord; Close all closes them, with Undo.
 *
 * Made with the first connection's chord, so with no agent nothing here runs.
 */
import { dropAgentGuard } from '../control/page';
import { endUntil, failHeld, sendHoldDeps, shownOrigin } from '../control/sends';
import { randomBytes } from 'node:crypto';
import { ACT_BAR_MIN_MS, CONTROL_WAIT_MS, barAddress, barDoing, isAgentChord, nodeOf, nodesOfChord, uuidv7, type AgentLive, type BarDoing, type Chord, type ChordId, type Command, type NodeId, type ProfileId, type State, type TabNode, type WindowId } from '@chord/core';
import type { Toast } from '@chord/ipc';
import type { WebContents } from 'electron';
import type { ControlAgent } from '../control/gate';
import { isAgentInput } from '../control/input';
import type { Change } from '../store';
import type { AgentHeld } from '../tabs';
import { onNeverSite } from './scope';

export interface AgentChordsDeps {
  store: { readonly state: State; dispatch(command: Command): void; subscribe(listener: (change: Change) => void): () => void };
  /** A tab's page, if it has one now. */
  page(nodeId: NodeId): WebContents | undefined;
  /** The window used last (not a private one): where an agent's toasts go, and whose sign-ins its chord takes. */
  lastWindow(): { id: WindowId; toast(toast: Toast): void } | null;
  /** The *Never* list: an agent's tab that goes to one of its sites closes. */
  neverSites?(): readonly string[];
  now?(): number;
  /** How long a card between actions waits (what an agent's tab sends: control/sends.ts); CONTROL_WAIT_MS unless a test says. */
  waitMs?: number;
}

/** Something an agent's tab held or refused, for its next result. */
export interface AgentNote {
  nodeId: NodeId;
  what: AgentHeld;
  detail: string;
}

interface AgentChord {
  chordId: ChordId;
  name: string;
  agent: ControlAgent;
  /** The connection is gone: the chord waits for Keep or Close all. */
  done: boolean;
  notes: AgentNote[];
  unlisten: () => void;
}

/** Notes kept per agent between its calls. */
const NOTES_KEPT = 20;
/** Close all's Undo, by its toast's token. */
const UNDOS_KEPT = 10;
/** How long after your key, click or typed address a tab's navigation counts as yours. */
const USER_MS = 15_000;
/** At most this long after you move an agent's tab, its outgoing page's sends are no one's (`leaving`). */
const LEAVING_MS = 15_000;

export class AgentChords {
  private readonly chords = new Map<ChordId, AgentChord>();
  /** What each agent tab's bar says now, so only changes are dispatched. */
  private readonly shown = new Map<NodeId, string>();
  /** Agent tabs running at full speed while hidden. */
  private readonly unthrottled = new Set<NodeId>();
  private readonly undos = new Map<string, { chord: Chord; tabs: TabNode[]; record: AgentChord | null }>();
  /** When you last pressed a key, clicked or typed an address in each agent tab. */
  private readonly userActs = new Map<NodeId, number>();
  /** What the agent is doing on each tab (M2c), and since when: a wording stays at least ACT_BAR_MIN_MS. */
  private readonly doings = new Map<NodeId, { text: string; since: number; clear?: ReturnType<typeof setTimeout> }>();
  /**
   * Agent tabs you just moved yourself (a reload, back, forward, an address: S18 M2e-1): until the page you sent it to
   * commits and loads, what the outgoing page sends (its `pagehide` keepalive POST, a beacon) is no one's and fails,
   * never yours (Neon's S1 on #116). Cleared once a committed page stops loading, a load fails, or after LEAVING_MS.
   */
  private readonly leaving = new Map<NodeId, { committed: boolean; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;
  /** A tab handed over to you: the agents' refs for it say it's closed. Set by the service. */
  onHandedOver: ((nodeId: NodeId) => void) | null = null;

  constructor(private readonly deps: AgentChordsDeps) {
    // Leaving a tab you paused lets the agent go on there; your closing an agent's last tab ends its chord once it's
    // done; a site added to the *Never* list closes its agent tabs.
    this.unsubscribe = deps.store.subscribe((change) => {
      const never = change.before.settings.assistant.neverSites !== change.state.settings.assistant.neverSites;
      if (!never && !change.patches.some((p) => p.path[0] === 'windows' || p.path[0] === 'nodes')) return;
      // An agent's tab that's gone (closed, Close all, a *Never* site) or became yours (Keep): its cards come down at once
      // (no call waits 45 s on a card for a closed tab, nor can a late answer to one be kept: Neon's B2 on #116).
      for (const chord of [...this.chords.values()]) {
        for (const tab of nodesOfChord(change.before, chord.chordId)) {
          if (tab.kind !== 'tab' || nodeOf(change.state, tab.id)?.chordId === chord.chordId) continue;
          this.letGo(chord, tab.id);
        }
      }
      for (const chord of [...this.chords.values()]) this.settle(chord);
      this.prune();
    });
  }

  /** The agent's chord, made now if it has none: its sign-ins are those of the window used last. */
  chordFor(agent: ControlAgent, name: string, profileId: ProfileId | null): ChordId {
    for (const chord of this.chords.values()) if (chord.agent === agent && !chord.done) return chord.chordId;
    const state = this.deps.store.state;
    const windowId = this.deps.lastWindow()?.id;
    const profile = profileId ?? (windowId ? state.chords[state.windows[windowId]?.activeChordId ?? '']?.profileId : undefined) ?? 'default';
    const chordId = uuidv7();
    this.deps.store.dispatch({ t: 'agent.chord.add', chordId, name, profileId: profile });
    const chord: AgentChord = { chordId, name, agent, done: false, notes: [], unlisten: agent.listen(() => this.update(chord)) };
    this.chords.set(chordId, chord);
    return chordId;
  }

  /** The agent's chord, if it has one. */
  chordOf(agent: ControlAgent): ChordId | null {
    for (const chord of this.chords.values()) if (chord.agent === agent && !chord.done) return chord.chordId;
    return null;
  }

  /** The agent's tabs, newest first, as the sidebar lists them. */
  tabsOf(chordId: ChordId): TabNode[] {
    return nodesOfChord(this.deps.store.state, chordId)
      .filter((n): n is TabNode => n.kind === 'tab')
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  }

  /* ---------- The bar, throttling and your hands ---------- */

  private live(chord: AgentChord, nodeId: NodeId): AgentLive | null {
    const state = chord.agent.state(nodeId);
    if (chord.done) return null;
    if (chord.agent.isStopped) return { name: chord.name, chordId: chord.chordId, state: 'stopped' };
    if (state.paused) return { name: chord.name, chordId: chord.chordId, state: 'paused' };
    if (state.cards.length > 0) return { name: chord.name, chordId: chord.chordId, state: 'working', waiting: true };
    const doing = this.doings.get(nodeId)?.text;
    if (state.calls > 0 || doing) return { name: chord.name, chordId: chord.chordId, state: 'working', ...(doing ? { doing } : {}) };
    return null;
  }

  /**
   * What the agent is doing on a tab now (M2c: core's barDoing), or null when it's done. The bar shows each wording at
   * least ACT_BAR_MIN_MS, so a fast agent doesn't make it flicker: a newer one waits out the rest of the older's time,
   * and the last one stays that long after the action ends.
   */
  doing(nodeId: NodeId, doing: BarDoing | null): void {
    const chord = this.chordOfTab(nodeId);
    if (!chord) return;
    const now = this.deps.now?.() ?? Date.now();
    const current = this.doings.get(nodeId);
    if (current?.clear) clearTimeout(current.clear);
    if (doing) {
      this.doings.set(nodeId, { text: barDoing(doing), since: now });
      return this.update(chord);
    }
    if (!current) return;
    const left = ACT_BAR_MIN_MS - (now - current.since);
    const end = () => {
      if (this.doings.get(nodeId) !== current) return;
      this.doings.delete(nodeId);
      const still = this.chordOfTab(nodeId);
      if (still) this.update(still);
    };
    if (left <= 0) return end();
    current.clear = setTimeout(end, left);
    current.clear.unref?.();
  }

  /** The agent's state changed: each of its tabs' bars, and whether each runs at full speed. */
  private update(chord: AgentChord): void {
    for (const tab of this.tabsOf(chord.chordId)) {
      // Stop: what its tabs held to send fails, and their cards come down (control/sends.ts).
      if (chord.agent.isStopped) {
        const page = this.deps.page(tab.id);
        if (page && !page.isDestroyed()) failHeld(page);
      }
      const live = this.live(chord, tab.id);
      const key = live ? `${live.state}${live.waiting ? ':waiting' : ''}${live.doing ? `:${live.doing}` : ''}` : '';
      if ((this.shown.get(tab.id) ?? '') !== key) {
        if (key) this.shown.set(tab.id, key);
        else this.shown.delete(tab.id);
        this.deps.store.dispatch({ t: 'tab.live', nodeId: tab.id, live: { agent: live } });
      }
      const working = live?.state === 'working';
      if (working !== this.unthrottled.has(tab.id)) {
        const page = this.deps.page(tab.id);
        if (working) this.unthrottled.add(tab.id);
        else this.unthrottled.delete(tab.id);
        if (page && !page.isDestroyed()) page.setBackgroundThrottling(!working);
      }
    }
  }

  /** After a change to windows or tabs: a paused tab no one shows goes on; a done chord with no tabs left goes. */
  private settle(chord: AgentChord): void {
    const state = this.deps.store.state;
    if (!state.chords[chord.chordId]) return this.forget(chord);
    const tabs = this.tabsOf(chord.chordId);
    // A tab gone to a site the user keeps private closes, and nothing it held reaches the agent; one you took there
    // is yours now.
    const sites = this.deps.neverSites?.() ?? [];
    for (const tab of tabs.filter((t) => onNeverSite(t.url, sites))) {
      this.dropNotes(tab.id);
      const windowId = this.yoursNow(tab.id);
      if (windowId) {
        this.deps.store.dispatch({ t: 'agent.tab.keep', nodeId: tab.id, windowId });
        this.onHandedOver?.(tab.id);
      } else this.deps.store.dispatch({ t: 'agent.tab.remove', nodeId: tab.id });
      this.userActs.delete(tab.id);
    }
    if (chord.done && tabs.length === 0) {
      this.deps.store.dispatch({ t: 'agent.chord.remove', chordId: chord.chordId });
      return this.forget(chord);
    }
    const shown = new Set(Object.values(state.windows).map((w) => w.agentTab));
    for (const tab of tabs) if (chord.agent.state(tab.id).paused && !shown.has(tab.id)) chord.agent.pause(tab.id, false);
  }

  private forget(chord: AgentChord): void {
    chord.unlisten();
    this.chords.delete(chord.chordId);
    this.prune();
  }

  /** You acted in an agent's tab (a key, a click, an address typed for it): what it does next is yours. */
  userActed(nodeId: NodeId): void {
    if (this.chordOfTab(nodeId)) this.userActs.set(nodeId, this.deps.now?.() ?? Date.now());
  }

  /**
   * You took an agent's tab over (S18 M2e-1): a key or click of yours in its page, or your reload, back, forward or typed
   * address for it. The agent is paused there (it hears the user is using the tab), what the page held to send for it
   * fails, and the cards waiting for that tab alone come down. Only ever called from your own input and Chord's own
   * buttons, keys and menus, never from the page navigating itself (Neon's B6: a pause makes its sends yours, so a
   * page's own reload or redirect must not be able to turn the hold off). A tab that isn't an agent's: nothing.
   */
  takeOver(nodeId: NodeId, contents = this.deps.page(nodeId), navigating = false): void {
    const chord = this.chordOfTab(nodeId);
    if (!chord) return;
    const live = contents && !contents.isDestroyed() ? contents : null;
    // Never your keys stopped: an action's guard comes down at once (the action stops at its next check).
    if (live) dropAgentGuard(live);
    this.userActed(nodeId);
    // What the page held to send for the agent fails before anything is yours, and the tab's cards come down.
    if (live) failHeld(live);
    chord.agent.cancelCardsFor(nodeId);
    if (navigating && live) this.leave(nodeId);
    // Paused (its sends yours) only where you can see it: a tab no window shows stays the agent's, held as before
    // (Neon's B1 on #116: a reload from its row's menu mustn't turn the hold off unseen, with no bar to say so).
    const shown = Object.values(this.deps.store.state.windows).some((w) => w.agentTab === nodeId);
    if (shown && !chord.done && !chord.agent.state(nodeId).paused) chord.agent.pause(nodeId, true);
  }

  /** takeOver, for a page Chord's buttons, keys or menus are about to reload or move (a tab of yours: nothing). */
  takeOverPage(contents: WebContents): void {
    for (const chord of this.chords.values()) {
      for (const tab of this.tabsOf(chord.chordId)) if (this.deps.page(tab.id) === contents) return this.takeOver(tab.id, contents, true);
    }
  }

  /** The page in this tab is on its way out (you moved it): its sends are no one's until the next one loads. */
  private leave(nodeId: NodeId): void {
    const was = this.leaving.get(nodeId);
    if (was) clearTimeout(was.timer);
    const timer = setTimeout(() => this.leaving.delete(nodeId), LEAVING_MS);
    timer.unref?.();
    this.leaving.set(nodeId, { committed: false, timer });
  }

  private left(nodeId: NodeId): void {
    const was = this.leaving.get(nodeId);
    if (!was) return;
    clearTimeout(was.timer);
    this.leaving.delete(nodeId);
  }

  /** A tab of the agent's that's gone, or yours now: its cards, its pause and its bar's wording go with it. */
  private letGo(chord: AgentChord, nodeId: NodeId): void {
    chord.agent.cancelCardsFor(nodeId);
    if (chord.agent.state(nodeId).paused) chord.agent.pause(nodeId, false);
    const doing = this.doings.get(nodeId);
    if (doing?.clear) clearTimeout(doing.clear);
    this.doings.delete(nodeId);
    this.left(nodeId);
    const page = this.deps.page(nodeId);
    if (page && !page.isDestroyed()) failHeld(page);
  }

  /** The window showing the tab, if you acted in it just now: its going somewhere is yours. */
  private yoursNow(nodeId: NodeId): WindowId | null {
    const at = this.userActs.get(nodeId);
    if (at === undefined || (this.deps.now?.() ?? Date.now()) - at > USER_MS) return null;
    const state = this.deps.store.state;
    return Object.values(state.windows).find((w) => w.agentTab === nodeId)?.id ?? null;
  }

  /** What's kept per tab goes with the tab. */
  private prune(): void {
    const state = this.deps.store.state;
    for (const id of [...this.userActs.keys()]) if (!nodeOf(state, id)) this.userActs.delete(id);
    for (const id of [...this.shown.keys()]) if (!nodeOf(state, id)) this.shown.delete(id);
    for (const id of [...this.unthrottled]) if (!nodeOf(state, id)) this.unthrottled.delete(id);
  }

  /** An agent tab's page was made: a key you press or a click of yours there pauses the agent on it; leaving it never asks (beforeunload). */
  wire(contents: WebContents, nodeId: NodeId): void {
    // Made while the agent already works on the tab (its first load, or after it slept): full speed now too.
    if (this.unthrottled.has(nodeId)) contents.setBackgroundThrottling(false);
    // Only your hands: input Chord sends for an agent (control/input.ts) never pauses it or makes a navigation yours.
    // Your hands: a key, or a button pressed (Neon's review of #110: a click is using the tab as much as a key is).
    const yours = () => this.takeOver(nodeId, contents);
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown' && !isAgentInput(contents)) yours();
    });
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && !isAgentInput(contents)) yours();
    });
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    // The page you sent it to: committed, then loaded (or failed): what it sends is judged as anything else again.
    contents.on('did-navigate', () => {
      const was = this.leaving.get(nodeId);
      if (was) was.committed = true;
    });
    contents.on('did-stop-loading', () => {
      if (this.leaving.get(nodeId)?.committed) this.left(nodeId);
    });
    // Back or forward within the same document (a pushState entry): nothing unloads, so nothing is on its way out.
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.left(nodeId);
    });
    contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) this.left(nodeId);
    });
    // What it sends (control/sends.ts): the agent's (held, asked) unless you have the tab (it's paused); once the agent is
    // done, only what follows your own key or click goes, the rest no one is there to ask about.
    sendHoldDeps(contents, {
      whose: (request) => {
        // The page you moved it from, on its way out: none of its sends go (the page you sent it to loads as usual).
        if (this.leaving.has(nodeId) && request && request.type !== 'Document') return 'none';
        const chord = this.chordOfTab(nodeId);
        // An agent's page never becomes yours (a tab you keep gets a new one): with its chord gone (closed, Close all, a
        // site you keep private), what it sends on its way out is no one's to ask about, and fails (round 4 of #112).
        if (!chord) return 'none';
        // Paused: you have the tab. Holding goes on once the agent continues (the owner, 2026-11-23).
        if (chord.agent.state(nodeId).paused) return 'user';
        // A done agent's tab: only what follows your own key or click there goes.
        if (chord.done) return this.yoursNow(nodeId) !== null ? 'user' : 'none';
        return 'agent';
      },
      ask: async (sites, why, signal, going) => {
        const chord = this.chordOfTab(nodeId);
        if (!chord || chord.done) return 'deny';
        const takeDown = new AbortController();
        signal.addEventListener('abort', () => takeDown.abort(), { once: true });
        // Exact origins (the owner, 2026-11-23), each by its host, its scheme too where it isn't https or the page's.
        const page = contents.getURL();
        const site = shownOrigin(originOf(page), page);
        const hosts = sites.map((o) => shownOrigin(o, page));
        const answer = await chord.agent.ask(
          {
            kind: 'step',
            tool: 'tab',
            description: '',
            target: [contents.getURL()],
            tab: nodeId,
            subject: `${nodeId}|idle|${randomBytes(4).toString('hex')}`,
            step: why ? { why, site: hosts[0] ?? site, fields: [], more: 0, idle: true, ...(going ? { going: barAddress(going) } : {}) } : { why: 'send', site, fields: [], more: 0, sends: hosts, idle: true },
            takeDown: takeDown.signal,
          },
          signal,
          this.deps.waitMs ?? CONTROL_WAIT_MS,
        );
        // No answer in time: the card comes down, and what it held fails.
        if (answer === 'waiting') takeDown.abort();
        // A send card's `always` is *Allow until done* (never remembered: a step card's answers aren't).
        return answer === 'always' && !why ? 'until' : answer === 'once' || answer === 'always' ? 'once' : 'deny';
      },
      // Exactly an origin (the owner, 2026-11-23): another subdomain, port or scheme is another card.
      siteOf: (url) => originOf(url),
    });
  }

  private chordOfTab(nodeId: NodeId): AgentChord | null {
    const node = nodeOf(this.deps.store.state, nodeId);
    return node ? (this.chords.get(node.chordId) ?? null) : null;
  }

  /* ---------- Held, for the agent ---------- */

  /** `from`: where it came from (a download's address), if not the detail itself (a popup's). */
  note(nodeId: NodeId, what: AgentHeld, detail: string, from?: string): void {
    const chord = this.chordOfTab(nodeId);
    if (!chord || this.onPrivateSite(nodeId)) return;
    // A popup or a download from a site the user keeps private (one the tab never got to): never named.
    const source = what === 'popup' ? detail : from;
    const hidden = source !== undefined && onNeverSite(source, this.deps.neverSites?.() ?? []);
    const text = hidden ? (what === 'popup' ? 'a site the user keeps private' : 'a file from a site the user keeps private') : detail.slice(0, 500);
    // A site asks for a sign-in on every retry and every page of it: one note per tab and origin (the note names
    // it) until the agent hears it.
    if (what === 'signin' && chord.notes.some((n) => n.what === 'signin' && n.nodeId === nodeId && n.detail === text)) return;
    chord.notes.push({ nodeId, what, detail: text });
    if (chord.notes.length > NOTES_KEPT) chord.notes.splice(0, chord.notes.length - NOTES_KEPT);
  }

  /** What the agent's tabs held since its last result, and forget it. */
  drain(agent: ControlAgent): AgentNote[] {
    const chordId = this.chordOf(agent);
    const chord = chordId ? this.chords.get(chordId) : undefined;
    return chord ? chord.notes.splice(0).filter((n) => !this.onPrivateSite(n.nodeId)) : [];
  }

  /** Forget what a tab held: it went to a site the user keeps private. */
  dropNotes(nodeId: NodeId): void {
    for (const chord of this.chords.values()) chord.notes = chord.notes.filter((n) => n.nodeId !== nodeId);
  }

  /** Whether the tab is, by its saved address or its page's, on a site the user keeps private. */
  private onPrivateSite(nodeId: NodeId): boolean {
    const sites = this.deps.neverSites?.() ?? [];
    const node = nodeOf(this.deps.store.state, nodeId);
    const page = this.deps.page(nodeId);
    return (node?.kind === 'tab' && onNeverSite(node.url, sites)) || Boolean(page && !page.isDestroyed() && onNeverSite(page.getURL(), sites));
  }

  /* ---------- Stop, continue, and when it's done ---------- */

  /** "Let … continue": after Stop, or a tab you paused. */
  continue(chordId: ChordId): void {
    const chord = this.chords.get(chordId);
    if (!chord) return;
    for (const tab of this.tabsOf(chordId)) if (chord.agent.state(tab.id).paused) chord.agent.pause(tab.id, false);
    chord.agent.resume();
  }

  stopAll(): void {
    for (const chord of this.chords.values()) chord.agent.stop();
  }

  /** The agent's connection ended: its chord stays, and you're asked what becomes of its tabs. */
  done(agent: ControlAgent): void {
    // *Allow until done* ends with the agent (control/sends.ts).
    const ended = this.chordOf(agent);
    if (ended) {
      for (const tab of this.tabsOf(ended)) {
        const page = this.deps.page(tab.id);
        if (page && !page.isDestroyed()) endUntil(page);
      }
    }
    const chordId = this.chordOf(agent);
    const chord = chordId ? this.chords.get(chordId) : undefined;
    if (!chord) return;
    chord.done = true;
    this.update(chord);
    for (const tab of this.tabsOf(chord.chordId)) {
      const page = this.deps.page(tab.id);
      if (this.unthrottled.delete(tab.id) && page && !page.isDestroyed()) page.setBackgroundThrottling(true);
    }
    const count = this.tabsOf(chord.chordId).length;
    if (count === 0) {
      this.deps.store.dispatch({ t: 'agent.chord.remove', chordId: chord.chordId });
      return this.forget(chord);
    }
    this.askToKeep(chord);
  }

  /** "… finished. Keep these tabs?": Keep, or Close all. */
  private askToKeep(chord: AgentChord): void {
    const w = this.deps.lastWindow();
    w?.toast({
      id: `agent-done:${chord.chordId}`,
      message: `${chord.name} finished. Keep these tabs?`,
      action: { label: 'Keep', command: { t: 'agents.keep', windowId: w.id, chordId: chord.chordId } },
      secondary: { label: 'Close all', command: { t: 'agents.closeAll', chordId: chord.chordId } },
    });
  }

  /** Keep: the agent's tabs move into the window's chord. */
  keep(windowId: WindowId, chordId: ChordId): void {
    // Only once the agent's done: a toast from before can't take tabs from an agent still at work.
    if (!isAgentChord(this.deps.store.state, chordId) || !this.chords.get(chordId)?.done) return;
    this.deps.store.dispatch({ t: 'agent.chord.keep', chordId, windowId });
    const chord = this.chords.get(chordId);
    if (chord) this.forget(chord);
  }

  /** Close all: the agent's chord and tabs go, with Undo. */
  closeAll(chordId: ChordId): void {
    const state = this.deps.store.state;
    const chord = state.chords[chordId];
    if (!chord?.agent || !this.chords.get(chordId)?.done) return;
    const tabs = this.tabsOf(chordId);
    const token = randomBytes(12).toString('hex');
    const held = this.chords.get(chordId) ?? null;
    this.undos.set(token, { chord, tabs, record: held });
    while (this.undos.size > UNDOS_KEPT) this.undos.delete(this.undos.keys().next().value!);
    if (held) this.forget(held);
    this.deps.store.dispatch({ t: 'agent.chord.remove', chordId });
    this.deps.lastWindow()?.toast({
      id: `agent-done:${chordId}`,
      message: `Closed ${tabs.length === 1 ? '1 tab' : `${tabs.length} tabs`}`,
      action: { label: 'Undo', command: { t: 'agents.undoClose', token } },
    });
  }

  /** Close all's Undo: the chord and its tabs come back, their pages loading again when shown. */
  undoClose(token: string): void {
    const undo = this.undos.get(token);
    if (!undo) return;
    this.undos.delete(token);
    // Back as it was when closed: a finished agent's chord, which goes once its last tab does.
    const record: AgentChord | null = undo.record ? { ...undo.record, done: true, unlisten: () => undefined } : null;
    if (record) this.chords.set(undo.chord.id, record);
    this.deps.store.dispatch({ t: 'agent.chord.restore', chord: undo.chord, tabs: undo.tabs });
    // Back where it was: you're asked again what becomes of its tabs.
    if (record) this.askToKeep(record);
  }

  dispose(): void {
    this.unsubscribe();
    for (const chord of [...this.chords.values()]) this.forget(chord);
  }
}


/** An address's origin (scheme, host and port), or empty. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
