// A small unzip for the Linux container, which has no unzip: stored and
// deflated entries, Unix modes (executables) and symlinks. The archive is
// untrusted, so names that would land outside the destination are refused.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export function unzip(file, dest) {
  const zip = readFileSync(file);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archives are not supported');
  let files = 0;
  let bytes = 0;
  const links = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    const clean = normalize(name);
    if (isAbsolute(name) || clean.split(sep).includes('..')) throw new Error(`refusing ${name}`);
    const target = join(dest, clean);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: compression method ${method}`);
    if (data.length !== size) throw new Error(`${name}: size mismatch`);
    mkdirSync(dirname(target), { recursive: true });
    if ((mode & 0o170000) === 0o120000) {
      links.push([data.toString('utf8'), target]);
      continue;
    }
    writeFileSync(target, data);
    if (mode & 0o777) chmodSync(target, mode & 0o777);
    files++;
    bytes += size;
  }
  for (const [linkTarget, path] of links) {
    if (isAbsolute(linkTarget)) throw new Error(`refusing absolute symlink ${path}`);
    symlinkSync(linkTarget, path);
  }
  return { files, bytes, links: links.length };
}
