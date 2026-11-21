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
import type { AgentHello, Command, ProfileId } from '@chord/core';
import type { ControlBrowser } from '../control/tools';
import { startEndpoint, type Endpoint } from './endpoint';
import type { AgentChords, AgentChordsDeps } from './chords';
import type { AgentConnection } from './connection';
import type { ConnectAnswer, ConnectingAgent } from './connect';
import type { ProcessInfo } from './parent';
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
            if (chordsModule && this.deps.chords && !this.chords) this.chords = new chordsModule.AgentChords(this.deps.chords);
            if (gone) return;
            const connection = agentConnection(hello, send, {
              browser: this.deps.browser,
              waitMs: this.deps.waitMs,
              log: this.deps.log,
              ...(this.chords ? { chords: this.chords } : {}),
              ...(this.deps.dispatch ? { dispatch: this.deps.dispatch } : {}),
              ...(this.deps.neverSites ? { neverSites: this.deps.neverSites } : {}),
              allowedProfile: () => held?.profileId ?? null,
              present: async (card, signal) => {
                if (card.kind !== 'connection' || !held) return 'deny';
                // Who started it, looked up while the card shows (about 1 s on Windows), never inside a call.
                held.parent ??= import('./parent').then(({ ancestry }) => ancestry(hello.parentPid)).catch(() => []);
                const answer = await this.deps.ask({ name: held.connection.name, folder: hello.cwd, parent: held.parent }, signal);
                held.profileId = answer.profileId;
                held.always = answer.grant === 'always';
                this.deps.changed?.();
                return answer.grant;
              },
            });
            const record: HeldConnection = { connection, hello, socket, parent: null, profileId: null, always: false };
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
    }
    this.endpoint?.close();
    this.endpoint = null;
    this.restricted = null;
    for (const held of this.connections) held.connection.closed();
    this.connections.clear();
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

  /** An agent removed from Allowed in Settings: it's let go now, and asks again next time. */
  disconnect(name: string): void {
    for (const held of [...this.connections]) if (held.always && held.connection.name === name) held.socket.destroy();
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
