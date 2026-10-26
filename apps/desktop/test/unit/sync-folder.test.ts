/**
 * Sync's folder on the disk (src/data/sync-folder.ts): segments are made whole
 * before anyone can see them, the folder's file is written once, and a folder
 * others can write to can't send Chord's writes elsewhere through a link, or
 * hold a read up with something that isn't a file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFolder } from '../../src/data/sync-folder';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sync’s folder on the disk', () => {
  it('makes a file whole under a temp name, then renames it; appends; writes the folder’s file only once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-sync-'));
    const fs = new NodeFolder(root);
    await fs.mkdir('1/00000000000000aa');
    await fs.create('1/00000000000000aa/000001.chordlog', bytes('head\n'));
    await fs.append('1/00000000000000aa/000001.chordlog', bytes('frame'));
    expect(readFileSync(join(root, '1', '00000000000000aa', '000001.chordlog'), 'utf8')).toBe('head\nframe');
    expect(readdirSync(join(root, '1', '00000000000000aa'))).toEqual(['000001.chordlog']);
    await fs.create('sync-1.json', bytes('{}'), true);
    await expect(fs.create('sync-1.json', bytes('{"other":1}'), true)).rejects.toThrow();
    expect(await fs.read('1/00000000000000aa/000001.chordlog', 5, 100)).toEqual(bytes('frame'));
    expect(await fs.stat('1')).toBeNull();
    expect(await fs.list('missing')).toBeNull();
  });

  it('refuses to write through a link planted in the folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-sync-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'chord-elsewhere-'));
    mkdirSync(join(root, '1'));
    // A computer's folder that's a link to somewhere else on this disk (a junction on Windows, which needs no rights).
    symlinkSync(elsewhere, join(root, '1', '00000000000000aa'), process.platform === 'win32' ? 'junction' : 'dir');
    const fs = new NodeFolder(root);
    await expect(fs.mkdir('1/00000000000000aa')).rejects.toThrow();
    await expect(fs.create('1/00000000000000aa/000001.chordlog', bytes('x'))).rejects.toThrow();
    await expect(fs.append('1/00000000000000aa/000001.chordlog', bytes('x'))).rejects.toThrow();
    await expect(fs.remove('1/00000000000000aa')).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(root, '1', '00000000000000aa'))).toBe(true);
  });

  it('refuses every write when `Chord sync` itself is a link or a junction', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'chord-sync-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'chord-elsewhere-'));
    const root = join(parent, 'Chord sync');
    symlinkSync(elsewhere, root, process.platform === 'win32' ? 'junction' : 'dir');
    const fs = new NodeFolder(root);
    await expect(fs.mkdir('')).rejects.toThrow();
    await expect(fs.mkdir('1/00000000000000aa')).rejects.toThrow();
    await expect(fs.create('sync-1.json', bytes('{}'), true)).rejects.toThrow();
    await expect(fs.create('x.chordlog', bytes('x'))).rejects.toThrow();
    await expect(fs.remove('1')).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('renames a file in place of another, inside the folder only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-sync-'));
    const fs = new NodeFolder(root);
    await fs.mkdir('1/00000000000000aa');
    await fs.create('1/00000000000000aa/000002.chordlog.part-1a2b', bytes('whole'));
    await fs.create('1/00000000000000aa/000002.chordlog', bytes('junk'));
    await fs.rename('1/00000000000000aa/000002.chordlog.part-1a2b', '1/00000000000000aa/000002.chordlog');
    expect(readdirSync(join(root, '1', '00000000000000aa'))).toEqual(['000002.chordlog']);
    expect(readFileSync(join(root, '1', '00000000000000aa', '000002.chordlog'), 'utf8')).toBe('whole');
    await expect(fs.rename('1/00000000000000aa/000002.chordlog', '../outside.chordlog')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('reads nothing from what isn’t a file (a pipe under a segment’s name)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-sync-'));
    mkdirSync(join(root, '1', '00000000000000aa'), { recursive: true });
    execFileSync('mkfifo', [join(root, '1', '00000000000000aa', '000001.chordlog')]);
    const fs = new NodeFolder(root);
    expect(await fs.read('1/00000000000000aa/000001.chordlog', 0, 100)).toEqual(new Uint8Array(0));
    expect(await fs.stat('1/00000000000000aa/000001.chordlog')).toBeNull();
  });
});
