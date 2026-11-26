/**
 * #315: at launch, before any profile's session is made, each profile whose partition folder changed name (its id has
 * upper case or `_`) gets its sign-ins in the new folder. Copied while another profile still needs the old one (a case
 * twin), through `.migrating-<new>` so only a whole copy ever gets a `p-*` name; renamed for the last. A profile whose
 * move fails runs this launch on its old partition (`persist:p-${id}`, case kept) and keeps its old folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profilePartition } from '@chord/core';
import { migratePartitions, partitionFolder, type PartitionFs } from '../../src/main/partitions';
import { removeUnusedPartitions } from '../../src/main/persistence';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A userData whose Partitions holds these folders, each with a `Cookies` file saying whose it is, and a cache. */
function userData(folders: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
  dirs.push(root);
  for (const [folder, owner] of Object.entries(folders)) {
    mkdirSync(join(root, 'Partitions', folder, 'Cache'), { recursive: true });
    writeFileSync(join(root, 'Partitions', folder, 'Cookies'), owner);
    writeFileSync(join(root, 'Partitions', folder, 'Cache', 'data_0'), 'cached');
  }
  return root;
}
const partitionsDir = (root: string) => join(root, 'Partitions');
const cookies = (root: string, folder: string) => (existsSync(join(partitionsDir(root), folder, 'Cookies')) ? readFileSync(join(partitionsDir(root), folder, 'Cookies'), 'utf8') : null);
const folderOf = (id: string) => profilePartition(id).replace(/^persist:/, '');
const listed = (root: string) => readdirSync(partitionsDir(root)).sort();

/** The real file system, with `cp` or `rename` failing for the targets `fail` names. */
function failing(fail: { cp?: (to: string) => boolean; rename?: (to: string) => boolean }): PartitionFs {
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
      if (fail.rename?.(String(to))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fsp.rename(from, to);
    },
  };
}

describe('migratePartitions (#315)', () => {
  it('Chord’s own ids: nothing moves, nothing falls back', async () => {
    const id = '01a21619-df80-7e66-9577-09ceec5d0a05';
    const root = userData({ [`p-${id}`]: id });
    expect(await migratePartitions(root, [id, 'default'])).toEqual(new Map());
    expect(listed(root)).toEqual([`p-${id}`]);
  });

  it('`Work` alone: its folder is renamed, its sign-ins kept', async () => {
    const root = userData({ 'p-work': 'Work' });
    expect(await migratePartitions(root, ['Work'])).toEqual(new Map());
    expect(cookies(root, folderOf('Work'))).toBe('Work');
    expect(listed(root)).toEqual([folderOf('Work')]);
  });

  it('`Work` and `work`: `work` keeps `p-work`, `Work` gets a copy (no caches)', async () => {
    const root = userData({ 'p-work': 'shared' });
    await migratePartitions(root, ['Work', 'work']);
    expect(cookies(root, 'p-work')).toBe('shared');
    expect(cookies(root, folderOf('Work'))).toBe('shared');
    expect(existsSync(join(partitionsDir(root), folderOf('Work'), 'Cache'))).toBe(false);
    expect(listed(root)).toEqual([folderOf('Work'), 'p-work'].sort());
  });

  it.each([
    ['Work', 'WORK'],
    ['work_1', 'Work_1'],
  ])('twins %j and %j, neither keeping the old folder: each gets the sign-ins, none starts empty (Argon’s B2)', async (a, b) => {
    const old = `p-${a.toLowerCase()}`;
    const root = userData({ [old]: 'shared' });
    expect(await migratePartitions(root, [a, b])).toEqual(new Map());
    expect(cookies(root, folderOf(a))).toBe('shared');
    expect(cookies(root, folderOf(b))).toBe('shared');
    // The last one renamed it: the old folder is gone.
    expect(existsSync(join(partitionsDir(root), old))).toBe(false);
  });

  it('already migrated: nothing moves; an old folder that isn’t there: nothing to do', async () => {
    const root = userData({ [folderOf('Work')]: 'Work', 'p-work': 'leftover' });
    expect(await migratePartitions(root, ['Work', 'Abc'])).toEqual(new Map());
    expect(cookies(root, folderOf('Work'))).toBe('Work');
    expect(cookies(root, 'p-work')).toBe('leftover');
    expect(existsSync(join(partitionsDir(root), folderOf('Abc')))).toBe(false);
  });

  it('a copy that dies part-way never leaves a `p-*`; what a crash left in `.migrating-*` goes at the next launch, which migrates (B3)', async () => {
    const root = userData({ 'p-work': 'shared' });
    const fallbacks = await migratePartitions(root, ['Work', 'work'], failing({ cp: () => true }));
    expect(fallbacks).toEqual(new Map([['Work', 'persist:p-Work']]));
    expect(listed(root)).toEqual(['p-work']);
    // A crash mid-copy (no catch to clean up): its half copy is still there at the next launch.
    mkdirSync(join(partitionsDir(root), `.migrating-${folderOf('Work')}`));
    writeFileSync(join(partitionsDir(root), `.migrating-${folderOf('Work')}`, 'Cookies'), 'half');
    // Next launch, the disk has room again.
    expect(await migratePartitions(root, ['Work', 'work'])).toEqual(new Map());
    expect(listed(root)).toEqual([folderOf('Work'), 'p-work'].sort());
    expect(cookies(root, folderOf('Work'))).toBe('shared');
  });

  it('one twin’s copy fails and it falls back to the old folder: the other copies instead of renaming it away (Argon’s note 1)', async () => {
    const root = userData({ 'p-work': 'shared' });
    let copies = 0;
    // The first copy made fails (ENOSPC), whichever twin makes it.
    const fallbacks = await migratePartitions(root, ['Work', 'WORK'], failing({ cp: () => ++copies === 1 }));
    expect(fallbacks.size).toBe(1);
    const [failed, legacy] = [...fallbacks][0]!;
    const other = failed === 'Work' ? 'WORK' : 'Work';
    expect(legacy).toBe(`persist:p-${failed}`);
    expect(cookies(root, folderOf(other))).toBe('shared');
    // The one that failed runs on its old partition, whose folder (Electron's lower case) still has its sign-ins.
    expect(cookies(root, legacy.replace(/^persist:/, '').toLowerCase())).toBe('shared');
    expect(existsSync(join(partitionsDir(root), folderOf(failed)))).toBe(false);
  });

  it('a rename that fails: that profile runs on `persist:p-${id}` with its case (a Session apart from its twin’s), and keeps its folder (SF1)', async () => {
    const root = userData({ 'p-work': 'Work' });
    const fallbacks = await migratePartitions(root, ['Work'], failing({ rename: () => true }));
    expect(fallbacks).toEqual(new Map([['Work', 'persist:p-Work']]));
    expect(fallbacks.get('Work')).not.toBe(profilePartition('work'));
    expect(cookies(root, 'p-work')).toBe('Work');
    // The cleanup once launch is over counts its old folder as in use: main passes the folder of the partition each
    // profile runs on (its old one here), and its session's own (Opus's blocker-class note on #315's PR 2).
    await removeUnusedPartitions(root, [partitionFolder(fallbacks.get('Work')!)]);
    expect(cookies(root, 'p-work')).toBe('Work');
  });

  it('no Partitions folder yet (a first launch): nothing to do', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
    dirs.push(root);
    expect(await migratePartitions(root, ['Work'])).toEqual(new Map());
  });
});

describe('removeUnusedPartitions after #315', () => {
  it('a legacy `p-work_1` goes once unused; a migrated profile’s new folder stays; `.migrating-*` is never touched (SF2)', async () => {
    const root = userData({ 'p-work_1': 'old', [folderOf('Work_1')]: 'Work_1', '.migrating-p-x': 'staging', 'p-0123abcd': 'gone' });
    await removeUnusedPartitions(root, [partitionFolder(profilePartition('Work_1'))]);
    expect(cookies(root, 'p-work_1')).toBeNull();
    expect(cookies(root, 'p-0123abcd')).toBeNull();
    expect(cookies(root, folderOf('Work_1'))).toBe('Work_1');
    expect(cookies(root, '.migrating-p-x')).toBe('staging');
  });
});
