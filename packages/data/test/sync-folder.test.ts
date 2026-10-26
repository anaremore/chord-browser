/**
 * Sync's folder protocol (S15 §6, §9 step 3) against an in-memory folder, with
 * Node's crypto: two computers setting up and joining, appending and reading
 * as they go; a half-written frame, a frame that doesn't open yet, a shorter
 * file, conflicted copies, compaction in the middle of a read, a copied id, a
 * newer format, a changed passphrase, and what a hostile folder can't do.
 */
import { describe, expect, it } from 'vitest';
import {
  appendRecords,
  generations,
  inspectFolder,
  lookAtFolder,
  nextGeneration,
  readComputers,
  readSegment,
  segmentName,
  segmentsOf,
  setUp,
  unlockNewest,
  writeSegment,
  writeSnapshot,
  writeSyncFile,
  type DataRecord,
  type OwnSegment,
  type ReadEvent,
  type SegmentCursor,
  type SyncFs,
} from '@chord/core';
import { nodeCrypto } from '../src/crypto';

/** scrypt at its smallest, so each test derives keys in a moment; the readers' bounds are tested on their own. */
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const A = '00000000000000aa';
const B = '00000000000000bb';
const PASS = 'correct horse battery staple';

/** A folder in memory, as a sync app would leave it: files, and folders made as they're written into. */
class MemoryFolder implements SyncFs {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
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
    return any || this.dirs.has(path) ? [...names] : null;
  }
  readonly dirs = new Set<string>();
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
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async remove(path: string): Promise<void> {
    for (const file of [...this.files.keys()]) if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
  }
  /** A file as a sync app might deliver it: cut to its first `n` bytes. */
  cut(path: string, n: number): void {
    const file = this.files.get(path)!;
    this.files.set(path, { bytes: file.bytes.slice(0, n), mtime: this.clock++ });
  }
}

const chord = (id: string, name: string, ms: number, device = A): DataRecord => ({ type: 'chord', id, at: [1_800_000_000_000 + ms, 0, device], set: { name } });
const device = (id: string, name: string): DataRecord => ({ type: 'device', id, at: [1_800_000_000_000, 0, id], set: { name, os: 'linux', app: '0.5.0' } });

/** Everything B reads of the others, merged naively (the merge itself is core's, tested there), with its cursors kept. */
class Reader {
  readonly cursors = new Map<string, SegmentCursor>();
  readonly records: DataRecord[] = [];
  readonly events: ReadEvent[] = [];
  constructor(
    private readonly fs: SyncFs,
    private readonly self: string,
    public root: Uint8Array,
    public generation = 1,
  ) {}
  async pass(budget?: number): Promise<DataRecord[]> {
    const got: DataRecord[] = [];
    for await (const event of readComputers(this.fs, { generation: this.generation, self: this.self, root: this.root, cursor: (d, s) => this.cursors.get(`${d}/${s}`) ?? null, ...(budget ? { budget } : {}) }, nodeCrypto)) {
      this.events.push(event);
      if (event.kind !== 'records') continue;
      got.push(...event.records);
      this.cursors.set(`${event.device}/${event.segment}`, event.cursor);
    }
    this.records.push(...got);
    return got;
  }
}

async function twoComputers() {
  const fs = new MemoryFolder();
  const look = await inspectFolder(fs);
  expect(look).toEqual({ state: 'new', generation: 1 });
  const set = await setUp(fs, 1, PASS, A, nodeCrypto, FAST);
  if (!set.ok) throw new Error('setup failed');
  let own: OwnSegment = await writeSnapshot(fs, { generation: 1, device: A }, [device(A, 'Desk'), chord('work', 'Work', 1)], set.root, { app: '0.5.0' }, nodeCrypto);
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

describe('setting up and joining', () => {
  it('the second computer reads the first’s snapshot, then only what it appends', async () => {
    const { reader, append } = await twoComputers();
    expect((await reader.pass()).map((r) => r.id)).toEqual([A, 'work']);
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
    // The sync app has delivered all but the frame's last 10 bytes; then 2 bytes of its length.
    fs.cut(path, whole.length - 10);
    expect(await reader.pass()).toEqual([]);
    const before = fs.files.get(path)!;
    fs.files.set(path, { bytes: whole, mtime: before.mtime + 1 });
    expect((await reader.pass()).map((r) => r.id)).toEqual(['a']);
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
    fs.files.set(path, { bytes: flipped, mtime: 99 });
    expect((await reader.pass()).map((r) => r.id)).toEqual(['a']);
    fs.files.set(path, { bytes: whole, mtime: 100 });
    expect((await reader.pass()).map((r) => r.id)).toEqual(['b']);
  });

  it('a file that got shorter (an older copy delivered) is read again from the start: merging twice changes nothing', async () => {
    const { fs, reader, append } = await twoComputers();
    const path = `1/${A}/${segmentName(1)}`;
    const older = new Uint8Array(fs.files.get(path)!.bytes);
    await append([chord('a', 'A', 2)]);
    await reader.pass();
    fs.files.set(path, { bytes: older, mtime: 50 });
    expect((await reader.pass()).map((r) => r.id)).toEqual([A, 'work']);
  });

  it('reads a big log over several steps, each within its budget', async () => {
    const { reader, append } = await twoComputers();
    for (let i = 0; i < 5; i++) await append(Array.from({ length: 50 }, (_, j) => chord(`c${i}-${j}`, 'x'.repeat(500), i * 100 + j)));
    const got = await reader.pass(50);
    expect(got.length).toBe(2 + 250);
    expect(reader.events.filter((e) => e.kind === 'records').length).toBeGreaterThan(3);
  });
});

describe('what a sync app leaves in the folder', () => {
  it('conflicted copies are passed over, and a conflicted copy of the folder’s file can’t be joined', async () => {
    const { fs, root, reader } = await twoComputers();
    const segment = fs.files.get(`1/${A}/${segmentName(1)}`)!;
    fs.files.set(`1/${A}/000001 (conflicted copy 2026-11-30).chordlog`, segment);
    fs.files.set(`1/${A}/000002.chordlog.tmp`, segment);
    fs.files.set(`1/not-a-device/${segmentName(1)}`, segment);
    expect((await reader.pass()).map((r) => r.id)).toEqual([A, 'work']);
    fs.files.set('sync-1 (conflicted copy).json', fs.files.get('sync-1.json')!);
    expect(await inspectFolder(fs)).toEqual({ state: 'conflict' });
    expect(await generations(fs)).toEqual({ generations: [1], conflicted: true });
    void root;
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
    setOwn(await writeSnapshot(fs, { generation: 1, device: A }, [device(A, 'Desk'), chord('work', 'Work', 1), chord('a', 'A', 2), chord('b', 'B', 3)], root, { app: '0.5.0' }, nodeCrypto));
    expect(await segmentsOf(fs, 1, A)).toEqual([2]);
    expect(own().segment).toBe(2);
    expect((await reader.pass()).map((r) => r.id).sort()).toEqual([A, 'a', 'b', 'work'].sort());
    // Delivered out of order: an old segment shows up again after the snapshot. Only the snapshot and what follows count.
    const stale = await writeSegment(fs, { generation: 1, device: A, segment: 1 }, [chord('old', 'Old', 0)], root, { snapshot: false, app: '0.5.0' }, nodeCrypto);
    void stale;
    const fresh = new Reader(fs, B, reader.root);
    expect((await fresh.pass()).map((r) => r.id)).not.toContain('old');
  });

  it('a copied id: before appending, a computer checks its segment ends where it left it', async () => {
    const { fs, root, own, append } = await twoComputers();
    const copy: OwnSegment = { ...own() };
    await append([chord('a', 'A', 2)]);
    // The other copy of this profile appends with what it remembers: the segment has moved on under it.
    expect(await appendRecords(fs, copy, [chord('b', 'B', 3)], root, { app: '0.5.0', device: [] }, nodeCrypto)).toEqual({ ok: false, problem: 'copied' });
  });

  it('a segment says where it belongs: one copied into another computer’s folder isn’t read', async () => {
    const { fs, reader } = await twoComputers();
    fs.files.set(`1/${B.replace('b', 'c')}/${segmentName(1)}`, fs.files.get(`1/${A}/${segmentName(1)}`)!);
    const got = await reader.pass();
    expect(got.map((r) => r.id)).toEqual([A, 'work']);
  });
});

describe('a newer Chord, and a new passphrase', () => {
  it.each<[string, (fs: MemoryFolder) => void]>([
    [
      'the folder’s file has a newer format',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as Record<string, unknown>;
        fs.files.set('sync-1.json', { bytes: new TextEncoder().encode(JSON.stringify({ ...file, format: 2 })), mtime: 9 });
      },
    ],
    [
      'a key derivation Chord can’t run',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as Record<string, unknown>;
        fs.files.set('sync-1.json', { bytes: new TextEncoder().encode(JSON.stringify({ ...file, kdf: { name: 'argon2id', salt: 'AAAA' } })), mtime: 9 });
      },
    ],
    [
      'scrypt asking for more memory than a reader gives it',
      (fs) => {
        const file = JSON.parse(new TextDecoder().decode(fs.files.get('sync-1.json')!.bytes)) as { kdf: object };
        fs.files.set('sync-1.json', { bytes: new TextEncoder().encode(JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 ** 20, r: 8 } })), mtime: 9 });
      },
    ],
  ])('%s: the folder reads as newer', async (_what, change) => {
    const { fs, root } = await twoComputers();
    change(fs);
    expect(await lookAtFolder(fs, 1, root, nodeCrypto)).toEqual({ state: 'newer' });
    expect(await inspectFolder(fs)).toEqual({ state: 'newer' });
  });

  it('a segment from a newer Chord (format or envelope) stops reading that computer', async () => {
    const { fs, reader } = await twoComputers();
    const path = `1/${A}/${segmentName(1)}`;
    const text = new TextDecoder('latin1').decode(fs.files.get(path)!.bytes);
    fs.files.set(path, { bytes: Uint8Array.from(text.replace('chord-encrypted 1', 'chord-encrypted 2'), (ch) => ch.charCodeAt(0)), mtime: 7 });
    expect(await reader.pass()).toEqual([]);
    expect(reader.events).toContainEqual({ kind: 'newer', device: A });
  });

  it('a new passphrase: a new generation, the others pause until they have it, and the old one opens nothing new', async () => {
    const { fs, reader } = await twoComputers();
    const next = await nextGeneration(fs, 'a brand new passphrase', A, nodeCrypto, FAST);
    expect(next.generation).toBe(2);
    await writeSnapshot(fs, { generation: 2, device: A }, [device(A, 'Desk'), chord('work', 'Work', 1)], next.root, { app: '0.5.0' }, nodeCrypto);
    expect(await lookAtFolder(fs, 1, reader.root, nodeCrypto)).toEqual({ state: 'changed', generation: 2, by: A });
    expect(await unlockNewest(fs, PASS, nodeCrypto)).toEqual({ ok: false, problem: 'wrong' });
    const moved = await unlockNewest(fs, 'a brand new passphrase', nodeCrypto);
    if (!moved.ok) throw new Error('unlock failed');
    const after = new Reader(fs, B, moved.root, 2);
    expect((await after.pass()).map((r) => r.id)).toEqual([A, 'work']);
  });

  it('a frame whose length can’t be one: nothing after it is read, and the read doesn’t move', async () => {
    const { fs, reader, append } = await twoComputers();
    await reader.pass();
    const path = `1/${A}/${segmentName(1)}`;
    await fs.append(path, Uint8Array.from([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]));
    await append([chord('a', 'A', 2)]).catch(() => undefined);
    expect(await reader.pass()).toEqual([]);
    const cursor = reader.cursors.get(`${A}/1`)!;
    const again = await readSegment(fs, { generation: 1, device: A, segment: 1 }, reader.root, cursor, nodeCrypto);
    expect(again.stopped).toBe('damaged');
    expect(again.cursor.offset).toBe(cursor.offset);
  });

  it('the folder’s file is written once, never over another', async () => {
    const fs = new MemoryFolder();
    await writeSyncFile(fs, 1, PASS, A, nodeCrypto, FAST);
    await expect(writeSyncFile(fs, 1, PASS, B, nodeCrypto, FAST)).rejects.toThrow();
  });
});
