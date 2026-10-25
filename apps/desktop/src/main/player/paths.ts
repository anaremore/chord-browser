/**
 * Where Chord Player lives on this computer (ARCHITECTURE.md §9, Chord
 * Player): per user, no installer, nothing registered with the OS.
 *
 *   <root>/state.json       which version runs, one waiting to start, ones that failed to
 *   <root>/<version>/       each version, unpacked from its zip
 *   <root>/Profile/         the player's own profile: its sign-ins and the Widevine CDM
 *   <root>/Downloads/       a zip on its way in (removed once unpacked)
 *
 * Removing Chord Player removes the root, sign-ins and all.
 */
import { join } from 'node:path';

export interface PathEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Development builds keep their own player, as they keep their own profile ("Chord Dev"). */
  packaged: boolean;
}

export function playerRoot({ platform, home, env, packaged }: PathEnv): string {
  // Development and tests only: a throwaway folder.
  if (!packaged && env['CHORD_PLAYER_ROOT']) return env['CHORD_PLAYER_ROOT'];
  const name = packaged ? 'Chord Player' : 'Chord Player Dev';
  if (platform === 'win32') return join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), name);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', name);
  return join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), packaged ? 'chord-player' : 'chord-player-dev');
}

export const profileDir = (root: string): string => join(root, 'Profile');
export const downloadsDir = (root: string): string => join(root, 'Downloads');
export const versionDir = (root: string, version: string): string => join(root, version);
export const stateFile = (root: string): string => join(root, 'state.json');
