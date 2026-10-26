/**
 * Sync's folder protocol (S15 §6, §9 step 3, §13) against an in-memory folder,
 * with Node's crypto: two computers setting up and joining, appending and
 * reading as they go; a half-written frame, a frame that doesn't open yet, a
 * shorter file, conflicted copies, compaction in the middle of a read, a
 * copied id, a newer format, a changed passphrase; and what someone who can
 * write to the folder, with the passphrase or without, can't do: hide a
 * computer's log behind junk, stop reading with junk computers, make a
 * computer take new ids, or fill memory with frames that inflate a
 * thousandfold.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendRecords,
  DATA_FORMAT,
  DATA_FORMAT_ABOUT,
  ENCRYPTED_LINE,
  ENVELOPE_VERSION,
  envelope,
  generations,
  inspectFolder,
  lookAtFolder,
  MAX_COMPUTERS,
  MAX_SEGMENT,
  mayPrune,
  nextGeneration,
  readComputers,
  readSegment,
  recordLine,
  SegmentsFull,
  segmentName,
  segmentsOf,
  setUp,
  STEP_BUDGET,
  unlockNewest,
  writeSegment,
  writeSnapshot,
  writeSyncFile,
  type DataRecord,
  type JunkSeen,
  type OwnSegment,
  type ReadEvent,
  type SegmentCursor,
  type StepBudget,
  type SyncFs,
} from '@chord/core';
import { nodeCrypto } from '../src/crypto';
import { ChordDatabase } from '../src/db';

/** scrypt at its smallest, so each test derives keys in a moment; the readers' bounds are tested on their own. */
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const A = '00000000000000aa';
const B = '00000000000000bb';
const PASS = 'correct horse battery staple';
const utf8 = new TextEncoder();

/** A folder in memory, as a sync app would leave it: files, and folders made as they're written into. */
class MemoryFolder implements SyncFs {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  readonly dirs = new Set<string>();
  private clock = 1;
  async list(path: string): Promise<string[] | null> {
    const prefix = path ? `${path}/` : '';
    const names = new Set<string>();
    let any = path === '' && this.files.size > 0;
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      any = true;
      names.add(file.slice(prefix.length).split('/')[0]!);
    }
    for (const dir of this.dirs) if (dir.startsWith(prefix) && dir !== path && dir.length > prefix.length) names.add(dir.slice(prefix.length).split('/')[0]!);
    return any || this.dirs.has(path) ? [...names] : null;
  }
  async stat(path: string) {
    const file = this.files.get(path);
    return file ? { size: file.bytes.length, mtime: file.mtime } : null;
  }
  async read(path: string, position: number, length: number): Promise<Uint8Array> {
    const file = this.files.get(path);
    return file ? file.bytes.slice(position, position + length) : new Uint8Array(0);
  }
  async create(path: string, bytes: Uint8Array, exclusive = false): Promise<void> {
    if (exclusive && this.files.has(path)) throw new Error('EEXIST');
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime: this.clock++ });
  }
  async append(path: string, bytes: Uint8Array): Promise<void> {
    const file = this.files.get(path)!;
    const next = new Uint8Array(file.bytes.length + bytes.length);
    next.set(file.bytes);
    next.set(bytes, file.bytes.length);
    this.files.set(path, { bytes: next, mtime: this.clock++ });
  }
  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, { ...file, mtime: this.clock++ });
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async remove(path: string): Promise<void> {
    for (const file of [...this.files.keys()]) if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
    for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }
  /** A file as a sync app might deliver it: cut to its first `n` bytes. */
  cut(path: string, n: number): void {
    const file = this.files.get(path)!;
    this.files.set(path, { bytes: file.bytes.slice(0, n), mtime: this.clock++ });
  }
  /** What anyone who can write to the folder can put there, without the passphrase. */
  plant(path: string, bytes: Uint8Array | string): void {
    this.files.set(path, { bytes: typeof bytes === 'string' ? utf8.encode(bytes) : bytes, mtime: this.clock++ });
  }
}

const chord = (id: string, name: string, ms: number, device = A): DataRecord => ({ type: 'chord', id, at: [1_800_000_000_000 + ms, 0, device], set: { name } });
const device = (id: string, name: string): DataRecord => ({ type: 'device', id, at: [1_800_000_000_000, 0, id], set: { name, os: 'linux', app: '0.5.0' } });
const deviceId = (n: number) => n.toString(16).padStart(16, '0');

/** A snapshot of `records` (in pages of `page`), its first frame this computer's `device` record. */
const snapshot = (fs: SyncFs, where: { generation: number; device: string }, records: DataRecord[], root: Uint8Array, opts: { after?: number; page?: number } = {}) => {
  const pages: DataRecord[][] = [];
  for (let i = 0; i < records.length; i += opts.page ?? 1000) pages.push(records.slice(i, i + (opts.page ?? 1000)));
  return writeSnapshot(fs, where, pages, root, { app: '0.5.0', device: [device(where.device, 'Computer')], ...(opts.after !== undefined ? { after: opts.after } : {}) }, nodeCrypto);
};

/** A junk header that looks like a segment's, for `where`, that nothing can prove (no frame opens with any key). */
const junkHeader = (where: { generation: number; device: string; segment: number }, extra: Record<string, unknown> = {}) =>
  `${ENCRYPTED_LINE} ${ENVELOPE_VERSION}\n${JSON.stringify({ chord: 'data', format: DATA_FORMAT, kind: 'sync', app: 'x', device: where.device, created: '2026-01-01T00:00:00.000Z', includes: ['setup'], about: DATA_FORMAT_ABOUT, generation: where.generation, segment: where.segment, snapshot: false, salt: envelope.toBase64(new Uint8Array(32)), ...extra })}\n`;

/** A real segment, sealed with the key, whose header says what it's told to (a newer Chord's format, say). */
function forgedSegment(where: { generation: number; device: string; segment: number }, root: Uint8Array, header: Record<string, unknown>, records: DataRecord[]): Uint8Array {
  const salt = nodeCrypto.random(32);
  const line = utf8.encode(JSON.stringify({ chord: 'data', format: DATA_FORMAT, kind: 'sync', app: 'x', device: where.device, created: new Date().toISOString(), includes: ['setup'], about: '', generation: where.generation, segment: where.segment, snapshot: false, salt: envelope.toBase64(salt), ...header }));
  const key = envelope.fileKey(nodeCrypto, root, salt);
  const hash = nodeCrypto.sha256(line);
  const frame = (index: number, lines: string) => {
    const nonce = nodeCrypto.random(12);
    const body = nodeCrypto.seal(key, nonce, nodeCrypto.deflate(utf8.encode(lines)), envelope.frameAad(hash, index, false));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, 12 + body.length);
    return envelope.concat([length, nonce, body]);
  };
  return envelope.concat([utf8.encode(`${ENCRYPTED_LINE} ${ENVELOPE_VERSION}\n`), line, utf8.encode('\n'), frame(0, recordLine(device(where.device, 'X'))), frame(1, records.map(recordLine).join(''))]);
}

function junkSeen(): JunkSeen & { size: number } {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    add: (key) => void seen.add(key),
    get size() {
      return seen.size;
    },
  };
}

/** Everything B reads of the others, merged naively (the merge itself is core's, tested there), with its cursors kept. */
class Reader {
  readonly cursors = new Map<string, SegmentCursor>();
  readonly records: DataRecord[] = [];
  readonly events: ReadEvent[] = [];
  readonly junk = junkSeen();
  constructor(
    private readonly fs: SyncFs,
    private readonly self: string,
    public root: Uint8Array,
    public generation = 1,
  ) {}
  async pass(budget?: Partial<StepBudget>): Promise<DataRecord[]> {
    const got: DataRecord[] = [];
    for await (const event of readComputers(
      this.fs,
      { generation: this.generation, self: this.self, root: this.root, cursor: (d, s) => this.cursors.get(`${d}/${s}`) ?? null, junk: this.junk, ...(budget ? { budget: { ...STEP_BUDGET, ...budget } } : {}) },
      nodeCrypto,
    )) {
      this.events.push(event);
      if (event.kind !== 'records') continue;
      got.push(...event.records);
      this.cursors.set(`${event.device}/${event.segment}`, event.cursor);
    }
    this.records.push(...got);
    return got;
  }
  steps(): Extract<ReadEvent, { kind: 'records' }>[] {
    return this.events.filter((e): e is Extract<ReadEvent, { kind: 'records' }> => e.kind === 'records');
  }
}

async function twoComputers() {
  const fs = new MemoryFolder();
  const look = await inspectFolder(fs);
  expect(look).toEqual({ state: 'new', generation: 1 });
  const set = await setUp(fs, 1, PASS, A, nodeCrypto, FAST);
  if (!set.ok) throw new Error('setup failed');
  let own: OwnSegment = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1)], set.root);
  expect(await inspectFolder(fs)).toEqual({ state: 'join', generation: 1, computers: 1 });
  const joined = await unlockNewest(fs, PASS, nodeCrypto);
  if (!joined.ok) throw new Error('join failed');
  const reader = new Reader(fs, B, joined.root);
  const append = async (records: DataRecord[]) => {
    const result = await appendRecords(fs, own, records, set.root, { app: '0.5.0', device: [device(A, 'Desk')] }, nodeCrypto);
    if (!result.ok) throw new Error(result.problem);
    own = result.own;
    return result;
  };
  return { fs, root: set.root, reader, append, own: () => own, setOwn: (o: OwnSegment) => (own = o) };
}

const ids = (records: DataRecord[]) => records.map((r) => r.id);

describe('setting up and joining', () => {
  it('the second computer reads the first’s snapshot, then only what it appends', async () => {
    const { reader, append } = await twoComputers();
    expect(ids(await reader.pass())).toEqual([A, 'work']);
    await append([chord('work', 'Renamed', 2)]);
    await append([chord('home', 'Home', 3)]);
    expect((await reader.pass()).map((r) => r.set['name'])).toEqual(['Renamed', 'Home']);
    expect(await reader.pass()).toEqual([]);
  });

  it('a wrong passphrase doesn’t open it; the key check tells it from damage', async () => {
    const { fs } = await twoComputers();
    expect(await unlockNewest(fs, 'not the passphrase at all', nodeCrypto)).toEqual({ ok: false, problem: 'wrong' });
  });

  it('a frame not yet whole is read once it is, never before', async () => {
    const { fs, reader, append } = await twoComputers();
    await reader.pass();
    await append([chord('a', 'A', 2)]);
    const path = `1/${A}/${segmentName(1)}`;
    const whole = fs.files.get(path)!.bytes;
    // The sync app has delivered all but the frame's last 10 bytes.
    fs.cut(path, whole.length - 10);
    expect(await reader.pass()).toEqual([]);
    fs.plant(path, whole);
    expect(ids(await reader.pass())).toEqual(['a']);
  });

  it('a frame that fails its check stops the read there, and is read again once it opens', async () => {
    const { fs, reader, append } = await twoComputers();
    await reader.pass();
    await append([chord('a', 'A', 2)]);
    await append([chord('b', 'B', 3)]);
    const path = `1/${A}/${segmentName(1)}`;
    const whole = new Uint8Array(fs.files.get(path)!.bytes);
    const flipped = new Uint8Array(whole);
    flipped[whole.length - 40] = flipped[whole.length - 40]! ^ 0xff;
    fs.plant(path, flipped);
    expect(ids(await reader.pass())).toEqual(['a']);
    fs.plant(path, whole);
    expect(ids(await reader.pass())).toEqual(['b']);
  });

  it('a file that got shorter (an older copy delivered) is read again from the start: merging twice changes nothing', async () => {
    const { fs, reader, append } = await twoComputers();
    const path = `1/${A}/${segmentName(1)}`;
    const older = new Uint8Array(fs.files.get(path)!.bytes);
    await append([chord('a', 'A', 2)]);
    await reader.pass();
    fs.plant(path, older);
    expect(ids(await reader.pass())).toEqual([A, 'work']);
  });

  it('reads a big log over several steps, each within its budget of bytes, inflated bytes and records', async () => {
    const { reader, append } = await twoComputers();
    for (let i = 0; i < 5; i++) await append(Array.from({ length: 50 }, (_, j) => chord(`c${i}-${j}`, 'x'.repeat(500), i * 100 + j)));
    expect((await reader.pass({ bytes: 50 })).length).toBe(2 + 250);
    expect(reader.steps().length).toBeGreaterThan(3);
    const byRecords = new Reader(reader['fs'] as SyncFs, B, reader.root);
    expect((await byRecords.pass({ records: 60 })).length).toBe(2 + 250);
    expect(Math.max(...byRecords.steps().map((s) => s.records.length))).toBeLessThanOrEqual(60 + 50);
    const byInflated = new Reader(reader['fs'] as SyncFs, B, reader.root);
    expect((await byInflated.pass({ inflated: 40_000 })).length).toBe(2 + 250);
    expect(byInflated.steps().length).toBeGreaterThan(2);
  });

  it('a snapshot is written as its pages come, and appears whole: one cut short never appears', async () => {
    const { fs, root, reader, own, setOwn } = await twoComputers();
    const many = Array.from({ length: 300 }, (_, i) => chord(`p${i}`, `P${i}`, i));
    setOwn(await snapshot(fs, { generation: 1, device: A }, many, root, { after: own().segment, page: 40 }));
    expect((await reader.pass()).filter((r) => r.type === 'chord')).toHaveLength(300);
    // A snapshot whose pages stop (chord-data stopped): nothing new appears, and its part is cleared away.
    async function* cut() {
      yield [chord('q', 'Q', 1)];
      throw new Error('stopped');
    }
    await expect(writeSnapshot(fs, { generation: 1, device: A }, cut(), root, { app: '0.5.0', device: [], after: own().segment }, nodeCrypto)).rejects.toThrow('stopped');
    expect(await segmentsOf(fs, 1, A)).toEqual([own().segment]);
    expect([...fs.files.keys()].some((name) => name.includes('.part-'))).toBe(false);
  });
});

describe('what a sync app leaves in the folder', () => {
  it('conflicted copies are passed over, and a conflicted copy of the folder’s file can’t be joined', async () => {
    const { fs, reader } = await twoComputers();
    const segment = fs.files.get(`1/${A}/${segmentName(1)}`)!;
    fs.files.set(`1/${A}/000001 (conflicted copy 2026-11-30).chordlog`, segment);
    fs.files.set(`1/${A}/000002.chordlog.tmp`, segment);
    fs.files.set(`1/not-a-device/${segmentName(1)}`, segment);
    expect(ids(await reader.pass())).toEqual([A, 'work']);
    fs.files.set('sync-1 (conflicted copy).json', fs.files.get('sync-1.json')!);
    expect(await inspectFolder(fs)).toEqual({ state: 'conflict' });
    expect(await generations(fs)).toEqual({ generations: [1], conflicted: true });
  });

  it('two computers setting up one empty folder at once: the second stops', async () => {
    const fs = new MemoryFolder();
    expect((await setUp(fs, 1, PASS, A, nodeCrypto, FAST)).ok).toBe(true);
    expect(await setUp(fs, 1, 'another passphrase here', B, nodeCrypto, FAST)).toEqual({ ok: false, problem: 'conflict' });
    // Its file arrived as a conflicted copy instead: the one whose key doesn't open the folder's file stops.
    const other = new MemoryFolder();
    const first = await setUp(other, 1, PASS, A, nodeCrypto, FAST);
    const theirs = new MemoryFolder();
    const second = await setUp(theirs, 1, 'another passphrase here', B, nodeCrypto, FAST);
    if (!first.ok || !second.ok) throw new Error('setup failed');
    other.files.set('sync-1 (B’s conflicted copy).json', theirs.files.get('sync-1.json')!);
    expect(await lookAtFolder(other, 1, second.root, nodeCrypto)).toEqual({ state: 'conflict' });
    expect(await lookAtFolder(other, 1, first.root, nodeCrypto)).toEqual({ state: 'ok' });
  });

  it('compaction in the middle of a read: the snapshot holds what the deleted segments did, and earlier ones are passed over', async () => {
    const { fs, root, reader, append, own, setOwn } = await twoComputers();
    await append([chord('a', 'A', 2)]);
    await reader.pass();
    await append([chord('b', 'B', 3)]);
    // A compacts: everything it knows in a new segment, its earlier ones deleted (here, before B read 'b').
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a', 'A', 2), chord('b', 'B', 3)], root, { after: own().segment }));
    expect(await segmentsOf(fs, 1, A)).toEqual([2]);
    expect(own().segment).toBe(2);
    expect(ids(await reader.pass()).sort()).toEqual([A, 'a', 'b', 'work'].sort());
    // Delivered out of order: an old segment shows up again after the snapshot. Only the snapshot and what follows count.
    await writeSegment(fs, { generation: 1, device: A, segment: 1 }, [chord('old', 'Old', 0)], root, { snapshot: false, app: '0.5.0', device: [] }, nodeCrypto);
    const fresh = new Reader(fs, B, reader.root);
    expect(ids(await fresh.pass())).not.toContain('old');
  });

  it('a copied id: before appending, a computer checks its segment ends where it left it', async () => {
    const { fs, root, own, append } = await twoComputers();
    const copy: OwnSegment = { ...own() };
    await append([chord('a', 'A', 2)]);
    // The other copy of this profile appends with what it remembers: a real frame is past where it left off.
    expect(await appendRecords(fs, copy, [chord('b', 'B', 3)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
    // Or the other copy started a real segment past this one's.
    const fresh = await twoComputers();
    await writeSegment(fresh.fs, { generation: 1, device: A, segment: 2 }, [chord('x', 'X', 9)], fresh.root, { snapshot: false, app: '0.5.0', device: [] }, nodeCrypto);
    expect(await appendRecords(fresh.fs, fresh.own(), [chord('b', 'B', 3)], fresh.root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
  });

  it('a segment says where it belongs: one copied into another computer’s folder isn’t read', async () => {
    const { fs, reader } = await twoComputers();
    fs.files.set(`1/${B.replace('b', 'c')}/${segmentName(1)}`, fs.files.get(`1/${A}/${segmentName(1)}`)!);
    expect(ids(await reader.pass())).toEqual([A, 'work']);
  });

  it('this computer’s segment gone, the folder there: `gone` (a snapshot puts it back); the folder gone too: `missing`', async () => {
    const { fs, root, own } = await twoComputers();
    await fs.remove(`1/${A}/${segmentName(1)}`);
    expect(await appendRecords(fs, own(), [chord('a', 'A', 2)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'gone' });
    const shorter = await twoComputers();
    shorter.fs.cut(`1/${A}/${segmentName(1)}`, shorter.own().size - 5);
    expect(await appendRecords(shorter.fs, shorter.own(), [chord('a', 'A', 2)], shorter.root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'gone' });
    await fs.remove('sync-1.json');
    expect(await appendRecords(fs, own(), [chord('a', 'A', 2)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'missing' });
  });
});

describe('junk anyone who can write to the folder puts there, without the passphrase', () => {
  it('a segment name past a computer’s own neither makes it take a new id nor numbers its next segment out of reach', async () => {
    const { fs, root, reader, append, own, setOwn } = await twoComputers();
    fs.plant(`1/${A}/${segmentName(MAX_SEGMENT)}`, junkHeader({ generation: 1, device: A, segment: MAX_SEGMENT }));
    fs.plant(`1/${A}/${segmentName(5)}`, 'not a segment at all');
    // Appending goes on in its own segment: the junk is no other computer.
    await append([chord('a', 'A', 2)]);
    expect(own().segment).toBe(1);
    // A snapshot goes past its newest real segment, not past the junk, and clears the junk out of its folder.
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a', 'A', 2)], root, { after: own().segment }));
    expect(own().segment).toBe(2);
    expect(await segmentsOf(fs, 1, A)).toEqual([2]);
    expect(ids(await reader.pass()).sort()).toEqual([A, 'a', 'work'].sort());
  });

  it('a fake snapshot header past a computer’s segments hides none of them', async () => {
    const { fs, reader, append } = await twoComputers();
    await append([chord('a', 'A', 2)]);
    fs.plant(`1/${A}/${segmentName(7)}`, junkHeader({ generation: 1, device: A, segment: 7 }, { snapshot: true }));
    expect(ids(await reader.pass())).toEqual([A, 'work', 'a']);
    // Nor once it's been looked at: no cursor says it's a snapshot.
    await append([chord('b', 'B', 3)]);
    expect(ids(await reader.pass())).toEqual(['b']);
    expect(reader.junk.size).toBeGreaterThan(0);
  });

  it('64 junk computers, sorted before the real ones, stop no reading; only computers with a real segment count', async () => {
    const { fs, reader } = await twoComputers();
    for (let i = 0; i < MAX_COMPUTERS; i++) {
      fs.plant(`1/${deviceId(i)}/${segmentName(1)}`, new Uint8Array(0));
      fs.plant(`1/${deviceId(i)}/${segmentName(2)}`, junkHeader({ generation: 1, device: deviceId(i), segment: 2 }));
    }
    expect(ids(await reader.pass())).toEqual([A, 'work']);
    expect(reader.events.some((e) => e.kind === 'too-many')).toBe(false);
  });

  it('more real computers than sync reads: it says so, rather than leaving some out without a word', async () => {
    const { fs, root, reader } = await twoComputers();
    for (let i = 1; i <= MAX_COMPUTERS; i++) await snapshot(fs, { generation: 1, device: deviceId(0x100 + i) }, [], root);
    await reader.pass();
    expect(reader.events.some((e) => e.kind === 'too-many')).toBe(true);
  });

  it('bytes added after a computer’s last frame: it doesn’t take a new id, its next change starts a new segment, and readers read on there', async () => {
    const { fs, reader, append, own } = await twoComputers();
    await reader.pass();
    const path = `1/${A}/${segmentName(1)}`;
    await fs.append(path, Uint8Array.from([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]));
    await append([chord('a', 'A', 2)]);
    expect(own().segment).toBe(2);
    expect(ids(await reader.pass())).toEqual([A, 'a']);
    // The first segment still stops where the junk is, and its read doesn't move.
    const cursor = reader.cursors.get(`${A}/1`)!;
    const again = await readSegment(fs, { generation: 1, device: A, segment: 1 }, reader.root, cursor, nodeCrypto);
    expect(again.stopped).toBe('damaged');
    expect(again.cursor.offset).toBe(cursor.offset);
  });

  it('a newer envelope can’t be told from junk: passed over, and reading goes on', async () => {
    const { fs, reader, append } = await twoComputers();
    await append([chord('a', 'A', 2)]);
    fs.plant(`1/${A}/${segmentName(9)}`, junkHeader({ generation: 1, device: A, segment: 9 }).replace(`${ENCRYPTED_LINE} ${ENVELOPE_VERSION}`, `${ENCRYPTED_LINE} 2`));
    expect(ids(await reader.pass())).toEqual([A, 'work', 'a']);
    expect(reader.events.some((e) => e.kind === 'newer')).toBe(false);
  });

  it('segment numbers at the top: a computer takes a new id (`full`), never a name no reader lists', async () => {
    const { fs, root } = await twoComputers();
    const top = await writeSegment(fs, { generation: 1, device: A, segment: MAX_SEGMENT }, [], root, { snapshot: true, app: '0.5.0', device: [] }, nodeCrypto);
    expect(await appendRecords(fs, { ...top, size: 2 * 1024 * 1024 }, [], root, { app: '0.5.0', device: [] }, nodeCrypto)).toMatchObject({ ok: false });
    await fs.append(`1/${A}/${segmentName(MAX_SEGMENT)}`, Uint8Array.from([1, 2, 3, 4, 5]));
    expect(await appendRecords(fs, top, [chord('a', 'A', 2)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'full' });
    await expect(snapshot(fs, { generation: 1, device: A }, [], root, { after: MAX_SEGMENT })).rejects.toBeInstanceOf(SegmentsFull);
    expect(() => segmentName(MAX_SEGMENT + 1)).toThrow(SegmentsFull);
  });
});

describe('frames from a computer with the passphrase that are past what a frame holds', () => {
  it('one that inflates past what a frame may: passed over and counted, and reading goes on after it', async () => {
    const { reader, append } = await twoComputers();
    await reader.pass();
    // One record of 9 MB of one letter: a frame a few kilobytes long that inflates to more than any frame Chord writes.
    await append([{ type: 'widget', id: 'big', at: [1_800_000_000_002, 0, A], set: { blob: 'a'.repeat(9 * 1024 * 1024) } }]);
    await append([chord('after', 'After', 3)]);
    expect(ids(await reader.pass())).toEqual(['after']);
    expect(reader.steps().reduce((n, s) => n + s.refused, 0)).toBe(1);
  });

  it('one with more records than a frame holds: passed over and counted', async () => {
    const { fs, root, reader } = await twoComputers();
    const where = { generation: 1, device: B.replace('b', 'd'), segment: 1 };
    const tiny = Array.from({ length: 25_000 }, (_, i): DataRecord => ({ type: 'w', id: `${i}`, set: { v: 1 } }));
    fs.plant(`1/${where.device}/${segmentName(1)}`, forgedSegment(where, root, {}, tiny));
    await reader.pass();
    expect(reader.records.filter((r) => r.type === 'w')).toHaveLength(0);
    expect(reader.steps().reduce((n, s) => n + s.refused, 0)).toBe(1);
  });
});

describe('a removed computer', () => {
  it('its removal is in the remover’s log, read like any change; it notices; and once the remover compacts, its folder can go', async () => {
    const { fs, root, reader, append, own, setOwn } = await twoComputers();
    // B (the reader) has written a log of its own too.
    await snapshot(fs, { generation: 1, device: B }, [], root);
    await reader.pass();
    // A removes B: a `device` record in A's own log, never in B's folder.
    const removedAt = Date.now();
    await append([{ type: 'device', id: B, at: [removedAt, 0, A], set: { removed: true } }]);
    const got = await reader.pass();
    expect(got).toEqual([{ type: 'device', id: B, at: [removedAt, 0, A], set: { removed: true } }]);
    // B merges it as chord-data does, and knows it was removed, and when.
    const dir = mkdtempSync(join(tmpdir(), 'chord-sync-removed-'));
    const db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
    try {
      db.newDevice();
      const self = db.device();
      const result = db.atomically(() => db.sync.merge(got.map((r) => (r.type === 'device' ? { ...r, id: self } : r)), Date.now()));
      expect(result.removed).toBe(removedAt);
    } finally {
      db.close();
    }
    // A compacts. It reads B's log to its end first; then B's folder may go: nothing in it is newer than the removal.
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), { type: 'device', id: B, at: [removedAt, 0, A], set: { removed: true } }], root, { after: own().segment }));
    const remover = new Reader(fs, A, root);
    await remover.pass();
    const cursor = (s: number) => remover.cursors.get(`${B}/${s}`) ?? null;
    expect(await mayPrune(fs, { generation: 1, device: B }, removedAt + 1, root, cursor, nodeCrypto)).toBe(true);
    await fs.remove(`1/${B}`);
    const third = new Reader(fs, '00000000000000cc', reader.root);
    expect((await third.pass()).map((r) => `${r.type}:${r.id}`).sort()).toEqual([`chord:work`, `device:${A}`, `device:${B}`]);
  });

  it('a removed computer’s folder stays while it holds what hasn’t been read here, or anything made after its removal (it joined again)', async () => {
    const { fs, root } = await twoComputers();
    const removedAt = Date.now() - 60_000;
    await snapshot(fs, { generation: 1, device: B }, [], root);
    const remover = new Reader(fs, A, root);
    // Not read yet: it stays.
    expect(await mayPrune(fs, { generation: 1, device: B }, Date.now() + 60_000, root, (s) => remover.cursors.get(`${B}/${s}`) ?? null, nodeCrypto)).toBe(false);
    await remover.pass();
    // Read to its end, but made after the removal (it turned sync off and on again): it stays.
    expect(await mayPrune(fs, { generation: 1, device: B }, removedAt, root, (s) => remover.cursors.get(`${B}/${s}`) ?? null, nodeCrypto)).toBe(false);
    // Junk in a removed computer's folder keeps nothing.
    const gone = deviceId(0x77);
    fs.plant(`1/${gone}/${segmentName(1)}`, junkHeader({ generation: 1, device: gone, segment: 1 }));
    expect(await mayPrune(fs, { generation: 1, device: gone }, removedAt, root, () => null, nodeCrypto)).toBe(true);
  });
});

describe('a newer Chord, and a new passphrase', () => {
  it.each<[string, (fs: MemoryFolder) => void]>([
    [
      'the folder’s file has a newer format',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as Record<string, unknown>;
        fs.plant('sync-1.json', JSON.stringify({ ...file, format: 2 }));
      },
    ],
    [
      'a key derivation Chord can’t run',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as Record<string, unknown>;
        fs.plant('sync-1.json', JSON.stringify({ ...file, kdf: { name: 'argon2id', salt: 'AAAA' } }));
      },
    ],
    [
      'scrypt asking for more memory than a reader gives it',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as { kdf: object };
        fs.plant('sync-1.json', JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 ** 20, r: 8 } }));
      },
    ],
  ])('%s: the folder reads as newer', async (_what, change) => {
    const { fs, root } = await twoComputers();
    change(fs);
    expect(await lookAtFolder(fs, 1, root, nodeCrypto)).toEqual({ state: 'newer' });
    expect(await inspectFolder(fs)).toEqual({ state: 'newer' });
  });

  it('a real segment of a newer Chord’s format stops reading that computer', async () => {
    const { fs, root, reader } = await twoComputers();
    await reader.pass();
    fs.plant(`1/${A}/${segmentName(2)}`, forgedSegment({ generation: 1, device: A, segment: 2 }, root, { format: DATA_FORMAT + 1 }, [chord('n', 'N', 5)]));
    expect(await reader.pass()).toEqual([]);
    expect(reader.events).toContainEqual({ kind: 'newer', device: A });
  });

  it('a new passphrase: a new generation, the others pause until they have it, and who changed it isn’t taken from its file', async () => {
    const { fs, reader } = await twoComputers();
    const next = await nextGeneration(fs, 'a brand new passphrase', A, nodeCrypto, FAST);
    expect(next.generation).toBe(2);
    await snapshot(fs, { generation: 2, device: A }, [chord('work', 'Work', 1)], next.root);
    expect(await lookAtFolder(fs, 1, reader.root, nodeCrypto)).toEqual({ state: 'changed', generation: 2 });
    expect(await unlockNewest(fs, PASS, nodeCrypto)).toEqual({ ok: false, problem: 'wrong' });
    const moved = await unlockNewest(fs, 'a brand new passphrase', nodeCrypto);
    if (!moved.ok) throw new Error('unlock failed');
    const after = new Reader(fs, B, moved.root, 2);
    expect(ids(await after.pass())).toEqual([A, 'work']);
  });

  it('a generation past what a name holds is never written', async () => {
    const fs = new MemoryFolder();
    await writeSyncFile(fs, 999_999, PASS, A, nodeCrypto, FAST);
    await expect(nextGeneration(fs, PASS, A, nodeCrypto, FAST)).rejects.toThrow();
  });

  it('the folder’s file is written once, never over another', async () => {
    const fs = new MemoryFolder();
    await writeSyncFile(fs, 1, PASS, A, nodeCrypto, FAST);
    await expect(writeSyncFile(fs, 1, PASS, B, nodeCrypto, FAST)).rejects.toThrow();
  });
});
