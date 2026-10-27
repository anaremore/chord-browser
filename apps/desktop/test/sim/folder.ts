/**
 * The sync folder as each computer sees it, and the sync app between them
 * (the sync simulation, S15 §13): every computer has a folder of its own, in
 * memory; what one writes reaches the cloud a little later, and the others
 * later still, file by file, in any order, sometimes in part first. The sync
 * app keeps every version, lets an edit beat a delete, keeps both sides of a
 * conflict (one as a "conflicted copy"), and now and then puts an old version
 * of a file back. A folder can fail every call, or hang until it's fixed.
 */
import type { SyncFs } from '@chord/core';

/** A seeded generator, so a failing run can be run again exactly. */
export class Rng {
  constructor(private state: number) {}
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
}

export type FolderFault = 'none' | 'fail' | 'hang';

/** One computer's view of the folder (`<folder>/Chord sync`). */
export class LocalFolder {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  readonly dirs = new Set<string>();
  fault: FolderFault = 'none';
  private hung: (() => void)[] = [];
  /** What a watch of it hears: a file arrived or changed (not one of this computer's own writes). */
  readonly watchers = new Set<(name: string) => void>();
  /** The sync app hears what this computer writes. */
  changed: (path: string) => void = () => undefined;

  constructor(readonly computer: string) {}

  /** A folder that works again: hung calls return, failing. */
  heal(): void {
    this.fault = 'none';
    for (const resume of this.hung.splice(0)) resume();
  }

  private async gate(): Promise<void> {
    if (this.fault === 'fail') throw new Error('EIO: the sync folder failed');
    if (this.fault === 'hang') {
      await new Promise<void>((resume) => this.hung.push(resume));
      throw new Error('EIO: the sync folder hung');
    }
  }

  /** What the sync app brings: never news to the sync app itself. */
  deliver(path: string, bytes: Uint8Array | null): void {
    if (bytes === null) this.files.delete(path);
    else {
      this.files.set(path, { bytes: new Uint8Array(bytes), mtime: Date.now() });
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
    for (const watcher of this.watchers) watcher(path);
  }

  /** The folder for one worker: once it's let go (or its computer stopped), nothing more is changed through it. */
  handle(alive: () => boolean): SyncFs {
    const live = () => {
      if (!alive()) throw new Error('Sync let this worker go');
    };
    const touched = (path: string) => this.changed(path);
    return {
      list: async (path) => {
        await this.gate();
        const prefix = path ? `${path}/` : '';
        const names = new Set<string>();
        let any = path === '' && (this.files.size > 0 || this.dirs.size > 0);
        for (const file of this.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          any = true;
          names.add(file.slice(prefix.length).split('/')[0]!);
        }
        for (const dir of this.dirs) if (dir.startsWith(prefix) && dir !== path && dir.length > prefix.length) names.add(dir.slice(prefix.length).split('/')[0]!);
        return any || this.dirs.has(path) ? [...names] : null;
      },
      stat: async (path) => {
        await this.gate();
        const file = this.files.get(path);
        return file ? { size: file.bytes.length, mtime: file.mtime } : null;
      },
      read: async (path, position, length) => {
        await this.gate();
        const file = this.files.get(path);
        return file ? file.bytes.slice(position, position + length) : new Uint8Array(0);
      },
      create: async (path, bytes, exclusive = false) => {
        await this.gate();
        live();
        if (exclusive && this.files.has(path)) throw new Error('EEXIST');
        this.files.set(path, { bytes: new Uint8Array(bytes), mtime: Date.now() });
        touched(path);
      },
      append: async (path, bytes) => {
        await this.gate();
        live();
        const file = this.files.get(path);
        if (!file) throw new Error('ENOENT');
        const next = new Uint8Array(file.bytes.length + bytes.length);
        next.set(file.bytes);
        next.set(bytes, file.bytes.length);
        this.files.set(path, { bytes: next, mtime: Date.now() });
        touched(path);
      },
      rename: async (from, to) => {
        await this.gate();
        live();
        const file = this.files.get(from);
        if (!file) throw new Error('ENOENT');
        this.files.delete(from);
        this.files.set(to, { ...file, mtime: Date.now() });
        touched(from);
        touched(to);
      },
      mkdir: async (path) => {
        await this.gate();
        live();
        const parts = path.split('/');
        for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
      },
      remove: async (path) => {
        await this.gate();
        live();
        for (const file of [...this.files.keys()]) {
          if (file !== path && !file.startsWith(`${path}/`)) continue;
          this.files.delete(file);
          touched(file);
        }
        for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
      },
      cutBack: async (path, at, expect) => {
        await this.gate();
        live();
        const file = this.files.get(path);
        if (!file || file.bytes.length !== at + expect.length || !file.bytes.subarray(at).every((byte, i) => byte === expect[i])) return false;
        this.files.set(path, { bytes: file.bytes.slice(0, at), mtime: Date.now() });
        touched(path);
        return true;
      },
    };
  }
}

interface CloudFile {
  bytes: Uint8Array | null;
  version: number;
  /** Earlier versions, oldest first: what "restore an old version" can put back. */
  history: (Uint8Array | null)[];
  /** Which computer's this version is. */
  by: string;
}

/** One thing the sync app will do at a time: an upload, or a delivery to one computer. */
interface Job {
  at: number;
  seq: number;
  run(): void;
}

/** The sync app: a cloud between the computers' folders, slow, out of order, and sometimes wrong. */
export class SyncApp {
  readonly cloud = new Map<string, CloudFile>();
  private readonly folders = new Map<string, LocalFolder>();
  /** What each computer last had of each file (the cloud version), and what it changed that isn't up yet. */
  private readonly base = new Map<string, Map<string, number>>();
  private readonly dirty = new Map<string, Set<string>>();
  private jobs: Job[] = [];
  private seq = 0;
  private version = 0;
  /** Off: nothing moves (a sync app not running). */
  paused = false;
  conflicts = 0;
  restores = 0;
  /** A computer's version of a file lost its name to another's (it's kept beside it, as a conflicted copy). */
  lost: (computer: string, path: string) => void = () => undefined;

  constructor(private readonly rng: Rng) {}

  /** A computer's folder, joined to the cloud: what's there now comes down first. */
  attach(folder: LocalFolder): void {
    this.folders.set(folder.computer, folder);
    this.base.set(folder.computer, new Map());
    this.dirty.set(folder.computer, new Set());
    folder.changed = (path) => this.local(folder.computer, path);
    for (const [path, file] of this.cloud) {
      folder.deliver(path, file.bytes);
      this.base.get(folder.computer)!.set(path, file.version);
    }
  }

  private schedule(delay: number, run: () => void): void {
    this.jobs.push({ at: Date.now() + delay, seq: ++this.seq, run });
  }

  private delay(): number {
    // Mostly within a few seconds; sometimes a minute; now and then much later.
    const r = this.rng.next();
    return r < 0.7 ? this.rng.int(3000) : r < 0.95 ? 3000 + this.rng.int(60_000) : 60_000 + this.rng.int(600_000);
  }

  private local(computer: string, path: string): void {
    this.dirty.get(computer)!.add(path);
    this.schedule(this.delay(), () => this.upload(computer, path));
  }

  private upload(computer: string, path: string): void {
    const dirty = this.dirty.get(computer)!;
    if (!dirty.has(path)) return;
    dirty.delete(path);
    const folder = this.folders.get(computer)!;
    const mine = folder.files.get(path)?.bytes ?? null;
    const file = this.cloud.get(path);
    const base = this.base.get(computer)!.get(path) ?? 0;
    if (file && file.version !== base) {
      // Changed elsewhere since this computer last had it.
      if (mine === null && file.bytes !== null) {
        // An edit beats a delete: the file comes back here.
        this.conflicts++;
        this.deliverTo(computer, path, 0);
        return;
      }
      if (mine !== null && file.bytes !== null && !same(mine, file.bytes)) {
        // Both changed: the later one keeps the name, the other is kept beside it.
        this.conflicts++;
        this.lost(file.by, path);
        this.put(`${path.replace(/\.chordlog$/, '')} (conflicted copy ${this.conflicts}).chordlog`, file.bytes, computer);
      }
    }
    this.put(path, mine, computer);
  }

  private put(path: string, bytes: Uint8Array | null, from: string): void {
    const file = this.cloud.get(path) ?? { bytes: null, version: 0, history: [], by: from };
    if (file.bytes !== null || file.version > 0) file.history.push(file.bytes);
    file.bytes = bytes ? new Uint8Array(bytes) : null;
    file.by = from;
    file.version = ++this.version;
    this.cloud.set(path, file);
    this.base.get(from)?.set(path, file.version);
    for (const computer of this.folders.keys()) if (computer !== from) this.deliverTo(computer, path, this.delay());
  }

  /** The cloud's file to one computer, later: whatever it is by then, sometimes its first part ahead of the rest. */
  private deliverTo(computer: string, path: string, delay: number): void {
    const file = () => this.cloud.get(path);
    const partial = this.rng.chance(0.15);
    const cut = this.rng.next();
    this.schedule(delay, () => {
      const now = file();
      if (!now) return;
      // A change of its own to the file not up yet: the upload sorts it out.
      if (this.dirty.get(computer)!.has(path)) return;
      const folder = this.folders.get(computer)!;
      if (partial && now.bytes && now.bytes.length > 1) {
        const have = folder.files.get(path)?.bytes.length ?? 0;
        const part = have + Math.floor((now.bytes.length - have) * cut);
        if (part > have && part < now.bytes.length) {
          folder.deliver(path, now.bytes.slice(0, part));
          this.deliverTo(computer, path, this.rng.int(5000));
          return;
        }
      }
      folder.deliver(path, now.bytes);
      this.base.get(computer)!.set(path, now.version);
    });
  }

  /** An old version of a file put back, as a person might from the sync app's history. */
  restoreOne(): string | null {
    const candidates = [...this.cloud].filter(([path, file]) => file.history.length > 0 && path.endsWith('.chordlog'));
    if (candidates.length === 0) return null;
    const [path, file] = this.rng.pick(candidates);
    const old = file.history[this.rng.int(file.history.length)]!;
    this.restores++;
    this.put(path, old, '(restore)');
    return path;
  }

  /** Everything due by now, in order. */
  run(): number {
    if (this.paused) return 0;
    let ran = 0;
    for (;;) {
      const now = Date.now();
      const due = this.jobs.filter((job) => job.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (due.length === 0) return ran;
      this.jobs = this.jobs.filter((job) => job.at > now);
      for (const job of due) job.run();
      ran += due.length;
    }
  }

  /** Everything, now: every upload up, every computer with the cloud's every file, whole. */
  settle(): void {
    for (let round = 0; round < 50; round++) {
      const jobs = this.jobs.sort((a, b) => a.at - b.at || a.seq - b.seq);
      this.jobs = [];
      for (const job of jobs) job.run();
      // Deliveries still in parts, and anything a job scheduled: done at once, whole.
      for (const [computer, folder] of this.folders) {
        for (const path of this.dirty.get(computer)!) this.upload(computer, path);
        for (const [path, file] of this.cloud) {
          const mine = folder.files.get(path)?.bytes ?? null;
          if ((mine === null && file.bytes === null) || (mine && file.bytes && same(mine, file.bytes))) {
            this.base.get(computer)!.set(path, file.version);
            continue;
          }
          folder.deliver(path, file.bytes);
          this.base.get(computer)!.set(path, file.version);
        }
      }
      if (this.jobs.length === 0 && [...this.dirty.values()].every((d) => d.size === 0)) return;
    }
  }

  /** Whether every computer's folder is the cloud's. */
  settled(): boolean {
    if (this.jobs.length > 0) return false;
    for (const [computer, folder] of this.folders) {
      if (this.dirty.get(computer)!.size > 0) return false;
      for (const [path, file] of this.cloud) {
        const mine = folder.files.get(path)?.bytes ?? null;
        if (!((mine === null && file.bytes === null) || (mine && file.bytes && same(mine, file.bytes)))) return false;
      }
    }
    return true;
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
