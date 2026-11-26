/**
 * #315: each profile's sign-ins in the folder its partition is named for now. Electron keeps `persist:<name>` in
 * `<userData>/Partitions/<name in lower case>` on every platform, so before #315 `Work` and `work` shared `p-work`.
 * profilePartition now escapes ids one-to-one (`Work` → `persist:p-_work`); a profile whose folder changed name has its
 * sign-ins moved there at launch, before any of its sessions is made (nothing has the folders open).
 *
 * - Copied while another profile in use still needs the old folder (a case twin), renamed for the last that does. A
 *   twin whose new folder IS the old one (`work`, all lower case, no `_`) keeps it and moves nothing.
 * - A copy goes through `.migrating-<new>`, renamed into place whole: only a complete copy ever has a `p-*` name.
 *   Whatever a crash or a full disk left there is removed first, at the next launch. Caches aren't copied.
 * - A move that fails (a locked file, a full disk) leaves that profile on its old partition this launch:
 *   `persist:p-${id}` with its case, a Session of its own (`persist:p-work` would be its twin's), whose folder is still
 *   the old one. It keeps needing that folder, so no twin renames it away; the next launch tries again.
 */
import { cp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROFILE, isPrivateProfile, profilePartition } from '@chord/core';

/** What the move does on disk: node:fs/promises', stood in for by tests. */
export interface PartitionFs {
  readdir: typeof readdir;
  rm: typeof rm;
  rename: typeof rename;
  cp: typeof cp;
  stat: typeof stat;
}

const realFs: PartitionFs = { readdir, rm, rename, cp, stat };

/** Chromium's caches in a partition: made again as pages load, so a copy leaves them behind. */
const CACHES = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'GrShaderCache']);

const STAGING = '.migrating-';

/** The folder under Partitions that Electron keeps a persistent partition in: its name in lower case. */
export const partitionFolder = (partition: string): string => partition.replace(/^persist:/, '').toLowerCase();

/**
 * Moves each profile's sign-ins to its partition's folder, and returns the profiles that couldn't be moved this launch,
 * with the partition each runs on instead (its old one). `profiles`: every profile a session may be made for this
 * launch (chords' and extensions').
 */
export async function migratePartitions(userData: string, profiles: Iterable<string>, fs: PartitionFs = realFs): Promise<Map<string, string>> {
  const fallbacks = new Map<string, string>();
  const root = join(userData, 'Partitions');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return fallbacks; // No partitions yet: a first launch.
  }
  // A copy a crash or a full disk cut short: never a profile's, and in the way of the next.
  for (const name of names) if (name.startsWith(STAGING)) await fs.rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  const exists = async (folder: string) =>
    fs.stat(join(root, folder)).then(
      () => true,
      () => false,
    );

  const ids = [...new Set(profiles)].filter((id) => id !== DEFAULT_PROFILE && !isPrivateProfile(id)).sort();
  // A folder some profile's partition is named for now (a twin keeping it): never renamed away.
  const kept = new Set(ids.map((id) => partitionFolder(profilePartition(id))));
  // By old folder: the profiles whose sign-ins are still only there.
  const needing = new Map<string, { id: string; next: string }[]>();
  for (const id of ids) {
    const next = partitionFolder(profilePartition(id));
    const old = `p-${id.toLowerCase()}`;
    if (next === old || !(await exists(old)) || (await exists(next))) continue;
    needing.set(old, [...(needing.get(old) ?? []), { id, next }]);
  }

  for (const [old, waiting] of needing) {
    // How many still need the old folder: one whose move fails runs on it, so it goes on needing it.
    let left = waiting.length;
    for (const { id, next } of waiting) {
      const last = left === 1 && !kept.has(old);
      try {
        if (last) {
          await fs.rename(join(root, old), join(root, next));
        } else {
          const staging = join(root, `${STAGING}${next}`);
          await fs.cp(join(root, old), staging, { recursive: true, filter: (from) => !CACHES.has(from.slice(join(root, old).length + 1).split(/[\\/]/)[0]!) });
          await fs.rename(staging, join(root, next));
        }
        left -= 1;
      } catch (error) {
        await fs.rm(join(root, `${STAGING}${next}`), { recursive: true, force: true }).catch(() => {});
        console.error(`Moving ${id}'s sign-ins to their new folder failed; they stay where they were this launch:`, error);
        fallbacks.set(id, `persist:p-${id}`);
      }
    }
  }
  return fallbacks;
}
