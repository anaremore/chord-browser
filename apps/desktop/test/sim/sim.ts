/**
 * The sync simulation (S15 §13): three computers and, later, a copy of one's
 * profile, each with a real chord.db and the app's own main and chord-data
 * code, sharing one folder through a sync app that's slow, out of order and
 * sometimes wrong. A seeded run makes random changes on each, turns sync off
 * and on, joins both ways, removes a computer, and injects faults: a crash at
 * any moment, a full disk, a folder that fails or hangs, an old version of a
 * file put back. At each quiet point (faults cleared, everyone running and
 * read until nothing moves) it checks:
 *   I1 convergence: every syncing computer's merged copy is the same, and its
 *      rows and state are what that copy says, for the synced kinds;
 *   I2 no lost edits: every field is your latest change to it, everywhere;
 *   I3 no phantom deletions: nothing's gone that no one deleted;
 *   I4 no reverts: sync never puts an older value of yours over a newer one;
 *   I5 local-only stays local: Today tabs never go with sync without an Undo;
 *   I6 nothing silently stuck: a computer that hasn't caught up shows a problem.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { stable, localChordFields, localFavoriteFields, localNodeFields, localRouteFields, localSettingFields, localThemeFields, same, type Command, type Settings, type State, type SyncValues } from '@chord/core';
import { hooks } from './electron';
import { Computer, PASSPHRASE, THEME } from './computer';
import { LocalFolder, Rng, SyncApp } from './folder';
import type { WriteOp } from '@chord/data';
import { Model, synced } from './model';

const realImmediate = globalThis.setImmediate;
const realYield = () => new Promise<void>((resolve) => realImmediate(resolve));
/** How many lines of trace a run keeps (SIM_TRACE_MAX), the last: what a failing seed's dump holds. */
const TRACE_MAX = Number(process.env['SIM_TRACE_MAX'] ?? 4000);

export interface SimOptions {
  seed: number;
  /** How many steps (changes, faults, sync's own steps) the run takes. */
  steps?: number;
  /** Faults: crashes, a full disk, a folder failing or hanging, old versions put back. */
  faults?: boolean;
  /** Every step, said. */
  trace?: boolean;
}

export interface SimResult {
  seed: number;
  violations: string[];
  stats: Record<string, number>;
  trace: string[];
}

/** One run. Fake timers must be on (the caller's test sets them up). */
export async function runSeed(options: SimOptions): Promise<SimResult> {
  const sim = new Sim(options);
  try {
    await sim.run();
  } catch (error) {
    sim.fail(`crashed the simulation: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await sim.dispose();
  }
  return { seed: options.seed, violations: sim.violations, stats: sim.stats, trace: sim.trace };
}

/** Syncing, as far as the invariants go: on, with no problem showing. */
type Standing = { on: boolean; problem: string | null; state: string };

class Sim {
  readonly rng: Rng;
  readonly app: SyncApp;
  readonly model = new Model();
  readonly trace: string[] = [];
  readonly violations: string[] = [];
  readonly stats: Record<string, number> = { steps: 0, changes: 0, crashes: 0, quiet: 0, joins: 0, offs: 0, removes: 0, copies: 0, fullDisks: 0, folderFaults: 0, restores: 0, stuckWithProblem: 0 };
  private readonly root = mkdtempSync(join(tmpdir(), 'chord-sim-'));
  private readonly computers: Computer[] = [];
  private n = 0;
  /** Faults now: computers whose disk is full. */
  private readonly full = new Set<Computer>();
  /** Computers that sync (on and joined), and those that have been part of it. */
  private readonly syncing = new Set<Computer>();
  /** Computers off, their outbox parked in the model. */
  private readonly parked = new Set<Computer>();
  private copied = false;
  /** Computers whose turning off is held for its Undo: once it's done, what's in their outbox waits there. */
  private readonly turningOff = new Set<Computer>();
  /** Computers whose join was refused at its choice (a full disk): Settings asks again, and it's chosen again once there's room. */
  private readonly choosing = new Map<Computer, 'synced' | 'both'>();
  /** Computers' logs (by device id) the sync app put back to an old version since the last quiet point. */
  private readonly restored = new Set<string>();
  /** The id each computer last wrote its log under. */
  private readonly ids = new Map<Computer, string>();
  /** Computers joining right now (their join's apply under way). */
  private readonly joiningNow = new Set<Computer>();
  /** What chord-data keeps of each thing on each computer while sync is on: what it last wrote (`local`). */
  private readonly locals = new Map<Computer, { local: Map<string, SyncValues | null>; was: Map<string, SyncValues> }>();
  /** Every address ever a Favorite: never twice (a Favorite at an address one has waits as a twin, by design). */
  private readonly favorited = new Set<string>(['https://home.test/']);

  constructor(private readonly options: SimOptions) {
    this.rng = new Rng(options.seed);
    this.app = new SyncApp(this.rng);
    this.model.note = (line) => this.log(line);
    // Two computers wrote one log (a profile's copy, under one id): the one whose version lost the name finds out at its
    // next look and writes it all again (a new id, a snapshot); off, or going off first, it can't.
    this.app.lost = (name, path) => {
      const c = this.computers.find((x) => x.name === name);
      if (!c) return;
      this.log(`the sync app kept ${name}'s version of ${path} as a conflicted copy`);
      this.restored.add(path.split('/')[1] ?? '');
      if (!this.syncing.has(c)) this.doubt(c);
    };
  }

  log(line: string): void {
    const entry = `${new Date(Date.now()).toISOString().slice(11, 23)} ${line}`;
    this.trace.push(entry);
    if (this.trace.length > TRACE_MAX) this.trace.shift();
    if (this.options.trace) console.log(`[${this.options.seed}] ${entry}`);
  }

  fail(message: string): void {
    this.violations.push(message);
    this.log(`VIOLATION ${message}`);
  }

  private computer(name: string): Computer {
    const folder = new LocalFolder(name);
    const device = (this.options.seed * 7919 + this.computers.length + 1).toString(16).padStart(16, '0').slice(-16);
    const c = new Computer(name, join(this.root, name), folder, device, (computer, command, before, after) => this.observe(computer, command, before, after));
    this.app.attach(folder);
    c.note = (line) => this.log(`${name} (${c.life?.data?.db?.device().slice(-4) ?? '----'}) ${line}`);
    c.stamped = (op) => this.model.stamp(name, matcher(op), op.at ?? Date.now());
    // What chord.db has of each synced thing, as last written: a write of yours that leaves a field as it was there is
    // no change of it, whatever it went through before the write (changed and changed back), and sync stamps none.
    const local = new Map<string, SyncValues | null>();
    // And what it last wrote of each that's gone here, live (`was`): what bringing it back is a change from.
    const was = new Map<string, SyncValues>();
    this.locals.set(c, { local, was });
    c.wrote = (op) => {
      // As chord-data keeps it (`local`): only while sync is on.
      if (!c.life?.data?.db?.sync.meta.on) return;
      for (const [key, set] of projected(op)) {
        const had = local.get(key);
        if ((op.origin ?? 'user') === 'user' && had && set) {
          for (const [field, value] of Object.entries(set)) if (field in had && same(had[field], value)) this.model.unchanged(name, key, field, op.at ?? 0);
        }
        // Changed and taken out in one write (muted, then unpinned): only its going is stamped.
        if ((op.origin ?? 'user') === 'user' && set === null) this.model.goneInWrite(name, key, op.at ?? 0);
        // Brought back by yours: what's as it was before it went is no change of yours.
        const before = was.get(key);
        if ((op.origin ?? 'user') === 'user' && set && !had && before) {
          for (const [field, value] of Object.entries(set)) if (field in before && same(before[field], value)) this.model.unchanged(name, key, field, op.at ?? 0);
        }
        if (set === null && had) was.set(key, had);
        else if (set === null && had === undefined) {
          // What chord-data kept of it came from elsewhere than a write here (joining's rows, the drift check): its `was`, as it has it.
          const kept = this.keptWas(c, key);
          if (kept) was.set(key, kept);
        } else if (set) was.delete(key);
        local.set(key, set && key === 'settings\nsettings' ? { ...had, ...set } : set);
      }
    };
    // Sync went off between a change and its write: chord-data never stamped it, so it never goes (a Keep both brings it).
    c.unsynced = (op) => {
      const n = this.model.lost(name, [{ match: matcher(op), since: c.written.get(`${op.k}:${op.id}`) ?? -Infinity }]);
      if (n > 0) this.log(`${name} wrote ${n} change${n === 1 ? '' : 's'} with sync off: not synced`);
    };
    this.computers.push(c);
    return c;
  }

  /** Every change on every computer: yours go into the model (while that computer syncs), sync's are checked as they land. */
  private observe(c: Computer, command: Command, before: State, after: State): void {
    // A join's own apply takes the folder's setup as it is: older, if the sync app put back an old version of a log.
    if (command.t === 'sync.apply' || command.t === 'sync.replace') this.model.applied(c.name, command, before, after, !this.joiningNow.has(c));
    // Yours count where chord-data stamps them (on, or joining: noted and stamped as the join ends), whatever the sim thinks.
    else if (c.life?.data?.db?.sync.meta.on) this.model.user(c.name, Date.now(), before, after, c.life.data.db.sync.meta.joining);
    // Off: never synced as such, but a value typed then is as old as that, whatever brings it into sync later (I4).
    else this.model.typed(Date.now(), before, after);
  }

  private unique(): string {
    return `~${++this.n}`;
  }

  /**
   * The app's own work, awaited while time passes: what it waits on (a write a
   * turn later, an apply's parts two frames apart) runs on fake timers, so
   * awaiting it without moving time would wait for ever.
   */
  async drive<T>(work: Promise<T>, limit = 15 * 60_000): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown = null;
    work.then(
      (v) => {
        done = true;
        value = v;
      },
      (e: unknown) => {
        done = true;
        error = e ?? new Error('rejected');
      },
    );
    await realYield();
    for (let spent = 0; !done && spent < limit; spent += 10) {
      await vi.advanceTimersByTimeAsync(10);
      this.app.run();
      await realYield();
    }
    if (!done) throw new Error(`never answered in ${limit / 1000} s`);
    if (error) throw error;
    return value as T;
  }

  /** Time passes: everything due runs, the sync app delivers, and real work (a file removed) gets its turn. */
  async tick(ms: number): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 100);
      await vi.advanceTimersByTimeAsync(step);
      this.app.run();
      await realYield();
      left -= step;
    }
    this.offs();
    if (process.env["SIM_DEBUG"]) this.log(`ticked ${ms}`);
  }

  /** Each thing still in a computer's outbox, with its oldest stamp there: what was stamped since hasn't reached the folder. */
  private outboxOf(c: Computer): Map<string, number> {
    const waiting = new Map<string, number>();
    for (const r of c.life?.data?.db?.sync.outbox(100_000).records ?? []) {
      const key = r.type === 'settings' ? 'settings\nsettings' : `${r.type}\n${r.id}`;
      waiting.set(key, Math.min(r.at?.[0] ?? 0, waiting.get(key) ?? Infinity));
    }
    return waiting;
  }

  /** Joined (or set up): what chord-data keeps of each thing here starts as what joining put in the copy (`local`). */
  private seedLocals(c: Computer): void {
    this.forget(c);
    const kept = this.locals.get(c)!;
    const raw = new DatabaseSync(c.file, { readOnly: true });
    try {
      for (const r of raw.prepare(`SELECT type, id, local, was FROM sync_record WHERE (local IS NOT NULL OR was IS NOT NULL) AND type NOT IN ('device', 'icon')`).all() as { type: string; id: string; local: string | null; was: string | null }[]) {
        if (r.local !== null) {
          const { deleted, ...local } = JSON.parse(r.local) as SyncValues;
          kept.local.set(`${r.type}\n${r.id}`, deleted === true ? null : local);
        }
        if (r.was !== null) kept.was.set(`${r.type}\n${r.id}`, JSON.parse(r.was) as SyncValues);
      }
    } finally {
      raw.close();
    }
  }

  /** What chord-data keeps of a thing gone here (`sync_record.was`), as it has it now. */
  private keptWas(c: Computer, key: string): SyncValues | null {
    const [type, id] = key.split('\n') as [string, string];
    const raw = new DatabaseSync(c.file, { readOnly: true });
    try {
      const row = raw.prepare('SELECT was FROM sync_record WHERE type = ? AND id = ?').get(type, id) as { was: string | null } | undefined;
      return row?.was ? (JSON.parse(row.was) as SyncValues) : null;
    } finally {
      raw.close();
    }
  }

  /** The merged copy cleared (sync off, or a join starting): what chord-data kept of things here goes with it. */
  private forget(c: Computer): void {
    const kept = this.locals.get(c);
    kept?.local.clear();
    kept?.was.clear();
  }

  /** The id a computer writes (or last wrote) its log under. */
  private deviceOf(c: Computer): string {
    const now = c.life?.data?.db?.device();
    if (now) this.ids.set(c, now);
    return this.ids.get(c) ?? c.device;
  }

  /** `c`'s log was put back to an old version, and `c` won't write it again: whatever it wrote may be gone. */
  private doubt(c: Computer): void {
    this.model.doubt(c.name);
    this.log(`${c.name}'s log was put back with sync off there: what it wrote may be gone from the folder`);
  }

  /** Sync off (turned off, or removed by another computer): what's still in the outbox waits there, parked. */
  private offs(): void {
    for (const c of this.computers) {
      const db = c.life?.data?.db;
      if (db) this.deviceOf(c);
      if (!db || db.sync.meta.on || this.parked.has(c)) continue;
      // Its log was put back meanwhile, and it went off before it looked again: no one writes it again.
      if (this.restored.has(this.deviceOf(c))) this.doubt(c);
      const waiting = this.outboxOf(c);
      this.model.park(c.name, waiting);
      // The merged copy goes with sync, and what it knew of things gone here with it.
      this.forget(c);
      const watch = process.env['SIM_WATCH'];
      if (watch) this.log(`${c.name} parks ${[...waiting.keys()].filter((k) => k.includes(watch)).join(', ') || `nothing of ${watch}`}`);
      this.parked.add(c);
      this.turningOff.delete(c);
      this.syncing.delete(c);
      this.log(`${c.name} is off, ${waiting.size} thing${waiting.size === 1 ? '' : 's'} waiting in its outbox`);
    }
  }

  async run(): Promise<void> {
    const said = (kind: string) => (...args: unknown[]) => this.log(`(${kind}) ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300)}`);
    vi.spyOn(console, 'error').mockImplementation(said('error'));
    vi.spyOn(console, 'warn').mockImplementation(said('warn'));
    // A new id (a join, a copy found out) comes from the seed too, so a seed runs the same each time.
    const ids = new Rng(this.options.seed * 7919 + 17);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array) {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = ids.int(256);
      }
      return array;
    });
    const [a, b, c] = [this.computer('a'), this.computer('b'), this.computer('c')];
    for (const x of [a, b, c]) await this.drive(x.launch());
    await this.setUp(a);
    await this.tick(500);
    this.app.settle();
    await this.join(b, 'synced');
    await this.tick(500);
    this.app.settle();
    await this.join(c, 'synced');
    const steps = this.options.steps ?? 120;
    for (let i = 0; i < steps; i++) {
      this.stats['steps']!++;
      await this.tick(1 + this.rng.int(1500));
      await this.step();
      if (i > 0 && i % 40 === 0) await this.quiet();
    }
    await this.quiet();
  }

  async dispose(): Promise<void> {
    vi.restoreAllMocks();
    for (const c of this.computers) c.crash();
    rmSync(this.root, { recursive: true, force: true });
  }

  /* ---------- sync's own steps ---------- */

  private async standing(c: Computer): Promise<Standing> {
    if (!c.alive) return { on: false, problem: 'not running', state: 'down' };
    const reply = await this.drive(c.persistence.sync({ type: 'sync.status' })).catch(() => null);
    const status = reply?.status;
    if (!status) return { on: false, problem: 'no answer', state: 'unknown' };
    return { on: status.state !== 'off', problem: status.problem ?? (status.state === 'on' ? null : status.state), state: status.state };
  }

  /** The rows a computer joins with (or sets up with), as joining reads them: each synced thing with its row's time. */
  /** As chord-data decides it, choosing *Use the synced setup*: no synced chord to make way for (kept from a first try refused). */
  private keepsChords(c: Computer): boolean {
    const raw = new DatabaseSync(c.file, { readOnly: true });
    try {
      const meta = JSON.parse(((raw.prepare(`SELECT value FROM meta WHERE key = 'sync'`).get() as { value: string } | undefined)?.value ?? '{}')) as { chose?: string; keepChords?: boolean };
      if (meta.chose === 'synced') return meta.keepChords === true;
      return ![...chordsChoosing(raw).values()].some((deleted) => !deleted);
    } finally {
      raw.close();
    }
  }

  private rowsOf(c: Computer, mode: 'all' | 'synced-setup', keepChords = false): { key: string; set: SyncValues; at: number; maybe?: boolean }[] {
    const raw = new DatabaseSync(c.file, { readOnly: true });
    try {
      const origins = raw.prepare('SELECT k, id, origin, at FROM row_origin').all() as { k: string; id: string; origin: string; at: number | null }[];
      const origin = new Map(origins.map((r) => [`${r.k}\n${r.id}`, r]));
      // When what sync keeps of the row was last made, by whom: another computer's or tidying's counts as older than anything.
      const time = (k: string, id: string, at: number) => {
        const o = origin.get(`${k}\n${id}`);
        return o?.origin === 'sync' || o?.origin === 'tidy' ? 0 : (o?.at ?? at);
      };
      const copy = new Map((raw.prepare('SELECT type, id, fields FROM sync_record').all() as { type: string; id: string; fields: string }[]).map((r) => [`${r.type}\n${r.id}`, JSON.parse(r.fields) as Record<string, unknown>]));
      // A chord's, as choosing reads them: with this computer's changes to chords that never reached the folder read in first.
      const chordsNow = chordsChoosing(raw);
      const liveInCopy = (key: string) => (key.startsWith('chord\n') ? chordsNow.get(key.slice(6)) === false : copy.has(key) && copy.get(key)!['deleted'] !== true);
      const out: { key: string; set: SyncValues; at: number; maybe?: boolean }[] = [];
      const chords = new Set<string>();
      for (const r of raw.prepare('SELECT * FROM chord WHERE deleted_at IS NULL').all() as Record<string, unknown>[]) {
        const id = String(r['id']);
        chords.add(id);
        if (mode === 'synced-setup' && !keepChords) continue;
        const chord = c.state.chords[id];
        const set = chord ? localChordFields(chord) : null;
        if (set) out.push({ key: `chord\n${id}`, set, at: time('chord', id, Number(r['updated_at'])) });
      }
      for (const r of raw.prepare('SELECT id, updated_at FROM node WHERE deleted_at IS NULL').all() as Record<string, unknown>[]) {
        const node = c.state.nodes[String(r['id'])];
        if (!node || !chords.has(node.chordId)) continue;
        const set = localNodeFields(node, null);
        if (!set) continue;
        const key = `${node.kind}\n${node.id}`;
        if (mode === 'synced-setup' && !keepChords && (copy.has(key) || !liveInCopy(`chord\n${node.chordId}`))) continue;
        out.push({ key, set, at: time('node', node.id, Number(r['updated_at'])) });
      }
      for (const r of raw.prepare('SELECT * FROM favorite').all() as Record<string, unknown>[]) {
        const favorite = c.state.favorites[String(r['id'])];
        if (favorite) out.push({ key: `favorite\n${favorite.id}`, set: localFavoriteFields(favorite, null), at: time('favorite', favorite.id, Number(r['updated_at'])) });
      }
      for (const r of raw.prepare('SELECT * FROM link_route').all() as Record<string, unknown>[]) {
        const route = c.state.linkRoutes[String(r['host'])];
        // One to a chord that isn't here waits for it: it joins only once the chord's back (the drift check adds it then).
        if (route) out.push({ key: `route\n${route.host}`, set: localRouteFields(route), at: time('linkRoute', route.host, Number(r['updated_at'])), ...(chords.has(route.chordId) ? {} : { maybe: true }) });
      }
      for (const r of raw.prepare('SELECT key, value, updated_at FROM setting').all() as Record<string, unknown>[]) {
        const key = String(r['key']);
        const value = JSON.parse(String(r['value'])) as unknown;
        if (key === 'themes') {
          for (const theme of c.state.settings.themes) out.push({ key: `theme\n${theme.id}`, set: localThemeFields(theme), at: time('setting', 'themes', Number(r['updated_at'])) });
          continue;
        }
        const fields = localSettingFields(key as keyof Settings, value, 'linux');
        // Each setting at its own row's time, as joining stamps them.
        if (fields) out.push({ key: 'settings\nsettings', set: fields, at: time('setting', key, Number(r['updated_at'])) });
      }
      const watch = process.env['SIM_WATCH'];
      if (watch) this.log(`${c.name} joins with ${JSON.stringify(out.filter((r) => r.key.includes(watch))).slice(0, 300)} (chords ${[...chords].join(',')}; routes ${JSON.stringify(raw.prepare('SELECT host, chord_id FROM link_route').all())}; state ${JSON.stringify(c.state.linkRoutes[watch] ?? null)})`);
      return out;
    } finally {
      raw.close();
    }
  }

  private async setUp(c: Computer): Promise<void> {
    hooks.folder = () => c.folderPath;
    await this.drive(c.persistence.flush());
    const rows = this.rowsOf(c, 'all');
    const chosen = await this.drive(c.service.chooseFolder(null));
    if (!chosen.ok) return this.fail(`setting up on ${c.name}: no folder`);
    const result = await this.drive(c.service.setup(chosen.folderId, PASSPHRASE));
    if (!result.ok) return this.fail(`setting up on ${c.name}: ${result.problem}`);
    this.model.joined(c.name, rows, false);
    this.syncing.add(c);
    this.seedLocals(c);
    this.log(`${c.name} set up sync`);
  }

  private async join(c: Computer, mode: 'synced' | 'both'): Promise<void> {
    hooks.folder = () => c.folderPath;
    const chosen = await this.drive(c.service.chooseFolder(null));
    if (!chosen.ok) return this.log(`${c.name} couldn't choose the folder: ${chosen.problem}`);
    if (chosen.inspection.state !== 'join') return this.log(`${c.name} found the folder ${chosen.inspection.state}: no join`);
    // A join starts over: what an earlier one noted goes (its rows join, as everything here does), and the copy with it.
    this.model.settleWindow(c.name, null);
    this.forget(c);
    this.choosing.delete(c);
    this.joiningNow.add(c);
    const joined = await this.drive(c.service.join(chosen.folderId, PASSPHRASE)).finally(() => this.joiningNow.delete(c));
    if (!joined.ok) {
      // A fresh Chord's join chooses at once: refused there (a full disk), it asks, as any join does.
      if (joined.problem === 'full') this.choosing.set(c, 'synced');
      return this.log(`${c.name} couldn't join: ${joined.problem}`);
    }
    if (joined.view.state === 'choosing') return this.choose(c, mode);
    // A clearly fresh Chord takes the synced setup without asking: what it had is its first run, nothing of yours.
    this.joined(c, 'fresh');
  }

  /** Joining, decided (again, after it was refused: what Settings asks until it's done). */
  private async choose(c: Computer, mode: 'synced' | 'both'): Promise<void> {
    await this.drive(c.persistence.flush());
    // *Use the synced setup* with no synced chord: nothing to make way for, and this computer's chords join it.
    const keepChords = mode === 'synced' && this.keepsChords(c);
    if (process.env['SIM_WATCH']) this.log(`${c.name} keeps its chords: ${keepChords}`);
    const rows = this.rowsOf(c, mode === 'synced' ? 'synced-setup' : 'all', keepChords);
    if (process.env['SIM_WATCH']) {
      const raw = new DatabaseSync(c.file, { readOnly: true });
      this.log(`${c.name} chooses ${mode}, noted ${JSON.stringify(raw.prepare('SELECT k, id, at FROM sync_noted').all()).slice(0, 400)}`);
      raw.close();
    }
    // What the join's end goes by: the synced setup read, and this computer as you left it.
    const { all } = this.copyOf(c);
    const chooser = new DatabaseSync(c.file, { readOnly: true });
    const chordsNow = chordsChoosing(chooser);
    const nodesNow = nodeChordsChoosing(chooser);
    chooser.close();
    const state = c.state;
    this.joiningNow.add(c);
    const chosenMode = await this.drive(c.service.choose(mode)).finally(() => this.joiningNow.delete(c));
    if (!chosenMode.ok) {
      this.choosing.set(c, mode);
      // Refused partway: what it added before stays in the copy (each part whole), so any of it may go.
      this.model.joined(c.name, rows, mode === 'synced', true);
      return this.log(`${c.name} couldn't choose: ${chosenMode.problem}`);
    }
    this.model.joined(c.name, rows, mode === 'synced');
    // What you changed meanwhile is stamped as the join ends: all of it, or, with the synced setup, nothing of the chords
    // that make way (S15 §6, stampJoinWindow).
    const chordKept = (id: unknown) => typeof id === 'string' && (keepChords || chordsNow.get(id) === false);
    this.model.settleWindow(c.name, (key) => {
      if (mode === 'both') return true;
      const [type, id] = key.split('\n') as [string, string];
      if (type === 'chord') return chordKept(id);
      // A node gone here: the chord it was in before the window, else the one the copy has it in (the outbox's too,
      // readmitted as the join ends), gone from the copy or not.
      if (type === 'tab' || type === 'folder' || type === 'split') {
        const before = nodesNow.before.get(key);
        return chordKept(state.nodes[id]?.chordId ?? before ?? (all.get(key)?.['pos'] as { chord?: string } | undefined)?.chord ?? nodesNow.outbox.get(key));
      }
      return true;
    });
    this.joined(c, mode);
  }

  private joined(c: Computer, how: string): void {
    this.seedLocals(c);
    this.choosing.delete(c);
    this.syncing.add(c);
    // What waited in its outbox goes now, in its first snapshot.
    this.model.unpark(c.name);
    this.parked.delete(c);
    this.stats['joins']!++;
    this.log(`${c.name} joined (${how})`);
  }

  /* ---------- one step ---------- */

  private async step(): Promise<void> {
    const alive = this.computers.filter((c) => c.alive);
    const r = this.rng.next();
    const faults = this.options.faults !== false;
    if (r < 0.7 && alive.length > 0) return this.change(this.rng.pick(alive));
    if (!faults) return;
    if (r < 0.74) {
      const c = this.rng.pick(this.computers);
      if (c.alive) {
        this.crashed(c);
        c.crash();
        this.stats['crashes']!++;
        this.log(`${c.name} crashed`);
      } else await this.relaunch(c);
      return;
    }
    if (r < 0.77) {
      const c = this.rng.pick(this.computers);
      if (this.full.has(c)) {
        this.full.delete(c);
        c.diskFull(false);
        this.log(`${c.name}'s disk has room again`);
      } else if (c.alive) {
        this.full.add(c);
        c.diskFull(true);
        this.stats['fullDisks']!++;
        this.log(`${c.name}'s disk is full`);
      }
      return;
    }
    if (r < 0.8) {
      const c = this.rng.pick(this.computers);
      if (c.folder.fault !== 'none') {
        c.folder.heal();
        this.log(`${c.name}'s folder works again`);
      } else {
        c.folder.fault = this.rng.chance(0.5) ? 'fail' : 'hang';
        this.stats['folderFaults']!++;
        this.log(`${c.name}'s folder ${c.folder.fault}s`);
      }
      return;
    }
    if (r < 0.81) {
      const path = this.app.restoreOne();
      if (path) {
        this.stats['restores']!++;
        this.log(`the sync app put back an old version of ${path}`);
        // Its computer, on, finds its log changed at its next look and writes it again (a new id, a snapshot); off, or
        // going off before it looks, it can't: what it wrote last may be gone from the folder for good.
        const device = path.split('/')[1] ?? '';
        this.restored.add(device);
        for (const c of this.computers) if (!this.syncing.has(c) && this.deviceOf(c) === device) this.doubt(c);
      }
      return;
    }
    if (r < 0.82) {
      this.app.paused = !this.app.paused;
      this.log(`the sync app ${this.app.paused ? 'stopped' : 'runs again'}`);
      return;
    }
    if (r < 0.835 && alive.length > 0) return this.turnOff(this.rng.pick(alive));
    if (r < 0.86) {
      const off = alive.filter((c) => !this.syncing.has(c));
      if (off.length > 0) await this.rejoin(this.rng.pick(off));
      return;
    }
    if (r < 0.865 && alive.length > 1) return this.remove(this.rng.pick(alive));
    if (r < 0.87 && !this.copied) return this.copyProfile();
  }

  /** What a crash takes with it: the changes made on `c` not written yet. */
  private crashed(c: Computer): void {
    const unwritten = c.unwritten().map((op) => ({ match: matcher(op), since: c.written.get(`${op.k}:${op.id}`) ?? -Infinity }));
    const n = this.model.lost(c.name, unwritten);
    if (n > 0) this.log(`${c.name} lost ${n} change${n === 1 ? '' : 's'} it hadn't written`);
  }

  private async relaunch(c: Computer): Promise<void> {
    if (c.alive) return;
    await this.drive(c.launch());
    if (this.full.has(c)) c.diskFull(true);
    this.log(`${c.name} launched again`);
  }

  private async turnOff(c: Computer): Promise<void> {
    const standing = await this.standing(c);
    // Joining, Settings asks which setup to use: Turn off isn't there to press.
    if (!standing.on || standing.state === 'choosing') return;
    c.service.hold('off');
    this.turningOff.add(c);
    this.syncing.delete(c);
    this.stats['offs']!++;
    this.log(`${c.name} turns sync off`);
  }

  private async rejoin(c: Computer): Promise<void> {
    const standing = await this.standing(c);
    const choosing = this.choosing.get(c);
    if (choosing && standing.state === 'choosing') return this.choose(c, choosing);
    if (standing.on && standing.problem !== 'removed') return;
    // Changes of yours made while it was off are kept by Keep both; Use the synced setup sets them aside.
    await this.join(c, this.rng.chance(0.5) ? 'both' : 'synced');
  }

  private async remove(c: Computer): Promise<void> {
    const others = this.computers.filter((x) => x !== c && x.alive && this.syncing.has(x));
    if (!this.syncing.has(c) || others.length === 0) return;
    const by = this.rng.pick(others);
    by.service.hold('remove', c.device);
    this.syncing.delete(c);
    this.stats['removes']!++;
    this.log(`${by.name} removes ${c.name}`);
  }

  /** a's profile, copied to another computer while a isn't running, and launched there: two computers, one id. */
  private async copyProfile(): Promise<void> {
    const a = this.computers[0]!;
    if (!this.syncing.has(a)) return;
    this.copied = true;
    // Quitting writes what it can; what its disk refuses (full) is lost with it, as with a crash.
    if (a.alive) {
      await this.drive(a.persistence.flush());
      this.crashed(a);
    }
    await this.drive(a.quit());
    const d = this.computer('d');
    a.copyTo(d);
    // The copy has what a kept of things gone, as chord.db does.
    const from = this.locals.get(a)!;
    const to = this.locals.get(d)!;
    for (const [key, set] of from.local) to.local.set(key, set);
    for (const [key, set] of from.was) to.was.set(key, set);
    // On the same computer's keyring: the copy reads the key, and writes as a, until it finds out.
    await this.drive(a.launch());
    await this.drive(d.launch());
    this.syncing.add(d);
    this.stats['copies']!++;
    this.log(`a's profile copied to d`);
  }

  /* ---------- changes you make ---------- */

  private async change(c: Computer): Promise<void> {
    const command = this.pickChange(c.state, c);
    if (!command) return;
    this.stats['changes']!++;
    this.log(`${c.name}: ${JSON.stringify(command).slice(0, 160)}`);
    c.dispatch(command);
    if (process.env["SIM_DEBUG"]) this.log(`${c.name} dispatched`);
  }

  private pickChange(state: State, c: Computer): Command | null {
    const windowId = Object.keys(state.windows)[0];
    if (!windowId) return null;
    const chords = Object.values(state.chords).filter((x) => !x.private);
    const pinned = Object.values(state.nodes).filter((n) => n.section === 'pinned' && state.chords[n.chordId] && !state.chords[n.chordId]!.private);
    const tabs = pinned.filter((n) => n.kind === 'tab');
    const folders = pinned.filter((n) => n.kind === 'folder');
    const today = Object.values(state.nodes).filter((n) => n.kind === 'tab' && n.section === 'today');
    const favorites = Object.values(state.favorites);
    const themes = state.settings.themes;
    const routes = Object.values(state.linkRoutes);
    const options: (() => Command | null)[] = [
      () => ({ t: 'chord.create', windowId, name: this.unique(), icon: 'C', theme: THEME }),
      () => (chords.length > 0 ? { t: 'chord.update', chordId: this.rng.pick(chords).id, name: this.unique() } : null),
      () => (chords.length > 1 ? { t: 'chord.delete', chordId: this.rng.pick(chords).id } : null),
      () => (state.deletedChords.length > 0 ? { t: 'chord.restore', windowId, chordId: this.rng.pick(state.deletedChords).chord.id } : null),
      () => ({ t: 'tab.open', windowId, url: `https://t${++this.n}.test/` }),
      () => (today.length > 0 ? { t: 'tab.pin', nodeId: this.rng.pick(today).id } : null),
      () => (tabs.length > 0 ? { t: 'tab.unpin', nodeId: this.rng.pick(tabs).id } : null),
      () => {
        const home = tabs.filter((t) => t.kind === 'tab' && t.pinnedUrl === t.url);
        return home.length > 0 ? { t: 'tab.updated', nodeId: this.rng.pick(home).id, title: this.unique() } : null;
      },
      () => (tabs.length > 0 ? { t: 'tab.mute', nodeId: this.rng.pick(tabs).id, muted: this.rng.chance(0.5) } : null),
      () => {
        if (tabs.length === 0) return null;
        const tab = this.rng.pick(tabs);
        const into = folders.filter((f) => f.chordId === tab.chordId);
        return { t: 'node.move', nodeId: tab.id, section: 'pinned', index: this.rng.int(4), parentId: into.length > 0 && this.rng.chance(0.5) ? this.rng.pick(into).id : null };
      },
      () => (folders.length > 0 ? { t: 'node.move', nodeId: this.rng.pick(folders).id, section: 'pinned', index: this.rng.int(4), parentId: null } : null),
      () => {
        if (tabs.length === 0 || chords.length < 2) return null;
        const tab = this.rng.pick(tabs);
        const to = chords.filter((x) => x.id !== tab.chordId);
        return to.length > 0 ? { t: 'node.moveToChord', nodeId: tab.id, chordId: this.rng.pick(to).id } : null;
      },
      () => (chords.length > 0 ? { t: 'folder.create', folderId: c.newId(), chordId: this.rng.pick(chords).id, title: this.unique() } : null),
      () => (folders.length > 0 ? { t: 'folder.rename', nodeId: this.rng.pick(folders).id, title: this.unique() } : null),
      () => (folders.length > 0 ? { t: 'folder.delete', nodeId: this.rng.pick(folders).id } : null),
      () => (state.deletedFolders.length > 0 ? { t: 'folder.restore', nodeId: this.rng.pick(state.deletedFolders).folder.id } : null),
      () => {
        const fresh = [...tabs, ...today].filter((t) => t.kind === 'tab' && !this.favorited.has(t.url));
        if (favorites.length >= 12 || fresh.length === 0) return null;
        const tab = this.rng.pick(fresh);
        if (tab.kind === 'tab') this.favorited.add(tab.url);
        return { t: 'favorite.add', favoriteId: c.newId(), nodeId: tab.id };
      },
      () => (favorites.length > 0 ? { t: 'favorite.remove', favoriteId: this.rng.pick(favorites).id } : null),
      () => (favorites.length > 1 ? { t: 'favorite.move', favoriteId: this.rng.pick(favorites).id, index: this.rng.int(favorites.length) } : null),
      () => {
        if (themes.length >= 6) return null;
        const base = themes.length > 0 && this.rng.chance(0.4) ? this.rng.pick(themes) : null;
        return { t: 'theme.save', theme: { id: base?.id ?? c.newId(), name: this.unique(), stops: THEME.stops, grain: 0.2 } };
      },
      () => (themes.length > 0 ? { t: 'theme.delete', id: this.rng.pick(themes).id } : null),
      () => ({ t: 'settings.set', settings: { searchEngine: this.rng.pick(['google', 'duckduckgo', 'bing'] as const) } }),
      () => ({ t: 'settings.set', settings: { archiveAfter: this.rng.pick(['12h', '24h', '7d', '30d', 'never'] as const) } }),
      () => (chords.length > 0 ? { t: 'linkRoute.set', host: `r${this.rng.int(6)}.test`, chordId: this.rng.pick(chords).id } : null),
      () => (routes.length > 0 ? { t: 'linkRoute.delete', host: this.rng.pick(routes).host } : null),
    ];
    for (let tries = 0; tries < 8; tries++) {
      const command = this.rng.pick(options)();
      if (command) return command;
    }
    return null;
  }

  /* ---------- quiet points and the invariants ---------- */

  /** Faults cleared, everyone running, read and written until nothing moves; then the invariants. */
  async quiet(): Promise<void> {
    this.stats['quiet']!++;
    this.log('-- quiet point --');
    for (const c of this.computers) c.folder.heal();
    for (const c of this.full) c.diskFull(false);
    this.full.clear();
    this.app.paused = false;
    for (const c of this.computers) if (!c.alive) await this.relaunch(c);
    // A join its full disk refused: chosen again, now there's room (Settings still asks).
    for (const [c, mode] of [...this.choosing]) if ((await this.standing(c)).state === 'choosing') await this.choose(c, mode);
    // Settings asks for the passphrase (the key wasn't kept: a full disk, say): you type it.
    for (const c of this.computers) {
      if (!c.alive || (await this.standing(c)).state !== 'locked') continue;
      const unlocked = await this.drive(c.service.unlock(PASSPHRASE));
      this.log(`${c.name} ${unlocked.ok ? 'unlocked with the passphrase' : `couldn't unlock: ${unlocked.problem}`}`);
    }
    let last = '';
    let stable = 0;
    for (let round = 0; round < 40 && stable < 2; round++) {
      this.app.settle();
      for (const c of this.computers) {
        if (!c.alive) continue;
        await this.drive(c.persistence.flush());
        await this.drive(c.persistence.sync({ type: 'sync.check' })).catch(() => undefined);
        await this.drive(c.persistence.sync({ type: 'sync.flush' })).catch(() => undefined);
      }
      await this.tick(4000);
      this.app.settle();
      await this.tick(4000);
      // An idle look, as every ten minutes does: what's merged and not applied, pushed again.
      if (round % 3 === 1) {
        for (const c of this.computers) if (c.alive) await this.drive(c.persistence.sync({ type: 'sync.reconcile', idle: true, wait: true })).catch(() => undefined);
        // What it pushed is applied a part at a time, a frame or two apart: time for that before looking.
        await this.tick(2000);
      }
      const now = await this.fingerprint();
      // A snapshot owed (another computer's log went back) is still to come: not settled yet.
      const owed = this.computers.some((c) => c.alive && c.life?.data?.db?.sync.meta.republish);
      stable = now === last && this.app.settled() && !owed ? stable + 1 : 0;
      last = now;
    }
    if (stable < 2) this.log('never settled');
    // Every computer on has looked at its log since: one put back is written again.
    this.restored.clear();
    await this.check();
  }

  /** Why a computer might not have caught up: where sync stands there, and what it hasn't applied. */
  private diagnose(c: Computer): string {
    const db = c.life?.data?.db;
    if (!db) return 'not running';
    const unapplied = [...db.sync.unappliedPages()].flatMap((page) => [...page.keys()]).map((k) => k.replace('\n', ' '));
    const own = db.sync.meta.own;
    return `meta ${JSON.stringify({ on: db.sync.meta.on, joining: db.sync.meta.joining, kept: db.sync.meta.kept, own: own ? `${own.device.slice(-4)}/${own.segment}@${own.size}` : null })}, outbox ${db.sync.outboxSize()}, unapplied [${unapplied.slice(0, 8).join(', ')}]${unapplied.length > 8 ? ` +${unapplied.length - 8}` : ''}, waiting to be written ${c.persistence.unsaved}`;
  }

  /** Everything that could still be moving: each computer's copy, outbox, state, and what waits to be written. */
  private async fingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const c of this.computers) {
      if (!c.alive) continue;
      const raw = new DatabaseSync(c.file, { readOnly: true });
      try {
        const copy = raw.prepare(`SELECT count(*) AS n, coalesce(sum(length(fields) + length(stamps) + coalesce(length(local), 0)), 0) AS size FROM sync_record`).get() as { n: number; size: number };
        const outbox = raw.prepare('SELECT count(*) AS n FROM sync_outbox').get() as { n: number };
        parts.push(`${c.name}:${copy.n}/${copy.size}/${outbox.n}/${JSON.stringify([...synced(c.state)])}`);
      } finally {
        raw.close();
      }
    }
    return parts.join('|');
  }

  /** A computer's merged copy: each live synced thing's values, read from chord.db. */
  private copyOf(c: Computer): { live: Map<string, Record<string, unknown>>; all: Map<string, Record<string, unknown>>; raw: string } {
    const db = new DatabaseSync(c.file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT type, id, fields, stamps FROM sync_record WHERE type NOT IN ('device', 'icon') ORDER BY type, id`).all() as { type: string; id: string; fields: string; stamps: string }[];
      const live = new Map<string, Record<string, unknown>>();
      const all = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        const fields = JSON.parse(r.fields) as Record<string, unknown>;
        all.set(`${r.type}\n${r.id}`, fields);
        if (fields['deleted'] !== true) live.set(`${r.type}\n${r.id}`, fields);
      }
      return { live, all, raw: rows.map((r) => `${r.type}/${r.id}/${stable(JSON.parse(r.fields))}/${stable(JSON.parse(r.stamps))}`).join('\n') };
    } finally {
      db.close();
    }
  }

  /** One thing as a computer's merged copy has it: each field's value and stamp. */
  private recordOf(c: Computer, key: string, also?: string): string {
    const [type, id] = key.split('\n') as [string, string];
    const db = new DatabaseSync(c.file, { readOnly: true });
    try {
      const row = db.prepare('SELECT fields, stamps, local FROM sync_record WHERE type = ? AND id = ?').get(type, id) as { fields: string; stamps: string; local: string | null } | undefined;
      if (!row) return 'not in the copy';
      const fields = JSON.parse(row.fields) as Record<string, unknown>;
      const stamps = JSON.parse(row.stamps) as Record<string, [number, number, string]>;
      const at = (s: [number, number, string] | undefined) => (s ? `${new Date(s[0]).toISOString().slice(11, 23)}/${s[1]}/${s[2].slice(-4)}` : '?');
      const shown = Object.keys(fields)
        .filter((f) => f === 'deleted' || f === 'pos' || f === 'name' || f === 'title' || f === 'chord' || f === also)
        .map((f) => `${f}=${JSON.stringify(fields[f])}@${at(stamps[f])}`)
        .join(' ');
      return `${shown} local=${(row.local ?? 'null').slice(0, 160)}`;
    } finally {
      db.close();
    }
  }

  private async check(): Promise<void> {
    const standings = new Map<Computer, Standing>();
    for (const c of this.computers) standings.set(c, await this.standing(c));
    const members = this.computers.filter((c) => this.syncing.has(c) && c.alive);
    const healthy = members.filter((c) => standings.get(c)!.on && standings.get(c)!.problem === null);
    for (const c of members) {
      const s = standings.get(c)!;
      if (s.problem !== null) {
        this.stats['stuckWithProblem']!++;
        this.log(`${c.name} shows a problem (${s.problem}), so isn't held to the rest`);
      }
    }
    const copies = new Map(healthy.map((c) => [c, this.copyOf(c)] as const));
    // I1: one merged copy, and each computer's state and rows what it says.
    const reference = healthy[0];
    for (const c of healthy.slice(1)) {
      if (copies.get(c)!.raw !== copies.get(reference!)!.raw) this.fail(`I1/I6 ${c.name}'s merged copy differs from ${reference!.name}'s, and no problem shows: ${diffCopies(copies.get(reference!)!.live, copies.get(c)!.live)} ${firstDiff(copies.get(reference!)!.raw, copies.get(c)!.raw)}`);
    }
    const waiting = (key: string, set: Record<string, unknown>, copy: Map<string, Record<string, unknown>>) => {
      // A node or route whose chord the copy doesn't have waits for it (S15 §13), as one whose folder is in another chord does.
      const pos = set['pos'] as { chord?: string; parent?: string | null } | undefined;
      const chord = key.startsWith('route\n') ? (set['chord'] as string | undefined) : pos?.chord;
      if ((key.startsWith('route\n') || pos) && (!chord || !copy.has(`chord\n${chord}`))) return true;
      if (pos?.parent && !copy.has(`folder\n${pos.parent}`)) return true;
      // Only part of a thing (a rename read, its making lost with a log put back): nothing to make it from yet.
      if (/^(tab|folder|split)\n/.test(key) && !pos) return true;
      if ((key.startsWith('chord\n') && !('name' in set)) || (key.startsWith('favorite\n') && !('url' in set))) return true;
      return false;
    };
    for (const c of healthy) {
      const mine = synced(c.state);
      const copy = copies.get(c)!.live;
      for (const [key, set] of copy) {
        if (key === 'settings\nsettings' || waiting(key, set, copy)) continue;
        const here = mine.get(key);
        if (!here) {
          // Only part of a tab or folder this computer never had (moved elsewhere, its making lost with a log put back
          // and no one left to write it again): nothing to make it from (a tab's home) till that comes. One it has is
          // filled from what it has.
          if ((key.startsWith('tab\n') && !('pinnedUrl' in set)) || (key.startsWith('folder\n') && !('title' in set))) continue;
          this.fail(`I1 ${c.name} hasn't ${key.replace('\n', ' ')}, which its merged copy has`);
          continue;
        }
        for (const [field, value] of Object.entries(here)) if (field !== 'created' && field in set && !same(set[field], value) && !lastChord(c.state, key)) this.fail(`I1 ${c.name}'s ${key.replace('\n', ' ')} ${field} is ${JSON.stringify(value)}; its merged copy says ${JSON.stringify(set[field])}`);
      }
      // A route to a chord that isn't here waits for it, here only (a chord deleted while sync was off, say).
      const routeWaits = (key: string) => key.startsWith('route\n') && !c.state.chords[c.state.linkRoutes[key.slice(6)]?.chordId ?? ''];
      for (const key of mine.keys()) if (key !== 'settings\nsettings' && !copy.has(key) && !lastChord(c.state, key) && !routeWaits(key)) this.fail(`I1 ${c.name} has ${key.replace('\n', ' ')}, which its merged copy hasn't [${this.recordOf(c, key)}]`);
    }
    // I2 and I3: what you meant, everywhere. A computer showing a problem may not have written what it changed yet.
    const stuck = new Map(members.filter((c) => !healthy.includes(c)).map((c) => [c.name, this.outboxOf(c)] as const));
    for (const [key, expected] of this.model.expected(stuck)) {
      for (const c of healthy) {
        const here = synced(c.state).get(key);
        if (expected.live === 'either') continue;
        if (expected.live === 'no') {
          // A computer keeps its last chord, whatever another computer did (and what's in it, and routes to it).
          if (here && !lastChord(c.state, key)) this.fail(`I2 ${c.name} still has ${key.replace('\n', ' ')}, which was deleted last [${this.recordOf(c, key)}]`);
          continue;
        }
        if (!here) {
          const merged = copies.get(c)!.live.get(key);
          // Waiting for its chord or folder, which another change took away: kept in the copy, applied once it's back.
          if (merged && waiting(key, merged, copies.get(c)!.live)) continue;
          this.fail(`I3 ${c.name} hasn't ${key.replace('\n', ' ')}, which no one deleted last [${this.recordOf(c, key)}] deleted: ${this.model.history(key, 'deleted')}`);
          continue;
        }
        // Waiting whole for its chord or folder: it stays as it was here meanwhile (S15 §13).
        const merged = copies.get(c)!.live.get(key);
        if (merged && waiting(key, merged, copies.get(c)!.live)) continue;
        for (const [field, values] of expected.fields) {
          if (values === null || values.includes(undefined) || field === 'created' || !(field in here)) continue;
          if (values.some((value) => same(here[field], value))) continue;
          // Into a folder that's gone, or a chord that is: at the top of its chord meanwhile, by design (S15 §13).
          const live = copies.get(c)!.live;
          const away = (value: unknown) => {
            const pos = value as { chord?: string; parent?: string | null } | undefined;
            if (field === 'pos' && pos && (!live.has(`chord\n${pos.chord}`) || (pos.parent && !live.has(`folder\n${pos.parent}`)))) return true;
            return field === 'chord' && key.startsWith('route\n') && !live.has(`chord\n${value as string}`);
          };
          if (values.some(away)) continue;
          this.fail(`I2 ${c.name}'s ${key.replace('\n', ' ')} ${field} is ${JSON.stringify(here[field])}; the latest change made it ${values.map((v) => JSON.stringify(v)).join(' or ')} [${this.recordOf(c, key, field)}] changes: ${this.model.history(key, field)}`);
        }
      }
    }
    for (const v of this.model.violations.splice(0)) this.fail(v);
    if (this.violations.length > 0) {
      for (const c of healthy) this.log(`${c.name}: ${this.diagnose(c)}`);
      // Where each computer has read to, in each log, and what the cloud and its own folder have.
      for (const c of healthy) {
        const raw = new DatabaseSync(c.file, { readOnly: true });
        const cursors = (raw.prepare('SELECT device, segment, offset FROM sync_cursor ORDER BY device, segment').all() as { device: string; segment: number; offset: number }[]).map((r) => `${r.device.slice(-4)}/${r.segment}@${r.offset}`);
        raw.close();
        const local = [...c.folder.files].filter(([path]) => path.endsWith('.chordlog')).map(([path, file]) => `${path.split('/').slice(1).join('/')}:${file.bytes.length}`);
        this.log(`${c.name} (${this.deviceOf(c).slice(-4)}) read ${cursors.join(' ')}; has ${local.join(' ')}`);
      }
      this.log(`cloud: ${[...this.app.cloud].filter(([path]) => path.endsWith('.chordlog')).map(([path, file]) => `${path.split('/').slice(1).join('/')}:${file.bytes?.length ?? 'gone'}`).join(' ')}`);
    }
  }
}

/** What a write leaves of each synced thing (`type\nid`), as the model projects a state: null, gone (or out of sync). */
function projected(op: WriteOp): Map<string, SyncValues | null> {
  const out = new Map<string, SyncValues | null>();
  switch (op.k) {
    case 'chord':
      out.set(`chord\n${op.id}`, op.value ? localChordFields(op.value) : null);
      break;
    case 'node':
      if (op.value) out.set(`${op.value.kind}\n${op.id}`, localNodeFields(op.value, null));
      else for (const kind of ['tab', 'folder', 'split']) out.set(`${kind}\n${op.id}`, null);
      break;
    case 'favorite':
      out.set(`favorite\n${op.id}`, op.value ? localFavoriteFields(op.value, null) : null);
      break;
    case 'linkRoute':
      out.set(`route\n${op.id}`, op.value ? localRouteFields(op.value) : null);
      break;
    case 'setting':
      if (op.id === 'themes') for (const theme of (Array.isArray(op.value) ? op.value : []) as Settings['themes']) out.set(`theme\n${theme.id}`, localThemeFields(theme));
      else if (op.value !== null) out.set('settings\nsettings', localSettingFields(op.id as keyof Settings, op.value, 'linux') ?? {});
      break;
    default:
      break;
  }
  return out;
}

/** Which of the model's things and fields a write is of. */
function matcher(op: WriteOp): (key: string, field: string) => boolean {
  switch (op.k) {
    case 'chord':
      return (key) => key === `chord\n${op.id}`;
    case 'node':
      return (key) => key === `tab\n${op.id}` || key === `folder\n${op.id}` || key === `split\n${op.id}`;
    case 'favorite':
      return (key) => key === `favorite\n${op.id}`;
    case 'linkRoute':
      return (key) => key === `route\n${op.id}`;
    case 'setting':
      return op.id === 'themes' ? (key) => key.startsWith('theme\n') : (key, field) => key === 'settings\nsettings' && (field === op.id || field.startsWith(`${op.id}.`));
    default:
      return () => false;
  }
}

/**
 * The copy's chords as a join's choice reads them (by id: whether gone): with
 * this computer's changes to chords that never reached the folder (its outbox)
 * merged in first, by their stamps, as `readmitOutbox('chord')` does.
 */
function chordsChoosing(raw: DatabaseSync): Map<string, boolean> {
  type At = [number, number, string];
  const chords = new Map<string, { deleted: boolean; at: At }>();
  for (const r of raw.prepare(`SELECT id, fields, stamps FROM sync_record WHERE type = 'chord'`).all() as { id: string; fields: string; stamps: string }[]) {
    const at = (JSON.parse(r.stamps) as Record<string, At>)['deleted'] ?? [0, 0, ''];
    chords.set(r.id, { deleted: (JSON.parse(r.fields) as Record<string, unknown>)['deleted'] === true, at });
  }
  const later = (a: At, b: At) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  for (const row of raw.prepare('SELECT record FROM sync_outbox ORDER BY seq').all() as { record: string }[]) {
    const r = JSON.parse(row.record) as { type: string; id: string; at?: At; set: Record<string, unknown> };
    if (r.type !== 'chord' || !r.at) continue;
    const had = chords.get(r.id);
    // A chord the copy hasn't: made by this record, whatever it holds (no `deleted`: not gone).
    if (!had) chords.set(r.id, { deleted: r.set['deleted'] === true, at: 'deleted' in r.set ? r.at : [0, 0, ''] });
    else if ('deleted' in r.set && later(r.at, had.at) > 0) chords.set(r.id, { deleted: r.set['deleted'] === true, at: r.at });
  }
  return new Map([...chords].map(([id, c]) => [id, c.deleted]));
}

/**
 * As a join is chosen, the chord each pinned node is in, by key: as it was
 * before the join's window (`sync_noted.base`), and as the outbox has it
 * (readmitted into the copy as the join ends).
 */
function nodeChordsChoosing(raw: DatabaseSync): { before: Map<string, string>; outbox: Map<string, string> } {
  const chordOf = (set: unknown) => {
    const chord = (set as { pos?: { chord?: unknown } } | null)?.pos?.chord;
    return typeof chord === 'string' ? chord : undefined;
  };
  const before = new Map<string, string>();
  for (const r of raw.prepare(`SELECT base FROM sync_noted WHERE k = 'node' AND base IS NOT NULL`).all() as { base: string }[]) {
    for (const [key, set] of JSON.parse(r.base) as [string, unknown][]) {
      const chord = chordOf(set);
      if (chord) before.set(key, chord);
    }
  }
  const outbox = new Map<string, string>();
  for (const row of raw.prepare('SELECT record FROM sync_outbox ORDER BY seq').all() as { record: string }[]) {
    const r = JSON.parse(row.record) as { type: string; id: string; set: unknown };
    const chord = chordOf(r.set);
    if ((r.type === 'tab' || r.type === 'folder' || r.type === 'split') && chord) outbox.set(`${r.type}\n${r.id}`, chord);
  }
  return { before, outbox };
}

/** Whether a thing is this computer's last chord, or in it, or a route to it: kept whatever another computer did (by design). */
function lastChord(state: State, key: string): boolean {
  const chords = Object.values(state.chords).filter((x) => !x.private);
  if (chords.length !== 1) return false;
  const only = chords[0]!.id;
  const [type, id] = key.split('\n') as [string, string];
  if (type === 'chord') return id === only;
  if (type === 'route') return state.linkRoutes[id]?.chordId === only;
  return state.nodes[id]?.chordId === only;
}

/** The first line two copies differ on (type/id/fields/stamps). */
function firstDiff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return `first difference: ${(x[i] ?? '-').slice(0, 300)} | ${(y[i] ?? '-').slice(0, 300)}`;
  return '';
}

function diffCopies(a: Map<string, Record<string, unknown>>, b: Map<string, Record<string, unknown>>): string {
  const out: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y) out.push(`${key.replace('\n', ' ')} ${x ? 'only in the first' : 'only in the second'}`);
    else if (!same(x, y)) out.push(`${key.replace('\n', ' ')} differs: ${JSON.stringify(x).slice(0, 120)} / ${JSON.stringify(y).slice(0, 120)}`);
    if (out.length > 4) break;
  }
  return out.join('; ') || 'stamps differ';
}
