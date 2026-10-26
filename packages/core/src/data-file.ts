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

/** A copy of some bytes. Never `slice`: on a Node Buffer it's a view of the same memory, which the next read overwrites. */
const copyOf = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

/** How much of a file's start a reader needs to find its header: the envelope's line and a header line of at most 64 KB. */
export const DATA_HEAD = 64 * 1024 + 64;
const MAX_HEADER = 64 * 1024;

/**
 * The lines after the header, as records, a piece at a time (a frame's, or a
 * plain file's lines as they arrive). A line that isn't one makes the file
 * damaged; so does an end line that miscounts, or anything after it. The end
 * line is any object with an integer `end` and no `type`, so a later format 1
 * may add to it.
 */
class Lines {
  private endCount: number | null = null;
  private bad = 0;
  private records = 0;

  /** A line too long to read: it counts, as damage. */
  refuse(): void {
    this.bad++;
  }

  line(text: string, out: DataRecord[]): void {
    if (!text) return;
    if (this.endCount !== null || text.length > MAX_LINE) {
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
    if (v && typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v['end']) && !('type' in v)) this.endCount = v['end'] as number;
    else if (isDataRecord(value)) {
      this.records++;
      out.push(value);
    } else this.bad++;
  }

  /** At the end: damaged, cut short (no end line), or whole. */
  problem(): DataFileProblem | null {
    if (this.bad > 0 || (this.endCount !== null && this.endCount !== this.records + this.bad)) return 'damaged';
    return this.endCount === null ? 'cut-short' : null;
  }
}

/**
 * A file's records, read as its bytes come, so no file is ever in memory
 * whole (an import takes files up to 2 GB): `push` the bytes after the header
 * in pieces of any size, then `end`. Never throws.
 */
export interface DataRecordStream {
  /** The next bytes: the records whole in them so far. */
  push(bytes: Uint8Array): DataRecord[];
  /** The file has ended: the last records. `problem` then says whether it was whole. */
  end(): DataRecord[];
  readonly problem: DataFileProblem | null;
}

/** A plain file's lines, a line at a time. A line past MAX_LINE is passed over to its end, and counts as damage. */
class PlainStream implements DataRecordStream {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly lines = new Lines();
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private skipping = false;
  private total = 0;
  private over = false;
  problem: DataFileProblem | null = null;

  push(bytes: Uint8Array): DataRecord[] {
    const out: DataRecord[] = [];
    if (this.over) return out;
    if ((this.total += bytes.length) > MAX_TOTAL) {
      this.over = true;
      return out;
    }
    for (let at = 0; at < bytes.length; ) {
      const next = bytes.indexOf(0x0a, at);
      const end = next < 0 ? bytes.length : next;
      if (!this.skipping && this.pendingSize + end - at > MAX_LINE) {
        this.skipping = true;
        this.lines.refuse();
        this.pending = [];
        this.pendingSize = 0;
      }
      if (!this.skipping) {
        // A line's first part is copied until its end comes: the caller may reuse its buffer.
        if (next < 0) {
          this.pending.push(copyOf(bytes.subarray(at, end)));
          this.pendingSize += end - at;
        } else this.lines.line(this.take(bytes.subarray(at, end)), out);
      }
      if (next < 0) break;
      this.skipping = false;
      at = next + 1;
    }
    return out;
  }

  /** A whole line: what was pending, then its last part. */
  private take(last: Uint8Array): string {
    if (this.pendingSize === 0) return this.decoder.decode(last);
    const whole = concat([...this.pending, last]);
    this.pending = [];
    this.pendingSize = 0;
    return this.decoder.decode(whole);
  }

  end(): DataRecord[] {
    const out: DataRecord[] = [];
    if (!this.over && !this.skipping && this.pendingSize > 0) this.lines.line(this.take(new Uint8Array(0)), out);
    this.problem = this.over ? 'damaged' : this.lines.problem();
    return out;
  }
}

/**
 * An encrypted file's frames, each opened and inflated once it's whole. A
 * frame that fails its check is passed over (each stands alone), so the rest
 * can still be read; frames swapped or dropped fail from there on, by index.
 */
class FrameStream implements DataRecordStream {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly lines = new Lines();
  private buffer: Uint8Array[] = [];
  private size = 0;
  private index = 0;
  private last = false;
  private damaged = false;
  private stopped = false;
  private total = 0;
  problem: DataFileProblem | null = null;

  constructor(
    private readonly c: DataCrypto,
    private readonly key: Uint8Array,
    private readonly headerHash: Uint8Array,
  ) {}

  /** The first `n` buffered bytes, in one piece, taken out of the buffer. */
  private take(n: number): Uint8Array {
    const first = this.buffer[0]!;
    this.size -= n;
    if (first.length >= n) {
      if (first.length === n) this.buffer.shift();
      else this.buffer[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    for (let at = 0; at < n; ) {
      const part = this.buffer[0]!;
      const used = Math.min(part.length, n - at);
      out.set(part.subarray(0, used), at);
      at += used;
      if (used === part.length) this.buffer.shift();
      else this.buffer[0] = part.subarray(used);
    }
    return out;
  }

  /** The next frame's length, from its first 4 bytes, left where they are. */
  private nextLength(): number {
    const head = this.buffer[0]!.length >= 4 ? this.buffer[0]! : concat(this.buffer).subarray(0, 4);
    return new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
  }

  push(bytes: Uint8Array): DataRecord[] {
    const out: DataRecord[] = [];
    if (this.stopped || bytes.length === 0) return out;
    // Copied: the caller may reuse its buffer, and a frame can span several pieces.
    this.buffer.push(copyOf(bytes));
    this.size += bytes.length;
    while (this.size > 0 && !this.stopped) {
      if (this.last) {
        // Bytes after the last frame are damage.
        this.damaged = this.stopped = true;
        break;
      }
      if (this.size < 4) break;
      const length = this.nextLength();
      if (length < NONCE + TAG || length > MAX_FRAME) {
        // The frames can't be told apart past here.
        this.damaged = this.stopped = true;
        break;
      }
      if (this.size < 4 + length) break;
      const frame = this.take(4 + length);
      this.open(frame.subarray(4, 4 + NONCE), frame.subarray(4 + NONCE), out);
    }
    if (this.stopped) {
      this.buffer = [];
      this.size = 0;
    }
    return out;
  }

  private open(nonce: Uint8Array, body: Uint8Array, out: DataRecord[]): void {
    let plain = this.c.open(this.key, nonce, body, frameAad(this.headerHash, this.index, false));
    if (!plain) {
      plain = this.c.open(this.key, nonce, body, frameAad(this.headerHash, this.index, true));
      this.last = Boolean(plain);
    }
    this.index++;
    const inflated = plain && this.c.inflate(plain, MAX_INFLATED);
    // A frame that fails its check is passed over: the frames around it can still be read, a whole line each.
    if (!inflated) {
      this.damaged = true;
      return;
    }
    if ((this.total += inflated.length) > MAX_TOTAL) {
      this.damaged = this.stopped = true;
      return;
    }
    for (const text of this.decoder.decode(inflated).split('\n')) this.lines.line(text, out);
  }

  end(): DataRecord[] {
    // A frame begun but not whole, or a few bytes too few for its length: the file was cut off.
    const cut = !this.stopped && this.size > 0;
    const lines = this.lines.problem();
    this.problem = this.damaged || lines === 'damaged' ? 'damaged' : lines === 'cut-short' || cut || !this.last ? 'cut-short' : null;
    return [];
  }
}

/**
 * A file opened: its header, whether it's encrypted, and either why it can't
 * be read at all or a way to read its records. An encrypted file's key is
 * made once and kept until `close`, so the file can be read through more than
 * once (an import counts it, then brings it in) without scrypt again.
 */
export interface DataFileOpen {
  header: DataHeader | null;
  encrypted: boolean;
  /** Why none of its records can be read; `records` gives null then. */
  problem: DataFileProblem | null;
  /** Where its records start: the bytes from here on go to a stream's `push`. */
  start: number;
  /** A new reader of its records, from `start`. */
  records(): DataRecordStream | null;
  /** Forget the key. */
  close(): void;
}

/** Whether a key derivation is one this Chord makes keys with, within what it takes (scrypt itself needs N < 2^(16·r)). */
function usableKdf(kdf: unknown): kdf is DataKdf {
  if (!kdf || typeof kdf !== 'object') return false;
  const k = kdf as Record<string, unknown>;
  const { N, r, p } = k as { N: number; r: number; p: number };
  if (k['name'] !== 'scrypt' || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  return N >= 2 ** 10 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && N < 2 ** (16 * r) && p >= 1 && p <= 4 && 128 * N * r <= MAX_SCRYPT_MEMORY;
}

const unopened = (problem: DataFileProblem, encrypted: boolean, header: DataHeader | null = null): DataFileOpen => ({
  header,
  encrypted,
  problem,
  start: 0,
  records: () => null,
  close: () => undefined,
});

/**
 * Open a file, plain or encrypted (by its first line, never its name), from
 * its first DATA_HEAD bytes (`head`, the whole file if it's shorter) and its
 * size. With the right passphrase an encrypted file reads exactly as the plain
 * one would. Never throws: what can't be read is a problem.
 */
export async function openDataFile(head: Uint8Array, size: number, passphrase: string | null, c: DataCrypto): Promise<DataFileOpen> {
  const decoder = new TextDecoder('utf-8');
  const firstBreak = head.indexOf(0x0a);
  const first = decoder.decode(head.subarray(0, firstBreak < 0 ? Math.min(head.length, MAX_HEADER) : Math.min(firstBreak, MAX_HEADER)));
  const magic = /^chord-encrypted (\d{1,6})$/.exec(first);
  if (!magic) {
    let raw: unknown;
    try {
      raw = JSON.parse(first);
    } catch {
      return unopened('not-chord', false);
    }
    const header = parseHeader(raw);
    if (!header) return unopened('not-chord', false);
    if (header.format > DATA_FORMAT) return unopened('newer', false, header);
    return { header, encrypted: false, problem: null, start: firstBreak < 0 ? size : firstBreak + 1, records: () => new PlainStream(), close: () => undefined };
  }

  const envelope = Number(magic[1]);
  if (envelope !== ENVELOPE_VERSION) return unopened(envelope > ENVELOPE_VERSION ? 'newer' : 'not-chord', true);
  const headerEnd = head.indexOf(0x0a, firstBreak + 1);
  // No end to the header in the whole file is a file cut short; none within 64 KB, a damaged one.
  if (headerEnd < 0 || headerEnd - firstBreak > MAX_HEADER) return unopened(headerEnd < 0 && head.length >= size ? 'cut-short' : 'damaged', true);
  const headerBytes = copyOf(head.subarray(firstBreak + 1, headerEnd));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>;
  } catch {
    return unopened('damaged', true);
  }
  const header = parseHeader(raw);
  if (!header) return unopened('damaged', true);
  if (header.format > DATA_FORMAT || !usableKdf(raw['kdf'])) return unopened('newer', true, header);
  const kdfSalt = fromBase64(raw['kdf'].salt);
  const fileSalt = fromBase64(raw['salt']);
  const check = fromBase64(raw['check']);
  if (!kdfSalt || kdfSalt.length < 16 || !fileSalt || fileSalt.length < 16 || !check || check.length !== NONCE + CHECK_WORD.length + TAG) return unopened('damaged', true, header);
  if (passphrase === null) return unopened('needs-passphrase', true, header);

  let root: Uint8Array;
  try {
    root = await rootKey(c, passphrase, raw['kdf'], kdfSalt);
  } catch {
    // Parameters this crypto library won't run: a newer Chord's, as far as this one can tell.
    return unopened('newer', true, header);
  }
  const word = c.open(checkKey(c, root, kdfSalt), check.subarray(0, NONCE), check.subarray(NONCE), new Uint8Array(0));
  if (!word || decoder.decode(word) !== CHECK_WORD) return unopened('wrong-passphrase', true, header);
  const key = fileKey(c, root, fileSalt);
  root.fill(0);
  const headerHash = c.sha256(headerBytes);
  return { header, encrypted: true, problem: null, start: headerEnd + 1, records: () => new FrameStream(c, key, headerHash), close: () => key.fill(0) };
}

/**
 * A whole file in memory, plain or encrypted: `openDataFile` and one stream,
 * at once. Never throws: what can't be read is a problem, with what could be.
 */
export async function readDataFile(bytes: Uint8Array, passphrase: string | null, c: DataCrypto): Promise<DataFileRead> {
  const opened = await openDataFile(bytes.subarray(0, DATA_HEAD), bytes.length, passphrase, c);
  const stream = opened.records();
  if (!stream) return { header: opened.header, encrypted: opened.encrypted, records: [], problem: opened.problem };
  const records = stream.push(bytes.subarray(opened.start));
  for (const record of stream.end()) records.push(record);
  opened.close();
  return { header: opened.header, encrypted: opened.encrypted, records, problem: stream.problem };
}
