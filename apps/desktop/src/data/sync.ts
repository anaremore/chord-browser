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
import { applyIsEmpty, CLOCK_AHEAD_MS, emptyApply, SYNC_OFF, type FolderInspection, type SyncApply, type SyncProblem, type SyncStatus } from '@chord/core';
import type { DataPush, SyncInfo, SyncReply, SyncRequest } from '@chord/data';
import type { ChordDatabase } from '@chord/data/db';
import type { FromWorker, ToWorker } from './sync-worker';

/** Changes are written this long after the last one (S15 §6), so a burst of them is one frame. */
const WRITE_MS = 3000;
/** Records merged per transaction, and changed things read back for main per push: a few milliseconds each, with searches answered between them. */
const SLICE = 100;
const PLAN_SLICE = 100;
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

type Ask = { kinds: ReadonlySet<FromWorker['t']>; for: ToWorker['t']; resolve(message: FromWorker): void };

export class SyncController {
  private worker: Worker | null = null;
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
  private problem: SyncProblem | null = null;
  private changedBy: string | null = null;
  private capped = 0;
  private passDone: (() => void) | null = null;
  /** Merges one batch at a time, in order. */
  private merging: Promise<void> = Promise.resolve();
  /** Checkpoints are small while sync is busy (BUSY_MS). */
  private busy: { db: ChordDatabase; timer: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null = null;

  constructor(
    private readonly db: () => ChordDatabase | null,
    private readonly push: (message: DataPush) => void,
    private readonly workerPath = join(import.meta.dirname, 'sync.js'),
  ) {}

  /* ---------- the worker ---------- */

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath, { name: 'Sync' });
    worker.on('message', (message: FromWorker) => this.heard(message));
    worker.on('error', (error) => {
      console.error('Sync worker failed:', error);
      this.worker = null;
      for (const ask of this.asks.splice(0)) ask.resolve({ t: 'failed', problem: 'io', for: ask.for });
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
    });
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

  private heard(message: FromWorker): void {
    const ask = this.asks[0];
    if (ask && (ask.kinds.has(message.t) || (message.t === 'failed' && message.for === ask.for))) {
      this.asks.shift();
      ask.resolve(message);
      return;
    }
    switch (message.t) {
      case 'records':
        this.merging = this.merging.then(() => this.merge(message));
        return;
      case 'newer':
        this.problem = 'newer';
        return;
      case 'pass-done':
        this.merging = this.merging.then(() => this.passed(message));
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

  private stopWorker(): void {
    clearTimeout(this.writeTimer);
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
    } satisfies ToWorker);
    if (db.sync.outboxSize() > 0) this.scheduleWrite(0);
  }

  /** Look at the folder now (Chord came to the front, or the folder changed). */
  read(): void {
    if (this.worker && this.key && !this.db()?.sync.meta.paused) this.worker.postMessage({ t: 'read' } satisfies ToWorker);
  }

  /* ---------- reading ---------- */

  private async merge(message: Extract<FromWorker, { t: 'records' }>): Promise<void> {
    const db = this.db();
    try {
      if (!db) return;
      if (message.records.length > 0) this.busyFor(db);
      const { generation } = db.sync.meta;
      const now = Date.now();
      for (let at = 0; at === 0 || at < message.records.length; at += SLICE) {
        // Removed meanwhile (an earlier slice said so): nothing more is merged.
        if (!db.sync.meta.on) break;
        const slice = message.records.slice(at, at + SLICE);
        const last = at + SLICE >= message.records.length;
        const started = performance.now();
        const result = db.atomically(() => {
          const merged = db.sync.merge(slice, now);
          if (last) db.sync.saveCursor(generation, message.device, message.segment, message.cursor);
          return merged;
        });
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
    } catch (error) {
      console.error('Sync couldn’t merge what it read:', error);
    } finally {
      this.worker?.postMessage({ t: 'ack' } satisfies ToWorker);
    }
  }

  private async passed(message: Extract<FromWorker, { t: 'pass-done' }>): Promise<void> {
    const db = this.db();
    if (!db) return;
    for (const [device, at] of Object.entries(message.seen)) this.seen.set(device, at);
    const look = message.look;
    if (look.state === 'ok') {
      if (this.problem !== 'newer') this.problem = null;
    } else if (look.state === 'changed') {
      this.problem = 'changed';
      this.changedBy = db.sync.devices().find((d) => d.id === look.by)?.name ?? null;
    } else this.problem = look.state;
    if (this.problem === 'conflict' || this.problem === 'changed' || this.problem === 'newer') this.stopWorker();
    const done = this.passDone;
    this.passDone = null;
    if (!db.sync.meta.joining) await this.pushChanges();
    this.retire();
    this.pushStatus();
    done?.();
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
    const ordered = db.sync.orderForApply(this.changes);
    this.changes = new Map();
    for (let at = 0; at < ordered.length; at += PLAN_SLICE) {
      const started = performance.now();
      const apply = db.sync.planFor(new Map(ordered.slice(at, at + PLAN_SLICE)));
      db.sync.timed('plan', performance.now() - started);
      if (!applyIsEmpty(apply)) this.push({ push: 'sync.apply', apply });
      if (at + PLAN_SLICE < ordered.length) await new Promise((resolve) => setImmediate(resolve));
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
    const timer = setTimeout(() => {
      if (this.busy?.timer === timer) this.quiet();
    }, BUSY_MS);
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
  }

  private scheduleWrite(ms: number): void {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.write(), ms);
  }

  /** The outbox, appended to this computer's log as a frame, then cleared up to what was written. */
  private write(): Promise<void> {
    this.writing ??= this.writeNow().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  private async writeNow(): Promise<void> {
    for (;;) {
      const db = this.db();
      const meta = db?.sync.meta;
      if (!db || !meta?.on || meta.joining || meta.paused || !meta.own || !this.key || !this.worker || (this.problem && this.problem !== 'missing')) return;
      const { upto, records } = db.sync.outbox();
      if (records.length === 0) return;
      const started = performance.now();
      const reply = await this.ask({ t: 'write', upto, records, device: db.sync.deviceRecords() }, ['written']);
      if (reply.t === 'written') {
        db.sync.timed('frame', performance.now() - started);
        db.sync.timed('frameBytes', reply.bytes);
        db.atomically(() => db.sync.written(reply.upto, reply.own, reply.frames, reply.bytes));
        if (this.problem === 'missing') this.problem = null;
        await this.compact();
        this.pushStatus();
        continue;
      }
      if (reply.t === 'failed' && reply.problem === 'copied') {
        await this.newId();
        continue;
      }
      // The folder isn't there (the sync app isn't running): the changes wait in the outbox for the next try.
      this.problem = 'missing';
      this.pushStatus();
      return;
    }
  }

  /** Another computer writes under this one's id (a copied profile): this one takes a new id, and starts its log again. */
  private async newId(): Promise<void> {
    const db = this.db();
    if (!db) return;
    db.newDevice();
    db.atomically(() => {
      db.sync.forgetOwn();
      db.sync.stampDevice({ ...this.info, removed: false });
    });
    this.stopWorker();
    this.startWorker();
    const reply = await this.ask({ t: 'snapshot', records: db.sync.snapshot() }, ['snapshotted']);
    if (reply.t === 'snapshotted') db.atomically(() => db.sync.snapshotted(reply.own, Date.now()));
  }

  /** At most daily, once this computer's segments outgrow a snapshot: one snapshot replaces them, and removed computers' folders go. */
  private async compact(force = false): Promise<void> {
    const db = this.db();
    if (!db) return;
    const meta = db.sync.meta;
    const due = Date.now() - meta.compactedAt >= COMPACT_MS && (meta.bytesSince > 2 * db.sync.snapshotChars() || meta.framesSince > COMPACT_FRAMES);
    if (!force && !due) return;
    const reply = await this.ask({ t: 'snapshot', records: db.sync.snapshot() }, ['snapshotted']);
    if (reply.t !== 'snapshotted') return;
    db.atomically(() => db.sync.snapshotted(reply.own, Date.now()));
    // Once removed, and with a snapshot written since, a computer's folder may go (S15 §6).
    for (const device of db.sync.devices()) {
      if (device.removed !== null && device.id !== db.device()) this.worker?.postMessage({ t: 'remove', path: `${meta.generation}/${device.id}` } satisfies ToWorker);
    }
  }

  /** The generation this computer moved past by changing the passphrase: its file goes after 30 days. */
  private retire(): void {
    const db = this.db();
    const retired = db?.sync.meta.retired;
    if (!db || !retired || Date.now() - retired.at < RETIRE_MS) return;
    this.worker?.postMessage({ t: 'remove', path: `sync-${retired.generation}.json` } satisfies ToWorker);
    db.sync.setMeta({ retired: null });
  }

  /* ---------- where it stands ---------- */

  status(): SyncStatus {
    const db = this.db();
    if (!db) return SYNC_OFF;
    const meta = db.sync.meta;
    if (!meta.on) return meta.removedAt ? { ...SYNC_OFF, state: 'problem', problem: 'removed', removedAt: meta.removedAt, folder: meta.folder } : SYNC_OFF;
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
    const ahead = [...this.newest].filter(([device, at]) => device !== self && at > now + CLOCK_AHEAD_MS).map(([device, at]) => ({ name: devices.find((d) => d.id === device)?.name ?? 'Another computer', ms: at - now }));
    const state: SyncStatus['state'] = meta.joining ? 'choosing' : meta.paused ? 'paused' : !this.key ? 'locked' : this.problem ? 'problem' : 'on';
    return {
      state,
      problem: state === 'problem' ? this.problem : null,
      folder: meta.folder,
      computers,
      lastChange,
      pending: db.sync.outboxSize(),
      ahead,
      changedBy: this.problem === 'changed' ? this.changedBy : null,
      removedAt: null,
      capped: this.capped,
      choosing: meta.joining ? { here: (db.sync.localThings().filter((r) => r.type === 'chord').length), synced: db.sync.syncedChords().length } : null,
    };
  }

  private pushStatus(): void {
    this.push({ push: 'sync.status', status: this.status() });
  }

  /* ---------- requests from main ---------- */

  async handle(request: SyncRequest): Promise<SyncReply> {
    const db = this.db();
    if (!db) throw new Error('chord-data: sync before open');
    switch (request.type) {
      case 'sync.status':
        return { status: this.status(), keyBlob: db.sync.keyBlob() };
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
      case 'sync.unlock':
        this.info = request.info;
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
      case 'sync.flush':
        clearTimeout(this.writeTimer);
        await this.write();
        return {};
      case 'sync.repush':
        for (const [key, names] of db.sync.thingsFor(request.keys)) this.changes.set(key, names);
        // After any merge under way, in order with it.
        this.merging = this.merging.then(() => this.pushChanges());
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
      db.sync.stampDevice({ ...info, removed: false });
    });
    const reply = await this.ask({ t: 'setup', folder, generation: inspection.generation, passphrase, device: db.device(), app: info.app, records: db.sync.snapshot() }, ['set-up']);
    if (reply.t !== 'set-up') {
      db.sync.clear();
      this.stopWorker();
      return { problem: reply.t === 'failed' && reply.problem === 'conflict' ? 'conflict' : 'io' };
    }
    db.atomically(() => db.sync.snapshotted(reply.own, Date.now()));
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
      return { problem: opened.t === 'failed' ? (opened.problem === 'copied' ? 'io' : opened.problem) : 'io' };
    }
    this.info = info;
    this.stopWorker();
    db.sync.clear();
    db.sync.setMeta({ on: true, joining: true, folder, generation: opened.generation, name: info.name, own: null, compactedAt: Date.now() });
    this.key = opened.key;
    this.problem = null;
    this.changes.clear();
    const read = new Promise<void>((resolve) => (this.passDone = resolve));
    this.startWorker();
    await read;
    if (this.problem) {
      const problem = this.problem;
      this.stopWorker();
      db.sync.clear();
      this.key = null;
      return { problem: problem === 'changed' ? 'wrong' : problem === 'removed' ? 'io' : problem };
    }
    return { key: opened.key, fresh: db.sync.fresh(), status: this.status() };
  }

  /** Joining, decided: this computer's setup joins the synced one (`both`), or makes way for it (`synced`); then its first segment, a snapshot. */
  private async choose(db: ChordDatabase, mode: 'synced' | 'both'): Promise<SyncReply> {
    if (!db.sync.meta.joining) return { problem: 'busy' };
    db.atomically(() => {
      db.sync.addLocal(mode === 'synced' ? 'synced-setup' : 'all');
      db.sync.stampDevice({ ...this.info, removed: false });
      db.sync.setMeta({ joining: false });
    });
    this.changes.clear();
    // Everything the synced setup has, read back a slice at a time, searches answered between, as one apply.
    const apply = emptyApply();
    const ordered = db.sync.orderForApply(db.sync.everything());
    for (let at = 0; at < ordered.length; at += PLAN_SLICE) {
      const started = performance.now();
      const part = db.sync.planFor(new Map(ordered.slice(at, at + PLAN_SLICE)));
      db.sync.timed('plan', performance.now() - started);
      for (const key of ['chords', 'nodes', 'favorites', 'themes', 'routes', 'effects'] as const) (apply[key] as unknown[]).push(...part[key]);
      for (const key of Object.keys(apply.gone) as (keyof SyncApply['gone'])[]) (apply.gone[key] as unknown[]).push(...part.gone[key]);
      if (part.settings) apply.settings = { ...apply.settings, ...part.settings };
      if (at + PLAN_SLICE < ordered.length) await new Promise((resolve) => setImmediate(resolve));
    }
    const synced = db.sync.syncedChords();
    const replace = mode === 'synced' && synced[0] ? { to: synced[0], keep: synced } : null;
    const reply = await this.ask({ t: 'snapshot', records: db.sync.snapshot() }, ['snapshotted']);
    if (reply.t === 'snapshotted') db.atomically(() => db.sync.snapshotted(reply.own, Date.now()));
    this.pushStatus();
    return { apply, replace, status: this.status() };
  }

  /** The passphrase, once (no key kept here, or it changed on another computer): a newer generation is moved to with a snapshot. */
  private async unlock(db: ChordDatabase, passphrase: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || !meta.folder) return { problem: 'missing' };
    const opened = await this.ask({ t: 'unlock', folder: meta.folder, passphrase }, ['unlocked']);
    if (opened.t !== 'unlocked') return { problem: opened.t === 'failed' && opened.problem !== 'copied' ? opened.problem : 'io' };
    this.key = opened.key;
    this.problem = null;
    if (opened.generation > meta.generation) {
      // The passphrase changed on another computer: this one moves to the new generation, with a snapshot there, and its old folder goes.
      // No read runs meanwhile: the worker reads again only once this computer is in the new generation.
      this.stopWorker();
      const moved = await this.ask(
        { t: 'move', folder: meta.folder, from: meta.generation, to: opened.generation, device: db.device(), key: opened.key, app: this.info.app, records: db.sync.snapshot() },
        ['moved'],
      );
      if (moved.t !== 'moved') {
        this.key = null;
        return { problem: 'io' };
      }
      db.atomically(() => {
        db.sync.setMeta({ generation: opened.generation });
        db.sync.snapshotted(moved.own, Date.now());
      });
    }
    this.startWorker();
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
    const reply = await this.ask({ t: 'restart', folder: meta.folder, from: meta.generation, passphrase, device: db.device(), app: this.info.app, records: db.sync.snapshot() }, ['restarted']);
    if (reply.t !== 'restarted') return { problem: 'io' };
    db.atomically(() => {
      db.sync.setMeta({ generation: reply.generation, retired: { generation: meta.generation, at: Date.now() } });
      db.sync.snapshotted(reply.own, Date.now());
    });
    this.key = reply.key;
    this.problem = null;
    this.startWorker();
    return { key: reply.key, status: this.status() };
  }

  /** A new passphrase (S15 §6): the next generation, with this computer's snapshot; the others pause until they have it. */
  private async rekey(db: ChordDatabase, passphrase: string): Promise<SyncReply> {
    const meta = db.sync.meta;
    if (!meta.on || !this.key || !this.worker) return { problem: 'missing' };
    const reply = await this.ask({ t: 'rekey', passphrase, records: db.sync.snapshot() }, ['rekeyed']);
    if (reply.t !== 'rekeyed') return { problem: 'io' };
    db.atomically(() => {
      db.sync.setMeta({ generation: reply.generation, retired: { generation: meta.generation, at: Date.now() } });
      db.sync.snapshotted(reply.own, Date.now());
    });
    this.key = reply.key;
    return { key: reply.key, status: this.status() };
  }

  /** Turning off removes this computer, from itself (S15 §6): its device record says so, written before it stops. Its data stays. */
  private async off(db: ChordDatabase): Promise<void> {
    if (db.sync.meta.on && !db.sync.meta.joining && this.key) {
      db.atomically(() => db.sync.stampDevice({ removed: true }));
      clearTimeout(this.writeTimer);
      await this.write();
    }
    this.stopWorker();
    this.key = null;
    this.problem = null;
    this.changes.clear();
    db.sync.clear();
  }

  /** chord-data is closing: the worker goes, with the key. */
  close(): void {
    this.stopWorker();
    this.key?.fill(0);
    this.key = null;
  }
}

