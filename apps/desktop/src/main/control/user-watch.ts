/**
 * The assistant acting in a tab of yours (S18 M2e-2; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from right before an action's input until a moment after the last one. Then
 * everything is let go of, and the tab is as it always was.
 *
 * - **What the page sends** is held and asked about during an action and TAIL_MS after it (M2e-2a, C1), or until
 *   something it sent is answered.
 * - **What its click sets off** (M2e-2b, A6) is caught for AFTER_MS after the last action, the activation's life and a
 *   margin: file pickers intercepted, passkeys refused before any prompt (`WebAuthn.enable` with no authenticator: the
 *   M2e-2 spike), FedCM's chooser dismissed, the site's service worker bypassed (its other tabs keep theirs: C3, always
 *   restored), dialogs noted, and (elsewhere, asking `userTabCatching`) popups, downloads and the clipboard.
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
/** How long after its last action what its click set off is caught: Chromium's 5 s activation, and a margin (Neon's S3). */
export const AFTER_MS = 6000;
/** How long a lease waits on a card about what's held before it ends anyway (what's held then fails). */
const CARD_WAIT_MS = 45_000;
/** Each command's limit: a page that stops answering never holds the debugger queue. */
const COMMAND_MS = 3000;
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];
/** Auto-attach to frames in other processes (and theirs), held at their start until their requests are held too. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] };

/** What the lease caught, for the chat (a muted row each). */
export type UserTabNote = 'file' | 'dialog' | 'signin' | 'popup' | 'download' | 'clipboard' | 'unload' | 'away';

export interface UserTabDeps extends Omit<SendHoldDeps, 'whose'> {
  /** Something the assistant's action set off was caught (said in the chat). */
  note(what: UserTabNote, detail: string): void;
  /** A download its click started: the chat's card (*Save invoice.pdf from shop.example?*). */
  askDownload(filename: string, signal: AbortSignal): Promise<boolean>;
  /** The clipboard's text (Electron's), to put back what the page changed in the window. */
  clipboard?: { read(): Promise<string> | string; write(text: string): void };
}

/** Whether a lease could be had: on (or joined), another chat's (E8), or not (the debugger can't be had, Fetch failed). */
export type UserLeaseBegin = 'on' | 'busy' | 'no';

interface Lease {
  /** Whose: the chat's gate id. */
  owner: string;
  deps: UserTabDeps;
  /** Until when what the page sends is the assistant's (held): its last action's end and TAIL_MS. */
  sendsUntil: number;
  /** The clipboard's text as the lease began. */
  clipboard: string | null;
  /** Its downloads' cards, to take down when it ends. */
  cancel: AbortController;
  /** Chord attached the debugger for this lease (else someone else's attachment, used as it is: never detached). */
  mine: boolean;
  actions: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Frames in other processes, auto-attached while the lease is on: their sessions, to turn things off in. */
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
  return Boolean(lease && !lease.ended && (lease.actions > 0 || Date.now() < lease.sendsUntil));
}

/** Whether what this tab's page does now was set off by the assistant: an action, or its AFTER_MS after (A6). */
export function userTabCatching(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended);
}

/** Something caught outside the lease (a popup, the clipboard: tabs.ts, permissions.ts), said in the chat. */
export function noteUserTab(contents: object, what: UserTabNote, detail: string): void {
  const lease = leases.get(contents as WebContents);
  if (lease && !lease.ended) lease.deps.note(what, detail);
}

/** A download the page started in the window: asked in the chat first (null when no lease: it isn't the assistant's). */
export function askUserTabDownload(contents: object, filename: string): Promise<boolean> | null {
  const lease = leases.get(contents as WebContents);
  if (!lease || lease.ended) return null;
  return lease.deps.askDownload(filename, lease.cancel.signal).catch(() => false);
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
export async function beginUserAction(contents: WebContents, owner: string, deps: UserTabDeps): Promise<UserLeaseBegin> {
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
    const lease: Lease = {
      owner,
      deps,
      sendsUntil: 0,
      clipboard: await readClipboard(deps),
      cancel: new AbortController(),
      mine,
      actions: 1,
      ended: false,
      timer: null,
      sessions: new Set(),
      pending: new Set(),
      onMessage: () => undefined,
      onDetach: () => undefined,
      onGone: () => undefined,
    };
    /** What the action's click sets off, in the page or a frame: caught for the chat (each command bounded). */
    const quiet = (method: string, params: object = {}, sessionId?: string) => command(debug, method, params, sessionId).catch(() => undefined);
    const catching = (sessionId?: string) =>
      Promise.all([
        quiet('Page.enable', {}, sessionId),
        quiet('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId),
        quiet('WebAuthn.enable', { enableUI: false }, sessionId),
        quiet('FedCm.enable', { disableRejectionDelay: true }, sessionId),
        quiet('Network.enable', {}, sessionId).then(() => quiet('Network.setBypassServiceWorker', { bypass: true }, sessionId)),
      ]);
    lease.onMessage = (_event, method, params, sessionId) => {
      const p = params as { sessionId?: string; waitingForDebugger?: boolean; message?: string; type?: string; dialogId?: string };
      if (lease.ended) return;
      if (method === 'Page.fileChooserOpened') return deps.note('file', 'a file picker');
      if (method === 'Page.javascriptDialogOpening') return deps.note('dialog', `${p.type ?? 'alert'}: “${String(p.message ?? '').slice(0, 120)}”`);
      if (method === 'FedCm.dialogShown') {
        void quiet('FedCm.dismissDialog', { dialogId: p.dialogId }, sessionId);
        return deps.note('signin', 'a sign-in with another site');
      }
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
        // What the frame's page sets off, caught too, before it runs.
        await catching(frame);
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
      await catching();
    } catch {
      unwire();
      if (mine && debug.isAttached()) debug.detach();
      return 'no';
    }
    lost.delete(contents);
    leases.set(contents, lease);
    // A page with unsaved changes stays put: the action hears it (its move didn't happen).
    contents.on('will-prevent-unload', onUnload);
    holdSends(contents);
    // During an action and TAIL_MS after it, what the tab sends is the assistant's: held and asked about. Then, or once
    // the lease ends (your hands, Stop), yours.
    sendHoldDeps(contents, { ...deps, whose: () => (!lease.ended && (lease.actions > 0 || Date.now() < lease.sendsUntil) ? 'agent' : 'user') });
    for (const listener of beginning) listener(contents);
    return 'on';
  });
}

function onUnload(this: WebContents): void {
  noteUserTab(this, 'unload', 'the page has unsaved changes, so it stayed');
}

async function readClipboard(deps: UserTabDeps): Promise<string | null> {
  try {
    return (await deps.clipboard?.read()) ?? null;
  } catch {
    return null;
  }
}

/** The action's done: the lease ends AFTER_MS after the last one, once nothing's held (or CARD_WAIT_MS on). */
export function endUserAction(contents: WebContents): void {
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  lease.actions = Math.max(0, lease.actions - 1);
  if (lease.actions > 0) return;
  const started = Date.now();
  lease.sendsUntil = started + TAIL_MS;
  const later = () => {
    lease.timer = null;
    if (lease.ended || lease.actions > 0) return;
    if (holding(contents) && Date.now() - started < CARD_WAIT_MS) {
      lease.timer = setTimeout(later, 250);
      lease.timer.unref?.();
      return;
    }
    void release(contents, lease, true);
  };
  lease.timer = setTimeout(later, AFTER_MS);
  lease.timer.unref?.();
}

/**
 * The lease ends now: you used the tab (your key or click), Stop, or the chat's acting ended. What's held for the
 * assistant fails (its card comes down); nothing of yours is held from here.
 */
export function endUserLease(contents: WebContents): void {
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  void release(contents, lease, false);
}

/** Lost (the debugger let go, the renderer gone): what was held fails at once, and the action hears it. */
function lose(contents: WebContents, lease: Lease): void {
  if (lease.ended) return;
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.cancel.abort();
  lost.add(contents);
  if (leases.get(contents) === lease) leases.delete(contents);
  debugOff(contents, lease);
  unholdSends(contents);
  if (contents.isDestroyed()) return;
  contents.off('will-prevent-unload', onUnload);
  // The renderer gone with Chord's debugger still on: everything turned on goes off (the service worker back first).
  if (contents.debugger.isAttached()) void withDebugger(contents, () => turnOff(contents, lease));
}

function debugOff(contents: WebContents, lease: Lease): void {
  contents.debugger.off('message', lease.onMessage);
  contents.debugger.off('detach', lease.onDetach);
  contents.off('render-process-gone', lease.onGone);
}

async function release(contents: WebContents, lease: Lease, byTime: boolean): Promise<void> {
  if (lease.ended) return;
  // Ended first: from here what the tab sends is yours (whose() says 'user'), and what was held for the assistant
  // fails now. The hold keeps answering until Fetch is off, so nothing of yours waits (Neon's B4 on #147).
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  lease.cancel.abort();
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  // The page changed the clipboard in the window (execCommand('copy') on the click's activation isn't a permission):
  // put back. Only when it ended by time: your own input ends it first, and what you copy then is yours.
  if (byTime && lease.clipboard !== null) {
    const now = await readClipboard(lease.deps);
    if (now !== null && now !== lease.clipboard) {
      lease.deps.clipboard?.write(lease.clipboard);
      lease.deps.note('clipboard', 'the clipboard, put back');
    }
  }
  if (contents.isDestroyed()) return;
  contents.off('will-prevent-unload', onUnload);
  await withDebugger(contents, async () => {
    // Taken off only now: a detach from here on is this release's own.
    contents.debugger.off('detach', lease.onDetach);
    contents.off('render-process-gone', lease.onGone);
    await turnOff(contents, lease);
  });
  contents.debugger.off('message', lease.onMessage);
  unholdSends(contents);
}

/** Everything the lease turned on, off (in the debugger queue): the service worker back first (C3), whatever ended it. */
async function turnOff(contents: WebContents, lease: Lease): Promise<void> {
  const debug = contents.debugger;
  if (contents.isDestroyed() || !debug.isAttached()) return;
  const quiet = (method: string, params: object = {}, sessionId?: string) => command(debug, method, params, sessionId).catch(() => undefined);
  for (const sessionId of [undefined, ...lease.sessions]) await quiet('Network.setBypassServiceWorker', { bypass: false }, sessionId);
  if (lease.mine) return void debug.detach();
  // Someone else's attachment: everything this lease turned on goes off again, left as it was.
  await quiet('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  for (const sessionId of [...lease.sessions, undefined]) {
    await quiet('Fetch.disable', {}, sessionId);
    await quiet('WebAuthn.disable', {}, sessionId);
    await quiet('FedCm.disable', {}, sessionId);
    await quiet('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
  }
}
