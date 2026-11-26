/**
 * The authoritative state (ARCHITECTURE.md §6.2). Commands go through the
 * shared reducer; listeners receive the patches (for renderer mirrors and
 * persistence) and the effects (for real views).
 */
import { apply, uuidv7, type Command, type Effect, type State } from '@chord/core';
import { freeze, type Patch } from 'immer';

export interface Change {
  state: State;
  /** The state before it: what a list written whole (the themes) had, so what was taken out of it is known. */
  before: State;
  patches: Patch[];
  effects: Effect[];
  /** What made it: persistence saves another computer's changes (`sync.apply`) marked as sync's. */
  command?: Command;
}

export class Store {
  private current: State;
  private readonly listeners = new Set<(change: Change) => void>();
  /** The one listener that runs before every other (setBeforeEffects). */
  private beforeEffects: ((change: Change) => void) | null = null;

  constructor(initial: State) {
    // Frozen, as every state after it is (Immer freezes what it makes): the nodes' index is kept only for a state that can't change (core's nodes.ts).
    this.current = freeze(initial, true);
  }

  get state(): State {
    return this.current;
  }

  dispatch(command: Command): void {
    const result = apply(this.current, command, { now: Date.now(), newId: () => uuidv7() });
    if (result.patches.length === 0 && result.effects.length === 0) return;
    const before = this.current;
    this.current = result.state;
    const change: Change = { ...result, before, command };
    this.beforeEffects?.(change);
    for (const listener of this.listeners) listener(change);
  }

  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The one listener that runs before every other, whenever it was set: what the effects depend on (#328: sessions
   * follow the settings, their proxy first, before Browser's effects make a tab's view and load its page). Only one,
   * so nothing else can come before it (Opus's SF1, round 1 of #332): setting a second throws.
   *
   * It runs inside dispatch, before the rest: if it throws, the change has already been made but reaches no other
   * listener (no effects run, nothing is sent or saved), and the throw goes to whoever dispatched.
   */
  setBeforeEffects(listener: (change: Change) => void): () => void {
    if (this.beforeEffects) throw new Error('The store’s before-effects listener is set already');
    this.beforeEffects = listener;
    return () => {
      if (this.beforeEffects === listener) this.beforeEffects = null;
    };
  }
}
