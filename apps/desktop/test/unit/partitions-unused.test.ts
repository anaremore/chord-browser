/**
 * #315: removeUnusedPartitions deletes the sign-ins of profiles no chord uses, from `<userData>/Partitions`. Electron
 * names a partition's folder in lower case, on every platform (`persist:p-Work` → `Partitions/p-work`, checked on
 * Electron 45.5.0), so a profile in use whose id has upper case must still be found in its folder, never deleted.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profilePartition } from '@chord/core';
import { removeUnusedPartitions } from '../../src/main/persistence';

/** The partitions of these profiles, as main passes them (#315's PR 2: partitions, not ids). */
const of = (...ids: string[]) => ids.map(profilePartition);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A userData with these folders under Partitions, each holding a cookie file, as Electron leaves them. */
function userData(folders: string[]): { root: string; has: (folder: string) => boolean } {
  const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
  dirs.push(root);
  for (const folder of folders) {
    mkdirSync(join(root, 'Partitions', folder), { recursive: true });
    writeFileSync(join(root, 'Partitions', folder, 'Cookies'), 'signed in');
  }
  return { root, has: (folder) => existsSync(join(root, 'Partitions', folder, 'Cookies')) };
}

const UPPER = '01A2B3C4-D5E6-7F80-9A1B-2C3D4E5F6A7B';

describe('removeUnusedPartitions (#315)', () => {
  it('a profile in use whose id has upper case keeps its sign-ins: Electron named its folder in lower case', async () => {
    // Before #315's escape it was named `p-${id}` (in lower case); since, its old partition is what it runs on until
    // its folder has moved (partitions.ts), so main passes that one.
    const data = userData([`p-${UPPER.toLowerCase()}`]);
    await removeUnusedPartitions(data.root, [`persist:p-${UPPER}`]);
    expect(data.has(`p-${UPPER.toLowerCase()}`)).toBe(true);
  });

  it('beside an upper-case id’s folder, the folder of no profile in use goes', async () => {
    // `DEADBEEF` in use has `p-deadbeef` (Electron's lower case); `p-cafef00d` is no profile's, and goes. (Two distinct
    // ids: Argon's SF3 on #315's design.)
    const data = userData(['p-deadbeef', 'p-cafef00d']);
    await removeUnusedPartitions(data.root, ['persist:p-DEADBEEF']);
    expect(data.has('p-deadbeef')).toBe(true);
    expect(data.has('p-cafef00d')).toBe(false);
  });

  it('Chord’s own ids (lower case): the ones in use stay, the others go', async () => {
    const live = '01a21619-df80-7e66-9577-09ceec5d0a05';
    const gone = '01a21619-df80-7e66-9577-09ceec5d0a06';
    const data = userData([`p-${live}`, `p-${gone}`]);
    await removeUnusedPartitions(data.root, of(live));
    expect(data.has(`p-${live}`)).toBe(true);
    expect(data.has(`p-${gone}`)).toBe(false);
  });

  it('never touches what isn’t a profile’s own partition: the default one, Chord’s, a copy under way, or anything else', async () => {
    const data = userData(['default', 'chord-devtools', 'p-', '.migrating-p-_work', 'other']);
    await removeUnusedPartitions(data.root, []);
    for (const folder of ['default', 'chord-devtools', 'p-', '.migrating-p-_work', 'other']) expect(data.has(folder)).toBe(true);
  });

  it('any folder an id could have named, before #315’s escape or after, goes once unused (Argon’s SF2)', async () => {
    const data = userData(['p-x', 'p-work_1', 'p-_work', 'p-__a']);
    await removeUnusedPartitions(data.root, []);
    for (const folder of ['p-x', 'p-work_1', 'p-_work', 'p-__a']) expect(data.has(folder)).toBe(false);
  });

  it('no Partitions folder at all: nothing to do', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
    dirs.push(root);
    await expect(removeUnusedPartitions(root, of('x'))).resolves.toBeUndefined();
  });
});
