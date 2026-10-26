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
import { DATA_FORMAT, DATA_FORMAT_ABOUT, ENCRYPTED_LINE, ENVELOPE_VERSION, envelope, FRAME_TARGET, MAX_FRAME, MAX_LINE, recordLine, SCRYPT, type DataCrypto, type DataKdf, type ScryptParams } from './data-file';
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
  /**
   * This computer's own segment cut back to its first `at` bytes after a write
   * of its own the disk took only part of: only if it's exactly `at` plus
   * `expect`'s length long and ends with `expect`, checked on the open file
   * just before it's cut, so nothing written meanwhile is cut. False, and
   * nothing cut, otherwise.
   */
  cutBack(path: string, at: number, expect: Uint8Array): Promise<boolean>;
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
/**
 * A segment's head is its readable line and its header (well under 1 KB as
 * Chord writes it, a few KB with what a snapshot covers), and its first frame only its computer's `device` record:
 * telling a real segment from junk reads at most these, never more.
 */
const SYNC_HEAD = 16 * 1024;
const FIRST_FRAME = 8 * 1024;
/** `sync-<n>.json` is small; one bigger isn't Chord's. */
const MAX_SYNC_FILE = 64 * 1024;
/** The most computers sync reads (it keeps 64 devices): only folders holding a real segment count. More, and Settings says so. */
export const MAX_COMPUTERS = 64;
/** Names have six digits: a segment or a generation past this would be one no reader lists. */
export const MAX_SEGMENT = 999_999;
const MAX_GENERATION = 999_999;
/** Segments looked into per pass to tell real ones from junk; a folder with more is looked through over several passes. */
const MAX_PROBES = 1024;
/**
 * Each folder's own budget a pass: names looked at (a stat each; a known
 * computer's more, since what's remembered is a stat), and segments looked
 * into. A folder with more is looked through over several passes, and the
 * pass moves on to the next.
 */
const FOLDER_LOOKS = 512;
const FOLDER_LOOKS_KNOWN = 4096;
const FOLDER_PROBES = 64;
/**
 * Junk sync remembers (by name, size and time) before it stops looking for
 * computers it doesn't know yet, and says the folder holds files it doesn't
 * recognise. Computers it knows go on being read.
 */
export const MAX_JUNK = 4096;
/** Sync's own format, apart from the records' (`DATA_FORMAT`) and the envelope's. */
export const SYNC_FORMAT = 1;

export function segmentName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEGMENT) throw new SegmentsFull(n);
  return `${String(n).padStart(6, '0')}.chordlog`;
}
const SEGMENT = /^(\d{6})\.chordlog$/;
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
  /** A snapshot holds everything its computer knew: earlier segments of its computer can be passed over, as far as it covers them. */
  snapshot: boolean;
  /**
   * A snapshot's earlier segments as its computer wrote them, each `[number,
   * bytes, frames]`: what it covers. A reader still reads what one of them has
   * past that (another copy of the profile wrote it), and one it doesn't name
   * at all; its computer deletes one only if it's still that long.
   */
  covers: Cover[];
  /** Base64, 32 random bytes: the segment's key is HKDF of the root key and it. */
  salt: string;
}

/** One earlier segment a snapshot covers: its number, and how many bytes and frames of it its computer wrote. */
export type Cover = [segment: number, size: number, frames: number];
/** The most earlier segments a snapshot names; one it doesn't is read whole, and never deleted by it. */
const MAX_COVERS = 200;
const isCover = (v: unknown): v is Cover => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isSafeInteger(n) && (n as number) >= 0) && (v[0] as number) >= 1 && (v[0] as number) <= MAX_SEGMENT;

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
  // A header is well under 2 KB as Chord writes it (a few KB with a snapshot's covers): read that much first.
  let head = await fs.read(path, 0, 2048);
  if (head.length === 2048 && head.indexOf(0x0a, head.indexOf(0x0a) + 1) < 0) head = await fs.read(path, 0, SYNC_HEAD);
  const first = head.indexOf(0x0a);
  // Not even its first line yet: one being delivered starts as Chord's do.
  if (first < 0) return { ok: false, problem: head.length < SYNC_HEAD && utf8.encode(ENCRYPTED_LINE).every((b, i) => i >= head.length || head[i] === b) ? 'short' : 'damaged' };
  const magic = new RegExp(`^${ENCRYPTED_LINE} (\\d{1,6})$`).exec(decoder.decode(head.subarray(0, first)));
  if (!magic || Number(magic[1]) !== ENVELOPE_VERSION) return { ok: false, problem: 'damaged' };
  const end = head.indexOf(0x0a, first + 1);
  if (end < 0) return { ok: false, problem: head.length >= SYNC_HEAD ? 'damaged' : 'short' };
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
    covers: Array.isArray(raw['covers']) ? raw['covers'].filter(isCover).slice(0, MAX_COVERS) : [],
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

/** What's under a segment's name: a real segment, one that may be (still being delivered), or junk. */
export type SegmentKind = { kind: 'real'; header: SegmentHeader; newer: boolean } | { kind: 'pending' } | { kind: 'junk' };

/**
 * What's under a segment's name. Real: its first frame opens with the key its
 * header gives, so the header is its computer's (its hash is sealed into every
 * frame). Pending: its head is a sync header for this very place (or the start
 * of one), and its first frame isn't all there yet: a sync app may still be
 * delivering it. Junk: anything else. At most two small reads (SYNC_HEAD and
 * FIRST_FRAME), whatever the file says.
 */
export async function segmentKind(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto): Promise<SegmentKind> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const stat = await fs.stat(path);
  if (!stat) return { kind: 'junk' };
  const opened = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (!opened.ok) return { kind: opened.problem === 'short' ? 'pending' : 'junk' };
  try {
    const { start } = opened.opened;
    const lengthBytes = await fs.read(path, start, 4);
    if (lengthBytes.length < 4) return { kind: 'pending' };
    const length = uint32(lengthBytes);
    if (length < NONCE + TAG || length > FIRST_FRAME) return { kind: 'junk' };
    if (start + 4 + length > stat.size) return { kind: 'pending' };
    const plain = await openFrame(fs, path, start, 0, opened.opened, FIRST_FRAME, c);
    return plain ? { kind: 'real', header: opened.opened.header, newer: opened.opened.newer } : { kind: 'junk' };
  } finally {
    opened.opened.key.fill(0);
  }
}

/** A segment, if it's real (`segmentKind`). */
export async function realSegment(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto): Promise<{ header: SegmentHeader; newer: boolean } | null> {
  const found = await segmentKind(fs, where, root, c);
  return found.kind === 'real' ? { header: found.header, newer: found.newer } : null;
}

/**
 * What a computer remembers of the folder between passes and writes: segments
 * that aren't real, by path, with their size and time when looked into (one
 * that changes is looked into again), and where looking for computers it
 * doesn't know yet got to.
 */
export interface FolderMemory {
  junk: Map<string, string>;
  /** What's remembered changed since the caller last kept it (chord-data keeps it across launches). */
  dirty?: boolean;
  /** The last unknown computer's folder looked through; the next pass goes on after it. */
  after: string;
  /**
   * Per computer, a folder with more than a pass's worth looked through over
   * several: what's new of a computer this one reads, from the top down (the
   * names from `low` to `top` looked through already)…
   */
  up: Map<string, { top: number; low: number }>;
  /** …down to a computer's newest snapshot, below this… */
  down: Map<string, number>;
  /** …and below that snapshot, what it doesn't cover, up to this. */
  below: Map<string, number>;
}

export const folderMemory = (): FolderMemory => ({ junk: new Map(), after: '', up: new Map(), down: new Map(), below: new Map() });

/**
 * What's under a segment's name, remembering junk (and pending ones, until
 * they change): each is looked into once, however many passes or writes come.
 * Null when it isn't there. `probe` is called before each look, and stops it
 * when it says so.
 */
async function lookAt(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto, memory: FolderMemory | undefined, probe: () => boolean = () => true): Promise<SegmentKind | 'stopped' | null> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const stat = await fs.stat(path);
  if (!stat) return null;
  const key = `${stat.size}:${stat.mtime}`;
  const seen = memory?.junk.get(path);
  if (seen === key) return { kind: 'junk' };
  if (seen?.startsWith('pending:') && seen.slice(8) === key) return { kind: 'pending' };
  if (!probe()) return 'stopped';
  const found = await segmentKind(fs, where, root, c);
  // Past MAX_JUNK, more isn't remembered: it's looked into again on a later pass, within that pass's budget.
  if (memory && found.kind !== 'real' && (memory.junk.size < MAX_JUNK || memory.junk.has(path))) {
    memory.junk.set(path, found.kind === 'pending' ? `pending:${key}` : key);
    memory.dirty = true;
  } else if (memory?.junk.delete(path)) memory.dirty = true;
  return found;
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
  /** When its computer says it made the segment (its header's `created`, sealed into every frame), once a frame has opened. */
  created: number | null;
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
  const empty = (stopped: SegmentRead['stopped'], at: SegmentCursor | null): SegmentRead => ({ records: [], cursor: at ?? { head: '', offset: 0, frame: 0, snapshot: false }, bad: 0, refused: 0, stopped, more: false, created: null });
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
    const created = Date.parse(opened.header.created);
    return { records, cursor: at, bad, refused, stopped, more, created: at.frame > 0 && Number.isFinite(created) ? created : null };
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
  /** Segments this computer closed since its last snapshot, as it left them: with this one, what its next snapshot covers, and all it may ever delete. */
  closed?: Cover[];
  /** Its last frame: where it starts, and its bytes' SHA-256 (hex). The segment must still end with exactly that (`ownIntact`). */
  tail?: { at: number; hash: string };
}

/** The tail of a segment that ends with `last`, `size` bytes long. */
const tailOf = (last: Uint8Array | undefined, size: number, c: DataCrypto): OwnSegment['tail'] => (last ? { at: size - last.length, hash: hex(c.sha256(last)) } : undefined);

/**
 * Whether this computer's newest segment is as it left it (S15 §6): exactly
 * its size, ending with exactly its last frame. `other`: longer, or ending
 * otherwise (another copy of the profile appended to it, and the sync app
 * kept that copy's version), or shorter (an older version came back): either
 * way another computer writes under this id, and this one takes a new id,
 * whose snapshot carries everything it knows. `gone`: not there, though the
 * folder is. `missing`: the folder isn't there.
 */
export async function ownIntact(fs: SyncFs, own: OwnSegment, c: DataCrypto): Promise<'ok' | 'other' | 'gone' | 'missing'> {
  const path = `${deviceFolder(own.generation, own.device)}/${segmentName(own.segment)}`;
  const stat = await fs.stat(path);
  if (!stat) return (await fs.stat(syncFileName(own.generation))) ? 'gone' : 'missing';
  if (stat.size !== own.size) return 'other';
  if (own.tail && own.tail.at < own.size) {
    const bytes = await fs.read(path, own.tail.at, own.size - own.tail.at);
    if (bytes.length !== own.size - own.tail.at || hex(c.sha256(bytes)) !== own.tail.hash) return 'other';
  }
  return 'ok';
}

/**
 * What this computer is writing to its log (S15 §13): where it goes (`at`; 0
 * for a whole new segment, or a snapshot, made whole by a rename), how many
 * bytes, their SHA-256 (hex; null for a snapshot, written a page at a time,
 * whose last frame's hash its segment carries), and its segment as it will be
 * once they're there. Kept until the write is answered (chord-data keeps it
 * across a restart of the worker, or of Chord, without the bytes), so a write
 * of its own is never taken for another writer's: one whose bytes landed
 * though the call failed (a flush or a close that threw, the worker stopped
 * mid-flush, Chord quit between a snapshot's rename and its answer) is its,
 * and one the disk took only part of is cut back and written again (that
 * needs the bytes, which the worker that wrote them has).
 */
export interface Appending {
  expect: OwnSegment;
  at: number;
  length: number;
  hash: string | null;
  bytes?: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * A write of this computer's that may have landed, settled before anything
 * judges its segment (`ownIntact`, a new segment past it): `landed`, all its
 * bytes are there, exactly, and the segment is as it expected; `cut`, only
 * the first of them were (a short write), so the segment is cut back to where
 * it was, and the write goes again. Anything else there (more bytes, or
 * other ones) isn't settled: it's another writer's, as before.
 */
export async function settleAppend(fs: SyncFs, own: OwnSegment, appending: Appending | null | undefined, c: DataCrypto): Promise<{ own: OwnSegment; settled: 'landed' | 'cut' | null }> {
  const none = { own, settled: null };
  if (!appending || appending.expect.generation !== own.generation || appending.expect.device !== own.device) return none;
  const { expect, at, length } = appending;
  const fresh = expect.segment !== own.segment;
  if (fresh ? expect.segment < own.segment || at !== 0 : at !== own.size) return none;
  const path = `${deviceFolder(expect.generation, expect.device)}/${segmentName(expect.segment)}`;
  const stat = await fs.stat(path);
  if (!stat || stat.size <= at) return none;
  const extra = stat.size - at;
  if (extra > length) return none;
  if (extra === length) {
    // All of it: exactly its bytes (by their hash), or for a snapshot, exactly its size ending with its last frame.
    if (appending.hash !== null) {
      const got = await fs.read(path, at, extra);
      if (got.length !== extra || hex(c.sha256(got)) !== appending.hash) return none;
    } else if ((await ownIntact(fs, expect, c)) !== 'ok') return none;
    return { own: expect, settled: 'landed' };
  }
  // Only its first bytes (a short write): its own only if they're exactly those, which only the worker that wrote them
  // knows. A new segment or a snapshot is never seen half made (it's renamed into place whole).
  if (fresh || !appending.bytes) return none;
  const got = await fs.read(path, at, extra);
  if (!sameBytes(got, appending.bytes.subarray(0, extra))) return none;
  return (await fs.cutBack(path, at, got)) ? { own, settled: 'cut' } : none;
}

/** A name this computer's own writing leaves for a moment: a segment made under a temp name, a snapshot written as `.part-`. */
const TEMP_NAME = /^\d{6}\.chordlog(?:\.part-[0-9a-f]{8})?(?:\.tmp-[0-9a-f]{8})?$/;
/** Older than this, a temp name in this computer's own folder is one a write left when it stopped (the worker let go, Chord quit). */
export const STALE_TEMP_MS = 60_000;

/**
 * This computer's own temp files a write left when it stopped, removed: only
 * in its own folder, only names its writing makes (`NNNNNN.chordlog.part-…`,
 * `….tmp-…`), only regular files (never through a link: the folder's `remove`
 * refuses one), and only once they're older than STALE_TEMP_MS. How many went.
 */
export async function removeStaleTemps(fs: SyncFs, where: { generation: number; device: string }, now: number): Promise<number> {
  const folder = deviceFolder(where.generation, where.device);
  let removed = 0;
  for (const name of (await fs.list(folder)) ?? []) {
    if (!TEMP_NAME.test(name) || !/\.(?:part|tmp)-[0-9a-f]{8}$/.test(name)) continue;
    const stat = await fs.stat(`${folder}/${name}`);
    if (!stat || now - stat.mtime < STALE_TEMP_MS) continue;
    try {
      await fs.remove(`${folder}/${name}`);
      removed++;
    } catch {
      // A link, or something that can't go: left as it is.
    }
  }
  return removed;
}

/** What a computer's next snapshot covers: the segments it closed since its last, and its newest as it left it. */
export const coversOf = (own: OwnSegment | null): Cover[] => (own ? [...(own.closed ?? []), [own.segment, own.size, own.frames] as Cover].slice(-MAX_COVERS) : []);

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
function newHead(where: { generation: number; device: string; segment: number }, snapshot: boolean, app: string, root: Uint8Array, c: DataCrypto, now: number, covers: Cover[] = []): { bytes: Uint8Array; key: Uint8Array; hash: Uint8Array } {
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
    covers,
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
  const sealed = sealSegment(where, records, root, opts, c);
  await fs.mkdir(deviceFolder(where.generation, where.device));
  await fs.create(`${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`, sealed.bytes);
  return sealed.own;
}

/** A whole segment's bytes, sealed, and the segment as it will be once they're in place. */
function sealSegment(
  where: { generation: number; device: string; segment: number },
  records: readonly DataRecord[],
  root: Uint8Array,
  opts: { snapshot: boolean; app: string; device: readonly DataRecord[]; now?: number },
  c: DataCrypto,
): { bytes: Uint8Array; own: OwnSegment } {
  const head = newHead(where, opts.snapshot, opts.app, root, c, opts.now ?? Date.now());
  const first = frames(opts.device, head.key, head.hash, 0, c, true);
  const rest = frames(records, head.key, head.hash, first.count, c);
  head.key.fill(0);
  const bytes = envelope.concat([head.bytes, ...first.bytes, ...rest.bytes]);
  const tail = tailOf(rest.bytes.at(-1) ?? first.bytes.at(-1), bytes.length, c);
  return { bytes, own: { ...where, size: bytes.length, frames: first.count + rest.count, closed: [], ...(tail ? { tail } : {}) } };
}

/** Another computer writes under this one's id: what a snapshot's check finds, and `copied` says. */
export class AnotherWriter extends Error {
  constructor() {
    super('Another computer writes under this id');
    this.name = 'AnotherWriter';
  }
}

/** Names a write looks into, at most, for another computer under its id: the rest the next write, junk remembered meanwhile. */
const WRITE_PROBES = 16;

/**
 * Whether another computer writes under this id: a real segment past `after`
 * (this computer's newest). The names past it are looked at lowest first (a
 * copy writes just past where it shared the log), each remembered when it's
 * junk (`memory`), at most WRITE_PROBES looked into a call: so a write costs a
 * stat for each name past its segment, and reads little, and only what it
 * hasn't seen. One still being delivered is found once it's whole.
 */
async function othersAbove(fs: SyncFs, generation: number, device: string, after: number, root: Uint8Array, c: DataCrypto, memory: FolderMemory | undefined): Promise<boolean> {
  let probes = 0;
  const probe = () => probes++ < WRITE_PROBES;
  for (const segment of await segmentsOf(fs, generation, device)) {
    if (segment <= after) continue;
    const found = await lookAt(fs, { generation, device, segment }, root, c, memory, probe);
    if (found === 'stopped') return false;
    if (found?.kind === 'real') return true;
  }
  return false;
}

/** The first number past `after` with nothing under its name: a new segment never takes the place of anything. */
async function firstFree(fs: SyncFs, generation: number, device: string, after: number): Promise<number> {
  const taken = new Set(await segmentsOf(fs, generation, device));
  let n = after + 1;
  while (taken.has(n)) n++;
  if (n > MAX_SEGMENT) throw new SegmentsFull(n);
  return n;
}

export type AppendResult =
  | { ok: true; own: OwnSegment; frames: number; bytes: number }
  /**
   * `copied`: another computer writes under this one's id (a real segment, or
   * frame, past where this one left off). `gone`: this computer's segment
   * isn't there, or is shorter than it left it, though the folder is: another
   * copy of this profile may have compacted it away, so this one takes a new
   * id too, and writes its snapshot there. `missing`: the folder isn't there
   * (the sync app isn't running). `full`: its segment numbers reached the top.
   */
  | { ok: false; problem: 'copied' | 'gone' | 'missing' | 'full' };

/**
 * Records appended to this computer's newest segment as one frame (or more,
 * past FRAME_TARGET), then flushed. First it checks no other computer writes
 * under its id: no real segment past its own, and its own exactly as it left
 * it, ending with its own last frame (`ownIntact`). Anything else is another
 * writer (`copied`), bytes someone added included: past SEGMENT_CLOSE a new
 * segment starts. A write of this computer's own that may have landed is
 * settled first, by the caller (`settleAppend`); `onAppend` hears what this
 * one writes, before it's written, to keep until it's answered.
 */
export async function appendRecords(
  fs: SyncFs,
  own: OwnSegment,
  records: readonly DataRecord[],
  root: Uint8Array,
  opts: { app: string; device: readonly DataRecord[]; now?: number; memory?: FolderMemory; onAppend?(appending: Appending): void },
  c: DataCrypto,
): Promise<AppendResult> {
  const folder = deviceFolder(own.generation, own.device);
  const path = `${folder}/${segmentName(own.segment)}`;
  // First, another computer under this id: a real segment past this one's (another copy of the profile, which compacted
  // or closed a segment), or one being delivered.
  if (await othersAbove(fs, own.generation, own.device, own.segment, root, c, opts.memory)) return { ok: false, problem: 'copied' };
  const intact = await ownIntact(fs, own, c);
  if (intact === 'missing' || intact === 'gone') return { ok: false, problem: intact };
  if (intact === 'other') return { ok: false, problem: 'copied' };
  const opened = await openSegment(fs, path, own.generation, own.device, own.segment, root, c);
  if (!opened.ok) return { ok: false, problem: 'copied' };
  if (own.size >= SEGMENT_CLOSE) {
    opened.opened.key.fill(0);
    let n: number;
    try {
      n = await firstFree(fs, own.generation, own.device, own.segment);
    } catch {
      return { ok: false, problem: 'full' };
    }
    const where = { generation: own.generation, device: own.device, segment: n };
    const segment = sealSegment(where, records, root, { snapshot: false, app: opts.app, device: opts.device, ...(opts.now ? { now: opts.now } : {}) }, c);
    // The one it closes is its, as it left it: its next snapshot covers it.
    const expect: OwnSegment = { ...segment.own, closed: [...(own.closed ?? []), [own.segment, own.size, own.frames] as Cover] };
    opts.onAppend?.({ expect, at: 0, length: segment.bytes.length, hash: hex(c.sha256(segment.bytes)), bytes: segment.bytes });
    await fs.mkdir(folder);
    await fs.create(`${folder}/${segmentName(n)}`, segment.bytes);
    return { ok: true, own: expect, frames: expect.frames, bytes: expect.size };
  }
  const sealed = frames(records, opened.opened.key, opened.opened.hash, own.frames, c);
  opened.opened.key.fill(0);
  const bytes = envelope.concat(sealed.bytes);
  const size = own.size + bytes.length;
  const tail = tailOf(sealed.bytes.at(-1), size, c) ?? own.tail;
  const expect: OwnSegment = { ...own, size, frames: own.frames + sealed.count, ...(tail ? { tail } : {}) };
  opts.onAppend?.({ expect, at: own.size, length: bytes.length, hash: hex(c.sha256(bytes)), bytes });
  await fs.append(path, bytes);
  return { ok: true, own: expect, frames: sealed.count, bytes: bytes.length };
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

/** One step of reading the other computers' logs. */
export type ReadEvent =
  | { kind: 'records'; device: string; segment: number; records: DataRecord[]; cursor: SegmentCursor; bad: number; refused: number }
  /** A computer whose log a newer Chord wrote: nothing more of it is read. */
  | { kind: 'newer'; device: string }
  /**
   * When a computer last wrote (its newest segment's time in this folder), for
   * Settings' list, and when it says it made the newest segment read (its own
   * clock, sealed in the header), for a clock that's ahead.
   */
  | { kind: 'seen'; device: string; at: number; wrote: number | null }
  /** More computers write here than sync reads (MAX_COMPUTERS): the rest are left out, and Settings says so. */
  | { kind: 'too-many' }
  /** The pass looked into as many segments as it may: the next goes on from there (`FolderMemory.after`). */
  | { kind: 'unfinished' }
  /** The folder holds more junk than sync remembers (MAX_JUNK): looking goes on, a budget a pass, and Settings says so. */
  | { kind: 'cluttered' }
  /** A computer this one reads whose folder holds more than a pass looks through: its new segments may be slow to come, and Settings names it. */
  | { kind: 'blocked'; device: string };

/**
 * Every other computer's log, from where this one has read to, one bounded
 * step at a time; each step is yielded for the caller to merge (and save its
 * cursor) before the next is read. A segment that isn't whole yet is read
 * again next time.
 *
 * - **For each computer:** its newest real snapshot and the real segments past
 *   it, and of its earlier segments, whatever the snapshot doesn't cover: one
 *   it doesn't name (read whole), or one grown past what it names (read from
 *   there). Another copy of the profile may have written either, and a sync
 *   app may bring a deleted one back with its edits.
 * - **Computers already read** (`known`: segments with a cursor past their first
 *   frame) come first: what's new past where this one read.
 *   **Computers not known yet** come after, from where the last pass got to
 *   (`memory.after`), newest first down to a snapshot.
 * - **Each folder is looked through within a budget of its own** (FOLDER_LOOKS
 *   names, FOLDER_PROBES looked into), and the pass within MAX_PROBES: a folder
 *   with more is looked through over several passes (`memory.up`,
 *   `memory.down`, `memory.below`), and the pass moves on. A known computer's
 *   next segment is looked for by name first (the next number past the newest
 *   read), then from the top down, since it numbers its next past whatever is
 *   there. A known computer whose folder holds more than a pass looks through
 *   says so (`blocked`): what another copy of it wrote may be slow to come.
 * - **Junk** under a segment's or a computer's name is remembered by name,
 *   size and time (`memory.junk`, which the caller keeps across launches), so
 *   each is looked into once. Past MAX_JUNK of it, more isn't remembered, and
 *   the pass says so (`cluttered`).
 */
export async function* readComputers(
  fs: SyncFs,
  opts: {
    generation: number;
    self: string;
    root: Uint8Array;
    cursor(device: string, segment: number): SegmentCursor | null;
    known(device: string): readonly number[];
    memory: FolderMemory;
    budget?: StepBudget;
  },
  c: DataCrypto,
): AsyncGenerator<ReadEvent> {
  const { generation, memory } = opts;
  let probes = 0;
  const devices = (await devicesIn(fs, generation)).filter((d) => d !== opts.self);
  const listed = new Set(devices);
  // Junk in folders that have gone, or of another generation, is forgotten.
  for (const path of [...memory.junk.keys()]) {
    const [at, device] = path.split('/');
    if (Number(at) === generation && listed.has(device ?? '')) continue;
    memory.junk.delete(path);
    memory.dirty = true;
  }
  for (const map of [memory.up, memory.down, memory.below]) for (const device of [...map.keys()]) if (!listed.has(device)) map.delete(device);
  let computers = 0;
  let unfinished = false;

  type Read = { segment: number; from: SegmentCursor | null };
  type Budget = { look(): boolean; probe(): boolean };
  /** A folder's own budget for this pass, within the pass's. */
  const folderBudget = (looks: number): Budget => {
    let looked = 0;
    let probed = 0;
    return {
      look: () => looked++ < looks,
      probe: () => {
        if (probed >= FOLDER_PROBES || probes >= MAX_PROBES) return false;
        probed++;
        probes++;
        return true;
      },
    };
  };
  const look = (where: { generation: number; device: string; segment: number }, budget: Budget): Promise<SegmentKind | 'stopped' | null> =>
    budget.look() ? lookAt(fs, where, opts.root, c, memory, () => budget.probe()) : Promise.resolve('stopped');

  /** A computer's segments to read, in order; whether a newer Chord wrote one; whether its budget ran out before looking through all of it. */
  async function plan(device: string): Promise<{ reads: Read[]; newer: boolean; stopped: boolean }> {
    const names = await segmentsOf(fs, generation, device);
    const known = [...opts.known(device)].sort((a, b) => a - b);
    const budget = folderBudget(known.length > 0 ? FOLDER_LOOKS_KNOWN : FOLDER_LOOKS);
    const real = new Map<number, { snapshot: boolean; covers: Cover[] | null }>(known.map((s) => [s, { snapshot: opts.cursor(device, s)?.snapshot ?? false, covers: null }]));
    const newestSnapshot = () => Math.max(-1, ...[...real].filter(([, r]) => r.snapshot).map(([s]) => s));
    let stopped = false;
    if (known.length > 0) {
      // Its next segment by name: the next number past the newest read, and on while there's one, whatever else the folder holds.
      const listedNames = new Set(names);
      for (let segment = known.at(-1)! + 1; segment <= MAX_SEGMENT && listedNames.has(segment) && !real.has(segment); segment++) {
        const found = await look({ generation, device, segment }, budget);
        if (found === 'stopped' || !found || found.kind !== 'real') break;
        if (found.newer) return { reads: [], newer: true, stopped };
        real.set(segment, { snapshot: found.header.snapshot, covers: found.header.covers });
      }
      // Then what's new past its newest snapshot read, from the top down (a computer numbers its next segment past whatever is
      // there), to a snapshot: what's new since the last pass first, then on from where that one stopped.
      const floor = Math.max(newestSnapshot(), known[0]! - 1);
      const sweep = memory.up.get(device);
      const top = names.at(-1) ?? floor;
      const order = names.filter((n) => n > floor && !real.has(n) && !(sweep && n >= sweep.low && n <= sweep.top)).reverse();
      let done = false;
      for (const segment of order) {
        const found = await look({ generation, device, segment }, budget);
        if (found === 'stopped') {
          stopped = true;
          // Looked through: from here up, and what an earlier pass did, if this one got past it.
          memory.up.set(device, { top: Math.max(top, sweep?.top ?? top), low: segment + 1 });
          break;
        }
        if (!found || found.kind !== 'real') continue;
        if (found.newer) return { reads: [], newer: true, stopped };
        real.set(segment, { snapshot: found.header.snapshot, covers: found.header.covers });
        if (found.header.snapshot) {
          done = true;
          break;
        }
      }
      if (done || !stopped) memory.up.delete(device);
    }
    // No snapshot yet: down from the lowest it has (or the top), from where the last pass left off, to the newest real one.
    if (newestSnapshot() < 0 && !stopped) {
      const from = Math.min(known[0] ?? Number.POSITIVE_INFINITY, memory.down.get(device) ?? Number.POSITIVE_INFINITY);
      for (let i = names.length - 1; i >= 0; i--) {
        const segment = names[i]!;
        if (segment >= from || real.has(segment)) continue;
        const found = await look({ generation, device, segment }, budget);
        if (found === 'stopped') {
          stopped = true;
          memory.down.set(device, segment + 1);
          break;
        }
        if (!found || found.kind !== 'real') continue;
        if (found.newer) return { reads: [], newer: true, stopped };
        real.set(segment, { snapshot: found.header.snapshot, covers: found.header.covers });
        if (found.header.snapshot) break;
      }
      if (!stopped) memory.down.delete(device);
    }
    const snapshot = newestSnapshot();
    const above = [...real.keys()].filter((s) => s >= snapshot).sort((a, b) => a - b);
    // Below the newest snapshot: what it doesn't cover.
    const below: Read[] = [];
    if (snapshot >= 0) {
      const info = real.get(snapshot)!;
      const covers = info.covers ?? (await headerOf(fs, { generation, device, segment: snapshot }, opts.root, c, opts.cursor(device, snapshot)?.head))?.header.covers ?? [];
      const covered = new Map(covers.map(([n, size, frames]) => [n, { size, frames }]));
      // Segments read already are read on, every pass; the rest are looked through within the budget, on from where the last pass stopped.
      const looked = memory.below.get(device) ?? 0;
      let resume: number | null = null;
      for (const segment of names) {
        if (segment >= snapshot) break;
        const cursor = opts.cursor(device, segment);
        const read = cursor !== null && cursor.frame > 0;
        if (!read) {
          if (segment <= looked || resume !== null) continue;
          if (!budget.look()) {
            resume = segment;
            continue;
          }
        }
        const where = { generation, device, segment };
        const stat = await fs.stat(`${deviceFolder(generation, device)}/${segmentName(segment)}`);
        if (!stat) continue;
        const cover = covered.get(segment);
        if (cover && stat.size <= cover.size) continue;
        if (read && cursor.offset >= stat.size) continue;
        if (!read) {
          const found = await lookAt(fs, where, opts.root, c, memory, () => budget.probe());
          if (found === 'stopped') {
            resume = segment;
            continue;
          }
          if (!found || found.kind !== 'real' || found.newer) continue;
        }
        // Covered up to a point: what's past it, from there (the frame's index and the header's hash say where).
        const head = cover ? await headerOf(fs, where, opts.root, c) : null;
        below.push({ segment, from: cover && head ? { head: head.head, offset: cover.size, frame: cover.frames, snapshot: false } : null });
      }
      if (resume === null) memory.below.delete(device);
      else {
        stopped = true;
        memory.below.set(device, resume - 1);
      }
    }
    return { reads: [...below, ...above.map((segment) => ({ segment, from: null }))], newer: false, stopped };
  }

  /** A computer's segments, read in order: each step yielded. Whether a newer Chord wrote one, and when it says it made the newest. */
  async function* read(device: string, segments: readonly Read[]): AsyncGenerator<ReadEvent, { newer: boolean; wrote: number | null }> {
    let wrote: number | null = null;
    for (const { segment, from } of segments) {
      for (;;) {
        const known = opts.cursor(device, segment);
        const start = from && (!known || known.head !== from.head || known.offset < from.offset) ? from : known;
        const read = await readSegment(fs, { generation, device, segment }, opts.root, start, c, opts.budget);
        if (read.stopped === 'newer') return { newer: true, wrote };
        if (read.created !== null) wrote = Math.max(wrote ?? 0, read.created);
        const moved = !known || known.head !== read.cursor.head || known.offset !== read.cursor.offset || known.frame !== read.cursor.frame;
        if (read.records.length > 0 || read.refused > 0 || (moved && read.cursor.frame > 0)) yield { kind: 'records', device, segment, records: read.records, cursor: read.cursor, bad: read.bad, refused: read.refused };
        if (!read.more) break;
      }
    }
    return { newer: false, wrote };
  }

  async function* finish(device: string, segments: readonly Read[], newer: boolean): AsyncGenerator<ReadEvent> {
    const result = newer ? { newer: true, wrote: null } : yield* read(device, segments);
    if (result.newer) {
      yield { kind: 'newer', device };
      return;
    }
    const last = segments.length > 0 ? await fs.stat(`${deviceFolder(generation, device)}/${segmentName(segments.at(-1)!.segment)}`) : null;
    if (last) yield { kind: 'seen', device, at: last.mtime, wrote: result.wrote };
  }

  // Computers already read first: what they've read is read on whatever the budget; what's new, within it.
  for (const device of devices) {
    if (opts.known(device).length === 0) continue;
    if (++computers > MAX_COMPUTERS) {
      yield { kind: 'too-many' };
      return;
    }
    const planned = await plan(device);
    if (planned.stopped) {
      unfinished = true;
      yield { kind: 'blocked', device };
    }
    yield* finish(device, planned.reads, planned.newer);
  }

  // Computers not known yet, from where the last pass got to: each within its own budget, then the next.
  const unknown = devices.filter((d) => opts.known(d).length === 0);
  const from = unknown.findIndex((d) => d > memory.after);
  const order = from < 0 ? unknown : [...unknown.slice(from), ...unknown.slice(0, from)];
  let finishedAll = true;
  for (const device of order) {
    if (probes >= MAX_PROBES) {
      finishedAll = false;
      break;
    }
    const planned = await plan(device);
    if (planned.stopped) unfinished = true;
    memory.after = device;
    if (!planned.newer && planned.reads.length === 0) continue;
    // Only computers with a real log count towards the most sync reads.
    if (++computers > MAX_COMPUTERS) {
      yield { kind: 'too-many' };
      return;
    }
    yield* finish(device, planned.reads, planned.newer);
  }
  if (finishedAll && !unfinished) memory.after = '';
  if (!finishedAll) unfinished = true;
  if (memory.junk.size >= MAX_JUNK) yield { kind: 'cluttered' };
  if (unfinished) yield { kind: 'unfinished' };
}

/** A segment's header and its hash (hex), unproven: proven when `head` is given and matches (a cursor read past its first frame says it's real). */
async function headerOf(fs: SyncFs, where: { generation: number; device: string; segment: number }, root: Uint8Array, c: DataCrypto, head?: string): Promise<{ header: SegmentHeader; head: string } | null> {
  const path = `${deviceFolder(where.generation, where.device)}/${segmentName(where.segment)}`;
  const opened = await openSegment(fs, path, where.generation, where.device, where.segment, root, c);
  if (!opened.ok) return null;
  opened.opened.key.fill(0);
  const hash = hex(opened.opened.hash);
  return head === undefined || head === hash ? { header: opened.opened.header, head: hash } : null;
}

/**
 * Whether a removed computer's folder may go (S15 §6): every real segment in
 * it has been read to its end here (`cursor`), none was made after it was
 * removed (it joined again, and this computer hasn't read that yet), and none
 * is still being delivered (a pending one may be its new snapshot). Junk
 * doesn't keep a folder.
 */
export async function mayPrune(fs: SyncFs, where: { generation: number; device: string }, removedAt: number, root: Uint8Array, cursor: (segment: number) => SegmentCursor | null, c: DataCrypto): Promise<boolean> {
  for (const segment of await segmentsOf(fs, where.generation, where.device)) {
    const path = `${deviceFolder(where.generation, where.device)}/${segmentName(segment)}`;
    const found = await segmentKind(fs, { ...where, segment }, root, c);
    if (found.kind === 'pending') return false;
    if (found.kind === 'junk') continue;
    const created = Date.parse(found.header.created);
    if (!Number.isFinite(created) || created >= removedAt) return false;
    const stat = await fs.stat(path);
    const known = cursor(segment);
    if (!stat || !known || known.offset < stat.size) return false;
  }
  return true;
}
/**
 * A snapshot as this computer's newest segment in a generation (joining,
 * setting up, a new passphrase, a new id, or compaction), written in pieces as
 * `records` come (so a big one is never held whole) under a name no reader
 * takes for a segment, then renamed into place, under the first free number
 * past `after` (this computer's newest): it never takes the place of anything.
 *
 * Its header names what it covers (`covers`: this computer's earlier segments,
 * as it wrote them). Before it's written, another computer under this id (a
 * real segment past `after`, or one of these grown past what this computer
 * wrote) stops it (`AnotherWriter`): this computer takes a new id instead.
 * After, it deletes each of them only if it's still the size it covered; one
 * that's grown meanwhile stays, still named as this computer's (`closed`), so
 * the next compaction finds the other writer. Nothing else is ever deleted.
 */
export async function writeSnapshot(
  fs: SyncFs,
  where: { generation: number; device: string },
  records: AsyncIterable<readonly DataRecord[]> | Iterable<readonly DataRecord[]>,
  root: Uint8Array,
  opts: { app: string; device: readonly DataRecord[]; after?: number; covers?: Cover[]; now?: number; memory?: FolderMemory; onRename?(appending: Appending): void },
  c: DataCrypto,
): Promise<OwnSegment> {
  const folder = deviceFolder(where.generation, where.device);
  const covers = (opts.covers ?? []).slice(-MAX_COVERS);
  await fs.mkdir(folder);
  const grown = async () => {
    for (const [segment, size] of covers) {
      const stat = await fs.stat(`${folder}/${segmentName(segment)}`);
      if (stat && stat.size > size) return true;
    }
    return false;
  };
  if (opts.after !== undefined && ((await othersAbove(fs, where.generation, where.device, opts.after, root, c, opts.memory)) || (await grown()))) throw new AnotherWriter();
  const n = await firstFree(fs, where.generation, where.device, opts.after ?? 0);
  const name = segmentName(n);
  const temp = `${folder}/${name}.part-${hex(c.random(4))}`;
  const head = newHead({ ...where, segment: n }, true, opts.app, root, c, opts.now ?? Date.now(), covers);
  let size: number;
  let index: number;
  let last: Uint8Array | undefined;
  try {
    const first = frames(opts.device, head.key, head.hash, 0, c, true);
    const start = envelope.concat([head.bytes, ...first.bytes]);
    await fs.create(temp, start);
    size = start.length;
    index = first.count;
    last = first.bytes.at(-1);
    for await (const chunk of records) {
      const sealed = frames(chunk, head.key, head.hash, index, c);
      if (sealed.count === 0) continue;
      const bytes = envelope.concat(sealed.bytes);
      await fs.append(temp, bytes);
      size += bytes.length;
      index += sealed.count;
      last = sealed.bytes.at(-1);
    }
    // Before it's in place, what it will be: a stop between the rename and the answer leaves it this computer's own.
    const tail = tailOf(last, size, c);
    opts.onRename?.({ expect: { ...where, segment: n, size, frames: index, closed: [], ...(tail ? { tail } : {}) }, at: 0, length: size, hash: null });
    await fs.rename(temp, `${folder}/${name}`);
  } catch (error) {
    await fs.remove(temp).catch(() => undefined);
    throw error;
  } finally {
    head.key.fill(0);
  }
  // Only what it covers, and only as long as it covered it: anything more is another writer's, and stays.
  const kept: Cover[] = [];
  for (const cover of covers) {
    const path = `${folder}/${segmentName(cover[0])}`;
    const stat = await fs.stat(path);
    if (!stat) continue;
    if (stat.size !== cover[1]) {
      kept.push(cover);
      continue;
    }
    await fs.remove(path).catch(() => kept.push(cover));
  }
  const tail = tailOf(last, size, c);
  return { ...where, segment: n, size, frames: index, closed: kept, ...(tail ? { tail } : {}) };
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
