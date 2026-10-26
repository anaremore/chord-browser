/**
 * Sync on chord-data's thread (docs/decisions/S15-your-data.md §7, §13): it
 * owns the sync tables (`@chord/data/sync`) and starts the worker thread that
 * does the folder work (sync-worker.ts) only while sync is on. It:
 *
 * - merges what the worker read, a slice of a few milliseconds at a time,
 *   each with its cursor, and answers each batch so the next comes after;
 * - pushes what changed to main as one `sync.apply` after each look at the
 *   folder (main only routes, and applies it as a store change);
 * - hands the worker what you changed about 3 seconds after the last change,
 *   and on quit, to append as one frame; compacts at most daily;
 * - says where sync stands, for Settings.
 *
 * The root key lives here in memory only: main reads it from safeStorage
 * after launch and hands it over, or you type the passphrase.
 */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { applyIsEmpty, CLOCK_AHEAD_MS, emptyApply, localDeviceFields, newDeviceId, SYNC_OFF, type DataRecord, type FolderInspection, type SyncApply, type SyncProblem, type SyncStatus } from '@chord/core';
import type { DataPush, SyncInfo, SyncReply, SyncRequest } from '@chord/data';
import type { ChordDatabase } from '@chord/data/db';
import type { FromWorker, ToWorker } from './sync-worker';

/** Changes are written this long after the last one (S15 §6), so a burst of them is one frame. */
const WRITE_MS = 3000;
/**
 * Records merged per transaction, and changed things read back for main per
 * push: 2 to 4 ms each, with searches answered between them. A search can wait
 * behind one of these and a write of what main applied, so each is kept to a
 * few milliseconds (100 took up to 8).
 */
const SLICE = 50;
/**
 * Characters of things read and written per merged slice: a slice of tiny
 * changes to a thing of 2 MB is one rewrite of it, not a hundred, and a slice
 * stops once it has rewritten about this much.
 */
const SLICE_CHARS = 512 * 1024;
const PLAN_SLICE = 50;
/**
 * SQLite's checkpoints, which copy the write-ahead log into the database and
 * took 10–70 ms on this thread, run on the worker's thread instead while sync
 * merges and main writes what it applied, until this long after; and that
 * often meanwhile.
 */
const BUSY_MS = 5000;
const CHECKPOINT_MS = 500;
/** Compaction at most daily, once a computer's own segments pass twice a snapshot's size, or 500 frames (S15 §6). */
const COMPACT_MS = 86_400_000;
const COMPACT_FRAMES = 500;
/** An old generation's file goes this long after this computer moved past it. */
const RETIRE_MS = 30 * 86_400_000;
/** A write that failed is tried again after this long, doubling each time up to WRITE_RETRY_MAX. */
const WRITE_RETRY_MS = 30_000;
const WRITE_RETRY_MAX = 15 * 60_000;
/** New ids a day, at most: past that, another computer keeps writing as this one, and this one stops writing, saying so. */
const MAX_NEW_IDS = 3;
const DAY_MS = 86_400_000;
/** Passes a join waits for while there's more of the folder to look through. */
const JOIN_PASSES = 20;
/** Reading that failed (a merge, a pass's end) is tried again after this long, doubling up to READ_RETRY_MAX. */
const READ_RETRY_MS = 10_000;
const READ_RETRY_MAX = 10 * 60_000;
/** How long turning off waits for what's waiting to be written: past that it goes on, and the changes stay in the outbox. */
const OFF_WRITE_MS = 10_000;
/**
 * The folder operation under way in the worker (each begun and ended out loud,
 * `busy` and `idle`) has a deadline of its own: this long without progress on
 * it (its answer, a snapshot page asked for or sent, a step read or answered)
 * means a file call that never returned, a stalled network drive or cloud
 * folder. Nothing else moves it: not a watch firing, not another request. The
 * worker is let go, and another starts after STALL_RETRY_MS, doubling up to
 * STALL_RETRY_MAX; the doubling starts over only after HEALTHY_MS with no
 * timeout.
 */
const WORKER_MS = 60_000;
const STALL_RETRY_MS = 30_000;
const STALL_RETRY_MAX = 15 * 60_000;
const HEALTHY_MS = 10 * 60_000;
/**
 * Workers let go whose stuck call hasn't returned: each holds one of the
 * process's four file threads. At this many, no other is started, so two stay
 * free for the rest of Chord, until one returns.
 */
const MAX_STUCK = 2;

/** What starts sync's worker thread: a real one, or a stand-in in tests. */
export type WorkerLike = Pick<Worker, 'postMessage' | 'on' | 'unref' | 'terminate'>;

/** A worker's failure as Settings' steps say it: one about writing this computer's log is the folder's. */
const stepProblem = (problem: Extract<FromWorker, { t: 'failed' }>['problem']): NonNullable<SyncReply['problem']> =>
  problem === 'copied' || problem === 'gone' || problem === 'full' ? 'io' : problem;

type Ask = { kinds: ReadonlySet<FromWorker['t']>; for: ToWorker['t']; resolve(message: FromWorker): void };

export class SyncController {
  private worker: WorkerLike | null = null;
  private key: Uint8Array | null = null;
  private info: SyncInfo = { name: '', os: '', app: '' };
  private readonly asks: Ask[] = [];
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | null = null;
  /** What changed since main last heard, by thing, with its fields. */
  private changes = new Map<string, Set<string>>();
  /** When each computer last wrote to the folder, and the newest stamp read from each. */
  private readonly seen = new Map<string, number>();
  private readonly newest = new Map<string, number>();
  /** When each computer says it made its newest segment read (its own clock): what tells its clock is ahead. */
  private readonly wrote = new Map<string, number>();
  /** The folder holds more junk than sync remembers: computers not known yet aren't looked for. */
  private cluttered = false;
  /** Things a change made here couldn't win (a stamp at the very last there can be): named in Settings. */
  private readonly stuck = new Map<string, string>();
  /** Computers this one reads whose folders hold more junk than a pass looks through: named in Settings. */
  private readonly blocked = new Set<string>();
  /** Reading's own problem (a merge or a pass's end failed): it's tried again, later and later, and Settings says so. */
  private readProblem: 'unreadable' | null = null;
  private readRetryMs = 0;
  private readRetry: ReturnType<typeof setTimeout> | undefined;
  /** The worker went without being stopped (it crashed): it's started again with the next try. */
  private died = false;
  /** The folder operation under way in the worker, and its deadline (`unanswered`). */
  private op: { what: string; deadline: ReturnType<typeof setTimeout> } | null = null;
  /** Workers let go while a file call held them: each is stopped once that call returns (`returned`). */
  private readonly stuckWorkers = new Set<WorkerLike>();
  /** The folder stopped answering: the worker was let go, another starts later and later, and Settings says so until one answers. */
  private stalled = false;
  private stallMs = 0;
  private lastStall = 0;
  private stallRetry: ReturnType<typeof setTimeout> | undefined;
  private problem: SyncProblem | null = null;
  /** Writing's own problem (it couldn't write, or keeps finding another computer writing as this one): a look that finds the folder doesn't clear it. */
  private writeProblem: 'unwritable' | 'copies' | null = null;
  private retryMs = 0;
  /** Whether the last pass had more of the folder to look through. */
  private unfinished = false;
  private changedBy: string | null = null;
  private capped = 0;
  /** Frames of other computers' logs passed over (too big to read), this session. */
  private refused = 0;
  /** The last pass found more computers than sync reads. */
  private tooMany = false;
  /** Removed computers whose folders went: not looked at again. */
  private readonly pruned = new Set<string>();
  private passDone: (() => void) | null = null;
  /** The generation this computer is moving to by changing the passphrase, until it has: a look that finds it isn't a reason to pause. */
  private moving: number | null = null;
  /** Snapshots being written: their pages, read as the worker asks for each. */
  private readonly streams = new Map<number, Iterator<DataRecord[]>>();
  private nextStream = 1;
  /** Merges one batch at a time, in order. */
  private merging: Promise<void> = Promise.resolve();
  /** Whether a Chord window is in front: the worker watches the folder on Windows only then. */
  private front = true;
  /** Checkpoints are small while sync is busy (BUSY_MS). */
  private busy: { db: ChordDatabase; timer: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

  constructor(
    private readonly db: () => ChordDatabase | null,
    private readonly push: (message: DataPush) => void,
    private readonly makeWorker: () => WorkerLike = () => new Worker(join(import.meta.dirname, 'sync.js'), { name: 'Sync' }),
  ) {}

  /**
   * One more link in reading's chain (merges, a pass's end, pushes): whatever
   * it throws is caught, said in Settings, and reading tried again later, so
   * one failure never stops the links after it.
   */
  private chain(work: () => Promise<void>): void {
    this.merging = this.merging.then(work).catch((error: unknown) => {
      console.error('Sync couldn’t take in what it read:', error);
      this.readFailed();
    });
  }

  /** A step of sync's on chord-data's thread, timed by name (`SyncTimings.steps`): perf.spec.ts reads the slowest. */
  private step<T>(db: ChordDatabase, what: string, work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } finally {
      db.sync.stepped(what, performance.now() - started);
    }
  }

  /**
   * Whatever comes from the worker or a timer runs through this: an error (a
   * database that's full or locked, say) never reaches chord-data's
   * last-resort handler, which would end the process. It's said in Settings,
   * and reading is tried again later.
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      console.error('Sync couldn’t take in what the folder said:', error);
      try {
        this.readFailed();
      } catch (again) {
        console.error('Sync couldn’t say so:', again);
      }
    }
  }

  /** Reading failed: tried again later and later, and said in Settings. */
  private readFailed(): void {
    this.readProblem = 'unreadable';
    this.readRetryMs = Math.min(READ_RETRY_MAX, Math.max(READ_RETRY_MS, this.readRetryMs * 2));
    clearTimeout(this.readRetry);
    this.readRetry = setTimeout(() => {
      try {
        if (this.died && !this.worker) {
          this.died = false;
          this.startWorker();
        } else this.read();
      } catch (error) {
        console.error('Sync couldn’t start reading again:', error);
        this.readFailed();
        return;
      }
      void this.reconcile().catch(() => this.readFailed());
    }, this.readRetryMs);
    this.readRetry.unref?.();
    this.pushStatus();
  }

  private readOk(): void {
    if (this.readProblem === null) return;
    this.readProblem = null;
    this.readRetryMs = 0;
    clearTimeout(this.readRetry);
  }

  /**
   * What's merged but not on this computer's screen (`unappliedPages`), pushed
   * to main again: after a launch, and after a failed apply or merge. Main's
   * writes of what it applied are what mark a thing applied (`local`), so a
   * quit or a crash during a pass or an apply never leaves a change off screen.
   */
  async reconcile(): Promise<void> {
    const db = this.db();
    if (!db?.sync.meta.on || db.sync.meta.joining) return;
    const pages = db.sync.unappliedPages();
    for (let page = this.step(db, 'unapplied', () => pages.next()); !page.done; page = this.step(db, 'unapplied', () => pages.next())) {
      for (const [key, names] of page.value) this.changes.set(key, new Set([...(this.changes.get(key) ?? []), ...names]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.changes.size > 0) this.chain(() => this.pushChanges());
  }

  /* ---------- the worker ---------- */

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.makeWorker();
    // Only the worker of now is heard: what one stopped or let go said (an answer, a step) is never taken for this one's.
    // One let go says only when the call that held it returned.
    worker.on('message', (message: FromWorker) => {
      if (this.worker === worker) this.guard(() => this.heard(worker, message));
      else if (message.t === 'idle' && this.stuckWorkers.has(worker)) this.guard(() => this.returned(worker));
    });
    // Gone without being stopped (it crashed): whatever waited for it is answered, so nothing waits for ever; Settings
    // says so, and it's started again later.
    const died = (error?: unknown) =>
      this.guard(() => {
        if (this.stuckWorkers.has(worker)) return this.returned(worker);
        if (this.worker !== worker) return;
        console.error('Sync worker failed:', error ?? 'it exited');
        this.worker = null;
        this.died = true;
        this.endOp();
        for (const ask of this.asks.splice(0)) ask.resolve({ t: 'failed', problem: 'io', for: ask.for });
        this.readFailed();
      });
    worker.on('error', died);
    worker.on('exit', () => died());
    // It never keeps chord-data's process alive on its own.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /** A folder operation, and its answer (or its failure). The worker does them one at a time, so answers come in order. */
  private ask(message: ToWorker, kinds: FromWorker['t'][]): Promise<FromWorker> {
    return new Promise((resolve) => {
      this.asks.push({ kinds: new Set(kinds), for: message.t, resolve });
      this.ensureWorker().postMessage(message);
    });
  }

  /** The worker began a folder operation: its deadline starts. */
  private begin(what: string): void {
    this.endOp();
    const deadline = setTimeout(() => this.guard(() => this.unanswered()), WORKER_MS);
    deadline.unref?.();
    this.op = { what, deadline };
  }

  /** Progress on the operation under way (a page, a step, an answer to one): its deadline starts again. Nothing else moves it. */
  private progress(): void {
    if (this.op) this.begin(this.op.what);
  }

  /** The operation under way ended. Once one that was asked for, or a pass, ends with nothing more waiting, the folder answers again. */
  private endOp(): void {
    if (!this.op) return;
    clearTimeout(this.op.deadline);
    const what = this.op.what;
    this.op = null;
    if (this.stalled && this.worker && this.asks.length === 0 && what !== 'tidy') {
      this.stalled = false;
      this.pushStatus();
    }
  }

  /**
   * The operation under way made no progress for WORKER_MS: a file call that
   * never returned holds the worker's one-at-a-time chain. The worker is let
   * go: told to do nothing more in the folder once that call returns, and kept
   * until then (`returned`), since it holds one of the process's file threads
   * meanwhile. What waited for it is answered as failed (writing keeps the
   * outbox and tries again), a join waiting for a pass hears it ended, and
   * Settings says the folder isn't answering. Another worker starts later and
   * later; none while MAX_STUCK calls are stuck.
   */
  private unanswered(): void {
    const worker = this.worker;
    const op = this.op;
    if (!worker || !op) return;
    console.error(`Sync: the folder hasn’t answered (${op.what}) for a minute; its worker is let go`);
    this.op = null;
    this.quiet();
    this.worker = null;
    this.streams.clear();
    worker.postMessage({ t: 'abandon' } satisfies ToWorker);
    this.stuckWorkers.add(worker);
    for (const ask of this.asks.splice(0)) ask.resolve({ t: 'failed', problem: 'io', for: ask.for });
    const done = this.passDone;
    this.passDone = null;
    done?.();
    this.stalled = true;
    const now = Date.now();
    if (now - this.lastStall > HEALTHY_MS) this.stallMs = 0;
    this.lastStall = now;
    this.stallMs = Math.min(STALL_RETRY_MAX, Math.max(STALL_RETRY_MS, this.stallMs * 2));
    this.restartLater(this.stallMs);
    this.pushStatus();
  }

  /** Another worker, after `ms`: unless MAX_STUCK calls are stuck, when none is risked until one returns. */
  private restartLater(ms: number): void {
    clearTimeout(this.stallRetry);
    this.stallRetry = undefined;
    if (this.stuckWorkers.size >= MAX_STUCK) return;
    this.stallRetry = setTimeout(
      () =>
        this.guard(() => {
          this.stallRetry = undefined;
          this.startWorker();
        }),
      ms,
    );
    this.stallRetry.unref?.();
  }

  /** A worker let go whose stuck call returned (or that ended): stopped, its file thread free; one held back for it starts now. */
  private returned(worker: WorkerLike): void {
    this.stuckWorkers.delete(worker);
    void worker.terminate();
    if (this.stalled && !this.worker && this.stallRetry === undefined) this.restartLater(0);
  }

  private heard(from: WorkerLike, message: FromWorker): void {
    switch (message.t) {
      case 'busy':
        this.begin(message.op);
        return;
      case 'idle':
        this.endOp();
        return;
      case 'pull':
      case 'records':
        this.progress();
        break;
      default:
        break;
    }
    this.hear(from, message);
  }

  private hear(from: WorkerLike, message: FromWorker): void {
    const ask = this.asks[0];
    if (ask && (ask.kinds.has(message.t) || (message.t === 'failed' && message.for === ask.for))) {
      this.asks.shift();
      ask.resolve(message);
      return;
    }
    switch (message.t) {
      case 'pull':
        this.page(message.stream);
        return;
      case 'pruned':
        this.pruned.add(message.device);
        return;
      case 'records':
        this.chain(() => this.merge(from, message));
        return;
      case 'appending': {
        // Kept until the write is answered: a worker that starts after this one (or after a relaunch) settles it.
        const { expect, at, bytes } = message.appending;
        this.db()?.sync.setMeta({ appending: { expect, at, bytes: Buffer.from(bytes).toString('base64') } });
        return;
      }
      case 'own-changed': {
        // This computer's segment isn't as it left it (another copy of the profile wrote to it): a new id, before it writes.
        const db = this.db();
        if (db?.sync.meta.on && !db.sync.meta.rebind) db.sync.setMeta({ rebind: true });
        this.scheduleWrite(0);
        return;
      }
      case 'newer':
        this.problem = 'newer';
        return;
      case 'pass-done':
        this.chain(() => this.passed(message));
        return;
      case 'changed':
        this.read();
        return;
      case 'failed':
        if (message.for === 'read') console.error('Sync: the folder couldn’t be read');
        return;
      default:
        return;
    }
  }

  /** A snapshot's next page, for the worker; `lost` once there's no such snapshot (it stopped), so nothing partial is put in place. */
  private page(stream: number): void {
    const pages = this.streams.get(stream);
    let next: IteratorResult<DataRecord[]> | null = null;
    const started = performance.now();
    try {
      next = pages ? pages.next() : null;
      if (pages) this.db()?.sync.timed('page', performance.now() - started);
    } catch (error) {
      console.error('Sync couldn’t read its snapshot:', error);
    }
    if (!next || next.done) this.streams.delete(stream);
    this.worker?.postMessage({ t: 'chunk', stream, records: next && !next.done ? next.value : [], done: !next || Boolean(next.done), ...(next ? {} : { lost: true }) } satisfies ToWorker);
    this.progress();
  }

  /**
   * A snapshot of the copy for the worker to write: its pages as it asks for
   * them, this computer's `device` record for its first frame, and the outbox
   * it covers (`mark`): changes stamped while it's written stay to follow it.
   */
  private snapshotOf(db: ChordDatabase, device: DataRecord[] = db.sync.deviceRecords()): { snapshot: { stream: number; device: DataRecord[] }; mark: number; reads: Record<string, string> } {
    const stream = this.nextStream++;
    // What it has read so far is in it: what's merged by now, it holds (its pages are read after).
    const reads = this.step(db, 'reads', () => db.sync.readPositions(db.sync.meta.generation));
    this.streams.set(stream, db.sync.snapshotPages());
    return { snapshot: { stream, device }, mark: db.sync.outboxMark(), reads };
  }

  /** A snapshot of the copy as this computer's newest segment (compaction, or its first): true once it's there; `copied` when another computer writes under this id. */
  private async snapshotNow(db: ChordDatabase): Promise<true | 'copied' | false> {
    const { snapshot, mark, reads } = this.snapshotOf(db);
    const reply = await this.ask({ t: 'snapshot', snapshot }, ['snapshotted']);
    this.streams.delete(snapshot.stream);
    if (reply.t !== 'snapshotted') return reply.t === 'failed' && reply.problem === 'copied' ? 'copied' : false;
    db.atomically(() => db.sync.snapshotted(reply.own, Date.now(), mark, reads));
    return true;
  }

  private stopWorker(): void {
    clearTimeout(this.writeTimer);
    clearTimeout(this.stallRetry);
    this.stallRetry = undefined;
    if (this.op) clearTimeout(this.op.deadline);
    this.op = null;
    this.died = false;
    this.stalled = false;
    this.stallMs = 0;
    this.streams.clear();
    // Checkpoints go back to chord-data's own connection.
    this.quiet();
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.postMessage({ t: 'stop' } satisfies ToWorker);
    void worker.terminate();
    for (const ask of this.asks.splice(0)) ask.resolve({ t: 'failed', problem: 'io', for: ask.for });
  }

  /** Reading and writing begin (again) with what chord-data remembers: the folder, the generation, this computer's segment, the cursors. */
  private startWorker(): void {
    const db = this.db();
    const meta = db?.sync.meta;
    if (!db || !meta?.on || meta.paused || !meta.folder || !this.key) return;
    this.ensureWorker().postMessage({
      t: 'start',
      folder: meta.folder,
      generation: meta.generation,
      device: db.device(),
      key: this.key,
      own: meta.own,
      cursors: db.sync.cursors(meta.generation),
      app: this.info.app,
      junk: db.sync.junk(),
      appending: meta.appending ? { expect: meta.appending.expect, at: meta.appending.at, bytes: new Uint8Array(Buffer.from(meta.appending.bytes, 'base64')) } : null,
      front: this.front,
    } satisfies ToWorker);
    if (db.sync.outboxSize() > 0) this.scheduleWrite(0);
  }

  /** Look at the folder now (Chord came to the front, or the folder changed). */
  read(): void {
    if (!this.worker || !this.key || this.db()?.sync.meta.paused) return;
    this.worker.postMessage({ t: 'read' } satisfies ToWorker);
  }

  /* ---------- reading ---------- */

  /**
   * A step the worker read, merged a slice at a time; the cursor is saved in
   * the same transaction as the last slice. The worker moves its cursor on only
   * when this says the step is in (`ack` ok): a step that failed is read again
   * later, and Settings says so.
   */
  private async merge(from: WorkerLike, message: Extract<FromWorker, { t: 'records' }>): Promise<void> {
    const db = this.db();
    let ok = false;
    try {
      if (!db) return;
      if (message.records.length > 0) this.busyFor(db);
      this.refused += message.refused;
      const { generation } = db.sync.meta;
      const now = Date.now();
      for (let at = 0; at === 0 || at < message.records.length; ) {
        // Removed meanwhile (an earlier slice said so): nothing more is merged.
        if (!db.sync.meta.on) break;
        const slice = message.records.slice(at, at + SLICE);
        const started = performance.now();
        const result = db.atomically(() => {
          const merged = db.sync.merge(slice, now, SLICE_CHARS);
          if (at + Math.max(1, merged.consumed) >= message.records.length) db.sync.saveCursor(generation, message.device, message.segment, message.cursor);
          return merged;
        });
        at += Math.max(1, result.consumed);
        const last = at >= message.records.length;
        db.sync.timed('merge', performance.now() - started);
        for (const [key, names] of result.changes) {
          const had = this.changes.get(key) ?? new Set<string>();
          for (const name of names) had.add(name);
          this.changes.set(key, had);
        }
        this.capped += result.capped;
        for (const [device, ms] of result.newest) this.newest.set(device, Math.max(ms, this.newest.get(device) ?? 0));
        if (result.removed !== null && !db.sync.meta.joining) this.removedHere(result.removed);
        // A slice is a few milliseconds: the command bar's searches, and anything else waiting, go between them.
        if (!last) await new Promise((resolve) => setImmediate(resolve));
      }
      ok = true;
    } catch (error) {
      console.error('Sync couldn’t merge what it read:', error);
      this.readFailed();
    } finally {
      // Answered to the worker that read it, only if it's still the one: never to one started since, whose own step it could be taken for.
      if (this.worker === from) {
        from.postMessage({ t: 'ack', id: message.id, ok } satisfies ToWorker);
        // Answered: the operation's deadline counts from here, not from when the step came.
        this.progress();
      }
    }
  }

  /** A pass's end: whatever goes wrong here, a join waiting for it hears it ended. */
  private async passed(message: Extract<FromWorker, { t: 'pass-done' }>): Promise<void> {
    const done = this.passDone;
    this.passDone = null;
    try {
      await this.takePass(message);
    } finally {
      done?.();
    }
  }

  private async takePass(message: Extract<FromWorker, { t: 'pass-done' }>): Promise<void> {
    const db = this.db();
    if (!db) return;
    for (const [device, at] of Object.entries(message.seen)) this.seen.set(device, at);
    this.tooMany = message.tooMany;
    this.cluttered = message.cluttered;
    this.unfinished = message.unfinished;
    this.blocked.clear();
    for (const device of message.blocked) this.blocked.add(device);
    if (message.failed) this.readFailed();
    else this.readOk();
    if (message.junk) this.step(db, 'junk', () => db.sync.saveJunk(message.junk!));
    for (const [device, at] of Object.entries(message.wrote)) this.wrote.set(device, Math.max(at, this.wrote.get(device) ?? 0));
    const look = message.look;
    const was = this.problem;
    // A newer generation that's this computer's own (it's moving there, or a look from before it moved): no reason to pause.
    if (look.state === 'ok' || (look.state === 'changed' && (look.generation === this.moving || look.generation <= db.sync.meta.generation))) {
      if (this.problem !== 'newer') this.problem = null;
    } else if (look.state === 'changed') {
      this.problem = 'changed';
      // Named only when that computer said so in this generation's log, sealed, before it moved: never from the new
      // generation's file, which anyone who can write to the folder could put there. Otherwise no one is named.
      this.changedBy = db.sync.devices().find((d) => d.rekeyed === look.generation)?.name ?? null;
    } else this.problem = look.state;
    if (this.problem === 'conflict' || this.problem === 'changed' || this.problem === 'newer') this.stopWorker();
    if (!db.sync.meta.joining) {
      await this.pushChanges();
      this.step(db, 'prune', () => this.prune(db));
    }
    this.retire();
    // The folder is back (the sync app runs again): what waited in the outbox goes now.
    if (was === 'missing' && this.problem === null && db.sync.outboxSize() > 0) this.scheduleWrite(0);
    this.pushStatus();
  }

  /**
   * What changed since main last heard, as `sync.apply` pushes: parents
   * before what they hold (chords, folders by depth, splits, tabs, the rest,
   * what went last), a slice at a time, each read back in a few milliseconds
   * with searches answered between them.
   */
  private async pushChanges(): Promise<void> {
    const db = this.db();
    if (!db || this.changes.size === 0) return;
    // A chord that went goes in one push with every node of it that went, so it takes them, kept for its Undo.
    const changes = this.changes;
    const slices = this.step(db, 'order', () => db.sync.pushSlices(changes, PLAN_SLICE));
    this.changes = new Map();
    for (const [at, slice] of slices.entries()) {
      const started = performance.now();
      const apply = db.sync.planFor(slice);
      // Each thing's version, which main confirms once it has applied it and written it back (`sync.applied`).
      const versions = db.sync.versions(slice.keys());
      db.sync.timed('plan', performance.now() - started);
      if (!applyIsEmpty(apply)) this.push({ push: 'sync.apply', apply, versions });
      // Nothing of it applies here (all of it refused, or as this computer has it already): seen, and not pushed again.
      else db.atomically(() => db.sync.markApplied(versions));
      if (at < slices.length - 1) await new Promise((resolve) => setImmediate(resolve));
    }
    // Main writes what it applied back to chord-data meanwhile: checkpoints stay small a while longer.
    this.busyFor(db);
  }

  /**
   * While sync merges and main writes what it applied (until BUSY_MS after),
   * the worker thread runs chord.db's checkpoints, passive ones on a
   * connection of its own, every CHECKPOINT_MS, and chord-data's thread none.
   */
  private busyFor(db: ChordDatabase): void {
    const worker = this.worker;
    if (!worker) return;
    if (this.busy?.db !== db) {
      this.quiet();
      db.checkpointElsewhere(true);
      const every = setInterval(() => this.worker?.postMessage({ t: 'checkpoint', database: db.file } satisfies ToWorker), CHECKPOINT_MS);
      every.unref();
      this.busy = { db, timer: setTimeout(() => undefined, 0), every };
    }
    clearTimeout(this.busy!.timer);
    const timer = setTimeout(
      () =>
        this.guard(() => {
          if (this.busy?.timer === timer) this.quiet();
        }),
      BUSY_MS,
    );
    timer.unref();
    this.busy!.timer = timer;
  }

  /** Not busy any more: chord-data's own connection checkpoints again, after one last checkpoint from the worker. */
  private quiet(): void {
    const busy = this.busy;
    if (!busy) return;
    this.busy = null;
    clearTimeout(busy.timer);
    clearInterval(busy.every);
    this.worker?.postMessage({ t: 'checkpoint', database: busy.db.file } satisfies ToWorker);
    if (this.db() === busy.db) busy.db.checkpointElsewhere(false);
  }

  /** Another computer removed this one: sync stops here, and this computer's data stays (S15 §6). */
  private removedHere(at: number): void {
    const db = this.db();
    if (!db) return;
    const folder = db.sync.meta.folder;
    this.stopWorker();
    this.key = null;
    db.sync.clear();
    db.sync.setMeta({ on: false, folder, removedAt: at });
    this.changes.clear();
    this.pushStatus();
  }

  /* ---------- writing ---------- */

  /** chord-data wrote a batch: what it stamped is written to the folder about 3 seconds after the last change. */
  afterWrite(): void {
    const db = this.db();
    if (db?.sync.stamping && db.sync.pending > 0) this.scheduleWrite(WRITE_MS);
    // A change that couldn't win: main is sent the merged value back, and Settings names what.
    const lost = db?.sync.takeLost();
    if (db && lost && lost.size > 0) {
      for (const [key, names] of lost) {
        this.changes.set(key, new Set([...(this.changes.get(key) ?? []), ...names]));
        this.stuck.set(key, db.sync.describe(key));
      }
      this.chain(() => this.pushChanges());
      this.pushStatus();
    }
  }

  private scheduleWrite(ms: number): void {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.write(), ms);
  }

  /** The outbox, appended to this computer's log as a frame, then cleared up to what was written. */
  private write(): Promise<void> {
    this.writing ??= this.writeNow()
      .catch((error: unknown) => {
        // Whatever it threw, the changes stay in the outbox, and it's tried again.
        console.error('Sync couldn’t write:', error);
        this.writeFailed();
      })
      .finally(() => {
        this.writing = null;
      });
    return this.writing;
  }

  /**
   * What's waiting, appended to this computer's log. Whatever goes wrong, the
   * changes stay in the outbox until they're in the folder: the folder gone,
   * they go once a look finds it; a write that fails, it's tried again later,
   * less and less often, and Settings says so; another computer under this
   * id, or this computer's log gone, this one takes a new id first.
   */
  private async writeNow(): Promise<void> {
    for (;;) {
      const db = this.db();
      const meta = db?.sync.meta;
      if (!db || !meta?.on || meta.joining || meta.paused || !this.key || !this.worker || (this.problem && this.problem !== 'missing') || this.writeProblem === 'copies') return;
      // A copied profile, or a log with no segment yet: a snapshot first, under a new id if this may be a copy.
      if (meta.rebind || !meta.own) {
        const made = meta.rebind ? await this.newId() : await this.snapshotNow(db);
        if (made === 'copied') {
          if (!(await this.newId())) return this.writeFailed();
        } else if (!made) return this.writeFailed();
        continue;
      }
      const { upto, records } = db.sync.outbox();
      if (records.length === 0) return this.writeOk();
      const started = performance.now();
      const reply = await this.ask({ t: 'write', upto, records, device: db.sync.deviceRecords() }, ['written']);
      if (reply.t === 'written') {
        db.sync.timed('frame', performance.now() - started);
        db.sync.timed('frameBytes', reply.bytes);
        db.atomically(() => db.sync.written(reply.upto, reply.own, reply.frames, reply.bytes));
        if (this.problem === 'missing') this.problem = null;
        this.writeOk();
        if (!(await this.compact())) return;
        this.pushStatus();
        continue;
      }
      const problem = reply.t === 'failed' ? reply.problem : 'io';
      if (problem === 'copied' || problem === 'full' || problem === 'gone') {
        // Another computer writes under this one's id (a copied profile), its log has gone (another copy may have
        // compacted it away: S15 §6's copied id), or its segments reached the top: a new id, and its snapshot there.
        // Nothing in the old folder is deleted; until the new snapshot is there, nothing changes here.
        if (await this.newId(problem === 'full')) continue;
        return this.writeFailed();
      }
      if (problem === 'missing') {
        // The folder isn't there (the sync app isn't running): the changes wait, and go once a look finds it.
        this.problem = 'missing';
        this.pushStatus();
        return;
      }
      return this.writeFailed();
    }
  }

  /** Written: writing's problem, if it had one, is over. */
  private writeOk(): void {
    if (this.writeProblem !== 'unwritable') return;
    this.writeProblem = null;
    this.retryMs = 0;
    this.pushStatus();
  }

  /** It couldn't write: it tries again later, less and less often, and Settings says so. The changes stay waiting. */
  private writeFailed(): void {
    if (this.writeProblem !== 'copies') this.writeProblem = 'unwritable';
    this.retryMs = Math.min(WRITE_RETRY_MAX, Math.max(WRITE_RETRY_MS, this.retryMs * 2));
    if (this.writeProblem === 'unwritable') this.scheduleWrite(this.retryMs);
    this.pushStatus();
  }

  /**
   * A new id for this computer: its first snapshot is written under it, and
   * only once that's in the folder does the id become this computer's (and
   * `retireOld`, segments at the top, marks the old one removed). Until then
   * nothing here changes, and a failure leaves things as they were. Past
   * MAX_NEW_IDS a day, another computer keeps writing as this one: it stops
   * writing, and says so.
   */
  private async newId(retireOld = false): Promise<boolean> {
    const db = this.db();
    if (!db) return false;
    const now = Date.now();
    const today = db.sync.meta.newIds.filter((at) => now - at < DAY_MS);
    if (today.length >= MAX_NEW_IDS) {
      this.writeProblem = 'copies';
      this.pushStatus();
      return false;
    }
    const fresh = newDeviceId();
    const device: DataRecord[] = [{ type: 'device', id: fresh, at: [now, 0, fresh], set: { ...localDeviceFields(this.info), removed: false } }];
    const { snapshot, mark, reads } = this.snapshotOf(db, device);
    const reply = await this.ask({ t: 'snapshot', snapshot, as: fresh }, ['snapshotted']);
    this.streams.delete(snapshot.stream);
    if (reply.t !== 'snapshotted') return false;
    const old = db.device();
    db.atomically(() => {
      db.adoptDevice(fresh);
      db.sync.setMeta({ newIds: [...today, now], rebind: false });
      db.sync.snapshotted(reply.own, now, mark, reads);
      if (retireOld) db.sync.stampDevice({ removed: true }, old);
      db.sync.stampDevice({ ...this.info, removed: false });
    });
    this.scheduleWrite(WRITE_MS);
    return true;
  }

  /** At most daily, once this computer's segments outgrow a snapshot: one snapshot replaces them. */
  private async compact(force = false): Promise<boolean> {
    const db = this.db();
    if (!db) return false;
    const meta = db.sync.meta;
    const due = Date.now() - meta.compactedAt >= COMPACT_MS && (meta.bytesSince > 2 * db.sync.snapshotChars() || meta.framesSince > COMPACT_FRAMES);
    if (!force && !due) return true;
    const made = await this.snapshotNow(db);
    // Another computer writes under this id (one of its segments grew past what this one wrote): a new id, deleting nothing.
    if (made === 'copied') return this.newId();
    return true;
  }

  /**
   * Removed computers' folders, once this one has compacted since (S15 §6),
   * judged after a pass (with everything it read merged): the worker removes
   * one only if everything real in it has been read here and nothing in it was
   * made after its removal (it joined again, and that isn't read yet).
   */
  private prune(db: ChordDatabase): void {
    const meta = db.sync.meta;
    const self = db.device();
    for (const device of db.sync.devices()) {
      if (device.removed === null || device.id === self || this.pruned.has(device.id) || device.removed >= meta.compactedAt) continue;
      // Only while everything read from it is in a snapshot of this computer's that landed: read more since (a late
      // delivery), and it waits for the next one, or computers that hadn't read that would never get it.
      if (!db.sync.readCovered(device.id)) continue;
      this.worker?.postMessage({ t: 'prune', device: device.id, removedAt: device.removed } satisfies ToWorker);
    }
  }

  /** The generation this computer moved past by changing the passphrase: its file, and this computer's folder in it, go after 30 days. */
  private retire(): void {
    const db = this.db();
    const retired = db?.sync.meta.retired;
    if (!db || !retired || Date.now() - retired.at < RETIRE_MS) return;
    this.worker?.postMessage({ t: 'remove', path: `sync-${retired.generation}.json` } satisfies ToWorker);
    this.worker?.postMessage({ t: 'remove', path: `${retired.generation}/${db.device()}` } satisfies ToWorker);
    db.sync.setMeta({ retired: null });
  }

  /* ---------- where it stands ---------- */

  status(): SyncStatus {
    const db = this.db();
    if (!db) return SYNC_OFF;
    const meta = db.sync.meta;
    // Off: changes made while it was on that never reached the folder still wait, and Settings says so.
    if (!meta.on) return meta.removedAt ? { ...SYNC_OFF, state: 'problem', problem: 'removed', removedAt: meta.removedAt, folder: meta.folder, pending: db.sync.outboxSize() } : { ...SYNC_OFF, pending: db.sync.outboxSize() };
    const self = db.device();
    const devices = db.sync.devices();
    const now = Date.now();
    const computers = devices
      .filter((d) => d.removed === null)
      .map((d) => ({ id: d.id, name: d.id === self ? meta.name || d.name : d.name, os: d.os, app: d.app, self: d.id === self, lastSync: d.id === self ? null : (this.seen.get(d.id) ?? null) }))
      .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    let lastChange: SyncStatus['lastChange'] = null;
    for (const [device, at] of this.newest) {
      if (device === self || (lastChange && lastChange.at >= at)) continue;
      lastChange = { name: devices.find((d) => d.id === device)?.name ?? 'Another computer', at };
    }
    // A clock ahead, from what each computer says of itself (when it made its newest segment), never from stamps a change was bumped to.
    const ahead = [...this.wrote].filter(([device, at]) => device !== self && at > now + CLOCK_AHEAD_MS).map(([device, at]) => ({ name: devices.find((d) => d.id === device)?.name ?? 'Another computer', ms: at - now }));
    const problem = this.problem ?? (this.stalled ? 'stalled' : null) ?? this.writeProblem ?? this.readProblem;
    const state: SyncStatus['state'] = meta.joining ? 'choosing' : meta.paused ? 'paused' : !this.key ? 'locked' : problem ? 'problem' : 'on';
    return {
      state,
      problem: state === 'problem' ? problem : null,
      folder: meta.folder,
      computers,
      lastChange,
      pending: db.sync.outboxSize(),
      ahead,
      changedBy: this.problem === 'changed' ? this.changedBy : null,
      removedAt: null,
      capped: this.capped,
      refused: this.refused,
      tooMany: this.tooMany,
      cluttered: this.cluttered,
      stuck: [...this.stuck.values()],
      blocked: [...this.blocked].map((device) => devices.find((d) => d.id === device)?.name ?? 'Another computer'),
      choosing: meta.joining ? { here: db.sync.chordsHere(), synced: db.sync.syncedChords().length } : null,
    };
  }

  private pushStatus(): void {
    try {
      const db = this.db();
      this.push({ push: 'sync.status', status: db ? this.step(db, 'status', () => this.status()) : this.status() });
    } catch (error) {
      console.error('Sync couldn’t say where it stands:', error);
    }
  }

  /* ---------- requests from main ---------- */

  async handle(request: SyncRequest): Promise<SyncReply> {
    const db = this.db();
    if (!db) throw new Error('chord-data: sync before open');
    switch (request.type) {
      case 'sync.status':
        return { status: this.step(db, 'status', () => this.status()), keyBlob: db.sync.keyBlob() };
      case 'sync.inspect':
        return { inspection: await this.inspect(request.folder) };
      case 'sync.setup':
        return this.setup(db, request.folder, request.passphrase, request.info);
      case 'sync.join':
        return this.join(db, request.folder, request.passphrase, request.info);
      case 'sync.choose':
        return this.choose(db, request.mode);
      case 'sync.start':
        this.key = request.key;
        this.info = request.info;
        this.startWorker();
        return { status: this.status() };
      case 'sync.applied': {
        // Main applied these versions and wrote them back (or saw nothing of them apply here): not pushed again, unless
        // they change. Ones it put off for a change of its own waiting aren't, and come again.
        const held = new Set(db.sync.thingsFor(request.later).keys());
        const versions = Object.fromEntries(Object.entries(request.versions).filter(([key]) => !held.has(key)));
        this.step(db, 'applied', () => db.atomically(() => db.sync.markApplied(versions)));
        return {};
      }
      case 'sync.reconcile':
        // After a launch (or chord-data starting again), and after main couldn't apply something: what's merged but not applied, again.
        void this.reconcile().catch(() => this.readFailed());
        return {};
      case 'sync.unlock':
        this.info = request.info;
        // Its key couldn't be read here: this profile may be a copy of another computer's, so it takes a new id before it writes.
        if (request.rebind && db.sync.meta.on) db.sync.setMeta({ rebind: true });
        return this.unlock(db, request.passphrase);
      case 'sync.passphrase':
        return this.rekey(db, request.passphrase);
      case 'sync.off':
        await this.off(db);
        return { status: this.status() };
      case 'sync.remove':
        db.atomically(() => db.sync.stampDevice({ removed: true }, request.device));
        this.scheduleWrite(0);
        return { status: this.status() };
      case 'sync.rename': {
        const name = request.name.trim().slice(0, 100);
        if (name) {
          this.info.name = name;
          db.atomically(() => {
            db.sync.setMeta({ name });
            db.sync.stampDevice({ name });
          });
          this.scheduleWrite(WRITE_MS);
        }
        return { status: this.status() };
      }
      case 'sync.pause':
        db.sync.setMeta({ paused: request.paused });
        if (request.paused) this.stopWorker();
        else this.startWorker();
        return { status: this.status() };
      case 'sync.check':
        this.read();
        return {};
      case 'sync.front':
        this.front = request.front;
        this.worker?.postMessage({ t: 'front', front: request.front } satisfies ToWorker);
        return {};
      case 'sync.flush':
        clearTimeout(this.writeTimer);
        await this.write();
        return {};
      case 'sync.repush':
        for (const [key, names] of db.sync.thingsFor(request.keys)) this.changes.set(key, names);
        // After any merge under way, in order with it.
        this.chain(() => this.pushChanges());
        return {};
      case 'sync.timings':
        return { timings: db.sync.timings };
      case 'sync.relocate':
        return this.relocate(db, request.folder);
      case 'sync.startOver':
        this.info = request.info;
        return this.startOver(db, request.passphrase);
      case 'sync.key':
        return this.key ? { key: new Uint8Array(this.key) } : { problem: 'missing' };
      case 'sync.keyBlob':
        db.sync.setKeyBlob(request.blob);
        return {};
    }
  }

  private async inspect(folder: string): Promise<FolderInspection> {
    const reply = await this.ask({ t: 'inspect', folder }, ['inspected']);
    if (!this.db()?.sync.meta.on) this.stopWorker();
    return reply.t === 'inspected' ? reply.inspection : { state: 'damaged' };
  }

  /** The first computer (S15 §6): the folder's file, then this computer's setup as its first segment, a snapshot. */
  private async setup(db: ChordDatabase, folder: string, passphrase: string, info: SyncInfo): Promise<SyncReply> {
    if (db.sync.meta.on) return { problem: 'busy' };
    const inspection = await this.inspect(folder);
    if (inspection.state !== 'new') return { problem: inspection.state === 'join' ? 'conflict' : inspection.state };
    this.info = info;
    db.sync.clear();
    db.atomically(() => {
      db.sync.setMeta({ on: true, joining: false, folder, generation: inspection.generation, name: info.name, own: null, compactedAt: Date.now() });
      db.sync.addLocal('all');
      db.sync.readmitOutbox();
      db.sync.stampDevice({ ...info, removed: false });
    });
    const { snapshot, mark } = this.snapshotOf(db);
    const reply = await this.ask({ t: 'setup', folder, generation: inspection.generation, passphrase, device: db.device(), app: info.app, snapshot }, ['set-up']);
    this.streams.delete(snapshot.stream);
    if (reply.t !== 'set-up') {
      db.sync.clear();
      this.stopWorker();
      return { problem: reply.t === 'failed' && reply.problem === 'conflict' ? 'conflict' : 'io' };
    }
    db.atomically(() => db.sync.snapshotted(reply.own, Date.now(), mark));
    this.key = reply.key;
    this.problem = null;
    this.startWorker();
    return { key: reply.key, status: this.status() };
  }

  /** Another computer joins (S15 §6): the passphrase opens the newest generation, and every computer's log is read and merged, nothing applied yet. */
  private async join(db: ChordDatabase, folder: string, passphrase: string, info: SyncInfo): Promise<SyncReply> {
    if (db.sync.meta.on && !db.sync.meta.joining) return { problem: 'busy' };
    const inspection = await this.inspect(folder);
    if (inspection.state !== 'join') return { problem: inspection.state === 'new' ? 'missing' : inspection.state };
    const opened = await this.ask({ t: 'unlock', folder, passphrase }, ['unlocked']);
    if (opened.t !== 'unlocked') {
      if (!db.sync.meta.on) this.stopWorker();
      return { problem: opened.t === 'failed' ? stepProblem(opened.problem) : 'io' };
    }
    this.info = info;
    this.stopWorker();
    db.sync.clear();
    db.sync.setMeta({ on: true, joining: true, folder, generation: opened.generation, name: info.name, own: null, compactedAt: Date.now() });
    this.key = opened.key;
    this.problem = null;
    this.changes.clear();
    let read = new Promise<void>((resolve) => (this.passDone = resolve));
    this.startWorker();
    await read;
    // More of the folder to look through (a big one, or junk): the passes that go on from there, so joining gets the
    // whole setup; a folder full of junk is said in Settings instead.
    for (let pass = 1; pass < JOIN_PASSES && this.unfinished && !this.cluttered && !this.problem && !this.stalled; pass++) {
      read = new Promise<void>((resolve) => (this.passDone = resolve));
      await read;
    }
    // The folder stopped answering partway: nothing's joined, and Settings says it couldn't use the folder.
    const problem = this.problem as SyncProblem | null;
    if (problem || this.stalled) {
      this.stopWorker();
      db.sync.clear();
      this.key = null;
      return { problem: problem === 'changed' ? 'wrong' : problem === 'missing' || problem === 'newer' || problem === 'conflict' ? problem : 'io' };
    }
    return { key: opened.key, fresh: this.step(db, 'fresh', () => db.sync.fresh()), status: this.status() };
  }

  /** Joining, decided: this computer's setup joins the synced one (`both`), or makes way for it (`synced`); then its first segment, a snapshot. */
  private async choose(db: ChordDatabase, mode: 'synced' | 'both'): Promise<SyncReply> {
    if (!db.sync.meta.joining) return { problem: 'busy' };
    // This computer's things into the copy, a slice at a time, searches answered between (still joining: nothing's stamped meanwhile).
    const local = this.step(db, 'local', () => db.sync.localThings());
    for (let at = 0; at < local.length; at += PLAN_SLICE) {
      this.step(db, 'add', () => db.atomically(() => db.sync.addLocal(mode === 'synced' ? 'synced-setup' : 'all', local.slice(at, at + PLAN_SLICE))));
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.step(db, 'joined', () =>
      db.atomically(() => {
        db.sync.readmitOutbox();
        db.sync.stampDevice({ ...this.info, removed: false });
        db.sync.setMeta({ joining: false });
      }),
    );
    this.changes.clear();
    // Everything the synced setup has, read back a slice at a time, searches answered between, as one apply.
    const apply = emptyApply();
    const all = new Map<string, Set<string>>();
    const everything = db.sync.everythingPages();
    for (let page = this.step(db, 'everything', () => everything.next()); !page.done; page = this.step(db, 'everything', () => everything.next())) {
      for (const [key, names] of page.value) all.set(key, names);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const ordered = this.step(db, 'order', () => db.sync.orderForApply(all));
    const versions: Record<string, string> = {};
    for (let at = 0; at < ordered.length; at += PLAN_SLICE) {
      const started = performance.now();
      const slice = new Map(ordered.slice(at, at + PLAN_SLICE));
      const part = db.sync.planFor(slice);
      Object.assign(versions, db.sync.versions(slice.keys()));
      db.sync.timed('plan', performance.now() - started);
      for (const key of ['chords', 'nodes', 'favorites', 'themes', 'routes', 'effects'] as const) (apply[key] as unknown[]).push(...part[key]);
      for (const key of Object.keys(apply.gone) as (keyof SyncApply['gone'])[]) (apply.gone[key] as unknown[]).push(...part.gone[key]);
      if (part.settings) apply.settings = { ...apply.settings, ...part.settings };
      if (at + PLAN_SLICE < ordered.length) await new Promise((resolve) => setImmediate(resolve));
    }
    const synced = this.step(db, 'synced', () => db.sync.syncedChords());
    const replace = mode === 'synced' && synced[0] ? { to: synced[0], keep: synced } : null;
    await this.snapshotNow(db);
    // Main writes all of it back next: checkpoints stay on the worker's connection meanwhile, never chord-data's thread.
    this.busyFor(db);
    this.pushStatus();
    return { apply, replace, versions, status: this.status() };
  }

  /** The passphrase, once (no key kept here, or it changed on another computer): a newer generation is moved to with a snapshot. */
  private async unlock(db: ChordDatabase, passphrase: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || !meta.folder) return { problem: 'missing' };
    const opened = await this.ask({ t: 'unlock', folder: meta.folder, passphrase }, ['unlocked']);
    if (opened.t !== 'unlocked') return { problem: opened.t === 'failed' ? stepProblem(opened.problem) : 'io' };
    this.key = opened.key;
    this.problem = null;
    if (opened.generation > meta.generation) {
      // The passphrase changed on another computer: this one moves to the new generation, with a snapshot there, and its old folder goes.
      // No read runs meanwhile: the worker reads again only once this computer is in the new generation.
      this.stopWorker();
      const { snapshot, mark } = this.snapshotOf(db);
      const moved = await this.ask({ t: 'move', folder: meta.folder, from: meta.generation, to: opened.generation, device: db.device(), key: opened.key, app: this.info.app, snapshot }, ['moved']);
      this.streams.delete(snapshot.stream);
      if (moved.t !== 'moved') {
        this.key = null;
        return { problem: 'io' };
      }
      db.atomically(() => {
        db.sync.setMeta({ generation: opened.generation });
        db.sync.snapshotted(moved.own, Date.now(), mark);
      });
    }
    this.startWorker();
    // A profile that may be a copy of another computer's takes a new id now, writing or not: under its own id, it reads
    // the other's log as another computer's. Should that fail, its next write tries again first.
    // Through writing's own queue, so a write already under way doesn't take a second new id.
    if (db.sync.meta.rebind) await this.write();
    return { key: opened.key, status: this.status() };
  }

  /** The folder moved (*Chord can't find the sync folder*, then *Choose folder…*): this one, only if it's this sync's. */
  private async relocate(db: ChordDatabase, folder: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || !this.key) return { problem: 'missing' };
    const looked = await this.ask({ t: 'look', folder, generation: meta.generation, key: this.key }, ['looked']);
    // Its generation's file opens with this computer's key, or a newer generation is there (the passphrase changed meanwhile).
    if (looked.t !== 'looked' || (looked.look.state !== 'ok' && looked.look.state !== 'changed')) return { problem: looked.t === 'looked' && looked.look.state === 'newer' ? 'newer' : 'wrong' };
    this.stopWorker();
    db.sync.setMeta({ folder });
    this.problem = null;
    this.startWorker();
    return { status: this.status() };
  }

  /**
   * A lost passphrase (S15 §6, *Start over*): the next generation in the same
   * folder, under a new passphrase, without the old key; this computer's
   * snapshot goes there. The synced copy under the old one is gone; each
   * computer's data isn't, and the others pause until they have the new one.
   */
  private async startOver(db: ChordDatabase, passphrase: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || meta.joining || !meta.folder) return { problem: 'missing' };
    this.stopWorker();
    const { snapshot, mark } = this.snapshotOf(db);
    const reply = await this.ask({ t: 'restart', folder: meta.folder, from: meta.generation, passphrase, device: db.device(), app: this.info.app, snapshot }, ['restarted']);
    this.streams.delete(snapshot.stream);
    if (reply.t !== 'restarted') return { problem: 'io' };
    db.atomically(() => {
      db.sync.setMeta({ generation: reply.generation, retired: { generation: meta.generation, at: Date.now() } });
      db.sync.snapshotted(reply.own, Date.now(), mark);
    });
    this.key = reply.key;
    this.problem = null;
    this.startWorker();
    return { key: reply.key, status: this.status() };
  }

  /**
   * A new passphrase (S15 §6): the next generation's file; then this computer
   * says so in its log under the old one (sealed, so the others can name it
   * when they pause), then its snapshot under the new one. Its old folder stays
   * until the old file goes (30 days), so the others can read what it said.
   */
  private async rekey(db: ChordDatabase, passphrase: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || !this.key || !this.worker) return { problem: 'missing' };
    const filed = await this.ask({ t: 'rekey-file', passphrase }, ['rekey-filed']);
    if (filed.t !== 'rekey-filed') return { problem: 'io' };
    // Until it has moved, a look that finds the new generation finds this computer's own: not a reason to pause.
    this.moving = filed.generation;
    let moved: FromWorker;
    let mark = 0;
    try {
      db.atomically(() => db.sync.stampDevice({ rekeyed: filed.generation }));
      clearTimeout(this.writeTimer);
      await this.write();
      const { snapshot, mark: taken } = this.snapshotOf(db);
      mark = taken;
      moved = await this.ask({ t: 'rekey-move', generation: filed.generation, key: filed.key, snapshot }, ['rekeyed']);
      this.streams.delete(snapshot.stream);
    } finally {
      this.moving = null;
    }
    if (moved.t !== 'rekeyed') return { problem: 'io' };
    db.atomically(() => {
      db.sync.setMeta({ generation: filed.generation, retired: { generation: meta.generation, at: Date.now() } });
      db.sync.snapshotted(moved.own, Date.now(), mark);
    });
    this.key = filed.key;
    return { key: filed.key, status: this.status() };
  }

  /** Turning off removes this computer, from itself (S15 §6): its device record says so, written before it stops. Its data stays. */
  private async off(db: ChordDatabase): Promise<void> {
    if (db.sync.meta.on && !db.sync.meta.joining && this.key) {
      db.atomically(() => db.sync.stampDevice({ removed: true }));
      clearTimeout(this.writeTimer);
      // At most a few seconds: what doesn't reach the folder stays in the outbox, and goes when sync is on again.
      await Promise.race([this.write(), new Promise((resolve) => setTimeout(resolve, OFF_WRITE_MS).unref?.())]);
    }
    this.stopWorker();
    this.key = null;
    this.problem = null;
    this.changes.clear();
    this.capped = this.refused = 0;
    this.tooMany = this.cluttered = this.unfinished = false;
    this.writeProblem = null;
    this.retryMs = 0;
    this.readOk();
    this.blocked.clear();
    this.pruned.clear();
    this.stuck.clear();
    this.wrote.clear();
    db.sync.clear();
  }

  /** chord-data is closing: the worker goes, with the key. */
  close(): void {
    clearTimeout(this.readRetry);
    for (const worker of this.stuckWorkers) void worker.terminate();
    this.stuckWorkers.clear();
    this.stopWorker();
    this.key?.fill(0);
    this.key = null;
  }
}

