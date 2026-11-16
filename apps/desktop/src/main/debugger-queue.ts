/**
 * One piece of debugger work at a time per page. Chord's clients (page_diagnostics,
 * screenshots) each attach `webContents.debugger` and detach when done; two at once
 * would detach each other mid-work. Every use goes through here. Each piece of work
 * must settle on its own (bounded with pageCall), or the page's queue stops.
 * No Electron imports, so it's unit-testable.
 */
const queues = new WeakMap<object, Promise<unknown>>();

export function withDebugger<T>(contents: object, work: () => Promise<T>): Promise<T> {
  const before = queues.get(contents) ?? Promise.resolve();
  const run = before.then(work, work);
  queues.set(
    contents,
    run.catch(() => undefined),
  );
  return run;
}
