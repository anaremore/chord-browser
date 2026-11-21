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
import { randomBytes } from 'node:crypto';
import { isAgentChord, nodeOf, nodesOfChord, uuidv7, type AgentLive, type Chord, type ChordId, type Command, type NodeId, type ProfileId, type State, type TabNode, type WindowId } from '@chord/core';
import type { Toast } from '@chord/ipc';
import type { WebContents } from 'electron';
import type { ControlAgent } from '../control/gate';
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

export class AgentChords {
  private readonly chords = new Map<ChordId, AgentChord>();
  /** What each agent tab's bar says now, so only changes are dispatched. */
  private readonly shown = new Map<NodeId, string>();
  /** Agent tabs running at full speed while hidden. */
  private readonly unthrottled = new Set<NodeId>();
  private readonly undos = new Map<string, { chord: Chord; tabs: TabNode[]; record: AgentChord | null }>();
  /** When you last pressed a key, clicked or typed an address in each agent tab. */
  private readonly userActs = new Map<NodeId, number>();
  private readonly unsubscribe: () => void;
  /** A tab handed over to you: the agents' refs for it say it's closed. Set by the service. */
  onHandedOver: ((nodeId: NodeId) => void) | null = null;

  constructor(private readonly deps: AgentChordsDeps) {
    // Leaving a tab you paused lets the agent go on there; your closing an agent's last tab ends its chord once it's
    // done; a site added to the *Never* list closes its agent tabs.
    this.unsubscribe = deps.store.subscribe((change) => {
      const never = change.before.settings.assistant.neverSites !== change.state.settings.assistant.neverSites;
      if (!never && !change.patches.some((p) => p.path[0] === 'windows' || p.path[0] === 'nodes')) return;
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
    if (state.calls > 0 || state.cards.length > 0) return { name: chord.name, chordId: chord.chordId, state: 'working' };
    return null;
  }

  /** The agent's state changed: each of its tabs' bars, and whether each runs at full speed. */
  private update(chord: AgentChord): void {
    for (const tab of this.tabsOf(chord.chordId)) {
      const live = this.live(chord, tab.id);
      const key = live ? live.state : '';
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

  /** An agent tab's page was made: a key you press there pauses the agent on it; leaving it never asks (beforeunload). */
  wire(contents: WebContents, nodeId: NodeId): void {
    // Made while the agent already works on the tab (its first load, or after it slept): full speed now too.
    if (this.unthrottled.has(nodeId)) contents.setBackgroundThrottling(false);
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') this.userActed(nodeId);
    });
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      this.userActed(nodeId);
      const chord = this.chordOfTab(nodeId);
      if (chord && !chord.done && !chord.agent.state(nodeId).paused) chord.agent.pause(nodeId, true);
    });
    contents.on('will-prevent-unload', (event) => event.preventDefault());
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
