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
 * in without a card; once they're gone, it asks again. Without the program
 * (the lookup failed) nothing is kept: a name alone never lets anything in.
 *
 * Everything on the card but its buttons comes from the agent or the OS, so it
 * is shown only as plain, bounded text: no control or bidi characters, and a
 * folder only if it is an absolute path.
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
  /** Always allowed (now or before): the program its allowance is kept by, so Remove ends only that one. */
  allowedParent?: string | null;
}

export interface ConnectCardsDeps {
  store: { readonly state: State; dispatch(command: Command): void };
  /** The window used last (never a private one), where the card goes; null while there's none. */
  lastWindow(): WindowId | null;
  /** The cards changed: windows' popovers show them again. */
  changed(): void;
  now?(): number;
}

interface Waiting {
  card: AgentConnectCard;
  /** Where it shows; null while there's no normal window (it waits for one). */
  windowId: WindowId | null;
  /** The program that started it, once looked up. */
  parent: ProcessInfo | null;
  looked: Promise<ProcessInfo | null>;
  answer(answer: 'deny' | 'once' | 'always', windowId: WindowId | null): void;
}

/** How long Chord waits on the lookup before it decides whether an agent it knows may come in. */
const LOOKUP_MS = 5000;
/** The longest folder the card shows; longer ones lose their middle. */
const FOLDER_MAX = 120;

/** The folder a program is installed in: its app bundle on macOS (`…/Antigravity.app`), else its own folder. */
function installFolder(path: string): string {
  const bundle = /^(.*?\.app)[\\/]/i.exec(path);
  return (bundle ? bundle[1]! : path.replace(/[\\/][^\\/]*$/, '')).replace(/\\/g, '/').toLowerCase();
}

/** Whether `path` lies inside `folder` (its separators and, as on Windows and macOS, its case aside). */
const inside = (path: string, folder: string) => path.replace(/\\/g, '/').toLowerCase().startsWith(`${folder}/`);

/**
 * The program that started it, as the card names it and Always allow keeps it: the bridge's parent, or, past a
 * helper the agent runs its tools from (Antigravity's `language_server_*`, reportedly), the app behind it. Only a
 * helper inside that app's own install folder is passed: a program anywhere else that calls itself so is named as
 * itself, and can't borrow the app's Always allow.
 */
export function startedByOf(chain: readonly ProcessInfo[]): ProcessInfo | null {
  const [first, next] = chain;
  if (!first) return null;
  const helper = /^language_server/i.test(first.name ?? '') && first.path && next?.path && inside(first.path, installFolder(next.path));
  return helper ? next! : first;
}

const firstOf = (parent: Promise<ProcessInfo[]>): Promise<ProcessInfo | null> =>
  Promise.race([parent.then(startedByOf).catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_MS).unref?.())]);

/** Control and format characters (bidi overrides, zero-width joiners…): never shown from an agent or the OS. */
const UNSAFE = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_ALL = /[\p{Cc}\p{Cf}]/gu;

/** Text from outside, as plain text: those characters dropped. */
export const plain = (text: string): string => text.replace(UNSAFE_ALL, '');

/**
 * The folder line's folder: an absolute path (`/…`, `C:\…`, `\\server\…`) with nothing hidden in it, its middle
 * dropped past FOLDER_MAX; null for anything else (the card then says "an unknown folder").
 */
export function cardFolder(folder: string): string | null {
  if (!folder || UNSAFE.test(folder)) return null;
  if (!/^(\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(folder)) return null;
  const chars = [...folder];
  if (chars.length <= FOLDER_MAX) return folder;
  const half = (FOLDER_MAX - 1) / 2;
  return `${chars.slice(0, Math.ceil(half)).join('')}…${chars.slice(chars.length - Math.floor(half)).join('')}`;
}

/** A program's path with its version folders as `*` (…/versions/2.1.3/claude, …/versions/2.1.3): an update is the same program. */
export function unversioned(path: string): string {
  return path
    .split(/([\\/])/)
    .map((part) => (/^v?\d+(\.\d+)+([-+.][0-9A-Za-z.-]+)?$/.test(part) ? '*' : part))
    .join('');
}

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

  /**
   * The agent let in for good, if it is: the same name, the same program (an update in a versioned install folder is
   * the same program, as `keep` counts it), sign-ins that still exist.
   */
  private allowance(name: string, parent: string): AgentAllowance | null {
    const state = this.deps.store.state;
    const program = unversioned(parent);
    return state.settings.agentsAllowed.find((a) => a.name === name && (a.parent === parent || unversioned(a.parent) === program) && signInsExist(state, a.profileId)) ?? null;
  }

  /** Ask (or not, for an agent let in for good). Taken down when `signal` aborts (Stop, the agent going): a no. */
  async ask(who: ConnectingAgent, signal: AbortSignal): Promise<ConnectAnswer> {
    const known = this.deps.store.state.settings.agentsAllowed.some((a) => a.name === who.name);
    const looked = firstOf(who.parent);
    // An agent you've let in for good by that name: who started it decides, so Chord looks first (about 1 s on Windows).
    if (known) {
      const path = (await looked)?.path;
      const allowed = path ? this.allowance(who.name, path) : null;
      if (allowed) {
        this.touch(allowed);
        return { grant: 'always', profileId: allowed.profileId, allowedParent: allowed.parent };
      }
    }
    if (signal.aborted) return { grant: 'deny', profileId: null };
    return new Promise<ConnectAnswer>((resolve) => {
      const id = randomBytes(8).toString('hex');
      const folder = cardFolder(who.folder);
      const entry: Waiting = {
        card: { id, name: plain(who.name), folder, startedBy: null },
        // No normal window yet: it waits for one (the call says *waiting* after 45 s, and the card stays).
        windowId: this.deps.lastWindow(),
        parent: null,
        looked,
        answer: (answer, answeredIn) => {
          if (!this.waiting.delete(id)) return;
          signal.removeEventListener('abort', onAbort);
          this.deps.changed();
          if (answer === 'deny' || !answeredIn) return resolve({ grant: 'deny', profileId: null });
          const state = this.deps.store.state;
          const profileId = state.chords[state.windows[answeredIn]?.activeChordId ?? '']?.profileId ?? null;
          if (answer === 'always' && profileId) {
            // Kept only with the program that started it (looked up by now, or as soon as it is).
            void (async () => {
              const parent = entry.parent ?? (await entry.looked);
              const kept = parent?.path ? this.keep(who.name, parent.path, profileId) : null;
              resolve({ grant: answer, profileId, allowedParent: kept });
            })();
            return;
          }
          resolve({ grant: answer, profileId });
        },
      };
      const onAbort = () => entry.answer('deny', entry.windowId);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, entry);
      this.deps.changed();
      // Who started it, as soon as it's known.
      void looked.then((parent) => {
        if (!this.waiting.has(id) || !parent) return;
        entry.parent = parent;
        const name = parent.name ? plain(parent.name).slice(0, 100) : '';
        if (!name) return;
        entry.card = { ...entry.card, startedBy: name };
        this.deps.changed();
      });
    });
  }

  /**
   * Always allow: kept with this program and those sign-ins. It takes the place of the same agent's row for the
   * same program, or for that program at another version (Claude Code updates into …/versions/<version>), so an
   * update doesn't add a row. Returns the program it's kept by.
   */
  private keep(name: string, parent: string, profileId: ProfileId): string {
    const now = this.now();
    const same = (a: AgentAllowance) => a.name === name && (a.parent === parent || unversioned(a.parent) === unversioned(parent));
    const list = this.deps.store.state.settings.agentsAllowed;
    const before = list.find(same);
    const others = list.filter((a) => !same(a));
    this.deps.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [...others, { name, parent, profileId, allowedAt: before?.allowedAt ?? now, lastUsedAt: now }] } });
    return parent;
  }

  private touch(allowed: AgentAllowance): void {
    const list = this.deps.store.state.settings.agentsAllowed.map((a) => (a === allowed ? { ...a, lastUsedAt: this.now() } : a));
    this.deps.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: list } });
  }

  /** The card a window shows: the oldest waiting there. A card waiting for a window goes to this one if it's the one used last. */
  cardFor(windowId: WindowId): AgentConnectCard | null {
    for (const entry of this.waiting.values()) if (entry.windowId === windowId) return entry.card;
    if (this.deps.lastWindow() === windowId) {
      for (const entry of this.waiting.values()) {
        if (entry.windowId) continue;
        entry.windowId = windowId;
        return entry.card;
      }
    }
    return null;
  }

  /** A normal window came to the front: cards waiting for one show there. */
  windowFocused(windowId: WindowId): void {
    let moved = false;
    for (const entry of this.waiting.values()) {
      if (entry.windowId) continue;
      entry.windowId = windowId;
      moved = true;
    }
    if (moved) this.deps.changed();
  }

  /** Your answer, from the card in that window's popover (only that window's card). */
  answer(id: string, answer: 'deny' | 'once' | 'always', windowId: WindowId): void {
    const entry = this.waiting.get(id);
    if (entry && entry.windowId === windowId) entry.answer(answer, windowId);
  }

  /** A window closed: its cards go to the window used last, or wait for a normal window (never a no on their own). */
  windowClosed(windowId: WindowId): void {
    const to = this.deps.lastWindow();
    for (const entry of this.waiting.values()) if (entry.windowId === windowId) entry.windowId = to && to !== windowId ? to : null;
    this.deps.changed();
  }
}
