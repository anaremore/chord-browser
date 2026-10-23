/**
 * A value main keeps a renderer up to date with: system info, the popover's
 * cards, the Settings and archive snapshots. The subscription starts before
 * the first fetch and is never torn down, so nothing main sends after it has
 * answered can be missed, not even while React is still mounting. (Fetching
 * first and subscribing in an effect lost messages sent in between: a
 * permission prompt raised during startup never showed.) A message that
 * arrives before the answer is older than it, since IPC keeps order, so the
 * answer replaces it.
 */
import { useSyncExternalStore } from 'react';

export interface Live<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export async function live<T>(fetch: () => Promise<T>, onChange: (listener: (value: T) => void) => () => void): Promise<Live<T>> {
  const listeners = new Set<() => void>();
  let value: T | undefined;
  let ready = false;
  onChange((next) => {
    value = next;
    if (ready) for (const listener of listeners) listener();
  });
  value = await fetch();
  ready = true;
  return {
    get: () => value as T,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useLive<T>(source: Live<T>): T {
  return useSyncExternalStore(source.subscribe, source.get);
}
