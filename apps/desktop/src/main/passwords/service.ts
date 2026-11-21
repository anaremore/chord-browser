/**
 * Chord's own passwords, main's side (docs/decisions/S17-passwords.md §5, §7,
 * §8). Main only routes and decides: chord-data holds the vault key and does
 * all sealing and opening (`@chord/data/passwords`), and main asks it for what
 * each step needs, keeping none of it. Main:
 *
 * - keeps the lock's clock: locked after every launch, and after *Lock after*
 *   unused (30 minutes unless you chose otherwise; *Never* allowed). *Lock
 *   now* locks until the passphrase is typed again, even with the key kept;
 * - keeps the key's second copy with the OS (`keys.ts`, safeStorage) for
 *   *Keep unlocked on this computer*, unwrapping it the first time it's
 *   needed, never at launch;
 * - asks for the passphrase again before *Show* and *Copy* once it was typed
 *   longer than 5 minutes ago (or never, this launch);
 * - puts a copied password on the clipboard and takes it off after a minute
 *   if it's still there (it remembers only its hash meanwhile);
 * - holds what Delete's Undo needs to name, this session;
 * - shows the unlock card in a window's popover, when something needs the
 *   vault open (the menu under the field, later), and answers it;
 * - is the API the menu under the field, the fill and the save cards call
 *   (`accountsFor`, `passwordForFill`, `candidate`, `save`, `never`): it
 *   matches on the page's origin as Chromium reports it, gives the menu
 *   usernames only, never saves from a private window or for a proxy, and
 *   follows the switch and the extension rule (S17 §11).
 *
 * Nothing here logs a value: failures are logged by what failed, never with
 * what was sent.
 */
import { createHash } from 'node:crypto';
import {
  lockAfterMs,
  loginProblem,
  PASSWORD_CLIPBOARD_MS,
  passphraseDue,
  passwordProfiles,
  passwordsOnIn,
  type InstalledExtension,
  type LoginSummary,
  type PasswordSettings,
  type WindowId,
} from '@chord/core';
import type * as Sites from '@chord/core/password-sites';
import type { LoginOffer } from '@chord/core/password-sites';
import type { PasswordOp, PasswordProblem, PasswordResult, VaultState } from '@chord/data';
import type { PasswordRevealResult, PasswordStepResult, PasswordsView, PasswordUnlockPrompt } from '@chord/ipc';

/** The OS's key store, through safeStorage (keys.ts). */
export interface PasswordKeys {
  /** Whether a key kept here would be protected: not Linux without a keyring (`basic_text`). */
  available(): Promise<boolean>;
  /** The key wrapped by the OS, as base64. */
  wrap(key: Uint8Array): Promise<string>;
  /** The key back; throws when the OS can't (another computer's copy, a keyring that's locked). */
  unwrap(blob: string): Promise<Uint8Array>;
}

export interface PasswordServiceOptions {
  /** chord-data's vault. Throws when chord-data can't answer. */
  data(op: PasswordOp): Promise<PasswordResult>;
  settings(): PasswordSettings;
  keys: PasswordKeys;
  clipboard: { writeText(text: string): void; readText(): string | Promise<string> };
  /** Something Settings or a popover shows changed: they ask again. */
  changed(): void;
  /** The vault locked: Settings hides any password it shows, without asking for its view again. */
  hide?(): void;
  /** The vault locked: what waits to be written into it (a generated password's confirmation) is dropped (phase 3A-2). */
  locked?(): void;
  /** A chord by id (its sign-ins' profile, whether it's a private window's), for the detector's API; null when there's none. */
  chord?(chordId: string): { id: string; profileId: string; private?: boolean; agent?: unknown } | null;
  /** The installed extensions, for the extension rule. */
  extensions?(): Record<string, InstalledExtension>;
  now?: () => number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

/** What the form detector (`main/passwords/detector.ts`) takes from the vault's side: which sign-ins it watches. It reads no settings. */
export interface DetectorSwitch {
  /** Exactly these profiles watched; every other one off. */
  setProfiles(profileIds: readonly string[]): void;
}

/** The state the detector's switch is worked out from. */
type DetectorState = { settings: { passwords: PasswordSettings }; chords: Record<string, { id: string; profileId: string; private?: boolean }>; extensions: Record<string, InstalledExtension> };

/** What the save card's Save did, or why it didn't. */
/** `changedAt`: an update's, for its Undo (`revertUpdate`). */
export type SaveAnswer = { ok: true; id: string; kind: 'new' | 'update' | 'same'; changedAt?: number } | { ok: false; problem: PasswordProblem | 'off' | 'io' | 'never' };

/** Who's asking for a page's accounts, or saving one: the page's origin as Chromium reports it for the frame, never what its script says. */
export interface PasswordPage {
  origin: string;
  /** The tab's chord (null in a private window, which has none here). */
  chord: { id: string; profileId: string } | null;
  private: boolean;
}

/** What the browser's own sign-in box gets (S17 §10): usernames only, never a password. */
export type HttpAccountsAnswer =
  | { state: 'off' }
  | { state: 'none' }
  | { state: 'locked' }
  | { state: 'open'; accounts: { id: string; username: string }[] };

/**
 * How long a generated password no sign-in has confirmed stays in the menu under the field (S17 §6; the owner's
 * design 4A shows it there, *Not confirmed · made today*, on coming back to a sign-up that failed). After that it's in
 * Settings → Passwords only, so an abandoned one doesn't clutter the menu.
 */
export const UNCONFIRMED_IN_MENU_MS = 24 * 60 * 60_000;

/** What the menu under the field gets: usernames and hosts, never a password. `madeAt`: one *Not confirmed*, and when it was made. */
export type AccountsAnswer =
  | { state: 'off' }
  | { state: 'none' }
  | { state: 'locked' }
  | { state: 'open'; offers: (LoginOffer & { madeAt?: number })[]; insecure: boolean };

/** What a sign-in that worked is to the save card (S17 §6 step 5), or why there's no card. */
export type CandidateAnswer =
  | { kind: 'new'; setup: boolean }
  | { kind: 'update'; id: string }
  | { kind: 'same'; id: string }
  | { kind: 'locked' }
  | { kind: 'never' }
  | { kind: 'off' }
  | { kind: 'refused' };

export interface SaveRequest extends PasswordPage {
  username: string;
  password: string;
  /** Typed in the browser's own sign-in box with *Remember* ticked: its realm (S17 §10). */
  realm?: string;
  /** The saved sign-in whose password this replaces (the update card). */
  replace?: string;
  /** The first save: the passphrase the card's passphrase step chose. */
  passphrase?: string;
  /** A proxy's sign-in box: never saved (DESIGN.md §9). */
  proxy?: boolean;
}

interface UnlockAsk {
  id: number;
  windowId: WindowId;
  keep: boolean;
  problem: 'wrong' | null;
  busy: boolean;
  answers: ((open: boolean) => void)[];
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Matching by site carries the Public Suffix List (about 130 KB): loaded the
 * first time a password step needs it, never at launch (performance rule 1).
 */
let sitesModule: Promise<typeof Sites> | null = null;
const sites = () => (sitesModule ??= import('@chord/core/password-sites'));

/** chord-data's problems as Settings' steps name them. */
const stepProblem = (problem: PasswordProblem): Exclude<PasswordStepResult, { ok: true }>['problem'] =>
  problem === 'refused' ? 'invalid' : problem;

export class PasswordService {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  /** When the passphrase was last typed and found right; null: not this launch. */
  private typedAt: number | null = null;
  private lastUsed = 0;
  private lockTimer: unknown = null;
  /** *Lock now*: the kept key isn't used again until the passphrase is typed. */
  private lockedByYou = false;
  /** Counts locks (yours and idle ones): a step that was typed before one doesn't count as the passphrase typed after it. */
  private locks = 0;
  /** What's on the clipboard from *Copy*, by its hash, and when it goes. */
  private copied: { hash: string; timer: unknown } | null = null;
  /** Deleted this session, newest first, for Undo: their address and username only. */
  private deleted: { id: string; origin: string; username: string }[] = [];
  /** The usernames and addresses Settings was last shown, so a deletion can be named. */
  private shown = new Map<string, { origin: string; username: string }>();
  private readonly asks = new Map<WindowId, UnlockAsk>();
  private nextAsk = 1;
  /** Whether the unlock card offers *Keep unlocked on this computer*: the OS can keep the key here. */
  private canKeep = false;
  private detector: DetectorSwitch | null = null;
  /** What the detector was last told, so it's told only of a change. */
  private detectorKey: string | null = null;
  private detectorInputs: readonly unknown[] = [];
  /** One opening at a time: two steps that need the kept key unwrap it once. */
  private opening: Promise<VaultState> | null = null;

  constructor(private readonly options: PasswordServiceOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /* ---------- the vault's state and the clock ---------- */

  private async data(op: PasswordOp): Promise<PasswordResult> {
    return this.options.data(op);
  }

  /** The vault was used: *Lock after* counts from now. */
  private touch(): void {
    this.lastUsed = this.now();
    this.schedule();
  }

  private schedule(): void {
    if (this.lockTimer !== null) this.clearTimer(this.lockTimer);
    this.lockTimer = null;
    const ms = lockAfterMs(this.options.settings().lockAfter);
    if (ms === null) return;
    const left = Math.max(0, this.lastUsed + ms - this.now());
    this.lockTimer = this.setTimer(() => {
      this.lockTimer = null;
      if (this.now() - this.lastUsed >= ms) void this.lockIdle();
      else this.schedule();
    }, left);
  }

  /** *Lock after* changed: the clock counts with the new time, from the last use. */
  settingsChanged(): void {
    if (this.lastUsed > 0) this.schedule();
  }

  /** Unused for *Lock after*: the key goes from memory. With the key kept here, the next use opens it again unasked. */
  private async lockIdle(): Promise<void> {
    this.locks++;
    const { status } = await this.data({ op: 'lock' }).catch((): PasswordResult => ({}));
    // A password Settings shows goes, always, and what waited to be written.
    this.options.hide?.();
    this.options.locked?.();
    // Kept unlocked: the list doesn't change (the next use opens it again unasked), so Settings isn't asked to look
    // again, which would open it again at once.
    if (!status?.kept) this.options.changed();
  }

  /**
   * The vault open if it can be without asking: already open, or opened with
   * the key kept on this computer (unless you locked it yourself). Never
   * throws: a key that can't be read leaves it locked, and says so in the log
   * without any of it.
   */
  private async ensureOpen(): Promise<VaultState> {
    this.opening ??= (async () => {
      const { status, generation, held } = await this.data({ op: 'status' });
      // *Lock now*, this launch or an earlier one: the kept key waits for the passphrase.
      if (held) this.lockedByYou = true;
      if (!status || status.state !== 'locked' || !status.kept || this.lockedByYou) return status?.state ?? 'locked';
      const { blob } = await this.data({ op: 'kept' });
      if (!blob) return 'locked';
      let key: Uint8Array;
      try {
        key = await this.options.keys.unwrap(blob);
      } catch {
        // The OS kept it for this computer only: a profile copied from another, or a keyring that's locked. The
        // passphrase still opens the vault, and nothing is lost.
        console.error('Passwords: the key kept on this computer couldn’t be read');
        return 'locked';
      }
      try {
        // *Lock now* while the OS answered: locked it stays (chord-data checks too, by `generation`).
        if (this.lockedByYou) return 'locked';
        const opened = await this.data({ op: 'open', key, ...(generation !== undefined ? { generation } : {}) });
        if (opened.problem && opened.problem !== 'locked') console.error('Passwords: the key kept on this computer isn’t this vault’s');
        const state = opened.status?.state ?? 'locked';
        // Opened unasked: *Lock after* counts from now, whatever opened it.
        if (state === 'open') this.touch();
        return state;
      } finally {
        key.fill(0);
      }
    })()
      .catch(() => 'locked' as const)
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  /** Main's state for the passphrase just typed and found right. */
  private typed(): void {
    this.typedAt = this.now();
    this.lockedByYou = false;
  }

  /* ---------- Settings → Passwords ---------- */

  async view(): Promise<PasswordsView> {
    const state = await this.ensureOpen().catch(() => 'locked' as const);
    const { status } = await this.data({ op: 'status' }).catch(() => ({ status: undefined }));
    const canKeep = await this.options.keys.available().catch(() => false);
    const view: PasswordsView = {
      state: status?.state ?? state,
      kept: status?.kept ?? false,
      canKeep,
      count: status?.count ?? 0,
      logins: [],
      unreadable: 0,
      nevers: [],
      // Which sites and usernames were deleted is shown only while the vault is open.
      deleted: [],
    };
    if (view.state === 'open') {
      const list = await this.data({ op: 'list', chordId: null }).catch(() => ({}) as PasswordResult);
      const nevers = await this.data({ op: 'nevers' }).catch(() => ({}) as PasswordResult);
      view.logins = sortLogins(list.logins ?? []);
      view.unreadable = list.unreadable ?? 0;
      view.nevers = nevers.nevers ?? [];
      view.deleted = this.deleted;
      this.shown = new Map(view.logins.map((l) => [l.id, { origin: l.origin, username: l.username }]));
      this.touch();
    }
    return view;
  }

  private async step(op: PasswordOp, after?: (result: PasswordResult) => void): Promise<PasswordStepResult> {
    let result: PasswordResult;
    try {
      result = await this.data(op);
    } catch {
      return { ok: false, problem: 'io' };
    }
    if (result.problem) return { ok: false, problem: stepProblem(result.problem) };
    after?.(result);
    this.options.changed();
    return { ok: true, view: await this.view() };
  }

  /** The first passphrase, from Settings (or the first save's card, through `save`). */
  setup(passphrase: string): Promise<PasswordStepResult> {
    return this.step({ op: 'setup', passphrase }, () => {
      this.typed();
      this.touch();
    });
  }

  async unlock(passphrase: string, keep = false): Promise<PasswordStepResult> {
    const result = await this.step({ op: 'unlock', passphrase }, () => {
      this.typed();
      this.touch();
    });
    if (result.ok) this.answerAsks(true);
    if (result.ok && keep && !result.view.kept) return this.keep(true);
    return result;
  }

  /** *Lock now*: locked until the passphrase is typed again, even with the key kept here. */
  async lock(): Promise<PasswordsView> {
    this.lockedByYou = true;
    this.locks++;
    this.typedAt = null;
    if (this.lockTimer !== null) this.clearTimer(this.lockTimer);
    this.lockTimer = null;
    // Held in chord.db too, so a relaunch with the key kept still waits for the passphrase.
    await this.data({ op: 'lock', held: true }).catch(() => undefined);
    this.options.hide?.();
    this.options.locked?.();
    this.options.changed();
    return this.view();
  }

  /**
   * *Keep unlocked on this computer*: a second copy of the key, wrapped by the
   * OS; or that copy forgotten. Turning it on lowers protection at rest, so it
   * asks for the passphrase as *Show* does (typed in the last 5 minutes, or now).
   */
  async keep(on: boolean, passphrase?: string): Promise<PasswordStepResult> {
    if (!on) return this.step({ op: 'keep', blob: null });
    if (!(await this.options.keys.available().catch(() => false))) return { ok: false, problem: 'keyring' };
    const stop = await this.gate(passphrase);
    if (stop) return { ok: false, problem: stop.problem === 'missing' ? 'io' : stop.problem };
    const { key, problem } = await this.data({ op: 'key' }).catch(() => ({ key: undefined, problem: 'locked' as const }));
    if (!key) return { ok: false, problem: problem === 'none' ? 'none' : 'locked' };
    let blob: string;
    try {
      blob = await this.options.keys.wrap(key);
    } catch {
      return { ok: false, problem: 'keyring' };
    } finally {
      key.fill(0);
    }
    return this.step({ op: 'keep', blob });
  }

  changePassphrase(current: string, next: string): Promise<PasswordStepResult> {
    const locks = this.locks;
    // Locked while scrypt ran: the lock holds (chord-data keeps `held` too), so this isn't the passphrase typed after it.
    return this.step({ op: 'passphrase', current, next }, () => {
      if (locks === this.locks) this.typed();
    });
  }

  /**
   * *Show* and *Copy* first: the vault open, and the passphrase typed in the
   * last 5 minutes, or typed now. Null when it may go ahead.
   */
  private async gate(passphrase: string | undefined): Promise<Exclude<PasswordRevealResult, { ok: true }> | null> {
    if ((await this.ensureOpen()) !== 'open') return { ok: false, problem: 'locked' };
    if (!passphraseDue(this.now(), this.typedAt)) return null;
    if (passphrase === undefined) return { ok: false, problem: 'passphrase' };
    const verified = await this.data({ op: 'verify', passphrase }).catch(() => ({ problem: 'io' as const }));
    if (verified.problem === 'wrong') return { ok: false, problem: 'wrong' };
    if (verified.problem) return { ok: false, problem: 'io' };
    this.typed();
    return null;
  }

  async reveal(id: string, passphrase?: string): Promise<PasswordRevealResult> {
    const stop = await this.gate(passphrase);
    if (stop) return stop;
    const result = await this.data({ op: 'reveal', id }).catch((): PasswordResult => ({}));
    this.touch();
    if (result.password === undefined) return { ok: false, problem: result.problem === 'locked' ? 'locked' : result.problem === 'missing' ? 'missing' : 'io' };
    return { ok: true, password: result.password };
  }

  /** *Copy*: on the clipboard, and off it again after a minute if it's still what's there. */
  async copy(id: string, passphrase?: string): Promise<PasswordRevealResult> {
    const shown = await this.reveal(id, passphrase);
    if (!shown.ok || shown.password === undefined) return shown;
    this.toClipboard(shown.password);
    return { ok: true };
  }

  private toClipboard(text: string): void {
    if (this.copied) this.clearTimer(this.copied.timer);
    this.options.clipboard.writeText(text);
    const hash = sha256(text);
    this.copied = { hash, timer: this.setTimer(() => void this.clearClipboard(), PASSWORD_CLIPBOARD_MS) };
  }

  /** The copied password leaves the clipboard, unless something else was copied since. */
  private async clearClipboard(): Promise<void> {
    if (!this.copied) return;
    this.clearTimer(this.copied.timer);
    const { hash } = this.copied;
    this.copied = null;
    const now = await Promise.resolve(this.options.clipboard.readText()).catch(() => '');
    if (sha256(now) === hash) this.options.clipboard.writeText('');
  }

  /** chord-data checks the address (only `http:` and `https:` can be saved). */
  add(login: { origin: string; username: string; password: string; note: string }): Promise<PasswordStepResult> {
    if (loginProblem(login)) return Promise.resolve({ ok: false, problem: 'invalid' });
    return this.step({ op: 'add', login, chordId: null }, () => this.touch());
  }

  /**
   * A sign-in changed in Settings. Its address decides which pages it fills, so changing it needs the passphrase
   * typed in the last 5 minutes, as *Show* does: someone at an unlocked computer can't point a sign-in at their site.
   */
  async edit(id: string, patch: Partial<{ origin: string; username: string; password: string; note: string }>, passphrase?: string): Promise<PasswordStepResult> {
    if (patch.origin !== undefined) {
      const stop = await this.gate(passphrase);
      if (stop) return { ok: false, problem: stop.problem === 'missing' ? 'io' : stop.problem };
    }
    return this.step({ op: 'edit', id, patch }, () => this.touch());
  }

  /** Deleted, with Undo for the rest of this session. */
  remove(id: string): Promise<PasswordStepResult> {
    const named = this.shown.get(id);
    return this.step({ op: 'delete', id }, () => {
      this.deleted = [{ id, origin: named?.origin ?? '', username: named?.username ?? '' }, ...this.deleted.filter((d) => d.id !== id)];
      this.touch();
    });
  }

  undo(id: string): Promise<PasswordStepResult> {
    return this.step({ op: 'undelete', id }, () => {
      this.deleted = this.deleted.filter((d) => d.id !== id);
      this.touch();
    });
  }

  forgetNever(site: string): Promise<PasswordStepResult> {
    return this.step({ op: 'forgetNever', site });
  }

  /** A forgotten passphrase: every password goes, and the key with it. Only while locked: open, there's nothing forgotten. */
  async startOver(): Promise<PasswordsView> {
    if ((await this.ensureOpen()) === 'open') return this.view();
    await this.data({ op: 'startOver' }).catch(() => undefined);
    this.typedAt = null;
    this.lockedByYou = false;
    this.deleted = [];
    this.shown.clear();
    this.answerAsks(false);
    this.options.changed();
    return this.view();
  }

  /* ---------- import and export (main/passwords/transfer.ts) ---------- */

  /** The vault's state for an import or export: opened unasked if it can be (the key kept here, unless you locked it). */
  vaultState(): Promise<VaultState> {
    return this.ensureOpen();
  }

  /** *Export*'s check, as *Show*'s (S17 §7): the vault open, and the passphrase typed in the last 5 minutes or now. Null: go ahead. */
  confirm(passphrase?: string): Promise<Exclude<PasswordRevealResult, { ok: true }> | null> {
    return this.gate(passphrase);
  }

  /** An import wrote (or its Undo did), or an export read: *Lock after* counts from now, and what shows the list looks again. */
  transferred(changed: boolean): void {
    this.touch();
    if (changed) this.options.changed();
  }

  /* ---------- the unlock card ---------- */

  /**
   * Show the unlock card in a window's popover; resolves once the vault is
   * open (true) or the card is cancelled (false). Open already, or openable
   * with the key kept here: true at once, no card.
   */
  async askUnlock(windowId: WindowId): Promise<boolean> {
    const state = await this.ensureOpen();
    if (state === 'open') return true;
    if (state === 'none') return false;
    const canKeep = await this.options.keys.available().catch(() => false);
    return new Promise((resolve) => {
      const ask = this.asks.get(windowId);
      if (ask) {
        ask.answers.push(resolve);
        return;
      }
      this.asks.set(windowId, { id: this.nextAsk++, windowId, keep: false, problem: null, busy: false, answers: [resolve] });
      this.canKeep = canKeep;
      this.options.changed();
    });
  }

  /** The card for a window's popover, if it's asking. */
  unlockPromptFor(windowId: WindowId): PasswordUnlockPrompt | null {
    const ask = this.asks.get(windowId);
    return ask ? { id: ask.id, keep: ask.keep, canKeep: this.canKeep, problem: ask.problem, busy: ask.busy } : null;
  }

  /** The card's Unlock (with whether to keep it unlocked here) or Cancel (null). */
  async answerUnlock(id: number, passphrase: string | null, keep: boolean): Promise<void> {
    const ask = [...this.asks.values()].find((a) => a.id === id);
    if (!ask || ask.busy) return;
    if (passphrase === null) {
      this.asks.delete(ask.windowId);
      for (const answer of ask.answers) answer(false);
      this.options.changed();
      return;
    }
    ask.busy = true;
    ask.keep = keep;
    this.options.changed();
    const result = await this.unlock(passphrase, keep && this.canKeep);
    ask.busy = false;
    if (!result.ok && (result.problem === 'wrong' || result.problem === 'invalid')) {
      ask.problem = 'wrong';
      this.options.changed();
    } else if (!result.ok) {
      ask.problem = null;
      this.options.changed();
    }
    // Open: every window's card has gone with it (`unlock` answers them all).
  }

  /** Every card answered: the vault opened (true) or went (false). */
  private answerAsks(open: boolean): void {
    if (this.asks.size === 0) return;
    const asks = [...this.asks.values()];
    this.asks.clear();
    for (const ask of asks) for (const answer of ask.answers) answer(open);
    this.options.changed();
  }

  /** A window closed: its card is cancelled. */
  windowClosed(windowId: WindowId): void {
    const ask = this.asks.get(windowId);
    if (!ask) return;
    this.asks.delete(windowId);
    for (const answer of ask.answers) answer(false);
  }

  /* ---------- the API the menu under the field and the save cards call ---------- */

  /** Whether Chord offers to save and fill on this page: the switch, the extension rule, and an address that can be saved. */
  private async onFor(page: PasswordPage, extensions: Record<string, InstalledExtension>): Promise<boolean> {
    if (!passwordsOnIn(this.options.settings(), page.private ? null : page.chord, extensions)) return false;
    return (await sites()).loginOrigin(page.origin) !== null;
  }

  /**
   * The accounts the menu under a focused field lists, best first (S17 §5):
   * usernames and hosts only. A private window is offered them too (it fills
   * and never saves); its use isn't remembered.
   */
  async accountsForPage(page: PasswordPage, extensions: Record<string, InstalledExtension>): Promise<AccountsAnswer> {
    if (!(await this.onFor(page, extensions))) return { state: 'off' };
    const state = await this.ensureOpen();
    if (state !== 'open') return { state };
    const chordId = page.private ? null : (page.chord?.id ?? null);
    const result = await this.data({ op: 'forSite', origin: page.origin, chordId }).catch(() => ({}) as PasswordResult);
    if (result.problem === 'locked') return { state: 'locked' };
    this.touch();
    const { insecureOrigin, offersFor } = await sites();
    // A form is never offered what the browser's own sign-in box saved (S17 §10): checked here as well as in chord-data.
    // A generated password no sign-in has confirmed is offered for a day after it was made, after the confirmed ones;
    // then it's in Settings only, *Not confirmed* (S17 §6, phase 2).
    const now = this.now();
    const forms = (result.logins ?? []).filter((l) => l.realm === null && !(l.unconfirmed && now - l.createdAt > UNCONFIRMED_IN_MENU_MS));
    const made = new Map(forms.filter((l) => l.unconfirmed).map((l) => [l.id, l.createdAt] as const));
    const offers = offersFor(page.origin, forms);
    const confirmed = offers.filter((o) => !made.has(o.id));
    const pending = offers.filter((o) => made.has(o.id)).map((o) => ({ ...o, madeAt: made.get(o.id)! }));
    return { state: 'open', offers: [...confirmed, ...pending], insecure: insecureOrigin(page.origin) };
  }

  /**
   * The password for an account you picked in the menu, for the frame whose
   * origin it was shown for: null unless the sign-in matches that origin
   * (chord-data checks again). Its use is remembered for the chord, never in
   * a private window.
   */
  async passwordForPage(page: PasswordPage, id: string, extensions: Record<string, InstalledExtension>): Promise<string | null> {
    if (!(await this.onFor(page, extensions))) return null;
    if ((await this.ensureOpen()) !== 'open') return null;
    const chordId = page.private ? null : (page.chord?.id ?? null);
    const result = await this.data({ op: 'fill', id, origin: page.origin, chordId }).catch(() => ({}) as PasswordResult);
    this.touch();
    // Main checks the match itself too (S17 §5), on the sign-in's own origin as chord-data opened it, and that it's a
    // form's, never the sign-in box's (S17 §10).
    if (result.password === undefined || result.loginOrigin === undefined || result.loginRealm !== null) return null;
    if ((await sites()).matchLogin(page.origin, result.loginOrigin) === null) return null;
    return result.password;
  }

  /** What a sign-in that worked is to the vault: which card, or none. Never in a private window, never for a proxy. */
  async candidate(page: PasswordPage & { username: string; password: string; proxy?: boolean; realm?: string }, extensions: Record<string, InstalledExtension>): Promise<CandidateAnswer> {
    if (page.private || page.proxy || loginProblem({ ...page, origin: page.origin }) !== null) return { kind: 'refused' };
    const realm = page.realm !== undefined ? { realm: page.realm } : {};
    if (!(await this.onFor(page, extensions))) return { kind: 'off' };
    const state = await this.ensureOpen();
    if (state === 'none') return { kind: 'new', setup: true };
    if (state === 'locked') return { kind: 'locked' };
    // *Never for this site* is about offers to save; *Remember*, ticked in the sign-in box, is you asking.
    if (page.realm === undefined && (await this.data({ op: 'isNever', origin: page.origin }).catch(() => ({}) as PasswordResult)).never) return { kind: 'never' };
    // A site that takes a one-time code after the password (Apple's list, S17 §6 phase 3D): the code is no new password.
    // The list is loaded only for a password that ends in 6 to 8 digits, never at launch: no code can be there otherwise.
    const appendsCode = page.realm === undefined && /[0-9]{6}$/.test(page.password) && (await import('@chord/core/password-quirks')).appendsCodeToPassword(page.origin) ? { appendsCode: true } : {};
    const { candidate } = await this.data({ op: 'compare', origin: page.origin, username: page.username, password: page.password, ...realm, ...appendsCode }).catch(() => ({}) as PasswordResult);
    if (!candidate) return { kind: 'locked' };
    // Exactly what's saved: no card, and its last use moves (S17 §6).
    if (candidate.kind === 'same' && page.chord) await this.data({ op: 'used', id: candidate.id, chordId: page.chord.id }).catch(() => undefined);
    // A generated one *Not confirmed*: this sign-in that worked confirms it (refused, and nothing changes, when it is).
    if (candidate.kind === 'same' && page.realm === undefined) await this.data({ op: 'confirm', id: candidate.id, origin: page.origin }).catch(() => undefined);
    this.touch();
    return candidate.kind === 'new' ? { kind: 'new', setup: false } : candidate;
  }

  /**
   * The save or update card's Save: the first one sets the passphrase too.
   * Refused from a private window, for a proxy, or for a site you said never
   * to save for.
   */
  async save(request: SaveRequest, extensions: Record<string, InstalledExtension>): Promise<{ ok: true; id: string; changedAt?: number } | { ok: false; problem: PasswordProblem | 'off' | 'io' }> {
    if (request.private || request.proxy || loginProblem(request) !== null) return { ok: false, problem: 'refused' };
    if (!(await this.onFor(request, extensions))) return { ok: false, problem: 'off' };
    try {
      let state = await this.ensureOpen();
      if (state === 'none') {
        if (request.passphrase === undefined) return { ok: false, problem: 'none' };
        const setup = await this.data({ op: 'setup', passphrase: request.passphrase });
        if (setup.problem) return { ok: false, problem: setup.problem };
        this.typed();
        state = 'open';
      }
      if (state !== 'open') return { ok: false, problem: 'locked' };
      if (!request.replace && request.realm === undefined && (await this.data({ op: 'isNever', origin: request.origin })).never) return { ok: false, problem: 'refused' };
      const saved = await this.data({
        op: 'save',
        origin: request.origin,
        username: request.username,
        password: request.password,
        chordId: request.chord?.id ?? null,
        ...(request.replace ? { replace: request.replace } : {}),
        ...(request.realm !== undefined ? { realm: request.realm } : {}),
      });
      if (!saved.id) return { ok: false, problem: saved.problem ?? 'invalid' };
      this.touch();
      this.options.changed();
      return { ok: true, id: saved.id, ...(saved.changedAt !== undefined ? { changedAt: saved.changedAt } : {}) };
    } catch {
      return { ok: false, problem: 'io' };
    }
  }

  /** The save card's *Never for this site*. */
  async never(page: PasswordPage): Promise<boolean> {
    if (page.private || (await this.ensureOpen()) !== 'open') return false;
    const result = await this.data({ op: 'never', origin: page.origin }).catch(() => ({}) as PasswordResult);
    this.options.changed();
    return result.never === true;
  }

  /* ---------- the detector's API (agreed with feat/passwords-detector) ---------- */

  /**
   * A page as the detector reports it: its origin (`event.senderFrame.origin`,
   * which main gives and this trusts) and its tab's chord. A private window's
   * chord is fill only; an agent's chord (S18), a chord id main doesn't know, or none gets nothing.
   */
  private pageOf(origin: string, chordId: string | null): PasswordPage | null {
    const chord = chordId ? (this.options.chord?.(chordId) ?? null) : null;
    if (!chord) return null;
    // An outside agent's tab (S18): nothing of the vault, ever. No menu, no fill, no save, no generator: off.
    if (chord.agent) return null;
    if (chord.private) return { origin, chord: null, private: true };
    return { origin, chord: { id: chord.id, profileId: chord.profileId }, private: false };
  }

  private installed(): Record<string, InstalledExtension> {
    return this.options.extensions?.() ?? {};
  }

  /** The menu under a focused field: usernames and hosts, this chord's recent first; or off, none (no vault yet), locked. */
  accountsFor(origin: string, chordId: string | null): Promise<AccountsAnswer> {
    const page = this.pageOf(origin, chordId);
    return page ? this.accountsForPage(page, this.installed()) : Promise.resolve({ state: 'off' });
  }

  /**
   * The password for the account picked in the menu, for that frame's origin:
   * null unless the sign-in matches it (S17 §5, checked here and again in
   * chord-data). `chordId` records the use; a private window's isn't.
   */
  passwordFor(accountId: string, origin: string, chordId: string | null): Promise<string | null> {
    const page = this.pageOf(origin, chordId);
    return page ? this.passwordForPage(page, accountId, this.installed()) : Promise.resolve(null);
  }

  /** Which card a sign-in that worked gets: new (with the passphrase step when there's no vault yet), update, or none. */
  candidateFor(candidate: { origin: string; username: string; password: string; chordId: string | null }): Promise<CandidateAnswer> {
    const page = this.pageOf(candidate.origin, candidate.chordId);
    if (!page) return Promise.resolve({ kind: 'off' });
    return this.candidate({ ...page, username: candidate.username, password: candidate.password }, this.installed());
  }

  /**
   * The save or update card's Save: a new sign-in, a new password for the
   * one saved for that username on the site (keeping the one before), or,
   * when it's what's saved already, its use only. The first one sets the
   * passphrase (`passphrase`, from the card's step). Never from a private
   * window, for a proxy, or on a site you said never to save for.
   */
  /**
   * A card's Save: new, an update, or the same as saved (nothing written). `typed`: the save card left a code off the
   * end of `password` (S17 §6 phase 3D, the owner's design 1A), and this is what was typed. It's decided as an open
   * vault would have decided before showing the card (review round 1 of #70): if either is the same as a saved sign-in
   * (with a code after it or not), nothing is written; an update keeps what was typed; only a new one is saved without
   * the code. A card offered while locked thus never shortens a saved password that really ends in digits.
   */
  async saveCandidate(candidate: { origin: string; username: string; password: string; typed?: string; chordId: string | null; passphrase?: string; proxy?: boolean; realm?: string }): Promise<SaveAnswer> {
    const page = this.pageOf(candidate.origin, candidate.chordId);
    if (!page) return { ok: false, problem: 'off' };
    const extensions = this.installed();
    const request: SaveRequest = {
      ...page,
      username: candidate.username,
      password: candidate.password,
      ...(candidate.passphrase !== undefined ? { passphrase: candidate.passphrase } : {}),
      ...(candidate.proxy ? { proxy: true } : {}),
      ...(candidate.realm !== undefined ? { realm: candidate.realm } : {}),
    };
    let kind = await this.candidate(request, extensions);
    if (candidate.typed !== undefined && candidate.typed !== candidate.password && candidate.realm === undefined && (kind.kind === 'new' || kind.kind === 'update')) {
      const typed = await this.candidate({ ...request, password: candidate.typed }, extensions);
      if (typed.kind === 'same') kind = typed;
      // An update, either way: it keeps what was typed.
      else if (kind.kind === 'update' || typed.kind === 'update') {
        request.password = candidate.typed;
        if (typed.kind === 'update') kind = typed;
      } else if (typed.kind !== 'new') kind = typed;
    }
    switch (kind.kind) {
      case 'refused':
      case 'off':
      case 'never':
      case 'locked':
        return { ok: false, problem: kind.kind };
      case 'same':
        return { ok: true, id: kind.id, kind: 'same' };
      case 'update': {
        const saved = await this.save({ ...request, replace: kind.id }, extensions);
        return saved.ok ? { ok: true, id: saved.id, kind: 'update', ...(saved.changedAt !== undefined ? { changedAt: saved.changedAt } : {}) } : saved;
      }
      case 'new': {
        const saved = await this.save(request, extensions);
        return saved.ok ? { ok: true, id: saved.id, kind: 'new' } : saved;
      }
    }
  }

  /* ---------- generated passwords, sign-up and change forms (S17 §6, phase 2) ---------- */

  /** What the generator's row asks first, for a page: nothing (open), the passphrase (locked), the first one (none); or no row at all (off, a private window). */
  async generatorFor(origin: string, chordId: string | null): Promise<'open' | 'locked' | 'none' | 'off'> {
    const page = this.pageOf(origin, chordId);
    if (!page || page.private || !(await this.onFor(page, this.installed()))) return 'off';
    return this.ensureOpen();
  }

  /**
   * A generated password, saved the moment it's filled (S17 §6): a new sign-in for the frame's origin, no username
   * yet, *Not confirmed*. The first one sets the passphrase (`passphrase`, from the save card's step). Never in a
   * private window (there's no generator there), and whatever the never list says (generating is asking).
   */
  async presave(request: { origin: string; password: string; chordId: string | null; passphrase?: string }): Promise<{ ok: true; id: string; setup: boolean } | { ok: false; problem: PasswordProblem | 'off' | 'io' }> {
    const page = this.pageOf(request.origin, request.chordId);
    if (!page || page.private || loginProblem({ origin: request.origin, username: '', password: request.password }) !== null) return { ok: false, problem: 'refused' };
    if (!(await this.onFor(page, this.installed()))) return { ok: false, problem: 'off' };
    try {
      let state = await this.ensureOpen();
      let setup = false;
      if (state === 'none') {
        if (request.passphrase === undefined) return { ok: false, problem: 'none' };
        const made = await this.data({ op: 'setup', passphrase: request.passphrase });
        if (made.problem) return { ok: false, problem: made.problem };
        this.typed();
        state = 'open';
        setup = true;
      }
      if (state !== 'open') return { ok: false, problem: 'locked' };
      const saved = await this.data({ op: 'presave', origin: request.origin, password: request.password, chordId: page.chord?.id ?? null });
      if (!saved.id) return { ok: false, problem: saved.problem ?? 'invalid' };
      this.touch();
      this.options.changed();
      return { ok: true, id: saved.id, setup };
    } catch {
      return { ok: false, problem: 'io' };
    }
  }

  /**
   * A *Not confirmed* sign-in, before a submit worked: `pending` gives it the username it was submitted with (or the
   * password it holds now); `confirm` marks it confirmed, as a submit that worked does. False when it can't (locked,
   * confirmed already, another site's). For the frame's origin only, never in a private window.
   */
  async presaved(action: 'pending' | 'confirm', id: string, origin: string, chordId: string | null, values: { username?: string; password?: string }): Promise<boolean> {
    const page = this.pageOf(origin, chordId);
    if (!page || page.private || (await this.ensureOpen()) !== 'open') return false;
    if (values.username !== undefined && values.username.length > 500) return false;
    if (values.password !== undefined && loginProblem({ origin, username: '', password: values.password }) !== null) return false;
    const result = await this.data({ op: action, id, origin, ...values }).catch(() => ({}) as PasswordResult);
    if (!result.id) return false;
    this.touch();
    this.options.changed();
    return true;
  }

  /**
   * A change-password form's account (S17 §6): the saved sign-ins the page is offered whose password is the form's
   * current one (`matches`), and every one it's offered (`accounts`, best first) for the card to ask from when that's
   * none or several. Usernames only.
   */
  async changeAccounts(
    origin: string,
    chordId: string | null,
    current: string | null,
  ): Promise<{ state: 'open'; matches: { id: string; username: string }[]; accounts: { id: string; username: string }[] } | { state: 'off' | 'none' | 'locked' }> {
    const offered = await this.accountsFor(origin, chordId);
    if (offered.state !== 'open') return { state: offered.state };
    const accounts = offered.offers.map((o) => ({ id: o.id, username: o.username }));
    if (!current) return { state: 'open', matches: [], accounts };
    const { logins } = await this.data({ op: 'matchCurrent', origin, current }).catch(() => ({}) as PasswordResult);
    const ids = new Set((logins ?? []).map((l) => l.id));
    return { state: 'open', matches: accounts.filter((a) => ids.has(a.id)), accounts };
  }

  /**
   * A changed password, for the account it's for (S17 §6): its password replaced (the one before it kept); and a
   * generated one saved for the change, *Not confirmed* (`presaved`), deleted, since the account has it now.
   */
  async changePassword(request: { origin: string; chordId: string | null; account: string; password: string; presaved?: string }): Promise<SaveAnswer> {
    const page = this.pageOf(request.origin, request.chordId);
    if (!page || page.private) return { ok: false, problem: 'off' };
    if ((await this.ensureOpen()) !== 'open') return { ok: false, problem: 'locked' };
    const { logins } = await this.data({ op: 'forSite', origin: request.origin, chordId: null }).catch(() => ({}) as PasswordResult);
    const account = (logins ?? []).find((l) => l.id === request.account && l.realm === null);
    if (!account) return { ok: false, problem: 'missing' };
    const saved = await this.save({ ...page, username: account.username, password: request.password, replace: account.id }, this.installed());
    if (!saved.ok) return saved;
    if (request.presaved && request.presaved !== account.id) await this.data({ op: 'delete', id: request.presaved }).catch(() => undefined);
    this.options.changed();
    return { ok: true, id: saved.id, kind: 'update', ...(saved.changedAt !== undefined ? { changedAt: saved.changedAt } : {}) };
  }

  /**
   * The saved card's *Delete it* (the owner's design 5A): the sign-in a generated password was saved as, gone (with
   * chord-data's Undo for the session). Only a page's form sign-in for the frame's origin.
   */
  async deleteSaved(id: string, origin: string, chordId: string | null): Promise<boolean> {
    const page = this.pageOf(origin, chordId);
    if (!page || page.private || (await this.ensureOpen()) !== 'open') return false;
    const { logins } = await this.data({ op: 'forSite', origin, chordId: null }).catch(() => ({}) as PasswordResult);
    if (!(logins ?? []).some((l) => l.id === id)) return false;
    const done = await this.data({ op: 'delete', id }).catch(() => ({}) as PasswordResult);
    if (!done.id) return false;
    this.touch();
    this.options.changed();
    return true;
  }

  /**
   * *Change password on the site* (S17 §9): Apple's address for the sign-in's site, else its
   * `/.well-known/change-password`. Only for a sign-in Settings was shown (the vault open), never another address.
   */
  async changePasswordUrl(id: string): Promise<string | null> {
    const shown = this.shown.get(id);
    if (!shown) return null;
    const { changePasswordUrlFor } = await import('@chord/core/password-quirks');
    return changePasswordUrlFor(shown.origin);
  }

  /* ---------- the browser's own sign-in box (S17 §10) ---------- */

  /**
   * The sign-ins the box for an origin and realm is filled from: those saved from the box for exactly that origin
   * (scheme, host, port, as main saw the request) and realm, this chord's recent first; usernames only. A private
   * window is offered them too (it fills and never saves). Never for a proxy: the caller doesn't ask.
   */
  async httpAccountsFor(origin: string, realm: string, chordId: string | null): Promise<HttpAccountsAnswer> {
    const page = this.pageOf(origin, chordId);
    if (!page || !(await this.onFor(page, this.installed()))) return { state: 'off' };
    const state = await this.ensureOpen();
    if (state !== 'open') return { state };
    const result = await this.data({ op: 'forSite', origin, realm, chordId: page.chord?.id ?? null }).catch(() => ({}) as PasswordResult);
    if (result.problem === 'locked') return { state: 'locked' };
    this.touch();
    const exact = (await sites()).loginOrigin(origin);
    const logins = (result.logins ?? []).filter((l) => l.realm === realm && l.origin === exact);
    logins.sort(
      (a, b) =>
        (b.chordUsed ?? -1) - (a.chordUsed ?? -1) || (b.lastUsed ?? -1) - (a.lastUsed ?? -1) || a.username.localeCompare(b.username) || a.id.localeCompare(b.id),
    );
    return { state: 'open', accounts: logins.map((l) => ({ id: l.id, username: l.username })) };
  }

  /** The password of a sign-in the box was filled from, for that origin and realm only (checked here and in chord-data). Its use is remembered, never in a private window. */
  async httpPasswordFor(id: string, origin: string, realm: string, chordId: string | null): Promise<string | null> {
    const page = this.pageOf(origin, chordId);
    if (!page || !(await this.onFor(page, this.installed()))) return null;
    if ((await this.ensureOpen()) !== 'open') return null;
    const result = await this.data({ op: 'fill', id, origin, realm, chordId: page.chord?.id ?? null }).catch(() => ({}) as PasswordResult);
    this.touch();
    if (result.password === undefined || result.loginOrigin === undefined || result.loginRealm !== realm) return null;
    if (result.loginOrigin !== (await sites()).loginOrigin(origin)) return null;
    return result.password;
  }

  /**
   * Undo of an update *Remember* made: the password before it back, only while the password is still the one that
   * update wrote (`changedAt`). False when it can't (locked, gone, changed since).
   */
  async revertUpdate(id: string, changedAt: number): Promise<boolean> {
    if ((await this.ensureOpen()) !== 'open') return false;
    const result = await this.data({ op: 'revert', id, changedAt }).catch(() => ({}) as PasswordResult);
    if (!result.id) return false;
    this.touch();
    this.options.changed();
    return true;
  }

  /** The save card's *Never for this site*, for that frame's origin and the tab's chord: false while locked (ask first) or in a private window. */
  neverFor(origin: string, chordId: string | null): Promise<boolean> {
    const page = this.pageOf(origin, chordId);
    return page ? this.never(page) : Promise.resolve(false);
  }

  /** The form detector, once main has made it: it's told at once which sign-ins to watch. */
  attachDetector(detector: DetectorSwitch, state: DetectorState): void {
    this.detector = detector;
    this.detectorKey = null;
    this.detectorInputs = [];
    this.stateChanged(state);
  }

  /**
   * After every state change: when the switch, the extension rule, the
   * chords or the extensions changed, the detector hears which sign-ins it
   * watches now (`setProfiles`: the whole set, so a chord left out is turned off), and only when that changed. Compared by
   * reference first (Immer keeps what didn't change), so most changes cost nothing.
   */
  stateChanged(state: DetectorState): void {
    if (!this.detector) return;
    const inputs = [state.settings.passwords, state.chords, state.extensions];
    if (inputs.every((input, i) => input === this.detectorInputs[i])) return;
    this.detectorInputs = inputs;
    const profiles = passwordProfiles(state.settings.passwords, state.chords, state.extensions);
    const key = profiles.join(',');
    if (key === this.detectorKey) return;
    this.detectorKey = key;
    this.detector.setProfiles(profiles);
  }

  /* ---------- lifetime ---------- */

  /** chord-data started again (after a crash): the key went with it, so the vault is locked. */
  restarted(): void {
    // Its Undo copies went with it.
    this.deleted = [];
    this.options.hide?.();
    this.options.changed();
  }

  /** Quitting: a copied password still on the clipboard leaves it now. */
  dispose(): Promise<void> {
    const cleared = this.clearClipboard();
    if (this.lockTimer !== null) this.clearTimer(this.lockTimer);
    this.lockTimer = null;
    this.answerAsks(false);
    return cleared;
  }
}

/** Settings' list: by site, then username. */
function sortLogins(logins: LoginSummary[]): LoginSummary[] {
  const host = (origin: string) => {
    try {
      return new URL(origin).hostname.replace(/^www\./, '');
    } catch {
      return origin;
    }
  };
  return [...logins].sort((a, b) => host(a.origin).localeCompare(host(b.origin)) || a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
}
