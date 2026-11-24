/**
 * The assistant acting in a tab of yours (S18 M2e-2; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from just before an action until a moment after the last one. Then everything is let
 * go of, and the tab is as it always was.
 *
 * - **What the page sends** is held and asked about during an action and TAIL_MS after it (M2e-2a, C1).
 * - **What its click sets off** (M2e-2b, A6) is caught for AFTER_MS after the last action, the activation's life and a
 *   margin: file pickers intercepted, passkeys refused before any prompt (`WebAuthn.enable` with no authenticator: the
 *   M2e-2 spike), FedCM's chooser dismissed, the site's service worker bypassed (its other tabs keep theirs: C3, always
 *   restored), dialogs noted, and (elsewhere, asking `userTabCatching`) popups, downloads and the clipboard.
 *
 * The lease never holds the debugger queue (debugger-queue.ts) between its own two steps (on, off), so the action's own
 * checks (deep.ts), page_diagnostics and screenshots run as ever (Neon's B3). A second action joins the lease. Your own
 * input in the tab (assistant/service.ts) ends it at once: what was held for the assistant fails, and nothing of yours
 * is ever held or caught.
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
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];

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

interface Lease {
  deps: UserTabDeps;
  /** Chord attached the debugger for this lease (else someone else's attachment, used as it is: never detached). */
  mine: boolean;
  actions: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Until when what the page sends is the assistant's (held): its last action's end and TAIL_MS. */
  sendsUntil: number;
  /** Frames in other processes, auto-attached while the lease is on: their sessions, to turn things off in. */
  sessions: Set<string>;
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
  /** The clipboard's text as the lease began. */
  clipboard: string | null;
  /** Its downloads' cards, to take down when it ends. */
  cancel: AbortController;
}

const leases = new WeakMap<WebContents, Lease>();

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

/** A download the page started in the window: asked in the chat first (false when no lease: it isn't the assistant's). */
export function askUserTabDownload(contents: object, filename: string): Promise<boolean> | null {
  const lease = leases.get(contents as WebContents);
  if (!lease || lease.ended) return null;
  return lease.deps.askDownload(filename, lease.cancel.signal).catch(() => false);
}

/**
 * The lease on, for one action (or joined, if one is on). False if the tab's debugger can't be had (someone's DevTools)
 * or Fetch can't be turned on: nothing is pressed or typed then.
 */
export async function beginUserAction(contents: WebContents, deps: UserTabDeps): Promise<boolean> {
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
    const lease: Lease = { deps, mine, actions: 1, ended: false, timer: null, sendsUntil: 0, sessions: new Set(), onMessage: () => undefined, clipboard: await readClipboard(deps), cancel: new AbortController() };
    const quiet = (method: string, params: object = {}, sessionId?: string) => debug.sendCommand(method, params, sessionId).catch(() => undefined);
    /** What the action's click set off, in the page or a frame: caught for the chat. */
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
      // A frame in another process, as it comes: its requests held, and what it sets off caught, before it runs.
      if (method === 'Target.attachedToTarget' && p.sessionId) {
        const frame = p.sessionId;
        lease.sessions.add(frame);
        void quiet('Fetch.enable', { patterns: PATTERNS }, frame)
          .then(() => catching(frame))
          .finally(() => (p.waitingForDebugger ? quiet('Runtime.runIfWaitingForDebugger', {}, frame) : undefined));
        return;
      }
      if (method === 'Page.fileChooserOpened') return deps.note('file', 'a file picker');
      if (method === 'Page.javascriptDialogOpening') return deps.note('dialog', `${p.type ?? 'alert'}: “${String(p.message ?? '').slice(0, 120)}”`);
      if (method === 'FedCm.dialogShown') {
        void quiet('FedCm.dismissDialog', { dialogId: p.dialogId }, sessionId);
        return deps.note('signin', 'a sign-in with another site');
      }
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
    await catching();
    leases.set(contents, lease);
    // A page with unsaved changes stays put: the action hears it (its move didn't happen).
    contents.on('will-prevent-unload', onUnload);
    holdSends(contents);
    // During an action and TAIL_MS after it, what the tab sends is the assistant's: held and asked about. Then, or once
    // you take the tab, yours.
    sendHoldDeps(contents, { ...deps, whose: () => (!lease.ended && (lease.actions > 0 || Date.now() < lease.sendsUntil) ? 'agent' : 'user') });
    return true;
  });
}

function onUnload(this: WebContents): void {
  noteUserTab(this, 'unload', 'the page has unsaved changes, so it stayed');
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
 * assistant fails (its cards come down); nothing of yours is held or caught from here (F2).
 */
export function endUserLease(contents: WebContents): void {
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  failHeld(contents);
  void release(contents, lease, false);
}

async function readClipboard(deps: UserTabDeps): Promise<string | null> {
  try {
    return (await deps.clipboard?.read()) ?? null;
  } catch {
    return null;
  }
}

async function release(contents: WebContents, lease: Lease, byTime: boolean): Promise<void> {
  if (lease.ended) return;
  lease.ended = true;
  lease.cancel.abort();
  if (leases.get(contents) === lease) leases.delete(contents);
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
  // What's still held fails; the page's requests go as they always did from here.
  unholdSends(contents);
  await withDebugger(contents, async () => {
    const debug = contents.debugger;
    debug.off('message', lease.onMessage);
    if (contents.isDestroyed() || !debug.isAttached()) return;
    const quiet = (method: string, params: object = {}, sessionId?: string) => debug.sendCommand(method, params, sessionId).catch(() => undefined);
    // The service worker always back (C3), whatever ended the lease, before anything else goes.
    for (const sessionId of [undefined, ...lease.sessions]) await quiet('Network.setBypassServiceWorker', { bypass: false }, sessionId);
    if (lease.mine) return void debug.detach();
    // Someone else's attachment: everything this lease turned on goes off again, left as it was.
    await quiet('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    for (const sessionId of [undefined, ...lease.sessions]) {
      await quiet('Fetch.disable', {}, sessionId);
      await quiet('WebAuthn.disable', {}, sessionId);
      await quiet('FedCm.disable', {}, sessionId);
      await quiet('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
    }
  });
}
