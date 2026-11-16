/**
 * Chord's own passwords, the parts that are pure (docs/decisions/S17-passwords.md
 * §5, §7, §11): the settings, the lock's clock, the extension rule, what a
 * saved sign-in holds, and its limits. No crypto and no storage here: the
 * vault key and the sealed rows are chord-data's (`@chord/data`'s passwords.ts),
 * and matching by site needs the Public Suffix List (`./password-sites`, a
 * subpath of its own so renderers never bundle the list).
 */
import type { ChordId, InstalledExtension, ProfileId } from './model';

/** Settings → Passwords → Lock after: minutes unused, or never. Locked after every launch whatever this says. */
export type PasswordLockAfter = 5 | 15 | 30 | 60 | 240 | 'never';
export const PASSWORD_LOCK_AFTER: readonly PasswordLockAfter[] = [5, 15, 30, 60, 240, 'never'];
export const isPasswordLockAfter = (value: unknown): value is PasswordLockAfter => (PASSWORD_LOCK_AFTER as readonly unknown[]).includes(value);

/** Settings → Passwords. Whether the vault is kept unlocked on this computer is the vault's own (chord-data's meta), never a setting: it can't travel. */
export interface PasswordSettings {
  /** *Offer to save and fill passwords*: Chord's own password manager, on unless you turn it off. */
  enabled: boolean;
  lockAfter: PasswordLockAfter;
  /** Chords where it's on although a known password manager's extension is installed there (the chord's own switch turned on). */
  onChords: string[];
  /** Chords where it's off by hand, with no password manager to turn it off (the chord's own switch turned off). Wins over `onChords`. */
  offChords: string[];
}

export const DEFAULT_PASSWORD_SETTINGS: PasswordSettings = { enabled: true, lockAfter: 30, onChords: [], offChords: [] };

/** *Show* and *Copy* ask for the passphrase again once it was last typed longer ago than this (S17 §7). */
export const PASSWORD_REAUTH_MS = 5 * 60_000;
/** A copied password leaves the clipboard after this, if it's still what's there. */
export const PASSWORD_CLIPBOARD_MS = 60_000;

/** What one sign-in may hold, in characters (S17 §8). Longer is refused, never cut: a cut password is a wrong one. */
export const PASSWORD_LIMITS = { username: 500, password: 1000, note: 4000, realm: 200, origin: 2048 } as const;

/** How long the vault stays open unused; null: until Chord quits or you lock it. */
export const lockAfterMs = (lockAfter: PasswordLockAfter): number | null => (lockAfter === 'never' ? null : lockAfter * 60_000);

/** Whether an open vault, last used at `lastUsed`, should lock at `now`. */
export function lockDue(now: number, lastUsed: number, lockAfter: PasswordLockAfter): boolean {
  const ms = lockAfterMs(lockAfter);
  return ms !== null && now - lastUsed >= ms;
}

/** Whether *Show* or *Copy* asks for the passphrase first: never typed this launch (kept unlocked), or longer ago than PASSWORD_REAUTH_MS. */
export const passphraseDue = (now: number, typedAt: number | null): boolean => typedAt === null || now - typedAt >= PASSWORD_REAUTH_MS;

/** *Lock after*'s choices, as Settings words them. */
export function lockAfterText(lockAfter: PasswordLockAfter): string {
  if (lockAfter === 'never') return 'Never';
  if (lockAfter < 60) return `${lockAfter} minutes unused`;
  return lockAfter === 60 ? '1 hour unused' : `${lockAfter / 60} hours unused`;
}

/**
 * One saved sign-in, as it's sealed (never stored or sent whole anywhere
 * else): S17 §7's blob. `previous` is the one password before this one, to
 * recover from a wrong update.
 */
export interface LoginSecret {
  /** Where it was saved: scheme, host and port (`https://github.com`). */
  origin: string;
  username: string;
  password: string;
  /** An HTTP sign-in's realm (phase 3); null for a page's form. */
  realm: string | null;
  note: string;
  /** When the password last changed (ms). */
  changedAt: number;
  previous: { password: string; changedAt: number } | null;
}

/**
 * What Settings and the menu under the field are given of a sign-in: never
 * its password. `lastUsed` is this computer's; `chordUsed` is when the chord
 * that asked last used it (null: never, or not asked for one chord).
 */
export interface LoginSummary {
  id: string;
  origin: string;
  username: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  lastUsed: number | null;
  chordUsed: number | null;
}

/** Whether a sign-in's parts are within PASSWORD_LIMITS; null when they are, else which isn't. */
export function loginProblem(login: { username: string; password: string; note?: string; realm?: string | null; origin: string }): 'username' | 'password' | 'note' | 'realm' | 'origin' | 'empty' | null {
  if (login.password.length === 0) return 'empty';
  if (login.username.length > PASSWORD_LIMITS.username) return 'username';
  if (login.password.length > PASSWORD_LIMITS.password) return 'password';
  if ((login.note ?? '').length > PASSWORD_LIMITS.note) return 'note';
  if ((login.realm ?? '').length > PASSWORD_LIMITS.realm) return 'realm';
  if (login.origin.length > PASSWORD_LIMITS.origin) return 'origin';
  return null;
}

/**
 * Password managers' extensions, by Chrome Web Store id (S17 §11): a chord
 * with one installed has Chord's own off by default, so nothing asks twice.
 * ⚠ The ids are from the store as remembered, not each rechecked.
 */
export const PASSWORD_MANAGER_EXTENSIONS: ReadonlySet<string> = new Set([
  'aeblfdkhhhdcdjpifhhbdiojplfjncoa', // 1Password
  'aomjjhallfgjeglblehebfpbcfeobpgk', // 1Password (classic)
  'khgocmkkpikpnmmkgmdnfckapcdkgfaf', // 1Password Beta
  'nngceckbapebfimnlniiiahkandclblb', // Bitwarden
  'ghmbeldphafepmbegfdlkpapadhbakde', // Proton Pass
  'oboonakemofpalcgghocfoadofidjkkk', // KeePassXC-Browser
  'fdjamakpfbbddfjaooikfcpapjohcfmg', // Dashlane
  'hdokiejnpimakedhajhdlcegeplioahd', // LastPass
  'fooolghllnmhmmndgjiamiiodkpenpbb', // NordPass
  'bfogiafebfohielmmehodmfbbebbbpei', // Keeper
  'kmcfomidfpdkfieipokbalgegidffkal', // Enpass
  'pnlccmojcmeohlpggmfnbbiapkmbliob', // RoboForm
]);

/** Installed extensions, as state keeps them or Settings is told of them: only their store id, profile and name matter here. */
type Extension = Pick<InstalledExtension, 'id' | 'profileId' | 'name'>;
type Extensions = Record<string, Extension> | readonly Extension[];

/** The known password manager installed in a profile, if any (the first by name). */
export function passwordManagerIn(profileId: ProfileId, extensions: Extensions): Extension | null {
  const all = Array.isArray(extensions) ? extensions : Object.values(extensions);
  return all.filter((e) => e.profileId === profileId && PASSWORD_MANAGER_EXTENSIONS.has(e.id)).sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}

/**
 * Whether Chord offers to save and fill in a chord: the switch, then the
 * chord's own: off where you turned it off (`offChords`), and off where a
 * known password manager is installed in the chord's profile unless you
 * turned it on there (`onChords`). Private windows have no chord here: they
 * follow the switch alone (extensions can't run there).
 */
export function passwordsOnIn(
  settings: PasswordSettings,
  chord: { id: ChordId; profileId: ProfileId } | null,
  extensions: Extensions,
): boolean {
  if (!settings.enabled) return false;
  if (!chord) return true;
  if (settings.offChords.includes(chord.id)) return false;
  return settings.onChords.includes(chord.id) || passwordManagerIn(chord.profileId, extensions) === null;
}

/** One chord's row under the switch: whether it's on there, and the password manager keeping it off (null when none is). */
export interface PasswordChordRow {
  chordId: ChordId;
  on: boolean;
  offBecause: string | null;
}

/** Each chord's row under the switch, in the order given, as if the switch were on: with it off, the rows only dim. */
export function passwordChordRows(
  settings: PasswordSettings,
  chords: readonly { id: ChordId; profileId: ProfileId }[],
  extensions: Extensions,
): PasswordChordRow[] {
  const switchOn = { ...settings, enabled: true };
  return chords.map((chord) => {
    const on = passwordsOnIn(switchOn, chord, extensions);
    const manager = on || settings.offChords.includes(chord.id) ? null : passwordManagerIn(chord.profileId, extensions);
    return { chordId: chord.id, on, offBecause: manager?.name ?? null };
  });
}

/**
 * The lists after a chord's own switch is turned. On takes it out of
 * `offChords`, and puts it in `onChords` where a password manager would keep
 * it off; off takes it out of `onChords`, and puts it in `offChords` where
 * nothing else would. A chord is in one list at most.
 */
export function passwordChordPatch(
  settings: PasswordSettings,
  chord: { id: ChordId; profileId: ProfileId },
  on: boolean,
  extensions: Extensions,
): Pick<PasswordSettings, 'onChords' | 'offChords'> {
  const managed = passwordManagerIn(chord.profileId, extensions) !== null;
  const onChords = settings.onChords.filter((id) => id !== chord.id);
  const offChords = settings.offChords.filter((id) => id !== chord.id);
  if (on && managed) onChords.push(chord.id);
  if (!on && !managed) offChords.push(chord.id);
  return { onChords, offChords };
}

/** Chord ids, as a list of them may come back (a file, an old profile): strings of an id's length, once each, at most 500. */
const cleanChordIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, 500) : [];

/** Saved password settings as they may come back: each part that can be used, the defaults for the rest. */
export function restorePasswordSettings(saved: unknown): PasswordSettings {
  const settings: PasswordSettings = { ...DEFAULT_PASSWORD_SETTINGS, onChords: [], offChords: [] };
  if (!saved || typeof saved !== 'object') return settings;
  const s = saved as Record<string, unknown>;
  if (typeof s['enabled'] === 'boolean') settings.enabled = s['enabled'];
  if (isPasswordLockAfter(s['lockAfter'])) settings.lockAfter = s['lockAfter'];
  settings.onChords = cleanChordIds(s['onChords']);
  settings.offChords = cleanChordIds(s['offChords']);
  return settings;
}

/** A settings change's password parts applied to `current` in place (the reducer's draft): only what differs is written. */
export function applyPasswordPatch(current: PasswordSettings, patch: Partial<PasswordSettings>): void {
  if (typeof patch.enabled === 'boolean' && current.enabled !== patch.enabled) current.enabled = patch.enabled;
  if (isPasswordLockAfter(patch.lockAfter) && current.lockAfter !== patch.lockAfter) current.lockAfter = patch.lockAfter;
  for (const list of ['onChords', 'offChords'] as const) {
    const ids = patch[list];
    if (!ids) continue;
    const clean = cleanChordIds(ids);
    if (clean.join('\n') !== current[list].join('\n')) current[list] = clean;
  }
}

type ChordLike = { id: ChordId; profileId: ProfileId; private?: boolean };

/**
 * The sign-ins (sessions, by profile id) whose pages the form detector
 * watches: each profile with a chord where Chord's own is on, and private
 * windows' (they fill and never save). Sorted, so a change is easy to tell.
 * Empty with the switch off.
 */
export function passwordProfiles(settings: PasswordSettings, chords: Record<string, ChordLike> | readonly ChordLike[], extensions: Extensions): string[] {
  if (!settings.enabled) return [];
  const on = new Set<string>();
  for (const chord of Array.isArray(chords) ? chords : Object.values(chords)) {
    if (chord.private || passwordsOnIn(settings, chord, extensions)) on.add(chord.profileId);
  }
  return [...on].sort();
}
