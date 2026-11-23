/**
 * File pickers in an outside agent's tab, held for the tab's whole life (Neon's review of #110): agents never choose
 * files, and a page can open a picker for as long as the user activation an agent's click gave it lasts (about 5 s),
 * from a detached input, an input in a closed shadow root, or a frame of its own. So the tab's debugger stays attached
 * from the moment its page is made, with Chromium's file chooser interception on (`Page.setInterceptFileChooserDialog`)
 * in its page and in every frame of it in another process (`Target.setAutoAttach`, flattened): a picker is never
 * shown, and the agent hears of it with its next result, as of a dialog.
 *
 * Only an agent's tab: a tab of yours never gets it, and a tab you keep gets a new page (core's keepAgentTab), which
 * this never attaches to. Chord's other debugger clients (page_diagnostics, screenshots, acting's control/deep.ts)
 * find it attached and use it as it is, never detaching it.
 */
import type { WebContents } from 'electron';

type Message = { method: string; params: unknown; sessionId?: string };

/** Starts holding pickers in `contents`; `held` hears each one held. Does nothing if the debugger can't be had. */
export function holdFilePickers(contents: WebContents, held: (detail: string) => void): void {
  if (contents.isDestroyed()) return;
  const debug = contents.debugger;
  try {
    if (!debug.isAttached()) debug.attach('1.3');
  } catch {
    // Someone else's client has it in a way Chord can't share: the preload's holds still apply.
    return;
  }
  const send = (method: string, params?: object, sessionId?: string) => {
    if (contents.isDestroyed() || !debug.isAttached()) return;
    debug.sendCommand(method, params, sessionId).catch(() => undefined);
  };
  /** Interception on in a target (the page, or a frame in another process), and frames under it attached too. */
  const hold = (sessionId?: string) => {
    send('Page.enable', undefined, sessionId);
    send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  };
  debug.on('message', (_event, method: Message['method'], params: Message['params']) => {
    if (method === 'Page.fileChooserOpened') held('a file picker');
    else if (method === 'Target.attachedToTarget') {
      const attached = params as { sessionId?: string; targetInfo?: { type?: string } };
      if (attached.sessionId && attached.targetInfo?.type === 'iframe') hold(attached.sessionId);
    }
  });
  hold();
}
