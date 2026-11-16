/**
 * page_diagnostics' read (ARCHITECTURE.md §11.3): what Chromium kept of a
 * page's problems, asked for once through the tab's own debugger and let go.
 *
 * Nothing listens before the assistant calls the tool, so pages pay nothing.
 * Then: attach, `Log.enable` (which sends the entries Blink kept: failed loads,
 * interventions, security and deprecation messages), `Runtime.enable` (which
 * sends the console calls and uncaught exceptions V8 kept, verified in the E2E,
 * §11.3), and detach, which drops both domains. The Network domain is never
 * enabled, so no request's headers, cookies or body is ever seen. DevTools open
 * on the tab are another client of the same page and keep working; a debugger
 * Chord can't attach says so instead of returning nothing.
 *
 * Nothing here waits on the page without a limit (ARCHITECTURE.md §1, rule 1):
 * a hung renderer answers no command, so the read gives up after READ_MS and
 * detaches at once. Debugger work is one at a time per page (debugger-queue.ts),
 * shared with screenshots, so two clients never detach each other.
 */
import { shrinkEvent, type CdpConsoleCall, type CdpException, type CdpLogEntry, type DiagnosticsEvent } from '@chord/core';
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { PAGE_CALL_MS, pageCall, pageOutcome } from '../page-call';
import { ASSISTANT_WORLD } from './extract';

/** How long the page may take to answer: a hung page is a refusal, not a turn that never ends. */
export const DIAGNOSTICS_READ_MS = 5000;
/** Events kept while asking, each already cut to size (shrinkEvent): a ceiling, not the bound the model sees. */
export const DIAGNOSTICS_MAX_EVENTS = 2500;

/** Each resource's `initiatorType`, by its full address, from the page's own Resource Timing (read in Chord's isolated world). */
const TYPES_SCRIPT = `(() => { const out = {}; for (const e of performance.getEntriesByType('resource').slice(-500)) out[e.name.slice(0, 2048)] = e.initiatorType; return out; })()`;

export type DiagnosticsRead = { ok: true; events: DiagnosticsEvent[]; types: Record<string, string> } | { ok: false; why: string };

/** What of a page's WebContents the read uses (a fake in the unit tests). */
export type DiagnosticsContents = Pick<WebContents, 'isDestroyed' | 'executeJavaScriptInIsolatedWorld'> & {
  debugger: Pick<WebContents['debugger'], 'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on' | 'off'>;
};

export function readDiagnostics(contents: DiagnosticsContents, ms = DIAGNOSTICS_READ_MS): Promise<DiagnosticsRead> {
  return withDebugger(contents, () => readOnce(contents, ms));
}

async function readOnce(contents: DiagnosticsContents, ms: number): Promise<DiagnosticsRead> {
  if (contents.isDestroyed()) return { ok: false, why: 'The tab is gone.' };
  const debug = contents.debugger;
  // Chord's own clients take turns (withDebugger), so one already attached is someone else's: use it, and leave it attached.
  const mine = !debug.isAttached();
  if (mine) {
    try {
      debug.attach('1.3');
    } catch (error) {
      return { ok: false, why: `Chord couldn't attach to the page (${error instanceof Error ? error.message : String(error)}). Its DevTools Console shows the same problems.` };
    }
  }
  const events: DiagnosticsEvent[] = [];
  // Cut to size as each arrives (each argument and field to its own limit): a page can log megabytes at a time.
  // The ceiling keeps the first events, not the newest. Chromium replays at most about 1,000 console and 1,000 log
  // entries, so the replay stays under it; entries the page logs during the read may be dropped.
  const onMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
    if (sessionId || events.length >= DIAGNOSTICS_MAX_EVENTS) return;
    if (method === 'Log.entryAdded') events.push(shrinkEvent({ kind: 'log', entry: (params as { entry: CdpLogEntry }).entry }));
    else if (method === 'Runtime.consoleAPICalled') events.push(shrinkEvent({ kind: 'console', call: params as CdpConsoleCall }));
    else if (method === 'Runtime.exceptionThrown') events.push(shrinkEvent({ kind: 'exception', thrown: params as CdpException }));
  };
  let detached = false;
  // Set once the read is over: a page that answers Log.enable late must not get Runtime.enable after Chord let go.
  let over = false;
  const onDetach = () => (detached = true);
  debug.on('message', onMessage);
  debug.on('detach', onDetach);
  try {
    // The replayed entries arrive before each command's answer (one channel, in order).
    const asked = await pageOutcome(
      (async () => {
        await debug.sendCommand('Log.enable');
        if (over) return;
        await debug.sendCommand('Runtime.enable');
      })(),
      ms,
    );
    if (detached) return { ok: false, why: 'The page let go of Chord while it was asking.' };
    if (!asked.ok) return { ok: false, why: 'timedOut' in asked ? 'The page took too long to answer.' : `The page didn't answer (${asked.error}).` };
    const types = await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: TYPES_SCRIPT }]) as Promise<unknown>, {}, PAGE_CALL_MS);
    return { ok: true, events, types: types && typeof types === 'object' ? (types as Record<string, string>) : {} };
  } finally {
    over = true;
    debug.off('message', onMessage);
    debug.off('detach', onDetach);
    if (!contents.isDestroyed() && debug.isAttached()) {
      // Detaching drops the domains, without asking the page (which may be hung). Someone else's client keeps its
      // attachment: the domains are turned off without waiting for an answer.
      if (mine) debug.detach();
      else for (const method of ['Runtime.disable', 'Log.disable']) debug.sendCommand(method).catch(() => undefined);
    }
  }
}
