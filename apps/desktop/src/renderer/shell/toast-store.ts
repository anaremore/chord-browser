/**
 * The toasts on screen in this window (DESIGN.md §7.5). The store listens
 * from the moment the shell starts, so a toast main sends while React is
 * still mounting isn't lost. The docked sidebar and the minimal bar show the
 * same toasts, so collapsing the sidebar doesn't drop one mid-read.
 */
import type { Toast } from '@chord/ipc';
import { useSyncExternalStore } from 'react';

/** At most this many at once; older ones give way. */
const MAX_TOASTS = 3;

export interface ToastStore {
  get(): Toast[];
  subscribe(listener: () => void): () => void;
  dismiss(id: string): void;
}

export function createToastStore(onShow: (listener: (toast: Toast) => void) => () => void): ToastStore {
  const listeners = new Set<() => void>();
  let toasts: Toast[] = [];
  const set = (next: Toast[]) => {
    toasts = next;
    for (const listener of listeners) listener();
  };
  // The same toast again (deleting twice) replaces the old one rather than stacking.
  onShow((toast) => set([toast, ...toasts.filter((t) => t.id !== toast.id)].slice(0, MAX_TOASTS)));
  return {
    get: () => toasts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: (id) => set(toasts.filter((t) => t.id !== id)),
  };
}

export function useToasts(store: ToastStore): Toast[] {
  return useSyncExternalStore(store.subscribe, store.get);
}
