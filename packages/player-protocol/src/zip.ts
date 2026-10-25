/**
 * The zip format Chord Player ships in, written by its packaging script and
 * read by Chord when it installs the player (ARCHITECTURE.md §9). One small
 * implementation on both ends, so the same archive unpacks the same way on
 * every OS: Windows, macOS and Linux keep no unzip in common, and macOS's
 * frameworks need their symlinks and executable bits kept.
 *
 * Writing: stored or deflated entries, Unix modes, symlinks as entries whose
 * data is the link's target, UTF-8 names, fixed timestamps (the same tree
 * makes the same archive). No zip64: the player is a few hundred megabytes.
 *
 * Reading treats the archive as untrusted even after its hash checked out:
 * names that would land outside the folder, absolute or escaping symlinks,
 * symlinks on Windows, sizes that don't match, a bad CRC, more than
 * `maxBytes` unpacked or `maxEntries` entries: each stops the unpacking with
 * an error, and the caller throws the folder away.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw, deflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MADE_BY_UNIX = (3 << 8) | 20;
const UTF8 = 1 << 11;
/** 1980-01-01 00:00, the earliest DOS date: archives don't depend on when they were made. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export interface ZipEntryInfo {
  name: string;
  /** Unix mode with the file type bits, or 0 when the archive has none. */
  mode: number;
  symlink: boolean;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  offset: number;
}

/* ---------- Writing ---------- */

/** Every file and symlink under `root`, as archive names (forward slashes), sorted so archives are reproducible. */
export async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) await walk(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return out;
}

/**
 * Zips the tree under `root` into `file`. `prefix` goes before every name
 * (`Chord Player.app/`). Returns the entry count and the unpacked size.
 */
export async function writeZip(root: string, file: string, { level = 9 }: { level?: number } = {}): Promise<{ entries: number; bytes: number }> {
  const names = await listTree(root);
  if (names.length >= 0xffff) throw new Error('Too many files for a zip without zip64');
  const handle = await open(file, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  let bytes = 0;
  try {
    for (const name of names) {
      const path = join(root, ...name.split('/'));
      const stat = await lstat(path);
      const isLink = stat.isSymbolicLink();
      const data = isLink ? Buffer.from((await readlink(path)).split(sep).join('/'), 'utf8') : await readFile(path);
      const crc = crc32(data);
      const deflated = isLink || data.length < 64 ? null : deflateRawSync(data, { level });
      const stored = !deflated || deflated.length >= data.length;
      const body = stored ? data : deflated;
      const method = stored ? 0 : 8;
      if (offset + body.length > 0xfffffff0 || data.length > 0xfffffff0) throw new Error('Too big for a zip without zip64');
      const mode = isLink ? S_IFLNK | 0o777 : S_IFREG | (process.platform === 'win32' ? 0o644 : stat.mode & 0o777);
      const nameBytes = Buffer.from(name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);
      await handle.write(local);
      await handle.write(nameBytes);
      await handle.write(body);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(MADE_BY_UNIX, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(UTF8, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(DOS_TIME, 12);
      record.writeUInt16LE(DOS_DATE, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(body.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(nameBytes.length, 28);
      record.writeUInt32LE((mode << 16) >>> 0, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, nameBytes);
      offset += 30 + nameBytes.length + body.length;
      bytes += data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(directory);
    await handle.write(end);
  } finally {
    await handle.close();
  }
  return { entries: names.length, bytes };
}

/* ---------- Reading ---------- */

/** The archive's entries, from its central directory. */
export async function readEntries(file: string, maxEntries = 20_000): Promise<ZipEntryInfo[]> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error('Not a zip archive');
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('zip64 archives aren’t supported');
    if (count > maxEntries) throw new Error(`Too many entries (${count})`);
    if (dirOffset + dirSize > size) throw new Error('The central directory runs past the end');
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const entries: ZipEntryInfo[] = [];
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL) throw new Error('Bad central directory');
      const madeBy = dir.readUInt16LE(at + 4) >> 8;
      const flags = dir.readUInt16LE(at + 8);
      const method = dir.readUInt16LE(at + 10);
      const crc = dir.readUInt32LE(at + 16);
      const compressedSize = dir.readUInt32LE(at + 20);
      const size = dir.readUInt32LE(at + 24);
      const nameLength = dir.readUInt16LE(at + 28);
      const extraLength = dir.readUInt16LE(at + 30);
      const commentLength = dir.readUInt16LE(at + 32);
      const external = dir.readUInt32LE(at + 38);
      const offset = dir.readUInt32LE(at + 42);
      if (flags & 1) throw new Error('Encrypted entries aren’t supported');
      if (at + 46 + nameLength > dir.length) throw new Error('Bad central directory');
      const name = dir.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      const mode = madeBy === 3 ? external >>> 16 : 0;
      entries.push({ name, mode, symlink: (mode & S_IFMT) === S_IFLNK, size, compressedSize, method, crc, offset });
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Where an entry lands under `dest`, or an error when its name isn't a plain relative path inside it. */
export function entryTarget(dest: string, name: string): string {
  if (!name || name.length > 1024 || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`Refusing the entry ${JSON.stringify(name.slice(0, 200))}`);
  }
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`Refusing the entry ${JSON.stringify(name.slice(0, 200))}`);
  const target = resolve(dest, ...parts);
  const root = resolve(dest);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Refusing the entry ${JSON.stringify(name.slice(0, 200))}`);
  return target;
}

/** Counts bytes and checks the CRC of what passes through, failing past `limit`. */
class Check extends Transform {
  crc = 0;
  bytes = 0;
  readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return done(new Error('An entry is bigger than it says'));
    this.crc = crc32(chunk, this.crc);
    done(null, chunk);
  }
}

export interface ExtractOptions {
  /** Most bytes it may unpack in all. */
  maxBytes: number;
  maxEntries?: number;
  /** Compressed bytes read so far, of the archive's total. */
  onProgress?(done: number, total: number): void;
  platform?: NodeJS.Platform;
}

/**
 * Unpacks `file` into `dest` (which must be new and empty). Throws on
 * anything untrustworthy, leaving a partial folder for the caller to remove.
 */
export async function extractZip(file: string, dest: string, options: ExtractOptions): Promise<{ entries: number; bytes: number }> {
  const platform = options.platform ?? process.platform;
  const entries = await readEntries(file, options.maxEntries);
  const declared = entries.reduce((sum, e) => sum + e.size, 0);
  if (declared > options.maxBytes) throw new Error(`It would unpack to ${declared} bytes, more than ${options.maxBytes}`);
  const total = entries.reduce((sum, e) => sum + e.compressedSize, 0);
  await mkdir(dest, { recursive: true });
  const links: { target: string; link: string }[] = [];
  let done = 0;
  let bytes = 0;
  const handle = await open(file, 'r');
  try {
    for (const entry of entries) {
      const target = entryTarget(dest, entry.name);
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method}`);
      const header = Buffer.alloc(30);
      await handle.read(header, 0, 30, entry.offset);
      if (header.readUInt32LE(0) !== LOCAL) throw new Error(`${entry.name}: bad local header`);
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      await mkdir(dirname(target), { recursive: true });
      const check = new Check(entry.size);
      if (entry.symlink) {
        if (platform === 'win32') throw new Error(`${entry.name}: symlinks aren’t expected on Windows`);
        if (entry.method !== 0 || entry.size > 4096) throw new Error(`${entry.name}: bad symlink`);
        const data = Buffer.alloc(entry.size);
        await handle.read(data, 0, entry.size, start);
        if (crc32(data) !== entry.crc) throw new Error(`${entry.name}: bad CRC`);
        const link = data.toString('utf8');
        if (!link || isAbsolute(link) || link.includes('\\') || link.includes('\0')) throw new Error(`${entry.name}: refusing the symlink to ${JSON.stringify(link)}`);
        const resolved = resolve(dirname(target), ...link.split('/'));
        const root = resolve(dest);
        if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`${entry.name}: refusing the symlink out of the folder`);
        links.push({ target: link.split('/').join(posix.sep), link: target });
        bytes += entry.size;
      } else {
        const source = entry.compressedSize === 0 ? null : createReadStream(file, { start, end: start + entry.compressedSize - 1 });
        const mode = platform === 'win32' ? undefined : (entry.mode & 0o777) || 0o644;
        if (!source) await writeFile(target, Buffer.alloc(0), mode ? { mode } : {});
        else if (entry.method === 0) await pipeline(source, check, createWriteStream(target, mode ? { mode } : {}));
        else await pipeline(source, createInflateRaw(), check, createWriteStream(target, mode ? { mode } : {}));
        if (source && (check.bytes !== entry.size || check.crc !== entry.crc)) throw new Error(`${entry.name}: doesn’t match its size or CRC`);
        if (!source && (entry.size !== 0 || entry.crc !== 0)) throw new Error(`${entry.name}: doesn’t match its size or CRC`);
        bytes += entry.size;
      }
      done += entry.compressedSize;
      options.onProgress?.(done, total);
    }
    // Last, so no entry can be written through a symlink an earlier one made.
    for (const { target, link } of links) await symlink(target, link);
  } finally {
    await handle.close();
  }
  return { entries: entries.length, bytes };
}
