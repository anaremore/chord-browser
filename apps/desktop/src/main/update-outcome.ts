/**
 * A Windows update that setup couldn't install (issue #142; build/installer.nsh, customUnInstallCheck). The
 * in-app updater runs setup silently, so setup can't say why it stopped: it puts the old version back, leaves
 * this file in the profile folder ("agent" when an agent's relay still held Chord's files, else "other") and
 * reopens Chord, which says it once.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_FAILED_FILE = 'Update Failed';

/** What to tell the user, once (the file goes as it's read); null when the last update didn't fail. */
export function takeUpdateFailure(userData: string): string | null {
  const file = join(userData, UPDATE_FAILED_FILE);
  let why: string;
  try {
    why = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  return why === 'agent'
    ? 'Chord couldn’t update: an agent connected to Chord was still using its files. Close the agent, then restart Chord to update.'
    : 'Chord couldn’t update: another program was still using its files. Restart your computer, then open Chord to update.';
}
