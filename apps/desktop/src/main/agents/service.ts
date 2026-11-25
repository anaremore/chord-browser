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
import { AGENT_ACT_SITES_MAX, sendTitle, stepDanger, stepTitle, type AgentAllowance, type AgentHello, type Command, type Grant, type NodeId, type ProfileId, type WindowId } from '@chord/core';
import type { ControlBrowser } from '../control/tools';
import { startEndpoint, type Endpoint } from './endpoint';
import type { AgentChords, AgentChordsDeps } from './chords';
import type { AgentConnection } from './connection';
import type { ConnectAnswer, ConnectingAgent } from './connect';
import type { ProcessInfo } from './parent';
import type { SiteQuestion, StepQuestion } from './site-cards';
import type { PeerLookup } from './peer';
// The service loads with the first time Agents is on, never at launch: so does what decides a tab can be shared.
import { shareable, type AgentShares } from './shares';
import type { Socket } from 'node:net';

export interface AgentServiceDeps {
  userData: string;
  browser: ControlBrowser;
  /** The connect card (connect.ts): asks you, or lets in an agent you allowed for good. */
  ask(who: ConnectingAgent, signal: AbortSignal): Promise<ConnectAnswer>;
  /** The site card (site-cards.ts, M2c): an agent's first action on a site. Absent, every site is a no. */
  askSite?(question: SiteQuestion, signal: AbortSignal): Promise<Grant>;
  /** The risky-step card (M2d), where the site card asks. */
  askStep?(question: StepQuestion, signal: AbortSignal): Promise<Grant>;
  /** Show me: the agent's tab shown over that window's chord. */
  showTab?(windowId: WindowId, nodeId: NodeId): void;
  /** The settings' allowances, to read and keep an always-allowed agent's sites (M2c). */
  allowances?: { list(): readonly AgentAllowance[]; set(list: AgentAllowance[]): void };
  /** What Settings → Agents shows changed: an agent connected, went, stopped or continued. */
  changed?(): void;
  /** Windows: window-owner.exe, for the pipe's DACL; null where there's none. */
  helper: string | null;
  /** How the pipe is restricted (its exit code): window-owner.exe's restrict-pipe on Windows. Tests give their own. */
  restrict?(path: string): Promise<number>;
  /** How long a call waits on a card (CONTROL_WAIT_MS unless a test says). */
  waitMs?: number;
  /** How often a call that asked for progress hears it (connection.ts; tests shorten it). */
  progressMs?: number;
  log?(...args: unknown[]): void;
  /** For the agents' chords (M1c), made with the first connection; absent, agents open no tabs. */
  chords?: AgentChordsDeps;
  dispatch?(command: Command): void;
  neverSites?(): readonly string[];
  /** M2's slices (agentActions): without them, *Started by* comes from the hello's word, as in M1. */
  actions?: boolean;
  /** Who's at the other end of a connection (peer.ts); tests give their own. Null: the OS can't say. */
  peer?(socket: Socket, endpoint: string, claimed: number, held: ReadonlySet<number>): Promise<PeerLookup>;
}

/** A connection Chord holds: the agent, and who started it once looked up (for M1d's card and Settings). */
export interface HeldConnection {
  connection: AgentConnection;
  /** Its hello, without the token: nothing keeps the token but the endpoint. */
  hello: Omit<AgentHello, 'token'>;
  /** Its end of the endpoint: Remove in Settings hangs up on it. */
  socket: Socket;
  parent: Promise<ProcessInfo[]> | null;
  /** The process at its other end, as the OS says (peer.ts), once looked up; null if it couldn't say. */
  peerPid?: number | null;
  /** Its claim on its hello's bridge PID (AgentService.claims): it holds that PID only while no other live connection claims it too. */
  claim?: object;
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
  /**
   * Bridge PIDs claimed by live connections, from each one's hello on (M2a), so even an idle relay that hasn't been
   * looked up yet holds its own. A PID claimed by more than one live connection is **contested**: no connection gets it
   * by claim, those that claimed it can't tell who's calling (no fallback for them either), and every other connection
   * counts it as taken. It clears as they close. (Review 2 of #103: a process with the token could otherwise hello as a
   * new relay before the relay's own hello arrived.)
   */
  private readonly claims = new Map<number, Set<object>>();
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
          const helper = this.deps.helper;
          const restrict = this.deps.restrict ?? (process.platform === 'win32' && helper ? (p: string) => restrictPipe(helper, p) : null);
          if (restrict) this.restricted = restrictWithRetry(restrict, path, this.deps.log);
          else if (process.platform === 'win32') warn(this.deps.log, 'the agent pipe is open to this user only by its token: window-owner.exe is missing, so its access isn’t tightened');
        },
        onConnection: ({ token: _token, ...hello }, send, socket) => {
          // The connection's code loads with the first one; messages that come meanwhile wait.
          const queued: Record<string, unknown>[] = [];
          let held: HeldConnection | null = null;
          let gone = false;
          // Its claim to be that bridge process (whoStarted): contested if another live connection claims it too.
          const claim = {};
          const claimants = this.claims.get(hello.bridgePid) ?? new Set<object>();
          claimants.add(claim);
          this.claims.set(hello.bridgePid, claimants);
          // Nothing of it is handled until the pipe's restriction (Windows' DACL, started by the first connection) has
          // finished, however it ended: its messages wait meanwhile, as they do for the connection's code. A failed one
          // (logged, and tried twice) doesn't hold connections back: the token still gates every one.
          void Promise.all([import('./connection'), this.deps.chords && !this.chords ? import('./chords') : null, this.restricted?.catch(() => -1)]).then(([{ agentConnection }, chordsModule]) => {
            if (chordsModule && this.deps.chords && !this.chords) {
              this.chords = new chordsModule.AgentChords({ ...this.deps.chords, ...(this.deps.waitMs !== undefined ? { waitMs: this.deps.waitMs } : {}) });
              // A tab you took over (to a site you keep private) is closed, as far as any agent knows.
              this.chords.onHandedOver = (nodeId) => {
                for (const h of this.connections) h.connection.forget(nodeId);
              };
            }
            if (gone) return;
            const connection = agentConnection(hello, send, {
              browser: this.deps.browser,
              waitMs: this.deps.waitMs,
              ...(this.deps.progressMs ? { progressMs: this.deps.progressMs } : {}),
              actions: this.deps.actions !== false,
              log: this.deps.log,
              ...(this.chords ? { chords: this.chords } : {}),
              ...(this.deps.dispatch ? { dispatch: this.deps.dispatch } : {}),
              ...(this.deps.neverSites ? { neverSites: this.deps.neverSites } : {}),
              shares: () => this.shares,
              allowedProfile: () => held?.profileId ?? null,
              sites: {
                allowed: (site) => Boolean(held && this.allowanceOf(held)?.actSites?.includes(site)),
                keep: (site) => {
                  const allowance = held && this.allowanceOf(held);
                  if (!allowance || !this.deps.allowances) return;
                  const sites = [...(allowance.actSites ?? []).filter((s) => s !== site), site].slice(-AGENT_ACT_SITES_MAX);
                  this.deps.allowances.set(this.deps.allowances.list().map((a) => (a === allowance ? { ...a, actSites: sites } : a)));
                  this.deps.changed?.();
                },
              },
              present: async (card, signal) => {
                // The site card (M2c): Always on this site only for an agent you always allow (it has an allowance to keep it with).
                if (card.kind === 'site' && held && this.deps.askSite) {
                  return this.deps.askSite({ name: held.connection.name, site: card.subject, action: card.description, always: Boolean(this.allowanceOf(held)) }, signal);
                }
                // A risky step (M2d): every time, never remembered; Show me shows its tab and outlines the element.
                if (card.kind === 'step' && card.step && held && this.deps.askStep) {
                  const step = card.step;
                  // What an action is sending (sends.ts): its own card, its sites; red when any is another site.
                  const sends = step.sends ? { sites: step.sends, other: step.sends.some((s) => s !== step.site) } : null;
                  return this.deps.askStep(
                    {
                      name: held.connection.name,
                      title: sends ? sendTitle(sends.sites) : stepTitle(step.why, step.site),
                      action: card.description,
                      fields: step.fields,
                      more: step.more,
                      // A form or link to another site: red, as data going to another site is.
                      danger: sends ? sends.other : stepDanger(step.why) || Boolean(step.to),
                      ...(sends ? { sends } : {}),
                      ...(step.idle ? { idle: true } : {}),
                      // Allow until done: on a send card (between actions or in one), never on a risky step's.
                      ...(sends ? { untilDone: true } : {}),
                      ...(step.going ? { going: step.going } : {}),
                      ...(step.to ? { to: step.to } : {}),
                      ...(step.shows ? { shows: step.shows } : {}),
                      ...(step.typed !== undefined ? { typed: step.typed } : {}),
                      show: (windowId) => {
                        if (card.tab) this.deps.showTab?.(windowId, card.tab);
                        card.show?.();
                      },
                    },
                    signal,
                  );
                }
                if (card.kind !== 'connection' || !held) return 'deny';
                // Who started it, looked up while the card shows (about 1 s on Windows), never inside a call.
                held.parent ??= this.whoStarted(held).catch(() => []);
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
            const record: HeldConnection = { connection, hello, socket, parent: null, profileId: null, always: false, allowedParent: null, letIn: false, claim };
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
              const claimants = this.claims.get(hello.bridgePid);
              claimants?.delete(claim);
              if (claimants?.size === 0) this.claims.delete(hello.bridgePid);
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
    this.claims.clear();
    for (const held of this.connections) held.connection.closed();
    this.connections.clear();
    this.publishLetIn();
  }

  /**
   * Who started a connection's agent (M2a): the process at its other end as the OS says (peer.ts), never the
   * hello's word for it. That's `chord mcp` (Chord's own executable), and who started it is its parent; anything else
   * that holds the token and connected is the client itself. Unknown, nobody: the card names no program, and Always
   * allow isn't offered.
   */
  private async whoStarted(held: HeldConnection): Promise<ProcessInfo[]> {
    // A packaged build before AGENT_ACTIONS_RELEASED: M1's lookup, from the bridge's word.
    if (this.deps.actions === false) return import('./parent').then(({ ancestry }) => ancestry(held.hello.parentPid));
    // Its claim, contested (another live connection claims that PID too): it can't tell, before the lookup or after.
    const contested = () => (this.claims.get(held.hello.bridgePid)?.size ?? 0) > 1;
    const unknown = () => {
      held.peerPid = null;
      return [];
    };
    if (contested()) return unknown();
    // Taken by other live connections: the peers they were given, and every PID claimed by anyone but this one alone.
    const others = new Set<number>();
    for (const other of this.connections) if (other !== held && typeof other.peerPid === 'number') others.add(other.peerPid);
    for (const [pid, claimants] of this.claims) if (!(claimants.size === 1 && held.claim && claimants.has(held.claim))) others.add(pid);
    // Not its claim (-1 is never a process): only a connection that holds its claim alone claims anything.
    const claimed = held.claim && this.claims.get(held.hello.bridgePid)?.has(held.claim) ? held.hello.bridgePid : -1;
    const peer = this.deps.peer ?? (async (socket: Socket, endpoint: string, claimed: number, taken: ReadonlySet<number>) => {
      const { peerOf, peerDeps } = await import('./peer');
      return peerOf(socket, endpoint, claimed, taken, peerDeps(this.deps.helper));
    });
    const { pid, chain: given } = await peer(held.socket, this.endpoint?.path ?? '', claimed, others);
    // Contested while it looked (the real relay's hello arrived meanwhile): what it found can't be trusted.
    if (contested()) return unknown();
    held.peerPid = pid;
    if (pid === null) return [];
    const { ancestry, sameProgram } = await import('./parent');
    // Windows' helper gives the chain with the peer (one process, no PowerShell); elsewhere it's looked up now.
    const chain = given ?? (await ancestry(pid, 4));
    return chain[0] && sameProgram(chain[0].path, process.execPath) ? chain.slice(1) : chain.slice(0, 3);
  }

  /** The allowance an always-allowed connection came in by (its name and program), if it still exists. */
  private allowanceOf(held: HeldConnection): AgentAllowance | null {
    if (!held.always || !held.allowedParent) return null;
    return this.deps.allowances?.list().find((a) => a.name === held.connection.name && a.parent === held.allowedParent) ?? null;
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

  /** A site removed from an allowance in Settings (M2c): its connections ask again there from their next action, mid-task too. */
  forgetSite(name: string, parent: string, site: string): void {
    for (const held of this.connections) if (held.always && held.connection.name === name && held.allowedParent === parent) held.connection.agent.forget('site', site);
  }
}

/** The pipe's DACL, tightened by window-owner.exe (its `restrict-pipe` verb); its exit code. */
export function restrictPipe(helper: string, path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(helper, ['restrict-pipe', path], { windowsHide: true, timeout: 10_000 }, (error) => {
      if (!error) return resolve(0);
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      // Killed at the timeout: RESTRICT_TIMED_OUT (never tried again). Not started (missing, blocked): -1, with the error's reason.
      // Killed by our timer, that is: maxBuffer kills it too, with a code of its own (then it's an ordinary failure).
      if ((error as { killed?: boolean }).killed && code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(RESTRICT_TIMED_OUT);
      if (typeof code !== 'number') lastRestrictError = error.message;
      resolve(typeof code === 'number' ? code : -1);
    });
  });
}

/** Why the last restrict-pipe run had no exit code of its own (it didn't start). */
let lastRestrictError = '';

/** restrict-pipe ran out of time (10 s): not tried again, so the first connection never waits twice as long. */
export const RESTRICT_TIMED_OUT = -2;

const warn = (log: AgentServiceDeps['log'], message: string) => {
  log?.(`agents: ${message}`);
  console.warn(`[chord] ${message}`);
};

/**
 * The pipe restricted, tried once more after a quick failure (never after a timeout); every failure logged with its
 * reason. Resolves with the last outcome.
 */
export async function restrictWithRetry(restrict: (path: string) => Promise<number>, path: string, log?: AgentServiceDeps['log']): Promise<number> {
  let code = -1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    lastRestrictError = '';
    code = await restrict(path).catch((error: unknown) => ((lastRestrictError = error instanceof Error ? error.message : String(error)), -1));
    if (code === 0) return 0;
    const last = attempt === 2 || code === RESTRICT_TIMED_OUT;
    const why = code === RESTRICT_TIMED_OUT ? 'it timed out' : code === -1 ? lastRestrictError || 'it didn’t run' : `window-owner exited ${code}`;
    warn(log, `couldn’t tighten the agent pipe’s access (try ${attempt} of 2: ${why})${last ? '; the token still gates every connection' : ''}`);
    if (last) break;
  }
  return code;
}
