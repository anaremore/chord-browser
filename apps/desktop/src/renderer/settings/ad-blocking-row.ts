/**
 * Settings → Privacy's row for the chords whose ad blocking didn't come on (#284; the owner's pick of
 * mocks/ad-blocking-failed-284.html, 2026-11-26): their pages load without it, and Try again tries once more.
 */
import type { AdBlockingStatus } from '@chord/ipc';

export interface NotBlockingRow {
  /** "Not blocking in Work", "… in Work and Home", "… in Work, Home and School". */
  label: string;
  description: string;
  /** A try is under way for one of them: the button says "Trying…" and waits. */
  trying: boolean;
  /** The profiles Try again tries (the ones failed, not those already being tried). */
  profiles: string[];
}

/** The row, or null when every chord's blocking is on (or none of those listed is a chord's). */
export function notBlockingRow(notOn: AdBlockingStatus['notOn'], chords: readonly { name: string; profileId: string }[]): NotBlockingRow | null {
  // Only chords' profiles count, for the words, Trying… and what's tried again (Neon's SF4 on #316).
  const ofChords = new Set(chords.map((c) => c.profileId));
  const mine = notOn.filter((p) => ofChords.has(p.profileId));
  // In the switcher's order, as Settings lists chords (Carbon's N1 on #316).
  const listed = new Set(mine.map((p) => p.profileId));
  const names = chords.filter((c) => listed.has(c.profileId)).map((c) => c.name);
  if (!names.length) return null;
  const many = names.length > 1;
  const joined = many ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return {
    label: `Not blocking in ${joined}`,
    description: many ? 'Ad blocking couldn’t start for these chords, so their pages load without it.' : 'Ad blocking couldn’t start for this chord, so its pages load without it.',
    trying: mine.some((p) => p.state === 'retrying'),
    profiles: mine.filter((p) => p.state === 'failed').map((p) => p.profileId),
  };
}
