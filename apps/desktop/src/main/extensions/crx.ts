/**
 * Chrome Web Store packages (ARCHITECTURE.md §12): CRX3 verification the way
 * Chromium's crx_verifier.cc does it, and a ZIP reader that can't write
 * outside its folder. Pure Node, so it's unit-tested without Electron.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * SHA-256 of the Chrome Web Store's publisher key ("ecdsa_2017_public", from
 * components/crx_file/crx_verifier.cc). Every store-published CRX carries a
 * proof signed by this key as well as the developer's own.
 */
export const WEB_STORE_PUBLISHER_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';

const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1');
const ZIP_TOKENS = ['PK\x05\x06', 'PK\x06\x07', 'PK\x06\x06'].map((t) => Buffer.from(t, 'latin1'));

/** Extension IDs are 32 letters a–p. */
export const EXTENSION_ID = /^[a-p]{32}$/;

const hexToId = (hex: string) => [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

/** An extension's ID: the first 128 bits of SHA-256(public key, SPKI DER), hex digits mapped to a–p. */
export function idFromKey(spki: Uint8Array): string {
  return hexToId(createHash('sha256').update(spki).digest('hex').slice(0, 32));
}

/** Just enough protobuf: length-delimited fields by number; other wire types are skipped. */
function protoFields(buf: Buffer): { field: number; bytes: Buffer }[] {
  const fields: { field: number; bytes: Buffer }[] = [];
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      if (shift > 35) throw new Error('varint too long');
      const b = buf[i++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('truncated field');
      fields.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

export interface VerifiedCrx {
  /** The ZIP inside. */
  archive: Buffer;
  /** The developer's public key (SPKI DER): it goes into manifest.json as `key`, so the ID stays the store's. */
  publicKey: Buffer;
}

export interface VerifyOptions {
  /** SHA-256 (hex) of the key whose proof must also be present. The Web Store's, except in tests. */
  publisherKeyHash?: string;
}

/**
 * Verify a CRX3 as Chromium does: every proof verifies over
 * [context][signed-header size][signed header][archive], one key hashes to
 * the declared ID (the developer's), one is the publisher's, and the ID is
 * the one we asked for. Throws with the reason otherwise.
 */
export function verifyCrx3(crx: Buffer, expectedId: string, { publisherKeyHash = WEB_STORE_PUBLISHER_KEY_HASH }: VerifyOptions = {}): VerifiedCrx {
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Not a CRX file');
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version}; only CRX3 is accepted`);
  const headerSize = crx.readUInt32LE(8);
  if (12 + headerSize > crx.length) throw new Error('Truncated CRX header');
  const header = crx.subarray(12, 12 + headerSize);
  const archive = crx.subarray(12 + headerSize);
  // Chromium refuses headers that contain ZIP end-of-directory markers.
  if (ZIP_TOKENS.some((token) => header.includes(token))) throw new Error('ZIP marker inside the CRX header');

  const fields = protoFields(header);
  const signedHeader = fields.find((f) => f.field === 10000)?.bytes;
  if (!signedHeader) throw new Error('No signed header');
  const crxIdBytes = protoFields(signedHeader).find((f) => f.field === 1)?.bytes;
  if (!crxIdBytes || crxIdBytes.length !== 16) throw new Error('No CRX ID');
  const declaredId = hexToId(crxIdBytes.toString('hex'));
  if (declaredId !== expectedId) throw new Error(`The package is for ${declaredId}, not ${expectedId}`);

  const sizeLe = Buffer.alloc(4);
  sizeLe.writeUInt32LE(signedHeader.length);
  const signedData = Buffer.concat([SIGNATURE_CONTEXT, sizeLe, signedHeader, archive]);

  let developerKey: Buffer | null = null;
  let publisherProof = false;
  const proofs = fields.filter((f) => f.field === 2 || f.field === 3);
  if (proofs.length === 0) throw new Error('No signatures');
  for (const proof of proofs) {
    const parts = protoFields(proof.bytes);
    const spki = parts.find((p) => p.field === 1)?.bytes;
    const signature = parts.find((p) => p.field === 2)?.bytes;
    if (!spki || !signature) throw new Error('Incomplete signature');
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const rsa = proof.field === 2;
    if (rsa !== (key.asymmetricKeyType === 'rsa')) throw new Error('Signature and key types differ');
    if (!rsa && key.asymmetricKeyType !== 'ec') throw new Error('Unsupported key type');
    // PKCS#1 v1.5 for RSA; DER-encoded for ECDSA (Node's default for EC keys).
    if (!verify('sha256', signedData, key, signature)) throw new Error('A signature doesn’t match the package');
    if (idFromKey(spki) === declaredId) developerKey = Buffer.from(spki);
    if (createHash('sha256').update(spki).digest('hex') === publisherKeyHash) publisherProof = true;
  }
  if (!developerKey) throw new Error('Not signed by the extension’s developer key');
  if (!publisherProof) throw new Error('Not signed by the Chrome Web Store');
  return { archive, publicKey: developerKey };
}

export interface ExtractLimits {
  maxFiles: number;
  /** Total uncompressed bytes. */
  maxBytes: number;
}

const DEFAULT_LIMITS: ExtractLimits = { maxFiles: 20_000, maxBytes: 1024 * 1024 * 1024 };

/**
 * Unpack a ZIP (stored or deflated; no ZIP64) into `dest`. Refuses entries
 * that would land outside it, and archives bigger than `limits` (a ZIP bomb
 * stops at the limit rather than filling the disk). Returns the file count.
 */
export function extractZip(zip: Buffer, dest: string, limits: ExtractLimits = DEFAULT_LIMITS): number {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = zip.readUInt16LE(eocd + 10);
  if (count > limits.maxFiles) throw new Error('Too many files in the package');
  let p = zip.readUInt32LE(eocd + 16);
  const root = resolve(dest) + sep;
  let files = 0;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad ZIP directory');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 isn’t supported');
    if (flags & 0x1) throw new Error('Encrypted ZIP entries aren’t supported');
    if (name.endsWith('/')) continue;
    if (name.includes('\0') || name.includes('\\')) throw new Error(`Bad file name: ${name}`);
    const target = resolve(dest, name);
    if (!target.startsWith(root)) throw new Error(`A file would land outside the extension’s folder: ${name}`);
    total += usize;
    if (total > limits.maxBytes) throw new Error('The package is too big');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Bad ZIP entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + csize > zip.length) throw new Error('Truncated ZIP entry');
    const raw = zip.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }) : null;
    if (!data) throw new Error(`Unsupported compression in ${name}`);
    if (data.length !== usize) throw new Error(`Size mismatch in ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
  }
  return files;
}

const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

/**
 * The extension ID in what someone typed or pasted: a bare ID, or a Chrome Web
 * Store page (`chromewebstore.google.com/detail/<name>/<id>`, or the old
 * `chrome.google.com/webstore/detail/…`). Null when there isn't one.
 */
export function extensionIdFrom(input: string): string | null {
  const text = input.trim();
  if (EXTENSION_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !STORE_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const detail = parts.indexOf('detail');
  if (detail < 0) return null;
  if (url.hostname === 'chrome.google.com' && parts[0] !== 'webstore') return null;
  const id = parts.slice(detail + 1).find((part) => EXTENSION_ID.test(part));
  return id ?? null;
}
