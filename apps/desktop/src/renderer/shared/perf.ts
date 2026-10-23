/**
 * Timing for the performance budgets (ARCHITECTURE.md §1), as User Timing
 * entries: they cost a clock read and a frame callback, show in DevTools'
 * Performance panel, and test/e2e/perf.spec.ts reads them with
 * `performance.getEntriesByName`.
 */

/**
 * Calls `then` once the next frame has been painted: from that frame's
 * requestAnimationFrame, a task queued behind its rendering. `frameAt` is when
 * the frame began (its rAF ran). A hidden page paints nothing, so this waits
 * until it's shown.
 */
export function afterNextPaint(then: (frameAt: number) => void): void {
  requestAnimationFrame(() => {
    const frameAt = performance.now();
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      then(frameAt);
    };
    channel.port2.postMessage(null);
  });
}

/** Converts epoch milliseconds (main's clock for requests) to this page's clock. */
export const fromEpoch = (epochMs: number): number => epochMs - performance.timeOrigin;

/**
 * A measure from `start` (this page's clock) to now, with `detail` for what
 * the budget also checks. Old ones are dropped, so the buffer stays small.
 */
export function measureSince(name: string, start: number, detail: Record<string, unknown>): void {
  if (performance.getEntriesByName(name, 'measure').length >= 200) performance.clearMeasures(name);
  performance.measure(name, { start: Math.max(0, start), end: performance.now(), detail });
}

/** How many marks of one name are kept before the oldest go; a measured step never makes this many. */
const MAX_MARKS = 500;
let markCount = 0;

/**
 * A mark each time the shell's App commits (`chord:shell-render`): the perf
 * spec counts them per frame, since a frame should hold at most one. The
 * buffer is emptied now and then, so it stays small.
 */
export function markRender(): void {
  if (++markCount > MAX_MARKS) {
    performance.clearMarks('chord:shell-render');
    markCount = 1;
  }
  performance.mark('chord:shell-render');
}
