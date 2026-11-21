/**
 * Outside agents in Chord's main (S18 M1b): the endpoint while Agents is on,
 * and a connection per agent. Loaded only when Agents is on (switch.ts), and
 * at that point it does two things: one pipe (or socket) and one token file.
 * Everything else waits for the first connection: the connection's code and
 * the gate (connection.ts), the Windows DACL helper, the parent lookup.
 *
 * The connection card is the connect card (connect.ts, M1d), and Settings →
 * Agents' switch (off by default) is the only way here.
 */
import { execFile } from 'node:child_process';
import type { AgentHello, Command, NodeId, ProfileId } from '@chord/core';
import type { ControlBrowser } from '../control/tools';
import { startEndpoint, type Endpoint } from './endpoint';
import type { AgentChords, AgentChordsDeps } from './chords';
import type { AgentConnection } from './connection';
import type { ConnectAnswer, ConnectingAgent } from './connect';
import type { ProcessInfo } from './parent';
// The service loads with the first time Agents is on, never at launch: so does what decides a tab can be shared.
import { shareable, type AgentShares } from './shares';
import type { Socket } from 'node:net';

export interface AgentServiceDeps {
  userData: string;
  browser: ControlBrowser;
  /** The connect card (connect.ts): asks you, or lets in an agent you allowed for good. */
  ask(who: ConnectingAgent, signal: AbortSignal): Promise<ConnectAnswer>;
  /** What Settings → Agents shows changed: an agent connected, went, stopped or continued. */
  changed?(): void;
  /** Windows: window-owner.exe, for the pipe's DACL; null where there's none. */
  helper: string | null;
  /** How long a call waits on a card (CONTROL_WAIT_MS unless a test says). */
  waitMs?: number;
  log?(...args: unknown[]): void;
  /** For the agents' chords (M1c), made with the first connection; absent, agents open no tabs. */
  chords?: AgentChordsDeps;
  dispatch?(command: Command): void;
  neverSites?(): readonly string[];
}

/** A connection Chord holds: the agent, and who started it once looked up (for M1d's card and Settings). */
export interface HeldConnection {
  connection: AgentConnection;
  /** Its hello, without the token: nothing keeps the token but the endpoint. */
  hello: Omit<AgentHello, 'token'>;
  /** Its end of the endpoint: Remove in Settings hangs up on it. */
  socket: Socket;
  parent: Promise<ProcessInfo[]> | null;
  /** The sign-ins it was let in with (the window you answered in, or those of its Always allow). */
  profileId: ProfileId | null;
  /** Let in for good (Always allow, now or before). */
  always: boolean;
  /** The program its allowance is kept by (Always allow with a known program): Remove matches name and program. */
  allowedParent: string | null;
  /** Let in (once or always): a tab can be shared with it. */
  letIn: boolean;
}

/** Messages a connection may send while its code loads (an MCP client sends two or three). */
export const QUEUED_MAX = 32;

export class AgentService {
  private endpoint: Endpoint | null = null;
  private starting: Promise<void> | null = null;
  readonly connections = new Set<HeldConnection>();
  /** The agents' chords: made with the first connection, so with no agent there are none and nothing runs for them. */
  chords: AgentChords | null = null;
  /** The DACL helper's run, once per endpoint (Windows). */
  restricted: Promise<number> | null = null;
  /** Tabs you share with agents (M1e): made with the first share. */
  shares: AgentShares | null = null;

  constructor(private readonly deps: AgentServiceDeps) {}

  get serving(): Endpoint | null {
    return this.endpoint;
  }

  /** One pipe and one token file; nothing else until a connection comes. */
  start(): Promise<void> {
    if (this.endpoint) return Promise.resolve();
    this.starting ??= (async () => {
      const endpoint = await startEndpoint({
        userData: this.deps.userData,
        log: this.deps.log,
        // The path comes with it: a connection can arrive before startEndpoint has returned, and must never skip the DACL.
        onFirstConnection: (path) => {
          if (process.platform === 'win32' && this.deps.helper) this.restricted = restrictPipe(this.deps.helper, path);
        },
        onConnection: ({ token: _token, ...hello }, send, socket) => {
          // The connection's code loads with the first one; messages that come meanwhile wait.
          const queued: Record<string, unknown>[] = [];
          let held: HeldConnection | null = null;
          let gone = false;
          void Promise.all([import('./connection'), this.deps.chords && !this.chords ? import('./chords') : null]).then(([{ agentConnection }, chordsModule]) => {
            if (chordsModule && this.deps.chords && !this.chords) {
              this.chords = new chordsModule.AgentChords(this.deps.chords);
              // A tab you took over (to a site you keep private) is closed, as far as any agent knows.
              this.chords.onHandedOver = (nodeId) => {
                for (const h of this.connections) h.connection.forget(nodeId);
              };
            }
            if (gone) return;
            const connection = agentConnection(hello, send, {
              browser: this.deps.browser,
              waitMs: this.deps.waitMs,
              log: this.deps.log,
              ...(this.chords ? { chords: this.chords } : {}),
              ...(this.deps.dispatch ? { dispatch: this.deps.dispatch } : {}),
              ...(this.deps.neverSites ? { neverSites: this.deps.neverSites } : {}),
              shares: () => this.shares,
              allowedProfile: () => held?.profileId ?? null,
              present: async (card, signal) => {
                if (card.kind !== 'connection' || !held) return 'deny';
                // Who started it, looked up while the card shows (about 1 s on Windows), never inside a call.
                held.parent ??= import('./parent').then(({ ancestry }) => ancestry(hello.parentPid)).catch(() => []);
                const answer = await this.deps.ask({ name: held.connection.name, folder: hello.cwd, parent: held.parent }, signal);
                held.profileId = answer.profileId;
                held.always = answer.grant === 'always';
                held.allowedParent = answer.allowedParent ?? null;
                held.letIn = answer.grant !== 'deny';
                this.publishLetIn();
                this.deps.changed?.();
                return answer.grant;
              },
            });
            const record: HeldConnection = { connection, hello, socket, parent: null, profileId: null, always: false, allowedParent: null, letIn: false };
            held = record;
            this.connections.add(record);
            // Settings → Agents lists the stopped ones: it hears when one stops or goes on.
            let stopped = false;
            connection.agent.listen(() => {
              if (connection.agent.isStopped === stopped) return;
              stopped = connection.agent.isStopped;
              this.deps.changed?.();
            });
            this.deps.changed?.();
            for (const m of queued.splice(0)) connection.message(m);
          }).catch((error: unknown) => {
            // The connection's code didn't load: hang up, so the relay says Chord isn't open rather than waiting forever.
            this.deps.log?.('agents: a connection couldn’t start:', error);
            console.warn('[chord] agents: a connection couldn’t start:', error instanceof Error ? error.message : error);
            socket.destroy();
          });
          return {
            // Only so many wait: a peer that floods them is hung up on.
            message: (m) => {
              if (held) return held.connection.message(m);
              if (queued.length >= QUEUED_MAX) return void socket.destroy();
              queued.push(m);
            },
            closed: () => {
              gone = true;
              if (!held) return;
              held.connection.closed();
              this.connections.delete(held);
              this.publishLetIn();
              this.deps.changed?.();
            },
          };
        },
      });
      this.endpoint = endpoint;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  /**
   * Agents off, or quitting: every connection ends, and the pipe and the file go. Off, each agent's chord asks
   * whether to keep its tabs; quitting, nothing asks (the chords, in memory only, go with Chord).
   */
  async stop(quitting = false): Promise<void> {
    await this.starting?.catch(() => undefined);
    if (quitting) {
      this.chords?.dispose();
      this.chords = null;
      this.shares?.dispose();
      this.shares = null;
    }
    this.endpoint?.close();
    this.endpoint = null;
    this.restricted = null;
    for (const held of this.connections) held.connection.closed();
    this.connections.clear();
    this.publishLetIn();
  }

  /** Stop for every agent (Ctrl+. / ⌘. in M1c): calls in flight answer now, later ones are refused. */
  stopAll(): void {
    for (const held of this.connections) held.connection.agent.stop();
  }

  /** Settings → Agents' "Let … continue", for a stopped agent by its gate's id (tabs or none). */
  continue(agentId: string): void {
    for (const held of this.connections) {
      if (held.connection.agent.id !== agentId) continue;
      const chordId = this.chords?.chordOf(held.connection.agent);
      if (chordId) this.chords!.continue(chordId);
      else held.connection.agent.resume();
    }
  }

  /** How many agents are let in, for the store (`agentsLetIn`): the command bar offers sharing only then. */
  private publishLetIn(): void {
    let count = 0;
    for (const held of this.connections) if (held.letIn) count++;
    this.deps.dispatch?.({ t: 'agents.letIn', count });
  }

  /** The agents let in now (once or always), the one that called last first: those a tab can be shared with. */
  sharingWith(): { id: string; name: string }[] {
    return [...this.connections]
      .filter((h) => h.letIn)
      .reverse()
      .sort((a, b) => b.connection.lastCallAt - a.connection.lastCallAt)
      .map((h) => ({ id: h.connection.agent.id, name: h.connection.name }));
  }

  /**
   * The tab menu's sharing item for a tab (M1e): whom it's shared with, or whom it can be shared with; null when no
   * agent is let in or the tab can't be shared (the item isn't there).
   */
  shareMenu(nodeId: NodeId): { sharedWith: string } | { agents: { id: string; name: string }[] } | null {
    const now = this.shares?.sharedWith(nodeId);
    if (now) return { sharedWith: now.name };
    const store = this.deps.chords?.store;
    const agents = this.sharingWith();
    return store && agents.length > 0 && shareable(store.state, nodeId, this.deps.neverSites?.() ?? []) ? { agents } : null;
  }

  /** Whether any tab is shared now: the window's bars need syncing only then (or with agents' chords). */
  get sharing(): boolean {
    return (this.shares?.count ?? 0) > 0;
  }

  /**
   * Share a tab of yours (M1e): with `agentId`, or the agent that called last. A tab already shared with that agent
   * (or with any, when none is named) stops being shared instead. `none`: no agent to share with; `no`: the tab
   * can't be shared (not a web page of yours, or a site you keep private).
   */
  async toggleShare(nodeId: NodeId, agentId?: string): Promise<'shared' | 'unshared' | 'none' | 'no'> {
    const now = this.shares?.sharedWith(nodeId) ?? null;
    if (now && (!agentId || now.agentId === agentId)) {
      this.shares!.unshare(nodeId);
      return 'unshared';
    }
    const agent = agentId ? this.sharingWith().find((a) => a.id === agentId) : this.sharingWith()[0];
    if (!agent) return 'none';
    const store = this.deps.chords?.store;
    if (!store) return 'no';
    if (!this.shares) {
      const { AgentShares } = await import('./shares');
      this.shares ??= new AgentShares({ store, neverSites: () => this.deps.neverSites?.() ?? [] });
    }
    const held = [...this.connections].find((h) => h.connection.agent.id === agent.id);
    if (!held) return 'none';
    const chordId = this.chords?.chordOf(held.connection.agent) ?? '';
    return this.shares.share(nodeId, { agentId: agent.id, name: agent.name, chordId }) ? 'shared' : 'no';
  }

  /** An agent removed from Allowed in Settings: it's let go now, and asks again next time. */
  disconnect(name: string, parent: string): void {
    for (const held of [...this.connections]) if (held.always && held.connection.name === name && held.allowedParent === parent) held.socket.destroy();
  }
}

/** The pipe's DACL, tightened by window-owner.exe (its `restrict-pipe` verb); its exit code. */
export function restrictPipe(helper: string, path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(helper, ['restrict-pipe', path], { windowsHide: true, timeout: 10_000 }, (error) => {
      if (!error) return resolve(0);
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number') console.warn(`[chord] couldn't tighten the agent pipe's access (window-owner exited ${code})`);
      resolve(typeof code === 'number' ? code : -1);
    });
  });
}
