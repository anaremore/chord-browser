/**
 * Sync end to end on one computer, without a folder: main's SyncService and
 * chord-data's SyncController wired together over a real chord.db, a
 * stand-in worker saying what it read, and the store's reducer applying what
 * main is pushed (its writes marked as sync's, as persistence marks them).
 * Reconciling is a diff of what chord.db has against the merged copy (S15
 * §13): what arrives before what it depends on (a tab before its chord or its
 * folder, a folder moved into a loop, a Favorite past the row's room) lands
 * once that comes; a write chord-data refused lands at the next launch; and
 * what this computer always keeps otherwise is pushed again only to apply as
 * nothing.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, MAX_FAVORITES, restoreState, seedState, type Command, type DataRecord, type SegmentCursor, type State } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import { opKey, opOrigin, opsForState, opsFromPatches, originOf, type DataPush, type WriteOp } from '@chord/data';
import { SyncController, type WorkerLike } from '../../src/data/sync';
import type { FromWorker, ToWorker } from '../../src/data/sync-worker';

vi.mock('electron', () => ({
  dialog: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async () => ({ result: Buffer.alloc(32, 7).toString('base64'), shouldReEncrypt: false }),
  },
}));
const { SyncService } = await import('../../src/main/sync');

class FakeWorker extends EventEmitter {
  readonly posted: ToWorker[] = [];
  postMessage(message: ToWorker): void {
    this.posted.push(message);
  }
  unref(): this {
    return this;
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  say(message: FromWorker): void {
    this.emit('message', message);
  }
}

const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const SEED = { now: 1000, theme: THEME, homeUrl: 'https://home.test/' };
const INFO = { name: 'Desk', os: 'Linux', app: '0.5.0' };
const A = '000000000000000a';
const B = '000000000000000b';
let n = 0;
const ctx = { now: 5000, newId: () => `id-${++n}` };
let clock = Date.now() + 1000;
/** A stamp from another computer, later than anything this one has written, and later than the one before. */
const at = (device: string): DataRecord['at'] => [(clock = Math.max(clock + 1, Date.now() + 1000)), 0, device];

let dir: string;
let db: ChordDatabase;
let state: State;
/** chord-data refuses main's next writes (a full disk), as many as this says. */
let refuse = 0;
let writes = 0;
/** Writes main has made and persistence hasn't sent yet (`hold`), coalesced by entity as persistence does; `release` sends them. */
let held: Map<string, WriteOp> | null = null;
let release: () => void = () => undefined;
let running: { controller: SyncController; worker: FakeWorker; pushes: DataPush[] } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-roundtrip-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
  state = seedState({ ...SEED, newId: ctx.newId });
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: dir, generation: 1, name: 'Desk', own: { generation: 1, device: db.device(), segment: 1, size: 100, frames: 1 } });
  db.atomically(() => db.sync.addLocal('all'));
  refuse = 0;
  writes = 0;
  held = null;
});
afterEach(() => {
  running?.controller.close();
  running = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Chord launched: chord-data's side and main's, wired; what's merged but not applied is asked for, as after any
 * launch. \`fromDisk\`: main's state read back from chord.db, as a relaunch reads it.
 */
async function launch({ fromDisk = false } = {}): Promise<{ controller: SyncController; worker: FakeWorker; pushes: DataPush[] }> {
  running?.controller.close();
  if (fromDisk) state = restoreState(db.load(), { ...SEED, newId: ctx.newId });
  const worker = new FakeWorker();
  const pushes: DataPush[] = [];
  let listener: (push: DataPush) => void = () => undefined;
  const controller = new SyncController(
    () => db,
    (push) => {
      pushes.push(push);
      listener(push);
    },
    () => worker as unknown as WorkerLike,
  );
  const service = new SyncService({
    data: { sync: (request) => controller.handle(request), flush: async () => undefined, unsaved: () => 0, waiting: () => false, onPush: (l) => (listener = l) },
    state: () => state,
    // The store: the reducer, then what changed written by chord-data (marked as sync's when it came from sync, as
    // persistence does), or refused, as chord-data refuses a batch on a full disk.
    dispatch: (command: Command) => {
      const before = state;
      const result = apply(state, command, ctx);
      state = result.state;
      const origin = originOf(command);
      const ops = opsFromPatches(result.patches, result.state, before).map((op): WriteOp => (origin === 'user' ? op : { ...op, origin }));
      if (ops.length === 0) return;
      if (held) {
        // Persistence's queue: a change of yours to an entity takes the place of sync's waiting one; theirs after yours waits behind it.
        for (const op of ops) {
          if (opOrigin(op) === 'user') {
            held.delete(`${opKey(op)}#auto`);
            held.set(opKey(op), op);
          } else held.set(`${opKey(op)}#auto`, op);
        }
        return;
      }
      if (refuse > 0) {
        refuse--;
        controller.writeRefused();
        return;
      }
      db.write(ops);
      writes++;
      controller.afterWrite();
    },
    effects: { syncSites: async () => undefined },
    toast: () => undefined,
    lastWindow: () => null,
    notify: () => undefined,
    info: () => INFO,
    platform: 'linux',
    folder: () => dir,
  });
  release = () => {
    const ops = [...(held?.values() ?? [])];
    held = null;
    if (ops.length === 0) return;
    db.write(ops);
    writes++;
    controller.afterWrite();
  };
  if (db.sync.meta.on) await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
  await service.afterLaunch();
  running = { controller, worker, pushes };
  return running;
}

const cursor = (offset: number): SegmentCursor => ({ head: 'h', offset, frame: 2, snapshot: true });
let batch = 0;
/** One pass of the stand-in worker: a step of \`device\`'s records, merged and answered, then the pass's end. */
async function read(worker: FakeWorker, device: string, records: DataRecord[]): Promise<void> {
  const id = ++batch;
  worker.say({ t: 'busy', op: 'pass' });
  worker.say({ t: 'records', id, device, segment: 1, records, cursor: cursor(100 + id), refused: 0 });
  await vi.waitFor(() => expect(worker.posted.some((m) => m.t === 'ack' && m.id === id)).toBe(true));
  worker.say({ t: 'pass-done', look: { state: 'ok' }, seen: {}, wrote: {}, tooMany: false, cluttered: false, unfinished: false, blocked: [] });
  worker.say({ t: 'idle' });
}
/** Long enough for what's pushed to be applied, and for a reconcile a write made due to run. */
const quiet = (ms = 2_800) => new Promise((resolve) => setTimeout(resolve, ms));

const chordRecord = (id: string, name: string, extra: Record<string, unknown> = {}): DataRecord => ({
  type: 'chord',
  id,
  at: at(A),
  set: { name, icon: 'W', theme: THEME, rank: 'z0', profile: 'default', created: 1, deleted: false, ...extra },
});
const folderRecord = (id: string, chord: string, parent: string | null = null, device = A): DataRecord => ({
  type: 'folder',
  id,
  at: at(device),
  set: { pos: { chord, section: 'pinned', parent, rank: 'b0' }, title: `Folder ${id}`, collapsed: false, created: 1, deleted: false },
});
const moveRecord = (type: 'folder' | 'tab', id: string, chord: string, parent: string | null, device: string): DataRecord => ({ type, id, at: at(device), set: { pos: { chord, section: 'pinned', parent, rank: 'b1' } } });
const tabRecord = (id: string, chord: string, parent: string | null): DataRecord => ({
  type: 'tab',
  id,
  at: at(B),
  set: { pos: { chord, section: 'pinned', parent, rank: 'c0' }, pinnedUrl: 'https://mail.test/', title: 'Mail', customTitle: null, muted: false, created: 1, deleted: false },
});
const favoriteRecord = (i: number, device = A): DataRecord => ({ type: 'favorite', id: `fav-${i}`, at: at(device), set: { url: `https://fav${i}.test/`, title: `Favorite ${i}`, rank: `a${String(i).padStart(3, '0')}`, created: 1, deleted: false } });
const applies = (pushes: DataPush[]) => pushes.filter((p) => p.push === 'sync.apply');
const home = () => Object.keys(state.chords)[0]!;

describe('what arrives before what it depends on', { timeout: 20_000 }, () => {
  it('a tab another computer pinned into a chord made on a third, read before that chord: it waits; once the chord comes, it’s in it; relaunched twice, nothing is pushed again', async () => {
    const first = await launch();
    await read(first.worker, B, [tabRecord('tab-b', 'chord-a', null)]);
    await quiet(200);
    expect(state.nodes['tab-b']).toBeUndefined();
    await read(first.worker, A, [chordRecord('chord-a', 'Work')]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ chordId: 'chord-a', section: 'pinned' }), { timeout: 6_000 });
    for (let i = 0; i < 2; i++) {
      const again = await launch();
      await quiet(300);
      expect(applies(again.pushes)).toEqual([]);
    }
  });

  it('a tab read before the folder it’s in: at the top meanwhile; once the folder comes, in it', async () => {
    const first = await launch();
    await read(first.worker, B, [tabRecord('tab-b', home(), 'folder-a')]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ chordId: home(), parentId: null }));
    await read(first.worker, A, [folderRecord('folder-a', home())]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ parentId: 'folder-a' }), { timeout: 6_000 });
  });

  it('a tab waiting on a folder that’s in another chord, until that folder moves into its own: then it’s in it', async () => {
    const first = await launch();
    await read(first.worker, A, [chordRecord('chord-d', 'Elsewhere'), folderRecord('folder-f', 'chord-d')]);
    await vi.waitFor(() => expect(state.nodes['folder-f']).toMatchObject({ chordId: 'chord-d' }));
    await read(first.worker, B, [tabRecord('tab-b', home(), 'folder-f')]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ chordId: home(), parentId: null }));
    await read(first.worker, A, [moveRecord('folder', 'folder-f', home(), null, A)]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ parentId: 'folder-f' }), { timeout: 6_000 });
  });

  it('a loop: X moves B out of A, Y moves A into B, and Y’s comes first; once X’s comes, A is in B', async () => {
    const first = await launch();
    // A, with B in it.
    await read(first.worker, A, [folderRecord('fa', home()), folderRecord('fb', home(), 'fa')]);
    await vi.waitFor(() => expect(state.nodes['fb']).toMatchObject({ parentId: 'fa' }));
    // Y moves A into B: with B still in A, a loop, so A stays at the top for now.
    await read(first.worker, B, [moveRecord('folder', 'fa', home(), 'fb', B)]);
    await quiet(300);
    expect(state.nodes['fa']).toMatchObject({ parentId: null });
    // X moves B out of A (read after Y's): no loop now, and A goes into B.
    await read(first.worker, A, [moveRecord('folder', 'fb', home(), null, A)]);
    await vi.waitFor(() => expect(state.nodes['fa']).toMatchObject({ parentId: 'fb' }), { timeout: 6_000 });
    expect(state.nodes['fb']).toMatchObject({ parentId: null });
  });

  it('a tab in a chord deleted here: it waits; Undo brings the chord back, and the tab lands in it', async () => {
    const first = await launch();
    await read(first.worker, A, [chordRecord('chord-k', 'Kept')]);
    await vi.waitFor(() => expect(state.chords['chord-k']).toBeDefined());
    first.worker.posted.length = 0;
    const windowId = Object.keys(state.windows)[0]!;
    // Deleted here; meanwhile another computer pins a tab into it.
    const dispatchHere = (command: Command) => {
      const result = apply(state, command, ctx);
      state = result.state;
      db.write(opsFromPatches(result.patches, result.state));
      first.controller.afterWrite();
    };
    dispatchHere({ t: 'chord.delete', chordId: 'chord-k' });
    expect(state.chords['chord-k']).toBeUndefined();
    await read(first.worker, B, [tabRecord('tab-k', 'chord-k', null)]);
    await quiet(300);
    expect(state.nodes['tab-k']).toBeUndefined();
    dispatchHere({ t: 'chord.restore', windowId, chordId: 'chord-k' });
    await vi.waitFor(() => expect(state.nodes['tab-k']).toMatchObject({ chordId: 'chord-k' }), { timeout: 6_000 });
  });

  it('a Favorite past the row’s room (48): not here; once one goes, it’s offered again and lands', async () => {
    const first = await launch();
    await read(first.worker, A, Array.from({ length: MAX_FAVORITES }, (_, i) => favoriteRecord(i)));
    await vi.waitFor(() => expect(Object.keys(state.favorites)).toHaveLength(MAX_FAVORITES), { timeout: 6_000 });
    await read(first.worker, B, [favoriteRecord(99, B)]);
    await quiet(300);
    expect(state.favorites['fav-99']).toBeUndefined();
    const result = apply(state, { t: 'favorite.remove', favoriteId: 'fav-0' }, ctx);
    state = result.state;
    db.write(opsFromPatches(result.patches, result.state));
    first.controller.afterWrite();
    await vi.waitFor(() => expect(state.favorites['fav-99']).toBeDefined(), { timeout: 6_000 });
  });
});

describe('a Favorite refused as a twin', { timeout: 20_000 }, () => {
  it('another computer’s Favorite at an address one here has: not here; once that one’s address changes, it lands, and no idle look had skipped it', async () => {
    const first = await launch();
    const atUrl = (id: string, url: string, device: string): DataRecord => ({ type: 'favorite', id, at: at(device), set: { url, title: id, rank: `r-${id}`, created: 1, deleted: false } });
    await read(first.worker, A, [atUrl('fav-x', 'https://same.test/', A)]);
    await vi.waitFor(() => expect(state.favorites['fav-x']).toBeDefined());
    await read(first.worker, B, [atUrl('fav-y', 'https://same.test/', B)]);
    await quiet(300);
    expect(state.favorites['fav-y']).toBeUndefined();
    // An idle look meanwhile: pushed once more, and applies as nothing.
    await first.controller.reconcile({ idle: true });
    await quiet(300);
    expect(state.favorites['fav-y']).toBeUndefined();
    // The one here moves to another address (another computer's change, applied): the address is free.
    await read(first.worker, A, [{ type: 'favorite', id: 'fav-x', at: at(A), set: { url: 'https://moved.test/' } }]);
    await vi.waitFor(() => expect(state.favorites['fav-y']).toMatchObject({ url: 'https://same.test/' }), { timeout: 6_000 });
  });
});

describe('a write chord-data refused', { timeout: 20_000 }, () => {
  it('a chord renamed elsewhere, its write refused (a full disk): on screen meanwhile, not in chord.db; the next launch reads it back, finds it different, and it lands', async () => {
    const first = await launch();
    refuse = 1;
    await read(first.worker, A, [{ type: 'chord', id: home(), at: at(A), set: { name: 'Renamed elsewhere' } }]);
    await vi.waitFor(() => expect(state.chords[home()]).toMatchObject({ name: 'Renamed elsewhere' }));
    expect(db.load()!.chords.find((c) => c.id === home())!.name).not.toBe('Renamed elsewhere');
    await launch({ fromDisk: true });
    await vi.waitFor(() => expect(db.load()!.chords.find((c) => c.id === home())!.name).toBe('Renamed elsewhere'), { timeout: 6_000 });
    expect(state.chords[home()]).toMatchObject({ name: 'Renamed elsewhere' });
  });
});

describe('a deletion made before its apply is written', { timeout: 20_000 }, () => {
  it('another computer’s Favorite, applied, and removed here before the apply was written (the write that lands is the deletion): stamped gone, sent, and it doesn’t come back', async () => {
    const first = await launch();
    held = new Map();
    await read(first.worker, A, [favoriteRecord(1)]);
    await vi.waitFor(() => expect(state.favorites['fav-1']).toBeDefined());
    const result = apply(state, { t: 'favorite.remove', favoriteId: 'fav-1' }, ctx);
    state = result.state;
    for (const op of opsFromPatches(result.patches, result.state)) {
      // As persistence's queue has it: yours takes the place of sync's waiting write.
      held!.delete(`${opKey(op)}#auto`);
      held!.set(opKey(op), op);
    }
    expect([...held!.values()]).toEqual([{ k: 'favorite', id: 'fav-1', value: null }]);
    release();
    expect(db.sync.outbox().records.some((r) => r.type === 'favorite' && r.id === 'fav-1' && r.set['deleted'] === true)).toBe(true);
    const pushed = applies(first.pushes).length;
    await first.controller.reconcile();
    await quiet(500);
    expect(state.favorites['fav-1']).toBeUndefined();
    expect(applies(first.pushes).slice(pushed).some((p) => p.push === 'sync.apply' && p.apply.favorites.some((f) => f.id === 'fav-1'))).toBe(false);
  });
});

describe('turned off while chord-data refuses writes', { timeout: 20_000 }, () => {
  it('the merged copy is kept: the next launch puts back what chord.db lacks of it, and once it lacks nothing, the copy goes', async () => {
    const first = await launch();
    refuse = 1;
    await read(first.worker, A, [{ type: 'chord', id: home(), at: at(A), set: { name: 'Renamed elsewhere' } }]);
    await vi.waitFor(() => expect(state.chords[home()]).toMatchObject({ name: 'Renamed elsewhere' }));
    await first.controller.handle({ type: 'sync.off', keep: true });
    expect(db.load()!.chords.find((c) => c.id === home())!.name).not.toBe('Renamed elsewhere');
    expect(db.sync.meta).toMatchObject({ on: false, kept: true });
    expect(db.sync.snapshot().some((r) => r.type === 'chord' && r.set['name'] === 'Renamed elsewhere')).toBe(true);
    // Relaunched, with room again: main reads chord.db, without the rename. The kept copy puts it back, then goes.
    await launch({ fromDisk: true });
    await vi.waitFor(() => expect(db.load()!.chords.find((c) => c.id === home())!.name).toBe('Renamed elsewhere'), { timeout: 6_000 });
    await vi.waitFor(() => expect(db.sync.meta.kept).toBe(false), { timeout: 8_000 });
    expect(db.sync.snapshot()).toEqual([]);
    expect(db.sync.meta.on).toBe(false);
  });
});

describe('reconciling stays cheap', { timeout: 20_000 }, () => {
  it('a push of 200 folders, applied a part at a time, reconciles once after it, not once a part', async () => {
    const first = await launch();
    await quiet(300);
    const looks = vi.spyOn(db.sync, 'unappliedPages');
    await read(
      first.worker,
      A,
      Array.from({ length: 200 }, (_, i) => folderRecord(`folder-${i}`, home())),
    );
    await vi.waitFor(() => expect(Object.values(state.nodes).filter((n) => n.kind === 'folder')).toHaveLength(200), { timeout: 6_000 });
    await quiet();
    expect(looks).toHaveBeenCalledTimes(1);
  });

  it('kept otherwise for good (colors this Chord tidies): pushed again at each launch, and applied as nothing, with nothing written', async () => {
    const first = await launch();
    await read(first.worker, A, [{ type: 'chord', id: home(), at: at(A), set: { theme: { stops: [{ l: 0.5, c: 0.1, h: 30 }], grain: 0.1, appearance: 'dark', sparkle: true } } }]);
    await vi.waitFor(() => expect(state.chords[home()]!.theme).toMatchObject({ appearance: 'dark' }));
    await quiet(300);
    for (let i = 0; i < 2; i++) {
      const before = { chords: state.chords, writes };
      const again = await launch({ fromDisk: true });
      await quiet(400);
      expect(JSON.stringify(applies(again.pushes))).toContain(home());
      expect(state.chords[home()]!.theme).toEqual(before.chords[home()]!.theme);
      expect(writes).toBe(before.writes);
    }
  });
});
