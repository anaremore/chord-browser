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
  AnotherWriter,
  appendRecords,
  coversOf,
  DATA_FORMAT,
  DATA_FORMAT_ABOUT,
  ENCRYPTED_LINE,
  ENVELOPE_VERSION,
  envelope,
  folderMemory,
  generations,
  inspectFolder,
  lookAtFolder,
  MAX_COMPUTERS,
  MAX_JUNK,
  MAX_SEGMENT,
  mayPrune,
  nextGeneration,
  ownIntact,
  readComputers,
  readSegment,
  recordLine,
  removeStaleTemps,
  settleAppend,
  STALE_TEMP_MS,
  SegmentsFull,
  segmentName,
  segmentsOf,
  setUp,
  STEP_BUDGET,
  unlockNewest,
  writeSegment,
  writeSnapshot,
  writeSyncFile,
  type Appending,
  type DataRecord,
  type FolderMemory,
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
  async cutBack(path: string, at: number, expect: Uint8Array): Promise<boolean> {
    const file = this.files.get(path);
    if (!file || file.bytes.length !== at + expect.length || !file.bytes.subarray(at).every((byte, i) => byte === expect[i])) return false;
    this.files.set(path, { bytes: file.bytes.slice(0, at), mtime: this.clock++ });
    return true;
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
const snapshot = (fs: SyncFs, where: { generation: number; device: string }, records: DataRecord[], root: Uint8Array, opts: { own?: OwnSegment; after?: number; page?: number } = {}) => {
  const after = opts.own?.segment ?? opts.after;
  const pages: DataRecord[][] = [];
  for (let i = 0; i < records.length; i += opts.page ?? 1000) pages.push(records.slice(i, i + (opts.page ?? 1000)));
  return writeSnapshot(fs, where, pages, root, { app: '0.5.0', device: [device(where.device, 'Computer')], covers: coversOf(opts.own ?? null), ...(after !== undefined ? { after } : {}) }, nodeCrypto);
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

/** Everything B reads of the others, merged naively (the merge itself is core's, tested there), with its cursors kept. */
class Reader {
  readonly cursors = new Map<string, SegmentCursor>();
  readonly records: DataRecord[] = [];
  readonly events: ReadEvent[] = [];
  readonly memory: FolderMemory = folderMemory();
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
      {
        generation: this.generation,
        self: this.self,
        root: this.root,
        cursor: (d, s) => this.cursors.get(`${d}/${s}`) ?? null,
        known: (d) => [...this.cursors].filter(([key, cursor]) => key.startsWith(`${d}/`) && cursor.frame > 0).map(([key]) => Number(key.split('/')[1])),
        memory: this.memory,
        ...(budget ? { budget: { ...STEP_BUDGET, ...budget } } : {}),
      },
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
    setOwn(await snapshot(fs, { generation: 1, device: A }, many, root, { own: own(), page: 40 }));
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
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a', 'A', 2), chord('b', 'B', 3)], root, { own: own() }));
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

  it('this computer’s segment gone, the folder there: `gone`; shorter than it left it: another writer (`copied`); the folder gone too: `missing`', async () => {
    const { fs, root, own } = await twoComputers();
    await fs.remove(`1/${A}/${segmentName(1)}`);
    expect(await appendRecords(fs, own(), [chord('a', 'A', 2)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'gone' });
    const shorter = await twoComputers();
    shorter.fs.cut(`1/${A}/${segmentName(1)}`, shorter.own().size - 5);
    expect(await appendRecords(shorter.fs, shorter.own(), [chord('a', 'A', 2)], shorter.root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
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
    // A snapshot goes past its newest real segment, not past the junk; it deletes only its own earlier segments, never what it can't show it wrote.
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a', 'A', 2)], root, { own: own() }));
    expect(own().segment).toBe(2);
    expect(await segmentsOf(fs, 1, A)).toEqual([2, 5, MAX_SEGMENT]);
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
    expect(reader.memory.junk.size).toBeGreaterThan(0);
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

  it('bytes added after a computer’s last frame: as far as it can tell, another writer, so it takes a new id (seen, never silent); readers stop there', async () => {
    const { fs, root, reader, own } = await twoComputers();
    await reader.pass();
    const path = `1/${A}/${segmentName(1)}`;
    await fs.append(path, Uint8Array.from([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]));
    expect(await appendRecords(fs, own(), [chord('a', 'A', 2)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
    // The segment still stops where the junk is, and its read doesn't move.
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
    // A full segment (past SEGMENT_CLOSE, of what doesn't compress) at the top: there's no number past it.
    const filler = Array.from({ length: 4 }, (_, i): DataRecord => ({ type: 'widget', id: `w${i}`, at: [1_800_000_000_000, 0, A], set: { blob: Buffer.from(nodeCrypto.random(300_000)).toString('base64') } }));
    const top = await writeSegment(fs, { generation: 1, device: A, segment: MAX_SEGMENT }, filler, root, { snapshot: true, app: '0.5.0', device: [] }, nodeCrypto);
    expect(top.size).toBeGreaterThan(1024 * 1024);
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
    setOwn(await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), { type: 'device', id: B, at: [removedAt, 0, A], set: { removed: true } }], root, { own: own() }));
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
    // Junk in a removed computer's folder keeps nothing: a whole first frame that doesn't open.
    const gone = deviceId(0x77);
    const garbage = new Uint8Array(4 + 40);
    new DataView(garbage.buffer).setUint32(0, 40);
    fs.plant(`1/${gone}/${segmentName(1)}`, envelope.concat([utf8.encode(junkHeader({ generation: 1, device: gone, segment: 1 })), garbage]));
    expect(await mayPrune(fs, { generation: 1, device: gone }, removedAt, root, () => null, nodeCrypto)).toBe(true);
    // One still being delivered (its first frame not all there) may be a computer's new snapshot: its folder stays.
    const rejoined = await twoComputers();
    const whole = await snapshot(rejoined.fs, { generation: 1, device: B }, [chord('x', 'X', 1, B)], rejoined.root);
    rejoined.fs.cut(`1/${B}/${segmentName(whole.segment)}`, rejoined.fs.files.get(`1/${B}/${segmentName(whole.segment)}`)!.bytes.length - 30);
    const half = new Uint8Array(rejoined.fs.files.get(`1/${B}/${segmentName(whole.segment)}`)!.bytes);
    const header = new TextDecoder('latin1').decode(half).indexOf('\n', new TextDecoder('latin1').decode(half).indexOf('\n') + 1) + 1;
    rejoined.fs.plant(`1/${B}/${segmentName(whole.segment)}`, half.slice(0, header + 10));
    expect(await mayPrune(rejoined.fs, { generation: 1, device: B }, Date.now() + 60_000, rejoined.root, () => null, nodeCrypto)).toBe(false);
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

describe('two copies of one profile, writing under one id', () => {
  /** A computer writing as chord-data does: what it knows (its copy), its newest segment, and a new id when another writes under its own. */
  class Writer {
    readonly memory = folderMemory();
    constructor(
      private readonly fs: SyncFs,
      private readonly root: Uint8Array,
      public id: string,
      public own: OwnSegment,
      public known: DataRecord[],
      private readonly nextId: () => string,
    ) {}
    clone(id = this.id): Writer {
      return new Writer(this.fs, this.root, id, { ...this.own }, [...this.known], this.nextId);
    }
    async write(records: DataRecord[]): Promise<void> {
      this.known.push(...records);
      const result = await appendRecords(this.fs, this.own, records, this.root, { app: '0.5.0', device: [device(this.id, 'X')], memory: this.memory }, nodeCrypto);
      if (result.ok) {
        this.own = result.own;
        return;
      }
      if (result.problem !== 'copied' && result.problem !== 'gone') throw new Error(result.problem);
      // S15 §6: another computer writes under this id, or may (its log is gone): a new id, and everything it knows there.
      this.id = this.nextId();
      this.own = await snapshot(this.fs, { generation: 1, device: this.id }, this.known, this.root);
    }
    async compact(): Promise<void> {
      try {
        this.own = await snapshot(this.fs, { generation: 1, device: this.id }, this.known, this.root, { own: this.own });
      } catch (error) {
        // Another computer under this id (a segment grew past what this one wrote, or a real one past its own): a new id, deleting nothing.
        if (!(error instanceof AnotherWriter)) throw error;
        this.id = this.nextId();
        this.own = await snapshot(this.fs, { generation: 1, device: this.id }, this.known, this.root);
      }
    }
  }

  it('after one compacts away the other’s segment, neither deletes the other’s log; the other takes a new id, and both converge', async () => {
    const { fs, root, own, append } = await twoComputers();
    await append([chord('a0', 'A0', 2)]);
    let n = 0x500;
    const nextId = () => deviceId(n++);
    const original = new Writer(fs, root, A, own(), [chord('work', 'Work', 1), chord('a0', 'A0', 2)], nextId);
    // The profile is copied to a second computer: the same id, the same segment, the same copy.
    const copy = original.clone();
    for (let round = 1; round <= 6; round++) {
      await original.compact();
      await original.write([chord(`a${round}`, `A${round}`, 10 * round)]);
      await copy.write([chord(`b${round}`, `B${round}`, 10 * round + 1)]);
      await copy.compact();
      await copy.write([chord(`c${round}`, `C${round}`, 10 * round + 2)]);
      // Both logs are there, each a real one.
      expect(await segmentsOf(fs, 1, original.id)).toContain(original.own.segment);
      expect(await segmentsOf(fs, 1, copy.id)).toContain(copy.own.segment);
    }
    expect(copy.id).not.toBe(original.id);
    // A third computer reads everything both wrote; each of them reads the other's.
    const everything = (records: DataRecord[]) => new Set(records.filter((r) => r.type === 'chord').map((r) => r.id));
    const expected = everything([...original.known, ...copy.known]);
    const third = new Reader(fs, '00000000000000cc', root);
    await third.pass();
    expect(everything(third.records)).toEqual(expected);
    const byOriginal = new Reader(fs, original.id, root);
    await byOriginal.pass();
    expect(everything([...original.known, ...byOriginal.records])).toEqual(expected);
    const byCopy = new Reader(fs, copy.id, root);
    await byCopy.pass();
    expect(everything([...copy.known, ...byCopy.records])).toEqual(expected);
  });

  it('a segment brought back, with another copy’s edits, after compactions deleted it: its edits are read, nobody deletes it, and the copy takes a new id', async () => {
    const { fs, root, own, append } = await twoComputers();
    await append([chord('a0', 'A0', 2)]);
    const early = new Reader(fs, B, root);
    await early.pass();
    // Copy B, offline: its own copy of the folder (as its sync app holds it), where it appends b1 to the shared segment 1.
    const offline = new MemoryFolder();
    for (const [path, file] of fs.files) offline.files.set(path, { ...file, bytes: new Uint8Array(file.bytes) });
    const b1 = await appendRecords(offline, own(), [chord('b1', 'B1', 3)], root, { app: '0.5.0', device: [] }, nodeCrypto);
    if (!b1.ok) throw new Error(b1.problem);
    // A compacts twice, deleting below each time.
    let aOwn = own();
    aOwn = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a0', 'A0', 2)], root, { own: aOwn });
    aOwn = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a0', 'A0', 2)], root, { own: aOwn });
    expect(await segmentsOf(fs, 1, A)).toEqual([3]);
    // B reconnects, and its sync app keeps B's edited segment 1 over A's delete.
    fs.plant(`1/${A}/${segmentName(1)}`, offline.files.get(`1/${A}/${segmentName(1)}`)!.bytes);
    expect(await segmentsOf(fs, 1, A)).toEqual([1, 3]);
    // B's next change finds A's segment 3 past its own: another computer under its id, so B takes a new id.
    expect(await appendRecords(fs, b1.own, [chord('b2', 'B2', 4)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
    // Readers read b1 (segment 1, which A's snapshot 3 doesn't cover), those that had read A's log before too.
    expect(ids(await new Reader(fs, B, root).pass())).toEqual(expect.arrayContaining(['a0', 'b1']));
    expect(ids(await early.pass())).toContain('b1');
    // A's next compaction leaves segment 1: A can't show it wrote it as it is.
    await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a0', 'A0', 2)], root, { own: aOwn });
    expect(await segmentsOf(fs, 1, A)).toEqual([1, 4]);
  });

  it('a segment that grew past what this computer wrote: its compaction stops (a new id, deleting nothing), and readers read what grew', async () => {
    const { fs, root, own, append } = await twoComputers();
    await append([chord('a0', 'A0', 2)]);
    // Another copy, online, appends to the shared segment.
    const copy = await appendRecords(fs, own(), [chord('b1', 'B1', 3)], root, { app: '0.5.0', device: [] }, nodeCrypto);
    expect(copy.ok).toBe(true);
    await expect(snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1)], root, { own: own() })).rejects.toBeInstanceOf(AnotherWriter);
    expect(await segmentsOf(fs, 1, A)).toEqual([1]);
    // A snapshot covering what A wrote of it, with the segment grown since: readers read past what it covers.
    const covered: OwnSegment = own();
    const grown = await appendRecords(fs, copy.ok ? copy.own : covered, [chord('b2', 'B2', 4)], root, { app: '0.5.0', device: [] }, nodeCrypto);
    expect(grown.ok).toBe(true);
    const n = await writeSnapshot(fs, { generation: 1, device: A }, [[chord('work', 'Work', 1), chord('a0', 'A0', 2)]], root, { app: '0.5.0', device: [], covers: coversOf(covered) }, nodeCrypto);
    expect(n.closed).toEqual(coversOf(covered));
    expect(await segmentsOf(fs, 1, A)).toEqual([1, n.segment]);
    const reader = new Reader(fs, B, root);
    expect(ids(await reader.pass())).toEqual(expect.arrayContaining(['a0', 'b1', 'b2']));
  });

  it('this computer’s segment gone with nothing real past it: a new id all the same, and nothing in the old folder deleted', async () => {
    const { fs, root, own, append } = await twoComputers();
    await append([chord('a0', 'A0', 2)]);
    let n = 0x600;
    const writer = new Writer(fs, root, A, own(), [chord('work', 'Work', 1), chord('a0', 'A0', 2)], () => deviceId(n++));
    fs.plant(`1/${A}/${segmentName(9)}`, 'something else');
    await fs.remove(`1/${A}/${segmentName(1)}`);
    await writer.write([chord('a1', 'A1', 3)]);
    expect(writer.id).not.toBe(A);
    expect(await segmentsOf(fs, 1, A)).toEqual([9]);
    const reader = new Reader(fs, B, root);
    expect(ids(await reader.pass()).filter((id) => id !== writer.id)).toEqual(expect.arrayContaining(['work', 'a0', 'a1']));
  });
});

describe('what writing and reading cost with junk about', () => {
  /** A folder that counts what's read from it. */
  class Counting extends MemoryFolder {
    bytes = 0;
    override async read(path: string, position: number, length: number): Promise<Uint8Array> {
      const out = await super.read(path, position, length);
      this.bytes += out.length;
      return out;
    }
  }

  it('a write looks into a few names past its segment at most, reads little of each, and remembers junk', async () => {
    const fs = new Counting();
    const set = await setUp(fs, 1, PASS, A, nodeCrypto, FAST);
    if (!set.ok) throw new Error('setup failed');
    let own = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1)], set.root);
    // 100 junk segments past this computer's, each a plausible header and 64 KB a first frame could be.
    const filler = new Uint8Array(4 + 64 * 1024);
    new DataView(filler.buffer).setUint32(0, 64 * 1024);
    for (let n = 2; n < 102; n++) fs.plant(`1/${A}/${segmentName(n)}`, envelope.concat([utf8.encode(junkHeader({ generation: 1, device: A, segment: n })), filler]));
    const memory = folderMemory();
    const write = async (name: string) => {
      fs.bytes = 0;
      const result = await appendRecords(fs, own, [chord('work', name, 2)], set.root, { app: '0.5.0', device: [], memory }, nodeCrypto);
      if (!result.ok) throw new Error(result.problem);
      own = result.own;
      return fs.bytes;
    };
    // Each write looks into at most 16 names (a header, and the 4 bytes saying a first frame is too long), never a 64 KB frame.
    for (let n = 0; n < 7; n++) expect(await write(`Write ${n}`)).toBeLessThan(40 * 1024);
    // Once all 100 are remembered, a write reads only its own segment's head.
    expect(memory.junk.size).toBe(100);
    expect(await write('Later')).toBeLessThan(5 * 1024);
    expect(await write('Later still')).toBeLessThan(5 * 1024);
  });

  it('junk computers past what one pass looks into: the next pass goes on from there, and finds the computer after them', async () => {
    const { fs, root } = await twoComputers();
    const later = 'ffffffffffffff01';
    await snapshot(fs, { generation: 1, device: later }, [chord('late', 'Late', 1, later)], root);
    for (let i = 0; i < 1500; i++) fs.plant(`1/${deviceId(0x1000 + i)}/${segmentName(1)}`, junkHeader({ generation: 1, device: deviceId(0x1000 + i), segment: 1 }));
    const reader = new Reader(fs, B, root);
    expect(ids(await reader.pass())).not.toContain('late');
    expect(reader.events.some((e) => e.kind === 'unfinished')).toBe(true);
    expect(ids(await reader.pass())).toContain('late');
    // Once looked through, a pass looks into nothing more.
    reader.events.length = 0;
    await reader.pass();
    expect(reader.events.some((e) => e.kind === 'unfinished' || e.kind === 'cluttered')).toBe(false);
  });

  it('past what sync remembers, it says so and goes on looking, a budget a pass; the computers it knows are read on', async () => {
    const { fs, reader, append } = await twoComputers();
    await reader.pass();
    for (let i = 0; i < MAX_JUNK + 100; i++) fs.plant(`1/${deviceId(0x1000 + i)}/${segmentName(1)}`, junkHeader({ generation: 1, device: deviceId(0x1000 + i), segment: 1 }));
    for (let pass = 0; pass < 6; pass++) await reader.pass();
    expect(reader.events.some((e) => e.kind === 'cluttered')).toBe(true);
    expect(reader.memory.junk.size).toBeLessThanOrEqual(MAX_JUNK);
    await append([chord('still', 'Still', 9)]);
    expect(ids(await reader.pass())).toEqual(['still']);
    // A computer that joins later, sorting after all the junk, is found: looking goes on, a budget a pass.
    const later = 'ffffffffffffff02';
    await snapshot(fs, { generation: 1, device: later }, [chord('late', 'Late', 1, later)], reader.root);
    let found = false;
    for (let pass = 0; pass < 10 && !found; pass++) found = ids(await reader.pass()).includes('late');
    expect(found).toBe(true);
  }, 120_000);
});

describe('copies appending at the same time', () => {
  it('both append to one segment, and the sync app keeps the longer: the other finds its segment isn’t as it left it, writing or not', async () => {
    const { fs, root, own } = await twoComputers();
    const shared = own();
    // B appends offline to its copy of the folder; A appends more to the shared one; the sync app keeps A's, the longer.
    const offline = new MemoryFolder();
    for (const [path, file] of fs.files) offline.files.set(path, { ...file, bytes: new Uint8Array(file.bytes) });
    const b = await appendRecords(offline, shared, [chord('b1', 'B1', 3)], root, { app: '0.5.0', device: [] }, nodeCrypto);
    const a = await appendRecords(fs, shared, [chord('a1', 'A1', 4), chord('a2', 'A'.repeat(200), 5)], root, { app: '0.5.0', device: [] }, nodeCrypto);
    if (!a.ok || !b.ok) throw new Error('append failed');
    expect(a.own.size).toBeGreaterThan(b.own.size);
    // B, not writing: its pass finds out.
    expect(await ownIntact(fs, b.own, nodeCrypto)).toBe('other');
    // B, writing: another writer, a new id; its snapshot under it carries b1.
    expect(await appendRecords(fs, b.own, [chord('b2', 'B2', 6)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
    // And of the same length but other bytes: still not its.
    const same = await twoComputers();
    const one = await appendRecords(same.fs, same.own(), [chord('x', 'X', 3)], same.root, { app: '0.5.0', device: [] }, nodeCrypto);
    const elsewhere = new MemoryFolder();
    for (const [path, file] of same.fs.files) elsewhere.files.set(path, { ...file, bytes: new Uint8Array(file.bytes) });
    if (!one.ok) throw new Error('append failed');
    const path = `1/${A}/${segmentName(1)}`;
    const bytes = new Uint8Array(same.fs.files.get(path)!.bytes);
    bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0xff;
    same.fs.plant(path, bytes);
    expect(await ownIntact(same.fs, one.own, nodeCrypto)).toBe('other');
    expect(await ownIntact(elsewhere, one.own, nodeCrypto)).toBe('ok');
  });
});

describe('6,000 junk names in one folder', () => {
  it('a computer this one reads: its folder more than a pass looks through, it’s named as slow; its next snapshot, numbered past the junk, is read at once', async () => {
    const { fs, root, reader, own } = await twoComputers();
    await reader.pass();
    for (let n = 2; n < 6002; n++) fs.plant(`1/${A}/${segmentName(n)}`, junkHeader({ generation: 1, device: A, segment: n }));
    await reader.pass();
    expect(reader.events.some((e) => e.kind === 'blocked' && e.device === A)).toBe(true);
    const next = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('after', 'After', 9)], root, { own: own() });
    expect(next.segment).toBe(6002);
    expect(ids(await reader.pass())).toContain('after');
    // And what it appends to that snapshot, and its next segment by name, come at once too, however much junk is still unlooked at.
    expect(await appendRecords(fs, next, [chord('more', 'More', 10)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toMatchObject({ ok: true });
    expect(ids(await reader.pass())).toContain('more');
  }, 120_000);

  it('a computer this one reads, junk at the numbers past it: its next segment, by name, first', async () => {
    const { fs, root, reader, own } = await twoComputers();
    await reader.pass();
    for (let n = 1000; n < 7000; n++) fs.plant(`1/${A}/${segmentName(n)}`, junkHeader({ generation: 1, device: A, segment: n }));
    const next = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1), chord('a', 'A', 2)], root, { own: own() });
    expect(next.segment).toBe(2);
    expect(ids(await reader.pass())).toContain('a');
  }, 120_000);

  it('a folder of junk doesn’t keep the pass from computers after it: each folder within its own budget, then the next', async () => {
    const { fs, root } = await twoComputers();
    const junky = '00000000000000ab';
    for (let n = 1; n <= 6000; n++) fs.plant(`1/${junky}/${segmentName(n)}`, junkHeader({ generation: 1, device: junky, segment: n }));
    const later = 'ffffffffffffff03';
    await snapshot(fs, { generation: 1, device: later }, [chord('late', 'Late', 1, later)], root);
    const reader = new Reader(fs, B, root);
    expect(ids(await reader.pass())).toEqual(expect.arrayContaining(['work', 'late']));
  }, 120_000);
});

describe('a write of this computer’s own that failed after its bytes landed', () => {
  /** Appends that land, then fail as `fail` says: the flush or the close throwing (`after`), or a short write on a full disk (`short`). */
  class Flaky extends MemoryFolder {
    fail: 'after' | 'short' | null = null;
    override async append(path: string, bytes: Uint8Array): Promise<void> {
      const fail = this.fail;
      this.fail = null;
      if (fail === 'short') {
        await super.append(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw new Error('Only some of the bytes were written');
      }
      await super.append(path, bytes);
      if (fail === 'after') throw new Error('EIO: fsync failed');
    }
  }
  async function computer() {
    const fs = new Flaky();
    const set = await setUp(fs, 1, PASS, A, nodeCrypto, FAST);
    if (!set.ok) throw new Error('setup failed');
    const own = await snapshot(fs, { generation: 1, device: A }, [chord('work', 'Work', 1)], set.root);
    return { fs, root: set.root, own };
  }
  /** One write as the worker makes it: what it's appending kept (`onAppend`), and the write's error caught. */
  async function write(fs: SyncFs, own: OwnSegment, records: DataRecord[], root: Uint8Array) {
    let appending: Appending | null = null;
    try {
      const result = await appendRecords(fs, own, records, root, { app: '0.5.0', device: [], onAppend: (a) => void (appending = a) }, nodeCrypto);
      return { result, appending: appending as Appending | null, error: null };
    } catch (error) {
      return { result: null, appending: appending as Appending | null, error };
    }
  }

  it('the flush or the close throws after the bytes landed: the next write takes them as its own (the same id), and readers read everything once', async () => {
    const { fs, root, own } = await computer();
    fs.fail = 'after';
    const first = await write(fs, own, [chord('a', 'A', 2)], root);
    expect(first.error).toBeTruthy();
    // Without what it was writing, its segment looks like another writer's.
    expect(await ownIntact(fs, own, nodeCrypto)).toBe('other');
    const settled = await settleAppend(fs, own, first.appending, nodeCrypto);
    expect(settled.settled).toBe('landed');
    expect(await ownIntact(fs, settled.own, nodeCrypto)).toBe('ok');
    const second = await write(fs, settled.own, [chord('b', 'B', 3)], root);
    expect(second.result).toMatchObject({ ok: true });
    const reader = new Reader(fs, B, root);
    expect(ids(await reader.pass())).toEqual([A, 'work', 'a', 'b']);
  });

  it('the worker let go mid-flush: what it was writing, as chord-data keeps it (its length and hash, never its bytes), settles it in the next worker the same way', async () => {
    const { fs, root, own } = await computer();
    fs.fail = 'after';
    const first = await write(fs, own, [chord('a', 'A', 2)], root);
    const { bytes: _bytes, ...kept } = first.appending!;
    const handed = JSON.parse(JSON.stringify(kept)) as Appending;
    expect(handed).not.toHaveProperty('bytes');
    expect(handed.length).toBe(first.appending!.bytes!.length);
    const settled = await settleAppend(fs, own, handed, nodeCrypto);
    expect(settled).toEqual({ own: first.appending!.expect, settled: 'landed' });
    // Without the bytes, only all of them settle: a part isn't taken as its own.
    const cut = await computer();
    cut.fs.fail = 'short';
    const partial = await write(cut.fs, cut.own, [chord('a', 'A', 2)], cut.root);
    const { bytes: _partBytes, ...markOnly } = partial.appending!;
    expect((await settleAppend(cut.fs, cut.own, markOnly, nodeCrypto)).settled).toBeNull();
    // Chord quit on a full disk before cutting it back: the next worker reads the bytes back from chord-data's own file
    // (written once per write), and cuts back what's exactly their first part, keeping its id.
    const fromFile = new Uint8Array(partial.appending!.bytes!);
    expect(await settleAppend(cut.fs, cut.own, { ...markOnly, bytes: fromFile }, nodeCrypto)).toEqual({ own: cut.own, settled: 'cut' });
    expect(await ownIntact(cut.fs, cut.own, nodeCrypto)).toBe('ok');
  });

  it('a compaction stopped between its snapshot’s rename and its answer: the snapshot is this computer’s own (its size, ending with its last frame)', async () => {
    const { fs, root, own } = await computer();
    let marker: Appending | null = null;
    const next = await writeSnapshot(fs, { generation: 1, device: A }, [[chord('work', 'Work', 1), chord('b', 'B', 3)]], root, { app: '0.5.0', device: [], covers: coversOf(own), after: own.segment, onRename: (a) => void (marker = a) }, nodeCrypto);
    const kept = JSON.parse(JSON.stringify(marker)) as Appending;
    expect(kept.hash).toBeNull();
    // As if the answer never came: the old segment is gone (it covered it), and the new one is its own, not another writer's.
    const settled = await settleAppend(fs, own, kept, nodeCrypto);
    expect(settled.settled).toBe('landed');
    expect(settled.own).toMatchObject({ segment: next.segment, size: next.size, frames: next.frames, tail: next.tail });
    expect(await appendRecords(fs, settled.own, [chord('c', 'C', 4)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toMatchObject({ ok: true });
  });

  it('a short write on a full disk: its part is cut back, and the write goes again whole; readers never see the part', async () => {
    const { fs, root, own } = await computer();
    fs.fail = 'short';
    const first = await write(fs, own, [chord('a', 'A', 2)], root);
    expect(first.error).toBeTruthy();
    const path = `1/${A}/${segmentName(own.segment)}`;
    expect((await fs.stat(path))!.size).toBeGreaterThan(own.size);
    const settled = await settleAppend(fs, own, first.appending, nodeCrypto);
    expect(settled).toEqual({ own, settled: 'cut' });
    expect((await fs.stat(path))!.size).toBe(own.size);
    const second = await write(fs, own, [chord('a', 'A', 2)], root);
    expect(second.result).toMatchObject({ ok: true });
    expect(ids(await new Reader(fs, B, root).pass())).toEqual([A, 'work', 'a']);
  });

  it('a new segment renamed into place before the write failed: its own, not another writer’s', async () => {
    const { fs, root } = await computer();
    // Its segment full: the next write starts a new one.
    const filler = Array.from({ length: 4 }, (_, i): DataRecord => ({ type: 'widget', id: `w${i}`, at: [1_800_000_000_000, 0, A], set: { blob: Buffer.from(nodeCrypto.random(300_000)).toString('base64') } }));
    const full = await writeSegment(fs, { generation: 1, device: A, segment: 2 }, filler, root, { snapshot: false, app: '0.5.0', device: [] }, nodeCrypto);
    let appending: Appending | null = null;
    const result = await appendRecords(fs, full, [chord('a', 'A', 2)], root, { app: '0.5.0', device: [], onAppend: (a) => void (appending = a) }, nodeCrypto);
    expect(result).toMatchObject({ ok: true, own: { segment: 3 } });
    // As if the answer never came: the next write, from the old segment, settles it first.
    const settled = await settleAppend(fs, full, appending, nodeCrypto);
    expect(settled.settled).toBe('landed');
    expect(settled.own).toMatchObject({ segment: 3 });
  });

  it('bytes that aren’t the ones it wrote, or more than it wrote, are another writer’s still', async () => {
    const { fs, root, own } = await computer();
    fs.fail = 'after';
    const first = await write(fs, own, [chord('a', 'A', 2)], root);
    const path = `1/${A}/${segmentName(own.segment)}`;
    await fs.append(path, Uint8Array.from([1, 2, 3]));
    expect((await settleAppend(fs, own, first.appending, nodeCrypto)).settled).toBeNull();
    const other = await computer();
    other.fs.fail = 'after';
    const mine = await write(other.fs, other.own, [chord('a', 'A', 2)], other.root);
    const bytes = new Uint8Array(other.fs.files.get(path)!.bytes);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    other.fs.plant(path, bytes);
    expect((await settleAppend(other.fs, other.own, mine.appending, nodeCrypto)).settled).toBeNull();
    expect(await appendRecords(other.fs, other.own, [chord('b', 'B', 3)], other.root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
  });
});

describe('temp files a stopped write left', () => {
  it('this computer’s own, older than a minute, go; fresh ones, other names, and other computers’ stay', async () => {
    const fs = new MemoryFolder();
    const now = 10 * STALE_TEMP_MS;
    const old = (path: string) => fs.files.set(path, { bytes: Uint8Array.from([1]), mtime: 1 });
    const fresh = (path: string) => fs.files.set(path, { bytes: Uint8Array.from([1]), mtime: now - 1_000 });
    old(`1/${A}/000002.chordlog.part-0123abcd`);
    old(`1/${A}/000002.chordlog.part-0123abcd.tmp-89abcdef`);
    old(`1/${A}/000003.chordlog.tmp-89abcdef`);
    fresh(`1/${A}/000004.chordlog.part-00112233`);
    old(`1/${A}/000001.chordlog`);
    old(`1/${A}/000005.chordlog.part-xyz`);
    old(`1/${A}/notes.txt.tmp-89abcdef`);
    old(`1/${B}/000002.chordlog.part-0123abcd`);
    expect(await removeStaleTemps(fs, { generation: 1, device: A }, now)).toBe(3);
    expect([...fs.files.keys()].sort()).toEqual(
      [`1/${A}/000001.chordlog`, `1/${A}/000004.chordlog.part-00112233`, `1/${A}/000005.chordlog.part-xyz`, `1/${A}/notes.txt.tmp-89abcdef`, `1/${B}/000002.chordlog.part-0123abcd`].sort(),
    );
  });
});
