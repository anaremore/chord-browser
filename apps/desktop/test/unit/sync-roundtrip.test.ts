/**
 * Sync end to end on one computer, without a folder: main's SyncService and
 * chord-data's SyncController wired together over a real chord.db, a
 * stand-in worker saying what it read, and the store's reducer applying what
 * main is pushed (its writes marked as sync's, as persistence marks them).
 * What another computer changed that arrives before what it depends on (a
 * tab before its chord, a tab before its folder) waits, unconfirmed, and is
 * applied once that comes; then relaunches push nothing more.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, seedState, type Command, type DataRecord, type SegmentCursor, type State } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import { opsForState, opsFromPatches, type DataPush, type WriteOp } from '@chord/data';
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
const INFO = { name: 'Desk', os: 'Linux', app: '0.5.0' };
const A = '000000000000000a';
const B = '000000000000000b';
let n = 0;
const ctx = { now: 5000, newId: () => `id-${++n}` };
let clock = Date.now() + 1000;
const at = (device: string): DataRecord['at'] => [++clock, 0, device];

let dir: string;
let db: ChordDatabase;
let state: State;
let running: { controller: SyncController; worker: FakeWorker; pushes: DataPush[] } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-roundtrip-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
  state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: dir, generation: 1, name: 'Desk', own: { generation: 1, device: db.device(), segment: 1, size: 100, frames: 1 } });
  db.atomically(() => db.sync.addLocal('all'));
});
afterEach(() => {
  running?.controller.close();
  running = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Chord launched: chord-data's side and main's, wired; what's merged but not applied is asked for, as after any launch. */
async function launch(): Promise<{ controller: SyncController; worker: FakeWorker; pushes: DataPush[] }> {
  running?.controller.close();
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
    data: { sync: (request) => controller.handle(request), flush: async () => undefined, failures: () => 0, waiting: () => false, onPush: (l) => (listener = l) },
    state: () => state,
    // The store: the reducer, then what changed written, marked as sync's when it came from sync (as persistence does).
    dispatch: (command: Command) => {
      const result = apply(state, command, ctx);
      db.write(opsFromPatches(result.patches, result.state).map((op): WriteOp => (command.t === 'sync.apply' ? { ...op, sync: true } : op)));
      state = result.state;
    },
    effects: { syncSites: async () => undefined },
    toast: () => undefined,
    lastWindow: () => null,
    notify: () => undefined,
    info: () => INFO,
    platform: 'linux',
    folder: () => dir,
  });
  await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
  await service.afterLaunch();
  running = { controller, worker, pushes };
  return running;
}

const cursor = (offset: number): SegmentCursor => ({ head: 'h', offset, frame: 2, snapshot: true });
let batch = 0;
/** One pass of the stand-in worker: a step of `device`'s records, merged and answered, then the pass's end. */
async function read(worker: FakeWorker, device: string, records: DataRecord[]): Promise<void> {
  const id = ++batch;
  worker.say({ t: 'busy', op: 'pass' });
  worker.say({ t: 'records', id, device, segment: 1, records, cursor: cursor(100 + id), refused: 0 });
  await vi.waitFor(() => expect(worker.posted.some((m) => m.t === 'ack' && m.id === id)).toBe(true));
  worker.say({ t: 'pass-done', look: { state: 'ok' }, seen: {}, wrote: {}, tooMany: false, cluttered: false, unfinished: false, blocked: [] });
  worker.say({ t: 'idle' });
}

const chordRecord = (id: string, name: string): DataRecord => ({ type: 'chord', id, at: at(A), set: { name, icon: 'W', theme: THEME, rank: 'z0', profile: 'default', created: 1, deleted: false } });
const folderRecord = (id: string, chord: string): DataRecord => ({ type: 'folder', id, at: at(A), set: { pos: { chord, section: 'pinned', parent: null, rank: 'b0' }, title: 'Reading', collapsed: false, created: 1, deleted: false } });
const tabRecord = (id: string, chord: string, parent: string | null): DataRecord => ({
  type: 'tab',
  id,
  at: at(B),
  set: { pos: { chord, section: 'pinned', parent, rank: 'c0' }, pinnedUrl: 'https://mail.test/', title: 'Mail', customTitle: null, muted: false, created: 1, deleted: false },
});
const applies = (pushes: DataPush[]) => pushes.filter((p) => p.push === 'sync.apply');

describe('what arrives before what it depends on', () => {
  it('a tab another computer pinned into a chord made on a third, read before that chord: it waits; once the chord comes, it’s in it; relaunched twice, nothing is pushed again', async () => {
    const first = await launch();
    await read(first.worker, B, [tabRecord('tab-b', 'chord-a', null)]);
    await vi.waitFor(() => expect(applies(first.pushes)).toHaveLength(1));
    // Applied, as far as it could be: its chord isn't here.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.nodes['tab-b']).toBeUndefined();
    await read(first.worker, A, [chordRecord('chord-a', 'Work')]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ chordId: 'chord-a', section: 'pinned' }), { timeout: 5_000 });
    expect(state.chords['chord-a']).toMatchObject({ name: 'Work' });
    // Relaunched, and again: nothing more to push.
    for (let i = 0; i < 2; i++) {
      const again = await launch();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(applies(again.pushes)).toEqual([]);
    }
    expect(state.nodes['tab-b']).toMatchObject({ chordId: 'chord-a' });
  });

  it('a tab read before the folder it’s in: at the top meanwhile; once the folder comes, in it; relaunched twice, nothing is pushed again', async () => {
    const first = await launch();
    const home = Object.keys(state.chords)[0]!;
    await read(first.worker, B, [tabRecord('tab-b', home, 'folder-a')]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ chordId: home, parentId: null }));
    await read(first.worker, A, [folderRecord('folder-a', home)]);
    await vi.waitFor(() => expect(state.nodes['tab-b']).toMatchObject({ parentId: 'folder-a' }), { timeout: 5_000 });
    for (let i = 0; i < 2; i++) {
      const again = await launch();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(applies(again.pushes)).toEqual([]);
    }
    expect(state.nodes['tab-b']).toMatchObject({ parentId: 'folder-a' });
  });
});
