/**
 * The assistant acting in a tab of yours (S18 M2e-2a; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from right before an action's input until a moment after the last one (TAIL_MS), or
 * until something it sent is answered. Then everything is let go of, and the tab is as it always was.
 *
 * - **One owner** (a chat's gate id): another chat acting in the tab meanwhile is refused (E8), and its own next action
 *   joins the lease (Neon's B3 on #147), checked again inside the debugger queue.
 * - **Never held across its steps:** the lease takes the debugger queue (debugger-queue.ts) only to turn things on and
 *   off, so the action's own checks (deep.ts), page_diagnostics and screenshots run as ever (Neon's B3 on the plan).
 *   Every command it sends is bounded (COMMAND_MS) and fails closed, so a page that stops answering (`window.print`)
 *   can't hold the queue.
 * - **Lost, closed:** the debugger let go (DevTools, a detach) or the page's renderer gone: the lease is lost, what was
 *   held fails, and the action hears it (`userLeaseLost`: page.lost(), deep.held()); never rejoined (Neon's B1).
 * - **Let go of in order:** from the moment it ends, what the tab sends is yours (it goes), what was held for the
 *   assistant fails, and only then is the hold's listener taken off, once Fetch is off (Neon's B4).
 * - **Your hands:** your own input in the tab (assistant/service.ts) ends it at once.
 */
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { failHeld, holdSends, holding, sendHoldDeps, unholdSends, type SendHoldDeps } from './sends';

/** How long after the assistant's last action in the tab what the page sends is still asked about. */
export const TAIL_MS = 1500;
/** How long a lease waits on a card about what's held before it ends anyway (what's held then fails). */
const CARD_WAIT_MS = 45_000;
/** Each command's limit: a page that stops answering never holds the debugger queue. */
const COMMAND_MS = 3000;
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];
/** Auto-attach to frames in other processes (and theirs), held at their start until their requests are held too. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] };

/** Whether a lease could be had: on (or joined), another chat's (E8), or not (the debugger can't be had, Fetch failed). */
export type UserLeaseBegin = 'on' | 'busy' | 'no';

interface Lease {
  /** Whose: the chat's gate id. */
  owner: string;
  /** Chord attached the debugger for this lease (else someone else's attachment, used as it is: never detached). */
  mine: boolean;
  actions: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Frames in other processes, auto-attached while the lease is on: their sessions, to turn Fetch off in. */
  sessions: Set<string>;
  /** Frames attaching now: their requests held before the action's input goes (Claude's S3 on #147). */
  pending: Set<Promise<void>>;
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
  onDetach: () => void;
  onGone: () => void;
}

const leases = new WeakMap<WebContents, Lease>();
/** Tabs whose lease was lost (the debugger let go, the renderer gone): an action there checks this before any input. */
const lost = new WeakSet<WebContents>();

/** Whether the assistant is acting in this tab of yours now (the vault keeps its menu shut meanwhile). */
export function userTabActing(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended);
}

/** Whether the tab's lease was lost since it began (Neon's B1 on #147): nothing more is pressed or typed there. */
export function userLeaseLost(contents: object): boolean {
  return lost.has(contents as WebContents);
}

/** A lease beginning, for anything that must close itself for it (the vault's menu: Neon's B7 on #147). */
const beginning = new Set<(contents: WebContents) => void>();
export function onUserLease(listener: (contents: WebContents) => void): () => void {
  beginning.add(listener);
  return () => void beginning.delete(listener);
}

/** A command within COMMAND_MS, or a rejection (fail closed). */
function command(debug: Electron.Debugger, method: string, params: object = {}, sessionId?: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} took too long`)), COMMAND_MS);
    timer.unref?.();
  });
  return Promise.race([debug.sendCommand(method, params, sessionId), limit]).finally(() => clearTimeout(timer));
}

/**
 * The lease on, for one action of `owner`'s (or joined, if it's that owner's). `busy`: another chat's (E8). `no`: the
 * tab's debugger can't be had (someone's DevTools), or Fetch can't be turned on: nothing is pressed or typed then.
 */
export async function beginUserAction(contents: WebContents, owner: string, deps: Omit<SendHoldDeps, 'whose'>): Promise<UserLeaseBegin> {
  if (contents.isDestroyed()) return 'no';
  const join = (lease: Lease): UserLeaseBegin => {
    if (lease.owner !== owner) return 'busy';
    // A lease whose debugger or hold is gone isn't joined: it's lost (Neon's B1).
    if (!contents.debugger.isAttached()) {
      lose(contents, lease);
      return 'no';
    }
    lease.actions++;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    return 'on';
  };
  const was = leases.get(contents);
  if (was && !was.ended) return join(was);
  return withDebugger(contents, async (): Promise<UserLeaseBegin> => {
    if (contents.isDestroyed()) return 'no';
    // Asked again in the queue: another begin may have got there first (Neon's B3 on #147).
    const again = leases.get(contents);
    if (again && !again.ended) return join(again);
    const debug = contents.debugger;
    const mine = !debug.isAttached();
    try {
      if (mine) debug.attach('1.3');
    } catch {
      return 'no';
    }
    const lease: Lease = { owner, mine, actions: 1, ended: false, timer: null, sessions: new Set(), pending: new Set(), onMessage: () => undefined, onDetach: () => undefined, onGone: () => undefined };
    lease.onMessage = (_event, method, params) => {
      const p = params as { sessionId?: string; waitingForDebugger?: boolean };
      if (method === 'Target.detachedFromTarget' && p.sessionId) return void lease.sessions.delete(p.sessionId);
      if (method !== 'Target.attachedToTarget' || !p.sessionId) return;
      const frame = p.sessionId;
      if (lease.ended) return;
      lease.sessions.add(frame);
      // A frame in another process: its requests held (and its own frames attached) before it runs; one that can't
      // be held stays paused at its start (a blank frame), never running unheld (fail closed: Claude's S3).
      const ready = (async () => {
        try {
          await command(debug, 'Fetch.enable', { patterns: PATTERNS }, frame);
          await command(debug, 'Target.setAutoAttach', AUTO_ATTACH, frame);
        } catch {
          return;
        }
        if (p.waitingForDebugger && !lease.ended) await command(debug, 'Runtime.runIfWaitingForDebugger', {}, frame).catch(() => undefined);
      })();
      lease.pending.add(ready);
      void ready.finally(() => lease.pending.delete(ready));
    };
    // The debugger let go (DevTools took it, a detach) or the page's renderer went: lost, never failing open.
    lease.onDetach = () => lose(contents, lease);
    lease.onGone = () => lose(contents, lease);
    debug.on('message', lease.onMessage);
    debug.on('detach', lease.onDetach);
    contents.on('render-process-gone', lease.onGone);
    const unwire = () => {
      debug.off('message', lease.onMessage);
      debug.off('detach', lease.onDetach);
      contents.off('render-process-gone', lease.onGone);
    };
    try {
      await command(debug, 'Fetch.enable', { patterns: PATTERNS });
      await command(debug, 'Target.setAutoAttach', AUTO_ATTACH);
      // Frames already there: attached as setAutoAttach answers; their requests held before any input.
      await Promise.all([...lease.pending]);
    } catch {
      unwire();
      if (mine && debug.isAttached()) debug.detach();
      return 'no';
    }
    lost.delete(contents);
    leases.set(contents, lease);
    holdSends(contents);
    // While the lease is on, what the tab sends is the assistant's: held and asked about. Once it ends, yours.
    sendHoldDeps(contents, { ...deps, whose: () => (lease.ended ? 'user' : 'agent') });
    for (const listener of beginning) listener(contents);
    return 'on';
  });
}

/** The action's done: the lease ends TAIL_MS after the last one, once nothing's held (or CARD_WAIT_MS on). */
export function endUserAction(contents: WebContents): void {
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  lease.actions = Math.max(0, lease.actions - 1);
  if (lease.actions > 0) return;
  const started = Date.now();
  const later = () => {
    lease.timer = null;
    if (lease.ended || lease.actions > 0) return;
    if (holding(contents) && Date.now() - started < CARD_WAIT_MS) {
      lease.timer = setTimeout(later, 250);
      lease.timer.unref?.();
      return;
    }
    void release(contents, lease);
  };
  lease.timer = setTimeout(later, TAIL_MS);
  lease.timer.unref?.();
}

/**
 * The lease ends now: you used the tab (your key or click), Stop, or the chat's acting ended. What's held for the
 * assistant fails (its card comes down); nothing of yours is held from here.
 */
export function endUserLease(contents: WebContents): void {
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  void release(contents, lease);
}

/** Lost (the debugger let go, the renderer gone): what was held fails at once, and the action hears it. */
function lose(contents: WebContents, lease: Lease): void {
  if (lease.ended) return;
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lost.add(contents);
  if (leases.get(contents) === lease) leases.delete(contents);
  debugOff(contents, lease);
  unholdSends(contents);
}

function debugOff(contents: WebContents, lease: Lease): void {
  contents.debugger.off('message', lease.onMessage);
  contents.debugger.off('detach', lease.onDetach);
  contents.off('render-process-gone', lease.onGone);
}

async function release(contents: WebContents, lease: Lease): Promise<void> {
  if (lease.ended) return;
  // Ended first: from here what the tab sends is yours (whose() says 'user'), and what was held for the assistant
  // fails now. The hold keeps answering until Fetch is off, so nothing of yours waits (Neon's B4 on #147).
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  if (contents.isDestroyed()) return;
  await withDebugger(contents, async () => {
    const debug = contents.debugger;
    // Taken off only now: a detach from here on is this release's own.
    debug.off('detach', lease.onDetach);
    contents.off('render-process-gone', lease.onGone);
    if (contents.isDestroyed() || !debug.isAttached()) return;
    if (lease.mine) return void debug.detach();
    // Someone else's attachment: everything this lease turned on goes off again, left as it was.
    await command(debug, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
    for (const sessionId of lease.sessions) await command(debug, 'Fetch.disable', {}, sessionId).catch(() => undefined);
    await command(debug, 'Fetch.disable').catch(() => undefined);
  });
  contents.debugger.off('message', lease.onMessage);
  unholdSends(contents);
}
