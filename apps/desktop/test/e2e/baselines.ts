/**
 * Baselines for the performance checks whose numbers depend on the machine:
 * memory and launch (test/e2e/perf.spec.ts). Each CI runner's last
 * measurement is checked in (perf-baseline.json), and a run fails when a
 * number grows past it by more than its margin. Pure, so the spec, the update
 * command (scripts/perf-baseline.mjs) and the unit tests share it.
 * docs/testing/performance.md, "Baselines", says why the margins are what they are.
 */

/** One runner's numbers. */
export interface Baseline {
  /** Where they were measured: the Linux container, or a CI run. */
  from: string;
  /** When, as YYYY-MM-DD. */
  date: string;
  /** Warm launches to the sidebar, as a multiple of bare Electron's launch on the same machine (median). */
  launch?: number;
  /** Private memory at idle with one window and one page, MB, by process. */
  memoryMb?: Record<string, number>;
}

export type Baselines = Record<string, Baseline>;

/** What one run measured, as perf.json's `measured`: the baseline it would make. */
export interface Measured {
  runner: string;
  launch?: number;
  memoryMb?: Record<string, number>;
}

/** The command that takes new baselines; every failure names it. */
export const UPDATE_COMMAND = 'pnpm --filter @chord/desktop perf:baseline';

/**
 * How far past its baseline a number may go before the run fails: memory by
 * 15% or 5 MB, whichever is more, and launch by 25%. Each is several times
 * the run-to-run spread measured (docs/testing/performance.md).
 */
export const MARGIN = { memoryShare: 0.15, memoryMb: 5, launchShare: 0.25 } as const;

export const memoryLimit = (base: number): number => round(base + Math.max(base * MARGIN.memoryShare, MARGIN.memoryMb));
export const launchLimit = (base: number): number => round(base * (1 + MARGIN.launchShare), 100);

/**
 * Which baseline applies, or null where none can. Each CI runner has its own:
 * the OS and architecture, and on Linux the display server, as CI runs both.
 * The Linux container (scripts/e2e-linux, which sets CHORD_E2E_DISPLAY) is a
 * machine of its own, by how many CPUs it runs on. Anywhere else, and on
 * macOS, the numbers are only reported: Electron gives macOS's memory as a
 * resident set (shared pages and all), and CI's macOS machines are too busy
 * for steady launch times (the slowest run's warm launches took 1.2 to 1.6
 * times the fastest's).
 */
export function runnerKey(platform: string, arch: string, env: Record<string, string | undefined>, cpus: number): string | null {
  if (platform === 'darwin') return null;
  const runner = platform === 'linux' ? `linux-${arch}-${env['WAYLAND_DISPLAY'] ? 'wayland' : 'x11'}` : `${platform}-${arch}`;
  if (env['CI']) return runner;
  if (env['CHORD_E2E_DISPLAY']) return `${runner}, container, ${cpus} CPUs`;
  return null;
}

/** The failure: what grew, from what to what, past which limit, and how to take a new baseline when it's meant to. */
export function grew(what: string, value: number, base: number, limit: number, unit: string): string {
  const change = value - base;
  return (
    `${what} grew from ${base} to ${round(value, 100)} ${unit} (+${round(change, 100)} ${unit}, +${Math.round((100 * change) / base)}%), ` +
    `past its limit of ${limit} ${unit}. If that's intended, take a new baseline: ${UPDATE_COMMAND} (docs/testing/performance.md, "Baselines").`
  );
}

/** perf-baseline.json with a run's numbers in: its runner's entry takes what the run measured and keeps the rest; other runners are untouched. */
export function withMeasured(baselines: Baselines, measured: Measured, from: string, date: string): Baselines {
  const { runner, launch, memoryMb } = measured;
  const entry: Baseline = { ...baselines[runner], from, date };
  if (launch !== undefined) entry.launch = launch;
  if (memoryMb) entry.memoryMb = memoryMb;
  return Object.fromEntries(Object.entries({ ...baselines, [runner]: entry }).sort(([a], [b]) => a.localeCompare(b)));
}

function round(n: number, by = 10): number {
  return Math.round(n * by) / by;
}
