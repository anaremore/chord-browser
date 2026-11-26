/**
 * #315: at launch, before any profile's session is made, the profiles migration 25 listed get their sign-ins in their
 * partition's new folder. Longest new name first (a new folder can be another's old one), copied while another still
 * needs the old one, renamed for the last; through `.migrating-<new>`; a stale new folder removed, never opened; a
 * failed move runs that profile on its old folder (`fallbackPartition`) and nothing moves into that folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { profilePartition } from '@chord/core';
import { fallbackPartition, foldersInUse, inMemoryFallback, migratePartitions, MOVED_MARKER, partitionFolder, type PartitionFs } from '../../src/main/partitions';
import { removeUnusedPartitions } from '../../src/main/persistence';

const dirs: string[] = [];
beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A userData whose Partitions holds these folders, each with a `Cookies` file saying whose it is, and a cache. */
function userData(folders: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
  dirs.push(root);
  mkdirSync(join(root, 'Partitions'), { recursive: true });
  for (const [folder, owner] of Object.entries(folders)) {
    mkdirSync(join(root, 'Partitions', folder, 'Cache'), { recursive: true });
    writeFileSync(join(root, 'Partitions', folder, 'Cookies'), owner);
    writeFileSync(join(root, 'Partitions', folder, 'Cache', 'data_0'), 'cached');
  }
  return root;
}
const partitionsDir = (root: string) => join(root, 'Partitions');
const cookies = (root: string, folder: string) => (existsSync(join(partitionsDir(root), folder, 'Cookies')) ? readFileSync(join(partitionsDir(root), folder, 'Cookies'), 'utf8') : null);
const folderOf = (id: string) => partitionFolder(profilePartition(id));
/** The sign-ins a profile opens now: its new folder, or its old one through its fallback. */
const opens = (root: string, id: string, fallbacks: ReadonlyMap<string, string>) => cookies(root, partitionFolder(fallbacks.get(id) ?? profilePartition(id)));
const listed = (root: string) => readdirSync(partitionsDir(root)).sort();

/** The real file system, with `cp` or `rename` failing for the targets `fail` names. */
function failing(fail: { cp?: (to: string) => boolean; rename?: (from: string, to: string) => boolean }): PartitionFs {
  return {
    ...fsp,
    cp: async (from, to, options) => {
      if (fail.cp?.(String(to))) {
        // A copy that dies part-way: its first file is written, then the disk is full.
        await fsp.mkdir(String(to), { recursive: true });
        await fsp.writeFile(join(String(to), 'Cookies'), 'half');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return fsp.cp(from, to, options);
    },
    rename: async (from, to) => {
      if (fail.rename?.(String(from), String(to))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fsp.rename(from, to);
    },
  };
}

describe('migratePartitions (#315)', () => {
  it('nothing listed (every launch after the move, and every profile Chord made): nothing moves or is even looked at', async () => {
    const id = '01a21619-df80-7e66-9577-09ceec5d0a05';
    const root = userData({ [`p-${id}`]: id });
    const readdir = vi.fn(fsp.readdir);
    expect(await migratePartitions(root, [], [id, 'Work'], { ...fsp, readdir } as unknown as PartitionFs)).toEqual({ fallbacks: new Map(), moved: [] });
    expect(readdir).not.toHaveBeenCalled();
  });

  it('`Work` alone: its folder renamed, its sign-ins kept; off the list', async () => {
    const root = userData({ 'p-work': 'Work' });
    expect(await migratePartitions(root, ['Work'], ['Work'])).toEqual({ fallbacks: new Map(), moved: ['Work'] });
    expect(cookies(root, folderOf('Work'))).toBe('Work');
    expect(listed(root)).toEqual([folderOf('Work')]);
  });

  it('`Work` and `work`: `work` keeps `p-work`, `Work` gets a copy (no caches)', async () => {
    const root = userData({ 'p-work': 'shared' });
    await migratePartitions(root, ['Work'], ['Work', 'work']);
    expect(cookies(root, 'p-work')).toBe('shared');
    expect(cookies(root, folderOf('Work'))).toBe('shared');
    expect(existsSync(join(partitionsDir(root), folderOf('Work'), 'Cache'))).toBe(false);
  });

  it.each([
    ['Work', 'WORK'],
    ['work_1', 'Work_1'],
  ])('twins %j and %j, neither keeping the old folder: each gets the sign-ins; the last renames it', async (a, b) => {
    const old = `p-${a.toLowerCase()}`;
    const root = userData({ [old]: 'shared' });
    const { fallbacks } = await migratePartitions(root, [a, b], [a, b]);
    expect(fallbacks).toEqual(new Map());
    expect(cookies(root, folderOf(a))).toBe('shared');
    expect(cookies(root, folderOf(b))).toBe('shared');
    expect(existsSync(join(partitionsDir(root), old))).toBe(false);
  });

  it.each([
    // One's new folder is the other's old one (Neon's and Opus's B1 on #329): each keeps its own.
    [['_work', 'Work'], { 'p-_work': '_work', 'p-work': 'Work' }],
    [['aB', 'a_b'], { 'p-a_b': 'a_b', 'p-ab': 'aB' }],
    [['a_b', 'a__b'], { 'p-a_b': 'a_b', 'p-a__b': 'a__b' }],
    [['_work', '__work', 'Work'], { 'p-_work': '_work', 'p-__work': '__work', 'p-work': 'Work' }],
  ] as const)('%j: a chain of folders, each profile ends with exactly its own sign-ins', async (ids, folders) => {
    const root = userData(folders);
    const { fallbacks, moved } = await migratePartitions(root, ids, ids);
    expect(fallbacks).toEqual(new Map());
    expect([...moved].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(opens(root, id, fallbacks), id).toBe(id);
  });

  it('a stale new folder (a profile deleted before #315 left `p-a_b`): removed, never opened as `aB`’s', async () => {
    const root = userData({ 'p-a_b': 'someone gone', 'p-ab': 'aB' });
    const { fallbacks } = await migratePartitions(root, ['aB'], ['aB']);
    expect(opens(root, 'aB', fallbacks)).toBe('aB');
  });

  it('`_work`’s move fails while `Work` is to move into its folder: both stay on their old folders, nothing overwritten (Neon’s occupied)', async () => {
    const root = userData({ 'p-_work': '_work', 'p-work': 'Work' });
    const { fallbacks, moved } = await migratePartitions(root, ['_work', 'Work'], ['_work', 'Work'], failing({ rename: (from) => from.endsWith('p-_work') }));
    expect(fallbacks).toEqual(
      new Map([
        ['_work', fallbackPartition('_work')],
        ['Work', fallbackPartition('Work')],
      ]),
    );
    expect(moved).toEqual([]);
    expect(opens(root, '_work', fallbacks)).toBe('_work');
    expect(opens(root, 'Work', fallbacks)).toBe('Work');
  });

  it('a crash mid-chain (after `_work` moved, before `Work` did, and before either came off the list): the relaunch finishes it', async () => {
    // As the crash left it: `_work` renamed into `p-__work` (its marker with it, written before the rename), `Work`
    // still in `p-work`, both still listed (the crash came before the list's write).
    const root = userData({ 'p-__work': '_work', 'p-work': 'Work' });
    writeFileSync(join(partitionsDir(root), 'p-__work', MOVED_MARKER), '_work');
    const { fallbacks, moved } = await migratePartitions(root, ['_work', 'Work'], ['_work', 'Work']);
    expect(fallbacks).toEqual(new Map());
    expect([...moved].sort()).toEqual(['Work', '_work']);
    expect(opens(root, '_work', fallbacks)).toBe('_work');
    expect(opens(root, 'Work', fallbacks)).toBe('Work');
  });

  it('a half copy (no marker: the launch died before it had its name): removed, and copied again from the old folder', async () => {
    const root = userData({ 'p-work': 'shared', [folderOf('Work')]: 'half', [`.migrating-${folderOf('Work')}`]: 'half' });
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work', 'work']);
    expect(opens(root, 'Work', fallbacks)).toBe('shared');
    expect(listed(root)).toEqual([folderOf('Work'), 'p-work'].sort());
  });

  it('`Work` arriving after the upgrade (sync, import): never listed, so it gets nothing of `work`’s (Opus’s SF1 on #329)', async () => {
    const root = userData({ 'p-work': 'work' });
    const { fallbacks } = await migratePartitions(root, [], ['Work', 'work']);
    expect(opens(root, 'Work', fallbacks)).toBeNull();
    expect(cookies(root, 'p-work')).toBe('work');
  });

  it('one twin’s copy fails (ENOSPC) and it falls back: the other copies instead of renaming the folder away (Argon’s note 1)', async () => {
    const root = userData({ 'p-work': 'shared' });
    let copies = 0;
    const { fallbacks } = await migratePartitions(root, ['Work', 'WORK'], ['Work', 'WORK'], failing({ cp: () => ++copies === 1 }));
    expect(fallbacks.size).toBe(1);
    const [failed] = [...fallbacks.keys()];
    const other = failed === 'Work' ? 'WORK' : 'Work';
    expect(opens(root, other, fallbacks)).toBe('shared');
    expect(opens(root, failed!, fallbacks)).toBe('shared');
    expect(listed(root).filter((f) => f.startsWith('.migrating-'))).toEqual([]);
  });

  it('a stat that fails for another reason than "not there" (EACCES): that profile falls back, its folder never deleted (Neon’s N1)', async () => {
    const root = userData({ 'p-work': 'Work' });
    const fs: PartitionFs = { ...fsp, stat: (async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))) as unknown as PartitionFs['stat'] };
    const { fallbacks, moved } = await migratePartitions(root, ['Work'], ['Work'], fs);
    expect(fallbacks).toEqual(new Map([['Work', fallbackPartition('Work')]]));
    expect(moved).toEqual([]);
    await removeUnusedPartitions(root, foldersInUse(['Work'], fallbacks, []));
    expect(cookies(root, 'p-work')).toBe('Work');
  });

  it('a listed profile not in use this launch: counts as moved (nothing is); an id no folder can be named from: never touched', async () => {
    const root = userData({ 'p-work': 'Work' });
    expect(await migratePartitions(root, ['Work', '../../x', 'private-w1'], ['../../x', 'private-w1'])).toEqual({ fallbacks: new Map(), moved: ['Work'] });
    expect(cookies(root, 'p-work')).toBe('Work');
  });

  it('`Work` listed but not in use, then back by sync the launch after: it gets nothing of `work`’s (Neon’s SF1-R2, Opus’s S1 on #329)', async () => {
    const root = userData({ 'p-work': 'work' });
    const rows = ['Work'];
    await migratePartitions(root, [...rows], ['work'], fsp as unknown as PartitionFs, async (id) => void rows.splice(rows.indexOf(id), 1));
    expect(rows).toEqual([]);
    const { fallbacks } = await migratePartitions(root, [...rows], ['Work', 'work']);
    expect(opens(root, 'Work', fallbacks)).toBeNull();
    expect(cookies(root, 'p-work')).toBe('work');
  });

  it('a whole copy whose row didn’t come off (Opus’s S2a): its marker says it moved; the next launch leaves it, with what was signed in since', async () => {
    const root = userData({ 'p-work': 'shared' });
    // Launch 1: Work's copy lands with its marker, and the list's write fails.
    await migratePartitions(root, ['Work'], ['Work', 'work'], fsp as unknown as PartitionFs, async () => Promise.reject(new Error('gone')));
    expect(readFileSync(join(partitionsDir(root), folderOf('Work'), MOVED_MARKER), 'utf8')).toBe('Work');
    // Work signs in somewhere new during that launch.
    writeFileSync(join(partitionsDir(root), folderOf('Work'), 'Cookies'), 'Work-own');
    // Launch 2, its row still listed: moved already, left as it is.
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work', 'work']);
    expect(opens(root, 'Work', fallbacks)).toBe('Work-own');
    expect(cookies(root, 'p-work')).toBe('shared');
  });

  it('a stale new folder with no old one (`p-a_b` left by a profile gone before #315, `aB` never signed in): removed, never opened as `aB`’s (Opus’s S2b)', async () => {
    const root = userData({ 'p-a_b': 'someone gone' });
    const { fallbacks } = await migratePartitions(root, ['aB'], ['aB']);
    expect(opens(root, 'aB', fallbacks)).toBeNull();
  });

  it('a renamed folder carries its marker; a copy gets its own, never its source’s', async () => {
    const root = userData({ 'p-work': 'shared' });
    await migratePartitions(root, ['Work', 'WORK'], ['Work', 'WORK']);
    for (const id of ['Work', 'WORK']) expect(readFileSync(join(partitionsDir(root), folderOf(id), MOVED_MARKER), 'utf8')).toBe(id);
  });

  it('no Partitions folder yet (never signed in anywhere): nothing to move, off the list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
    dirs.push(root);
    expect(await migratePartitions(root, ['Work'], ['Work'])).toEqual({ fallbacks: new Map(), moved: ['Work'] });
  });
});

describe('a fallback never shares its folder with another live Session (Opus’s blocker on #329 round 2)', () => {
  it('a twin’s copy fails while `work` keeps `p-work`: in memory this launch (signed out, nothing written); `p-work` stays `work`’s', async () => {
    const root = userData({ 'p-work': 'shared' });
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work', 'work'], failing({ cp: () => true }));
    expect(fallbacks).toEqual(new Map([['Work', inMemoryFallback('Work')]]));
    expect(inMemoryFallback('Work').startsWith('persist:')).toBe(false);
    expect(cookies(root, 'p-work')).toBe('shared');
  });

  it('a profile alone in its old folder whose move fails: that folder, kept on disk (persist:P-…)', async () => {
    const root = userData({ 'p-work': 'Work' });
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work'], failing({ rename: () => true }));
    expect(fallbacks).toEqual(new Map([['Work', fallbackPartition('Work')]]));
  });

  it('two twins both failing on one old folder: the first keeps it on disk, the second in memory', async () => {
    const root = userData({ 'p-work': 'shared' });
    const { fallbacks } = await migratePartitions(root, ['Work', 'WORK'], ['Work', 'WORK'], failing({ cp: () => true, rename: () => true }));
    expect([...fallbacks.values()].sort()).toEqual([fallbackPartition('WORK'), inMemoryFallback('Work')].sort());
  });
});

describe('fallbackPartition (Neon’s B2 on #329)', () => {
  it('never any profile’s partition: a Session of its own, in the old folder', () => {
    for (const id of ['_work', 'Work', 'work', 'a_b', 'aB', '__', 'x']) {
      for (const other of ['_work', 'Work', 'work', 'a_b', 'aB', '__', 'x', 'default']) expect(fallbackPartition(id)).not.toBe(profilePartition(other));
      expect(partitionFolder(fallbackPartition(id))).toBe(`p-${id.toLowerCase()}`);
    }
  });
});

describe('foldersInUse (Neon’s SF2 on #329)', () => {
  it('each profile’s folder (its fallback’s if it has one), and each session’s own, by its storagePath', () => {
    expect(foldersInUse(['Work', 'abc'], new Map([['Work', fallbackPartition('Work')]]), ['/u/Partitions/p-xyz', null, undefined])).toEqual(['p-work', 'p-abc', 'p-xyz']);
  });
});

describe('the move list comes off one profile at a time, as each moves (Neon’s B1-R2 on #329)', () => {
  /** Migration 25's list, kept by the test: `onMoved` takes an id off it, as chord-data's partition.moved does. */
  const list = (ids: string[]) => {
    const rows = [...ids];
    return { rows, onMoved: async (id: string) => void rows.splice(rows.indexOf(id), 1) };
  };

  it('(a) a crash mid-chain (`__work`, `_work`, `Work`; the third move never finishes): the relaunch gives each its own', async () => {
    const root = userData({ 'p-__work': '__work', 'p-_work': '_work', 'p-work': 'Work' });
    const ids = ['__work', '_work', 'Work'];
    const moves = list(ids);
    let renames = 0;
    // The launch dies in its third move: that rename never answers.
    const dying: PartitionFs = { ...fsp, rename: (from, to) => (++renames === 3 ? new Promise<void>(() => {}) : fsp.rename(from, to)) };
    void migratePartitions(root, moves.rows, ids, dying, moves.onMoved);
    await vi.waitFor(() => expect(renames).toBe(3));
    // Each came off the list as it moved: only the one that never finished is still listed (Neon's SF2-R3 on #329).
    expect(moves.rows).toEqual(['Work']);
    // Relaunch: what's still listed moves, on the same disk.
    const { fallbacks } = await migratePartitions(root, [...moves.rows], ids, fsp as unknown as PartitionFs, moves.onMoved);
    for (const id of ids) expect(opens(root, id, fallbacks), id).toBe(id);
  });

  it('(b) the list’s write fails (`_work` moved, its row stays): nothing moves into its old folder this launch, and the next launch gives each its own', async () => {
    const root = userData({ 'p-_work': '_work', 'p-work': 'Work' });
    const ids = ['_work', 'Work'];
    const rows = [...ids];
    const failingWrite = async () => Promise.reject(new Error('chord-data is gone'));
    const first = await migratePartitions(root, [...rows], ids, fsp as unknown as PartitionFs, failingWrite);
    // `_work` moved: its sign-ins are in its new folder, not a fallback, and its old folder is gone. Its row stayed, so
    // the old folder is occupied: `Work` doesn't move into it this launch (Neon's SF2-R3 on #329).
    expect(first.fallbacks.has('_work')).toBe(false);
    expect(existsSync(join(partitionsDir(root), 'p-_work'))).toBe(false);
    expect(first.fallbacks.get('Work')).toBe(fallbackPartition('Work'));
    for (const id of ids) expect(opens(root, id, first.fallbacks), id).toBe(id);
    // Next launch, its row (and Work's, if Work didn't move) still listed; the write works now.
    const moves = list(rows);
    const { fallbacks } = await migratePartitions(root, [...moves.rows], ids, fsp as unknown as PartitionFs, moves.onMoved);
    expect(fallbacks).toEqual(new Map());
    for (const id of ids) expect(opens(root, id, fallbacks), id).toBe(id);
  });
});

describe('#329 round 3', () => {
  it('SF1-R3: Partitions can’t be read (EACCES): `Work` listed, `work` in use keeping `p-work`, so `Work` runs in memory, never on `work`’s folder', async () => {
    const root = userData({ 'p-work': 'shared' });
    const fs: PartitionFs = { ...fsp, readdir: (async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))) as unknown as PartitionFs['readdir'] };
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work', 'work'], fs);
    expect(fallbacks).toEqual(new Map([['Work', inMemoryFallback('Work')]]));
  });

  it('a marker that can’t be read for another reason than "not there": falls back, never removes the folder', async () => {
    const root = userData({ 'p-work': 'Work', [folderOf('Work')]: 'Work-own' });
    const fs: PartitionFs = {
      ...fsp,
      readFile: (async (path: string, options: unknown) =>
        String(path).endsWith(MOVED_MARKER) ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : fsp.readFile(path, options as never)) as unknown as PartitionFs['readFile'],
    };
    const { fallbacks } = await migratePartitions(root, ['Work'], ['Work'], fs);
    expect(fallbacks.has('Work')).toBe(true);
    expect(cookies(root, folderOf('Work'))).toBe('Work-own');
  });

  it('a copy leaves out only the old folder’s own marker, never a file of that name deeper in', async () => {
    const root = userData({ 'p-work': 'shared' });
    mkdirSync(join(partitionsDir(root), 'p-work', 'Local Storage'), { recursive: true });
    writeFileSync(join(partitionsDir(root), 'p-work', 'Local Storage', MOVED_MARKER), 'a site’s file');
    writeFileSync(join(partitionsDir(root), 'p-work', MOVED_MARKER), 'someone');
    await migratePartitions(root, ['Work'], ['Work', 'work']);
    expect(readFileSync(join(partitionsDir(root), folderOf('Work'), 'Local Storage', MOVED_MARKER), 'utf8')).toBe('a site’s file');
    expect(readFileSync(join(partitionsDir(root), folderOf('Work'), MOVED_MARKER), 'utf8')).toBe('Work');
  });
});

