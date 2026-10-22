/**
 * The authoritative state (ARCHITECTURE.md §6.2). Commands go through the
 * shared reducer; listeners receive the patches (for renderer mirrors and
 * persistence) and the effects (for real views).
 */
import { apply, uuidv7, type Command, type Effect, type State } from '@chord/core';
import type { Patch } from 'immer';

export interface Change {
  state: State;
  patches: Patch[];
  effects: Effect[];
}

export class Store {
  private current: State;
  private readonly listeners = new Set<(change: Change) => void>();

  constructor(initial: State) {
    this.current = initial;
  }

  get state(): State {
    return this.current;
  }

  dispatch(command: Command): void {
    const result = apply(this.current, command, { now: Date.now(), newId: () => uuidv7() });
    if (result.patches.length === 0 && result.effects.length === 0) return;
    this.current = result.state;
    for (const listener of this.listeners) listener(result);
  }

  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
