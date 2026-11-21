/**
 * The connect card (S18 M1d; mocks/agents-s18-m1.html §1): an outside agent's
 * first call asks you, in the window you used last, centered at the top of its
 * page, in its popover, which never takes the keyboard. "<client> wants to use
 * Chord", who started it ("Started by claude.exe in <folder>." once Chord has
 * looked, "Started in <folder>." until then or if it can't tell), what it may
 * do, and Deny (or ×), Allow once, Always allow.
 *
 * Always allow keeps the agent by the name it gives and the program that
 * started it (hints, never proof: S18 §3), with the sign-ins of the window you
 * answered in. While those sign-ins still exist, its next connections are let
 * in without a card; once they're gone, it asks again.
 */
import { randomBytes } from 'node:crypto';
import { sortedChords, type AgentAllowance, type Command, type Grant, type ProfileId, type State, type WindowId } from '@chord/core';
import type { AgentConnectCard } from '@chord/ipc';
import type { ProcessInfo } from './parent';

/** Who's asking: what its connection says, and the lookup of who started it (running while the card shows). */
export interface ConnectingAgent {
  name: string;
  /** The folder its client runs in (the agent's own, sent with its hello). */
  folder: string;
  parent: Promise<ProcessInfo[]>;
}

export interface ConnectAnswer {
  grant: Grant;
  /** The sign-ins its chord gets: those of the window you answered in, or the ones it was let in with for good. */
  profileId: ProfileId | null;
}

export interface ConnectCardsDeps {
  store: { readonly state: State; dispatch(command: Command): void };
  /** The window used last (never a private one), where the card goes. */
  lastWindow(): WindowId | null;
  /** The cards changed: windows' popovers show them again. */
  changed(): void;
  now?(): number;
}

interface Waiting {
  card: AgentConnectCard;
  windowId: WindowId;
  /** The program that started it, once looked up. */
  parent: ProcessInfo | null;
  looked: Promise<ProcessInfo | null>;
  answer(answer: 'deny' | 'once' | 'always', windowId: WindowId): void;
}

/** How long Chord waits on the lookup before it decides whether an agent it knows may come in. */
const LOOKUP_MS = 5000;

const firstOf = (parent: Promise<ProcessInfo[]>): Promise<ProcessInfo | null> =>
  Promise.race([parent.then((chain) => chain[0] ?? null).catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_MS).unref?.())]);

/** Sign-ins that still exist: one of your chords (not a private window's, not an agent's) uses them. */
export function signInsExist(state: State, profileId: ProfileId): boolean {
  return sortedChords(state).some((c) => c.profileId === profileId);
}

export class ConnectCards {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly deps: ConnectCardsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The agent let in for good, if it is: the same name, the same program, sign-ins that still exist. */
  private allowance(name: string, parent: string | null): AgentAllowance | null {
    const state = this.deps.store.state;
    return state.settings.agentsAllowed.find((a) => a.name === name && a.parent === parent && signInsExist(state, a.profileId)) ?? null;
  }

  /** Ask (or not, for an agent let in for good). Taken down when `signal` aborts (Stop, the agent going): a no. */
  async ask(who: ConnectingAgent, signal: AbortSignal): Promise<ConnectAnswer> {
    const known = this.deps.store.state.settings.agentsAllowed.some((a) => a.name === who.name);
    const looked = firstOf(who.parent);
    // An agent you've let in for good by that name: who started it decides, so Chord looks first (about 1 s on Windows).
    if (known) {
      const allowed = this.allowance(who.name, (await looked)?.path ?? null);
      if (allowed) {
        this.touch(allowed);
        return { grant: 'always', profileId: allowed.profileId };
      }
    }
    if (signal.aborted) return { grant: 'deny', profileId: null };
    const windowId = this.deps.lastWindow();
    if (!windowId) return { grant: 'deny', profileId: null };
    return new Promise<ConnectAnswer>((resolve) => {
      const id = randomBytes(8).toString('hex');
      const entry: Waiting = {
        card: { id, name: who.name, folder: who.folder.slice(0, 500), startedBy: null },
        windowId,
        parent: null,
        looked,
        answer: (answer, answeredIn) => {
          if (!this.waiting.delete(id)) return;
          signal.removeEventListener('abort', onAbort);
          this.deps.changed();
          if (answer === 'deny') return resolve({ grant: 'deny', profileId: null });
          const state = this.deps.store.state;
          const profileId = state.chords[state.windows[answeredIn]?.activeChordId ?? '']?.profileId ?? null;
          if (answer === 'always' && profileId) void this.keep(who.name, entry, profileId);
          resolve({ grant: answer, profileId });
        },
      };
      const onAbort = () => entry.answer('deny', windowId);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, entry);
      this.deps.changed();
      // Who started it, as soon as it's known.
      void looked.then((parent) => {
        if (!this.waiting.has(id) || !parent?.name) return;
        entry.parent = parent;
        entry.card = { ...entry.card, startedBy: parent.name.slice(0, 100) };
        this.deps.changed();
      });
    });
  }

  /** Always allow: kept with the program that started it (looked up by now, or as soon as it is) and those sign-ins. */
  private async keep(name: string, entry: Waiting, profileId: ProfileId): Promise<void> {
    const parent = entry.parent ?? (await entry.looked);
    const now = this.now();
    const others = this.deps.store.state.settings.agentsAllowed.filter((a) => !(a.name === name && a.parent === (parent?.path ?? null)));
    this.deps.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [...others, { name, parent: parent?.path ?? null, profileId, allowedAt: now, lastUsedAt: now }] } });
  }

  private touch(allowed: AgentAllowance): void {
    const list = this.deps.store.state.settings.agentsAllowed.map((a) => (a === allowed ? { ...a, lastUsedAt: this.now() } : a));
    this.deps.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: list } });
  }

  /** The card a window shows: the oldest waiting there. */
  cardFor(windowId: WindowId): AgentConnectCard | null {
    for (const entry of this.waiting.values()) if (entry.windowId === windowId) return entry.card;
    return null;
  }

  /** Your answer, from the card in that window's popover (only that window's card). */
  answer(id: string, answer: 'deny' | 'once' | 'always', windowId: WindowId): void {
    const entry = this.waiting.get(id);
    if (entry && entry.windowId === windowId) entry.answer(answer, windowId);
  }

  /** A window closed: its cards go to the window used last, or are a no if there's none. */
  windowClosed(windowId: WindowId): void {
    const to = this.deps.lastWindow();
    for (const entry of [...this.waiting.values()]) {
      if (entry.windowId !== windowId) continue;
      if (to && to !== windowId) entry.windowId = to;
      else entry.answer('deny', windowId);
    }
    this.deps.changed();
  }
}
