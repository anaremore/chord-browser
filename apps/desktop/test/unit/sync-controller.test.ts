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

describe('joining with Keep both, a change made here meanwhile', () => {
  it('a chord renamed while the join adds this computer’s things (nothing’s stamped then): found as the join ends, in the copy and on its way out', async () => {
    const { state } = on({ snapshot: ['ok'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    const id = Object.keys(state.chords)[0]!;
    db.sync.setMeta({ joining: true });
    // The rename lands just after the join read this computer's chords (its first page), before it ends.
    const read = db.sync.localPages.bind(db.sync);
    vi.spyOn(db.sync, 'localPages').mockImplementationOnce(function* (size?: number) {
      let first = true;
      for (const page of read(size)) {
        yield page;
        if (first) rename(state, 'Renamed meanwhile');
        first = false;
      }
    });
    await controller!.handle({ type: 'sync.choose', mode: 'both' });
    expect(db.sync.meta.joining).toBe(false);
    expect(db.sync.snapshot().some((r) => r.type === 'chord' && r.id === id && r.set['name'] === 'Renamed meanwhile')).toBe(true);
    // On its way out: in this computer's first snapshot (what it covers leaves the outbox), stamped above what it replaced.
    expect(db.sync.meta.own).toMatchObject({ segment: 2 });
    expect([...db.sync.unappliedPages()].some((page) => page.has(thingKey('chord', id)))).toBe(false);
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

describe('kept here other than another computer wrote it', () => {
  /** A relaunch: a new controller, as after a quit, asked for what isn't applied. */
  async function relaunch(): Promise<DataPush[]> {
    controller?.close();
    const pushes: DataPush[] = [];
    controller = new SyncController(() => db, (push) => pushes.push(push), fake().make);
    await controller.handle({ type: 'sync.reconcile' });
    await settle();
    return pushes;
  }

  it('tidied or refused: pushed again at each launch, and applies as nothing; an idle look skips it while it’s as it was', async () => {
    let { state } = on({}, fake().make);
    const home = Object.keys(state.chords)[0]!;
    const at = [Date.now() + 1000, 0, OTHER] as DataRecord['at'];
    db.atomically(() =>
      db.sync.merge(
        [
          // Its colors with a key this Chord doesn't keep: the theme here is the same colors without it.
          { type: 'chord', id: home, at, set: { theme: { ...THEME, sparkle: true } } },
          // A name longer than a chord's here: refused, so this computer never has it.
          { type: 'chord', id: 'long-one', at, set: { name: 'L'.repeat(300), icon: 'L', theme: THEME, rank: 'z0', profile: 'default', created: 1 } },
        ],
        Date.now(),
      ),
    );
    for (let launch = 0; launch < 3; launch++) {
      const pushes = await relaunch();
      // The tidied one is pushed (as this Chord keeps it: no sparkle); the refused one has nothing to apply.
      expect(applied(pushes)).toContain(`"id":"${home}"`);
      expect(applied(pushes)).not.toContain('sparkle');
      const before = state;
      for (const push of pushes) if (push.push === 'sync.apply') state = mainApplies(state, push.apply);
      // Applied as nothing: the store doesn't change, so nothing's written.
      expect(state.chords).toBe(before.chords);
    }
    // An idle look pushes it once more (nothing's been pushed by one yet this session), then skips it while it's as it was.
    const idle = async () => {
      const pushes: DataPush[] = [];
      const c = new SyncController(() => db, (push) => pushes.push(push), fake().make);
      controller?.close();
      controller = c;
      await c.reconcile({ idle: true });
      await settle();
      const first = applied(pushes);
      pushes.length = 0;
      await c.reconcile({ idle: true });
      await settle();
      return [first, applied(pushes)];
    };
    const [first, second] = await idle();
    expect(first).toContain(`"id":"${home}"`);
    expect(second).toBe('[]');
    // Changed again elsewhere, it's a new version: an idle look pushes it.
    db.atomically(() => db.sync.merge([{ type: 'chord', id: home, at: [Date.now() + 2000, 0, OTHER], set: { name: 'Renamed' } }], Date.now()));
    const pushes: DataPush[] = [];
    const c = new SyncController(() => db, (push) => pushes.push(push), fake().make);
    controller?.close();
    controller = c;
    await c.reconcile({ idle: true });
    await settle();
    expect(applied(pushes)).toContain('Renamed');
  });

  it('put off for a change of yours waiting: main asks for it again (repush), and a reconcile finds it until it’s applied', async () => {
    const { state } = on({}, fake().make);
    const id = Object.keys(state.chords)[0]!;
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { name: 'From elsewhere' } }], Date.now()));
    expect(applied(await relaunch())).toContain('From elsewhere');
    // Not applied (put off): the next launch finds it again.
    expect(applied(await relaunch())).toContain('From elsewhere');
  });
});

/** Workers as the controller starts them, each a stand-in, and which were stopped. */
function workerLog() {
  const workers: FakeWorker[] = [];
  const terminated: FakeWorker[] = [];
  const make = (): WorkerLike => {
    const w = new FakeWorker();
    w.terminate = () => {
      terminated.push(w);
      return Promise.resolve(0);
    };
    workers.push(w);
    return w as unknown as WorkerLike;
  };
  return { workers, terminated, make };
}
/** A worker's folder operation, begun and ended as the real one says. */
const busy = (w: FakeWorker, op: Extract<FromWorker, { t: 'busy' }>['op']) => w.say({ t: 'busy', op });
const idle = (w: FakeWorker) => w.say({ t: 'idle' });
/** A pass from start to end, nothing in it. */
const quietPass = (w: FakeWorker) => {
  busy(w, 'pass');
  w.say(passDone());
  idle(w);
};
const writeOf = (w: FakeWorker) => w.posted.find((m) => m.t === 'write') as Extract<ToWorker, { t: 'write' }> | undefined;

describe('a folder that stops answering', () => {
  it('a write that never returns, the watch firing every 40 s meanwhile: the write’s own deadline passes; Settings says so, the changes wait, and writing goes on once the folder answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, terminated, make } = workerLog();
      const { state } = on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      quietPass(workers[0]!);
      await settle();
      rename(state, 'Waiting');
      const flushing = controller!.handle({ type: 'sync.flush' });
      await settle();
      expect(writeOf(workers[0]!)).toBeDefined();
      busy(workers[0]!, 'write');
      // The watch fires every 40 s; each asks for a read. None of it is progress on the write.
      for (let t = 0; t < 59_000; t += 1_000) {
        if (t % 40_000 === 0 && t > 0) workers[0]!.say({ t: 'changed' });
        vi.advanceTimersByTime(1_000);
      }
      expect(controller!.status().problem).toBeNull();
      vi.advanceTimersByTime(1_000);
      await flushing;
      expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'stalled', pending: 1 });
      expect(db.sync.outboxSize()).toBe(1);
      // Let go, not stopped: its stuck call holds a file thread until it returns.
      expect(workers[0]!.posted.at(-1)).toEqual({ t: 'abandon' });
      expect(terminated).toEqual([]);
      // Another, 30 s later; the folder answers it.
      vi.advanceTimersByTime(30_000);
      await settle();
      expect(workers).toHaveLength(2);
      vi.advanceTimersByTime(1);
      await settle();
      quietPass(workers[1]!);
      const write = writeOf(workers[1]!);
      expect(write).toBeDefined();
      busy(workers[1]!, 'write');
      workers[1]!.say({ t: 'written', upto: write!.upto, own: { generation: 1, device: db.device(), segment: 1, size: 300, frames: 2 }, frames: 1, bytes: 100 });
      idle(workers[1]!);
      await settle();
      expect(db.sync.outboxSize()).toBe(0);
      expect(controller!.status()).toMatchObject({ state: 'on', problem: null });
      // The first one's call returns at last: then it's stopped.
      idle(workers[0]!);
      expect(terminated).toEqual([workers[0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two calls stuck: no third worker until one returns, so two of the four file threads stay free; Settings goes on saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, terminated, make } = workerLog();
      on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      busy(workers[0]!, 'pass');
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(30_000);
      expect(workers).toHaveLength(2);
      busy(workers[1]!, 'pass');
      vi.advanceTimersByTime(60_000);
      expect(controller!.status().problem).toBe('stalled');
      // Two stuck: nothing more is started, however long.
      vi.advanceTimersByTime(60 * 60_000);
      expect(workers).toHaveLength(2);
      expect(controller!.status().problem).toBe('stalled');
      // One returns: it's stopped, and another starts at once.
      idle(workers[0]!);
      expect(terminated).toEqual([workers[0]]);
      vi.advanceTimersByTime(0);
      expect(workers).toHaveLength(3);
      quietPass(workers[2]!);
      await settle();
      expect(controller!.status().problem).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('later and later: the wait before another worker doubles with each timeout, and starts over only after ten minutes with none', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { workers, make } = workerLog();
      on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      /** The newest worker hangs in a prune (no pass): its call returns as soon as it's let go, so none stays stuck. */
      const hang = () => {
        const w = workers.at(-1)!;
        busy(w, 'prune');
        vi.advanceTimersByTime(60_000);
        idle(w);
      };
      /** How long until the next worker starts. */
      const wait = () => {
        const before = workers.length;
        let ms = 0;
        while (workers.length === before && ms < 60 * 60_000) {
          vi.advanceTimersByTime(1_000);
          ms += 1_000;
        }
        return ms;
      };
      hang();
      expect(wait()).toBe(30_000);
      hang();
      expect(wait()).toBe(60_000);
      hang();
      expect(wait()).toBe(120_000);
      // Ten minutes healthy (a pass every minute), then a hang: back to the shortest wait.
      for (let i = 0; i < 11; i++) {
        quietPass(workers.at(-1)!);
        vi.advanceTimersByTime(60_000);
      }
      hang();
      expect(wait()).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deadlines, more', () => {
  it('an operation that ended without touching the folder (a watch not wanted, behind on Windows) is no sign the folder answers: Settings goes on saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, make } = workerLog();
      on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      busy(workers[0]!, 'pass');
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(30_000);
      expect(controller!.status().problem).toBe('stalled');
      busy(workers[1]!, 'watch');
      workers[1]!.say({ t: 'idle', reached: false });
      expect(controller!.status().problem).toBe('stalled');
      // One that reached it, with nothing else waiting: it answers again.
      busy(workers[1]!, 'pass');
      workers[1]!.say(passDone());
      idle(workers[1]!);
      await settle();
      expect(controller!.status().problem).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the worker is told where chord-data keeps what it’s writing (a file beside chord.db), so a worker after it can cut back a short write', async () => {
    const { workers, make } = workerLog();
    on({}, make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    expect(workers[0]!.posted[0]).toMatchObject({ t: 'start', pendingFile: join(dir, 'sync-pending') });
  });

  it('setting up the watch on a share that stopped answering: a folder operation like any, under its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, make } = workerLog();
      on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      busy(workers[0]!, 'watch');
      vi.advanceTimersByTime(60_000);
      expect(controller!.status().problem).toBe('stalled');
      // Coming to the front sets the watch up again: in the next worker, under a deadline too.
      vi.advanceTimersByTime(30_000);
      await controller!.handle({ type: 'sync.front', front: true });
      expect(workers[1]!.posted.map((m) => m.t)).toEqual(['start', 'front']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a merge that takes longer than the deadline: the worker waits on chord-data then, not the folder, and isn’t let go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, make } = workerLog();
      const { state } = on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      const id = Object.keys(state.chords)[0]!;
      busy(workers[0]!, 'pass');
      workers[0]!.say(records(1, [{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { name: 'Slow' } }]));
      // The merge hasn't answered yet (its slices wait their turns): two minutes pass meanwhile.
      vi.advanceTimersByTime(120_000);
      expect(controller!.status().problem).toBeNull();
      await settle();
      expect(workers[0]!.acks()).toEqual([{ t: 'ack', id: 1, ok: true }]);
      // Answered: the deadline runs again from there.
      vi.advanceTimersByTime(60_000);
      expect(controller!.status().problem).toBe('stalled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the wait before another worker reaches its cap (15 minutes) while nothing works: the waiting itself never counts as healthy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { workers, make } = workerLog();
      on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      const waits: number[] = [];
      for (let i = 0; i < 7; i++) {
        const w = workers.at(-1)!;
        busy(w, 'pass');
        vi.advanceTimersByTime(60_000);
        idle(w);
        const before = workers.length;
        let ms = 0;
        while (workers.length === before && ms < 60 * 60_000) {
          vi.advanceTimersByTime(1_000);
          ms += 1_000;
        }
        waits.push(ms / 1000);
      }
      expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a worker stopped or let go', () => {
  it('a step it read and the controller merged after it went is never answered to the one started after it, nor is anything it says taken as that one’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { workers, make } = workerLog();
      const { state } = on({}, make);
      await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
      const id = Object.keys(state.chords)[0]!;
      // A big step: merged over several slices.
      const step = Array.from({ length: 160 }, (_, i): DataRecord => ({ type: 'chord', id: i === 0 ? id : `other-${i}`, at: [Date.now() + 1000, 0, OTHER], set: { name: `Step ${i}` } }));
      busy(workers[0]!, 'pass');
      workers[0]!.say(records(1, step));
      // It crashes while its step is merged; another starts 10 s later.
      workers[0]!.emit('error', new Error('gone'));
      vi.advanceTimersByTime(10_000);
      expect(workers).toHaveLength(2);
      await settle();
      expect(workers[1]!.acks()).toEqual([]);
      expect(workers[0]!.acks()).toEqual([]);
      // What the first one says late (an answer to a write, say) is never taken as the second's.
      rename(state, 'Waiting');
      const flushing = controller!.handle({ type: 'sync.flush' });
      await settle();
      const write = writeOf(workers[1]!);
      expect(write).toBeDefined();
      workers[0]!.say({ t: 'failed', problem: 'copied', for: 'write' });
      await settle();
      expect(db.sync.meta.newIds).toEqual([]);
      workers[1]!.say({ t: 'written', upto: write!.upto, own: { generation: 1, device: db.device(), segment: 1, size: 300, frames: 2 }, frames: 1, bytes: 100 });
      await flushing;
      expect(db.sync.outboxSize()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('what it was writing is kept until it’s answered, and handed to the next one, which settles it', async () => {
    const { workers, make } = workerLog();
    on({}, make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    const expect_ = { generation: 1, device: db.device(), segment: 1, size: 160, frames: 2 };
    const marker = { expect: expect_, at: 100, length: 60, hash: 'ab'.repeat(32) };
    workers[0]!.say({ t: 'appending', appending: marker });
    // Its length and hash, never its bytes (a new segment is over a megabyte).
    expect(db.sync.meta.appending).toEqual(marker);
    // Chord quits before the answer; at the next launch, the worker is handed it.
    controller!.close();
    const next = workerLog();
    controller = new SyncController(() => db, () => undefined, next.make);
    await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    expect(next.workers[0]!.posted[0]).toMatchObject({ t: 'start', appending: marker });
    // Answered: no longer kept.
    db.atomically(() => db.sync.written(0, expect_, 1, 3));
    expect(db.sync.meta.appending).toBeNull();
  });

  it('a write that landed though it went unanswered, settled by the worker: its segment kept at once, so the next write’s marker is from there', async () => {
    const { workers, make } = workerLog();
    on({}, make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    workers[0]!.say({ t: 'appending', appending: { expect: { generation: 1, device: db.device(), segment: 1, size: 160, frames: 2 }, at: 100, length: 60, hash: null } });
    const landed = { generation: 1, device: db.device(), segment: 1, size: 160, frames: 2 };
    workers[0]!.say({ t: 'settled', own: landed });
    expect(db.sync.meta.own).toEqual(landed);
    expect(db.sync.meta.appending).toBeNull();
    // The next write's marker is relative to it: a restart now settles from 160, never from the old 100.
    workers[0]!.say({ t: 'appending', appending: { expect: { ...landed, size: 220, frames: 3 }, at: 160, length: 60, hash: null } });
    controller!.close();
    const next = workerLog();
    controller = new SyncController(() => db, () => undefined, next.make);
    await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    expect(next.workers[0]!.posted[0]).toMatchObject({ t: 'start', own: landed, appending: { at: 160 } });
  });
});

describe('an error taking in what the worker said', () => {
  it('a full disk as this computer is told another writes under its id: chord-data goes on, says so, and the next pass tries again', async () => {
    const w = fake();
    on({}, w.make);
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    vi.spyOn(db.sync, 'setMeta').mockImplementationOnce(() => {
      throw new Error('database or disk is full');
    });
    expect(() => w.worker.say({ t: 'own-changed' })).not.toThrow();
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unreadable' });
    expect(db.sync.meta.rebind).toBe(false);
    // The next pass finds it again, and this time it's kept.
    w.worker.say({ t: 'own-changed' });
    expect(db.sync.meta.rebind).toBe(true);
  });
});
