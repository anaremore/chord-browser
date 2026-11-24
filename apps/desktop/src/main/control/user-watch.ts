/**
 * The assistant acting in a tab of yours (S18 M2e-2a; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from just before an action until a moment after the last one (TAIL_MS), or until
 * something it sent is answered. Then everything is let go of, and the tab is as it always was.
 *
 * The lease never holds the debugger queue (debugger-queue.ts) between its own two steps (on, off), so the action's
 * own checks (deep.ts), page_diagnostics and screenshots run as ever (Neon's B3). A second action joins the lease.
 * Your own input in the tab (assistant/service.ts) ends it at once: what was held for the assistant fails, and nothing
 * of yours is ever held.
 */
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { failHeld, holdSends, holding, sendHoldDeps, unholdSends, type SendHoldDeps } from './sends';

/** How long after the assistant's last action in the tab what the page sends is still asked about. */
export const TAIL_MS = 1500;
/** How long a lease waits on a card about what's held before it ends anyway (what's held then fails). */
const CARD_WAIT_MS = 45_000;
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];

interface Lease {
  /** Chord attached the debugger for this lease (else someone else's attachment, used as it is: never detached). */
  mine: boolean;
  actions: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Frames in other processes, auto-attached while the lease is on: their sessions, to turn Fetch off in. */
  sessions: Set<string>;
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
  since: number;
}

const leases = new WeakMap<WebContents, Lease>();

/** Whether the assistant is acting in this tab of yours now (the vault keeps its menu shut meanwhile). */
export function userTabActing(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended);
}

/**
 * The lease on, for one action (or joined, if one is on). False if the tab's debugger can't be had (someone's DevTools)
 * or Fetch can't be turned on: nothing is pressed or typed then.
 */
export async function beginUserAction(contents: WebContents, deps: Omit<SendHoldDeps, 'whose'>): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const was = leases.get(contents);
  if (was && !was.ended) {
    was.actions++;
    if (was.timer) clearTimeout(was.timer);
    was.timer = null;
    return true;
  }
  return withDebugger(contents, async () => {
    if (contents.isDestroyed()) return false;
    const debug = contents.debugger;
    const mine = !debug.isAttached();
    try {
      if (mine) debug.attach('1.3');
    } catch {
      return false;
    }
    const lease: Lease = { mine, actions: 1, ended: false, timer: null, sessions: new Set(), since: Date.now(), onMessage: () => undefined };
    // A frame in another process, as it comes: its requests held too, before it runs.
    lease.onMessage = (_event, method, params) => {
      if (method !== 'Target.attachedToTarget') return;
      const { sessionId, waitingForDebugger } = params as { sessionId?: string; waitingForDebugger?: boolean };
      if (!sessionId) return;
      lease.sessions.add(sessionId);
      void debug
        .sendCommand('Fetch.enable', { patterns: PATTERNS }, sessionId)
        .catch(() => undefined)
        .finally(() => (waitingForDebugger ? debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined) : undefined));
    };
    debug.on('message', lease.onMessage);
    try {
      await debug.sendCommand('Fetch.enable', { patterns: PATTERNS });
      await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] });
    } catch {
      debug.off('message', lease.onMessage);
      if (mine && debug.isAttached()) debug.detach();
      return false;
    }
    leases.set(contents, lease);
    holdSends(contents);
    // While the lease is on, what the tab sends is the assistant's: held and asked about. Once you take it, yours.
    sendHoldDeps(contents, { ...deps, whose: () => (lease.ended ? 'user' : 'agent') });
    return true;
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
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  failHeld(contents);
  void release(contents, lease);
}

async function release(contents: WebContents, lease: Lease): Promise<void> {
  if (lease.ended) return;
  lease.ended = true;
  if (leases.get(contents) === lease) leases.delete(contents);
  if (contents.isDestroyed()) return;
  // What's still held fails; the page's requests go as they always did from here.
  unholdSends(contents);
  await withDebugger(contents, async () => {
    const debug = contents.debugger;
    debug.off('message', lease.onMessage);
    if (contents.isDestroyed() || !debug.isAttached()) return;
    if (lease.mine) return void debug.detach();
    // Someone else's attachment: everything this lease turned on goes off again, left as it was.
    await debug.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
    for (const sessionId of lease.sessions) await debug.sendCommand('Fetch.disable', {}, sessionId).catch(() => undefined);
    await debug.sendCommand('Fetch.disable', {}).catch(() => undefined);
  });
}
