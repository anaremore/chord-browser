/**
 * The assistant acting in a tab of yours (S18 M2e-2a; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from right before an action's input until a moment after the last one (TAIL_MS), or
 * until something it sent is answered. Then everything is let go of, and the tab is as it always was.
 *
 * - **One owner** (a chat's gate id): another chat acting in the tab meanwhile is refused (E8), and its own next action
 *   joins the lease (Neon's B3 on #147), checked again inside the debugger queue. A chat ending lets go of its own
 *   lease only (`endUserLease(contents, owner)`); your hands end anyone's (Claude's B1, round 2).
 * - **Never held across its steps:** the lease takes the debugger queue (debugger-queue.ts) only to turn things on and
 *   off, so the action's own checks (deep.ts), page_diagnostics and screenshots run as ever (Neon's B3 on the plan).
 *   Every command it sends is bounded (COMMAND_MS) and fails closed, so a page that stops answering (`window.print`)
 *   can't hold the queue.
 * - **Held from the first request:** the send hold is listening before Fetch is on (as agents/pickers.ts), and a
 *   lease whose debugger went, or that was ended, while it was being set up is never handed out (Neon's B1 and B2,
 *   round 2).
 * - **Lost, closed:** the debugger let go (DevTools, a detach) or the page's renderer gone: the lease is lost, what was
 *   held fails, and the action hears it (`userLeaseLost`: page.lost(), deep.held()); never rejoined (Neon's B1). A
 *   lease ended while an action is under way counts as lost for that action too.
 * - **Let go of in order:** from the moment it ends, what the tab sends is yours (it goes), what was held for the
 *   assistant fails, and only then is the hold's listener taken off, once Fetch is off (Neon's B4).
 */
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { failHeld, holdSends, holding, sendHoldDeps, unholdSends, type SendHoldDeps } from './sends';

/** How long after the assistant's last action in the tab what the page sends is still asked about. */
export const TAIL_MS = 1500;
/** How long a lease waits on a card about what's held before it ends anyway (what's held then fails). */
const CARD_WAIT_MS = 45_000;
/** Each command's limit: a page that stops answering never holds the debugger queue. */
export const COMMAND_MS = 3000;
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];
/** Auto-attach to frames in other processes (and theirs), held at their start until their requests are held too. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] };

/** Whether a lease could be had: on (or joined), another chat's (E8), or not (the debugger can't be had, Fetch failed). */
export type UserLeaseBegin = 'on' | 'busy' | 'no';

/**
 * One action's hold on the lease: `end` once it's done (its tail starts after the last one). It belongs to the lease it
 * began on: once that lease is gone, or ended once already, it does nothing (Neon's B3, round 3 of #147).
 */
export interface UserAction {
  begun: UserLeaseBegin;
  end(): void;
}

const NOT_ON = (begun: Exclude<UserLeaseBegin, 'on'>): UserAction => ({ begun, end: () => undefined });

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
  /** A frame that was there as the lease began couldn't be held: the lease isn't handed out (fail closed). */
  frameFailed: boolean;
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
  onDetach: () => void;
  onGone: () => void;
}

const leases = new WeakMap<WebContents, Lease>();
/** Tabs whose lease was lost (the debugger let go, the renderer gone): an action there checks this before any input. */
const lost = new WeakSet<WebContents>();
/** Begins under way (queued, or setting up), per tab: an end meanwhile cancels its owner's (or, from your hands, all). */
const starting = new WeakMap<WebContents, Set<{ owner: string; cancelled: boolean }>>();

/** Whether the assistant is acting in this tab of yours now (the vault keeps its menu shut meanwhile). */
export function userTabActing(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended);
}

/** Whose lease is on in this tab now (a chat's gate id), or null. */
export function userLeaseOwner(contents: object): string | null {
  const lease = leases.get(contents as WebContents);
  return lease && !lease.ended ? lease.owner : null;
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

/** A lease ended, however (its tail, your hands, Stop, lost): its owner forgets the tab (Claude's B1, round 2). */
const ending = new Set<(contents: WebContents, owner: string) => void>();
export function onUserLeaseEnd(listener: (contents: WebContents, owner: string) => void): () => void {
  ending.add(listener);
  return () => void ending.delete(listener);
}

/** A command within COMMAND_MS, or a rejection (fail closed). */
export function command(debug: Electron.Debugger, method: string, params: object = {}, sessionId?: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} took too long`)), COMMAND_MS);
    timer.unref?.();
  });
  return Promise.race([debug.sendCommand(method, params, sessionId), limit]).finally(() => clearTimeout(timer));
}

/**
 * The lease on, for one action of `owner`'s (or joined, if it's that owner's). `busy`: another chat's (E8). `no`: the
 * tab's debugger can't be had (someone's DevTools), Fetch can't be turned on, a frame can't be held, the debugger went
 * meanwhile, or the lease was ended meanwhile: nothing is pressed or typed then.
 */
export async function beginUserAction(contents: WebContents, owner: string, deps: Omit<SendHoldDeps, 'whose'>): Promise<UserAction> {
  if (contents.isDestroyed()) return NOT_ON('no');
  const join = (lease: Lease): UserAction => {
    if (lease.owner !== owner) return NOT_ON('busy');
    // A lease whose debugger or hold is gone isn't joined: it's lost (Neon's B1).
    if (!contents.debugger.isAttached()) {
      lose(contents, lease);
      return NOT_ON('no');
    }
    lease.actions++;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    return { begun: 'on', end: actionEnd(contents, lease) };
  };
  const was = leases.get(contents);
  if (was && !was.ended) return join(was);
  const me = { owner, cancelled: false };
  let mine = starting.get(contents);
  if (!mine) starting.set(contents, (mine = new Set()));
  mine.add(me);
  try {
    return await withDebugger(contents, () => setUp(contents, owner, deps, me, join));
  } finally {
    mine.delete(me);
  }
}

async function setUp(contents: WebContents, owner: string, deps: Omit<SendHoldDeps, 'whose'>, me: { cancelled: boolean }, join: (lease: Lease) => UserAction): Promise<UserAction> {
  if (contents.isDestroyed() || me.cancelled) return NOT_ON('no');
  // Asked again in the queue: another begin may have got there first (Neon's B3 on #147).
  const again = leases.get(contents);
  if (again && !again.ended) return join(again);
  const debug = contents.debugger;
  const mine = !debug.isAttached();
  try {
    if (mine) debug.attach('1.3');
  } catch {
    return NOT_ON('no');
  }
  const lease: Lease = { owner, mine, actions: 1, ended: false, timer: null, sessions: new Set(), pending: new Set(), frameFailed: false, onMessage: () => undefined, onDetach: () => undefined, onGone: () => undefined };
  let handedOut = false;
  lease.onMessage = (_event, method, params) => {
    const p = params as { sessionId?: string; waitingForDebugger?: boolean };
    if (method === 'Target.detachedFromTarget' && p.sessionId) return void lease.sessions.delete(p.sessionId);
    if (method !== 'Target.attachedToTarget' || !p.sessionId) return;
    const frame = p.sessionId;
    if (lease.ended) return;
    lease.sessions.add(frame);
    // A frame in another process: its requests held (and its own frames attached) before it runs; one that can't
    // be held stays paused at its start (a blank frame), never running unheld (fail closed: Claude's S3). One there
    // as the lease begins that can't be held: no lease (Neon's S3, round 2).
    const ready = (async () => {
      try {
        await command(debug, 'Fetch.enable', { patterns: PATTERNS }, frame);
        await command(debug, 'Target.setAutoAttach', AUTO_ATTACH, frame);
      } catch {
        if (!handedOut) lease.frameFailed = true;
        return;
      }
      if (p.waitingForDebugger && !lease.ended) await command(debug, 'Runtime.runIfWaitingForDebugger', {}, frame).catch(() => undefined);
    })();
    lease.pending.add(ready);
    void ready.finally(() => lease.pending.delete(ready));
  };
  // The debugger let go (DevTools took it, a detach) or the page's renderer went: lost, never failing open. While it's
  // still being set up, only ended: the set-up gives up and cleans up itself (Neon's B4, round 3 of #147).
  lease.onDetach = () => (handedOut ? lose(contents, lease) : void (lease.ended = true));
  lease.onGone = lease.onDetach;
  debug.on('detach', lease.onDetach);
  contents.on('render-process-gone', lease.onGone);
  // The hold listens before Fetch is on: nothing paused in between is left without an answer (Neon's B1, round 2).
  // Until it's handed out, what the page sends is its own (the action's input hasn't gone): it goes.
  holdSends(contents);
  sendHoldDeps(contents, { ...deps, whose: () => (lease.ended || !handedOut ? 'user' : 'agent') });
  debug.on('message', lease.onMessage);
  const giveUp = async (): Promise<UserAction> => {
    lease.ended = true;
    debugOff(contents, lease);
    await turnOff(contents, lease);
    unholdSends(contents);
    return NOT_ON('no');
  };
  try {
    await command(debug, 'Fetch.enable', { patterns: PATTERNS });
    await command(debug, 'Target.setAutoAttach', AUTO_ATTACH);
    // Frames already there: attached as setAutoAttach answers (and theirs, as they come); held before any input.
    while (lease.pending.size) await Promise.all([...lease.pending]);
  } catch {
    return giveUp();
  }
  // Gone or ended while it was set up: never handed out with nothing on (Neon's B1 and B2, round 2).
  if (lease.ended || lease.frameFailed || me.cancelled || contents.isDestroyed() || !debug.isAttached()) return giveUp();
  handedOut = true;
  lost.delete(contents);
  leases.set(contents, lease);
  for (const listener of beginning) listener(contents);
  return { begun: 'on', end: actionEnd(contents, lease) };
}

/** One action's end, for the lease it began on only, once (Neon's B3, round 3 of #147). */
function actionEnd(contents: WebContents, lease: Lease): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (leases.get(contents) !== lease || lease.ended) return;
    endAction(contents, lease);
  };
}

/** The action's done: the lease ends TAIL_MS after the last one, once nothing's held (or CARD_WAIT_MS on). */
function endAction(contents: WebContents, lease: Lease): void {
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
 * The lease ends now. With an `owner` (that chat's acting ended: Stop, a new chat, the chord off): only that chat's
 * lease, and its begins under way; another chat's is left alone. Without (your key, click or page move: F1): whoever's
 * it is. What's held for the assistant fails (its card comes down); nothing of yours is held from here.
 */
export function endUserLease(contents: WebContents, owner?: string): void {
  for (const begin of starting.get(contents) ?? []) if (owner === undefined || begin.owner === owner) begin.cancelled = true;
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  if (owner !== undefined && lease.owner !== owner) return;
  void release(contents, lease);
}

/** Lost (the debugger let go, the renderer gone): what was held fails at once, and the action hears it. */
function lose(contents: WebContents, lease: Lease): void {
  if (lease.ended) return;
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  lost.add(contents);
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  ended(contents, lease);
  if (contents.isDestroyed()) return void debugOff(contents, lease);
  // The renderer gone with the debugger still on: Fetch off (Chord's attachment let go of), or the reloaded tab's
  // requests would wait on a hold no one answers (Claude's S1, round 2). The listener stays until then.
  void withDebugger(contents, async () => {
    if (superseded(contents, lease)) return debugOff(contents, lease);
    try {
      if (!contents.isDestroyed()) contents.debugger.off('detach', lease.onDetach);
      await turnOff(contents, lease);
    } finally {
      debugOff(contents, lease);
      unholdSends(contents);
    }
  });
}

function debugOff(contents: WebContents, lease: Lease): void {
  contents.off('render-process-gone', lease.onGone);
  if (contents.isDestroyed()) return;
  contents.debugger.off('message', lease.onMessage);
  contents.debugger.off('detach', lease.onDetach);
}

function ended(contents: WebContents, lease: Lease): void {
  for (const listener of ending) listener(contents, lease.owner);
}

/**
 * A lease's cleanup that runs once the next lease is already on (it was set up in the queue first): the next one is
 * left alone, and takes over Chord's attachment, to let go of when it ends (Neon's B4, round 3 of #147).
 */
function superseded(contents: WebContents, lease: Lease): boolean {
  const now = leases.get(contents);
  if (!now || now === lease || now.ended) return false;
  now.mine ||= lease.mine;
  return true;
}

/** Everything the lease turned on, off: Chord's own attachment detached, someone else's left as it was. */
async function turnOff(contents: WebContents, lease: Lease): Promise<void> {
  if (contents.isDestroyed()) return;
  const debug = contents.debugger;
  if (!debug.isAttached()) return;
  if (lease.mine) return void debug.detach();
  await command(debug, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
  for (const sessionId of lease.sessions) await command(debug, 'Fetch.disable', {}, sessionId).catch(() => undefined);
  await command(debug, 'Fetch.disable').catch(() => undefined);
}

async function release(contents: WebContents, lease: Lease): Promise<void> {
  if (lease.ended) return;
  // Ended first: from here what the tab sends is yours (whose() says 'user'), and what was held for the assistant
  // fails now. The hold keeps answering until Fetch is off, so nothing of yours waits (Neon's B4 on #147).
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  // An action still under way there (your hands mid-action) hears it as lost: deep.held() goes false (Claude's B1).
  if (lease.actions > 0) lost.add(contents);
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  ended(contents, lease);
  if (contents.isDestroyed()) return void debugOff(contents, lease);
  await withDebugger(contents, async () => {
    if (superseded(contents, lease)) return debugOff(contents, lease);
    try {
      // Taken off only now: a detach from here on is this release's own.
      if (!contents.isDestroyed()) contents.debugger.off('detach', lease.onDetach);
      contents.off('render-process-gone', lease.onGone);
      await turnOff(contents, lease);
    } finally {
      debugOff(contents, lease);
      unholdSends(contents);
    }
  });
}
