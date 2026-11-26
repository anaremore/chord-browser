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
import { holdSends, sendsOn } from '../control/sends';
import { PAGE_LACKS, WORKER_READS_ONLY } from './agent-scripts';
import { withDebugger } from '../debugger-queue';

type Message = { method: string; params: unknown; sessionId?: string };

/** Agent tabs whose hold isn't on (not yet, or the debugger let go): nothing is pressed or typed there. */
const lost = new WeakSet<object>();
/** Each held tab's way to try once more now (an action's), resolving with whether the hold is on. */
const retries = new WeakMap<object, () => Promise<boolean>>();

export function pickersLost(contents: object): boolean {
  return lost.has(contents);
}

/**
 * The frames of another process, and the dedicated workers, the hold attached in each tab (their sessions).
 */
const sessions = new WeakMap<object, Set<string>>();

/**
 * The targets the hold attaches, each held at its start: frames of another process, and dedicated workers (made to
 * read only: holdWorker). Never a service worker: it's the site's, shared with your
 * own tabs there, and holding it would hold what they send (Claude's review 3 of #112). An agent's tab bypasses service
 * workers instead (`Network.setBypassServiceWorker`), so what it sends is its own, and held as such; and it has no
 * shared workers at all (preload/agent-hold.ts), which it would share with your tabs the same way.
 */
const ATTACHED = [{ type: 'iframe' }, { type: 'worker' }];
const WORKERS = new Set(['worker']);

/**
 * Agent tabs with a frame that couldn't be held (its interception never answered): it stays held at its start, a
 * blank frame that keeps the page from finishing its load, and acting there is refused at once, with that said,
 * rather than waiting on a load that won't come (Claude's review 8 of #110). Cleared by the page's next document.
 */
const unsecured = new WeakSet<object>();

export function pickersUnsecured(contents: object): boolean {
  return unsecured.has(contents);
}

/** Agent tabs whose first page hasn't come yet (tabs.ts: a blank page, service workers bypassed, then the address). */
const firstLoad = new WeakSet<object>();

/** Whether the tab's first page is still on its way: a read or open_tab waits for it rather than reading the blank one. */
export function firstLoadPending(contents: object): boolean {
  return firstLoad.has(contents);
}

/** tabs.ts: the tab's first page is on its way (true), or came, or never will (false). */
export function setFirstLoadPending(contents: object, pending: boolean): void {
  if (pending) firstLoad.add(contents);
  else firstLoad.delete(contents);
}

/**
 * A new agent tab's service workers bypassed (Claude's review 3 of #112): what it sends is its own, never a service
 * worker's, which is the site's and shared with your tabs there. Asked once its page has a renderer (tabs.ts loads a
 * blank page for it first); the real page loads only if this answered.
 */
export async function bypassServiceWorkers(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return false;
  const debug = contents.debugger;
  return Promise.race([
    debug
      .sendCommand('Network.enable', {})
      .then(() => debug.sendCommand('Network.setBypassServiceWorker', { bypass: true }))
      // And every document it loads from now without what could send out of the hold's sight (PAGE_LACKS).
      .then(() => debug.sendCommand('Page.enable'))
      .then(() => debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LACKS, runImmediately: true }))
      .then(
        () => true,
        () => false,
      ),
    new Promise<boolean>((done) => setTimeout(() => done(false), COMMAND_MS).unref?.()),
  ]);
}

/**
 * A new agent tab's hold couldn't be finished (its service workers not bypassed: tabs.ts): lost and unsecured, so
 * nothing acts there and open_tab says it couldn't be opened (round 4 of #112: never a page loaded unheld).
 */
export function holdFailed(contents: object): void {
  lost.add(contents);
  unsecured.add(contents);
  // An arming in flight counts for nothing: it can't put the hold back on (Claude's final pass).
  failers.get(contents)?.();
}

/** Per tab, its hold's way to make an arming in flight count for nothing (holdFailed). */
const failers = new WeakMap<object, () => void>();

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

/**
 * Starts holding pickers in `contents`; `held` hears each one held. Resolves once its page's hold is on (its frames'
 * auto-attach, its sends held, service workers bypassed): the tab's page is loaded only then (tabs.ts), since a frame
 * whose navigation was under way when the frames' auto-attach began is held at its start without the hold hearing of
 * it (CI's arm64, #112), and a page loaded unheld would send unasked (Claude's review 3: fail closed). A hold that never
 * comes on leaves the tab unloaded: blank, and open_tab says it couldn't load.
 */
export function holdFilePickers(contents: WebContents, held: (detail: string) => void): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  const debug = contents.debugger;
  // What the tab sends, held for its life (control/sends.ts): answered from its first request.
  holdSends(contents);
  /** The attachment armed now: a detach (or another arm) makes answers from before it count for nothing. */
  let generation = 0;
  let tries = 0;
  /** The page's hold is on (its frames' auto-attach, its sends, service workers bypassed): what tabs.ts waits on to load the page. */
  let framesOn: () => void = () => undefined;
  const framesReady = new Promise<void>((done) => (framesOn = done));
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
    // Its frames first: held from their start once this is on (the browser answers it, with or without a page yet, so
    // the tab's page can load right after: tabs.ts waits on it). An auto-attach that failed (or never answered) leaves
    // them unheld, so the hold isn't on.
    const attached = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: ATTACHED }, sessionId);
    // Its requests its own, never a service worker's (which would send them out of the hold's sight). Only where there's
    // a renderer (the Network domain closes the session otherwise): a frame, or a page armed again; a new page's comes
    // from tabs.ts, which loads a blank page for it first (bypassServiceWorkers).
    const bypassed = sessionId || contents.getURL() ? (await send('Network.enable', {}, sessionId)) && (await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)) : true;
    // The page's sends held before it loads too (control/sends.ts: a page that posts as it loads asks first).
    const sendingFirst = sessionId ? true : await sendsOn(contents);
    if (!sessionId && attached && bypassed && sendingFirst) framesOn();
    await send('Page.enable', undefined, sessionId);
    // Each new document without what could send out of the hold's sight (PAGE_LACKS): a frame's before it runs, a page
    // armed again; a new page's comes with its bypass (tabs.ts, bypassServiceWorkers).
    const lacking = sessionId || contents.getURL() ? await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LACKS, runImmediately: true }, sessionId) : true;
    const intercepted =
      (await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)) || (await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId));
    // What it sends held from its start too (control/sends.ts): in the page, and in a frame before it runs.
    const sending = intercepted && attached && (sessionId ? await sendsOn(contents, sessionId) : sendingFirst);
    const on = intercepted && attached && bypassed && lacking && sending;
    if (sessionId && on) void send('Runtime.runIfWaitingForDebugger', undefined, sessionId);
    if (sessionId && !on) unsecured.add(contents);
    return on;
  };
  /**
   * A dedicated worker: its own workers held as they start too, service workers bypassed, and made to read only
   * (WORKER_READS_ONLY), then it runs. Chromium gives it no Fetch domain of its own, and its requests never pass through
   * its page's (Claude's review 3 of #112 found it, end to end), so what it would send can't be held: it isn't sent.
   * One that couldn't be made so stays held at its start (acting there is refused until the next document).
   */
  const holdWorker = async (sessionId: string): Promise<void> => {
    const nested = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: ATTACHED }, sessionId);
    // Never through the site's service worker either (its requests would leave the page's hold).
    const bypassed = (await send('Network.enable', {}, sessionId)) && (await send('Network.setBypassServiceWorker', { bypass: true }, sessionId));
    // And it reads, never sends (WORKER_READS_ONLY): its own requests aren't the page's hold's to see.
    // Only if the script ran through (a thrown one answers too, with its exception).
    const readsOnly = await Promise.race([
      debug.sendCommand('Runtime.evaluate', { expression: WORKER_READS_ONLY, returnByValue: true }, sessionId).then(
        (r: { result?: { value?: unknown }; exceptionDetails?: unknown }) => !r.exceptionDetails && r.result?.value === true,
        () => false,
      ),
      new Promise<boolean>((done) => setTimeout(() => done(false), COMMAND_MS).unref?.()),
    ]);
    if (nested && bypassed && readsOnly) void send('Runtime.runIfWaitingForDebugger', undefined, sessionId);
    else unsecured.add(contents);
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
      const type = attached.targetInfo?.type ?? '';
      if (type === 'iframe' || WORKERS.has(type)) {
        let known = sessions.get(contents);
        if (!known) sessions.set(contents, (known = new Set()));
        known.add(attached.sessionId);
      }
      if (type === 'iframe') {
        const held = hold(attached.sessionId);
        framesArming?.push(held);
      } else if (WORKERS.has(type)) void holdWorker(attached.sessionId);
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
  failers.set(contents, () => {
    generation++;
  });
  // The page loads once its hold is on (framesReady: its frames' auto-attach and its sends); the rest of the arming
  // (the page's own interception) goes on beside that load.
  void arm();
  return framesReady;
}
