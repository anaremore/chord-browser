/**
 * Sync's tables, chord-data's half (docs/decisions/S15-your-data.md §7, §13):
 * the merged copy of every synced thing (`sync_record`), the changes made here
 * waiting to be written (`sync_outbox`), how far each computer's log has been
 * read (`sync_cursor`), and the clock, folder and generation (`meta`). Only
 * chord-data's thread touches them, inside its transactions:
 *
 * - **Stamping** (`stamp`), from `write()`, in the same transaction: each
 *   synced thing a batch touches is compared with what this computer wrote of
 *   it last (`local`), and only what you changed gets a stamp and goes to the
 *   outbox. Values that came from another computer (`sync.apply`, marked by
 *   main) are saved without a stamp, so they never go back into this log.
 *   While sync is off, `write()` doesn't call it: it costs nothing.
 * - **Merging** (`merge`), a slice at a time, what the sync worker read: each
 *   record checked (core's `checkSyncRecord`), within `SYNC_LIMITS`, merged
 *   field by field, the cursor saved with it.
 * - **Applying** (`planFor`): what changed, read back as the model has it
 *   (core's `planApply`), for main's `sync.apply`.
 */
import { createHash } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import {
  checkSyncRecord,
  compareStamps,
  defaultFields,
  FRESH_PAGES,
  isFreshSetup,
  isGone,
  localChanges,
  localChordFields,
  localDeviceFields,
  localEffectsFields,
  localFavoriteFields,
  localNodeFields,
  localRouteFields,
  localSettingFields,
  localThemeFields,
  mergeRecord,
  nextStamp,
  NODE_TYPES,
  planApply,
  restoreChord,
  rowStamp,
  same,
  seenStamp,
  stampAbove,
  SYNC_LIMITS,
  syncKind,
  thingKey,
  thingRecords,
  uuidv7,
  validTheme,
  deviceOf,
  isStamp,
  type ApplyContext,
  type DataRecord,
  type OwnSegment,
  type Platform,
  type SegmentCursor,
  type SidebarNode,
  type Stamp,
  type SyncApply,
  type SyncChange,
  type SyncDevice,
  type SyncThing,
  type SyncValues,
} from '@chord/core';
import type { WriteOp } from './index';
import { amountsHere, localRecords } from './import-file';
import { chordOf, favoriteOf, iconOf, nodeOf, nodeSelect, num, parseJson, siteEffectsOf, str, type Row } from './rows';

type Sql = (text: string) => StatementSync;

/** What chord-data keeps of sync in `meta` (`sync`, as JSON), apart from the clock (`sync.clock`) and the key (`sync.key`). */
export interface SyncMeta {
  /** On: changes are stamped, and the worker reads and writes the folder. */
  on: boolean;
  /** The folder you picked: `Chord sync` is inside it. */
  folder: string | null;
  generation: number;
  /** This computer's newest segment, as it left it. */
  own: OwnSegment | null;
  /** This computer's name, as the others list it. */
  name: string;
  paused: boolean;
  /** Between a join's reading and your choice: nothing is applied or written yet. */
  joining: boolean;
  /** When this computer last wrote a snapshot, and what it's appended since. */
  compactedAt: number;
  framesSince: number;
  bytesSince: number;
  /** Another computer removed this one: when. Sync is off, and Settings says so until it's turned on again. */
  removedAt: number | null;
  /** An earlier generation this computer moved past by changing the passphrase, and when: its file goes after 30 days. */
  retired: { generation: number; at: number } | null;
  /** When this computer took new ids (another computer wrote under its own): past a few a day, it stops writing and says so. */
  newIds: number[];
  /** This profile may be a copy (its key couldn't be read here): it takes a new id before it writes. */
  rebind: boolean;
  /**
   * How far this computer had read each other computer's folder when its last
   * snapshot started (`readPositions`): everything read from one up to there is
   * in a snapshot of its own. A removed computer's folder goes only while what's
   * been read of it is exactly that.
   */
  coveredReads: Record<string, string>;
  /**
   * What the worker is writing to this computer's log, kept until it's
   * answered (core's `Appending`: where, how long, its hash, never its
   * bytes): after a write that failed, a worker let go mid-write, or a stop
   * between a snapshot's rename and its answer, the next worker takes exactly
   * those bytes as this computer's own if they're there, never as another
   * writer's. `own` is kept up to date with what it settles.
   */
  appending: { expect: OwnSegment; at: number; length: number; hash: string | null } | null;
}

/** A thing's merged version and what chord.db has of it, as one short hash: an idle look skips one it pushed as it is. */
const signatureOf = (row: Row): string =>
  createHash('sha256').update(String(row['fields'])).update('\n').update(String(row['stamps'])).update('\n').update(String(row['local'])).digest('base64url').slice(0, 22);

const OFF: SyncMeta = { on: false, folder: null, generation: 1, own: null, name: '', paused: false, joining: false, compactedAt: 0, framesSince: 0, bytesSince: 0, removedAt: null, retired: null, newIds: [], rebind: false, coveredReads: {}, appending: null };

/**
 * Sync's costs, as chord-data measures them: a whole write() with sync on and
 * off, the stamping hook inside it, a frame from asking the worker to its
 * answer (and its bytes), and each merged slice.
 */
export interface SyncTimings {
  write: number[];
  writeOff: number[];
  stamp: number[];
  frame: number[];
  frameBytes: number[];
  merge: number[];
  plan: number[];
  /** A page of a snapshot, read for the worker. */
  page: number[];
  /** Sync's other steps on chord-data's thread (joining's slices, Settings' status, pruning), each named: the slowest few hundred. */
  steps: { what: string; ms: number }[];
}

/** A merge's outcome: what changed (for main), what was left out, and whether this computer was removed. */
export interface MergeResult {
  changes: Map<string, Set<string>>;
  /** Records sync doesn't take (not a synced type, or not what they say). */
  dropped: number;
  /** Things past SYNC_LIMITS, left out. */
  capped: number;
  /** Another computer took this one off: when (its stamp's time). */
  removed: number | null;
  /** When the newest change from each computer that wrote here came (its stamp, or now if that's ahead), for Settings' *last change*. */
  newest: Map<string, number>;
  /** How many of the records were taken: the rest wait for the next slice (the budget ran out). */
  consumed: number;
}

interface Loaded {
  thing: SyncThing;
  local: SyncValues | null;
  /** What it counts for against SYNC_LIMITS.chars (`costOf`). */
  cost: number;
}

/**
 * What a thing counts for against SYNC_LIMITS.chars: its values and stamps as
 * saved, and for each field what a snapshot adds for it (a record's type, id
 * and stamp, when every field has a stamp of its own), so the cap bounds what a
 * snapshot holds, not only the values.
 */
const costOf = (id: string, values: number, stamps: number, fields: number): number => values + stamps + fields * (id.length + 60);
const COST_SQL = `length(fields) + length(stamps) + (length(stamps) - length(replace(stamps, '[', ''))) * (length(id) + 60)`;
/** What one field adds to its thing's cost (an estimate made as records are merged; the save counts it exactly). */
const fieldCost = (id: string, name: string, field: { v: unknown; at: Stamp }): number => 2 * (name.length + 4) + (JSON.stringify(field.v)?.length ?? 4) + JSON.stringify(field.at).length + id.length + 60;
const valueCost = (name: string, v: unknown): number => name.length + 4 + (JSON.stringify(v)?.length ?? 4);

const ICON_CACHE = 500;
/** A snapshot is read for the worker a page at a time: about this many characters, so a big one is never held whole. */
const PAGE_CHARS = 256 * 1024;
/** An icon's id is its bytes' SHA-256 (core's iconId): what another computer's icon must be. */
const iconHash = (base64: string): string => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
/** Things main applies apart from chords and sidebar nodes. */
const SYNC_TYPES_APPLIED: ReadonlySet<string> = new Set(['favorite', 'theme', 'route', 'settings', 'effects']);

/** A data URL's icon: its bytes' SHA-256 as its id (core's iconId), its type, its bytes as base64. */
function iconFrom(url: string | null): { id: string; mime: string; data: string } | null {
  if (!url) return null;
  const match = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const [, mime, , base64, payload] = match;
  const bytes = base64 ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!), 'utf8');
  if (!/^image\/[a-z0-9.+-]+$/.test(mime!) || bytes.length === 0) return null;
  return { id: `sha256-${createHash('sha256').update(bytes).digest('hex')}`, mime: mime!, data: bytes.toString('base64') };
}

export class SyncStore {
  private metaCache: SyncMeta | null = null;
  private clock: Stamp | null = null;
  private clockDirty = false;
  private readonly icons = new Map<string, { id: string; mime: string; data: string } | null>();
  /** Changes stamped since the worker last took the outbox: chord-data writes them about 3 s after the last. */
  pending = 0;
  /** A write made room for what waited (`takeDue`). */
  private due = false;
  /** How long sync's steps took on chord-data's thread (ms), the last few hundred of each: perf.spec.ts reads them. */
  readonly timings: SyncTimings = { write: [], writeOff: [], stamp: [], frame: [], frameBytes: [], merge: [], plan: [], page: [], steps: [] };

  timed(what: Exclude<keyof SyncTimings, 'steps'>, ms: number): void {
    const list = this.timings[what];
    list.push(Math.round(ms * 1000) / 1000);
    if (list.length > 500) list.shift();
  }

  /** One of sync's other steps on chord-data's thread, by name. */
  stepped(what: string, ms: number): void {
    this.timings.steps.push({ what, ms: Math.round(ms * 1000) / 1000 });
    if (this.timings.steps.length > 500) this.timings.steps.shift();
  }

  constructor(
    private readonly sql: Sql,
    private readonly device: () => string,
    private readonly platform: Platform,
  ) {}

  /* ---------- meta ---------- */

  get meta(): SyncMeta {
    if (!this.metaCache) {
      const row = this.sql(`SELECT value FROM meta WHERE key = 'sync'`).get() as Row | undefined;
      this.metaCache = { ...OFF, ...parseJson<Partial<SyncMeta>>(row?.['value'], {}) };
    }
    return this.metaCache;
  }

  setMeta(change: Partial<SyncMeta>): void {
    this.metaCache = { ...this.meta, ...change };
    this.sql(`INSERT INTO meta (key, value) VALUES ('sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(this.metaCache));
  }

  /** Whether write() stamps: sync is on, and not between a join's reading and your choice. */
  get stamping(): boolean {
    return this.meta.on && !this.meta.joining;
  }

  /** safeStorage's ciphertext of the root key, base64 (main decrypts it); null when this computer keeps none. */
  keyBlob(): string | null {
    const row = this.sql(`SELECT value FROM meta WHERE key = 'sync.key'`).get() as Row | undefined;
    return typeof row?.['value'] === 'string' ? row['value'] : null;
  }

  setKeyBlob(blob: string | null): void {
    if (blob === null) this.sql(`DELETE FROM meta WHERE key = 'sync.key'`).run();
    else this.sql(`INSERT INTO meta (key, value) VALUES ('sync.key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(blob);
  }

  private loadClock(): Stamp | null {
    if (this.clock) return this.clock;
    const row = this.sql(`SELECT value FROM meta WHERE key = 'sync.clock'`).get() as Row | undefined;
    const value = parseJson<unknown>(row?.['value'], null);
    this.clock = isStamp(value) ? value : null;
    return this.clock;
  }

  /** A new stamp for a change made here: the hybrid clock (core's nextStamp), saved before the transaction ends. */
  private tick(now: number): Stamp {
    this.clock = nextStamp(this.loadClock(), now, this.device());
    this.clockDirty = true;
    return this.clock;
  }

  private saveClock(): void {
    if (!this.clockDirty || !this.clock) return;
    this.sql(`INSERT INTO meta (key, value) VALUES ('sync.clock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(this.clock));
    this.clockDirty = false;
  }

  /* ---------- things ---------- */

  private load(type: string, id: string): Loaded | null {
    const row = this.sql('SELECT fields, stamps, local FROM sync_record WHERE type = ? AND id = ?').get(type, id) as Row | undefined;
    return row ? this.loaded(type, id, row) : null;
  }

  private loaded(type: string, id: string, row: Row): Loaded {
    const values = parseJson<Record<string, unknown>>(row['fields'], {});
    const stamps = parseJson<Record<string, Stamp>>(row['stamps'], {});
    const fields: SyncThing['fields'] = {};
    for (const [name, v] of Object.entries(values)) fields[name] = { v, at: stamps[name] ?? [0, 0, ''] };
    const length = (v: unknown) => (typeof v === 'string' ? v.length : 0);
    return {
      thing: { type, id, fields },
      local: row['local'] === null || row['local'] === undefined ? null : parseJson<SyncValues | null>(row['local'], null),
      cost: costOf(id, length(row['fields']), length(row['stamps']), Object.keys(values).length),
    };
  }

  /** A thing saved; `was` is what it counted for before (0 for a new one). Returns what it counts for now. */
  private save(thing: SyncThing, local: SyncValues | null | undefined, was = 0): number {
    const values: Record<string, unknown> = {};
    const stamps: Record<string, Stamp> = {};
    for (const [name, field] of Object.entries(thing.fields)) {
      values[name] = field.v;
      stamps[name] = field.at;
    }
    const fields = JSON.stringify(values);
    const stampsJson = JSON.stringify(stamps);
    if (local === undefined) {
      this.sql(`INSERT INTO sync_record (type, id, fields, stamps) VALUES (?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET fields = excluded.fields, stamps = excluded.stamps`).run(
        thing.type,
        thing.id,
        fields,
        stampsJson,
      );
    } else {
      this.sql(
        `INSERT INTO sync_record (type, id, fields, stamps, local) VALUES (?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET fields = excluded.fields, stamps = excluded.stamps, local = excluded.local`,
      ).run(thing.type, thing.id, fields, stampsJson, local === null ? null : JSON.stringify(local));
    }
    const cost = costOf(thing.id, fields.length, stampsJson.length, Object.keys(values).length);
    if (this.total !== null) this.total += cost - was;
    return cost;
  }

  /** What the copy counts for in all (`costOf` of every thing), kept as things are saved once it's been counted. */
  private total: number | null = null;

  private totalCost(): number {
    this.total ??= num((this.sql(`SELECT COALESCE(SUM(${COST_SQL}), 0) AS n FROM sync_record`).get() as Row)['n']);
    return this.total;
  }

  /** What the copy counts for against SYNC_LIMITS.chars (tests, and Settings one day). */
  size(): number {
    return this.totalCost();
  }

  /** Things a change made here couldn't win (another computer's stamp is at the very last there can be): the merged value stays. */
  private readonly lost = new Map<string, Set<string>>();

  /** A thing, as Settings names it: a chord's or a pinned tab's name, a Favorite's title, or what kind of thing it is. */
  describe(key: string): string {
    const [type, id] = key.split('\n') as [string, string];
    const fields = this.load(type, id)?.thing.fields ?? {};
    const text = (name: string) => (typeof fields[name]?.v === 'string' && (fields[name]!.v as string).trim() ? (fields[name]!.v as string).trim().slice(0, 60) : null);
    const named = text('name') ?? text('customTitle') ?? text('title');
    if (named) return `“${named}”`;
    return type === 'settings' ? 'a setting' : type === 'route' || type === 'effects' ? id : `a ${type}`;
  }

  /** What lost since last asked: main is sent the merged value, so this computer shows what every other one does. */
  takeLost(): Map<string, Set<string>> {
    const out = new Map(this.lost);
    this.lost.clear();
    return out;
  }

  private setLocal(type: string, id: string, local: SyncValues | null): void {
    this.sql('UPDATE sync_record SET local = ? WHERE type = ? AND id = ?').run(local === null ? null : JSON.stringify(local), type, id);
  }

  /**
   * A change made here, stamped: merged into the copy and queued for the log.
   * Its stamp is the clock's, or just above the stamp of any field it replaces
   * that's ahead of it (another computer's clock was ahead), so a change made
   * here always beats the value it replaces. The clock itself stays near the
   * time (core's seenStamp).
   */
  private record(type: string, id: string, set: SyncValues, now: number, local: SyncValues | null | undefined): void {
    const had = this.load(type, id);
    let at = this.tick(now);
    for (const name of Object.keys(set)) {
      const field = had?.thing.fields[name];
      if (field && compareStamps(at, field.at) <= 0) at = stampAbove(field.at, this.device());
    }
    // Above a stamp at the very last there can be, no stamp is: such a change can't win anywhere, so it isn't written,
    // and main is sent the merged value back. This computer never shows what its own copy, and every other, doesn't.
    const wins: SyncValues = {};
    for (const [name, v] of Object.entries(set)) {
      const field = had?.thing.fields[name];
      if (field && compareStamps(at, field.at) <= 0) {
        const key = thingKey(type, id);
        this.lost.set(key, (this.lost.get(key) ?? new Set()).add(name));
      } else wins[name] = v;
    }
    if (Object.keys(wins).length === 0) {
      if (had && local !== undefined) this.setLocal(type, id, local);
      return;
    }
    const record: DataRecord = { type, id, at, set: wins };
    this.save(mergeRecord(had?.thing, record).thing, local, had?.cost ?? 0);
    this.sql('INSERT INTO sync_outbox (record) VALUES (?)').run(JSON.stringify(record));
    this.pending++;
  }

  /** An icon a change uses, as a fact, once: written before the change that names it, so a reader has it first. */
  private ensureIcon(icon: { id: string; mime: string; data: string }): void {
    if (this.sql(`SELECT 1 FROM sync_record WHERE type = 'icon' AND id = ?`).get(icon.id)) return;
    const record: DataRecord = { type: 'icon', id: icon.id, set: { mime: icon.mime, data: icon.data } };
    this.save(mergeRecord(undefined, record).thing, null);
    this.sql('INSERT INTO sync_outbox (record) VALUES (?)').run(JSON.stringify(record));
  }

  private icon(url: string | null): { id: string; mime: string; data: string } | null {
    if (!url) return null;
    if (this.icons.has(url)) return this.icons.get(url)!;
    const icon = iconFrom(url);
    if (this.icons.size >= ICON_CACHE) this.icons.delete(this.icons.keys().next().value!);
    this.icons.set(url, icon);
    return icon;
  }

  /**
   * One thing as the model has it now (`after`; null when it's gone here, or
   * out of sync's reach): what you changed gets a stamp. From another computer
   * (`fromSync`), it's only noted as what this computer has.
   */
  private touch(type: string, id: string, after: SyncValues | null, fromSync: boolean, now: number, icon: { id: string; mime: string; data: string } | null = null): void {
    if (fromSync) {
      // Another computer's value, applied: only noted, without reading what's merged (applying a big merge writes hundreds).
      this.setLocal(type, id, after ?? { deleted: true });
      return;
    }
    const had = this.load(type, id);
    const local = after ?? (had ? { deleted: true } : null);
    const changes = localChanges(had?.thing, had?.local ?? null, after);
    if (!changes) {
      if (had && !same(had.local, local)) this.setLocal(type, id, local);
      return;
    }
    if (icon && changes['icon'] === icon.id) this.ensureIcon(icon);
    this.record(type, id, changes, now, local);
  }

  /** The kind of node a thing of this id is here, if sync knows it. */
  private nodeType(id: string): string | null {
    const row = this.sql(`SELECT type FROM sync_record WHERE id = ? AND type IN ('folder', 'tab', 'split') LIMIT 1`).get(id) as Row | undefined;
    return row ? str(row['type']) : null;
  }

  /**
   * The stamping hook: called by `write()` inside its transaction, after the
   * rows are written, for every op of the batch. Only synced kinds are looked
   * at; history, windows, downloads and the rest never are.
   */
  stamp(ops: readonly WriteOp[], now: number): void {
    // A chord's tombstone goes before its tabs' and folders' (and into the same frame where it fits): a computer that
    // reads it first takes the chord with everything in it, kept for its Undo, rather than its tabs one by one.
    const chordsGone = ops.filter((op) => op.k === 'chord' && !op.value);
    for (const op of chordsGone.length > 0 ? [...chordsGone, ...ops.filter((op) => !chordsGone.includes(op))] : ops) {
      const fromSync = op.sync === true;
      if (!this.due) this.due = this.makesRoom(op);
      switch (op.k) {
        case 'chord':
          this.touch('chord', op.id, op.value ? localChordFields(op.value) : null, fromSync, now);
          break;
        case 'node': {
          if (fromSync) {
            // A sync write names its node's kind; one gone, whichever kind sync has under its id.
            const icon = op.value?.kind === 'tab' ? this.icon(op.value.favicon) : null;
            if (op.value) this.setLocal(op.value.kind, op.id, localNodeFields(op.value, icon?.id ?? null) ?? { deleted: true });
            else this.sql(`UPDATE sync_record SET local = '{"deleted":true}' WHERE id = ? AND type IN ('folder', 'tab', 'split')`).run(op.id);
            break;
          }
          if (!op.value) {
            const type = this.nodeType(op.id);
            if (type) this.touch(type, op.id, null, fromSync, now);
            break;
          }
          const node = op.value;
          const icon = node.kind === 'tab' ? this.icon(node.favicon) : null;
          const type = this.nodeType(op.id);
          // The same id as another kind of node: not the same thing.
          if (type && type !== node.kind) break;
          this.touch(node.kind, op.id, localNodeFields(node, icon?.id ?? null), fromSync, now, icon);
          break;
        }
        case 'favorite': {
          const icon = op.value ? this.icon(op.value.favicon) : null;
          this.touch('favorite', op.id, op.value ? localFavoriteFields(op.value, icon?.id ?? null) : null, fromSync, now, icon);
          break;
        }
        case 'linkRoute':
          this.touch('route', op.id, op.value ? localRouteFields(op.value) : null, fromSync, now);
          break;
        case 'effect':
          this.touch('effects', op.id, op.value ? localEffectsFields(op.value) : null, fromSync, now);
          break;
        case 'setting':
          if (op.id === 'themes') this.themes(op.value, fromSync, now);
          else this.setting(op.id, op.value, fromSync, now);
          break;
        default:
          break;
      }
    }
    this.saveClock();
  }

  /** Whether a write brings a chord, a folder or a split here (new, back, or moved), or takes away a Favorite: what waited for one may apply now. */
  private makesRoom(op: WriteOp): boolean {
    if (op.k === 'favorite') return op.value === null;
    if (op.k === 'chord') return op.value !== null && !this.liveHere('chord', op.id);
    if (op.k !== 'node' || !op.value || op.value.kind === 'tab') return false;
    const had = this.localHere(op.value.kind, op.id);
    if (!had || had['deleted'] === true) return true;
    const pos = had['pos'] as { chord?: unknown; parent?: unknown } | undefined;
    return pos?.chord !== op.value.chordId || pos?.parent !== op.value.parentId;
  }

  private localHere(type: string, id: string): SyncValues | null {
    const row = this.sql('SELECT local FROM sync_record WHERE type = ? AND id = ?').get(type, id) as Row | undefined;
    return row?.['local'] ? parseJson<SyncValues | null>(row['local'], null) : null;
  }

  private liveHere(type: string, id: string): boolean {
    const local = this.localHere(type, id);
    return local !== null && local['deleted'] !== true;
  }

  /** Custom themes are things of their own: each one in the list, and a tombstone for each that left it. */
  private themes(value: unknown, fromSync: boolean, now: number): void {
    const themes = (Array.isArray(value) ? value : []).map(validTheme).filter((t) => t !== null);
    const ids = new Set(themes.map((t) => t.id));
    for (const theme of themes) this.touch('theme', theme.id, localThemeFields(theme), fromSync, now);
    for (const row of this.sql(`SELECT id FROM sync_record WHERE type = 'theme'`).all() as Row[]) {
      if (ids.has(str(row['id']))) continue;
      // One gone frees room for one that waited for it.
      if (this.liveHere('theme', str(row['id']))) this.due = true;
      this.touch('theme', str(row['id']), null, fromSync, now);
    }
  }

  /** One setting: the settings thing's fields for it, the rest as they were. One that doesn't sync changes nothing. */
  private setting(key: string, value: unknown, fromSync: boolean, now: number): void {
    const fields = value === null ? {} : localSettingFields(key, value, this.platform);
    if (fields === null) return;
    const had = this.load('settings', 'settings');
    const before = had?.local && had.local['deleted'] !== true ? had.local : null;
    const after: SyncValues = {};
    const family = `shortcuts.${this.platform === 'darwin' ? 'mac' : 'other'}`;
    for (const [name, v] of Object.entries(before ?? {})) {
      const owns = key === 'shortcuts' ? name === family : name === key || name.startsWith(`${key}.`);
      if (!owns) after[name] = v;
    }
    Object.assign(after, fields);
    if (fromSync) {
      if (had) this.setLocal('settings', 'settings', after);
      return;
    }
    const changes = localChanges(had?.thing, before ?? (had ? {} : null), after);
    if (changes) this.record('settings', 'settings', changes, now, after);
    else if (had && !same(had.local, after)) this.setLocal('settings', 'settings', after);
  }

  /* ---------- turning on ---------- */

  /**
   * This computer's synced things as they are now, from its rows, each with
   * its row's stamp (`updated_at`), so joining doesn't make them newer than
   * they are (S15 §6). A setting still at its default counts as never set:
   * stamped older than anything, so a synced one wins (as an import's, §12).
   */
  localThings(): DataRecord[] {
    const device = this.device();
    const out: DataRecord[] = [];
    const push = (type: string, id: string, at: Stamp, set: SyncValues | null) => {
      if (set) out.push({ type, id, at, set });
    };
    const chords = new Set<string>();
    for (const r of this.sql('SELECT * FROM chord WHERE deleted_at IS NULL').all() as Row[]) {
      const chord = restoreChord(chordOf(r));
      chords.add(chord.id);
      push('chord', chord.id, rowStamp(num(r['updated_at']), device), localChordFields(chord));
    }
    for (const r of this.sql(`${nodeSelect(', i.mime AS icon_mime, i.data AS icon_data', '\n     LEFT JOIN favicon i ON i.key = t.favicon_key')}`).all() as Row[]) {
      const node: SidebarNode | null = nodeOf(r, iconOf(r));
      if (!node || !chords.has(node.chordId)) continue;
      const icon = node.kind === 'tab' ? this.icon(node.favicon) : null;
      const fields = localNodeFields(node, icon?.id ?? null);
      if (!fields) continue;
      if (icon && fields['icon'] === icon.id) out.push({ type: 'icon', id: icon.id, set: { mime: icon.mime, data: icon.data } });
      push(node.kind, node.id, rowStamp(num(r['updated_at']), device), fields);
    }
    for (const r of this.sql('SELECT f.*, i.mime AS icon_mime, i.data AS icon_data FROM favorite f LEFT JOIN favicon i ON i.key = f.favicon_key').all() as Row[]) {
      const favorite = favoriteOf(r, iconOf(r));
      const icon = this.icon(favorite.favicon);
      if (icon) out.push({ type: 'icon', id: icon.id, set: { mime: icon.mime, data: icon.data } });
      push('favorite', favorite.id, rowStamp(num(r['updated_at']), device), localFavoriteFields(favorite, icon?.id ?? null));
    }
    for (const r of this.sql('SELECT * FROM link_route').all() as Row[]) {
      if (chords.has(str(r['chord_id']))) push('route', str(r['host']), rowStamp(num(r['updated_at']), device), localRouteFields({ host: str(r['host']), chordId: str(r['chord_id']), createdAt: num(r['created_at']) }));
    }
    for (const r of this.sql('SELECT * FROM effect').all() as Row[]) {
      const site = siteEffectsOf(r);
      if (site) push('effects', site.host, rowStamp(num(r['updated_at']), device), localEffectsFields(site));
    }
    const defaults = defaultFields(this.platform);
    const settings: Record<string, SyncValues> = {};
    for (const r of this.sql('SELECT key, value, updated_at FROM setting').all() as Row[]) {
      const key = str(r['key']);
      const value = parseJson<unknown>(r['value'], null);
      if (key === 'themes') {
        for (const theme of (Array.isArray(value) ? value : []).map(validTheme)) {
          if (theme) push('theme', theme.id, rowStamp(num(r['updated_at']), device), localThemeFields(theme));
        }
        continue;
      }
      for (const [name, v] of Object.entries(localSettingFields(key, value, this.platform) ?? {})) {
        const at = defaults.has(name) && same(defaults.get(name), v) ? 0 : num(r['updated_at']);
        (settings[String(at)] ??= {})[name] = v;
      }
    }
    for (const [ms, set] of Object.entries(settings)) push('settings', 'settings', [Number(ms), 0, device], set);
    return out;
  }

  /** Whether this computer is a clearly fresh Chord (core's isFreshSetup): joining replaces its setup without asking. */
  fresh(): boolean {
    const here = amountsHere(this.sql, FRESH_PAGES + 1);
    // Most aren't, and say so by what's here alone (history, chats, more than one chord): nothing else is read.
    if (here.chats > 0 || here.pages > FRESH_PAGES) return false;
    if (Number((this.sql('SELECT COUNT(*) AS n FROM chord WHERE deleted_at IS NULL').get() as { n: number }).n) !== 1) return false;
    const local = localRecords(this.sql, { device: this.device(), platform: this.platform, sha256: (bytes) => createHash('sha256').update(bytes).digest('hex') });
    return isFreshSetup(local, here, this.platform);
  }

  /**
   * This computer's things into the merged copy, each as what it wrote last
   * (`local`): all of them (setting up, or joining with *Keep both*), or all
   * but its chords and what's pinned in them (*Use the synced setup*, whose
   * chords make way), with its settings older than any synced one. Each thing
   * here says it's here (`deleted: false`) at its row's stamp, so one changed
   * here after another computer deleted it stays, for everyone, and one that
   * wasn't goes (S15 §13).
   */
  addLocal(mode: 'all' | 'synced-setup', records: readonly DataRecord[] = this.localThings()): Map<string, Set<string>> {
    const changes = new Map<string, Set<string>>();
    for (const record of records) {
      if (mode === 'synced-setup' && (record.type === 'chord' || NODE_TYPES.has(record.type))) continue;
      const here = record.type === 'settings' || record.type === 'icon' ? record : { ...record, set: { ...record.set, deleted: false } };
      const r = mode === 'synced-setup' && here.type === 'settings' ? { ...here, at: [0, 0, this.device()] as Stamp } : here;
      const had = this.load(r.type, r.id);
      const merged = mergeRecord(had?.thing, r);
      const local = { ...(had?.local && had.local['deleted'] !== true ? had.local : {}), ...r.set };
      this.save(merged.thing, local, had?.cost ?? 0);
      if (r.at) this.clock = seenStamp(this.loadClock(), r.at, Date.now(), this.device());
      // What the copy has that differs from this computer's: main applies it.
      const differs = Object.keys(merged.thing.fields).filter((name) => !same(merged.thing.fields[name]!.v, local[name]));
      if (differs.length > 0) changes.set(thingKey(r.type, r.id), new Set(differs));
    }
    this.clockDirty = true;
    this.saveClock();
    return changes;
  }

  /** This computer's `device` record, stamped now: on joining (live again, if it had been removed), and when renamed. */
  stampDevice(fields: { name?: string; os?: string; app?: string; removed?: boolean; rekeyed?: number }, id = this.device(), now = Date.now()): void {
    const set: SyncValues = {};
    if (fields.name !== undefined || fields.os !== undefined || fields.app !== undefined) Object.assign(set, localDeviceFields({ name: fields.name ?? '', os: fields.os ?? '', app: fields.app ?? '' }));
    if (fields.name === undefined) delete set['name'];
    if (fields.os === undefined) delete set['os'];
    if (fields.app === undefined) delete set['app'];
    if (fields.removed !== undefined) set['removed'] = fields.removed;
    // Said under the old passphrase before this computer moves to a new one: the others name it (S15 §13).
    if (fields.rekeyed !== undefined) set['rekeyed'] = fields.rekeyed;
    if (Object.keys(set).length > 0) this.record('device', id, set, now, undefined);
    this.saveClock();
  }

  /** This computer's own `device` record, each field with its own stamp, for a segment's start. */
  deviceRecords(): DataRecord[] {
    const had = this.load('device', this.device());
    return had ? thingRecords(had.thing) : [];
  }

  /* ---------- merging ---------- */

  /**
   * Records another computer wrote, merged into the copy in one transaction
   * (the caller's): each checked, within SYNC_LIMITS, field by field. Records
   * for one thing are merged together and the thing saved once; a thing the
   * records change nothing in isn't written at all; and once about `budget`
   * characters of things have been read and written, the rest wait for the
   * next slice (`consumed` says how many were taken), so a slice stays a few
   * milliseconds however big the things it changes. The clock moves up to
   * each stamp read, at most a minute past the wall clock. `self` is this
   * computer, whose own removal is noticed unless it's joining.
   */
  merge(records: readonly DataRecord[], now: number, budget = Number.POSITIVE_INFINITY): MergeResult {
    const result: MergeResult = { changes: new Map(), dropped: 0, capped: 0, removed: null, newest: new Map(), consumed: 0 };
    const self = this.device();
    let counts: Map<string, number> | null = null;
    let work = 0;
    /** The things this slice changes, as merged so far, each with what it counted for when read. */
    const open = new Map<string, { thing: SyncThing; was: number; cost: number; values: number; dirty: boolean; isNew: boolean }>();
    for (const raw of records) {
      // Past the budget, only more for a thing already read this slice: that costs no more reading or writing.
      if (result.consumed > 0 && work >= budget && !open.has(thingKey(raw.type, raw.id))) break;
      result.consumed++;
      const r = checkSyncRecord(raw, iconHash);
      if (!r) {
        result.dropped++;
        continue;
      }
      const key = thingKey(r.type, r.id);
      let entry = open.get(key);
      if (!entry) {
        // An icon is a fact: one that's here stays as it is, without reading it.
        if (r.type === 'icon' && this.sql(`SELECT 1 FROM sync_record WHERE type = 'icon' AND id = ?`).get(r.id)) continue;
        const had = this.load(r.type, r.id);
        if (!had) {
          // A new thing: within each type's limit, and the copy's.
          counts ??= new Map((this.sql('SELECT type, COUNT(*) AS n FROM sync_record GROUP BY type').all() as Row[]).map((row) => [str(row['type']), num(row['n'])]));
          const type = syncKind(r.type) === 'unknown' ? '?' : r.type;
          const count = type === '?' ? [...counts].filter(([t]) => syncKind(t) === 'unknown').reduce((n, [, c]) => n + c, 0) : (counts.get(type) ?? 0);
          const limit = type === '?' ? SYNC_LIMITS.unknown : (SYNC_LIMITS.byType[type] ?? 0);
          const total = [...counts.values()].reduce((n, c) => n + c, 0);
          if (count >= limit || total >= SYNC_LIMITS.things) {
            result.capped++;
            continue;
          }
          counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
        }
        const thing = had?.thing ?? { type: r.type, id: r.id, fields: {} };
        const values = Object.entries(thing.fields).reduce((n, [name, f]) => n + valueCost(name, f.v), 2);
        entry = { thing, was: had?.cost ?? 0, cost: had?.cost ?? 0, values, dirty: false, isNew: !had };
        open.set(key, entry);
        work += entry.was;
      }
      const merged = mergeRecord(entry.thing, r);
      const moved = Object.keys(r.set).filter((name) => merged.thing.fields[name] !== entry.thing.fields[name]);
      // Nothing it changes (an older stamp, a record read twice): nothing to write.
      if (moved.length === 0) continue;
      // Every thing, new or old, grows only so far (fields, and its values), and the copy as a whole no further than
      // SYNC_LIMITS.chars, counting stamps and what a snapshot adds, however many records add to it.
      let cost = entry.cost;
      let values = entry.values;
      for (const name of moved) {
        const before = entry.thing.fields[name];
        const after = merged.thing.fields[name]!;
        cost += fieldCost(r.id, name, after) - (before ? fieldCost(r.id, name, before) : 0);
        values += valueCost(name, after.v) - (before ? valueCost(name, before.v) : 0);
      }
      if (Object.keys(merged.thing.fields).length > SYNC_LIMITS.fields || values > SYNC_LIMITS.thingChars || this.totalCost() + (cost - entry.cost) > SYNC_LIMITS.chars) {
        result.capped++;
        continue;
      }
      this.total = this.totalCost() + (cost - entry.cost);
      work += Math.max(0, cost - entry.cost);
      entry.thing = merged.thing;
      entry.cost = cost;
      entry.values = values;
      entry.dirty = true;
      if (r.at) {
        this.clock = seenStamp(this.loadClock(), r.at, now, self);
        this.clockDirty = true;
        // When it came, as this computer's clock says: a stamp bumped to win over one far ahead says nothing of its computer's clock.
        const by = r.at[2];
        const at = Math.min(r.at[0], now);
        if (at > (result.newest.get(by) ?? 0)) result.newest.set(by, at);
      }
      if (merged.changed.length > 0) {
        const names = result.changes.get(key) ?? new Set<string>();
        for (const name of merged.changed) names.add(name);
        result.changes.set(key, names);
      }
      if (r.type === 'device' && r.id === self && merged.changed.includes('removed') && merged.thing.fields['removed']?.v === true) result.removed = merged.thing.fields['removed'].at[0];
    }
    for (const entry of open.values()) {
      if (!entry.dirty) continue;
      // Saved once, counted exactly: the estimate made while merging gives way to what was written.
      this.total = this.totalCost() - entry.cost + entry.was;
      work += this.save(entry.thing, undefined, entry.was);
    }
    this.saveClock();
    return result;
  }
  saveCursor(generation: number, device: string, segment: number, cursor: SegmentCursor): void {
    this.sql(
      `INSERT INTO sync_cursor (generation, device, segment, head, offset, frame, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(generation, device, segment) DO UPDATE SET head = excluded.head, offset = excluded.offset, frame = excluded.frame, snapshot = excluded.snapshot`,
    ).run(generation, device, segment, cursor.head, cursor.offset, cursor.frame, cursor.snapshot ? 1 : 0);
  }

  cursors(generation: number): { device: string; segment: number; cursor: SegmentCursor }[] {
    return (this.sql('SELECT * FROM sync_cursor WHERE generation = ?').all(generation) as Row[]).map((r) => ({
      device: str(r['device']),
      segment: num(r['segment']),
      cursor: { head: str(r['head']), offset: num(r['offset']), frame: num(r['frame']), snapshot: num(r['snapshot']) === 1 },
    }));
  }

  /* ---------- applying ---------- */

  /** Things by key, each with the names of its fields to apply: every field when `names` is empty. */
  private changeList(changes: Map<string, Set<string>>): SyncChange[] {
    const out: SyncChange[] = [];
    for (const [key, names] of changes) {
      const [type, id] = key.split('\n') as [string, string];
      const had = this.load(type, id);
      if (had) out.push({ thing: had.thing, names: names.size > 0 ? [...names] : Object.keys(had.thing.fields) });
    }
    return out;
  }

  /** What changed, as main applies it (core's planApply), read from the copy. */
  planFor(changes: Map<string, Set<string>>, now = Date.now(), newId: () => string = uuidv7): SyncApply {
    const cache = new Map<string, SyncThing | undefined>();
    const ctx: ApplyContext = {
      get: (type, id) => {
        const key = thingKey(type, id);
        if (!cache.has(key)) cache.set(key, this.load(type, id)?.thing);
        return cache.get(key);
      },
      panes: (splitId) =>
        (this.sql(`SELECT id, fields, stamps, local FROM sync_record WHERE type = 'tab' AND json_extract(fields, '$.pos.parent') = ?`).all(splitId) as Row[])
          .map((row) => this.loaded('tab', str(row['id']), row).thing)
          .filter((t) => !isGone(t)),
      localSettings: this.load('settings', 'settings')?.local ?? {},
      platform: this.platform,
      now,
      newId,
    };
    return planApply(this.changeList(changes), ctx);
  }

  /**
   * Changed things in the order main applies them, so each lands in what holds
   * it whichever push it's in: chords, folders by depth, splits, tabs, the
   * rest; what went last (a tab moved out of a chord that went stays), chords
   * before the nodes they held.
   */
  orderForApply(changes: Map<string, Set<string>>, brief = this.briefs()): [string, Set<string>][] {
    const depth = (parent: string | null): number => {
      let n = 0;
      for (; parent !== null && n <= 16; n++) parent = brief('folder', parent)?.parent ?? null;
      return n;
    };
    const rank = (key: string): number => {
      const [type, id] = key.split('\n') as [string, string];
      const thing = brief(type, id);
      if (!thing) return 100;
      // A chord that went goes before its nodes' tombstones: it takes them with it, kept for Undo here, rather than one by one.
      if (thing.gone) return type === 'chord' ? 80 : 90;
      if (type === 'chord') return 0;
      if (type === 'folder') return 10 + depth(thing.parent);
      if (type === 'split') return 40;
      if (type === 'tab') return 50;
      return SYNC_TYPES_APPLIED.has(type) ? 60 : 70;
    };
    const ranks = new Map([...changes.keys()].map((key) => [key, rank(key)]));
    return [...changes].sort(([a], [b]) => ranks.get(a)! - ranks.get(b)!);
  }

  /**
   * What ordering what changed needs of each thing (whether it went, and where
   * it is), read by SQLite from the merged copy without loading the thing,
   * once each: a few microseconds a thing, so ordering a push stays well
   * under a keystroke's budget.
   */
  private briefs(): (type: string, id: string) => { gone: boolean; parent: string | null; chord: string | null } | null {
    const seen = new Map<string, { gone: boolean; parent: string | null; chord: string | null } | null>();
    const statement = this.sql(
      `SELECT json_extract(fields, '$.deleted') AS deleted, json_extract(fields, '$.pos.parent') AS parent, json_extract(fields, '$.pos.chord') AS chord
       FROM sync_record WHERE type = ? AND id = ?`,
    );
    return (type, id) => {
      const key = thingKey(type, id);
      if (seen.has(key)) return seen.get(key)!;
      const row = statement.get(type, id) as Row | undefined;
      const out = row ? { gone: row['deleted'] === 1, parent: typeof row['parent'] === 'string' ? row['parent'] : null, chord: typeof row['chord'] === 'string' ? row['chord'] : null } : null;
      seen.set(key, out);
      return out;
    };
  }

  /** Every thing whose merged value differs from what this computer has (or never had): what a join applies. */
  everything(): Map<string, Set<string>> {
    return new Map([...this.everythingPages()].flatMap((page) => [...page]));
  }

  /**
   * Reconciling (S15 §13): what chord.db durably has against the merged copy,
   * by thing, a page at a time; whatever differs is pushed to main again.
   * What chord.db has of each thing is `local`: its rows as the stamping hook
   * projects them (core's `local*Fields`), kept in the same transaction as the
   * rows themselves, so a write chord-data refused, or one a crash cut off,
   * leaves it as it was, and shows here. A thing never applied here; one gone
   * in the copy but not here, or the other way round; and a field this
   * computer keeps whose value differs. Fields it never keeps (a tab's title
   * off its home, another platform's shortcuts) and ones it never takes (a
   * chord's sign-ins, Effects' Duet ids) aren't differences. What this
   * computer always keeps otherwise (tidied, refused, waiting for its chord or
   * folder, past a cap) differs too, and is pushed again, to apply as
   * nothing, or as something once what it waited for is here. Only what can't
   * apply anywhere yet (its chord isn't in the copy at all) is left out.
   */
  *unappliedPages(size = 200): Generator<Map<string, Set<string>>> {
    const never: Record<string, readonly string[]> = { chord: ['profile'], effects: ['duet'] };
    const brief = this.briefs();
    const live = (type: string, id: unknown) => typeof id === 'string' && brief(type, id) !== null && !brief(type, id)!.gone;
    let after = { type: '', id: '' };
    for (;;) {
      const rows = this.sql(`SELECT type, id, fields, stamps, local FROM sync_record WHERE type > ? OR (type = ? AND id > ?) ORDER BY type, id LIMIT ?`).all(after.type, after.type, after.id, size) as Row[];
      const out = new Map<string, Set<string>>();
      for (const row of rows) {
        const { thing, local } = this.loaded(str(row['type']), str(row['id']), row);
        after = { type: thing.type, id: thing.id };
        if (thing.type === 'icon' || thing.type === 'device' || syncKind(thing.type) !== 'sync') continue;
        const key = thingKey(thing.type, thing.id);
        const gone = isGone(thing);
        const goneHere = local?.['deleted'] === true;
        if (!gone && (NODE_TYPES.has(thing.type) || thing.type === 'route')) {
          const pos = (thing.type === 'route' ? { chord: thing.fields['chord']?.v } : thing.fields['pos']?.v) as { chord?: unknown } | undefined;
          if (!live('chord', pos?.chord)) continue;
        }
        if (!local || goneHere) {
          if (!gone) out.set(key, new Set(Object.keys(thing.fields)));
          continue;
        }
        if (gone) {
          out.set(key, new Set(['deleted']));
          continue;
        }
        const skip = never[thing.type] ?? [];
        const names = Object.keys(thing.fields).filter((name) => name !== 'deleted' && name in local && !skip.includes(name) && !same(thing.fields[name]!.v, local[name]));
        if (names.length > 0) out.set(key, new Set(names));
      }
      yield out;
      if (rows.length < size) return;
    }
  }

  /** Each thing's merged version and what chord.db has of it, as one hash, by key: an idle look skips a thing it pushed as it still is. */
  signatures(keys: Iterable<string>): Map<string, string> {
    const statement = this.sql('SELECT fields, stamps, local FROM sync_record WHERE type = ? AND id = ?');
    const out = new Map<string, string>();
    for (const key of keys) {
      const at = key.indexOf('\n');
      const row = statement.get(key.slice(0, at), key.slice(at + 1)) as Row | undefined;
      if (row) out.set(key, signatureOf(row));
    }
    return out;
  }

  /**
   * Since chord-data last asked: a write here (sync's own apply, or yours, an
   * Undo) brought a chord, a folder or a split, or moved one, or took away a
   * Favorite or a theme. What waited for one of those (a tab for its chord or
   * folder, a Favorite for room) may apply now: chord-data reconciles soon.
   */
  takeDue(): boolean {
    const due = this.due;
    this.due = false;
    return due;
  }

  /** How far this computer has read each other computer's folder in this generation: its cursors, as one string each. */
  readPositions(generation: number): Record<string, string> {
    const out: Record<string, string[]> = {};
    for (const r of this.sql('SELECT device, segment, offset FROM sync_cursor WHERE generation = ? ORDER BY device, segment').all(generation) as Row[]) {
      (out[str(r['device'])] ??= []).push(`${num(r['segment'])}:${num(r['offset'])}`);
    }
    return Object.fromEntries(Object.entries(out).map(([device, list]) => [device, list.join(',')]));
  }

  /** Whether everything read from a computer's folder is in a snapshot of this computer's that landed: read since, it isn't. */
  readCovered(device: string): boolean {
    const meta = this.meta;
    return (this.readPositions(meta.generation)[device] ?? '') === (meta.coveredReads[device] ?? '');
  }

  /** What `everything` gives, `size` things at a time, by key: a join reads it with searches answered between. */
  *everythingPages(size = 200): Generator<Map<string, Set<string>>> {
    let after = { type: '', id: '' };
    for (;;) {
      const rows = this.sql(`SELECT type, id, fields, stamps, local FROM sync_record WHERE type > ? OR (type = ? AND id > ?) ORDER BY type, id LIMIT ?`).all(after.type, after.type, after.id, size) as Row[];
      const out = new Map<string, Set<string>>();
      for (const row of rows) {
        const { thing, local } = this.loaded(str(row['type']), str(row['id']), row);
        after = { type: thing.type, id: thing.id };
        if (thing.type === 'icon' || thing.type === 'device') continue;
        const names = Object.keys(thing.fields).filter((name) => !local || !same(thing.fields[name]!.v, local[name]));
        if (names.length > 0) out.set(thingKey(thing.type, thing.id), new Set(names));
      }
      yield out;
      if (rows.length < size) return;
    }
  }

  /** This computer's chords, for Settings while it's choosing: a count, not a read of everything. */
  chordsHere(): number {
    return num((this.sql('SELECT COUNT(*) AS n FROM chord WHERE deleted_at IS NULL').get() as Row)['n']);
  }

  /**
   * The things behind entities main saved meanwhile (`chord:<id>`, `node:<id>`,
   * `setting:<key>`…): main put off applying them while a change of its own
   * to them was waiting, and asks for them again once it's written.
   */
  thingsFor(entityKeys: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const add = (type: string, id: string) => {
      if (this.load(type, id)) out.set(thingKey(type, id), new Set());
    };
    for (const key of entityKeys) {
      const at = key.indexOf(':');
      const [k, id] = [key.slice(0, at), key.slice(at + 1)];
      if (k === 'chord') add('chord', id);
      else if (k === 'node') for (const type of NODE_TYPES) add(type, id);
      else if (k === 'favorite') add('favorite', id);
      else if (k === 'linkRoute') add('route', id);
      else if (k === 'effect') add('effects', id);
      else if (k === 'setting' && id === 'themes') for (const row of this.sql(`SELECT id FROM sync_record WHERE type = 'theme'`).all() as Row[]) add('theme', str(row['id']));
      else if (k === 'setting') add('settings', 'settings');
    }
    return out;
  }

  /** The chords the copy has, live, by rank: a join's *Use the synced setup* sends this computer's Today tabs to the first. */
  syncedChords(): string[] {
    return (this.sql(`SELECT id, fields FROM sync_record WHERE type = 'chord'`).all() as Row[])
      .map((row) => ({ id: str(row['id']), fields: parseJson<Record<string, unknown>>(row['fields'], {}) }))
      .filter((c) => c.fields['deleted'] !== true && typeof c.fields['rank'] === 'string')
      .sort((a, b) => ((a.fields['rank'] as string) < (b.fields['rank'] as string) ? -1 : 1))
      .map((c) => c.id);
  }

  /* ---------- writing ---------- */

  /** The changes waiting to be written, oldest first. */
  outbox(limit = 2000): { upto: number; records: DataRecord[] } {
    const rows = this.sql('SELECT seq, record FROM sync_outbox ORDER BY seq LIMIT ?').all(limit) as Row[];
    return { upto: rows.length > 0 ? num(rows.at(-1)!['seq']) : 0, records: rows.map((r) => parseJson<DataRecord>(r['record'], { type: 'x', id: 'x', set: {} })) };
  }

  /** The worker appended the outbox up to `upto`, in `frames` frames of `bytes`: they go, and this computer's segment is where it says. */
  written(upto: number, own: OwnSegment, frames: number, bytes: number): void {
    this.sql('DELETE FROM sync_outbox WHERE seq <= ?').run(upto);
    this.pending = this.outboxSize();
    const meta = this.meta;
    this.setMeta({ own, framesSince: meta.framesSince + frames, bytesSince: meta.bytesSince + bytes, appending: null });
  }

  outboxSize(): number {
    return num((this.sql('SELECT COUNT(*) AS n FROM sync_outbox').get() as Row)['n']);
  }

  /** Everything the copy holds, as records: a snapshot, whole (tests; the worker takes it a page at a time, `snapshotPages`). */
  snapshot(): DataRecord[] {
    return [...this.snapshotPages()].flat();
  }

  /**
   * Everything the copy holds, as records, a page of about PAGE_CHARS at a
   * time, each read when the worker asks for it: a snapshot is never held
   * whole, here or there. Icons first, so a reader has each before what names
   * it. Pages go by key, so changes meanwhile don't upset them: a thing
   * changed after its page went is in the outbox, which outlives the snapshot.
   */
  *snapshotPages(pageChars = PAGE_CHARS): Generator<DataRecord[]> {
    for (const icons of [true, false]) {
      let after: { type: string; id: string } = { type: '', id: '' };
      for (;;) {
        const rows = (
          icons
            ? this.sql(`SELECT type, id, fields, stamps, local FROM sync_record WHERE type = 'icon' AND id > ? ORDER BY id`).iterate(after.id)
            : this.sql(`SELECT type, id, fields, stamps, local FROM sync_record WHERE type <> 'icon' AND (type > ? OR (type = ? AND id > ?)) ORDER BY type, id`).iterate(after.type, after.type, after.id)
        ) as IterableIterator<Row>;
        const page: DataRecord[] = [];
        let chars = 0;
        let full = false;
        for (const row of rows) {
          const { thing, cost: size } = this.loaded(str(row['type']), str(row['id']), row);
          page.push(...thingRecords(thing));
          chars += size;
          after = { type: thing.type, id: thing.id };
          if (chars >= pageChars) {
            full = true;
            break;
          }
        }
        rows.return?.();
        if (page.length > 0) yield page;
        if (!full) break;
      }
    }
  }

  /** The newest change in the outbox: a snapshot started now covers it and everything before. */
  outboxMark(): number {
    return num((this.sql('SELECT COALESCE(MAX(seq), 0) AS n FROM sync_outbox').get() as Row)['n']);
  }

  /** How big a snapshot is, about: what compaction weighs a computer's segments against. */
  snapshotChars(): number {
    return num((this.sql('SELECT COALESCE(SUM(length(fields) + length(stamps)), 0) AS n FROM sync_record').get() as Row)['n']);
  }

  /**
   * The snapshot went out: the outbox it covers (up to `mark`, taken when it
   * started) goes too, and counting starts again. Changes stamped while it was
   * written stay, to be appended after it.
   */
  snapshotted(own: OwnSegment, now: number, mark = Number.MAX_SAFE_INTEGER, reads?: Record<string, string>): void {
    this.sql('DELETE FROM sync_outbox WHERE seq <= ?').run(mark);
    this.pending = this.outboxSize();
    this.setMeta({ own, compactedAt: now, framesSince: 0, bytesSince: 0, appending: null, ...(reads ? { coveredReads: reads } : {}) });
  }

  /* ---------- devices ---------- */

  devices(): SyncDevice[] {
    return (this.sql(`SELECT id, fields, stamps, local FROM sync_record WHERE type = 'device'`).all() as Row[]).map((row) => deviceOf(this.loaded('device', str(row['id']), row).thing)).filter((d) => d !== null);
  }

  /**
   * Turning off: the copy, the cursors, the junk remembered and the key go;
   * this computer's data stays, and so do changes not yet in the folder (the
   * outbox): turned on again, they go then (`readmitOutbox`).
   */
  clear(): void {
    this.sql('DELETE FROM sync_record').run();
    this.sql('DELETE FROM sync_cursor').run();
    this.sql('DELETE FROM sync_junk').run();
    this.sql(`DELETE FROM meta WHERE key IN ('sync', 'sync.clock', 'sync.key')`).run();
    this.metaCache = null;
    this.clock = null;
    this.pending = 0;
  }

  /**
   * Changes made while sync was on that never reached the folder (it was
   * turned off first, or couldn't write): into the copy, so the first snapshot
   * after it's on again holds them, each with its stamp.
   */
  readmitOutbox(): void {
    for (const row of this.sql('SELECT record FROM sync_outbox ORDER BY seq').all() as Row[]) {
      const r = parseJson<DataRecord | null>(row['record'], null);
      if (!r || typeof r.type !== 'string' || typeof r.id !== 'string' || !r.set) continue;
      const had = this.load(r.type, r.id);
      this.save(mergeRecord(had?.thing, r).thing, had ? undefined : null, had?.cost ?? 0);
    }
  }

  /** What the reader remembers of junk in the folder (name, size and time), kept across launches. */
  junk(): [string, string][] {
    return (this.sql('SELECT path, seen FROM sync_junk').all() as Row[]).map((r) => [str(r['path']), str(r['seen'])]);
  }

  saveJunk(entries: readonly [string, string][]): void {
    this.sql('DELETE FROM sync_junk').run();
    const insert = this.sql('INSERT INTO sync_junk (path, seen) VALUES (?, ?)');
    for (const [path, seen] of entries) insert.run(path, seen);
  }

  /**
   * Changed things as pushes of about `size` each, in the order main applies
   * them (`orderForApply`), a chord that went always in one push with every
   * node of it that went: it takes them with it, kept for its Undo, rather
   * than a later push deleting them one by one.
   */
  pushSlices(changes: Map<string, Set<string>>, size: number): Map<string, Set<string>>[] {
    const brief = this.briefs();
    const ordered = this.orderForApply(changes, brief);
    const goneChords = new Set(ordered.filter(([key]) => key.startsWith('chord\n') && brief('chord', key.slice(6))?.gone).map(([key]) => key.slice(6)));
    const withChord = new Map<string, [string, Set<string>][]>();
    const rest: [string, Set<string>][] = [];
    for (const entry of ordered) {
      const [type, id] = entry[0].split('\n') as [string, string];
      const thing = NODE_TYPES.has(type) ? brief(type, id) : null;
      const chord = thing?.gone ? thing.chord : null;
      if (chord !== null && goneChords.has(chord)) withChord.set(chord, [...(withChord.get(chord) ?? []), entry]);
      else rest.push(entry);
    }
    const slices: Map<string, Set<string>>[] = [];
    let slice = new Map<string, Set<string>>();
    const add = (group: [string, Set<string>][]) => {
      if (slice.size > 0 && slice.size + group.length > size) {
        slices.push(slice);
        slice = new Map();
      }
      for (const [key, names] of group) slice.set(key, names);
    };
    for (const entry of rest) {
      const [type, id] = entry[0].split('\n') as [string, string];
      add(type === 'chord' && goneChords.has(id) ? [entry, ...(withChord.get(id) ?? [])] : [entry]);
    }
    if (slice.size > 0) slices.push(slice);
    return slices;
  }
}
