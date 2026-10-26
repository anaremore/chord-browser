/**
 * Sync's folder protocol (docs/decisions/S15-your-data.md §6, §13): pure, with
 * the folder and the crypto passed in, so it's tested against an in-memory
 * folder and run by sync's worker against the real one.
 *
 * ```
 * <the folder you pick>/Chord sync/
 *   sync-1.json                          the KDF, its salt and the key check, written once
 *   1/9f2c4e1a7b3d5c60/000001.chordlog   this computer's log, in segments
 *   1/03be7d1c55a2e9f4/000001.chordlog   another computer's
 * ```
 *
 * A segment is an encrypted Chord file (data-file.ts) whose root key comes
 * from `sync-<generation>.json`: its readable line, its header (kind `sync`,
 * with its computer, generation, number, whether it's a snapshot, and its own
 * salt), then frames, appended over time. Every frame is sealed with the
 * header's hash and its index, and none is marked last: a segment is
 * open-ended, so a frame cut short, or one that fails its check, is one the
 * sync app hasn't delivered yet. A reader stops there, and tries again later.
 *
 * Everything read here is untrusted: sizes, names, headers, frames and lines
 * are bounded as an import's are, and records go on to `checkSyncRecord`.
 */
import { DATA_FORMAT, DATA_FORMAT_ABOUT, DATA_HEAD, ENCRYPTED_LINE, ENVELOPE_VERSION, envelope, FRAME_TARGET, MAX_FRAME, MAX_LINE, recordLine, SCRYPT, type DataCrypto, type DataKdf, type ScryptParams } from './data-file';
import { isDataRecord, type DataRecord } from './records';
import { isDeviceId } from './stamps';

// Core compiles without DOM types; these are globals in Node and every browser.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(bytes: Uint8Array): string };

const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const { NONCE, TAG, KEY, MAX_INFLATED } = envelope;

/** The folder, as sync's worker sees it: paths are relative to `Chord sync`, with `/` between parts. */
export interface SyncFs {
  /** Names in a folder, or null when it isn't there. */
  list(path: string): Promise<string[] | null>;
  /** A file's size and when it last changed (ms), or null. */
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  /** Up to `length` bytes from `position`: fewer at its end. */
  read(path: string, position: number, length: number): Promise<Uint8Array>;
  /** A new file, whole: a reader never sees it half made. With `exclusive`, it fails if the file is there. */
  create(path: string, bytes: Uint8Array, exclusive?: boolean): Promise<void>;
  /** Bytes added at the end of a file, then flushed to the disk. */
  append(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** A file, or a folder and everything in it. */
  remove(path: string): Promise<void>;
}

export const SYNC_FOLDER = 'Chord sync';
/** A segment closes at this size and is never touched again, so a sync app uploads each closed one once. */
export const SEGMENT_CLOSE = 1024 * 1024;
/** The most of the folder one pass reads, so a big log is read over several passes, each answered. */
export const PASS_BYTES = 16 * 1024 * 1024;
/** `sync-<n>.json` is small; one bigger isn't Chord's. */
const MAX_SYNC_FILE = 64 * 1024;
/** Sync's own format, apart from the records' (`DATA_FORMAT`) and the envelope's. */
export const SYNC_FORMAT = 1;

export const segmentName = (n: number): string => `${String(n).padStart(6, '0')}.chordlog`;
const SEGMENT = /^(\d{6})\.chordlog$/;
const SYNC_FILE = /^sync-(\d{1,6})\.json$/;
export const syncFileName = (generation: number): string => `sync-${generation}.json`;
export const deviceFolder = (generation: number, device: string): string => `${generation}/${device}`;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/* ---------- sync-<n>.json ---------- */

/** A generation's file: how to make the root key from the passphrase, and a check that tells a wrong one. */
export interface SyncFile {
  generation: number;
  kdf: DataKdf;
  /** "chord", sealed with the check key: nonce, ciphertext, tag. */
  check: Uint8Array;
  /** The computer that wrote it: Settings names it when the passphrase changed. */
  by: string;
  created: string;
}

export type SyncFileRead = { ok: true; file: SyncFile } | { ok: false; problem: 'missing' | 'newer' | 'damaged' };

/** A generation's file, read and checked: its format, its key derivation within what Chord runs (as an import's), its sizes. */
export async function readSyncFile(fs: SyncFs, generation: number): Promise<SyncFileRead> {
  const path = syncFileName(generation);
  const stat = await fs.stat(path);
  if (!stat) return { ok: false, problem: 'missing' };
  if (stat.size > MAX_SYNC_FILE) return { ok: false, problem: 'damaged' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(await fs.read(path, 0, MAX_SYNC_FILE))) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: 'damaged' };
  }
  if (!raw || typeof raw !== 'object' || raw['chord'] !== 'sync' || !Number.isInteger(raw['format'])) return { ok: false, problem: 'damaged' };
  if ((raw['format'] as number) > SYNC_FORMAT) return { ok: false, problem: 'newer' };
  if (raw['generation'] !== generation) return { ok: false, problem: 'damaged' };
  // A key derivation Chord doesn't know, or won't run, is a newer Chord's (as for a file, data-file.ts).
  if (!envelope.usableKdf(raw['kdf'])) return { ok: false, problem: 'newer' };
  const salt = envelope.fromBase64(raw['kdf'].salt);
  const check = envelope.fromBase64(raw['check']);
  if (!salt || salt.length < 16 || !check || check.length !== NONCE + envelope.checkWord.length + TAG) return { ok: false, problem: 'damaged' };
  const by = typeof raw['by'] === 'string' && isDeviceId(raw['by']) ? raw['by'] : '';
  const created = typeof raw['created'] === 'string' ? raw['created'].slice(0, 40) : '';
  return { ok: true, file: { generation, kdf: raw['kdf'], check, by, created } };
}

/** Whether a root key opens a generation: its check, as a file's tells a wrong passphrase from damage. */
export function keyOpens(file: SyncFile, root: Uint8Array, c: DataCrypto): boolean {
  const salt = envelope.fromBase64(file.kdf.salt);
  if (!salt) return false;
  const word = c.open(envelope.checkKey(c, root, salt), file.check.subarray(0, NONCE), file.check.subarray(NONCE), new Uint8Array(0));
  return word !== null && decoder.decode(word) === envelope.checkWord;
}

/** The root key from a passphrase, or null when it doesn't open this generation. scrypt: about half a second. */
export async function unlock(file: SyncFile, passphrase: string, c: DataCrypto): Promise<Uint8Array | null> {
  const salt = envelope.fromBase64(file.kdf.salt);
  if (!salt) return null;
  let root: Uint8Array;
  try {
    root = await envelope.rootKey(c, passphrase, file.kdf, salt);
  } catch {
    return null;
  }
  if (keyOpens(file, root, c)) return root;
  root.fill(0);
  return null;
}

/**
 * A new generation's file, written once and never over another (`exclusive`):
 * a new KDF salt, and the check. Returns the root key.
 */
export async function writeSyncFile(fs: SyncFs, generation: number, passphrase: string, by: string, c: DataCrypto, params: ScryptParams = SCRYPT, now = Date.now()): Promise<Uint8Array> {
  const salt = c.random(32);
  const root = await envelope.rootKey(c, passphrase, params, salt);
  const nonce = c.random(NONCE);
  const check = envelope.concat([nonce, c.seal(envelope.checkKey(c, root, salt), nonce, utf8.encode(envelope.checkWord), new Uint8Array(0))]);
  const body = {
    chord: 'sync',
    format: SYNC_FORMAT,
    generation,
    kdf: { name: 'scrypt', ...params, salt: envelope.toBase64(salt) },
    check: envelope.toBase64(check),
    by,
    created: new Date(now).toISOString(),
    about: DATA_FORMAT_ABOUT,
  };
  await fs.create(syncFileName(generation), utf8.encode(`${JSON.stringify(body)}\n`), true);
  return root;
}

/** What `Chord sync` holds: its generations, newest last, and whether a sync app made a conflicted copy of one. */
export async function generations(fs: SyncFs): Promise<{ generations: number[]; conflicted: boolean } | null> {
  const names = await fs.list('');
  if (!names) return null;
  const found: number[] = [];
  let conflicted = false;
  for (const name of names) {
    const match = SYNC_FILE.exec(name);
    if (match) found.push(Number(match[1]));
    // Sync apps name a conflicted copy after the file: "sync-1 (conflicted copy).json", "sync-1-DESKTOP.json".
    else if (/^sync-\d/.test(name) && name.endsWith('.json')) conflicted = true;
  }
  return { generations: found.sort((a, b) => a - b), conflicted };
}

/** The computers whose folders a generation has (names that are a computer's id; anything else is ignored). */
export async function devicesIn(fs: SyncFs, generation: number): Promise<string[]> {
  return ((await fs.list(String(generation))) ?? []).filter(isDeviceId).sort();
}

/** A computer's segments, oldest first. Names that aren't `NNNNNN.chordlog` (temp files, conflicted copies) are ignored. */
export async function segmentsOf(fs: SyncFs, generation: number, device: string): Promise<number[]> {
  const out: number[] = [];
  for (const name of (await fs.list(deviceFolder(generation, device))) ?? []) {
    const match = SEGMENT.exec(name);
    if (match && Number(match[1]) > 0) out.push(Number(match[1]));
  }
  return out.sort((a, b) => a - b);
}

/* ---------- Segments ---------- */

/** A segment's header: a Chord file's, of kind `sync`, with where it belongs and its own salt. */
export interface SegmentHeader {
  chord: 'data';
  format: number;
  kind: 'sync';
  app: string;
  device: string;
  created: string;
  includes: ['setup'];
  about: string;
  generation: number;
  segment: number;
  /** A snapshot holds everything its computer knew: earlier segments of its computer can be passed over. */
  snapshot: boolean;
  /** Base64, 32 random bytes: the segment's key is HKDF of the root key and it. */
  salt: string;
}

/** Where a computer's reading of a segment has got: past `frame` frames, `offset` bytes in, of the segment whose header hashes to `head`. */
export interface SegmentCursor {
  head: string;
  offset: number;
  frame: number;
  snapshot: boolean;
}

/** A segment opened: its header, where its frames start, and its key. */
interface Opened {
  header: SegmentHeader;
  start: number;
  key: Uint8Array;
  hash: Uint8Array;
}

type OpenResult = { ok: true; opened: Opened } | { ok: false; problem: 'newer' | 'damaged' | 'short' };

/** A segment's head, checked: Chord's envelope, a sync header for this very place, a salt. */
async function openSegment(fs: SyncFs, path: string, generation: number, device: string, n: number, root: Uint8Array, c: DataCrypto): Promise<OpenResult> {
  const head = await fs.read(path, 0, DATA_HEAD);
  const first = head.indexOf(0x0a);
  if (first < 0) return { ok: false, problem: 'short' };
  const magic = new RegExp(`^${ENCRYPTED_LINE} (\\d{1,6})$`).exec(decoder.decode(head.subarray(0, first)));
  if (!magic) return { ok: false, problem: 'damaged' };
  if (Number(magic[1]) !== ENVELOPE_VERSION) return { ok: false, problem: Number(magic[1]) > ENVELOPE_VERSION ? 'newer' : 'damaged' };
  const end = head.indexOf(0x0a, first + 1);
  if (end < 0) return { ok: false, problem: head.length >= DATA_HEAD ? 'damaged' : 'short' };
  const line = new Uint8Array(head.subarray(first + 1, end));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decoder.decode(line)) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: 'damaged' };
  }
  if (!raw || typeof raw !== 'object' || raw['chord'] !== 'data' || !Number.isInteger(raw['format'])) return { ok: false, problem: 'damaged' };
  if ((raw['format'] as number) > DATA_FORMAT) return { ok: false, problem: 'newer' };
  // A segment says where it belongs: one moved, or copied into another computer's folder, isn't read.
  if (raw['kind'] !== 'sync' || raw['device'] !== device || raw['generation'] !== generation || raw['segment'] !== n) return { ok: false, problem: 'damaged' };
  const salt = envelope.fromBase64(raw['salt']);
  if (!salt || salt.length < 16) return { ok: false, problem: 'damaged' };
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const header: SegmentHeader = {
    chord: 'data',
    format: raw['format'] as number,
    kind: 'sync',
    app: text(raw['app']),
    device,
    created: text(raw['created']),
    includes: ['setup'],
    about: text(raw['about']),
    generation,
    segment: n,
    snapshot: raw['snapshot'] === true,
    salt: raw['salt'] as string,
  };
  return { ok: true, opened: { header, start: end + 1, key: envelope.fileKey(c, root, salt), hash: c.sha256(line) } };
}

/** What reading one segment gave: its records, where reading got to, and why it stopped short, if it did. */
export interface SegmentRead {
  records: DataRecord[];
  cursor: SegmentCursor;
  /** Lines that weren't records: passed over. */
  bad: number;
  /** `newer`: a newer Chord wrote it. `damaged`: its head isn't one, or its frames can't be told apart. `waiting`: the next frame isn't whole yet. */
  stopped: 'newer' | 'damaged' | 'waiting' | null;
  /** More is there, past this pass's bytes. */
  more: boolean;
}

/**
 * Reads a segment from where its cursor says, up to `budget` bytes of frames:
 * a cursor for a different head, or past the file's end (a sync app delivered
 * an older, shorter copy), starts again from the first frame: merging twice
 * changes nothing. A frame that isn't whole, or doesn't open, stops the read
 * there without moving past it.
 */
export async function readSegment(
  fs: SyncFs,
  where: { generation: number; device: string; segment: number },
  root: Uint8Array,
  cursor: SegmentCursor | null,
  c: DataCrypto,
  budget = PASS_BYTES,
): Promise<SegmentRead> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const empty = (stopped: SegmentRead['stopped'], at: SegmentCursor | null): SegmentRead => ({ records: [], cursor: at ?? { head: '', offset: 0, frame: 0, snapshot: false }, bad: 0, stopped, more: false });
  const stat = await fs.stat(path);
  if (!stat) return empty('waiting', cursor);
  const opened = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (!opened.ok) return empty(opened.problem === 'short' ? 'waiting' : opened.problem, cursor);
  const { header, start, key, hash } = opened.opened;
  const head = hex(hash);
  let at: SegmentCursor = cursor && cursor.head === head && cursor.offset >= start && cursor.offset <= stat.size ? { ...cursor } : { head, offset: start, frame: 0, snapshot: header.snapshot };
  const records: DataRecord[] = [];
  let bad = 0;
  let read = 0;
  while (at.offset < stat.size) {
    if (read >= budget) return { records, cursor: at, bad, stopped: null, more: true };
    const lengthBytes = await fs.read(path, at.offset, 4);
    if (lengthBytes.length < 4) return { records, cursor: at, bad, stopped: 'waiting', more: false };
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
    // The frames can't be told apart past a length that can't be one: nothing after it is read.
    if (length < NONCE + TAG || length > MAX_FRAME) return { records, cursor: at, bad, stopped: 'damaged', more: false };
    if (at.offset + 4 + length > stat.size) return { records, cursor: at, bad, stopped: 'waiting', more: false };
    const frame = await fs.read(path, at.offset + 4, length);
    if (frame.length < length) return { records, cursor: at, bad, stopped: 'waiting', more: false };
    const plain = c.open(key, frame.subarray(0, NONCE), frame.subarray(NONCE), envelope.frameAad(hash, at.frame, false));
    const inflated = plain && c.inflate(plain, MAX_INFLATED);
    // Not whole yet, as far as anyone can tell: the sync app may still be delivering it. Read again next time.
    if (!inflated) return { records, cursor: at, bad, stopped: 'waiting', more: false };
    for (const text of decoder.decode(inflated).split('\n')) {
      if (!text) continue;
      if (text.length > MAX_LINE) {
        bad++;
        continue;
      }
      try {
        const value: unknown = JSON.parse(text);
        if (isDataRecord(value)) records.push(value);
        else bad++;
      } catch {
        bad++;
      }
    }
    at = { ...at, offset: at.offset + 4 + length, frame: at.frame + 1 };
    read += 4 + length;
  }
  return { records, cursor: at, bad, stopped: null, more: false };
}

/** A segment's header, for finding a computer's newest snapshot; null when it can't be read (yet). */
export async function segmentHeader(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto): Promise<SegmentHeader | 'newer' | null> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const opened = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (opened.ok) return opened.opened.header;
  return opened.problem === 'newer' ? 'newer' : null;
}

/* ---------- Writing ---------- */

/** This computer's newest segment as it left it: what's appended next goes after `size` bytes, as frame `frames`. */
export interface OwnSegment {
  generation: number;
  device: string;
  segment: number;
  size: number;
  frames: number;
}

/** Frames of whole lines, each up to FRAME_TARGET before it's sealed; a line longer than a line may be is left out. */
function frames(records: readonly DataRecord[], key: Uint8Array, hash: Uint8Array, first: number, c: DataCrypto): { bytes: Uint8Array[]; count: number } {
  const out: Uint8Array[] = [];
  let lines: string[] = [];
  let size = 0;
  let index = first;
  const seal = () => {
    if (lines.length === 0) return;
    const nonce = c.random(NONCE);
    const body = c.seal(key, nonce, c.deflate(utf8.encode(lines.join(''))), envelope.frameAad(hash, index++, false));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, NONCE + body.length);
    out.push(envelope.concat([length, nonce, body]));
    lines = [];
    size = 0;
  };
  for (const record of records) {
    const line = recordLine(record);
    if (line.length * 3 > MAX_LINE && utf8.encode(line).length > MAX_LINE) continue;
    if (size > 0 && size + line.length > FRAME_TARGET) seal();
    lines.push(line);
    size += line.length;
  }
  seal();
  return { bytes: out, count: index - first };
}

function newHeader(where: { generation: number; device: string; segment: number }, snapshot: boolean, app: string, c: DataCrypto, now: number): { line: Uint8Array; salt: Uint8Array } {
  const salt = c.random(32);
  const header: SegmentHeader = {
    chord: 'data',
    format: DATA_FORMAT,
    kind: 'sync',
    app,
    device: where.device,
    created: new Date(now).toISOString(),
    includes: ['setup'],
    about: DATA_FORMAT_ABOUT,
    generation: where.generation,
    segment: where.segment,
    snapshot,
    salt: envelope.toBase64(salt),
  };
  return { line: utf8.encode(JSON.stringify(header)), salt };
}

/**
 * A new segment, made whole before anyone can see it (`create`): its header,
 * then `records` (the computer's `device` record first, as every segment
 * starts). A snapshot holds everything this computer knows.
 */
export async function writeSegment(
  fs: SyncFs,
  where: { generation: number; device: string; segment: number },
  records: readonly DataRecord[],
  root: Uint8Array,
  opts: { snapshot: boolean; app: string; now?: number },
  c: DataCrypto,
): Promise<OwnSegment> {
  await fs.mkdir(deviceFolder(where.generation, where.device));
  const { line, salt } = newHeader(where, opts.snapshot, opts.app, c, opts.now ?? Date.now());
  const key = envelope.fileKey(c, root, salt);
  const sealed = frames(records, key, c.sha256(line), 0, c);
  const bytes = envelope.concat([utf8.encode(`${ENCRYPTED_LINE} ${ENVELOPE_VERSION}\n`), line, utf8.encode('\n'), ...sealed.bytes]);
  await fs.create(`${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`, bytes);
  key.fill(0);
  return { ...where, size: bytes.length, frames: sealed.count };
}

export type AppendResult = { ok: true; own: OwnSegment; frames: number; bytes: number } | { ok: false; problem: 'copied' | 'missing' };

/**
 * Records appended to this computer's newest segment as one frame (or more,
 * past FRAME_TARGET), then flushed. First it checks the segment ends where
 * this computer left it: if it doesn't, another computer is writing under the
 * same id (a profile folder copied to a new computer), and nothing is written.
 * A segment past SEGMENT_CLOSE is left as it is, and a new one starts.
 */
export async function appendRecords(fs: SyncFs, own: OwnSegment, records: readonly DataRecord[], root: Uint8Array, opts: { app: string; device: readonly DataRecord[]; now?: number }, c: DataCrypto): Promise<AppendResult> {
  const folder = deviceFolder(own.generation, own.device);
  const path = `${folder}/${segmentName(own.segment)}`;
  const stat = await fs.stat(path);
  if (!stat) return { ok: false, problem: 'missing' };
  if (stat.size !== own.size) return { ok: false, problem: 'copied' };
  const newest = (await segmentsOf(fs, own.generation, own.device)).at(-1) ?? own.segment;
  if (newest > own.segment) return { ok: false, problem: 'copied' };
  if (own.size >= SEGMENT_CLOSE) {
    const next = await writeSegment(fs, { generation: own.generation, device: own.device, segment: own.segment + 1 }, [...opts.device, ...records], root, { snapshot: false, app: opts.app, ...(opts.now ? { now: opts.now } : {}) }, c);
    return { ok: true, own: next, frames: next.frames, bytes: next.size };
  }
  const head = await fs.read(path, 0, DATA_HEAD);
  const first = head.indexOf(0x0a);
  const end = first < 0 ? -1 : head.indexOf(0x0a, first + 1);
  if (end < 0) return { ok: false, problem: 'copied' };
  const line = new Uint8Array(head.subarray(first + 1, end));
  let salt: Uint8Array | null = null;
  try {
    salt = envelope.fromBase64((JSON.parse(decoder.decode(line)) as Record<string, unknown>)['salt']);
  } catch {
    salt = null;
  }
  if (!salt) return { ok: false, problem: 'copied' };
  const key = envelope.fileKey(c, root, salt);
  const sealed = frames(records, key, c.sha256(line), own.frames, c);
  key.fill(0);
  const bytes = envelope.concat(sealed.bytes);
  await fs.append(path, bytes);
  return { ok: true, own: { ...own, size: own.size + bytes.length, frames: own.frames + sealed.count }, frames: sealed.count, bytes: bytes.length };
}

/** Keys are 32 bytes: the root key as main keeps it (safeStorage) and hands it back. */
export const isRootKey = (key: Uint8Array): boolean => key.length === KEY;

/* ---------- The folder as a whole ---------- */

/** What a folder you picked holds, before any passphrase: nothing of Chord's yet, one to join, or one Chord can't use. */
export type FolderInspection =
  | { state: 'new'; generation: number }
  | { state: 'join'; generation: number; computers: number }
  | { state: 'conflict' }
  | { state: 'newer' }
  | { state: 'damaged' };

/**
 * A folder you picked, looked at (`Chord sync` in it): its newest
 * generation's file, and how many computers sync through it. Their names are
 * inside the encryption, so they show once the passphrase opens it. Two
 * `sync-<n>.json` of one generation (a sync app's conflicted copy: two
 * computers set it up at once) can't be joined.
 */
export async function inspectFolder(fs: SyncFs): Promise<FolderInspection> {
  const found = await generations(fs);
  if (!found || found.generations.length === 0) {
    // Folders left from something else start no generation of their own: a new one goes past them.
    const names = (await fs.list('')) ?? [];
    const past = names.filter((n) => /^\d{1,6}$/.test(n)).map(Number);
    return found?.conflicted ? { state: 'conflict' } : { state: 'new', generation: Math.max(0, ...past) + 1 };
  }
  if (found.conflicted) return { state: 'conflict' };
  const generation = found.generations.at(-1)!;
  const file = await readSyncFile(fs, generation);
  if (!file.ok) return { state: file.problem === 'newer' ? 'newer' : 'damaged' };
  return { state: 'join', generation, computers: (await devicesIn(fs, generation)).length };
}

/**
 * Sync set up on this computer, in a folder with nothing of Chord's: the
 * first generation's file (never over another's), then a look for a second
 * one a sync app delivered meanwhile (S15 §6: the second to set it up stops).
 */
export async function setUp(fs: SyncFs, generation: number, passphrase: string, self: string, c: DataCrypto, params: ScryptParams = SCRYPT): Promise<{ ok: true; root: Uint8Array } | { ok: false; problem: 'conflict' }> {
  await fs.mkdir('');
  let root: Uint8Array;
  try {
    root = await writeSyncFile(fs, generation, passphrase, self, c, params);
  } catch {
    return { ok: false, problem: 'conflict' };
  }
  const found = await generations(fs);
  if (!found || found.conflicted || found.generations.some((g) => g > generation)) {
    root.fill(0);
    return { ok: false, problem: 'conflict' };
  }
  return { ok: true, root };
}

/** What a look at the folder found, before reading anyone's log. */
export type FolderLook =
  | { state: 'ok' }
  /** `Chord sync`, or this generation's file, isn't there: the sync app isn't running, or the folder moved. */
  | { state: 'missing' }
  /** A newer Chord's file, or a key derivation this one can't run. */
  | { state: 'newer' }
  /** A newer generation: the passphrase was changed, on `by`. */
  | { state: 'changed'; generation: number; by: string }
  /** This generation's file doesn't open with this computer's key: two computers set the folder up at once, and the other's won. */
  | { state: 'conflict' };

export async function lookAtFolder(fs: SyncFs, generation: number, root: Uint8Array, c: DataCrypto): Promise<FolderLook> {
  const found = await generations(fs);
  if (!found || found.generations.length === 0) return { state: 'missing' };
  const newest = found.generations.at(-1)!;
  if (newest > generation) {
    const file = await readSyncFile(fs, newest);
    if (file.ok) return { state: 'changed', generation: newest, by: file.file.by };
    if (file.problem === 'newer') return { state: 'newer' };
  }
  const file = await readSyncFile(fs, generation);
  if (!file.ok) return { state: file.problem === 'newer' ? 'newer' : 'missing' };
  return keyOpens(file.file, root, c) ? { state: 'ok' } : { state: 'conflict' };
}

/** One step of reading the other computers' logs. */
export type ReadEvent =
  | { kind: 'records'; device: string; segment: number; records: DataRecord[]; cursor: SegmentCursor; bad: number }
  /** A computer whose log a newer Chord wrote: nothing more of it is read. */
  | { kind: 'newer'; device: string }
  /** When a computer last wrote (its newest segment's time), for Settings' list. */
  | { kind: 'seen'; device: string; at: number };

/**
 * Every other computer's log, from where this one has read to: for each, its
 * newest snapshot and what came after (earlier segments are passed over: the
 * snapshot holds them), a segment at a time, at most `budget` bytes a step.
 * Each step is yielded for the caller to merge (and save its cursor) before
 * the next is read. A segment that isn't whole yet is read again next time.
 */
export async function* readComputers(
  fs: SyncFs,
  opts: { generation: number; self: string; root: Uint8Array; cursor(device: string, segment: number): SegmentCursor | null; budget?: number },
  c: DataCrypto,
): AsyncGenerator<ReadEvent> {
  for (const device of await devicesIn(fs, opts.generation)) {
    if (device === opts.self) continue;
    const segments = await segmentsOf(fs, opts.generation, device);
    if (segments.length === 0) continue;
    // The newest snapshot: everything before it is in it.
    let start = segments[0]!;
    let newer = false;
    for (let i = segments.length - 1; i >= 0; i--) {
      const known = opts.cursor(device, segments[i]!);
      const header = known ? null : await segmentHeader(fs, { generation: opts.generation, device, segment: segments[i]! }, opts.root, c);
      if (header === 'newer') {
        newer = true;
        break;
      }
      if (known?.snapshot || (header && header.snapshot)) {
        start = segments[i]!;
        break;
      }
    }
    if (newer) {
      yield { kind: 'newer', device };
      continue;
    }
    for (const segment of segments) {
      if (segment < start) continue;
      for (;;) {
        const read = await readSegment(fs, { generation: opts.generation, device, segment }, opts.root, opts.cursor(device, segment), c, opts.budget);
        if (read.stopped === 'newer') {
          newer = true;
          break;
        }
        yield { kind: 'records', device, segment, records: read.records, cursor: read.cursor, bad: read.bad };
        if (!read.more) break;
      }
      if (newer) break;
    }
    if (newer) {
      yield { kind: 'newer', device };
      continue;
    }
    const last = await fs.stat(`${deviceFolder(opts.generation, device)}/${segmentName(segments.at(-1)!)}`);
    if (last) yield { kind: 'seen', device, at: last.mtime };
  }
}

/**
 * A snapshot as this computer's first segment in a generation (joining,
 * setting up, a new passphrase, a new id) or as compaction: after every
 * segment it has there, and then those earlier ones go, since the snapshot
 * holds them.
 */
export async function writeSnapshot(fs: SyncFs, where: { generation: number; device: string }, records: readonly DataRecord[], root: Uint8Array, opts: { app: string; now?: number }, c: DataCrypto): Promise<OwnSegment> {
  const before = await segmentsOf(fs, where.generation, where.device);
  const own = await writeSegment(fs, { ...where, segment: (before.at(-1) ?? 0) + 1 }, records, root, { snapshot: true, app: opts.app, ...(opts.now ? { now: opts.now } : {}) }, c);
  for (const n of before) await fs.remove(`${deviceFolder(where.generation, where.device)}/${segmentName(n)}`).catch(() => undefined);
  return own;
}

/** A new passphrase (S15 §6): the next generation's file. This computer's snapshot goes under it next (`writeSnapshot`). */
export async function nextGeneration(fs: SyncFs, passphrase: string, self: string, c: DataCrypto, params: ScryptParams = SCRYPT): Promise<{ generation: number; root: Uint8Array }> {
  const found = await generations(fs);
  const generation = Math.max(0, ...(found?.generations ?? [])) + 1;
  return { generation, root: await writeSyncFile(fs, generation, passphrase, self, c, params) };
}

/** The newest generation's root key from a passphrase (joining, or after it changed): null when it doesn't open it. */
export async function unlockNewest(fs: SyncFs, passphrase: string, c: DataCrypto): Promise<{ ok: true; generation: number; root: Uint8Array } | { ok: false; problem: 'wrong' | 'missing' | 'newer' | 'damaged' }> {
  const found = await generations(fs);
  if (!found || found.generations.length === 0) return { ok: false, problem: 'missing' };
  const generation = found.generations.at(-1)!;
  const file = await readSyncFile(fs, generation);
  if (!file.ok) return { ok: false, problem: file.problem };
  const root = await unlock(file.file, passphrase, c);
  return root ? { ok: true, generation, root } : { ok: false, problem: 'wrong' };
}
