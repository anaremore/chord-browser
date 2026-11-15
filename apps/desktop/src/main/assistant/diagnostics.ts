/**
 * page_diagnostics' read (ARCHITECTURE.md §11.3): what Chromium kept of a
 * page's problems, asked for once through the tab's own debugger and let go.
 *
 * Nothing listens before the assistant calls the tool, so pages pay nothing.
 * Then: attach, `Log.enable` (which sends the entries Blink kept: failed loads,
 * interventions, security and deprecation messages), `Runtime.enable` (which
 * sends the console calls and uncaught exceptions V8 kept, verified in the E2E,
 * §11.3), disable both and detach. The Network domain is never enabled, so no
 * request's headers, cookies or body is ever seen. DevTools open on the tab
 * are another client of the same page and keep working; a debugger Chord
 * can't attach says so instead of returning nothing.
 */
import type { CdpConsoleCall, CdpException, CdpLogEntry, DiagnosticsEvent } from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { ASSISTANT_WORLD } from './extract';

/** How long the whole read may take: a hung page is a refusal, not a turn that never ends. */
const READ_MS = 5000;
/** Events kept while asking: Blink and V8 each keep at most 1,000; this is a ceiling, not the bound the model sees. */
const MAX_EVENTS = 5000;

/** Each resource's `initiatorType`, by its full address, from the page's own Resource Timing (read in Chord's isolated world). */
const TYPES_SCRIPT = `(() => { const out = {}; for (const e of performance.getEntriesByType('resource').slice(-500)) out[e.name] = e.initiatorType; return out; })()`;

export type DiagnosticsRead = { ok: true; events: DiagnosticsEvent[]; types: Record<string, string> } | { ok: false; why: string };

export async function readDiagnostics(contents: WebContents): Promise<DiagnosticsRead> {
  if (contents.isDestroyed()) return { ok: false, why: 'The tab is gone.' };
  const debug = contents.debugger;
  // Chord's own client may be attached for a moment already (a screenshot): use it, and leave it attached.
  const mine = !debug.isAttached();
  if (mine) {
    try {
      debug.attach('1.3');
    } catch (error) {
      return { ok: false, why: `Chord couldn't attach to the page (${error instanceof Error ? error.message : String(error)}). Its DevTools Console shows the same problems.` };
    }
  }
  const events: DiagnosticsEvent[] = [];
  const onMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
    if (sessionId || events.length >= MAX_EVENTS) return;
    if (method === 'Log.entryAdded') events.push({ kind: 'log', entry: (params as { entry: CdpLogEntry }).entry });
    else if (method === 'Runtime.consoleAPICalled') events.push({ kind: 'console', call: params as CdpConsoleCall });
    else if (method === 'Runtime.exceptionThrown') events.push({ kind: 'exception', thrown: params as CdpException });
  };
  let detached = false;
  const onDetach = () => (detached = true);
  debug.on('message', onMessage);
  debug.on('detach', onDetach);
  try {
    const asked = async () => {
      // The replayed entries arrive before each command's answer (one channel, in order).
      await debug.sendCommand('Log.enable');
      await debug.sendCommand('Runtime.enable');
      return true;
    };
    const done = await pageCall(asked(), false, READ_MS);
    if (!done || detached) return { ok: false, why: detached ? 'The page let go of Chord while it was asking.' : 'The page took too long to answer.' };
    const types = (await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: TYPES_SCRIPT }]), {}, READ_MS)) as Record<string, string> | null;
    return { ok: true, events, types: types && typeof types === 'object' ? types : {} };
  } catch (error) {
    return { ok: false, why: `The page didn't answer (${error instanceof Error ? error.message : String(error)}).` };
  } finally {
    debug.off('message', onMessage);
    debug.off('detach', onDetach);
    if (!contents.isDestroyed() && debug.isAttached()) {
      await Promise.allSettled([debug.sendCommand('Runtime.disable'), debug.sendCommand('Log.disable')]);
      if (mine && debug.isAttached()) debug.detach();
    }
  }
}
