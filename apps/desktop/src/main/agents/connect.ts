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
import { sameProgram, type ProcessInfo } from './parent';

/**
 * A program an allowance can be kept by: not Chord itself (anything that starts `Chord.exe mcp` would be it), nor a
 * path the lookup couldn't read right (U+FFFD; on Windows also `?`, which no Windows path holds: a profile folder like
 * José's read in another code page, #264), which could be anyone's.
 */
export function keepable(path: string | null | undefined, platform: NodeJS.Platform = process.platform): path is string {
  if (!path || path.includes('\uFFFD') || (platform === 'win32' && path.includes('?'))) return false;
  return !sameProgram(path, process.execPath);
}

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

/** A path as the OS compares it: case aside on Windows and macOS, never on Linux; null with any `..` in it. */
function comparable(path: string, platform: NodeJS.Platform): string | null {
  const slashes = platform === 'win32' ? path.replace(/\\/g, '/') : path;
  const norm = platform === 'win32' || platform === 'darwin' ? slashes.toLowerCase() : slashes;
  return /(^|\/)\.\.(\/|$)/.test(norm) ? null : norm;
}

/** The Antigravity app's install root, if `path` is its main executable: `<dir>` on Windows and Linux, the `.app` bundle on macOS. */
function antigravityApp(path: string, platform: NodeJS.Platform): string | null {
  const p = comparable(path, platform);
  if (!p) return null;
  const root = platform === 'darwin' ? /^(\/.+\/antigravity\.app)\/contents\/macos\/[^/]+$/.exec(p) : platform === 'win32' ? /^(.+)\/antigravity\.exe$/.exec(p) : /^(\/.+)\/antigravity$/.exec(p);
  return root?.[1] ?? null;
}

/** macOS: the bundle a helper app of Antigravity's runs from (`Contents/Frameworks/Antigravity Helper*.app`), its extension host. */
function antigravityHelperApp(path: string): string | null {
  const p = comparable(path, 'darwin');
  return (p && /^(\/.+\/antigravity\.app)\/contents\/frameworks\/antigravity helper[^/]*\.app\/contents\/macos\/[^/]+$/.exec(p)?.[1]) ?? null;
}

/**
 * Whether a helper lies where Antigravity ships its language server, under `root`: `resources/bin/` or, as VS Code
 * forks ship an extension's, `resources/app/extensions/antigravity/bin/` (Windows, Linux); the bundle's
 * `Contents/Resources/` (macOS).
 */
function inAntigravity(helper: string, root: string, platform: NodeJS.Platform): boolean {
  const h = comparable(helper, platform);
  if (!h) return false;
  if (platform === 'darwin') return h.startsWith(`${root}/contents/resources/`);
  return h.startsWith(`${root}/resources/bin/`) || h.startsWith(`${root}/resources/app/extensions/antigravity/bin/`);
}

/**
 * The program that started it, as the card names it and Always allow keeps it: the bridge's parent; or, when that is
 * Antigravity's `language_server_*` helper, the Antigravity app itself: the next ancestor, if it's the app (by name
 * and each OS's layout), or on macOS the one after a helper app inside the same bundle (its extension host). Any
 * other process that calls itself so (a child of Claude Code or Codex, say) is named as itself, and can't borrow an
 * agent's Always allow. The layouts are what VS Code forks ship, not yet checked against a real Antigravity; the
 * parent stays a hint, never an identity (S18 §3).
 */
export function startedByOf(chain: readonly ProcessInfo[], platform: NodeJS.Platform = process.platform): ProcessInfo | null {
  const [first, next, third] = chain;
  if (!first) return null;
  if (!/^language_server/i.test(first.name ?? '') || !first.path || !next?.path) return first;
  const app = antigravityApp(next.path, platform);
  if (app && inAntigravity(first.path, app, platform)) return next;
  if (platform === 'darwin' && third?.path) {
    const host = antigravityHelperApp(next.path);
    if (host && antigravityApp(third.path, 'darwin') === host && inAntigravity(first.path, host, 'darwin')) return third;
  }
  return first;
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
    // An agent you've let in for good by that name: who started it decides, so Chord looks first (a few ms on Windows,
    // window-owner.exe's process snapshot; ps and lsof, or /proc, elsewhere).
    if (known) {
      const path = (await looked)?.path;
      const allowed = keepable(path) ? this.allowance(who.name, path) : null;
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
            // Kept only with the program that started it (looked up by now, or as soon as it is). With none to keep it
            // by, nothing is kept and it's let in this once (the card stops offering Always allow once it knows).
            void (async () => {
              const parent = entry.parent ?? (await entry.looked);
              const kept = keepable(parent?.path) ? this.keep(who.name, parent.path, profileId) : null;
              resolve(kept ? { grant: 'always', profileId, allowedParent: kept } : { grant: 'once', profileId });
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
        if (!this.waiting.has(id)) return;
        entry.parent = parent;
        const name = parent?.name ? plain(parent.name).slice(0, 100) : '';
        // No program it can be kept by: the card says Chord can't tell, and offers no Always allow.
        entry.card = keepable(parent?.path) && name ? { ...entry.card, startedBy: name } : { ...entry.card, startedBy: null, noProgram: true };
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
    this.deps.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: [...others, { name, parent, profileId, allowedAt: before?.allowedAt ?? now, lastUsedAt: now, ...(before?.actSites ? { actSites: before.actSites } : {}) }] } });
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
