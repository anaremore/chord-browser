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
 * - **Off the list as each moves** (`onMoved`, awaited before the next starts): a launch that dies mid-chain leaves
 *   listed only what hasn't moved, so the next never takes a moved profile's new folder for its old one. If that write
 *   fails, the sign-ins are in their new folder all the same (no fallback); the old folder is occupied for the rest of
 *   the launch, and next launch it's gone, so the lingering row moves nothing (Neon's B1-R2 on #329).
 */
import { cp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_PROFILE, isId, isPrivateProfile, profilePartition } from '@chord/core';

/** What the move does on disk: node:fs/promises', stood in for by tests. */
export interface PartitionFs {
  readdir: typeof readdir;
  rm: typeof rm;
  rename: typeof rename;
  cp: typeof cp;
  stat: typeof stat;
  writeFile: typeof writeFile;
}

const realFs: PartitionFs = { readdir, rm, rename, cp, stat, writeFile };

/** Development and tests only (CHORD_E2E_PARTITION_MOVE_FAIL): the file system, with `profileId`'s copy and rename failing. */
export function partitionFsFailingFor(profileId: string): PartitionFs {
  const target = partitionFolder(profilePartition(profileId));
  const theirs = (to: unknown) => basename(String(to)) === target || basename(String(to)) === `${STAGING}${target}`;
  const refuse = () => Promise.reject(Object.assign(new Error(`EBUSY: ${profileId}'s move held (CHORD_E2E_PARTITION_MOVE_FAIL)`), { code: 'EBUSY' }));
  return {
    ...realFs,
    cp: ((from: string, to: string, options: unknown) => (theirs(to) ? refuse() : cp(from, to, options as never))) as typeof cp,
    rename: ((from: string, to: string) => (theirs(to) ? refuse() : rename(from, to))) as typeof rename,
  };
}

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

/** A fallback whose old folder another Session uses this launch: kept in memory, so it never shares the folder. */
export const inMemoryFallback = (profileId: string): string => `P-${profileId}`;

/** A profile whose sign-ins are kept apart, by an id a folder can be named from (never `..` or a path). */
const ownProfile = (id: string): boolean => id !== DEFAULT_PROFILE && isId(id) && !isPrivateProfile(id);

export interface PartitionMoves {
  /** The profiles that couldn't be moved this launch, and the partition each runs on instead. */
  fallbacks: Map<string, string>;
  /** The profiles moved (or with nothing to move): off the list for good. */
  moved: string[];
}

/** Written into a new folder before it gets its name: whose it is, so a later launch knows it moved (Opus on #329). */
export const MOVED_MARKER = '.chord-moved';

/**
 * Moves the listed profiles' sign-ins (`moves`, migration 25's list) to their partitions' folders. `inUse`: every
 * profile a session may be made for this launch (chords' and extensions'). A listed one not in use counts as moved
 * (its sign-ins are no chord's, and the cleanup deletes them): one that comes back later never takes a twin's.
 * `onMoved` takes a profile off the list, awaited as each moves, before the next starts.
 */
export async function migratePartitions(
  userData: string,
  moves: Iterable<string>,
  inUse: Iterable<string>,
  fs: PartitionFs = realFs,
  onMoved: (profileId: string) => Promise<void> = async () => {},
): Promise<PartitionMoves> {
  const fallbacks = new Map<string, string>();
  const moved: string[] = [];
  const using = new Set([...inUse].filter(ownProfile));
  const all = [...new Set(moves)].filter(ownProfile);
  // Old folders a profile runs on this launch (its move failed), or one whose row didn't come off: nothing moves in.
  const occupied = new Set<string>();
  /** Moved (or nothing to move): off the list now, before the next move starts. */
  const done = async (id: string, old: string) => {
    moved.push(id);
    try {
      await onMoved(id);
    } catch (error) {
      console.error(`Recording that ${id}'s sign-ins moved failed; nothing moves into its old folder this launch, and the next launch finds it moved:`, error);
      occupied.add(old);
    }
  };
  // Listed but not in use: nothing to move for anyone (Neon's SF1-R2, Opus's S1 on #329).
  for (const id of all) if (!using.has(id)) await done(id, `p-${id.toLowerCase()}`);
  const listed = all.filter((id) => using.has(id));
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
  /** Whose a folder's marker says it is, or null (none, or unreadable). */
  const markerOf = (folder: string) => readFile(join(root, folder, MOVED_MARKER), 'utf8').then((s) => s.trim(), () => null);
  const failed: { id: string; old: string }[] = [];
  const fallBack = (id: string, old: string, error: unknown) => {
    console.error(`Moving ${id}'s sign-ins to their new folder failed; they stay where they were this launch:`, error);
    failed.push({ id, old });
    occupied.add(old);
  };

  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // No partitions at all: nothing to move.
      for (const id of listed) await done(id, `p-${id.toLowerCase()}`);
      return { fallbacks, moved };
    }
    for (const id of listed) fallBack(id, `p-${id.toLowerCase()}`, error);
    return { fallbacks: inMemoryWhereShared(failed, new Set()), moved };
  }
  // A copy a crash or a full disk cut short: never a profile's, and in the way of the next.
  for (const name of names) if (name.startsWith(STAGING)) await fs.rm(join(root, name), { recursive: true, force: true }).catch(() => {});

  const plan = listed.map((id) => ({ id, next: partitionFolder(profilePartition(id)), old: `p-${id.toLowerCase()}` }));
  // Folders in use by a profile that doesn't move (its folder is its partition's now): never renamed away or written.
  const kept = new Set([...using].filter((id) => !listed.includes(id)).map((id) => partitionFolder(profilePartition(id))));
  // By old folder: how many listed profiles still need it (a failed move goes on needing it).
  const needing = new Map<string, number>();
  for (const m of plan) needing.set(m.old, (needing.get(m.old) ?? 0) + 1);
  // Longest new name first (then by id, to be the same each launch).
  plan.sort((a, b) => b.next.length - a.next.length || (a.id < b.id ? -1 : 1));

  for (const { id, next, old } of plan) {
    if (next === old) {
      await done(id, old);
      continue;
    }
    if (occupied.has(next) || kept.has(next)) {
      fallBack(id, old, new Error(`${next} is still another profile's`));
      continue;
    }
    try {
      if (await exists(next)) {
        // Its own, moved by a launch that ended before the list said so: moved.
        if ((await markerOf(next)) === id) {
          needing.set(old, needing.get(old)! - 1);
          await done(id, old);
          continue;
        }
        // Not this one's (a half copy, or a profile deleted before #315): never opened as its, whether or not `old` is there.
        await fs.rm(join(root, next), { recursive: true, force: true });
      }
      if (!(await exists(old))) {
        // Never signed in anywhere: nothing to move.
        needing.set(old, needing.get(old)! - 1);
        await done(id, old);
        continue;
      }
      const last = needing.get(old) === 1 && !kept.has(old);
      if (last) {
        // The marker travels with the folder: once it has its new name, it says whose it is.
        await fs.writeFile(join(root, old, MOVED_MARKER), id);
        await fs.rename(join(root, old), join(root, next));
      } else {
        const staging = join(root, `${STAGING}${next}`);
        const from = join(root, old);
        await fs.cp(from, staging, { recursive: true, filter: (path) => !CACHES.has(path.slice(from.length + 1).split(/[\\/]/)[0]!) && !path.endsWith(MOVED_MARKER) });
        await fs.writeFile(join(staging, MOVED_MARKER), id);
        await fs.rename(staging, join(root, next));
      }
      needing.set(old, needing.get(old)! - 1);
    } catch (error) {
      await fs.rm(join(root, `${STAGING}${next}`), { recursive: true, force: true }).catch(() => {});
      fallBack(id, old, error);
      continue;
    }
    await done(id, old);
  }
  return { fallbacks: inMemoryWhereShared(failed, kept), moved };
}

/**
 * The partitions the profiles that couldn't move run on this launch: their old folder (`persist:P-…`) when it's theirs
 * alone; otherwise, when a profile that doesn't move keeps it or another fallback took it first, one in memory
 * (`P-…`): signed out this launch, writing nothing. Two Sessions on one folder diverge, and Chromium can't close them
 * (quitting hung for minutes; Opus on #329).
 */
function inMemoryWhereShared(failed: readonly { id: string; old: string }[], kept: ReadonlySet<string>): Map<string, string> {
  const fallbacks = new Map<string, string>();
  const taken = new Set(kept);
  for (const { id, old } of failed) {
    if (taken.has(old)) {
      fallbacks.set(id, inMemoryFallback(id));
      continue;
    }
    taken.add(old);
    fallbacks.set(id, fallbackPartition(id));
  }
  return fallbacks;
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
