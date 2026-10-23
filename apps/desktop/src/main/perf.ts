/**
 * Launch timing for the performance budgets (ARCHITECTURE.md §1, §15.5).
 *
 * Main's first import, with no imports of its own, so `mainEntry` is read
 * before any other module of Chord's runs. Each mark is one clock read;
 * end-to-end tests read them through `chordTestHooks.launch()`
 * (test/e2e/perf.spec.ts). Times are epoch milliseconds
 * (`performance.timeOrigin + performance.now()`), the clock the renderers'
 * timestamps use too.
 */

const now = (): number => performance.timeOrigin + performance.now();

export type LaunchMark =
  /** The first line of Chord's main process ran. */
  | 'mainEntry'
  /** Electron is ready: windows can be made. */
  | 'ready'
  /** chord-data has read the saved session. */
  | 'restored'
  /** The first browser window exists, hidden while its shell loads. */
  | 'windowCreated'
  /** The first shell's page has loaded (its scripts may still be starting). */
  | 'shellLoaded'
  /** The first window is on screen. */
  | 'windowShown'
  /** The first shell's sidebar is in the DOM with its handlers attached; it paints at the next frame. */
  | 'shellReady'
  /** The first shell painted a frame with a working sidebar: the window is usable. */
  | 'shellPainted';

const marks: Partial<Record<LaunchMark, number>> = { mainEntry: now() };

/** The first time each milestone is reached; later windows don't move it. */
export function markLaunch(mark: LaunchMark): void {
  marks[mark] ??= now();
}

/** Every mark so far, plus when the process started (Node's time origin). */
export function launchTimings(): Partial<Record<LaunchMark | 'processStart', number>> {
  return { processStart: performance.timeOrigin, ...marks };
}

/** Epoch milliseconds, for timestamps sent to the renderers (the command bar measures its opening from one). */
export const epochNow = now;
