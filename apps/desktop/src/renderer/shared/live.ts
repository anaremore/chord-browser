/**
 * A value main keeps a renderer up to date with: system info, the popover's
 * cards, the Settings and archive snapshots. The subscription starts before
 * the first fetch and is never torn down, so nothing main sends after it has
 * answered can be missed, not even while React is still mounting. (Fetching
 * first and subscribing in an effect lost messages sent in between: a
 * permission prompt raised during startup never showed.)
 *
 * Main's messages keep their order among themselves, but not against the
 * fetch's answer, which comes back on another pipe: a message main sent after
 * answering can arrive first. So once any message has arrived, the answer is
 * dropped. Main sends one on every change, each with the whole value, so the
 * last message is never older than the last change.
 */
import { useSyncExternalStore } from 'react';

export interface Live<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export async function live<T>(fetch: () => Promise<T>, onChange: (listener: (value: T) => void) => () => void): Promise<Live<T>> {
  const listeners = new Set<() => void>();
  let value: T | undefined;
  let sent = false;
  let ready = false;
  onChange((next) => {
    value = next;
    sent = true;
    if (ready) for (const listener of listeners) listener();
  });
  const answer = await fetch();
  if (!sent) value = answer;
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
