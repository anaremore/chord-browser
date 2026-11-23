/**
 * What an agent's action sends (S18 M2d; the owner's default, 2026-11-23: "ask when it sends data"). The words, forms
 * and addresses classify a step before it's sent (core's control-risk.ts); this is the layer under them, by what the
 * step does: while an agent's action runs, every request its tab makes, in any frame, its own process or another's,
 * passes through Chromium's `Fetch` domain on the tab's debugger (attached for the tab's life: agents/pickers.ts).
 *
 * - A request that only reads (GET, HEAD) goes on.
 * - A report (a beacon, an `<a ping>`: `resourceType` Ping) is dropped, answered with nothing: no report leaves an
 *   agent's action, and none asks (the owner's option A: analytics never ask). The rare page that saves data by
 *   beacon loses it while an agent acts.
 * - Anything else that sends data (a form posted, a fetch or XHR with another method, any other) is held, and the
 *   action's step card asks once for all of them, saying which sites they go to (tools.ts). Allow lets them go;
 *   Don't, no answer, or Stop drops them. A step the user already allowed (a classified risky one) isn't asked
 *   again: its requests go (`pass`).
 * - After the action, for a moment (TAIL_MS, or until the tab's next action), what its page still sends is dropped,
 *   never held (no one is there to ask), and its next result says so.
 *
 * A request dropped is answered: a document with an empty 204 (the page stays where it was), anything else failed
 * (the page's script sees an error, as for a blocked request).
 */
import type { WebContents } from 'electron';
import { frameSessions } from '../agents/pickers';

/** After an action, how long what its page still sends is dropped (a debounced save, a timer's submit). */
export const SENDS_TAIL_MS = 1500;
/** Each command's limit. */
const COMMAND_MS = 3000;

type Paused = { requestId: string; sessionId: string | undefined; url: string; type: string };

/** What one action sent, held, so far. */
export interface SendWatch {
  /** The addresses held (each request's), in order. */
  held(): string[];
  /** Resolves the first time something is held (never, if nothing is). */
  heldNow: Promise<void>;
  /** Allow lets what's held go, and what's sent from now on in this action; Don't drops it all. */
  release(allow: boolean): void;
  /** The action's over: what's still held is dropped, and the tail starts. */
  end(): void;
}

interface Watching {
  mode: 'hold' | 'pass' | 'deny' | 'tail';
  held: Paused[];
  heldNow: () => void;
  /** Sessions the Fetch domain is on (undefined: the page's own). */
  sessions: Set<string | undefined>;
  tail: ReturnType<typeof setTimeout> | null;
  /** What the tail dropped since the tab's last action. */
  tailDropped: number;
  listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
}

const watching = new WeakMap<object, Watching>();
/** What tails dropped, per tab, until its next action takes the count. */
const dropped = new WeakMap<object, number>();

/** What the tab's page sent after its last action, dropped: taken (the count goes back to 0). */
export function takeDroppedAfter(contents: object): number {
  const n = dropped.get(contents) ?? 0;
  dropped.delete(contents);
  return n;
}

/**
 * Starts watching what `contents` sends for one action (any watch before it ends at once). `pass`: a step the user
 * already allowed: its requests go (reports are still dropped). Null if the tab's debugger isn't there to watch with:
 * nothing is sent then (tools.ts refuses).
 */
export async function watchSends(contents: WebContents, pass: boolean): Promise<SendWatch | null> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const debug = contents.debugger;
  stop(contents);
  const send = (method: string, params?: object, sessionId?: string): Promise<boolean> => {
    if (contents.isDestroyed() || !debug.isAttached()) return Promise.resolve(false);
    return Promise.race([
      debug.sendCommand(method, params, sessionId).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => setTimeout(() => done(false), COMMAND_MS).unref?.()),
    ]);
  };
  const go = (p: Paused) => void send('Fetch.continueRequest', { requestId: p.requestId }, p.sessionId);
  const drop = (p: Paused) =>
    void (p.type === 'Document'
      ? send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: [] }, p.sessionId)
      : send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, p.sessionId));
  let heldNow: () => void = () => undefined;
  const firstHeld = new Promise<void>((done) => (heldNow = done));
  const w: Watching = {
    mode: pass ? 'pass' : 'hold',
    held: [],
    heldNow: () => heldNow(),
    sessions: new Set(),
    tail: null,
    tailDropped: 0,
    listener: (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        // A frame of another process attached while it watches: watched too.
        const attached = params as { sessionId?: string; targetInfo?: { type?: string } };
        if (attached.sessionId && attached.targetInfo?.type === 'iframe') void enable(attached.sessionId);
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      const at = params as { requestId?: string; request?: { method?: string; url?: string }; resourceType?: string };
      if (!at.requestId) return;
      // The page's own target comes with an empty session id: answered without one (an empty one reaches no session).
      const p: Paused = { requestId: at.requestId, sessionId: sessionId || undefined, url: String(at.request?.url ?? ''), type: String(at.resourceType ?? '') };
      const how = String(at.request?.method ?? 'GET').toUpperCase();
      if (how === 'GET' || how === 'HEAD') return go(p);
      // A report: dropped, never asked (the owner's option A).
      if (p.type === 'Ping') return drop(p);
      switch (w.mode) {
        case 'pass':
          return go(p);
        case 'hold':
          w.held.push(p);
          return w.heldNow();
        case 'deny':
          return drop(p);
        case 'tail':
          w.tailDropped++;
          dropped.set(contents, (dropped.get(contents) ?? 0) + 1);
          return drop(p);
      }
    },
  };
  const enable = async (sessionId?: string) => {
    if (w.sessions.has(sessionId)) return true;
    w.sessions.add(sessionId);
    return send('Fetch.enable', { patterns: [{ requestStage: 'Request' }] }, sessionId);
  };
  debug.on('message', w.listener);
  watching.set(contents, w);
  // The page's own target, and every frame of another process the tab holds (agents/pickers.ts attaches them).
  const on = await enable();
  for (const session of frameSessions(contents)) await enable(session);
  if (!on) {
    stop(contents);
    return null;
  }
  return {
    held: () => w.held.map((p) => p.url),
    heldNow: firstHeld,
    release: (allow) => {
      const held = w.held.splice(0);
      w.mode = allow ? 'pass' : 'deny';
      for (const p of held) (allow ? go : drop)(p);
    },
    end: () => {
      if (watching.get(contents) !== w) return;
      for (const p of w.held.splice(0)) drop(p);
      w.mode = 'tail';
      w.tail = setTimeout(() => stop(contents), SENDS_TAIL_MS);
      w.tail.unref?.();
    },
  };
}

/** The watch ends: the Fetch domain off wherever it was on (a paused request goes on: disabling lets it). */
export function stopWatching(contents: WebContents): void {
  stop(contents);
}

function stop(contents: WebContents): void {
  const w = watching.get(contents);
  if (!w) return;
  watching.delete(contents);
  if (w.tail) clearTimeout(w.tail);
  for (const p of w.held.splice(0)) {
    void contents.debugger.sendCommand('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, p.sessionId).catch(() => undefined);
  }
  if (contents.isDestroyed()) return;
  contents.debugger.off('message', w.listener);
  if (!contents.debugger.isAttached()) return;
  for (const session of w.sessions) void contents.debugger.sendCommand('Fetch.disable', undefined, session).catch(() => undefined);
}
