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
 * A segment's first frame holds only its computer's `device` record, so it's
 * small: a segment is real once that frame opens with the key, which proves
 * its header too. Anything else under a segment's name (junk anyone who can
 * write to the folder could put there) is passed over, and never decides
 * which segment is a computer's newest, or that another computer writes under
 * this one's id.
 *
 * Everything read here is untrusted: sizes, names, headers, frames and lines
 * are bounded as an import's are, each step of reading is bounded by bytes
 * read, bytes inflated and records, and records go on to `checkSyncRecord`.
 */
import { DATA_FORMAT, DATA_FORMAT_ABOUT, DATA_HEAD, ENCRYPTED_LINE, ENVELOPE_VERSION, envelope, FRAME_TARGET, MAX_FRAME, MAX_LINE, recordLine, SCRYPT, type DataCrypto, type DataKdf, type ScryptParams } from './data-file';
import { isDataRecord, type DataRecord } from './records';
import { isDeviceId } from './stamps';

// Core compiles without DOM types; these are globals in Node and every browser.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(bytes: Uint8Array): string };

const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const { NONCE, TAG, KEY } = envelope;

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
  /** A file given another name, in place of any file that had it: how a segment written in pieces appears whole. */
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** A file, or a folder and everything in it. */
  remove(path: string): Promise<void>;
}

export const SYNC_FOLDER = 'Chord sync';
/** A segment closes at this size and is never touched again, so a sync app uploads each closed one once. */
export const SEGMENT_CLOSE = 1024 * 1024;
/**
 * The most one step of reading holds: bytes read from the folder, bytes once
 * inflated, and records. Each step is merged and answered before the next is
 * read, so a big log, or one made to inflate a thousandfold, is read over
 * many steps, each a bounded piece of memory.
 */
export const PASS_BYTES = 16 * 1024 * 1024;
export const STEP_INFLATED = 16 * 1024 * 1024;
export const STEP_RECORDS = 20_000;
/**
 * No frame Chord writes inflates past FRAME_TARGET and one record (a synced
 * thing is at most 2 MiB), nor holds more than a few thousand records. One
 * past these opened, so it's from a computer with the passphrase, but it's
 * passed over (`refused`), and reading goes on after it.
 */
const FRAME_INFLATED = 8 * 1024 * 1024;
const FRAME_RECORDS = 20_000;
/** A segment's first frame holds only its computer's `device` record: anything longer isn't one. */
const FIRST_FRAME = 64 * 1024;
/** `sync-<n>.json` is small; one bigger isn't Chord's. */
const MAX_SYNC_FILE = 64 * 1024;
/** The most computers sync reads (it keeps 64 devices): only folders holding a real segment count. More, and Settings says so. */
export const MAX_COMPUTERS = 64;
/** Names have six digits: a segment or a generation past this would be one no reader lists. */
export const MAX_SEGMENT = 999_999;
const MAX_GENERATION = 999_999;
/** Segments looked into per pass to tell real ones from junk; a folder full of junk is looked through over several passes. */
const MAX_PROBES = 4096;
/** Sync's own format, apart from the records' (`DATA_FORMAT`) and the envelope's. */
export const SYNC_FORMAT = 1;

export function segmentName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEGMENT) throw new SegmentsFull(n);
  return `${String(n).padStart(6, '0')}.chordlog`;
}
const SEGMENT = /^(\d{6})\.chordlog$/;
/** A snapshot written in pieces, before it's renamed into place: no reader takes it for a segment. */
const PART = /^\d{6}\.chordlog\.part-[0-9a-f]+$/;
const SYNC_FILE = /^sync-(\d{1,6})\.json$/;
export const syncFileName = (generation: number): string => `sync-${generation}.json`;
export const deviceFolder = (generation: number, device: string): string => `${generation}/${device}`;

/** A computer's segment numbers reached the top: it takes a new id, whose log starts at 1. */
export class SegmentsFull extends Error {
  constructor(n: number) {
    super(`Segment ${n} is past what a name holds`);
    this.name = 'SegmentsFull';
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const uint32 = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);

/* ---------- sync-<n>.json ---------- */

/** A generation's file: how to make the root key from the passphrase, and a check that tells a wrong one. */
export interface SyncFile {
  generation: number;
  kdf: DataKdf;
  /** "chord", sealed with the check key: nonce, ciphertext, tag. */
  check: Uint8Array;
  /** The computer that says it wrote it. Anyone can write that, so Settings never names it from here. */
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
  if (!Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATION) throw new RangeError(`Generation ${generation} is past what a name holds`);
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
    if (match && Number(match[1]) > 0) found.push(Number(match[1]));
    // Sync apps name a conflicted copy after the file: "sync-1 (conflicted copy).json", "sync-1-DESKTOP.json".
    else if (/^sync-\d/.test(name) && name.endsWith('.json')) conflicted = true;
  }
  return { generations: found.sort((a, b) => a - b), conflicted };
}

/** The folders of a generation named as a computer's id (anything else is ignored); whether each holds a real log is for the reader to find. */
export async function devicesIn(fs: SyncFs, generation: number): Promise<string[]> {
  return ((await fs.list(String(generation))) ?? []).filter(isDeviceId).sort();
}

/** A computer's segment numbers, oldest first. Names that aren't `NNNNNN.chordlog` (temp files, conflicted copies) are ignored. */
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

/**
 * Where a computer's reading of a segment has got: past `frame` frames,
 * `offset` bytes in, of the segment whose header hashes to `head`. `snapshot`
 * only once its first frame has opened (and so its header is real).
 */
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
  /** Its records are a newer Chord's (a higher `format`): what it holds can't be read here, once it's shown to be real. */
  newer: boolean;
}

type OpenResult = { ok: true; opened: Opened } | { ok: false; problem: 'damaged' | 'short' };

/**
 * A segment's head, read: Chord's envelope, a sync header for this very place,
 * a salt. Nothing in it is proven until a frame opens with the key it gives.
 * A newer envelope can't be told from junk, so it's passed over as junk: a
 * Chord that changes the envelope starts a new generation.
 */
async function openSegment(fs: SyncFs, path: string, generation: number, device: string, n: number, root: Uint8Array, c: DataCrypto): Promise<OpenResult> {
  const head = await fs.read(path, 0, DATA_HEAD);
  const first = head.indexOf(0x0a);
  if (first < 0) return { ok: false, problem: 'short' };
  const magic = new RegExp(`^${ENCRYPTED_LINE} (\\d{1,6})$`).exec(decoder.decode(head.subarray(0, first)));
  if (!magic || Number(magic[1]) !== ENVELOPE_VERSION) return { ok: false, problem: 'damaged' };
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
  return { ok: true, opened: { header, start: end + 1, key: envelope.fileKey(c, root, salt), hash: c.sha256(line), newer: (raw['format'] as number) > DATA_FORMAT } };
}

/** The frame at `offset` of a segment, if it's whole and opens as frame `index`: its plaintext. `max` bounds its length. */
async function openFrame(fs: SyncFs, path: string, offset: number, index: number, opened: Opened, max: number, c: DataCrypto): Promise<Uint8Array | null> {
  const lengthBytes = await fs.read(path, offset, 4);
  if (lengthBytes.length < 4) return null;
  const length = uint32(lengthBytes);
  if (length < NONCE + TAG || length > max) return null;
  const frame = await fs.read(path, offset + 4, length);
  if (frame.length < length) return null;
  return c.open(opened.key, frame.subarray(0, NONCE), frame.subarray(NONCE), envelope.frameAad(opened.hash, index, false));
}

/**
 * A segment, if it's real: its first frame opens with the key its header
 * gives, so the header is its computer's (its hash is sealed into every
 * frame). Null for anything else under a segment's name, or one not yet
 * delivered whole. At most two small reads.
 */
export async function realSegment(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto): Promise<{ header: SegmentHeader; newer: boolean } | null> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  if (!(await fs.stat(path))) return null;
  const opened = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (!opened.ok) return null;
  const plain = await openFrame(fs, path, opened.opened.start, 0, opened.opened, FIRST_FRAME, c);
  opened.opened.key.fill(0);
  return plain ? { header: opened.opened.header, newer: opened.opened.newer } : null;
}

/** What one step of reading a segment may hold. */
export interface StepBudget {
  /** Bytes of frames read. */
  bytes: number;
  /** Bytes once inflated. */
  inflated: number;
  records: number;
}

export const STEP_BUDGET: StepBudget = { bytes: PASS_BYTES, inflated: STEP_INFLATED, records: STEP_RECORDS };

/** What reading one segment gave: its records, where reading got to, and why it stopped short, if it did. */
export interface SegmentRead {
  records: DataRecord[];
  cursor: SegmentCursor;
  /** Lines that weren't records: passed over. */
  bad: number;
  /** Frames that opened but were past what a frame may hold: passed over. */
  refused: number;
  /** `newer`: a newer Chord wrote it. `damaged`: its head isn't one, or its frames can't be told apart. `waiting`: the next frame isn't whole yet. */
  stopped: 'newer' | 'damaged' | 'waiting' | null;
  /** More is there, past this step's budget. */
  more: boolean;
}

/**
 * Reads a segment from where its cursor says, one step's worth (`budget`): a
 * cursor for a different head, or past the file's end (a sync app delivered
 * an older, shorter copy), starts again from the first frame: merging twice
 * changes nothing. A frame that isn't whole, or doesn't open, stops the read
 * there without moving past it. One that opens but inflates past what a frame
 * may hold, or holds more records, is passed over and counted (`refused`).
 */
export async function readSegment(
  fs: SyncFs,
  where: { generation: number; device: string; segment: number },
  root: Uint8Array,
  cursor: SegmentCursor | null,
  c: DataCrypto,
  budget: StepBudget = STEP_BUDGET,
): Promise<SegmentRead> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const empty = (stopped: SegmentRead['stopped'], at: SegmentCursor | null): SegmentRead => ({ records: [], cursor: at ?? { head: '', offset: 0, frame: 0, snapshot: false }, bad: 0, refused: 0, stopped, more: false });
  const stat = await fs.stat(path);
  if (!stat) return empty('waiting', cursor);
  const result = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (!result.ok) return empty(result.problem === 'short' ? 'waiting' : 'damaged', cursor);
  const opened = result.opened;
  const head = hex(opened.hash);
  let at: SegmentCursor = cursor && cursor.head === head && cursor.offset >= opened.start && cursor.offset <= stat.size ? { ...cursor } : { head, offset: opened.start, frame: 0, snapshot: false };
  const records: DataRecord[] = [];
  let bad = 0;
  let refused = 0;
  let read = 0;
  let inflated = 0;
  const out = (stopped: SegmentRead['stopped'], more = false): SegmentRead => {
    opened.key.fill(0);
    return { records, cursor: at, bad, refused, stopped, more };
  };
  while (at.offset < stat.size) {
    if (read >= budget.bytes || inflated >= budget.inflated || records.length >= budget.records) return out(null, true);
    const lengthBytes = await fs.read(path, at.offset, 4);
    if (lengthBytes.length < 4) return out('waiting');
    const length = uint32(lengthBytes);
    // The frames can't be told apart past a length that can't be one: nothing after it is read.
    if (length < NONCE + TAG || length > MAX_FRAME) return out('damaged');
    if (at.offset + 4 + length > stat.size) return out('waiting');
    const plain = await openFrame(fs, path, at.offset, at.frame, opened, MAX_FRAME, c);
    // Not whole yet, as far as anyone can tell: the sync app may still be delivering it. Read again next time.
    if (!plain) return out('waiting');
    // It opened, so its header is real: a newer Chord's records can't be read here.
    if (opened.newer) return out('newer');
    const next: SegmentCursor = { ...at, offset: at.offset + 4 + length, frame: at.frame + 1, snapshot: at.frame === 0 ? opened.header.snapshot : at.snapshot };
    read += 4 + length;
    const text = c.inflate(plain, FRAME_INFLATED);
    if (!text) {
      refused++;
      at = next;
      continue;
    }
    const lines = decoder.decode(text).split('\n');
    if (lines.length > FRAME_RECORDS + 1) {
      refused++;
      at = next;
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      if (line.length > MAX_LINE) {
        bad++;
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (isDataRecord(value)) records.push(value);
        else bad++;
      } catch {
        bad++;
      }
    }
    inflated += text.length;
    at = next;
  }
  return out(null);
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

/**
 * Frames of whole lines, each up to FRAME_TARGET before it's sealed; a line
 * longer than a line may be is left out. With `always`, one frame even with
 * no records: every segment has a first frame.
 */
function frames(records: readonly DataRecord[], key: Uint8Array, hash: Uint8Array, first: number, c: DataCrypto, always = false): { bytes: Uint8Array[]; count: number } {
  const out: Uint8Array[] = [];
  let lines: string[] = [];
  let size = 0;
  let index = first;
  const seal = (force = false) => {
    if (lines.length === 0 && !force) return;
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
  seal(always && out.length === 0);
  return { bytes: out, count: index - first };
}

/** A segment's head: its readable line and header, its key, and the hash its frames are sealed with. */
function newHead(where: { generation: number; device: string; segment: number }, snapshot: boolean, app: string, root: Uint8Array, c: DataCrypto, now: number): { bytes: Uint8Array; key: Uint8Array; hash: Uint8Array } {
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
  const line = utf8.encode(JSON.stringify(header));
  return { bytes: envelope.concat([utf8.encode(`${ENCRYPTED_LINE} ${ENVELOPE_VERSION}\n`), line, utf8.encode('\n')]), key: envelope.fileKey(c, root, salt), hash: c.sha256(line) };
}

/**
 * A new segment, made whole before anyone can see it (`create`): its header,
 * a first frame of this computer's `device` record alone (small, so a reader
 * can tell the segment is real cheaply), then `records`.
 */
export async function writeSegment(
  fs: SyncFs,
  where: { generation: number; device: string; segment: number },
  records: readonly DataRecord[],
  root: Uint8Array,
  opts: { snapshot: boolean; app: string; device: readonly DataRecord[]; now?: number },
  c: DataCrypto,
): Promise<OwnSegment> {
  await fs.mkdir(deviceFolder(where.generation, where.device));
  const head = newHead(where, opts.snapshot, opts.app, root, c, opts.now ?? Date.now());
  const first = frames(opts.device, head.key, head.hash, 0, c, true);
  const rest = frames(records, head.key, head.hash, first.count, c);
  head.key.fill(0);
  const bytes = envelope.concat([head.bytes, ...first.bytes, ...rest.bytes]);
  await fs.create(`${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`, bytes);
  return { ...where, size: bytes.length, frames: first.count + rest.count };
}

/**
 * A computer's real segments above `above`, newest first, at most `probes`
 * looked into: what tells another computer writing under this one's id from
 * junk someone put under a segment's name.
 */
async function realAbove(fs: SyncFs, generation: number, device: string, above: number, root: Uint8Array, c: DataCrypto, probes = MAX_PROBES): Promise<number | null> {
  const names = (await segmentsOf(fs, generation, device)).filter((n) => n > above).reverse();
  for (const n of names.slice(0, probes)) if (await realSegment(fs, { generation, device, segment: n }, root, c)) return n;
  return null;
}

export type AppendResult =
  | { ok: true; own: OwnSegment; frames: number; bytes: number }
  /**
   * `copied`: another computer writes under this one's id (a real segment, or
   * frame, past where this one left off). `gone`: this computer's segment
   * isn't there, or is shorter than it left it, though the folder is: a fresh
   * snapshot puts its log back. `missing`: the folder isn't there (the sync
   * app isn't running). `full`: its segment numbers reached the top.
   */
  | { ok: false; problem: 'copied' | 'gone' | 'missing' | 'full' };

/**
 * Records appended to this computer's newest segment as one frame (or more,
 * past FRAME_TARGET), then flushed. First it checks the segment is as this
 * computer left it. Bytes someone added after its last frame would stop every
 * reader there, so then, as past SEGMENT_CLOSE, a new segment starts.
 */
export async function appendRecords(fs: SyncFs, own: OwnSegment, records: readonly DataRecord[], root: Uint8Array, opts: { app: string; device: readonly DataRecord[]; now?: number }, c: DataCrypto): Promise<AppendResult> {
  const folder = deviceFolder(own.generation, own.device);
  const path = `${folder}/${segmentName(own.segment)}`;
  const stat = await fs.stat(path);
  if (!stat) return { ok: false, problem: (await fs.stat(syncFileName(own.generation))) ? 'gone' : 'missing' };
  if ((await realAbove(fs, own.generation, own.device, own.segment, root, c)) !== null) return { ok: false, problem: 'copied' };
  if (stat.size < own.size) return { ok: false, problem: 'gone' };
  const opened = await openSegment(fs, path, own.generation, own.device, own.segment, root, c);
  if (!opened.ok) return { ok: false, problem: 'gone' };
  let fresh = own.size >= SEGMENT_CLOSE;
  if (stat.size > own.size) {
    // Past where this computer left off: another computer's frame under its id, or bytes someone added.
    const plain = await openFrame(fs, path, own.size, own.frames, opened.opened, MAX_FRAME, c);
    if (plain) {
      opened.opened.key.fill(0);
      return { ok: false, problem: 'copied' };
    }
    fresh = true;
  }
  if (fresh) {
    opened.opened.key.fill(0);
    if (own.segment >= MAX_SEGMENT) return { ok: false, problem: 'full' };
    const next = await writeSegment(fs, { generation: own.generation, device: own.device, segment: own.segment + 1 }, records, root, { snapshot: false, app: opts.app, device: opts.device, ...(opts.now ? { now: opts.now } : {}) }, c);
    return { ok: true, own: next, frames: next.frames, bytes: next.size };
  }
  const sealed = frames(records, opened.opened.key, opened.opened.hash, own.frames, c);
  opened.opened.key.fill(0);
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
 * generation's file, and about how many computers sync through it (folders
 * holding a segment's name: without the passphrase, which are real can't be
 * told, and their names are inside the encryption). Two `sync-<n>.json` of one
 * generation (a sync app's conflicted copy: two computers set it up at once)
 * can't be joined.
 */
export async function inspectFolder(fs: SyncFs): Promise<FolderInspection> {
  const found = await generations(fs);
  if (!found || found.generations.length === 0) {
    // Folders left from something else start no generation of their own: a new one goes past them.
    const names = (await fs.list('')) ?? [];
    const past = names.filter((n) => /^\d{1,6}$/.test(n)).map(Number);
    const next = Math.max(0, ...past) + 1;
    return found?.conflicted ? { state: 'conflict' } : next > MAX_GENERATION ? { state: 'damaged' } : { state: 'new', generation: next };
  }
  if (found.conflicted) return { state: 'conflict' };
  const generation = found.generations.at(-1)!;
  const file = await readSyncFile(fs, generation);
  if (!file.ok) return { state: file.problem === 'newer' ? 'newer' : 'damaged' };
  let computers = 0;
  for (const device of (await devicesIn(fs, generation)).slice(0, MAX_COMPUTERS * 4)) if ((await segmentsOf(fs, generation, device)).length > 0) computers++;
  return { state: 'join', generation, computers: Math.min(computers, MAX_COMPUTERS) };
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
  /**
   * A newer generation: the passphrase was changed, or sync started again
   * with a new one. Who did it is named only from this generation's logs (a
   * computer says so there, sealed, before it moves), never from the file.
   */
  | { state: 'changed'; generation: number }
  /** This generation's file doesn't open with this computer's key: two computers set the folder up at once, and the other's won. */
  | { state: 'conflict' };

export async function lookAtFolder(fs: SyncFs, generation: number, root: Uint8Array, c: DataCrypto): Promise<FolderLook> {
  const found = await generations(fs);
  if (!found || found.generations.length === 0) return { state: 'missing' };
  const newest = found.generations.at(-1)!;
  if (newest > generation) {
    const file = await readSyncFile(fs, newest);
    if (file.ok) return { state: 'changed', generation: newest };
    if (file.problem === 'newer') return { state: 'newer' };
  }
  const file = await readSyncFile(fs, generation);
  if (!file.ok) return { state: file.problem === 'newer' ? 'newer' : 'missing' };
  return keyOpens(file.file, root, c) ? { state: 'ok' } : { state: 'conflict' };
}

/** Segments found not to be real, by path, size and time: looked into again only once they change. */
export interface JunkSeen {
  has(key: string): boolean;
  add(key: string): void;
}

/** One step of reading the other computers' logs. */
export type ReadEvent =
  | { kind: 'records'; device: string; segment: number; records: DataRecord[]; cursor: SegmentCursor; bad: number; refused: number }
  /** A computer whose log a newer Chord wrote: nothing more of it is read. */
  | { kind: 'newer'; device: string }
  /** When a computer last wrote (its newest segment's time), for Settings' list. */
  | { kind: 'seen'; device: string; at: number }
  /** More computers write here than sync reads (MAX_COMPUTERS): the rest are left out, and Settings says so. */
  | { kind: 'too-many' }
  /** The pass looked into as many segments as it may: another pass soon goes on from there. */
  | { kind: 'unfinished' };

/**
 * Every other computer's log, from where this one has read to: for each
 * computer whose folder holds a real segment, its newest real snapshot and
 * the real segments after it (earlier ones are passed over: the snapshot
 * holds them), one bounded step at a time. Junk under a segment's or a
 * computer's name is passed over and counts for nothing. Each step is
 * yielded for the caller to merge (and save its cursor) before the next is
 * read. A segment that isn't whole yet is read again next time.
 */
export async function* readComputers(
  fs: SyncFs,
  opts: { generation: number; self: string; root: Uint8Array; cursor(device: string, segment: number): SegmentCursor | null; junk?: JunkSeen; budget?: StepBudget },
  c: DataCrypto,
): AsyncGenerator<ReadEvent> {
  let probes = 0;
  let computers = 0;
  for (const device of await devicesIn(fs, opts.generation)) {
    if (device === opts.self) continue;
    const names = await segmentsOf(fs, opts.generation, device);
    // Newest first, back to the newest real snapshot; a segment is real once its first frame opens (a cursor past it says so).
    const real: { segment: number; snapshot: boolean }[] = [];
    let newer = false;
    let unfinished = false;
    for (let i = names.length - 1; i >= 0; i--) {
      const segment = names[i]!;
      const known = opts.cursor(device, segment);
      let snapshot: boolean;
      if (known && known.frame > 0) snapshot = known.snapshot;
      else {
        const path = `${deviceFolder(opts.generation, device)}/${segmentName(segment)}`;
        const stat = await fs.stat(path);
        if (!stat) continue;
        const key = `${path}\n${stat.size}\n${stat.mtime}`;
        if (opts.junk?.has(key)) continue;
        if (probes >= MAX_PROBES) {
          unfinished = true;
          break;
        }
        probes++;
        const found = await realSegment(fs, { generation: opts.generation, device, segment }, opts.root, c);
        if (!found) {
          opts.junk?.add(key);
          continue;
        }
        if (found.newer) {
          newer = true;
          break;
        }
        snapshot = found.header.snapshot;
      }
      real.push({ segment, snapshot });
      if (snapshot) break;
    }
    if (unfinished) {
      yield { kind: 'unfinished' };
      return;
    }
    if (!newer && real.length === 0) continue;
    // Only computers with a real log count towards the most sync reads.
    if (++computers > MAX_COMPUTERS) {
      yield { kind: 'too-many' };
      return;
    }
    if (newer) {
      yield { kind: 'newer', device };
      continue;
    }
    for (const { segment } of real.reverse()) {
      for (;;) {
        const known = opts.cursor(device, segment);
        const read = await readSegment(fs, { generation: opts.generation, device, segment }, opts.root, known, c, opts.budget);
        if (read.stopped === 'newer') {
          newer = true;
          break;
        }
        const moved = !known || known.head !== read.cursor.head || known.offset !== read.cursor.offset || known.frame !== read.cursor.frame;
        if (read.records.length > 0 || read.refused > 0 || (moved && read.cursor.frame > 0)) yield { kind: 'records', device, segment, records: read.records, cursor: read.cursor, bad: read.bad, refused: read.refused };
        if (!read.more) break;
      }
      if (newer) break;
    }
    if (newer) {
      yield { kind: 'newer', device };
      continue;
    }
    const last = await fs.stat(`${deviceFolder(opts.generation, device)}/${segmentName(real.at(-1)!.segment)}`);
    if (last) yield { kind: 'seen', device, at: last.mtime };
  }
}

/**
 * Whether a removed computer's folder may go (S15 §6): every real segment in
 * it has been read to its end here (`cursor`), and none was made after it was
 * removed (it joined again, and this computer hasn't read that yet). Junk
 * doesn't keep a folder.
 */
export async function mayPrune(fs: SyncFs, where: { generation: number; device: string }, removedAt: number, root: Uint8Array, cursor: (segment: number) => SegmentCursor | null, c: DataCrypto): Promise<boolean> {
  for (const segment of await segmentsOf(fs, where.generation, where.device)) {
    const path = `${deviceFolder(where.generation, where.device)}/${segmentName(segment)}`;
    const real = await realSegment(fs, { ...where, segment }, root, c);
    if (!real) continue;
    const created = Date.parse(real.header.created);
    if (!Number.isFinite(created) || created >= removedAt) return false;
    const stat = await fs.stat(path);
    const known = cursor(segment);
    if (!stat || !known || known.offset < stat.size) return false;
  }
  return true;
}

/**
 * A snapshot as this computer's newest segment in a generation (joining,
 * setting up, a new passphrase, a log put back, or compaction), written in
 * pieces as `records` come (so a big one is never held whole) under a name no
 * reader takes for a segment, then renamed into place; then this computer's
 * earlier segments go, since the snapshot holds them, with anything else
 * under a segment's name in its folder. Its number is past this computer's
 * newest real one (and `after`), never past junk's.
 */
export async function writeSnapshot(
  fs: SyncFs,
  where: { generation: number; device: string },
  records: AsyncIterable<readonly DataRecord[]> | Iterable<readonly DataRecord[]>,
  root: Uint8Array,
  opts: { app: string; device: readonly DataRecord[]; after?: number; now?: number },
  c: DataCrypto,
): Promise<OwnSegment> {
  const folder = deviceFolder(where.generation, where.device);
  await fs.mkdir(folder);
  const before = ((await fs.list(folder)) ?? []).filter((name) => SEGMENT.test(name) || PART.test(name));
  const newest = (await realAbove(fs, where.generation, where.device, opts.after ?? 0, root, c)) ?? opts.after ?? 0;
  const n = newest + 1;
  const name = segmentName(n);
  const temp = `${folder}/${name}.part-${hex(c.random(4))}`;
  const head = newHead({ ...where, segment: n }, true, opts.app, root, c, opts.now ?? Date.now());
  let size: number;
  let index: number;
  try {
    const first = frames(opts.device, head.key, head.hash, 0, c, true);
    const start = envelope.concat([head.bytes, ...first.bytes]);
    await fs.create(temp, start);
    size = start.length;
    index = first.count;
    for await (const chunk of records) {
      const sealed = frames(chunk, head.key, head.hash, index, c);
      if (sealed.count === 0) continue;
      const bytes = envelope.concat(sealed.bytes);
      await fs.append(temp, bytes);
      size += bytes.length;
      index += sealed.count;
    }
    await fs.rename(temp, `${folder}/${name}`);
  } catch (error) {
    await fs.remove(temp).catch(() => undefined);
    throw error;
  } finally {
    head.key.fill(0);
  }
  for (const old of before) if (old !== name) await fs.remove(`${folder}/${old}`).catch(() => undefined);
  return { ...where, segment: n, size, frames: index };
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
