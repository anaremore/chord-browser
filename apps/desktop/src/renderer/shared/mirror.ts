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

export interface MirrorOptions {
  /**
   * When subscribers hear of a change. Patches apply as they arrive, so
   * `get()` is always current; the shell tells React once a frame
   * (shared/frames.ts), however many patches came in it. By default, at once.
   */
  notify?: (tell: () => void) => void;
}

export async function createMirror(source: StateSource, { notify = (tell) => tell() }: MirrorOptions = {}): Promise<Mirror> {
  const listeners = new Set<() => void>();
  let state: State;
  let pending: StatePatchEvent[] = [];
  let syncing = true;
  let told = true;

  const tell = () => {
    told = true;
    for (const l of listeners) l();
  };
  const changed = () => {
    if (!told) return;
    told = false;
    notify(tell);
  };

  const resync = async () => {
    syncing = true;
    const snap = await source.snapshot();
    state = snap.state;
    // Patches that arrived while the snapshot was in flight may be newer.
    for (const event of pending) if (event.version > state.version) state = applyPatches(state, event.patches as Patch[]);
    pending = [];
    syncing = false;
    changed();
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
    changed();
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
