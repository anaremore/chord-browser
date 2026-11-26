/**
 * The first page's request, from Chromium's own net log, for CI's test builds only (#259, part of #189): on Windows
 * CI a first navigation has started and then neither committed nor failed for a whole test. launch-timeline.ts asks
 * for this when that happens; the request's events say how far it got (never asked for, resolving a proxy,
 * connecting, sent with no answer, or answered).
 *
 * The net log is Chromium's, not a `webRequest` listener: one of those on a chord's session would send its every
 * request through main and switch off extensions' own rules there (requests.ts), changing what's being looked at.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, netLog } from 'electron';

type NetEvent = { time: string; type: number; phase: number; source: { id: number; type: number }; params?: Record<string, unknown> };
type NetLogFile = { constants: { logEventTypes: Record<string, number>; logEventPhase: Record<string, number> }; events: NetEvent[] };

let file: string | null = null;

/** Start recording (call once, before `ready`): only in a CI test build, where a stalled first page fails a test. */
export function recordNetLog(): void {
  if (app.isPackaged || !process.env['CI']) return;
  const dir = mkdtempSync(join(tmpdir(), 'chord-netlog-'));
  file = join(dir, 'net.json');
  void app.whenReady().then(() => netLog.startLogging(file!, { captureMode: 'default' }).catch(() => (file = null)));
  app.once('quit', () => rmSync(dir, { recursive: true, force: true }));
}

/** At most this many of the request's events are shown: the start and the end of a long one say where it stopped. */
const SHOWN = 40;

/** The events of `url`'s requests so far, one line each (`+ms TYPE begin|end`); the recording stops here. */
export async function requestEvents(url: string): Promise<string[]> {
  if (!file || !netLog.currentlyLogging) return ['(no net log: not a CI test build)'];
  await netLog.stopLogging();
  let log: NetLogFile;
  try {
    log = JSON.parse(readFileSync(file, 'utf8')) as NetLogFile;
  } catch (error) {
    return [`(the net log couldn't be read: ${error instanceof Error ? error.message : String(error)})`];
  }
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const phases = new Map(Object.entries(log.constants.logEventPhase).map(([name, id]) => [id, name.replace(/^PHASE_/, '').toLowerCase()]));
  const sources = new Set(log.events.filter((e) => e.params?.['url'] === url).map((e) => e.source.id));
  if (sources.size === 0) return [`no request for ${url} in the net log (${log.events.length} events in all): the navigation never asked the network`];
  const mine = log.events.filter((e) => sources.has(e.source.id));
  const t0 = Number(mine[0]!.time);
  const lines = mine.map((e) => {
    const phase = phases.get(e.phase);
    const error = e.params?.['net_error'];
    return `+${Number(e.time) - t0} ms  ${names.get(e.type) ?? e.type}${phase && phase !== 'none' ? ` ${phase}` : ''}${typeof error === 'number' ? ` (net_error ${error})` : ''}`;
  });
  const shown = lines.length <= SHOWN ? lines : [...lines.slice(0, SHOWN / 2), `… ${lines.length - SHOWN} more …`, ...lines.slice(-SHOWN / 2)];
  return [`the net log's events for ${url} (${sources.size} request${sources.size === 1 ? '' : 's'}), from the first:`, ...shown];
}
