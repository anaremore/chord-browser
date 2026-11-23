/**
 * File pickers in an outside agent's tab, held for the tab's whole life (Neon's review of #110): agents never choose
 * files, and a page can open a picker for as long as the user activation an agent's click gave it lasts (about 5 s),
 * from a detached input, an input in a closed shadow root, or a frame of its own. So the tab's debugger stays attached
 * from the moment its page is made, with Chromium's file chooser interception on (`Page.setInterceptFileChooserDialog`)
 * in its page and in every frame of it in another process (`Target.setAutoAttach`, iframes only, each held before it
 * runs: `waitForDebuggerOnStart`, then `Runtime.runIfWaitingForDebugger` once its interception is on): a picker is
 * never shown, and the agent hears of it with its next result, as of a dialog.
 *
 * If the debugger lets go (someone detached it, the renderer crashed and came back), it's attached and armed again;
 * until it is, the tab's hold is lost (`pickersLost`) and acting there does nothing (control/deep.ts refuses).
 *
 * Only an agent's tab: a tab of yours never gets it, and a tab you keep gets a new page (core's keepAgentTab), which
 * this never attaches to. Chord's other debugger clients (page_diagnostics, screenshots, acting's control/deep.ts)
 * find it attached and use it as it is, never detaching it.
 */
import type { WebContents } from 'electron';

type Message = { method: string; params: unknown; sessionId?: string };

/** Agent tabs whose hold is down (the debugger let go and isn't back yet): nothing is pressed or typed there. */
const lost = new WeakSet<object>();

export function pickersLost(contents: object): boolean {
  return lost.has(contents);
}

/** How soon after letting go the debugger is attached again (a crashed renderer's page coming back). */
const REARM_MS = 250;
/** At most this many tries in a row, then the hold stays lost (acting there refused) until the page is made again. */
const REARM_TRIES = 20;

/** Starts holding pickers in `contents`; `held` hears each one held. */
export function holdFilePickers(contents: WebContents, held: (detail: string) => void): void {
  if (contents.isDestroyed()) return;
  const debug = contents.debugger;
  let tries = 0;
  const send = (method: string, params?: object, sessionId?: string) => {
    if (contents.isDestroyed() || !debug.isAttached()) return Promise.resolve();
    return debug.sendCommand(method, params, sessionId).catch(() => undefined);
  };
  /** Interception on in a target (the page, or a frame in another process), frames under it held as they start. */
  const hold = async (sessionId?: string) => {
    await send('Page.enable', undefined, sessionId);
    await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] }, sessionId);
    // A frame held at its start goes on only now, with its interception on.
    if (sessionId) await send('Runtime.runIfWaitingForDebugger', undefined, sessionId);
  };
  const arm = () => {
    if (contents.isDestroyed()) return;
    try {
      if (!debug.isAttached()) debug.attach('1.3');
    } catch {
      // Taken in a way Chord can't share (or not back yet): tried again a moment later, acting refused meanwhile.
      lost.add(contents);
      if (++tries < REARM_TRIES) setTimeout(arm, REARM_MS).unref?.();
      return;
    }
    tries = 0;
    void hold().then(() => lost.delete(contents));
  };
  debug.on('message', (_event, method: Message['method'], params: Message['params']) => {
    if (method === 'Page.fileChooserOpened') held('a file picker');
    else if (method === 'Target.attachedToTarget') {
      const attached = params as { sessionId?: string; targetInfo?: { type?: string } };
      if (!attached.sessionId) return;
      if (attached.targetInfo?.type === 'iframe') void hold(attached.sessionId);
      // Anything else the filter let through goes on as it was.
      else void send('Runtime.runIfWaitingForDebugger', undefined, attached.sessionId);
    }
  });
  // Let go of (detached, a renderer that crashed): attached and armed again, acting refused until then.
  debug.on('detach', () => {
    if (contents.isDestroyed()) return;
    lost.add(contents);
    setTimeout(arm, REARM_MS).unref?.();
  });
  // A renderer that crashed and came back: armed again, whatever the debugger said.
  contents.on('render-process-gone', () => lost.add(contents));
  contents.on('did-finish-load', () => {
    if (lost.has(contents)) arm();
  });
  arm();
}
