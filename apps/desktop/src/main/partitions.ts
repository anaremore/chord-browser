/**
 * #315: each profile's sign-ins in the folder its partition is named for now. Electron keeps `persist:<name>` in
 * `<userData>/Partitions/<name in lower case>` on every platform, so before #315 `Work` and `work` shared `p-work`.
 * profilePartition now escapes ids one-to-one (`Work` → `persist:p-_work`); a profile whose folder changed name has its
 * sign-ins moved there at launch, before any of its sessions is made (nothing has the folders open).
 *
 * - **Only the profiles migration 25 listed move** (`partition_move`): the ones in a folder of the old naming. Each comes
 *   off the list once moved. A profile that arrives later (sync, import) was never in an old folder, so it never moves
 *   and never takes a twin's sign-ins (Opus on #329).
 * - **Longest new name first.** A move's new folder can be another's old one (`Work`'s `p-_work` is `_work`'s), and a new
 *   name is always longer than its old one, so moving the longest first empties each folder before something moves in.
 * - Copied while another profile still needs the old folder (a case twin, or one in use that keeps it), renamed for
 *   the last. A copy goes through `.migrating-<new>`, renamed into place whole: only a complete copy ever has a `p-*`
 *   name; what a crash left there goes first, at the next launch. Caches aren't copied.
 * - **A new folder already there** (a crashed launch's copy, or a profile deleted before #315) isn't anyone's now: it's
 *   removed before the move, never opened as this profile's.
 * - **A move that fails** (a locked file, a full disk, any error but "not there") leaves that profile on its old folder
 *   this launch, through `fallbackPartition` (a Session of its own), and its old folder is then occupied: nothing moves
 *   into it. It stays on the list, and the next launch tries again.
 */
import { cp, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_PROFILE, isId, isPrivateProfile, profilePartition } from '@chord/core';

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
 * The partition a profile whose sign-ins couldn't be moved runs on this launch: its old folder (Electron lowercases
 * `P-Work` to `p-work`), as a Session of its own. A capital `P`, so it's never any profile's `profilePartition`
 * (all `persist:p-…` or `persist:default`), which would hand both the same Session (Neon's B2 on #329).
 */
export const fallbackPartition = (profileId: string): string => `persist:P-${profileId}`;

/** A profile whose sign-ins are kept apart, by an id a folder can be named from (never `..` or a path). */
const ownProfile = (id: string): boolean => id !== DEFAULT_PROFILE && isId(id) && !isPrivateProfile(id);

export interface PartitionMoves {
  /** The profiles that couldn't be moved this launch, and the partition each runs on instead. */
  fallbacks: Map<string, string>;
  /** The profiles moved (or with nothing to move): off the list for good. */
  moved: string[];
}

/**
 * Moves the listed profiles' sign-ins (`moves`, migration 25's list) to their partitions' folders. `inUse`: every
 * profile a session may be made for this launch (chords' and extensions'); a listed one not in use is left listed.
 */
export async function migratePartitions(userData: string, moves: Iterable<string>, inUse: Iterable<string>, fs: PartitionFs = realFs): Promise<PartitionMoves> {
  const fallbacks = new Map<string, string>();
  const moved: string[] = [];
  const using = new Set([...inUse].filter(ownProfile));
  const listed = [...new Set(moves)].filter((id) => ownProfile(id) && using.has(id));
  if (!listed.length) return { fallbacks, moved };
  const root = join(userData, 'Partitions');
  /** Whether a folder is there; an error that isn't "not there" (permissions, a busy disk) throws. */
  const exists = (folder: string) =>
    fs.stat(join(root, folder)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      },
    );
  const fallBack = (id: string, error: unknown) => {
    console.error(`Moving ${id}'s sign-ins to their new folder failed; they stay where they were this launch:`, error);
    fallbacks.set(id, fallbackPartition(id));
  };

  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { fallbacks, moved: listed }; // No partitions: nothing to move.
    for (const id of listed) fallBack(id, error);
    return { fallbacks, moved };
  }
  // A copy a crash or a full disk cut short: never a profile's, and in the way of the next.
  for (const name of names) if (name.startsWith(STAGING)) await fs.rm(join(root, name), { recursive: true, force: true }).catch(() => {});

  const plan = listed.map((id) => ({ id, next: partitionFolder(profilePartition(id)), old: `p-${id.toLowerCase()}` }));
  // Folders in use by a profile that doesn't move (its folder is its partition's now): never renamed away or written.
  const kept = new Set([...using].filter((id) => !listed.includes(id)).map((id) => partitionFolder(profilePartition(id))));
  // By old folder: how many listed profiles still need it (a failed move goes on needing it).
  const needing = new Map<string, number>();
  for (const m of plan) needing.set(m.old, (needing.get(m.old) ?? 0) + 1);
  // Old folders a profile runs on this launch, its move having failed: nothing moves into them.
  const occupied = new Set<string>();
  // Longest new name first (then by id, to be the same each launch).
  plan.sort((a, b) => b.next.length - a.next.length || (a.id < b.id ? -1 : 1));

  for (const { id, next, old } of plan) {
    if (next === old) {
      moved.push(id);
      continue;
    }
    if (occupied.has(next) || kept.has(next)) {
      fallBack(id, new Error(`${next} is still another profile's`));
      occupied.add(old);
      continue;
    }
    try {
      if (!(await exists(old))) {
        // Never signed in anywhere (or moved by a launch that ended before it said so): nothing to move.
        needing.set(old, needing.get(old)! - 1);
        moved.push(id);
        continue;
      }
      // Not anyone's now (a crashed launch's copy, or a profile deleted before #315): never opened as this one's.
      if (await exists(next)) await fs.rm(join(root, next), { recursive: true, force: true });
      const last = needing.get(old) === 1 && !kept.has(old);
      if (last) {
        await fs.rename(join(root, old), join(root, next));
      } else {
        const staging = join(root, `${STAGING}${next}`);
        const from = join(root, old);
        await fs.cp(from, staging, { recursive: true, filter: (path) => !CACHES.has(path.slice(from.length + 1).split(/[\\/]/)[0]!) });
        await fs.rename(staging, join(root, next));
      }
      needing.set(old, needing.get(old)! - 1);
      moved.push(id);
    } catch (error) {
      await fs.rm(join(root, `${STAGING}${next}`), { recursive: true, force: true }).catch(() => {});
      fallBack(id, error);
      occupied.add(old);
    }
  }
  return { fallbacks, moved };
}

/**
 * The folders sessions use, for removeUnusedPartitions: each profile in use's (its old one if it runs on that this
 * launch), and each session made's own, as Electron named it (its storagePath), so a live folder is never worked out
 * again from an id.
 */
export function foldersInUse(inUse: Iterable<string>, fallbacks: ReadonlyMap<string, string>, storagePaths: Iterable<string | null | undefined>): string[] {
  const folders = [...inUse].map((id) => partitionFolder(fallbacks.get(id) ?? profilePartition(id)));
  for (const path of storagePaths) if (path) folders.push(basename(path));
  return folders;
}
