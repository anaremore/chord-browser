/**
 * Builds Chrome extension packages for tests: a ZIP writer and signed CRX3
 * files in the format Chromium's crx_verifier.cc reads, with keys generated
 * on the spot (never the Chrome Web Store's).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface KeyPair {
  kind: 'rsa' | 'ec';
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function keyPair(kind: 'rsa' | 'ec'): KeyPair {
  const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { kind, ...pair };
}

export const spki = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' });

/** The extension ID a developer key gives: SHA-256 of the key, first 32 hex digits mapped to a–p. */
export function extensionIdOf(key: KeyObject): string {
  const hex = createHash('sha256').update(spki(key)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** A ZIP of these files (deflated), as Chrome's packages are. */
export function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const common = Buffer.concat([u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(packed.length), u32(data.length), u16(nameBytes.length), u16(0)]);
    const local = Buffer.concat([u32(0x04034b50), common, nameBytes, packed]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const count = Object.keys(files).length;
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, directory, end]);
}

/** Every file under a folder, for zip(). */
export function folderFiles(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split(sep).join('/')] = readFileSync(path);
    }
  };
  walk(dir);
  return out;
}

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

const field = (num: number, bytes: Buffer) => Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);

/**
 * A CRX3 package: the archive, signed by each signer, declaring the ID of
 * `developer`'s key. Pass the developer and a stand-in "publisher" to get a
 * package Chord accepts when told that publisher's key hash.
 */
export function crx3(archive: Buffer, developer: KeyPair, signers: readonly KeyPair[]): Buffer {
  const crxId = createHash('sha256').update(spki(developer.publicKey)).digest().subarray(0, 16);
  const signedHeader = field(1, crxId);
  const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), u32(signedHeader.length), signedHeader, archive]);
  const proofs = signers.map((s) =>
    field(s.kind === 'rsa' ? 2 : 3, Buffer.concat([field(1, spki(s.publicKey)), field(2, sign('sha256', signedData, s.privateKey))])),
  );
  const header = Buffer.concat([...proofs, field(10000, signedHeader)]);
  return Buffer.concat([Buffer.from('Cr24', 'latin1'), u32(3), u32(header.length), header, archive]);
}
