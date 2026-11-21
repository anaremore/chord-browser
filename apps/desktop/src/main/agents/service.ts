/**
 * Outside agents in Chord's main (S18 M1b): the endpoint while Agents is on,
 * and a connection per agent. Loaded only when Agents is on (switch.ts), and
 * at that point it does two things: one pipe (or socket) and one token file.
 * Everything else waits for the first connection: the connection's code and
 * the gate (connection.ts), the Windows DACL helper, the parent lookup.
 *
 * Until Settings → Agents and its card (M1d), a development-only hook answers
 * the connection card (CHORD_AGENT_APPROVE), and packaged builds never get here.
 */
import { execFile } from 'node:child_process';
import type { AgentHello, Command, Grant, ProfileId } from '@chord/core';
import type { CardPresenter } from '../control/gate';
import type { ControlBrowser } from '../control/tools';
import { startEndpoint, type Endpoint } from './endpoint';
import type { AgentChords, AgentChordsDeps } from './chords';
import type { AgentConnection } from './connection';
import type { ProcessInfo } from './parent';

/**
 * The development hook's answer to a connection card: `once` (the default), `always`, `deny`,
 * `hold` (never answers: *waiting*), or `delay:<ms>` then once.
 */
export type DevApproval = 'once' | 'always' | 'deny' | 'hold' | `delay:${number}`;

export function devApproval(value: string | undefined): DevApproval {
  if (value === 'always' || value === 'deny' || value === 'hold') return value;
  if (value && /^delay:\d{1,6}$/.test(value)) return value as DevApproval;
  return 'once';
}

/** The hook as a card presenter: it answers as told, or no when the card is taken down. */
export function devPresenter(approval: DevApproval): CardPresenter {
  return (_card, signal) =>
    new Promise<Grant>((resolve) => {
      signal.addEventListener('abort', () => resolve('deny'), { once: true });
      if (approval === 'hold') return;
      if (approval.startsWith('delay:')) setTimeout(() => resolve('once'), Number(approval.slice(6))).unref?.();
      else resolve(approval as Grant);
    });
}

export interface AgentServiceDeps {
  userData: string;
  browser: ControlBrowser;
  present: CardPresenter;
  /** Windows: window-owner.exe, for the pipe's DACL; null where there's none. */
  helper: string | null;
  /** How long a call waits on a card (CONTROL_WAIT_MS unless a test says). */
  waitMs?: number;
  log?(...args: unknown[]): void;
  /** For the agents' chords (M1c), made with the first connection; absent, agents open no tabs. */
  chords?: AgentChordsDeps;
  dispatch?(command: Command): void;
  neverSites?(): readonly string[];
  /** The sign-ins of the window where the user let an agent in. */
  allowedProfile?(): ProfileId | null;
}

/** A connection Chord holds: the agent, and who started it once looked up (for M1d's card and Settings). */
export interface HeldConnection {
  connection: AgentConnection;
  /** Its hello, without the token: nothing keeps the token but the endpoint. */
  hello: Omit<AgentHello, 'token'>;
  parent: Promise<ProcessInfo[]> | null;
}

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
        onFirstConnection: () => {
          if (process.platform === 'win32' && this.deps.helper && this.endpoint) this.restricted = restrictPipe(this.deps.helper, this.endpoint.path);
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
              ...(this.deps.allowedProfile ? { allowedProfile: this.deps.allowedProfile } : {}),
              present: (card, signal) => {
                // Who started it, looked up while the card shows (about 1 s on Windows), never inside a call.
                if (held && !held.parent) held.parent = import('./parent').then(({ ancestry }) => ancestry(hello.parentPid)).catch(() => []);
                return this.deps.present(card, signal);
              },
            });
            held = { connection, hello, parent: null };
            this.connections.add(held);
            for (const m of queued.splice(0)) connection.message(m);
          }).catch((error: unknown) => {
            // The connection's code didn't load: hang up, so the relay says Chord isn't open rather than waiting forever.
            this.deps.log?.('agents: a connection couldn’t start:', error);
            console.warn('[chord] agents: a connection couldn’t start:', error instanceof Error ? error.message : error);
            socket.destroy();
          });
          return {
            message: (m) => (held ? held.connection.message(m) : void queued.push(m)),
            closed: () => {
              gone = true;
              if (!held) return;
              held.connection.closed();
              this.connections.delete(held);
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
