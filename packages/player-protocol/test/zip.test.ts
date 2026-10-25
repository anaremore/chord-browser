import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { entryTarget, extractZip, readEntries, writeZip } from '../src/zip.ts';

const posix = process.platform !== 'win32';
const fresh = () => mkdtempSync(join(tmpdir(), 'zip-'));

/** A tiny zip with whatever entries a test wants, the way an attacker might write one. */
function craft(entries: { name: string; data: Buffer; mode?: number; method?: number; claimedSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.method ?? 0, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.claimedSize ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(e.method ?? 0, 10);
    record.writeUInt32LE(crc32(e.data), 16);
    record.writeUInt32LE(e.data.length, 20);
    record.writeUInt32LE(e.claimedSize ?? e.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + e.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe('the player’s zip format', () => {
  it('round-trips a tree: contents, executables and symlinks (a macOS framework’s layout)', async () => {
    const src = fresh();
    mkdirSync(join(src, 'App.app/Contents/Frameworks/F.framework/Versions/A'), { recursive: true });
    writeFileSync(join(src, 'App.app/Contents/Frameworks/F.framework/Versions/A/F'), Buffer.alloc(100_000, 7));
    writeFileSync(join(src, 'App.app/Contents/Info.plist'), '<plist/>');
    writeFileSync(join(src, 'run'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    writeFileSync(join(src, 'empty'), '');
    if (posix) {
      symlinkSync('A', join(src, 'App.app/Contents/Frameworks/F.framework/Versions/Current'));
      symlinkSync('Versions/Current/F', join(src, 'App.app/Contents/Frameworks/F.framework/F'));
    }
    const zip = join(fresh(), 'a.zip');
    const written = await writeZip(src, zip);
    expect(written.entries).toBe(posix ? 6 : 4);
    const again = join(fresh(), 'b.zip');
    await writeZip(src, again);
    expect(readFileSync(again).equals(readFileSync(zip))).toBe(true); // reproducible

    const dest = join(fresh(), 'out');
    const progress: number[] = [];
    const result = await extractZip(zip, dest, { maxBytes: 10_000_000, onProgress: (done, total) => progress.push(done / total) });
    expect(result.bytes).toBe(written.bytes);
    expect(progress.at(-1)).toBe(1);
    expect(readFileSync(join(dest, 'App.app/Contents/Frameworks/F.framework/Versions/A/F')).equals(Buffer.alloc(100_000, 7))).toBe(true);
    expect(readFileSync(join(dest, 'empty'), 'utf8')).toBe('');
    if (posix) {
      expect(statSync(join(dest, 'run')).mode & 0o111).not.toBe(0);
      expect(readlinkSync(join(dest, 'App.app/Contents/Frameworks/F.framework/F'))).toBe('Versions/Current/F');
      expect(readFileSync(join(dest, 'App.app/Contents/Frameworks/F.framework/F')).length).toBe(100_000);
    }
  });

  it('refuses names that would land outside the folder', () => {
    const dest = fresh();
    for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/evil', 'a\\..\\evil', 'a//b', './a']) {
      expect(() => entryTarget(dest, name), name).toThrow(/Refusing/);
    }
    expect(entryTarget(dest, 'a/b.txt')).toBe(join(dest, 'a', 'b.txt'));
  });

  it('refuses a crafted archive: an escaping name or symlink, a wrong size or CRC, or too much', async () => {
    const cases: { why: string; zip: Buffer; posixOnly?: boolean; maxBytes?: number; error: RegExp }[] = [
      { why: 'escaping name', zip: craft([{ name: '../evil.txt', data: Buffer.from('x') }]), error: /Refusing/ },
      { why: 'absolute symlink', zip: craft([{ name: 'l', data: Buffer.from('/etc'), mode: 0o120777 }]), posixOnly: true, error: /symlink/ },
      { why: 'symlink out', zip: craft([{ name: 'a/l', data: Buffer.from('../../x'), mode: 0o120777 }]), posixOnly: true, error: /symlink/ },
      { why: 'claims less than it holds', zip: craft([{ name: 'f', data: Buffer.alloc(100), claimedSize: 10 }]), error: /bigger|match/ },
      { why: 'too big', zip: craft([{ name: 'f', data: Buffer.alloc(100) }]), maxBytes: 50, error: /more than/ },
    ];
    for (const c of cases) {
      if (c.posixOnly && !posix) continue;
      const file = join(fresh(), 'z.zip');
      writeFileSync(file, c.zip);
      await expect(extractZip(file, join(fresh(), 'out'), { maxBytes: c.maxBytes ?? 1e6 }), c.why).rejects.toThrow(c.error);
    }
    const corrupt = craft([{ name: 'f', data: Buffer.from('hello') }]);
    corrupt[30 + 1] = 'X'.charCodeAt(0); // the stored data, after the header and the one-byte name
    const file = join(fresh(), 'c.zip');
    writeFileSync(file, corrupt);
    await expect(extractZip(file, join(fresh(), 'out'), { maxBytes: 1e6 })).rejects.toThrow(/CRC/);
    await expect(readEntries(join(fresh(), 'missing.zip'))).rejects.toThrow();
  });

  it('refuses symlinks in an archive meant for Windows', async () => {
    const file = join(fresh(), 'w.zip');
    writeFileSync(file, craft([{ name: 'l', data: Buffer.from('target'), mode: 0o120777 }]));
    await expect(extractZip(file, join(fresh(), 'out'), { maxBytes: 1e6, platform: 'win32' })).rejects.toThrow(/Windows/);
  });
});
