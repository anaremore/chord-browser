/**
 * Installing Chord Player, as a state machine (ARCHITECTURE.md §9): what the
 * DRM notice shows comes from here, and an event that doesn't fit the state
 * it arrives in changes nothing (a second click on Install, a late progress
 * report after a failure). Pure, so it's unit-tested.
 *
 *   unknown ─check→ checking ─found→ available ─install→ downloading ─downloaded→ checking-download
 *                       └─none→ unavailable                │fail                     │verified
 *                                                          ▼                         ▼
 *                       failed ←──────fail────────────── unpacking ─done→ installed
 *
 * `installed` is the state whenever a usable version is on disk (found at
 * launch, or just unpacked). A newer release for an installed player is an
 * update, installed in the background beside it (installer.ts); the notice
 * keeps offering the installed one meanwhile.
 */
import type { PlayerManifest, PlayerRelease } from '@chord/player-protocol';
import type { PlayerFailure, PlayerOffer } from '@chord/ipc';

export interface Installed {
  version: string;
  protocol: number;
  ecs: string;
  vmp: PlayerManifest['vmp'];
}

export type InstallState =
  | { s: 'unknown' }
  | { s: 'checking'; since: number }
  | { s: 'unavailable'; why: 'unsupported' | 'unsigned' | 'no-release' | 'unreachable' }
  | { s: 'available'; release: PlayerRelease; manifest: PlayerManifest; update: boolean }
  | { s: 'downloading'; release: PlayerRelease; manifest: PlayerManifest; received: number }
  | { s: 'verifying'; release: PlayerRelease; manifest: PlayerManifest }
  | { s: 'unpacking'; release: PlayerRelease; manifest: PlayerManifest; percent: number }
  | { s: 'installed'; installed: Installed }
  | { s: 'failed'; why: PlayerFailure; release: PlayerRelease | null; manifest: PlayerManifest | null };

export type InstallEvent =
  | { e: 'check'; now: number }
  | { e: 'found'; release: PlayerRelease; manifest: PlayerManifest; update?: boolean }
  | { e: 'none'; why: 'unsupported' | 'unsigned' | 'no-release' | 'unreachable' }
  | { e: 'install' }
  | { e: 'progress'; received: number }
  | { e: 'downloaded' }
  | { e: 'verified' }
  | { e: 'unpacked'; percent: number }
  | { e: 'done'; installed: Installed }
  | { e: 'fail'; why: PlayerFailure }
  | { e: 'present'; installed: Installed }
  | { e: 'removed' };

const busy = (s: InstallState['s']) => s === 'downloading' || s === 'verifying' || s === 'unpacking';

export function nextState(state: InstallState, event: InstallEvent): InstallState {
  switch (event.e) {
    case 'check':
      // An installed or busy player isn't re-checked from here (updates run beside an installed one).
      return state.s === 'installed' || state.s === 'checking' || busy(state.s) ? state : { s: 'checking', since: event.now };
    case 'found':
      return state.s === 'checking' ? { s: 'available', release: event.release, manifest: event.manifest, update: event.update ?? false } : state;
    case 'none':
      return state.s === 'checking' ? { s: 'unavailable', why: event.why } : state;
    case 'install':
      if (state.s === 'available') return { s: 'downloading', release: state.release, manifest: state.manifest, received: 0 };
      if (state.s === 'failed' && state.release && state.manifest) return { s: 'downloading', release: state.release, manifest: state.manifest, received: 0 };
      return state;
    case 'progress':
      return state.s === 'downloading' ? { ...state, received: Math.min(event.received, state.manifest.size) } : state;
    case 'downloaded':
      return state.s === 'downloading' ? { s: 'verifying', release: state.release, manifest: state.manifest } : state;
    case 'verified':
      return state.s === 'verifying' ? { s: 'unpacking', release: state.release, manifest: state.manifest, percent: 0 } : state;
    case 'unpacked':
      return state.s === 'unpacking' ? { ...state, percent: Math.max(state.percent, Math.min(100, Math.round(event.percent))) } : state;
    case 'done':
      return state.s === 'unpacking' ? { s: 'installed', installed: event.installed } : state;
    case 'fail':
      return busy(state.s) ? { s: 'failed', why: event.why, release: 'release' in state ? state.release : null, manifest: 'manifest' in state ? state.manifest : null } : state;
    case 'present':
      return busy(state.s) ? state : { s: 'installed', installed: event.installed };
    case 'removed':
      return busy(state.s) ? state : { s: 'unknown' };
  }
}

/** How long the notice waits for a check before it shows without Chord Player (it's added when the answer comes). */
export const CHECK_WAIT_MS = 3000;

/**
 * What the DRM notice offers in a state: `pending` while a check is young
 * (the card waits, to arrive whole), null when there's nothing to offer.
 * `opening`: the page is on its way into the player.
 */
export function offerFor(state: InstallState, { now, opening }: { now: number; opening: boolean }): PlayerOffer | null | 'pending' {
  switch (state.s) {
    case 'unknown':
      return 'pending';
    case 'checking':
      return now - state.since < CHECK_WAIT_MS ? 'pending' : null;
    case 'unavailable':
      return null;
    case 'available':
      return { state: 'install', size: state.manifest.size, update: state.update };
    case 'downloading':
      return { state: 'installing', phase: 'downloading', percent: Math.floor((state.received / state.manifest.size) * 100) };
    case 'verifying':
      return { state: 'installing', phase: 'checking', percent: 100 };
    case 'unpacking':
      return { state: 'installing', phase: 'unpacking', percent: state.percent };
    case 'installed':
      return opening ? { state: 'opening' } : { state: 'ready' };
    case 'failed':
      return { state: 'failed', why: state.why };
  }
}
