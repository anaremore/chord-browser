/**
 * Sync on chord-data's thread (src/data/sync.ts), with a stand-in for its
 * worker: what it does when writing goes wrong. A snapshot under a new id that
 * fails leaves everything as it was, says so, and tries again; nothing waiting
 * is lost. A profile whose key couldn't be read here (a copy of another
 * computer's) takes a new id as soon as it's unlocked, writing or not.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, seedState, thingKey, type DataRecord, type SegmentCursor, type State } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import { opsForState, opsFromPatches, type DataPush, type WriteOp } from '@chord/data';
import { SyncController, type WorkerLike } from '../../src/data/sync';
import type { FromWorker, ToWorker } from '../../src/data/sync-worker';

const workerPath = join(import.meta.dirname, 'fixtures', 'fake-sync-worker.mjs');
const worker = (): WorkerLike => new Worker(workerPath);

/** A stand-in worker on this thread, for reading's tests: what the controller posts is kept, and what it hears, the test says. */
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
  acks(): ToWorker[] {
    return this.posted.filter((m) => m.t === 'ack');
  }
}
const fake = (): { worker: FakeWorker; make: () => WorkerLike } => {
  const w = new FakeWorker();
  return { worker: w, make: () => w as unknown as WorkerLike };
};
const OTHER = '00000000000000ee';
const cursorAt = (offset: number): SegmentCursor => ({ head: 'h', offset, frame: 2, snapshot: true });
const records = (id: number, list: DataRecord[], offset = 100): FromWorker => ({ t: 'records', id, device: OTHER, segment: 1, records: list, cursor: cursorAt(offset), refused: 0 });
const passDone = (extra: Partial<Extract<FromWorker, { t: 'pass-done' }>> = {}): FromWorker => ({ t: 'pass-done', look: { state: 'ok' }, seen: {}, wrote: {}, tooMany: false, cluttered: false, unfinished: false, blocked: [], ...extra });
/** What main was pushed to apply, as text, to look for a name in. */
const applied = (pushes: DataPush[]): string => JSON.stringify(pushes.filter((p) => p.push === 'sync.apply'));
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const INFO = { name: 'Desk', os: 'Linux', app: '0.5.0' };
let n = 0;
const ctx = { now: 5000, newId: () => `id-${++n}` };

let dir: string;
let db: ChordDatabase;
let controller: SyncController | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-controller-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
});
afterEach(() => {
  controller?.close();
  controller = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env['CHORD_FAKE_SYNC'];
});

/** A profile with sync on, its log at segment 1, and a controller whose worker answers as \`plan\` says. */
function on(plan: Record<string, string[]>, makeWorker: () => WorkerLike = worker): { state: State; pushes: DataPush[] } {
  process.env['CHORD_FAKE_SYNC'] = JSON.stringify(plan);
  const state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: dir, generation: 1, name: 'Desk', own: { generation: 1, device: db.device(), segment: 1, size: 100, frames: 1 } });
  db.atomically(() => db.sync.addLocal('all'));
  const pushes: DataPush[] = [];
  controller = new SyncController(() => db, (push) => pushes.push(push), makeWorker);
  return { state, pushes };
}

/** Main applying what it was pushed, and writing it back as what it applied. */
function mainApplies(state: State, apply_: Extract<DataPush, { push: 'sync.apply' }>['apply']): State {
  const result = apply(state, { t: 'sync.apply', ...apply_ }, ctx);
  db.write(opsFromPatches(result.patches, result.state).map((op): WriteOp => ({ ...op, sync: true })));
  return result.state;
}

function rename(state: State, name: string): State {
  const result = apply(state, { t: 'chord.update', chordId: Object.keys(state.chords)[0]!, name }, ctx);
  db.write(opsFromPatches(result.patches, result.state));
  return result.state;
}

describe('writing, when it goes wrong', () => {
  it('a snapshot under a new id that fails (its log gone): nothing changes here, it says so, the change waits, and the next try lands it', async () => {
    const { state } = on({ write: ['gone', 'gone'], snapshot: ['io', 'ok'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Waiting');
    const before = db.device();
    await controller!.handle({ type: 'sync.flush' });
    // The new id's snapshot failed: the old id and its segment stand, the change waits, and Settings says so.
    expect(db.device()).toBe(before);
    expect(db.sync.meta.own).toMatchObject({ device: before, segment: 1 });
    expect(db.sync.outboxSize()).toBe(1);
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unwritable' });
    // The next try (here at once; on its own, later and later): the snapshot lands, the id is the new one, and nothing waits.
    await controller!.handle({ type: 'sync.flush' });
    expect(db.device()).not.toBe(before);
    expect(db.sync.meta.own).toMatchObject({ device: db.device() });
    expect(db.sync.outboxSize()).toBe(0);
    expect(controller!.status().problem).toBeNull();
  });

  it('after a relaunch, writing goes on where it was: nothing was cleared', async () => {
    const { state } = on({ write: ['gone'], snapshot: ['io'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Waiting');
    await controller!.handle({ type: 'sync.flush' });
    controller!.close();
    process.env['CHORD_FAKE_SYNC'] = JSON.stringify({ write: ['ok'] });
    controller = new SyncController(() => db, () => undefined, worker);
    await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    await controller.handle({ type: 'sync.flush' });
    expect(db.sync.outboxSize()).toBe(0);
  });

  it('another computer writing as this one again and again: past three new ids a day, it stops writing and says so', async () => {
    const { state } = on({ write: ['copied', 'copied', 'copied', 'copied'], snapshot: ['ok', 'ok', 'ok', 'ok'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Again');
    await controller!.handle({ type: 'sync.flush' });
    expect(db.sync.meta.newIds).toHaveLength(3);
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'copies' });
    expect(db.sync.outboxSize()).toBeGreaterThan(0);
  });
});

describe('a copy of a profile that never writes', () => {
  it('its key couldn’t be read here: unlocked, it takes a new id at once, and reads the other’s log as another computer’s', async () => {
    on({ snapshot: ['ok'] });
    const before = db.device();
    const reply = await controller!.handle({ type: 'sync.unlock', passphrase: 'correct horse battery staple', info: INFO, rebind: true });
    expect(reply.key).toBeDefined();
    expect(db.device()).not.toBe(before);
    expect(db.sync.meta.rebind).toBe(false);
  });

  it('with changes waiting to be written as it’s unlocked: one new id, not one for the unlock and one for the write', async () => {
    const { state } = on({ snapshot: ['ok', 'ok', 'ok'] });
    db.sync.setMeta({ rebind: true });
    rename(state, 'Waiting');
    expect(db.sync.outboxSize()).toBe(1);
    await controller!.handle({ type: 'sync.unlock', passphrase: 'correct horse battery staple', info: INFO, rebind: true });
    await controller!.handle({ type: 'sync.flush' });
    expect(db.sync.meta.newIds).toHaveLength(1);
    expect(db.sync.outboxSize()).toBe(0);
  });
});

describe('reading, when it goes wrong', () => {
  it('a pass’s end that can’t be kept (saving its junk fails): Settings says so; what’s read next is still merged, answered, and applied', async () => {
    const w = fake();
    const { state, pushes } = on({}, w.make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    vi.spyOn(db.sync, 'saveJunk').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    w.worker.say(passDone({ junk: [[`1/${OTHER}/000002.chordlog`, '10:1']] }));
    await settle();
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unreadable' });
    // The links after it still run: a step read next is merged, its cursor kept, and answered.
    const id = Object.keys(state.chords)[0]!;
    w.worker.say(records(1, [{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { name: 'From elsewhere' } }]));
    await settle();
    expect(w.worker.acks()).toEqual([{ t: 'ack', id: 1, ok: true }]);
    expect(db.sync.cursors(1)).toContainEqual({ device: OTHER, segment: 1, cursor: cursorAt(100) });
    w.worker.say(passDone());
    await settle();
    expect(applied(pushes)).toContain('From elsewhere');
    expect(controller!.status().problem).toBeNull();
  });

  it('a merge that fails: answered as not merged (so the worker keeps its cursor and reads it again), said in Settings, and read again later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const w = fake();
      const { state, pushes } = on({}, w.make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      const id = Object.keys(state.chords)[0]!;
      const step = [{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { name: 'From elsewhere' } } satisfies DataRecord];
      vi.spyOn(db.sync, 'merge').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      w.worker.say(records(1, step));
      await settle();
      expect(w.worker.acks()).toEqual([{ t: 'ack', id: 1, ok: false }]);
      expect(db.sync.cursors(1)).toEqual([]);
      expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unreadable' });
      // Read again later, on its own.
      const reads = () => w.worker.posted.filter((m) => m.t === 'read').length;
      const before = reads();
      vi.advanceTimersByTime(10_000);
      expect(reads()).toBe(before + 1);
      // The worker reads the step again from where it was: merged this time.
      w.worker.say(records(2, step));
      await settle();
      expect(w.worker.acks().at(-1)).toEqual({ t: 'ack', id: 2, ok: true });
      expect(db.sync.cursors(1)).toContainEqual({ device: OTHER, segment: 1, cursor: cursorAt(100) });
      w.worker.say(passDone());
      await settle();
      expect(applied(pushes)).toContain('From elsewhere');
      expect(controller!.status().problem).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the worker crashing: nothing waits for it for ever; Settings says so, and it’s started again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = fake();
      let made = 0;
      const second = fake();
      on({}, () => (made++ === 0 ? first.make() : second.make()));
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      first.worker.emit('error', new Error('out of memory'));
      expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unreadable' });
      vi.advanceTimersByTime(10_000);
      expect(second.worker.posted.some((m) => m.t === 'start')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a quit or a crash, then a relaunch', () => {
  it('mid-pass (merged, never pushed to main) and mid-apply (main applied a part): what isn’t applied is pushed again, and only that', async () => {
    const w = fake();
    let { state } = on({}, w.make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    const id = Object.keys(state.chords)[0]!;
    const at = [Date.now() + 1000, 0, OTHER] as DataRecord['at'];
    w.worker.say(
      records(1, [
        { type: 'chord', id, at, set: { name: 'First part' } },
        { type: 'chord', id: 'new-one', at, set: { name: 'Second part', icon: 'S', theme: THEME, rank: 'z0', profile: 'default', created: 1 } },
      ]),
    );
    await settle();
    expect(w.worker.acks()).toEqual([{ t: 'ack', id: 1, ok: true }]);
    // The pass never ended: main was never told.
    controller!.close();
    const pushes: DataPush[] = [];
    controller = new SyncController(() => db, (push) => pushes.push(push), fake().make);
    await controller.handle({ type: 'sync.reconcile' });
    await settle();
    expect(applied(pushes)).toContain('First part');
    expect(applied(pushes)).toContain('Second part');
    // Main applied the first part and wrote it back, then quit.
    state = mainApplies(state, db.sync.planFor(new Map([[thingKey('chord', id), new Set(['name'])]])));
    expect(state.chords[id]!.name).toBe('First part');
    controller.close();
    const again: DataPush[] = [];
    controller = new SyncController(() => db, (push) => again.push(push), fake().make);
    await controller.handle({ type: 'sync.reconcile' });
    await settle();
    expect(applied(again)).toContain('Second part');
    expect(applied(again)).not.toContain('First part');
    // All of it applied: nothing's pushed again.
    for (const push of again) if (push.push === 'sync.apply') state = mainApplies(state, push.apply);
    controller.close();
    const none: DataPush[] = [];
    controller = new SyncController(() => db, (push) => none.push(push), fake().make);
    await controller.handle({ type: 'sync.reconcile' });
    await settle();
    expect(applied(none)).toBe('[]');
  });
});
