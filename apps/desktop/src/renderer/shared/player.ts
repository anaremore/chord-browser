/**
 * Chord Player's install wording, shared by the DRM notice (popover) and
 * Settings → General → Chord Player (DESIGN.md §7.14), so both say the same.
 */
import type { PlayerFailure, PlayerOffer } from '@chord/ipc';

/** Why installing or starting Chord Player failed, in a sentence. */
export const PLAYER_FAILURES: Record<PlayerFailure, string> = {
  download: 'Chord Player didn’t download. Check your connection and try again.',
  verify: 'The download didn’t match its signature, so Chord didn’t install it.',
  unpack: 'Chord Player couldn’t be unpacked. Check there’s room on the disk and try again.',
  start: 'Chord Player didn’t start.',
  widevine: 'Chord Player couldn’t get Widevine from Google. Check your connection and try again.',
};

export const PLAYER_PHASES = { downloading: 'Downloading Chord Player', checking: 'Checking the download', unpacking: 'Unpacking Chord Player' } as const;

/** About this many megabytes, as file sizes are shown (decimal). */
export const megabytes = (bytes: number): number => Math.max(1, Math.round(bytes / 1_000_000));

/** The line over the progress bar: *Downloading Chord Player · 42%*, *Checking the download*, *Unpacking Chord Player · 80%*. */
export function installingLabel(offer: Extract<PlayerOffer, { state: 'installing' }>): string {
  return offer.phase === 'checking' ? PLAYER_PHASES.checking : `${PLAYER_PHASES[offer.phase]} · ${offer.percent}%`;
}
