/**
 * A call into a page's renderer (`executeJavaScript`, `capturePage` and the
 * like) never settles while that renderer hangs. Main's own logic never waits
 * on one without a limit: past it, the caller gets its fallback and goes on
 * (ARCHITECTURE.md §1, performance rule 1). No Electron imports, so it's
 * unit-testable.
 */

/** Long enough for a busy page to answer, short enough that a hung one doesn't hold anything up. */
export const PAGE_CALL_MS = 2000;

/** `call`'s value, or `fallback` if it fails or takes longer than `ms`. */
export function pageCall<T>(call: Promise<T>, fallback: T, ms = PAGE_CALL_MS): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
