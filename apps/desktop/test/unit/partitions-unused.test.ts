/**
 * #315: removeUnusedPartitions deletes the sign-ins of profiles no chord uses, from `<userData>/Partitions`. Electron
 * names a partition's folder in lower case, on every platform (`persist:p-Work` → `Partitions/p-work`, checked on
 * Electron 45.5.0), so a profile in use whose id has upper case must still be found in its folder, never deleted.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeUnusedPartitions } from '../../src/main/persistence';

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
    const data = userData([`p-${UPPER.toLowerCase()}`]);
    await removeUnusedPartitions(data.root, new Set([UPPER]));
    expect(data.has(`p-${UPPER.toLowerCase()}`)).toBe(true);
  });

  it('the folder of no profile in use goes, though one in use differs from it only in case', async () => {
    // `DEADBEEF` in use has `p-deadbeef`; nothing else does, so that's the only folder that stays.
    const data = userData(['p-deadbeef', 'p-cafef00d']);
    await removeUnusedPartitions(data.root, new Set(['DEADBEEF']));
    expect(data.has('p-deadbeef')).toBe(true);
    expect(data.has('p-cafef00d')).toBe(false);
  });

  it('Chord’s own ids (lower case): the ones in use stay, the others go', async () => {
    const live = '01a21619-df80-7e66-9577-09ceec5d0a05';
    const gone = '01a21619-df80-7e66-9577-09ceec5d0a06';
    const data = userData([`p-${live}`, `p-${gone}`]);
    await removeUnusedPartitions(data.root, new Set([live]));
    expect(data.has(`p-${live}`)).toBe(true);
    expect(data.has(`p-${gone}`)).toBe(false);
  });

  it('never touches what isn’t a profile’s own partition: the default one, Chord’s, or anything else', async () => {
    const data = userData(['default', 'chord-devtools', 'p-', 'p-x', 'p-Work', 'other']);
    await removeUnusedPartitions(data.root, new Set());
    for (const folder of ['default', 'chord-devtools', 'p-', 'p-x', 'p-Work', 'other']) expect(data.has(folder)).toBe(true);
  });

  it('no Partitions folder at all: nothing to do', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-partitions-'));
    dirs.push(root);
    await expect(removeUnusedPartitions(root, new Set(['x']))).resolves.toBeUndefined();
  });
});
