/**
 * Latest wins: sends values one at a time, and while one is on its way keeps
 * only the newest to send next. A fast stream (a drag's boxes, one a frame)
 * never queues up behind a slow receiver: each send carries the latest value,
 * and the last value pushed is always the last one sent.
 */
export interface LatestWins<T> {
  push(value: T): void;
  /** Nothing on its way, and nothing waiting. */
  readonly idle: boolean;
}

export function latestWins<T>(send: (value: T) => Promise<unknown>): LatestWins<T> {
  let busy = false;
  let next: { value: T } | null = null;
  const pump = (): void => {
    if (!next) {
      busy = false;
      return;
    }
    const { value } = next;
    next = null;
    busy = true;
    // A failed send (the window closing) doesn't stop the ones after it.
    send(value).then(pump, pump);
  };
  return {
    push(value) {
      next = { value };
      if (!busy) pump();
    },
    get idle() {
      return !busy && !next;
    },
  };
}
