/**
 * One computer in the sync simulation: main's side (the store, persistence,
 * SyncService) and chord-data's (a real chord.db, the SyncController, and
 * the worker's own code, run in-process over the computer's view of the
 * folder), wired as the app wires them, with messages copied as threads and
 * processes copy them. It can quit, crash at any moment (everything in memory
 * dropped; chord.db, its view of the folder and chord-data's own file stay),
 * and launch again from chord.db.
 */
import { scryptSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { apply, restoreState, seedState, type Command, type State } from '@chord/core';
import { opKey, originOf, type DataPush, type DataRequest, type DataResponse, type WriteOp } from '@chord/data';
import { nodeCrypto } from '@chord/data/crypto';
import { ChordDatabase } from '@chord/data/db';
import type { SyncView, Toast } from '@chord/ipc';
import { SyncController, type WorkerLike } from '../../src/data/sync';
import { createSyncWorker, type ToWorker } from '../../src/data/sync-worker-core';
import { writeBatch } from '../../src/data/writes';
import { Persistence } from '../../src/main/persistence';
import { SyncService } from '../../src/main/sync';
import { hooks } from './electron';
import type { LocalFolder } from './folder';

export const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
export const PASSPHRASE = 'harbor lantern quietly orbit maple';
const INFO = { os: 'Linux', app: '0.5.0' };

/** scrypt as cheap as it goes, and done at once: the cost isn't what's tested, and nothing outside fake time may wait. */
const simCrypto: typeof nodeCrypto = { ...nodeCrypto, scrypt: async (passphrase, salt, _params, length) => new Uint8Array(scryptSync(passphrase, salt, length, { N: 1024, r: 8, p: 1 })) };

/** What a computer tells the simulation: each change to its state, with the command that made it. */
export type Observer = (computer: Computer, command: Command, before: State, after: State) => void;

interface Life {
  alive: boolean;
  data: SimData | null;
  persistence: Persistence | null;
  service: SyncService | null;
}

/** chord-data's process, in-process: requests answered as worker.ts answers them. */
class SimData extends EventEmitter {
  db: ChordDatabase | null = null;
  dead = false;
  readonly controller: SyncController;

  constructor(private readonly computer: Computer) {
    super();
    this.controller = new SyncController(
      () => (this.dead ? null : this.db),
      (push) => this.send(push),
      () => new SimWorker(computer, this) as unknown as WorkerLike,
    );
  }

  private send(message: DataResponse | DataPush): void {
    if (this.dead) return;
    const copy = structuredClone(message);
    queueMicrotask(() => {
      if (!this.dead) this.emit('message', copy);
    });
  }

  postMessage(message: DataRequest): void {
    if (this.dead) return;
    const request = structuredClone(message);
    queueMicrotask(() => {
      if (!this.dead) this.handle(request);
    });
  }

  kill(): void {}

  private handle(request: DataRequest): void {
    const reply = (response: DataResponse) => this.send(response);
    if (request.type.startsWith('sync.')) {
      this.controller.handle(request as Parameters<SyncController['handle']>[0]).then(
        (answer) => reply({ id: request.id, ok: true, sync: answer }),
        (error: unknown) => reply({ id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
      );
      return;
    }
    try {
      switch (request.type) {
        case 'open': {
          this.controller.close();
          this.db?.close();
          this.db = new ChordDatabase(request.file, 'linux');
          reply({ id: request.id, ok: true, saved: this.db.load(), navs: this.db.loadNavs(), effects: this.db.loadEffects() });
          return;
        }
        case 'write': {
          if (!this.db) throw new Error('chord-data: write before open');
          for (const op of request.ops) if (op.value === null && (op.k === 'node' || op.k === 'chord' || op.k === 'favorite')) this.computer.note(`writes ${op.k} ${op.id} gone (${op.origin ?? 'user'})`);
          // What's written, and when each change in it was made: what a crash after it doesn't lose.
          const watch = process.env['SIM_WATCH'];
          const mine = () => JSON.stringify(this.db?.sync.outbox(100_000).records.filter((r) => r.id === watch) ?? []);
          const before = watch ? mine() : '';
          if (watch && request.ops.some((op) => op.id === watch)) {
            const raw = new DatabaseSync(this.computer.file, { readOnly: true });
            const record = raw.prepare('SELECT type, fields, local, was FROM sync_record WHERE id = ?').get(watch);
            raw.close();
            this.computer.note(`writes ${watch} (${request.ops.filter((op) => op.id === watch).map((op) => `${op.origin ?? 'user'}${op.value === null ? ' gone' : ''}`).join(', ')}) while on=${this.db.sync.meta.on} joining=${this.db.sync.meta.joining}; copy ${JSON.stringify(record)}`);
          }
          // Earlier changes of yours waiting with one (made apart): each stamped first, as of its own time, as chord-data does.
          const steps = request.ops.flatMap((op): WriteOp[] => {
            if (!op.before) return [op];
            const { before, ...last } = op;
            return [...before.map((step) => ({ k: op.k, id: op.id, ...(op.origin ? { origin: op.origin } : {}), ...step }) as WriteOp), last as WriteOp];
          });
          const written = (response: DataResponse) => {
            // Written with sync off (it went off between the change and its write): stamped never, so never synced.
            if (response.ok && this.db) for (const op of steps) if ((op.origin ?? 'user') === 'user') (this.db.sync.meta.on ? this.computer.stamped : this.computer.unsynced)(op);
            if (response.ok) for (const op of steps) this.computer.wrote(op);
            if (response.ok) for (const op of request.ops) if (op.at !== undefined) this.computer.written.set(opKey(op), Math.max(op.at, this.computer.written.get(opKey(op)) ?? 0));
            // SIM_WATCH: what stamped a thing, and from which write.
            if (watch && response.ok && this.db) {
              const stamped = mine();
              if (stamped !== before) this.computer.note(`stamped ${watch} ${stamped.slice(0, 200)} from ops ${JSON.stringify(request.ops.map((op) => [op.k, op.id, op.origin ?? 'user'])).slice(0, 300)}`);
            }
            reply(response);
          };
          writeBatch(this.db, () => (this.dead ? null : this.db), this.controller, request, written);
          return;
        }
        case 'close':
          this.controller.close();
          this.db?.close();
          this.db = null;
          reply({ id: request.id, ok: true });
          return;
        case 'device':
          reply({ id: request.id, ok: true, device: this.db!.device() });
          return;
        case 'search':
          reply({ id: request.id, ok: true, search: { history: [], choices: [], archive: [] } });
          return;
        default:
          reply({ id: request.id, ok: true });
      }
    } catch (error) {
      reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The process ends at once: nothing more is said, or done. */
  die(): void {
    this.dead = true;
    try {
      this.db?.close();
    } catch {
      // Closed already.
    }
    this.db = null;
  }
}

/** Sync's worker thread, in-process: the worker's own code, over the computer's view of the folder. */
class SimWorker extends EventEmitter {
  dead = false;
  private readonly core: { receive(message: ToWorker): void };

  constructor(computer: Computer, owner: SimData) {
    super();
    let alive = true;
    const live = () => alive && !this.dead && !owner.dead;
    this.core = createSyncWorker({
      send: (message) => {
        if (!live()) return;
        // SIM_DEBUG: what the worker says of this computer's own log.
        if (process.env['SIM_DEBUG'] && ['own-changed', 'snapshotted', 'written', 'failed', 'set-up'].includes(message.t)) computer.note(`worker: ${JSON.stringify(message).slice(0, 240)}`);
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (!this.dead) this.emit('message', copy);
        });
      },
      folderOf: () => computer.folder.handle(live),
      abandon: () => {
        alive = false;
      },
      reachable: async () => computer.folder.fault !== 'fail',
      watch: (_folder, changed) => {
        const watcher = (name: string) => changed(name);
        computer.folder.watchers.add(watcher);
        return { close: () => computer.folder.watchers.delete(watcher) };
      },
      writeFile: async (path, bytes) => {
        computer.files.set(path, new Uint8Array(bytes));
      },
      readFile: async (path) => computer.files.get(path) ?? null,
      crypto: simCrypto,
      watchInFront: false,
    });
  }

  postMessage(message: ToWorker): void {
    if (this.dead) return;
    const copy = structuredClone(message);
    queueMicrotask(() => {
      if (!this.dead) this.core.receive(copy);
    });
  }

  unref(): this {
    return this;
  }

  terminate(): Promise<number> {
    this.dead = true;
    return Promise.resolve(0);
  }
}

export class Computer {
  state!: State;
  life: Life | null = null;
  readonly toasts: string[] = [];
  view: SyncView | null = null;
  /** chord-data's own files beside chord.db (`sync-pending`): on the disk, so they outlive a crash. */
  readonly files = new Map<string, Uint8Array>();
  private ids = 0;

  constructor(
    readonly name: string,
    readonly dir: string,
    readonly folder: LocalFolder,
    readonly device: string,
    private readonly observe: Observer,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  get file(): string {
    return join(this.dir, 'chord.db');
  }

  /** Where the folder is, as this computer's paths say: the simulation's folder is in memory. */
  get folderPath(): string {
    return `/sim/${this.name}`;
  }

  get alive(): boolean {
    return Boolean(this.life?.alive);
  }

  get service(): SyncService {
    return this.life!.service!;
  }

  get persistence(): Persistence {
    return this.life!.persistence!;
  }

  get controller(): SyncController {
    return this.life!.data!.controller;
  }

  get db(): ChordDatabase {
    return this.life!.data!.db!;
  }

  /** By entity (`opKey`), when the latest change of it written was made. */
  readonly written = new Map<string, number>();

  /** Writes of yours waiting in persistence (queued, being written, or put back after a refusal): what a crash loses. */
  unwritten(): WriteOp[] {
    const p = this.life?.persistence as unknown as { pending: Map<string, WriteOp>; inFlight: WriteOp[] } | undefined;
    if (!p) return [];
    return [...p.pending.values(), ...p.inFlight].filter((op) => (op.origin ?? 'user') === 'user');
  }

  /** Said to the simulation's trace. */
  note: (line: string) => void = () => undefined;
  /** A change of yours written while sync was off here: the sim's model takes it back out (it never goes). */
  unsynced: (op: WriteOp) => void = () => undefined;
  /** A change of yours written while sync was on (or joining): stamped as of its write. */
  stamped: (op: WriteOp) => void = () => undefined;
  /** Any write that landed, yours or not: what chord.db has of the entity now. */
  wrote: (op: WriteOp) => void = () => undefined;

  newId = (): string => `${this.name}${(++this.ids).toString(36)}x${Date.now().toString(36)}`;

  /** Chord launched: chord.db read (or a first launch's setup saved), and sync's side started as main starts it. */
  async launch(): Promise<void> {
    const fresh = !existsSync(this.file);
    if (fresh) {
      // A computer's id, chosen by the simulation, so a run goes the same way again.
      new ChordDatabase(this.file, 'linux').close();
      const raw = new DatabaseSync(this.file);
      raw.prepare(`INSERT INTO meta (key, value) VALUES ('device', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(this.device);
      raw.close();
    }
    const life: Life = { alive: true, data: null, persistence: null, service: null };
    this.life = life;
    hooks.fork = () => (life.data = new SimData(this));
    const opened = await Persistence.open(this.file);
    life.persistence = opened.persistence;
    const seed = { now: Date.now(), newId: this.newId, theme: THEME, homeUrl: 'https://home.test/' };
    this.state = opened.saved ? restoreState(opened.saved, seed) : seedState(seed);
    if (!opened.saved) opened.persistence.recordAll(this.state);
    const persistence = opened.persistence;
    life.service = new SyncService({
      data: {
        sync: (request) => persistence.sync(request),
        flush: () => persistence.flush(),
        unsaved: () => persistence.unsaved,
        waiting: (key, since) => persistence.waitingHere(key, since),
        onPush: (listener) =>
          persistence.onPush((push) => {
            // SIM_WATCH: what chord-data pushes of a thing to apply.
            const watch = process.env['SIM_WATCH'];
            if (watch && push.push === 'sync.apply' && JSON.stringify(push.apply).includes(watch)) this.note(`pushed ${watch} (read after write ${push.read?.n ?? '?'}): ${JSON.stringify(push.apply).slice(0, 200)}`);
            listener(push);
          }),
      },
      state: () => this.state,
      dispatch: (command) => this.dispatch(command),
      effects: {
        syncSites: async (sites, gone) => {
          for (const site of sites) persistence.effect(site.host, { ...site, compiled: '', sanitizer: 0 }, true);
          for (const host of gone) persistence.effect(host, null, true);
        },
      },
      toast: (_windowId, toast: Toast) => {
        if (life.alive) this.toasts.push(toast.message);
      },
      lastWindow: () => Object.keys(this.state.windows)[0] ?? null,
      notify: (view) => {
        if (life.alive) this.view = view;
      },
      info: () => ({ ...INFO, name: this.name }),
      platform: 'linux',
      folder: () => this.folderPath,
    });
    persistence.onRespawn(() => void life.service?.restarted());
    await life.service.afterLaunch();
  }

  /** A change made here (or sync's, through SyncService): the store's, then persistence's, as main does. */
  dispatch(command: Command): void {
    if (!this.life?.alive) return;
    const before = this.state;
    const result = apply(before, command, { now: Date.now(), newId: this.newId });
    if (result.patches.length === 0 && result.effects.length === 0) return;
    this.state = result.state;
    this.observe(this, command, before, result.state);
    this.life.persistence?.record(result.patches, result.state, originOf(command), before);
  }

  /** Quitting, as the app quits: sync's last write within its two seconds, then chord-data closed. */
  async quit(): Promise<void> {
    const life = this.life;
    if (!life?.alive) return;
    await life.service?.quit();
    await life.persistence?.close();
    this.stop(life);
  }

  /** Gone at once, mid-whatever: nothing in memory survives; chord.db has what it had committed. */
  crash(): void {
    const life = this.life;
    if (!life?.alive) return;
    this.stop(life);
  }

  private stop(life: Life): void {
    life.alive = false;
    life.data?.die();
    this.life = null;
  }

  /** This profile copied to another computer (while it isn't running): chord.db and chord-data's files, as they are. */
  copyTo(other: Computer): void {
    rmSync(other.dir, { recursive: true, force: true });
    mkdirSync(other.dir, { recursive: true });
    for (const name of ['chord.db', 'chord.db-wal', 'chord.db-shm']) if (existsSync(join(this.dir, name))) copyFileSync(join(this.dir, name), join(other.dir, name));
    for (const [path, bytes] of this.files) other.files.set(path.replace(this.dir, other.dir), new Uint8Array(bytes));
  }

  /** chord.db fills the disk (`full`), or has room again. */
  diskFull(full: boolean): void {
    const raw = (this.life?.data?.db as unknown as { db: DatabaseSync } | undefined)?.db;
    if (!raw) return;
    if (!full) {
      raw.exec('PRAGMA max_page_count = 1073741823');
      return;
    }
    const pages = Number((raw.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
    raw.exec(`PRAGMA max_page_count = ${pages}`);
  }
}
