/**
 * File pickers in an outside agent's tab, held for the tab's whole life (Neon's review of #110): agents never choose
 * files, and a page can open a picker for as long as the user activation an agent's click gave it lasts (about 5 s),
 * from a detached input, an input in a closed shadow root, or a frame of its own. So the tab's debugger stays attached
 * from the moment its page is made, with Chromium's file chooser interception on (`Page.setInterceptFileChooserDialog`)
 * in its page and in every frame of it in another process (`Target.setAutoAttach`, iframes only, each held before it
 * runs: `waitForDebuggerOnStart`, then `Runtime.runIfWaitingForDebugger` once its interception is on, or failed): a
 * picker is never shown, and the agent hears of it with its next result, as of a dialog.
 *
 * The hold counts as on only once the interception answered, on the attachment it was asked on (a generation: a
 * detach meanwhile makes an answer from before it count for nothing). Until then, and whenever the debugger lets go
 * (someone detached it, the renderer crashed and came back), the tab's hold is lost (`pickersLost`) and acting there
 * does nothing (control/deep.ts refuses, before every input). It's armed again with a growing wait, at most
 * REARM_TRIES times in a row; after that only an action (once each: retryPickers) or the page's next load tries again.
 *
 * Only an agent's tab: a tab of yours never gets it, and a tab you keep gets a new page (core's keepAgentTab), which
 * this never attaches to. Chord's other debugger clients (page_diagnostics, screenshots, acting's control/deep.ts)
 * find it attached and use it as it is, never detaching it.
 */
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';

type Message = { method: string; params: unknown; sessionId?: string };

/** Agent tabs whose hold isn't on (not yet, or the debugger let go): nothing is pressed or typed there. */
const lost = new WeakSet<object>();
/** Each held tab's way to try once more now (an action's), resolving with whether the hold is on. */
const retries = new WeakMap<object, () => Promise<boolean>>();

export function pickersLost(contents: object): boolean {
  return lost.has(contents);
}

/** The frames of another process the hold attached in each tab (their sessions): what an action's watch also watches (control/sends.ts). */
const sessions = new WeakMap<object, Set<string>>();

export function frameSessions(contents: object): ReadonlySet<string> {
  return sessions.get(contents) ?? new Set();
}

/**
 * Agent tabs with a frame that couldn't be held (its interception never answered): it stays held at its start, a
 * blank frame that keeps the page from finishing its load, and acting there is refused at once, with that said,
 * rather than waiting on a load that won't come (Claude's review 8 of #110). Cleared by the page's next document.
 */
const unsecured = new WeakSet<object>();

export function pickersUnsecured(contents: object): boolean {
  return unsecured.has(contents);
}

/** An action found the hold lost: one try now (never more than one per action), and whether it's on. */
export async function retryPickers(contents: object): Promise<boolean> {
  const retry = retries.get(contents);
  return retry ? retry() : !lost.has(contents);
}

/** The first wait before arming again; it doubles each try, at most REARM_MAX_MS. */
const REARM_MS = 250;
const REARM_MAX_MS = 5000;
/** Tries in a row (a debugger that keeps letting go stops here), then only an action or a load tries again. */
const REARM_TRIES = 8;
/** Each command's limit: a hung page never leaves the hold half on, or a frame waiting. */
const COMMAND_MS = 3000;

/** Starts holding pickers in `contents`; `held` hears each one held. */
export function holdFilePickers(contents: WebContents, held: (detail: string) => void): void {
  if (contents.isDestroyed()) return;
  const debug = contents.debugger;
  /** The attachment armed now: a detach (or another arm) makes answers from before it count for nothing. */
  let generation = 0;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  lost.add(contents);
  /** A command's answer (true: it answered without an error), within COMMAND_MS. */
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
  /**
   * Interception on in a target (the page, or a frame in another process), frames under it held as they start. A
   * frame goes on only once its interception answered (tried twice): one that never got it stays held, a blank frame
   * in the agent's tab rather than one that could show a picker (Neon's review 7 of #110).
   */
  const hold = async (sessionId?: string): Promise<boolean> => {
    await send('Page.enable', undefined, sessionId);
    const intercepted =
      (await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)) || (await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId));
    // Its frames held too: an auto-attach that failed (or never answered) leaves them unheld, so the hold isn't on.
    const attached = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] }, sessionId);
    const on = intercepted && attached;
    if (sessionId && on) void send('Runtime.runIfWaitingForDebugger', undefined, sessionId);
    if (sessionId && !on) unsecured.add(contents);
    return on;
  };
  /**
   * The frames attached during an arming (those already there when it asks: a re-arm after a detach finds them
   * running, not held at their start): the tab's hold is on only once every one of theirs is (Claude's review 8).
   */
  let framesArming: Promise<boolean>[] | null = null;
  /**
   * Attaches (if need be) and arms; the hold is on only if this attachment's interception answered. One arming at a
   * time (a load and a retry together share it), in Chord's debugger queue (withDebugger): never riding another
   * client's attachment that it then lets go of (page_diagnostics' own, when the hold was down).
   */
  let arming: Promise<boolean> | null = null;
  const arm = (): Promise<boolean> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (contents.isDestroyed()) return Promise.resolve(false);
    arming ??= withDebugger(contents, async () => {
      const mine = ++generation;
      lost.add(contents);
      try {
        if (!debug.isAttached()) debug.attach('1.3');
      } catch {
        later();
        return false;
      }
      framesArming = [];
      const top = await hold();
      // Every frame attached meanwhile (the existing ones are attached before setAutoAttach answers).
      const frames = framesArming;
      framesArming = null;
      const on = top && (await Promise.all(frames)).every(Boolean);
      if (on && mine === generation && debug.isAttached()) {
        lost.delete(contents);
        tries = 0;
        return true;
      }
      if (mine === generation) later();
      return false;
    }).finally(() => {
      arming = null;
      // A detach while it armed asked for a retry that this arming swallowed: one is always set when it ends lost.
      if (lost.has(contents)) later();
    });
    return arming;
  };
  /** Tried again after a growing wait, at most REARM_TRIES times in a row. */
  const later = () => {
    if (timer || contents.isDestroyed() || ++tries > REARM_TRIES) return;
    timer = setTimeout(() => void arm(), Math.min(REARM_MS * 2 ** (tries - 1), REARM_MAX_MS));
    timer.unref?.();
  };
  retries.set(contents, () => (lost.has(contents) ? arm() : Promise.resolve(true)));
  debug.on('message', (_event, method: Message['method'], params: Message['params']) => {
    if (method === 'Page.fileChooserOpened') held('a file picker');
    else if (method === 'Target.detachedFromTarget') sessions.get(contents)?.delete(String((params as { sessionId?: string }).sessionId));
    else if (method === 'Target.attachedToTarget') {
      const attached = params as { sessionId?: string; targetInfo?: { type?: string } };
      if (!attached.sessionId) return;
      if (attached.targetInfo?.type === 'iframe') {
        let known = sessions.get(contents);
        if (!known) sessions.set(contents, (known = new Set()));
        known.add(attached.sessionId);
        const held = hold(attached.sessionId);
        framesArming?.push(held);
      }
      // Anything else the filter let through goes on as it was.
      else void send('Runtime.runIfWaitingForDebugger', undefined, attached.sessionId);
    }
  });
  // Let go of (detached, a renderer that crashed): lost until armed again (an answer in flight counts for nothing).
  debug.on('detach', () => {
    if (contents.isDestroyed()) return;
    generation++;
    lost.add(contents);
    later();
  });
  // Another document: its frames are its own (one that couldn't be held went with the old one).
  contents.on('did-navigate', () => unsecured.delete(contents));
  contents.on('render-process-gone', () => {
    generation++;
    lost.add(contents);
  });
  // A page that loaded with the hold lost (after a crash, or the tries ran out): tried again, from the start.
  contents.on('did-finish-load', () => {
    if (!lost.has(contents)) return;
    tries = 0;
    void arm();
  });
  void arm();
}
