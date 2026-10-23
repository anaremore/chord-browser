/**
 * One render a frame (DESIGN.md §6.7). Main's state patches arrive as
 * separate IPC messages, each its own task: a tab switch sends several (and
 * the extensions bar and Duet follow with their own), and rendering each one
 * would render the shell two or three times inside one frame. Work queued
 * here runs together at the start of the next frame, in one
 * requestAnimationFrame callback, inside `batch` (the shell gives React's
 * `flushSync`, so it all renders once, there and then). That's the frame it
 * would have been painted in anyway: nothing on screen waits.
 *
 * A hidden page paints no frames, so its work runs at once. A page that's
 * visible but gets no frame (a covered window) runs it after `NO_FRAME_MS`.
 */

const NO_FRAME_MS = 100;

const queue: (() => void)[] = [];
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let batch = (run: () => void) => run();

/** How a frame's work runs together: the shell renders it in one React pass. */
export function batchFrames(wrap: (run: () => void) => void): void {
  batch = wrap;
}

/** Run `work` at the start of the next frame, with everything else queued for it, in order. */
export function nextFrame(work: () => void): void {
  queue.push(work);
  if (document.visibilityState !== 'visible') return flush();
  if (frame) return;
  frame = requestAnimationFrame(flush);
  timer = setTimeout(flush, NO_FRAME_MS);
}

/** `listener`, called with each value in the frame after it arrives. */
export const inNextFrame =
  <T>(listener: (value: T) => void) =>
  (value: T): void =>
    nextFrame(() => listener(value));

function flush(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  clearTimeout(timer);
  timer = undefined;
  const work = queue.splice(0);
  batch(() => {
    for (const run of work) {
      try {
        run();
      } catch (error) {
        // One failure mustn't hold back the rest of the frame's work.
        reportError(error);
      }
    }
  });
}

// Going hidden, the frame never comes: run what's waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && queue.length > 0) flush();
});

// A key or a click is handled against the newest state: what's waiting for the frame renders first,
// before the page's own listeners (React's included) see the event. Input never waits, nor acts on a stale frame.
for (const type of ['keydown', 'pointerdown', 'click'] as const) {
  window.addEventListener(
    type,
    () => {
      if (queue.length > 0) flush();
    },
    { capture: true },
  );
}
