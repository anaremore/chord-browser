/**
 * Your data's files (docs/decisions/S15-your-data.md §2–§3; docs/data-format.md
 * spells it out for anyone writing a reader). A file is a header line, then
 * one record per line, then `{"end":<records>}`. *Encrypt with a passphrase*
 * keeps the header readable and seals the same lines, deflated, in frames:
 * scrypt and HKDF make the key, AES-256-GCM seals each frame with the
 * header's hash, its index and whether it's the last, so nothing can be
 * edited, reordered, dropped or cut off unseen.
 *
 * Pure: the primitives come in as a `DataCrypto` (Node's: `@chord/data/crypto`).
 */
import { isDataRecord, type DataRecord } from './records';
import { PASSPHRASE_WORDS } from './words';

// Core compiles without DOM types; these are globals in Node and every browser.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(bytes: Uint8Array, options?: { stream?: boolean }): string };
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
declare function btoa(data: string): string;
declare function atob(data: string): string;

/** Every later Chord reads every earlier format (S15 §2, *Versions*). Within 1, changes are additions only. */
export const DATA_FORMAT = 1;
export const DATA_FORMAT_ABOUT = 'https://github.com/anaremore/chord-browser/blob/main/docs/data-format.md';

/** What a file holds, in the order it holds it: setup, then Today tabs and icons, then history, then Duet. */
export type DataPart = 'setup' | 'today' | 'history' | 'duet';

/** What an export would hold, counted before anything is written: Settings' card says so (S15 §8). */
export interface ExportCounts {
  chords: number;
  pinnedTabs: number;
  folders: number;
  todayTabs: number;
  favorites: number;
  themes: number;
  routes: number;
  /** Sites with Effects. */
  effects: number;
  /** History pages with at least one visit. */
  pages: number;
  /** Duet chats, and the images in them. */
  chats: number;
  images: number;
}

/** The first line of a plain file, and the second of an encrypted one. */
export interface DataHeader {
  chord: 'data';
  format: number;
  kind: string;
  /** The Chord that wrote it. */
  app: string;
  /** The computer that wrote it: its stamps carry the same id. */
  device: string;
  created: string;
  includes: DataPart[];
  about: string;
}

export function dataHeader({ app, device, created, includes }: { app: string; device: string; created: number; includes: DataPart[] }): DataHeader {
  return { chord: 'data', format: DATA_FORMAT, kind: 'export', app, device, created: new Date(created).toISOString(), includes, about: DATA_FORMAT_ABOUT };
}

/** A header as read: null unless it says it's Chord's data. A newer `format` is returned, for the caller to say so. */
export function parseHeader(raw: unknown): DataHeader | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (h['chord'] !== 'data' || !Number.isInteger(h['format']) || (h['format'] as number) < 1) return null;
  const includes = Array.isArray(h['includes']) ? h['includes'].filter((p): p is DataPart => p === 'setup' || p === 'today' || p === 'history' || p === 'duet') : [];
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : '');
  return { chord: 'data', format: h['format'] as number, kind: str(h['kind']), app: str(h['app']), device: str(h['device']), created: str(h['created']), includes, about: str(h['about']) };
}

/** One record as its line: `type`, `id`, `at`, `set`, in that order. */
export const recordLine = (r: DataRecord): string => `${JSON.stringify(r.at ? { type: r.type, id: r.id, at: r.at, set: r.set } : { type: r.type, id: r.id, set: r.set })}\n`;
export const endLine = (records: number): string => `${JSON.stringify({ end: records })}\n`;

/* ---------- Passphrases ---------- */

/** S15 question 9: at least 12 characters, and *Suggest one*. Lost, it can't be recovered (D14). */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;

/** The same passphrase however it was typed: composed characters (NFC), as macOS and Windows keyboards may differ. */
export const normalizePassphrase = (passphrase: string): string => passphrase.normalize('NFC');

/** What's wrong with a passphrase, in words; null when it can be used. */
export function passphraseProblem(passphrase: string): string | null {
  const length = [...normalizePassphrase(passphrase)].length;
  if (length < PASSPHRASE_MIN) return `At least ${PASSPHRASE_MIN} characters.`;
  if (length > PASSPHRASE_MAX) return `At most ${PASSPHRASE_MAX} characters.`;
  return null;
}

/** A whole number below `n`, uniformly: random 32-bit values past the last whole multiple of `n` are drawn again. */
function below(n: number, random: () => number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const value = random();
    if (value < limit) return value % n;
  }
}

const random32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** *Suggest one*: five words, each picked at random from PASSPHRASE_WORDS (about 10.8 bits each, 54 in all). */
export function suggestPassphrase(random: () => number = random32): string {
  return Array.from({ length: 5 }, () => PASSPHRASE_WORDS[below(PASSPHRASE_WORDS.length, random)]).join(' ');
}

/* ---------- The encrypted envelope ---------- */

/** What core needs from a crypto library: all of it standard, so any language can read a file (docs/data-format.md). */
export interface DataCrypto {
  random(length: number): Uint8Array;
  scrypt(passphrase: Uint8Array, salt: Uint8Array, params: ScryptParams, length: number): Promise<Uint8Array>;
  /** HKDF-SHA256. */
  hkdf(key: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  /** AES-256-GCM: the ciphertext with its 16-byte tag after it. */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  /** Null when the tag doesn't match. */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null;
  /** Raw DEFLATE (RFC 1951), no zlib or gzip wrapper. */
  deflate(data: Uint8Array): Uint8Array;
  /** Null when it isn't DEFLATE, or would come to more than `maxLength`. */
  inflate(data: Uint8Array, maxLength: number): Uint8Array | null;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** The header's key derivation: named, with its parameters, so a later Chord can move on and still open this file. */
export interface DataKdf extends ScryptParams {
  name: 'scrypt';
  /** Base64, 32 random bytes. */
  salt: string;
}

/** An encrypted file's header: a plain one's, plus how to make the key and check it. */
export interface SealedHeader extends DataHeader {
  kdf: DataKdf;
  /** The file's own salt (base64, 32 bytes): its key is HKDF of the passphrase's. */
  salt: string;
  /** "chord", sealed with the check key (base64: nonce, ciphertext, tag), so a wrong passphrase isn't taken for damage. */
  check: string;
}

/** The first line of an encrypted file, so a person who opens it can tell what it is: `chord-encrypted 1`. */
export const ENCRYPTED_LINE = 'chord-encrypted';
/**
 * The envelope's own version (the cipher, the keys, the frames), apart from
 * `format`, the records': a new record format needn't change how files are
 * sealed, nor the other way round.
 */
export const ENVELOPE_VERSION = 1;
/** OWASP's minimum for scrypt: 128 MiB and about half a second (S15 §3). */
export const SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
/** Most plaintext a frame takes before it's sealed: whole lines, so a line longer than this is a frame of its own. */
export const FRAME_TARGET = 256 * 1024;
/** The longest line a file may have (S15 §5's 32 MB, as UTF-8): a writer leaves a longer record out, a reader refuses it. */
export const MAX_LINE = 32 * 1024 * 1024;
/** No frame is longer, and none inflates past MAX_INFLATED: a line's worth, with room for DEFLATE's own overhead. */
export const MAX_FRAME = 40 * 1024 * 1024;
const MAX_INFLATED = 48 * 1024 * 1024;
/** The most a whole file holds, decrypted and inflated (S15 §5 refuses files over 2 GB). */
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const NONCE = 12;
const TAG = 16;
const KEY = 32;
const CHECK_WORD = 'chord';
/** What a reader runs scrypt with at most: 256 MiB, twice S15's 128 MiB, so a file can't make Chord take more. */
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;

const utf8 = new TextEncoder();
const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
function fromBase64(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length > 400 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Each frame's associated data: the header line's SHA-256, its index (8 bytes, big-endian) and 1 for the last frame, else 0. */
function frameAad(headerHash: Uint8Array, index: number, last: boolean): Uint8Array {
  const aad = new Uint8Array(headerHash.length + 9);
  aad.set(headerHash);
  const view = new DataView(aad.buffer);
  view.setUint32(headerHash.length, Math.floor(index / 0x1_0000_0000));
  view.setUint32(headerHash.length + 4, index >>> 0);
  aad[headerHash.length + 8] = last ? 1 : 0;
  return aad;
}

const checkKey = (c: DataCrypto, root: Uint8Array, kdfSalt: Uint8Array) => c.hkdf(root, kdfSalt, 'chord check 1', KEY);
const fileKey = (c: DataCrypto, root: Uint8Array, fileSalt: Uint8Array) => c.hkdf(root, fileSalt, 'chord file 1', KEY);
const rootKey = (c: DataCrypto, passphrase: string, kdf: ScryptParams, salt: Uint8Array) => c.scrypt(utf8.encode(normalizePassphrase(passphrase)), salt, kdf, KEY);

/* ---------- Writing ---------- */

/** Writes a file a record at a time: its first bytes, then what each record adds, then the end. */
export interface DataFileWriter {
  readonly head: Uint8Array;
  /** Bytes to append for this record: for an encrypted file, nothing until a frame is full. A record past MAX_LINE is left out. */
  add(record: DataRecord): Uint8Array[];
  /** The end line, and for an encrypted file the last frame. */
  end(): Uint8Array[];
  /** Records left out for being longer than a reader takes. */
  readonly skipped: number;
}

/** A record's line, or null when it's longer than MAX_LINE (a character is at most 3 bytes of UTF-8 in a JSON string). */
function lineOf(record: DataRecord): string | null {
  const line = recordLine(record);
  return line.length * 3 <= MAX_LINE || utf8.encode(line).length <= MAX_LINE ? line : null;
}

export function plainWriter(header: DataHeader): DataFileWriter {
  let records = 0;
  let skipped = 0;
  return {
    head: utf8.encode(`${JSON.stringify(header)}\n`),
    add(record) {
      const line = lineOf(record);
      if (line === null) {
        skipped++;
        return [];
      }
      records++;
      return [utf8.encode(line)];
    },
    end: () => [utf8.encode(endLine(records))],
    get skipped() {
      return skipped;
    },
  };
}

/**
 * An encrypted file: its readable lines, then frames. The passphrase becomes
 * the key here, once (scrypt, about half a second), and is kept no longer.
 */
export async function encryptedWriter(header: DataHeader, passphrase: string, c: DataCrypto, params: ScryptParams = SCRYPT): Promise<DataFileWriter> {
  const kdfSalt = c.random(32);
  const fileSalt = c.random(32);
  const root = await rootKey(c, passphrase, params, kdfSalt);
  const checkNonce = c.random(NONCE);
  const check = concat([checkNonce, c.seal(checkKey(c, root, kdfSalt), checkNonce, utf8.encode(CHECK_WORD), new Uint8Array(0))]);
  const sealed: SealedHeader = { ...header, kdf: { name: 'scrypt', ...params, salt: toBase64(kdfSalt) }, salt: toBase64(fileSalt), check: toBase64(check) };
  const headerLine = JSON.stringify(sealed);
  const headerHash = c.sha256(utf8.encode(headerLine));
  const key = fileKey(c, root, fileSalt);
  root.fill(0);

  let lines: string[] = [];
  let size = 0;
  let index = 0;
  let records = 0;
  let skipped = 0;
  const frame = (last: boolean): Uint8Array => {
    const nonce = c.random(NONCE);
    const body = c.seal(key, nonce, c.deflate(utf8.encode(lines.join(''))), frameAad(headerHash, index++, last));
    lines = [];
    size = 0;
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, NONCE + body.length);
    return concat([length, nonce, body]);
  };
  return {
    head: utf8.encode(`${ENCRYPTED_LINE} ${ENVELOPE_VERSION}\n${headerLine}\n`),
    add(record) {
      const line = lineOf(record);
      if (line === null) {
        skipped++;
        return [];
      }
      records++;
      // The frame being filled is sealed only once another line comes: then it's known not to be the last.
      const out = size > 0 && size + line.length > FRAME_TARGET ? [frame(false)] : [];
      lines.push(line);
      size += line.length;
      return out;
    },
    end() {
      lines.push(endLine(records));
      const last = frame(true);
      key.fill(0);
      return [last];
    },
    get skipped() {
      return skipped;
    },
  };
}

/* ---------- Reading ---------- */

/**
 * Why a file couldn't be read whole: it isn't Chord's (`not-chord`), a newer
 * Chord wrote it (`newer`, a newer format, envelope or key derivation), it's
 * encrypted and no passphrase was given (`needs-passphrase`) or the wrong one
 * (`wrong-passphrase`), part of it fails its check or is past what Chord takes
 * (`damaged`), or it stops before its end (`cut-short`). Whatever could be
 * read comes with it.
 */
export type DataFileProblem = 'not-chord' | 'newer' | 'needs-passphrase' | 'wrong-passphrase' | 'damaged' | 'cut-short';

export interface DataFileRead {
  header: DataHeader | null;
  encrypted: boolean;
  records: DataRecord[];
  problem: DataFileProblem | null;
}

const failed = (problem: DataFileProblem, encrypted: boolean, header: DataHeader | null = null): DataFileRead => ({ header, encrypted, records: [], problem });

/**
 * The lines after the header, a piece at a time (a frame's, or a plain file's
 * lines), as records. A line that isn't one makes the file damaged; so does
 * an end line that miscounts, or anything after it. The end line is any
 * object with an integer `end` and no `type`, so a later format 1 may add to it.
 */
class LineReader {
  private end: number | null = null;
  private bad = 0;

  constructor(private readonly read: DataFileRead) {}

  /** A line too long to read: it counts, as damage. */
  refuse(): void {
    this.bad++;
  }

  line(text: string): void {
    if (!text) return;
    if (this.end !== null || text.length > MAX_LINE) {
      this.bad++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.bad++;
      return;
    }
    const v = value as Record<string, unknown> | null;
    if (v && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v['end']) && !('type' in v)) this.end = v['end'] as number;
    else if (isDataRecord(value)) this.read.records.push(value);
    else this.bad++;
  }

  finish(): void {
    if (this.bad > 0 || (this.end !== null && this.end !== this.read.records.length + this.bad)) this.read.problem = 'damaged';
    else if (this.end === null) this.read.problem ??= 'cut-short';
  }
}

/** Whether a key derivation is one this Chord makes keys with, within what it takes (scrypt itself needs N < 2^(16·r)). */
function usableKdf(kdf: unknown): kdf is DataKdf {
  if (!kdf || typeof kdf !== 'object') return false;
  const k = kdf as Record<string, unknown>;
  const { N, r, p } = k as { N: number; r: number; p: number };
  if (k['name'] !== 'scrypt' || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  return N >= 2 ** 10 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && N < 2 ** (16 * r) && p >= 1 && p <= 4 && 128 * N * r <= MAX_SCRYPT_MEMORY;
}

/**
 * A whole file, plain or encrypted (by its first line, never its name). With
 * the right passphrase an encrypted file reads exactly as the plain one would.
 * Never throws: what can't be read is a problem, with what could be.
 */
export async function readDataFile(bytes: Uint8Array, passphrase: string | null, c: DataCrypto): Promise<DataFileRead> {
  const decoder = new TextDecoder('utf-8');
  const firstBreak = bytes.indexOf(0x0a);
  const first = decoder.decode(bytes.subarray(0, firstBreak < 0 ? Math.min(bytes.length, 64 * 1024) : Math.min(firstBreak, 64 * 1024)));
  const magic = /^chord-encrypted (\d{1,6})$/.exec(first);
  if (!magic) {
    let raw: unknown;
    try {
      raw = JSON.parse(first);
    } catch {
      return failed('not-chord', false);
    }
    const header = parseHeader(raw);
    if (!header) return failed('not-chord', false);
    if (header.format > DATA_FORMAT) return failed('newer', false, header);
    const read: DataFileRead = { header, encrypted: false, records: [], problem: null };
    if (bytes.length > MAX_TOTAL) return { ...read, problem: 'damaged' };
    const lines = new LineReader(read);
    // A line at a time, so no string is ever the whole file.
    for (let at = firstBreak < 0 ? bytes.length : firstBreak + 1; at < bytes.length; ) {
      const next = bytes.indexOf(0x0a, at);
      const end = next < 0 ? bytes.length : next;
      if (end - at > MAX_LINE) lines.refuse();
      else lines.line(decoder.decode(bytes.subarray(at, end)));
      at = end + 1;
    }
    lines.finish();
    return read;
  }

  const envelope = Number(magic[1]);
  if (envelope !== ENVELOPE_VERSION) return failed(envelope > ENVELOPE_VERSION ? 'newer' : 'not-chord', true);
  const headerEnd = bytes.indexOf(0x0a, firstBreak + 1);
  if (headerEnd < 0 || headerEnd - firstBreak > 64 * 1024) return failed(headerEnd < 0 ? 'cut-short' : 'damaged', true);
  const headerBytes = bytes.subarray(firstBreak + 1, headerEnd);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>;
  } catch {
    return failed('damaged', true);
  }
  const header = parseHeader(raw);
  if (!header) return failed('damaged', true);
  if (header.format > DATA_FORMAT || !usableKdf(raw['kdf'])) return failed('newer', true, header);
  const kdfSalt = fromBase64(raw['kdf'].salt);
  const fileSalt = fromBase64(raw['salt']);
  const check = fromBase64(raw['check']);
  if (!kdfSalt || kdfSalt.length < 16 || !fileSalt || fileSalt.length < 16 || !check || check.length !== NONCE + CHECK_WORD.length + TAG) return failed('damaged', true, header);
  if (passphrase === null) return failed('needs-passphrase', true, header);

  let root: Uint8Array;
  try {
    root = await rootKey(c, passphrase, raw['kdf'], kdfSalt);
  } catch {
    // Parameters this crypto library won't run: a newer Chord's, as far as this one can tell.
    return failed('newer', true, header);
  }
  const word = c.open(checkKey(c, root, kdfSalt), check.subarray(0, NONCE), check.subarray(NONCE), new Uint8Array(0));
  if (!word || decoder.decode(word) !== CHECK_WORD) return failed('wrong-passphrase', true, header);
  const key = fileKey(c, root, fileSalt);
  root.fill(0);

  const headerHash = c.sha256(headerBytes);
  const read: DataFileRead = { header, encrypted: true, records: [], problem: null };
  const lines = new LineReader(read);
  let at = headerEnd + 1;
  let index = 0;
  let last = false;
  let damaged = false;
  let total = 0;
  while (at < bytes.length) {
    if (last || bytes.length - at < 4) {
      // Bytes after the last frame are damage; a few too few for a length, a frame cut off.
      damaged ||= last;
      if (!last) read.problem = 'cut-short';
      break;
    }
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
    if (length < NONCE + TAG || length > MAX_FRAME) {
      // The frames can't be told apart past here.
      damaged = true;
      break;
    }
    if (at + 4 + length > bytes.length) {
      read.problem = 'cut-short';
      break;
    }
    const nonce = bytes.subarray(at + 4, at + 4 + NONCE);
    const body = bytes.subarray(at + 4 + NONCE, at + 4 + length);
    at += 4 + length;
    let plain = c.open(key, nonce, body, frameAad(headerHash, index, false));
    if (!plain) {
      plain = c.open(key, nonce, body, frameAad(headerHash, index, true));
      last = Boolean(plain);
    }
    index++;
    const inflated = plain && c.inflate(plain, MAX_INFLATED);
    // A frame that fails its check is passed over: the frames around it can still be read, a whole line each.
    if (!inflated) {
      damaged = true;
      continue;
    }
    total += inflated.length;
    if (total > MAX_TOTAL) {
      damaged = true;
      break;
    }
    for (const text of decoder.decode(inflated).split('\n')) lines.line(text);
  }
  key.fill(0);
  lines.finish();
  if (damaged) read.problem = 'damaged';
  else if (!last) read.problem ??= 'cut-short';
  return read;
}