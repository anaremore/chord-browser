/**
 * Frame timing from a Chromium trace, for the shell's frame budget
 * (ARCHITECTURE.md §1, DESIGN.md §6.7).
 *
 * The Long Animation Frames API only reports frames over 50 ms, far above the
 * 16 ms (60 Hz) and 8 ms (120 Hz) budgets, and a LoAF's own duration counts
 * the idle wait for the next vsync. So each frame is measured from the trace
 * instead: Chromium marks every animation frame on a renderer's main thread
 * (`AnimationFrame`, from the first task after the last frame to the end of
 * rendering), and the frame's **work** is the main-thread task time inside it.
 * A frame spans every task since the last one, so on a slow display (a locked
 * Windows session paints to a ~55 Hz virtual one) more tasks land in each
 * frame than at 144 Hz: frame work is only comparable on the same display.
 * The longest single task is comparable anywhere (`longestTask`).
 */
import type { CDPSession, Page } from '@playwright/test';

export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  id2?: { local?: string; global?: string };
  args?: { name?: string; data?: Record<string, unknown> };
}

export interface Frame {
  /** Start, in ms from the first frame of the trace. */
  at: number;
  /** Main-thread task time inside the frame, ms. */
  work: number;
  /** The frame's span, first task to end of rendering (idle waits included), ms. */
  span: number;
  /** Where the work went, ms. `script` is everything that isn't style, layout or paint. */
  styleLayout: number;
  paint: number;
  script: number;
  /** The longest JS calls in the frame (DevTools' FunctionCall), for finding who did the work. */
  calls: { name: string; ms: number }[];
}

/** A renderer's main-thread events, in order. */
function mainThread(events: readonly TraceEvent[], pid: number): TraceEvent[] {
  const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain')?.tid;
  return main === undefined ? [] : events.filter((e) => e.pid === pid && e.tid === main).sort((a, b) => a.ts - b.ts);
}

/** Top-level tasks only: one nested in another (a nested run loop) is already counted. */
function topLevelTasks(mine: readonly TraceEvent[]): TraceEvent[] {
  const tasks: TraceEvent[] = [];
  for (const e of mine) {
    if (e.ph !== 'X' || e.name !== 'ThreadControllerImpl::RunTask' || e.dur === undefined) continue;
    const last = tasks.at(-1);
    if (last && e.ts < last.ts + last.dur!) continue;
    tasks.push(e);
  }
  return tasks;
}

/**
 * The longest single task on a renderer's main thread, ms. Unlike a frame's
 * work, this doesn't depend on how often the display asks for frames: a task
 * longer than 16 ms drops a frame at 60 Hz on any display.
 */
export function longestTask(events: readonly TraceEvent[], pid: number): { ms: number; calls: { name: string; ms: number }[] } {
  const mine = mainThread(events, pid);
  const longest = topLevelTasks(mine).reduce<TraceEvent | null>((a, t) => (!a || t.dur! > a.dur! ? t : a), null);
  if (!longest) return { ms: 0, calls: [] };
  const end = longest.ts + longest.dur!;
  const calls = mine
    .filter((e) => e.ph === 'X' && e.name === 'FunctionCall' && e.ts >= longest.ts && e.ts < end)
    .map((e) => ({ name: callName(e), ms: e.dur! / 1000 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  return { ms: longest.dur! / 1000, calls };
}

/** Top-level tasks on a renderer's main thread, and the frames they belong to. */
export function framesOf(events: readonly TraceEvent[], pid: number): Frame[] {
  const mine = mainThread(events, pid);
  const tasks = topLevelTasks(mine);
  const spans: { begin: number; end: number }[] = [];
  const open = new Map<string, number>();
  for (const e of mine) {
    if (e.name !== 'AnimationFrame') continue;
    const key = e.id2?.local ?? e.id2?.global ?? '';
    if (e.ph === 'b') open.set(key, e.ts);
    else if (e.ph === 'e' && open.has(key)) {
      spans.push({ begin: open.get(key)!, end: e.ts });
      open.delete(key);
    }
  }
  const timed = mine.filter((e) => e.ph === 'X' && e.dur !== undefined);
  const sum = (from: number, to: number, names: ReadonlySet<string>) =>
    timed.reduce((total, e) => (names.has(e.name) ? total + overlap(e.ts, e.ts + e.dur!, from, to) : total), 0) / 1000;
  const origin = spans[0]?.begin ?? 0;
  return spans.map(({ begin, end }) => {
    const work = tasks.reduce((total, t) => total + overlap(t.ts, t.ts + t.dur!, begin, end), 0) / 1000;
    const styleLayout = sum(begin, end, STYLE_LAYOUT);
    const paint = sum(begin, end, PAINT);
    const calls = timed
      .filter((e) => e.name === 'FunctionCall' && e.ts >= begin && e.ts < end)
      .map((e) => ({ name: callName(e), ms: e.dur! / 1000 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3);
    return { at: (begin - origin) / 1000, work, span: (end - begin) / 1000, styleLayout, paint, script: Math.max(0, work - styleLayout - paint), calls };
  });
}

/**
 * How often a renderer laid its page out, and how long that took in all, ms.
 * Resizing a page's view costs it a layout: moving it every frame of a
 * transition lays it out every frame (ARCHITECTURE.md §5, the frame snapshot).
 */
export function layoutsOf(events: readonly TraceEvent[], pid: number): { count: number; ms: number } {
  const layouts = mainThread(events, pid).filter((e) => e.ph === 'X' && e.name === 'Layout' && e.dur !== undefined);
  return { count: layouts.length, ms: layouts.reduce((total, e) => total + e.dur!, 0) / 1000 };
}

const STYLE_LAYOUT = new Set(['UpdateLayoutTree', 'Layout']);
const PAINT = new Set(['PrePaint', 'Paint', 'Layerize', 'Commit']);

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function callName(e: TraceEvent): string {
  const data = e.args?.data ?? {};
  const fn = typeof data['functionName'] === 'string' && data['functionName'] ? data['functionName'] : '(anonymous)';
  const url = typeof data['url'] === 'string' ? data['url'].split('/').pop() : '';
  return url ? `${fn} ${url}:${String(data['lineNumber'] ?? '?')}` : fn;
}

/** Records a trace of everything Chromium does while `run` runs (every process, through one page's DevTools session). */
export async function trace(cdp: CDPSession, run: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const collect = (e: { value: unknown[] }) => events.push(...(e.value as TraceEvent[]));
  cdp.on('Tracing.dataCollected', collect);
  const complete = new Promise<void>((done) => cdp.once('Tracing.tracingComplete', () => done()));
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['devtools.timeline', 'toplevel'] },
  });
  try {
    await run();
  } finally {
    await cdp.send('Tracing.end');
    await complete;
    cdp.off('Tracing.dataCollected', collect);
  }
  return events;
}

/**
 * Frame intervals while `run` runs: a requestAnimationFrame loop asks for
 * every frame, so a gap longer than the display's refresh interval is a
 * dropped frame. Unlike work, this depends on the display and on the screen
 * being on (a locked Windows session paints to a slow virtual display).
 */
export async function frameIntervals(page: Page, run: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __chordFrames?: { times: number[]; on: boolean } };
    const probe = { times: [] as number[], on: true };
    w.__chordFrames = probe;
    const step = (t: number) => {
      probe.times.push(t);
      if (probe.on) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await run();
  const times = await page.evaluate(() => {
    const probe = (window as unknown as { __chordFrames: { times: number[]; on: boolean } }).__chordFrames;
    probe.on = false;
    return probe.times;
  });
  return times.slice(1).map((t, i) => t - times[i]!);
}
