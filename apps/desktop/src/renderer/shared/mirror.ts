/**
 * A renderer's mirror of main's state (ARCHITECTURE.md §6.2): a snapshot,
 * then Immer patches. A version gap triggers a fresh snapshot.
 */
import type { State } from '@chord/core';
import type { StatePatchEvent, StateSnapshot } from '@chord/ipc';
import { applyPatches, enablePatches, type Patch } from 'immer';
import { useSyncExternalStore } from 'react';

enablePatches();

interface StateSource {
  snapshot(): Promise<StateSnapshot>;
  onPatch(listener: (event: StatePatchEvent) => void): () => void;
}

export interface Mirror {
  readonly windowId: string;
  get(): State;
  subscribe(listener: () => void): () => void;
}

export async function createMirror(source: StateSource): Promise<Mirror> {
  const listeners = new Set<() => void>();
  let state: State;
  let pending: StatePatchEvent[] = [];
  let syncing = true;

  const resync = async () => {
    syncing = true;
    const snap = await source.snapshot();
    state = snap.state;
    // Patches that arrived while the snapshot was in flight may be newer.
    for (const event of pending) if (event.version > state.version) state = applyPatches(state, event.patches as Patch[]);
    pending = [];
    syncing = false;
    for (const l of listeners) l();
    return snap.windowId;
  };

  source.onPatch((event) => {
    if (syncing) {
      pending.push(event);
      return;
    }
    // Every change bumps the version by exactly one; anything else means we missed one.
    if (event.version !== state.version + 1) {
      void resync();
      return;
    }
    state = applyPatches(state, event.patches as Patch[]);
    for (const l of listeners) l();
  });

  const windowId = await resync();
  return {
    windowId,
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useMirror(mirror: Mirror): State {
  return useSyncExternalStore(mirror.subscribe, mirror.get);
}
