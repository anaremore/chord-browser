/**
 * One render a frame (DESIGN.md §6.7). Main's state patches arrive as
 * separate IPC messages, each its own task: a tab switch sends several, and
 * rendering each one would render the shell two or three times inside one
 * frame. Work queued here runs together at the start of the next frame, in
 * one requestAnimationFrame callback, so React renders it once. That's the
 * frame it would have been painted in anyway: nothing on screen waits.
 *
 * A hidden page paints no frames, so its work runs at once. A page that's
 * visible but gets no frame (a covered window) runs it after `NO_FRAME_MS`.
 */

const NO_FRAME_MS = 100;

const queue: (() => void)[] = [];
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Run `work` at the start of the next frame, with everything else queued for it, in order. */
export function nextFrame(work: () => void): void {
  queue.push(work);
  if (document.visibilityState !== 'visible') return flush();
  if (frame) return;
  frame = requestAnimationFrame(flush);
  timer = setTimeout(flush, NO_FRAME_MS);
}

function flush(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  clearTimeout(timer);
  timer = undefined;
  for (const work of queue.splice(0)) {
    try {
      work();
    } catch (error) {
      // One failure mustn't hold back the rest of the frame's work.
      reportError(error);
    }
  }
}

// Going hidden, the frame never comes: run what's waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && queue.length > 0) flush();
});
