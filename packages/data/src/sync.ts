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
  chordRecord,
  DEFAULT_PROFILE,
  compareStamps,
  defaultFields,
  FRESH_PAGES,
  isFreshSetup,
  isGone,
  LAST_RANK,
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
  valuesOf,
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
import { opOrigin, type Origin, type WriteOp } from './index';
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
  /**
   * Setting up (the first computer), this computer's things going into the copy a slice at a time, as joining reads
   * them (`joining` too, so what you change meanwhile is noted): one a stop left partway (a crash) is cleared.
   */
  settingUp: boolean;
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
  /** The projection of rows (core's `local*Fields`, the icon cap) `local` was last checked under (`PROJECTION`). */
  projection: number;
  /** Off, with the merged copy kept: turned off while what sync applied wasn't all in chord.db (`keepOff`). */
  kept: boolean;
  /**
   * Joined with *Use the synced setup*: this computer's chords make way, into
   * `to`. Kept until a reconcile finds none of them left in chord.db (`chordsMakingWay`),
   * so one whose change was lost (a crash before its write) makes way after the launch.
   */
  makingWay: { to: string } | null;
  /**
   * Another computer's log went back to an older version after this one read
   * it (a sync app restoring a file): this one's next write is a snapshot, with
   * all it has of it, so the folder has it again. Kept until written.
   */
  republish: boolean;
  /** Joining: the choice made, once a part of it is in (a choice refused partway carries on the same way, or starts over). */
  chose: 'synced' | 'both' | null;
  /** *Use the synced setup* with no synced chord to make way for: this computer's chords join it, as with *Keep both*. */
  keepChords: boolean;
}

/** One synced thing as chord.db's rows have it (`rowThings`): its fields, each field's row time, and the icon it names. */
interface RowThing {
  type: string;
  id: string;
  set: SyncValues;
  /** When its row (a field's, for the settings) last changed. */
  ms: (name: string) => number;
  /** Whether a field is at its default: a setting never set counts as older than anything when joining. */
  atDefault: (name: string) => boolean;
  /** Who last wrote its row (`row_origin`): null when an older Chord did, and it isn't known. */
  origin: Origin | null;
  /** Who last wrote a field's row, for a thing made of many rows (the settings). */
  fieldOrigin?: (name: string) => Origin | null;
  icon: { id: string; mime: string; data: string } | null;
}

/**
 * How rows are projected into what sync keeps (core's `local*Fields`, the icon
 * cap, which settings sync): raised whenever that changes, so the first drift
 * check under a new one only refreshes `local` and never stamps a change no
 * one made. 1: icons past SYNC_LIMITS.iconChars read as none.
 */
const PROJECTION = 1;

/**
 * About this much of the copy (its JSON) a reconcile's page reads: 512 KB took
 * up to 7.7 ms with Effects at their largest, and a search waits behind one.
 */
const RECONCILE_PAGE_CHARS = 256 * 1024;
/**
 * About this much of chord.db's rows a page of `rowThings` reads: the drift
 * check reads each thing's copy and `local` besides (512 KB took 7.4 ms).
 */
const ROW_PAGE_CHARS = 128 * 1024;

/** A thing's merged version and what chord.db has of it, as one short hash: an idle look skips one it pushed as it is. */
const signatureOf = (row: Row): string =>
  createHash('sha256').update(String(row['fields'])).update('\n').update(String(row['stamps'])).update('\n').update(String(row['local'])).digest('base64url').slice(0, 22);

/** The kinds of write noted while a join waits (`noteUnstamped`): the synced ones. */
const WINDOW_KINDS = new Set(['chord', 'node', 'favorite', 'linkRoute', 'effect', 'setting']);

const OFF: SyncMeta = { on: false, folder: null, generation: 1, own: null, name: '', paused: false, joining: false, settingUp: false, compactedAt: 0, framesSince: 0, bytesSince: 0, removedAt: null, retired: null, newIds: [], rebind: false, coveredReads: {}, appending: null, projection: 0, kept: false, makingWay: null, republish: false, chose: null, keepChords: false };

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
  /** This computer's id was turned off by a computer writing as this one (its own stamp, and it never did): a copy of its profile. */
  removedByCopy?: boolean;
  /** When the newest change from each computer that wrote here came (its stamp, or now if that's ahead), for Settings' *last change*. */
  newest: Map<string, number>;
  /** How many of the records were taken: the rest wait for the next slice (the budget ran out). */
  consumed: number;
}

interface Loaded {
  thing: SyncThing;
  local: SyncValues | null;
  /** What this computer last had of it before it went here (`local` is gone): what bringing it back is compared with. */
  was: SyncValues | null;
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

/** A write's changes, the earlier ones waiting with it first (`before`), each as a write of its own. */
const stepsOf = (op: WriteOp): WriteOp[] => [...(op.before ?? []).map((step) => ({ k: op.k, id: op.id, ...(op.origin ? { origin: op.origin } : {}), ...step }) as WriteOp), op];

/** A thing's values but whether it's gone. */
const withoutDeleted = ({ deleted: _deleted, ...rest }: SyncValues): SyncValues => rest;

/** Whether this computer showed a field's merged value (`shown`: what it had of the thing; gone, or not there at all): one a change of yours replaced. */
const shownHere = (shown: SyncValues | null, name: string, v: unknown): boolean => {
  if (!shown) return false;
  if (name === 'deleted') return (shown['deleted'] === true) === (v === true);
  return name in shown && same(shown[name], v);
};

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
  /** As a join ends (`stampJoinWindow`): what each thing changed in its window was before it, by thing. */
  private readonly windowBases = new Map<string, SyncValues | null>();
  /** As a join ends: what was in sync at some point in its window (made, then gone again: a deletion). */
  private readonly windowLive = new Set<string>();
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
    const next = { ...this.meta, ...change };
    this.sql(`INSERT INTO meta (key, value) VALUES ('sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
    this.metaCache = next;
  }

  /**
   * A transaction rolled back (a full disk): what's kept in memory of chord.db
   * (the meta, the clock, the outbox's size) is read again, as it is now.
   */
  rolledBack(): void {
    this.metaCache = null;
    this.clock = null;
    this.clockDirty = false;
    try {
      this.pending = this.outboxSize();
    } catch {
      // Read once more when next asked.
    }
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

  /** A stamp as of when a change was made here (earlier than now): the clock still moves past it. */
  private madeAt(made: number, now: number): Stamp {
    const at: Stamp = [made, 0, this.device()];
    this.clock = seenStamp(this.loadClock(), at, now, this.device());
    this.clockDirty = true;
    return at;
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
    const row = this.sql('SELECT fields, stamps, local, was FROM sync_record WHERE type = ? AND id = ?').get(type, id) as Row | undefined;
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
      was: typeof row['was'] === 'string' ? parseJson<SyncValues | null>(row['was'], null) : null,
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
   * time (core's seenStamp). `shown`: what this computer had of the thing
   * before the change. A merged value it never showed (read after the change
   * was made, while a full disk put its write off, or not applied here yet)
   * isn't one the change replaced: the later of the two wins, by when each was
   * made (S15 §13). Nor is one stamped after the change was made and before
   * now, another computer's, whatever its value (the same as what was shown,
   * say, a folder brought back after you deleted it): only one ahead of now
   * (a clock ahead) or this computer's own can be.
   */
  private record(type: string, id: string, set: SyncValues, now: number, local: SyncValues | null | undefined, made?: number, shown?: SyncValues | null, loaded?: Loaded | null): void {
    // `loaded`: read already (a change of yours reads it first), its fields as they are.
    const had = loaded !== undefined ? loaded : this.load(type, id);
    // As of when you made it (a write a full disk put off is no later a change for it), never past now.
    const putOff = made !== undefined && Number.isSafeInteger(made) && made > 0 && made < now;
    let at = putOff ? this.madeAt(made, now) : this.tick(now);
    const replaced = (name: string, field: { v: unknown; at: Stamp }) =>
      shown === undefined || (shownHere(shown, name, field.v) && (!putOff || field.at[2] === this.device() || field.at[0] > now));
    for (const name of Object.keys(set)) {
      const field = had?.thing.fields[name];
      if (field && compareStamps(at, field.at) <= 0 && replaced(name, field)) at = stampAbove(field.at, this.device());
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
    const read = iconFrom(url);
    // One past what sync carries isn't synced: the tab or Favorite goes without it.
    const icon = read && read.data.length <= SYNC_LIMITS.iconChars ? read : null;
    if (this.icons.size >= ICON_CACHE) this.icons.delete(this.icons.keys().next().value!);
    this.icons.set(url, icon);
    return icon;
  }

  /**
   * One thing as the model has it now (`after`; null when it's gone here, or
   * out of sync's reach), written as from `origin` (S15 §13): yours (`user`)
   * gets a stamp for what you changed, a deletion whenever the copy has it
   * live; another computer's applied (`sync`) and tidying (`tidy`) are only
   * noted as what this computer has. A tidy write that takes away what the
   * copy has live isn't a deletion: a reconcile puts it back, soon.
   */
  private touch(type: string, id: string, after: SyncValues | null, origin: Origin, now: number, icon: { id: string; mime: string; data: string } | null = null, took?: boolean, made?: number, madeHere?: boolean): void {
    // Yours, but leaving out what was already out of sync before your change (sync moved it to Today): no deletion of yours.
    if (origin !== 'user' || (after === null && took === false)) {
      // Without reading what's merged (applying a big merge writes hundreds), but for a deletion: one of something the
      // copy has live comes back.
      if (after === null) {
        if (this.liveInCopy(type, id)) this.due = true;
        this.gone(type, id);
      } else this.setLocal(type, id, after);
      return;
    }
    const had = this.load(type, id);
    const local = after ?? (had ? { deleted: true } : null);
    // Brought back here (an Undo, a tab pinned again, or made again by your change, `madeHere`, though what took it
    // wasn't written): what differs from what this computer last had of it is yours, the rest stays as merged, others'
    // changes made meanwhile included, and it's here again. An edit of what this computer still has, that another
    // computer deleted meanwhile (its deletion not applied here yet), isn't: the deletion stays (S15 §13, edit
    // against delete). Stamped as a join ends: a change from what it was before the join's window (`noteBases`);
    // null, made in it.
    const windowBase = this.windowBases.get(thingKey(type, id));
    const gone = had?.local?.['deleted'] === true;
    const back = windowBase === undefined && ((gone && Boolean(had.was)) || madeHere === true);
    // An edit of a thing here (not made or brought back by it) that this computer never wrote while sync was on (a route
    // waiting for its chord when it joined, say): a change from what the copy has of it, never a new one, which would
    // bring back a deletion elsewhere not read here yet.
    const unwritten = windowBase === undefined && !back && had && had.local === null && after !== null ? withoutDeleted(valuesOf(had.thing)) : null;
    const base = windowBase !== undefined ? (had && Object.keys(had.thing.fields).length > 0 ? windowBase : null) : gone ? (back ? had!.was : null) : (had?.local ?? unwritten);
    let changes = localChanges(had?.thing, base, after);
    // Here again as of now, as a new one is (S15 §13): a deletion elsewhere it's later than doesn't take it.
    if (back && after !== null) changes = { ...changes, deleted: false };
    // Brought back in a join's window (gone in it, then an Undo): here again as of then, though it's as before the window.
    if (windowBase !== undefined && madeHere === true && after !== null) changes = { ...changes, deleted: false };
    // Made here and gone again before the copy had it: gone as of then all the same, since another computer may have made
    // it too, under the same id (a route, by its host), and yours is the later word.
    if (after === null && madeHere === true && !changes) changes = { deleted: true };
    // Taken out by you, from sync's reach, though the copy hasn't read it yet (a route waiting for its chord as this
    // computer joined, the record that made it elsewhere not read yet): gone as of then, so what's read of it later,
    // older, doesn't bring it back.
    if (after === null && took === true && !had && windowBase === undefined && !changes) changes = { deleted: true };
    // Gone in a join's window, and here (synced) before it: gone as of then, though the copy hasn't read it yet (a join
    // refused partway and carried on reads the rest after): what's read later of it is older. Out of sync before the
    // window and after it, and never in it (a tab brought back by an Undo, to Today): no change of yours; in it, made and
    // gone again: gone as of then (another computer may have made it too: a route, by its host).
    if (after === null && (windowBase || (windowBase === null && this.windowLive.has(thingKey(type, id)))) && !changes) changes = { deleted: true };
    if (after === null && windowBase === null && !this.windowLive.has(thingKey(type, id))) changes = null;
    if (after === null) this.gone(type, id);
    if (!changes) {
      if (had && after !== null && !same(had.local, local)) this.setLocal(type, id, local);
      return;
    }
    if (icon && changes['icon'] === icon.id) this.ensureIcon(icon);
    this.record(type, id, changes, now, local, made, windowBase !== undefined ? windowBase : (had?.local ?? null), had);
  }

  /** Gone here: `local` says so, and what it was is kept (`was`), for when it's brought back. */
  private gone(type: string, id: string): void {
    this.sql(
      `UPDATE sync_record SET was = CASE WHEN local IS NOT NULL AND coalesce(json_extract(local, '$.deleted'), 0) = 0 THEN local ELSE was END, local = '{"deleted":true}' WHERE type = ? AND id = ?`,
    ).run(type, id);
  }

  /** Whether the merged copy has this thing, and not as gone. */
  private liveInCopy(type: string, id: string): boolean {
    const row = this.sql(`SELECT json_extract(fields, '$.deleted') AS deleted FROM sync_record WHERE type = ? AND id = ?`).get(type, id) as Row | undefined;
    return row !== undefined && row['deleted'] !== 1;
  }

  /** As a join ends: the kind of node this id was before its window (`noteBases`), if it was in sync's reach then. */
  private windowKind(id: string): string | null {
    for (const kind of NODE_TYPES) if (this.windowBases.get(thingKey(kind, id))) return kind;
    return null;
  }

  /** The kind of node a thing of this id is here, if sync knows it. */
  private nodeType(id: string): string | null {
    const row = this.sql(`SELECT type FROM sync_record WHERE id = ? AND type IN ('folder', 'tab', 'split') LIMIT 1`).get(id) as Row | undefined;
    return row ? str(row['type']) : null;
  }

  /**
   * The stamping hook: called by `write()` inside its transaction, after the
   * rows are written, for every op of the batch. Only synced kinds are looked
   * at; history, windows, downloads and the rest never are. One rule (S15
   * §13): yours are stamped, everything else is noted.
   */
  stamp(written: readonly WriteOp[], now: number): void {
    // Earlier changes of yours waiting with one (made apart, a full disk putting them off): each first, as of its own time.
    const groups = written.map((op): WriteOp[] => {
      if (!op.before) return [op];
      const { before, ...last } = op;
      return [...before.map((step) => ({ k: op.k, id: op.id, ...(op.origin ? { origin: op.origin } : {}), ...step }) as WriteOp), last as WriteOp];
    });
    // A chord's tombstone goes before its tabs' and folders' (and into the same frame where it fits): a computer that
    // reads it first takes the chord with everything in it, kept for its Undo, rather than its tabs one by one. (With
    // whatever went before it: made and deleted, it's made first.)
    // Every write of such a chord goes first, in its order (another computer's making of it applied just before yours
    // took it away: applied first, so what it was is kept, `was`, for an Undo).
    const gone = new Set(groups.filter((group) => group.at(-1)!.k === 'chord' && !group.at(-1)!.value).map((group) => group[0]!.id));
    const ofGone = (group: WriteOp[]) => group[0]!.k === 'chord' && gone.has(group[0]!.id);
    const ops = gone.size > 0 ? [...groups.filter(ofGone), ...groups.filter((group) => !ofGone(group))].flat() : groups.flat();
    for (const op of ops) {
      const origin = opOrigin(op);
      if (!this.due) this.due = this.makesRoom(op);
      switch (op.k) {
        case 'chord':
          this.touch('chord', op.id, op.value ? localChordFields(op.value) : null, origin, now, null, op.took, op.at, op.back);
          break;
        case 'node': {
          if (!op.value) {
            // One gone: whichever kind sync has under its id, or, gone in a join's window before the copy read it, the kind
            // it was before the window (a late snapshot, or a log put back, would otherwise bring it back).
            const type = this.nodeType(op.id) ?? this.windowKind(op.id);
            if (type) this.touch(type, op.id, null, origin, now, null, op.took, op.at, op.back);
            break;
          }
          const node = op.value;
          const icon = node.kind === 'tab' ? this.icon(node.favicon) : null;
          const type = this.nodeType(op.id);
          // The same id as another kind of node: not the same thing.
          if (type && type !== node.kind) break;
          this.touch(node.kind, op.id, localNodeFields(node, icon?.id ?? null), origin, now, icon, op.took, op.at, op.back);
          break;
        }
        case 'favorite': {
          const icon = op.value ? this.icon(op.value.favicon) : null;
          this.touch('favorite', op.id, op.value ? localFavoriteFields(op.value, icon?.id ?? null) : null, origin, now, icon, op.took, op.at, op.back);
          break;
        }
        case 'linkRoute':
          this.touch('route', op.id, op.value ? localRouteFields(op.value) : null, origin, now, null, op.took, op.at, op.back);
          break;
        case 'effect':
          this.touch('effects', op.id, op.value ? localEffectsFields(op.value) : null, origin, now, null, op.took, op.at, op.back);
          break;
        case 'setting':
          if (op.id === 'themes') this.themes(op.value, op.removed ?? [], origin, now, op.at);
          else this.setting(op.id, op.value, origin, now, op.at);
          break;
        default:
          break;
      }
    }
    this.saveClock();
  }

  /** Whether a write brings a chord, a folder or a split here (new, back, or moved), or takes away a Favorite: what waited for one may apply now. */
  private makesRoom(op: WriteOp): boolean {
    // Any change to a Favorite: one gone frees room, one whose address changed frees that address for one refused as a twin.
    if (op.k === 'favorite') return true;
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

  /**
   * Custom themes are things of their own, written as one list. Yours: each
   * one in it as it is now, and a deletion for each you took out of it
   * (`removed`, from the state before your change): never one it lacks for
   * another reason (another computer's not applied yet, past the limit). From
   * sync or tidying: noted, each one in it, and each it no longer has.
   */
  private themes(value: unknown, removed: readonly string[], origin: Origin, now: number, made?: number): void {
    const themes = (Array.isArray(value) ? value : []).map(validTheme).filter((t) => t !== null);
    const ids = new Set(themes.map((t) => t.id));
    for (const theme of themes) this.touch('theme', theme.id, localThemeFields(theme), origin, now, null, undefined, made);
    // One gone frees room for one that waited for it.
    const gone = origin === 'user' ? removed.filter((id) => !ids.has(id)) : (this.sql(`SELECT id FROM sync_record WHERE type = 'theme'`).all() as Row[]).map((row) => str(row['id'])).filter((id) => !ids.has(id) && this.liveHere('theme', id));
    for (const id of gone) {
      this.due = true;
      this.touch('theme', id, null, origin, now, null, undefined, made);
    }
  }

  /** One setting: the settings thing's fields for it, the rest as they were. One that doesn't sync changes nothing. */
  private setting(key: string, value: unknown, origin: Origin, now: number, made?: number): void {
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
    if (origin !== 'user') {
      if (had) this.setLocal('settings', 'settings', after);
      return;
    }
    // Stamped as a join ends: this setting's fields as they were before the join's window (`noteBases`), the rest as here.
    const windowBase = this.windowBases.get(`setting\n${key}`);
    const base: SyncValues = { ...(before ?? {}) };
    if (windowBase !== undefined) {
      for (const name of Object.keys(base)) if (key === 'shortcuts' ? name === family : name === key || name.startsWith(`${key}.`)) delete base[name];
      Object.assign(base, windowBase);
    }
    // The settings are one thing, always there: never a `deleted` of theirs.
    const changes = localChanges(had?.thing, base, after);
    if (changes) this.record('settings', 'settings', changes, now, after, made, base);
    else if (had && !same(had.local, after)) this.setLocal('settings', 'settings', after);
  }

  /**
   * Off, with the merged copy kept (S15 §13): what's written now is noted.
   * Another computer's, applied at last, as what this computer has, so the
   * copy can go once it lacks nothing. Yours goes into the copy as it is: the
   * copy is there only to put back what sync applied, never to undo what you
   * did since, a change or a deletion.
   */
  keptWrite(ops: readonly WriteOp[], now: number): void {
    const theirs = ops.filter((op) => opOrigin(op) !== 'user');
    if (theirs.length > 0) this.stamp(theirs, now);
    for (const op of ops) {
      if (opOrigin(op) !== 'user') continue;
      switch (op.k) {
        case 'chord':
          this.adopt('chord', op.id, op.value ? localChordFields(op.value) : null);
          break;
        case 'node': {
          const type = op.value?.kind ?? this.nodeType(op.id);
          const icon = op.value?.kind === 'tab' ? this.icon(op.value.favicon) : null;
          if (type) this.adopt(type, op.id, op.value ? localNodeFields(op.value, icon?.id ?? null) : null);
          break;
        }
        case 'favorite':
          this.adopt('favorite', op.id, op.value ? localFavoriteFields(op.value, this.icon(op.value.favicon)?.id ?? null) : null);
          break;
        case 'linkRoute':
          this.adopt('route', op.id, op.value ? localRouteFields(op.value) : null);
          break;
        case 'effect':
          this.adopt('effects', op.id, op.value ? localEffectsFields(op.value) : null);
          break;
        case 'setting': {
          if (op.id === 'themes') {
            const themes = (Array.isArray(op.value) ? op.value : []).map(validTheme).filter((t) => t !== null);
            for (const theme of themes) this.adopt('theme', theme.id, localThemeFields(theme));
            for (const id of op.removed ?? []) if (!themes.some((t) => t.id === id)) this.adopt('theme', id, null);
            break;
          }
          const fields = op.value === null ? {} : localSettingFields(op.id, op.value, this.platform);
          if (fields) this.adopt('settings', 'settings', fields, true);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Your value of a thing, taken into the kept copy as it is (`partial`: only these fields, the settings'). */
  private adopt(type: string, id: string, after: SyncValues | null, partial = false): void {
    const had = this.load(type, id);
    if (!had) return;
    const fields = { ...had.thing.fields };
    const at: Stamp = [0, 0, this.device()];
    if (after === null) fields['deleted'] = { v: true, at: fields['deleted']?.at ?? at };
    else {
      for (const [name, v] of Object.entries(after)) fields[name] = { v, at: fields[name]?.at ?? at };
      if (fields['deleted']) fields['deleted'] = { v: false, at: fields['deleted'].at };
    }
    const local = after === null ? { deleted: true } : partial ? { ...(had.local && had.local['deleted'] !== true ? had.local : {}), ...after } : after;
    this.save({ type, id, fields }, local, had.cost);
  }

  /* ---------- turning on ---------- */

  /**
   * This computer's synced things as they are now, from its rows, a page at a
   * time (`rowThings`), each stamped when what sync keeps of it was last made
   * (`row_origin.at`), so joining doesn't make them newer than they are (S15
   * §6), and with the icons they name first. A setting still at its default
   * counts as never set, and a row sync or tidying last wrote (`row_origin`) as
   * no change of this computer's: stamped older than anything, so a synced one
   * wins (as an import's, §12).
   */
  *localPages(size = 200): Generator<DataRecord[]> {
    const device = this.device();
    for (const page of this.rowThings(size)) {
      const out: DataRecord[] = [];
      for (const thing of page) {
        if (thing.icon && thing.set['icon'] === thing.icon.id) out.push({ type: 'icon', id: thing.icon.id, set: { mime: thing.icon.mime, data: thing.icon.data } });
        // A row another computer's change wrote (sync), or tidying, isn't this computer's change: it counts as older
        // than anything, so it never stands in front of a later change made elsewhere meanwhile (S15 §13).
        const notMine = (origin: Origin | null) => origin === 'sync' || origin === 'tidy';
        if (thing.type !== 'settings') {
          out.push({ type: thing.type, id: thing.id, at: notMine(thing.origin) ? [0, 0, device] : rowStamp(thing.ms(''), device), set: thing.set });
          continue;
        }
        const byMs = new Map<number, SyncValues>();
        for (const [name, v] of Object.entries(thing.set)) {
          const ms = thing.atDefault(name) || notMine(thing.fieldOrigin?.(name) ?? null) ? 0 : thing.ms(name);
          byMs.set(ms, { ...byMs.get(ms), [name]: v });
        }
        for (const [ms, set] of byMs) out.push({ type: 'settings', id: 'settings', at: [ms, 0, device], set });
      }
      yield out;
    }
  }

  /** All of `localPages` at once (setting up, and tests). */
  localThings(): DataRecord[] {
    return [...this.localPages(1000)].flat();
  }

  /**
   * Before a write sync won't stamp (a join between its reading and its end):
   * what sync keeps of each synced thing yours changes, as its row has it now,
   * the first time in the join (`sync_noted.base`). Your changes in the
   * window are what differs from that, as when sync is on.
   */
  noteBases(ops: readonly WriteOp[]): Set<WriteOp> {
    const noted = this.sql('SELECT 1 FROM sync_noted WHERE k = ? AND id = ?');
    const note = this.sql('INSERT OR IGNORE INTO sync_noted (k, id, at, base) VALUES (?, ?, NULL, ?)');
    // Out of sync before your write and after it (a Today tab you closed, once unpinned): no change of what sync keeps, so
    // never one of the window's, and never what times one (the unpinning's deletion stays as of then).
    const outside = new Set<WriteOp>();
    for (const op of ops) {
      if (opOrigin(op) !== 'user' || !WINDOW_KINDS.has(op.k) || !this.inWindow(op)) continue;
      const before = this.keptOf(this.rowOp(op.k, op.id) ?? ({ k: op.k, id: op.id, value: null } as WriteOp));
      // (Not one made and taken out again before its write, `back` or `took`: in sync's reach in between.)
      if (op.k !== 'setting' && stepsOf(op).every((step) => step.took !== true && !step.back && [...this.keptOf(step).values()].every((set) => set === null)) && [...before.values()].every((set) => set === null)) {
        outside.add(op);
        continue;
      }
      if (noted.get(op.k, op.id)) continue;
      note.run(op.k, op.id, JSON.stringify([...before]));
    }
    return outside;
  }

  /**
   * A write sync didn't stamp (sync on, a join between its reading and its
   * end, which can wait as long as Settings asks): your ops, noted by id with
   * when you made them (`sync_noted`, in the write's transaction, so a crash
   * meanwhile loses none), to stamp from their rows as the join ends.
   */
  noteUnstamped(ops: readonly WriteOp[], outside: ReadonlySet<WriteOp> = new Set()): void {
    const note = this.sql('INSERT INTO sync_noted (k, id, at) VALUES (?, ?, ?) ON CONFLICT(k, id) DO UPDATE SET at = max(coalesce(at, 0), coalesce(excluded.at, 0))');
    const live = this.sql('UPDATE sync_noted SET live = 1 WHERE k = ? AND id = ?');
    for (const op of ops) {
      // Another computer's, applied, or tidying: never stamped. Nor one made before the join began (while sync was off,
      // its write put off by a full disk): it's what this computer had then, as the join reads its rows (`addLocal`), and
      // the drift check after takes it so too, never as a change in the window. Nor one out of sync before and after.
      if (opOrigin(op) !== 'user' || !this.inWindow(op) || outside.has(op)) continue;
      if (WINDOW_KINDS.has(op.k)) note.run(op.k, op.id, op.at ?? null);
      // In sync at some point in the window (made, then gone again): its going is a deletion, as of then.
      // So was one made and taken out again before its write landed (`back`, gone).
      // Each change it carries counts (`before`: earlier ones of yours, waiting with it).
      const synced = op.k === 'chord' || op.k === 'node' || op.k === 'favorite' || op.k === 'linkRoute' || op.k === 'effect';
      const steps = stepsOf(op);
      if (synced && steps.some((step) => (step.value !== null ? [...this.keptOf(step).values()].some((set) => set !== null) : step.back === true))) live.run(op.k, op.id);
      // Brought back in it (an Undo): here again as of then, as outside a join, whatever it was before the window.
      if (synced && op.value !== null && steps.some((step) => step.back === true)) note.run('back', `${op.k}\n${op.id}`, op.at ?? null);
      // The themes you took out of the list in that window.
      if (op.k === 'setting' && op.id === 'themes') for (const id of op.removed ?? []) note.run('themeRemoved', id, op.at ?? null);
    }
  }

  /** Whether a change was made in this join's window: since it began (`compactedAt`, set as it starts). */
  private inWindow(op: WriteOp): boolean {
    return op.at === undefined || op.at >= this.meta.compactedAt;
  }

  get unstamped(): boolean {
    return this.sql('SELECT 1 FROM sync_noted LIMIT 1').get() !== undefined;
  }

  /** Whether the merged copy has this chord, live: one the synced setup keeps. */
  private chordInCopy(id: unknown): boolean {
    return typeof id === 'string' && this.liveInCopy('chord', id);
  }

  /**
   * After *Use the synced setup* (`makingWay`): this computer's chords still in
   * chord.db that the merged copy hasn't, the ones that were to make way (the
   * change that took them lost: a crash before its write), and the synced
   * chord they make way into (the one asked for, or the first synced one;
   * null when there's none left: they stay, `adoptChords`). Null once there
   * are none.
   */
  chordsMakingWay(): { chordIds: string[]; to: string | null } | null {
    const way = this.meta.makingWay;
    if (!way) return null;
    const chordIds = this.chordsOutOfCopy();
    const to = this.chordInCopy(way.to) ? way.to : (this.syncedChords()[0] ?? null);
    return chordIds.length > 0 ? { chordIds, to } : null;
  }

  /** This computer's chords the merged copy hasn't live: what makes way for the synced setup, or joins it when there's none. */
  chordsOutOfCopy(): string[] {
    return (this.sql('SELECT id FROM chord WHERE deleted_at IS NULL').all() as Row[]).map((r) => str(r['id'])).filter((id) => !this.chordInCopy(id));
  }

  /**
   * After *Use the synced setup*, with no synced chord left for this
   * computer's to make way into (all deleted since, and the change that was to
   * take them lost in a crash): they stay, so they join the copy with what's
   * pinned in them, as a join with no synced chord has them (`keepChords`),
   * each as of its row, and go to the folder. Not one the copy knows (gone
   * there: its deletion is applied here in its turn). How many things joined.
   */
  adoptChords(chordIds: readonly string[], size = 200): number {
    const ids = new Set(chordIds);
    const self = this.device();
    let added = 0;
    for (const page of this.rowThings(size)) {
      for (const thing of page) {
        const chord = thing.type === 'chord' ? thing.id : NODE_TYPES.has(thing.type) ? (thing.set['pos'] as { chord?: unknown } | undefined)?.chord : undefined;
        if (typeof chord !== 'string' || !ids.has(chord) || this.load(thing.type, thing.id)) continue;
        if (thing.icon && thing.set['icon'] === thing.icon.id) this.ensureIcon(thing.icon);
        const at = rowStamp(thing.ms(''), self);
        const record: DataRecord = { type: thing.type, id: thing.id, at, set: { ...thing.set, deleted: false } };
        this.save(mergeRecord(undefined, record).thing, thing.set);
        this.clock = seenStamp(this.loadClock(), at, Date.now(), self);
        this.clockDirty = true;
        this.sql('INSERT INTO sync_outbox (record) VALUES (?)').run(JSON.stringify(record));
        this.pending++;
        added++;
      }
    }
    this.saveClock();
    return added;
  }

  /**
   * As a join ends, in the transaction that ends it: what you wrote in its
   * window (nothing was stamped then), read back from its rows by id and
   * stamped as the stamping hook would have, the real edits they are: a thing
   * changed, made, or deleted by id, each as of when you made it, and each a
   * change from what it was before the window (`noteBases`): an edit of one
   * another computer deleted leaves the deletion, as when sync is on. Only
   * those ids, never a whole scan. `synced-setup`: this computer's chords
   * make way, and what's in them with them; a chord the synced setup keeps,
   * and what's in it, is stamped.
   */
  stampJoinWindow(mode: 'all' | 'synced-setup', now: number): number {
    const ops: WriteOp[] = [];
    const noted = this.sql('SELECT k, id, at, base, live FROM sync_noted').all() as Row[];
    const themesRemoved = noted.filter((r) => r['k'] === 'themeRemoved').map((r) => str(r['id']));
    const broughtBack = new Set(noted.filter((r) => r['k'] === 'back').map((r) => str(r['id'])));
    for (const r of noted) {
      const [k, id] = [str(r['k']), str(r['id'])];
      if (!WINDOW_KINDS.has(k)) continue;
      for (const [key, set] of parseJson<[string, SyncValues | null][]>(r['base'], [])) {
        this.windowBases.set(key, set);
        if (r['live'] === 1) this.windowLive.add(key);
      }
      const op = this.rowOp(k, id) ?? ({ k, id, value: null } as WriteOp);
      if (mode === 'synced-setup' && op.k === 'chord' && !this.chordInCopy(id)) continue;
      if (mode === 'synced-setup' && op.k === 'node') {
        // Gone: the chord it was in before the window, else the one the copy has it in.
        const kind = this.windowKind(id);
        const before = kind ? (this.windowBases.get(thingKey(kind, id))?.['pos'] as { chord?: unknown } | undefined)?.chord : undefined;
        const type = this.nodeType(id);
        const inCopy = type ? (this.load(type, id)?.thing.fields['pos']?.v as { chord?: unknown } | undefined)?.chord : undefined;
        if (!this.chordInCopy(op.value?.chordId ?? before ?? inCopy)) continue;
      }
      const removed = k === 'setting' && id === 'themes' && themesRemoved.length > 0 ? { removed: themesRemoved } : {};
      const back = op.value !== null && broughtBack.has(`${k}\n${id}`) ? { back: true } : {};
      ops.push({ ...op, ...removed, ...back, ...(typeof r['at'] === 'number' && r['at'] > 0 ? { at: r['at'] } : {}) } as WriteOp);
    }
    this.sql('DELETE FROM sync_noted').run();
    try {
      if (ops.length > 0) this.stamp(ops, now);
    } finally {
      this.windowBases.clear();
      this.windowLive.clear();
    }
    return ops.length;
  }

  /** One entity as its row has it now, as a write of it would carry it; null when it has no row. */
  private rowOp(k: string, id: string): WriteOp | null {
    switch (k) {
      case 'chord': {
        const row = this.sql('SELECT id, profile_id, name, icon, theme, rank, proxy, created_at FROM chord WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
        return row ? { k, id, value: restoreChord(chordOf(row)) } : null;
      }
      case 'node': {
        const row = this.sql(`${nodeSelect(', i.mime AS icon_mime, i.data AS icon_data', '\n     LEFT JOIN favicon i ON i.key = t.favicon_key')} AND n.id = ?`).get(id) as Row | undefined;
        const node = row ? nodeOf(row, iconOf(row)) : null;
        return node ? { k, id, value: node } : null;
      }
      case 'favorite': {
        const row = this.sql('SELECT f.id, f.url, f.title, f.rank, f.created_at, i.mime AS icon_mime, i.data AS icon_data FROM favorite f LEFT JOIN favicon i ON i.key = f.favicon_key WHERE f.id = ?').get(id) as Row | undefined;
        return row ? { k, id, value: favoriteOf(row, iconOf(row)) } : null;
      }
      case 'linkRoute': {
        const row = this.sql('SELECT host, chord_id, created_at FROM link_route WHERE host = ?').get(id) as Row | undefined;
        return row ? { k, id, value: { host: str(row['host']), chordId: str(row['chord_id']), createdAt: num(row['created_at']) } } : null;
      }
      case 'effect': {
        const row = this.sql('SELECT host, wet, css, css_on, hidden, presets, duet, created_at, updated_at FROM effect WHERE host = ?').get(id) as Row | undefined;
        const site = row ? siteEffectsOf(row) : null;
        return site ? ({ k, id, value: site } as WriteOp) : null;
      }
      case 'setting': {
        const row = this.sql('SELECT value FROM setting WHERE key = ?').get(id) as Row | undefined;
        return row ? ({ k, id, value: parseJson<unknown>(row['value'], null) } as WriteOp) : null;
      }
      default:
        return null;
    }
  }

  /**
   * What sync keeps of a write's entity, by thing (`type\nid`; a setting's
   * fields by `setting\nkey`, a list of themes by each theme): null for one
   * sync doesn't keep (a tab in Today), or that isn't there.
   */
  private keptOf(op: WriteOp): Map<string, SyncValues | null> {
    const out = new Map<string, SyncValues | null>();
    switch (op.k) {
      case 'chord':
        out.set(thingKey('chord', op.id), op.value ? localChordFields(op.value) : null);
        break;
      case 'node':
        if (op.value) out.set(thingKey(op.value.kind, op.id), localNodeFields(op.value, op.value.kind === 'tab' ? (this.icon(op.value.favicon)?.id ?? null) : null));
        // Not here: whichever kind it turns out to be, it wasn't (a Today tab brought back by an Undo stays out of sync).
        else for (const kind of NODE_TYPES) out.set(thingKey(kind, op.id), null);
        break;
      case 'favorite':
        out.set(thingKey('favorite', op.id), op.value ? localFavoriteFields(op.value, this.icon(op.value.favicon)?.id ?? null) : null);
        break;
      case 'linkRoute':
        out.set(thingKey('route', op.id), op.value ? localRouteFields(op.value) : null);
        break;
      case 'effect':
        out.set(thingKey('effects', op.id), op.value ? localEffectsFields(op.value) : null);
        break;
      case 'setting':
        if (op.id === 'themes') for (const theme of (Array.isArray(op.value) ? op.value : []).map(validTheme)) if (theme) out.set(thingKey('theme', theme.id), localThemeFields(theme));
        if (op.id !== 'themes') out.set(`setting\n${op.id}`, op.value === null ? {} : (localSettingFields(op.id, op.value, this.platform) ?? {}));
        break;
      default:
        break;
    }
    return out;
  }

  /**
   * One kind's rows a page at a time: at most `size`, and about
   * ROW_PAGE_CHARS of them. `heads` lists each key after a key, with
   * its size (`key`, `chars`: bytes, by `octet_length`, which reads no text), `rows` the rows from just after one key up to
   * another, with only the columns the projection needs.
   */
  private *paged(heads: string, rows: string, size: number): Generator<Row[]> {
    let after = '';
    for (;;) {
      const keys = this.sql(heads).all(after, size) as Row[];
      if (keys.length === 0) return;
      let chars = 0;
      let take = 0;
      for (const key of keys) {
        if (take > 0 && chars + num(key['chars']) > ROW_PAGE_CHARS) break;
        chars += num(key['chars']);
        take++;
      }
      const last = str(keys[take - 1]!['key']);
      yield this.sql(rows).all(after, last) as Row[];
      if (take === keys.length && keys.length < size) return;
      after = last;
    }
  }

  /**
   * What chord.db's rows have of each synced thing, projected as the stamping
   * hook projects a write (core's `local*Fields`), a page at a time (`paged`,
   * by bytes, with only the columns the projection needs): chords, nodes,
   * Favorites, routes, Effects, themes, and the settings thing last, gathered
   * across pages. Each with its row's time (`ms`: when what sync keeps of it
   * was last made, `row_origin`, or its last write where that isn't known), who
   * last wrote that (`origin`), whether a setting is at its default, and the
   * icon it names. Pinned nodes of chords that are here, and routes to them,
   * only.
   */
  private *rowThings(size: number): Generator<RowThing[]> {
    const chords = new Set<string>();
    const ms = (r: Row) => num(r['origin_at'] ?? r['updated_at']);
    const at = (r: Row) => () => ms(r);
    const by = (r: Row): Origin | null => (r['origin'] === 'user' || r['origin'] === 'sync' || r['origin'] === 'tidy' ? r['origin'] : null);
    const never = () => false;
    for (const rows of this.paged(
      'SELECT id AS key, octet_length(name) + octet_length(theme) + 200 AS chars FROM chord WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?',
      `SELECT c.id, c.profile_id, c.name, c.icon, c.theme, c.rank, c.proxy, c.created_at, c.updated_at, o.origin, o.at AS origin_at FROM chord c
         LEFT JOIN row_origin o ON o.k = 'chord' AND o.id = c.id WHERE c.deleted_at IS NULL AND c.id > ? AND c.id <= ? ORDER BY c.id`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        const chord = restoreChord(chordOf(r));
        chords.add(chord.id);
        const set = localChordFields(chord);
        if (set) page.push({ type: 'chord', id: chord.id, set, ms: at(r), atDefault: never, origin: by(r), icon: null });
      }
      yield page;
    }
    for (const rows of this.paged(
      `SELECT n.id AS key, coalesce(length(i.data), 0) + coalesce(octet_length(t.url), 0) + coalesce(octet_length(t.title), 0) + coalesce(octet_length(t.custom_title), 0) + coalesce(octet_length(f.title), 0) + 200 AS chars
         FROM node n LEFT JOIN tab t ON t.node_id = n.id LEFT JOIN folder f ON f.node_id = n.id LEFT JOIN favicon i ON i.key = t.favicon_key
        WHERE n.deleted_at IS NULL AND n.id > ? ORDER BY n.id LIMIT ?`,
      `${nodeSelect(', i.mime AS icon_mime, i.data AS icon_data, o.origin, o.at AS origin_at', "\n     LEFT JOIN favicon i ON i.key = t.favicon_key\n     LEFT JOIN row_origin o ON o.k = 'node' AND o.id = n.id")} AND n.id > ? AND n.id <= ? ORDER BY n.id`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        const node: SidebarNode | null = nodeOf(r, iconOf(r));
        if (!node || !chords.has(node.chordId)) continue;
        const icon = node.kind === 'tab' ? this.icon(node.favicon) : null;
        const set = localNodeFields(node, icon?.id ?? null);
        if (set) page.push({ type: node.kind, id: node.id, set, ms: at(r), atDefault: never, origin: by(r), icon });
      }
      yield page;
    }
    for (const rows of this.paged(
      'SELECT f.id AS key, coalesce(length(i.data), 0) + octet_length(f.url) + octet_length(f.title) + 100 AS chars FROM favorite f LEFT JOIN favicon i ON i.key = f.favicon_key WHERE f.id > ? ORDER BY f.id LIMIT ?',
      `SELECT f.id, f.url, f.title, f.rank, f.created_at, f.updated_at, i.mime AS icon_mime, i.data AS icon_data, o.origin, o.at AS origin_at FROM favorite f
         LEFT JOIN favicon i ON i.key = f.favicon_key LEFT JOIN row_origin o ON o.k = 'favorite' AND o.id = f.id WHERE f.id > ? AND f.id <= ? ORDER BY f.id`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        const favorite = favoriteOf(r, iconOf(r));
        const icon = this.icon(favorite.favicon);
        page.push({ type: 'favorite', id: favorite.id, set: localFavoriteFields(favorite, icon?.id ?? null), ms: at(r), atDefault: never, origin: by(r), icon });
      }
      yield page;
    }
    for (const rows of this.paged(
      'SELECT host AS key, 100 AS chars FROM link_route WHERE host > ? ORDER BY host LIMIT ?',
      `SELECT r.host, r.chord_id, r.created_at, r.updated_at, o.origin, o.at AS origin_at FROM link_route r LEFT JOIN row_origin o ON o.k = 'linkRoute' AND o.id = r.host
        WHERE r.host > ? AND r.host <= ? ORDER BY r.host`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        if (!chords.has(str(r['chord_id']))) continue;
        page.push({ type: 'route', id: str(r['host']), set: localRouteFields({ host: str(r['host']), chordId: str(r['chord_id']), createdAt: num(r['created_at']) }), ms: at(r), atDefault: never, origin: by(r), icon: null });
      }
      yield page;
    }
    for (const rows of this.paged(
      'SELECT host AS key, octet_length(css) + octet_length(hidden) + octet_length(presets) + octet_length(duet) + 100 AS chars FROM effect WHERE host > ? ORDER BY host LIMIT ?',
      `SELECT e.host, e.wet, e.css, e.css_on, e.hidden, e.presets, e.duet, e.created_at, e.updated_at, o.origin, o.at AS origin_at FROM effect e
         LEFT JOIN row_origin o ON o.k = 'effect' AND o.id = e.host WHERE e.host > ? AND e.host <= ? ORDER BY e.host`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        const site = siteEffectsOf(r);
        const set = site ? localEffectsFields(site) : null;
        if (site && set) page.push({ type: 'effects', id: site.host, set, ms: at(r), atDefault: never, origin: by(r), icon: null });
      }
      yield page;
    }
    // Settings: what this computer keeps of them, gathered a page at a time, then one thing; themes each.
    const defaults = defaultFields(this.platform);
    const settings: SyncValues = {};
    const settingMs = new Map<string, number>();
    const settingOrigin = new Map<string, Origin | null>();
    for (const rows of this.paged(
      'SELECT key AS key, octet_length(value) + 50 AS chars FROM setting WHERE key > ? ORDER BY key LIMIT ?',
      `SELECT s.key, s.value, s.updated_at, o.origin, o.at AS origin_at FROM setting s LEFT JOIN row_origin o ON o.k = 'setting' AND o.id = s.key WHERE s.key > ? AND s.key <= ? ORDER BY s.key`,
      size,
    )) {
      const page: RowThing[] = [];
      for (const r of rows) {
        const key = str(r['key']);
        const value = parseJson<unknown>(r['value'], null);
        if (key === 'themes') {
          for (const theme of (Array.isArray(value) ? value : []).map(validTheme)) if (theme) page.push({ type: 'theme', id: theme.id, set: localThemeFields(theme), ms: at(r), atDefault: never, origin: by(r), icon: null });
          continue;
        }
        for (const [name, v] of Object.entries(localSettingFields(key, value, this.platform) ?? {})) {
          settings[name] = v;
          settingMs.set(name, ms(r));
          settingOrigin.set(name, by(r));
        }
      }
      yield page;
    }
    if (Object.keys(settings).length > 0) {
      // The settings thing is written by many rows: it's yours where any field of it is.
      const origin = [...settingOrigin.values()].includes('user') ? 'user' : ([...settingOrigin.values()][0] ?? null);
      yield [
        {
          type: 'settings',
          id: 'settings',
          set: settings,
          ms: (name) => settingMs.get(name) ?? 0,
          atDefault: (name) => defaults.has(name) && same(defaults.get(name), settings[name]),
          origin,
          fieldOrigin: (name) => settingOrigin.get(name) ?? null,
          icon: null,
        },
      ];
    }
  }

  /**
   * `local` checked against the rows, a page at a time (S15 §13), at launch
   * and with each idle reconcile: a safety net for anything that slipped past
   * the stamping hook. Each step is one synchronous slice for the caller to
   * run in a transaction. Yields how many things it mended.
   *
   * The rows say who last wrote them (`row_origin`), and the drift rule goes
   * by that, as stamping does. A differing field in a row you wrote (`user`)
   * is your edit: stamped at the row's time, or, where that doesn't beat the
   * field's stamp, just above it, unless another computer's value there is
   * later than your row (theirs wins, as it would have). A difference in a row
   * sync or tidying wrote, or one whose writer isn't known (written by an
   * older Chord), is how a row is projected: it only refreshes `local`, with no
   * stamp and nothing sent; so does every difference the first time under a
   * new projection (`PROJECTION`: an icon past the cap read as none, a setting
   * newly synced). A thing the copy doesn't have is added only from a row you
   * wrote, and a pinned node or a route only into a chord the copy has: never
   * a chord, so this computer's chords that made way for the synced setup
   * stay out. A thing `local` has and the rows don't is refreshed as gone,
   * never stamped: its time isn't known, and the reconcile then puts the
   * copy's back, which loses nothing.
   */
  *driftRepairs(size = 200): Generator<number> {
    const silent = this.meta.projection !== PROJECTION;
    const self = this.device();
    const seen = new Set<string>();
    const localOf = this.sql('SELECT local FROM sync_record WHERE type = ? AND id = ?');
    const mend = (thing: RowThing): number => {
      const { type, id, set, icon } = thing;
      seen.add(thingKey(type, id));
      const row = localOf.get(type, id) as Row | undefined;
      const yours = (name: string) => (thing.fieldOrigin ? thing.fieldOrigin(name) : thing.origin) === 'user';
      if (!row) {
        // Not in the copy at all: only one you wrote, and only into a chord the copy has (a node, a route).
        if (silent || type === 'chord' || thing.origin !== 'user') return 0;
        const chord = NODE_TYPES.has(type) ? (set['pos'] as { chord?: unknown } | undefined)?.chord : type === 'route' ? set['chord'] : undefined;
        if ((NODE_TYPES.has(type) || type === 'route') && !this.chordInCopy(chord)) return 0;
      }
      const had = row?.['local'] ? parseJson<SyncValues | null>(row['local'], null) : null;
      const live = had && had['deleted'] !== true ? had : null;
      if (row && live && Object.keys(set).every((name) => same(set[name], live[name]))) return 0;
      // In the copy, and never written here since it came (`local` empty: read from the folder, and its apply not in
      // chord.db yet, say a crash took it): the row is from before, what joining with the synced setup set aside, and
      // no change of yours. Only `local` is refreshed; the reconcile then applies the copy's.
      if (silent || (row && !had)) {
        this.setLocal(type, id, set);
        return 1;
      }
      const loaded = row ? this.load(type, id) : null;
      let merged: SyncThing | undefined = loaded?.thing;
      const groups = new Map<string, { at: Stamp; set: SyncValues }>();
      const candidates: [string, unknown][] = Object.entries(set).filter(([name, v]) => !(live && name in live && same(live[name], v)));
      // Gone in the copy, live in your rows: brought back here, if this computer had it gone too; if it still has it
      // (another computer's deletion not applied here yet), the deletion stays.
      if (merged && isGone(merged) && !live) candidates.push(['deleted', false]);
      for (const [name, v] of candidates) {
        if (name === 'deleted' ? thing.origin !== 'user' : !yours(name)) continue;
        const field = merged?.fields[name];
        if (field && same(field.v, v)) continue;
        const rowAt = rowStamp(thing.ms(name), self);
        // Your edit wins over what it replaced: this computer's own value, or another's no later than your row.
        const at = !field || compareStamps(rowAt, field.at) > 0 ? rowAt : field.at[2] === self || field.at[0] <= rowAt[0] ? stampAbove(field.at, self) : null;
        if (!at) continue;
        const key = JSON.stringify(at);
        const group = groups.get(key) ?? { at, set: {} };
        group.set[name] = v;
        groups.set(key, group);
      }
      if (groups.size === 0) {
        if (row) this.setLocal(type, id, set);
        return row ? 1 : 0;
      }
      if (icon && [...groups.values()].some((group) => group.set['icon'] === icon.id)) this.ensureIcon(icon);
      const records: DataRecord[] = [];
      for (const { at, set: fields } of groups.values()) {
        const record: DataRecord = { type, id, at, set: fields };
        merged = mergeRecord(merged, record).thing;
        records.push(record);
        this.clock = seenStamp(this.loadClock(), at, Date.now(), self);
        this.clockDirty = true;
      }
      this.saveClock();
      this.save(merged!, set, loaded?.cost ?? 0);
      for (const record of records) this.sql('INSERT INTO sync_outbox (record) VALUES (?)').run(JSON.stringify(record));
      this.pending += records.length;
      return 1;
    };
    for (const page of this.rowThings(size)) {
      let mended = 0;
      for (const thing of page) mended += mend(thing);
      yield mended;
    }
    // In `local`, not in the rows: refreshed as gone (no stamp), a page of keys at a time. Tombstones are told by their
    // size (`octet_length` reads no text), and `local` itself is read only for one the rows didn't have: an Effects'
    // `local` holds its CSS, and reading every one to find the few took 7 ms.
    const localOfGone = this.sql('SELECT local FROM sync_record WHERE type = ? AND id = ?');
    // A route to a chord that isn't here (deleted here, or not come yet) is no row the pages hold, yet it's here, waiting
    // for its chord: what this computer has of it stays as it is.
    const waiting = this.sql('SELECT 1 FROM link_route r WHERE r.host = ? AND NOT EXISTS (SELECT 1 FROM chord c WHERE c.id = r.chord_id)');
    let after = { type: '', id: '' };
    for (;;) {
      const rows = this.sql(
        `SELECT type, id FROM sync_record WHERE (type, id) > (?, ?) AND type IN ('chord', 'folder', 'tab', 'split', 'favorite', 'route', 'effects', 'theme')
           AND local IS NOT NULL AND (octet_length(local) <> 16 OR local <> '{"deleted":true}') ORDER BY type, id LIMIT 1000`,
      ).all(after.type, after.id) as Row[];
      let mended = 0;
      for (const row of rows) {
        const type = str(row['type']);
        const id = str(row['id']);
        after = { type, id };
        if (seen.has(thingKey(type, id)) || (type === 'route' && waiting.get(id))) continue;
        const local = parseJson<SyncValues | null>((localOfGone.get(type, id) as Row | undefined)?.['local'], null);
        if (!local || local['deleted'] === true) continue;
        this.setLocal(type, id, { deleted: true });
        mended++;
      }
      yield mended;
      if (rows.length < 1000) break;
    }
    if (silent) this.setMeta({ projection: PROJECTION });
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
   * chords make way), with its settings older than any synced one. `makeWay`
   * false: a synced setup with no chord (a folder whose other logs haven't come
   * yet, say), nothing to make way for, so this computer's chords, and what's
   * in them, join it. Each thing here says it's here (`deleted: false`) at its
   * row's stamp, so one changed here after another computer deleted it stays,
   * for everyone, and one that wasn't goes (S15 §13).
   */
  addLocal(mode: 'all' | 'synced-setup', records: readonly DataRecord[] = this.localThings(), makeWay = true): Map<string, Set<string>> {
    const changes = new Map<string, Set<string>>();
    for (const record of records) {
      if (mode === 'synced-setup' && makeWay && (record.type === 'chord' || NODE_TYPES.has(record.type))) {
        // This computer's chords make way, with what's pinned in them; what you pinned in a chord the synced setup
        // keeps (while sync was off, say) joins it, unless the synced setup has it already (its version stays). One the
        // synced setup has too (the same id), live: what this computer has of it is noted (`local`), so a change of yours
        // after is a change of it, never a new one that would bring back a deletion not read here yet (S15 §13). Main
        // applies the synced version, and notes that in its turn.
        const had = this.load(record.type, record.id);
        if (had && had.local === null && !isGone(had.thing)) this.setLocal(record.type, record.id, record.set);
        if (record.type === 'chord' || had) continue;
        if (!this.chordInCopy((record.set['pos'] as { chord?: unknown } | undefined)?.chord)) continue;
      }
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
    // `local` written as rows are projected now: the drift check has nothing of an older version's to refresh.
    if (this.meta.projection !== PROJECTION) this.setMeta({ projection: PROJECTION });
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
        // A node whose id is already another kind of node's here (a folder under a pinned tab's id): refused, and counted.
        // Things are (type, id) everywhere, and a node's id is one thing only.
        if (!had && NODE_TYPES.has(r.type) && this.sql(`SELECT 1 FROM sync_record WHERE id = ? AND type IN ('folder', 'tab', 'split') AND type != ?`).get(r.id, r.type)) {
          result.dropped++;
          continue;
        }
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
      if (r.type === 'device' && r.id === self && merged.changed.includes('removed') && merged.thing.fields['removed']?.v === true) {
        // Stamped as this computer, which is on and never turned itself off: a copy of this profile, turning off as it.
        if (merged.thing.fields['removed'].at[2] === self) result.removedByCopy = true;
        else result.removed = merged.thing.fields['removed'].at[0];
      }
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
      `INSERT INTO sync_cursor (generation, device, segment, head, offset, frame, snapshot, last_at, last_hash, last_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(generation, device, segment) DO UPDATE SET head = excluded.head, offset = excluded.offset, frame = excluded.frame, snapshot = excluded.snapshot,
         last_at = excluded.last_at, last_hash = excluded.last_hash, last_mtime = excluded.last_mtime`,
    ).run(generation, device, segment, cursor.head, cursor.offset, cursor.frame, cursor.snapshot ? 1 : 0, cursor.last?.at ?? null, cursor.last?.hash ?? null, cursor.last?.mtime ?? null);
  }

  cursors(generation: number): { device: string; segment: number; cursor: SegmentCursor }[] {
    return (this.sql('SELECT * FROM sync_cursor WHERE generation = ?').all(generation) as Row[]).map((r) => ({
      device: str(r['device']),
      segment: num(r['segment']),
      cursor: {
        head: str(r['head']),
        offset: num(r['offset']),
        frame: num(r['frame']),
        snapshot: num(r['snapshot']) === 1,
        ...(typeof r['last_at'] === 'number' && typeof r['last_hash'] === 'string' ? { last: { at: r['last_at'], hash: r['last_hash'], ...(typeof r['last_mtime'] === 'number' ? { mtime: r['last_mtime'] } : {}) } } : {}),
      },
    }));
  }

  /* ---------- applying ---------- */

  /** Things by key, each with the names of its fields to apply: every field when `names` is empty. */
  private changeList(changes: Map<string, Set<string>>): SyncChange[] {
    const out: SyncChange[] = [];
    for (const [key, names] of changes) {
      const [type, id] = key.split('\n') as [string, string];
      const had = this.load(type, id);
      if (!had) continue;
      const fill = type === 'chord' || type === 'theme' || NODE_TYPES.has(type);
      out.push({ thing: fill && !isGone(had.thing) ? this.whole(had) : had.thing, names: names.size > 0 ? [...names] : Object.keys(had.thing.fields) });
    }
    return out;
  }

  /**
   * A chord, theme, folder, tab or split whose fields haven't all come (a
   * rename read before the record that made it, or that record gone from the
   * folder with a log put back to an old version): what's missing from what
   * this computer has of it, or for a chord or theme a default, so it's
   * applied (and kept), never dropped, until they come. A pinned node has no
   * default (a tab's home): one this computer never had waits for them.
   */
  private whole(had: { thing: SyncThing; local: SyncValues | null }): SyncThing {
    const fields = had.thing.fields;
    if (NODE_TYPES.has(had.thing.type)) {
      const local = had.local && had.local['deleted'] !== true ? had.local : {};
      const missing = Object.keys(local).filter((name) => name !== 'deleted' && !(name in fields));
      if (missing.length === 0) return had.thing;
      const filled: SyncThing['fields'] = { ...fields };
      for (const name of missing) filled[name] = { v: local[name], at: [0, 0, ''] };
      return { ...had.thing, fields: filled };
    }
    const chord = had.thing.type === 'chord';
    const needed = chord ? ['name', 'icon', 'theme', 'rank', 'profile'] : ['name', 'stops', 'grain'];
    if (needed.every((name) => name in fields)) return had.thing;
    const local = had.local && had.local['deleted'] !== true ? had.local : {};
    const look = { stops: [{ l: 0.72, c: 0.12, h: 300 }], grain: 0.2 };
    const defaults: SyncValues = chord
      ? chordRecord({ id: had.thing.id, profileId: DEFAULT_PROFILE, name: '', icon: '', theme: { ...look, appearance: 'auto' }, rank: LAST_RANK, createdAt: 0 }, [0, 0, ''])!.set
      : { name: 'Theme', ...look };
    const filled: SyncThing['fields'] = { ...fields };
    for (const name of chord ? [...needed, 'created'] : needed) if (!(name in filled)) filled[name] = { v: name in local ? local[name] : defaults[name], at: [0, 0, ''] };
    return { ...had.thing, fields: filled };
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
  *unappliedPages(size = 100): Generator<Map<string, Set<string>>> {
    const never: Record<string, readonly string[]> = { chord: ['profile'], effects: ['duet'] };
    const brief = this.briefs();
    const live = (type: string, id: unknown) => typeof id === 'string' && brief(type, id) !== null && !brief(type, id)!.gone;
    let after = { type: '', id: '' };
    for (;;) {
      const rows = this.boundedPage(after, size);
      const out = new Map<string, Set<string>>();
      for (const row of rows) {
        const { thing, local } = this.loaded(str(row['type']), str(row['id']), row);
        after = { type: thing.type, id: thing.id };
        if (syncKind(thing.type) !== 'sync') continue;
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
      if (rows.length === 0) return;
    }
  }

  /**
   * A page of the copy for reconciling, after `after` in (type, id) order: no
   * icons or devices (never applied, and an icon can be big), at most `size`
   * things and about RECONCILE_PAGE_CHARS of them, so a page stays a few
   * milliseconds. Sized by bytes (`octet_length`, which SQLite reads from the
   * row's header: a text's `length` reads all of it, 7 ms for a page's worth
   * of Effects at their largest), from the key's index on.
   */
  private boundedPage(after: { type: string; id: string }, size: number): Row[] {
    const heads = this.sql(
      `SELECT type, id, octet_length(fields) + octet_length(stamps) + coalesce(octet_length(local), 0) AS chars FROM sync_record
        WHERE (type, id) > (?, ?) AND type NOT IN ('icon', 'device') ORDER BY type, id LIMIT ?`,
    ).all(after.type, after.id, size) as Row[];
    let chars = 0;
    let take = 0;
    for (const head of heads) {
      if (take > 0 && chars + num(head['chars']) > RECONCILE_PAGE_CHARS) break;
      chars += num(head['chars']);
      take++;
    }
    if (take === 0) return [];
    const last = heads[take - 1]!;
    return this.sql(
      `SELECT type, id, fields, stamps, local FROM sync_record
        WHERE (type, id) > (?, ?) AND (type, id) <= (?, ?) AND type NOT IN ('icon', 'device') ORDER BY type, id`,
    ).all(after.type, after.id, last['type'] as string, last['id'] as string) as Row[];
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
  *everythingPages(size = 100): Generator<Map<string, Set<string>>> {
    let after = { type: '', id: '' };
    for (;;) {
      const rows = this.boundedPage(after, size);
      const out = new Map<string, Set<string>>();
      for (const row of rows) {
        const { thing, local } = this.loaded(str(row['type']), str(row['id']), row);
        after = { type: thing.type, id: thing.id };
        const names = Object.keys(thing.fields).filter((name) => !local || !same(thing.fields[name]!.v, local[name]));
        if (names.length > 0) out.set(thingKey(thing.type, thing.id), new Set(names));
      }
      yield out;
      if (rows.length === 0) return;
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

  /**
   * The chords the copy has, live, by rank: a join's *Use the synced setup*
   * keeps them, and sends this computer's Today tabs to the first. Every one:
   * one whose fields haven't all come (a rename read before the file that made
   * it) is kept, last, never taken for one of this computer's, which make way.
   */
  syncedChords(): string[] {
    const rank = (c: { fields: Record<string, unknown> }) => (typeof c.fields['rank'] === 'string' ? c.fields['rank'] : LAST_RANK);
    return (this.sql(`SELECT id, fields FROM sync_record WHERE type = 'chord'`).all() as Row[])
      .map((row) => ({ id: str(row['id']), fields: parseJson<Record<string, unknown>>(row['fields'], {}) }))
      .filter((c) => c.fields['deleted'] !== true)
      .sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : a.id < b.id ? -1 : 1))
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
    return num((this.sql('SELECT COALESCE(SUM(octet_length(fields) + octet_length(stamps)), 0) AS n FROM sync_record').get() as Row)['n']);
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
    this.sql('DELETE FROM sync_noted').run();
  }

  /**
   * Turning off while what sync applied here isn't all in chord.db (writes
   * refused past turning off's wait, S15 §13): as `clear`, but the merged copy
   * stays, marked `kept`. A reconcile puts back what chord.db lacks of it, at
   * launch and after writes; once it lacks nothing, the copy goes (`clear`).
   */
  keepOff(): void {
    this.sql('DELETE FROM sync_cursor').run();
    this.sql('DELETE FROM sync_junk').run();
    this.sql(`DELETE FROM meta WHERE key IN ('sync.clock', 'sync.key')`).run();
    this.setMeta({ ...OFF, kept: true });
    this.clock = null;
    this.pending = 0;
    this.sql('DELETE FROM sync_noted').run();
  }

  /**
   * Changes made while sync was on that never reached the folder (it was
   * turned off first, or couldn't write): into the copy, so the first snapshot
   * after it's on again holds them, each with its stamp. `type`: only those of
   * one type (a join's choice reads the chords' in first, to know if any synced
   * chord is left to make way for).
   */
  readmitOutbox(type?: string): void {
    for (const row of this.sql('SELECT record FROM sync_outbox ORDER BY seq').all() as Row[]) {
      const r = parseJson<DataRecord | null>(row['record'], null);
      if (!r || typeof r.type !== 'string' || typeof r.id !== 'string' || !r.set || (type !== undefined && r.type !== type)) continue;
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
