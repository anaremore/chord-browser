/**
 * Sync's pure parts (docs/decisions/S15-your-data.md §4, §6, §13). Each
 * computer keeps a merged copy of every synced thing, each field with the
 * stamp of the change that set it (`SyncThing`), and merges what other
 * computers wrote field by field: the higher stamp wins, and between equal
 * stamps the larger value, so the merge is commutative, associative and
 * idempotent. Neither the order logs arrive in nor reading one twice changes
 * the result.
 *
 * - **What this computer writes** is each synced thing's fields as the model
 *   has it (`local*Fields`). chord-data's `write()` compares them with what it
 *   wrote last (`localChanges`), so only what you changed gets a stamp, and
 *   what came from another computer never goes back into this one's log.
 * - **What another computer wrote is untrusted.** `checkSyncRecord` takes only
 *   records of a synced type with an id and a stamp that make sense, within
 *   sizes; types sync never carries (history, Duet, zoom, permissions) are
 *   dropped, and a newer Chord's are kept as they came, merged under the same
 *   rules, and written back, but never used. `planApply` reads each changed
 *   thing back through the codecs a Chord file's records pass, and the
 *   reducer's `sync.apply` checks it once more.
 */
import { effectsFromRecord, effectsRecord, hasEffects, type SiteEffects } from './effects';
import { routeKey } from './links';
import { settingPath, valueAt, same, stable } from './merge';
import { DEFAULT_SETTINGS, type Chord, type ChordId, type CustomTheme, type Favorite, type LinkRoute, type NodeId, type Settings, type SettingsPatch, type SidebarNode } from './model';
import {
  chordFromRecord,
  chordRecord,
  favoriteFromRecord,
  favoriteRecord,
  iconFromRecord,
  isIconId,
  nodeFromRecord,
  nodeRecord,
  RECORD_TYPES,
  routeFromRecord,
  routeRecord,
  settingFields,
  settingsFromFields,
  SETTING_TRAVEL,
  shortcutFamily,
  themeFromRecord,
  themeRecord,
  type DataRecord,
} from './records';
import { restoreSettings } from './restore';
import type { Platform } from './shortcuts';
import { compareStamps, isDeviceId, isStamp, type Stamp } from './stamps';

/* ---------- Things ---------- */

/** One field of a merged thing: its winning value, and the stamp of the change that set it. */
export interface SyncField {
  v: unknown;
  at: Stamp;
}

/** One synced thing as this computer knows it, merged from every computer's log. */
export interface SyncThing {
  type: string;
  id: string;
  fields: Record<string, SyncField>;
}

/** A thing's fields as values, without stamps: what this computer wrote, or a thing's merged values. */
export type SyncValues = Record<string, unknown>;

/** What sync carries (S15 §1's table): setup, the icons it uses, and each computer's `device` record. */
export const SYNC_TYPES: ReadonlySet<string> = new Set(['chord', 'folder', 'tab', 'split', 'favorite', 'theme', 'settings', 'route', 'effects', 'icon', 'device']);
/** Facts: an icon's id is its content, so it has no stamp and never changes. */
const FACTS: ReadonlySet<string> = new Set(['icon']);
export const NODE_TYPES: ReadonlySet<string> = new Set(['folder', 'tab', 'split']);
/** A fact's stamp: older than any change. Never written: a fact's record has no `at`. */
export const FACT_STAMP: Stamp = [0, 0, ''];

export const thingKey = (type: string, id: string): string => `${type}\n${id}`;
export const isGone = (thing: SyncThing | undefined): boolean => thing?.fields['deleted']?.v === true;
export const valuesOf = (thing: SyncThing): SyncValues => Object.fromEntries(Object.entries(thing.fields).map(([name, f]) => [name, f.v]));

/** The newest stamp among a thing's fields. */
export function newestStamp(thing: SyncThing): Stamp {
  let at = FACT_STAMP;
  for (const field of Object.values(thing.fields)) if (compareStamps(field.at, at) > 0) at = field.at;
  return at;
}

/**
 * How much sync keeps, so another computer's log can't fill memory or the
 * sidebar: things of each type, and in all; fields per thing and the size of
 * one; and characters in all. Far past any profile (S15 §2's realistic one
 * has about 600 things). What's past them isn't merged, and Settings says so.
 */
export const SYNC_LIMITS = {
  things: 100_000,
  chars: 64 * 1024 * 1024,
  fields: 256,
  fieldName: 100,
  /** One thing, as JSON: an icon's base64 is at most 1.4 MB (records.ts). A merged thing's values are held to it too. */
  thingChars: 2 * 1024 * 1024,
  /**
   * An icon sync carries, as base64: favicons are a few KB, so this is
   * generous, and one bigger is left out, read or written (one of 1.3 MB made
   * a merged slice of up to 46 ms).
   */
  iconChars: 128 * 1024,
  byType: {
    chord: 500,
    folder: 4_000,
    tab: 20_000,
    split: 4_000,
    favorite: 500,
    theme: 200,
    settings: 1,
    route: 10_000,
    effects: 2_000,
    icon: 20_000,
    device: 64,
  } as Record<string, number>,
  /** A newer Chord's types, all together. */
  unknown: 10_000,
} as const;

/** What kind of record sync has: one it keeps and uses, a newer Chord's it keeps as it came, or one it never carries. */
export function syncKind(type: string): 'sync' | 'unknown' | 'drop' {
  if (SYNC_TYPES.has(type)) return 'sync';
  return (RECORD_TYPES as readonly string[]).includes(type) ? 'drop' : 'unknown';
}

const isId = (v: string) => /^[A-Za-z0-9_-]{1,64}$/.test(v);
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Whether an id is one its type can have. A newer Chord's types are only bounded. */
function goodId(type: string, id: string): boolean {
  switch (type) {
    case 'chord':
    case 'folder':
    case 'tab':
    case 'split':
    case 'favorite':
    case 'theme':
      return isId(id);
    case 'settings':
      return id === 'settings';
    case 'route':
      return routeKey(id) === id;
    case 'effects':
      return id.length <= 300 && /^[a-z0-9.\-[\]:]+$/.test(id) && !id.startsWith('www.');
    case 'icon':
      return isIconId(id);
    case 'device':
      return isDeviceId(id);
    default:
      return id.length <= 1000;
  }
}

/**
 * Another computer's record as sync takes it, or null: a type sync never
 * carries, an id its type can't have, a stamp missing (only icons have none)
 * or not one (core's isStamp: within the counter's and the year 9999's
 * bounds), too many fields or too big. A field `deleted` that isn't true or
 * false is left out. An icon must be one (records.ts) whose bytes are what its
 * id says (`iconHash`: the hex SHA-256 of its base64's bytes), and loses any
 * stamp it came with. Nothing here depends on the reader's clock, so every
 * computer takes or refuses the same records: a stamp far ahead is taken, and
 * a change made here still beats it (`stampAbove`).
 */
export function checkSyncRecord(r: DataRecord, iconHash: (base64: string) => string): DataRecord | null {
  const kind = syncKind(r.type);
  if (kind === 'drop' || !goodId(r.type, r.id)) return null;
  const names = Object.keys(r.set);
  if (names.length === 0 || names.length > SYNC_LIMITS.fields || !names.every((n) => FIELD_NAME.test(n))) return null;
  if (FACTS.has(r.type)) {
    const icon = iconFromRecord({ type: r.type, id: r.id, set: r.set });
    // An icon's id is its bytes' hash: one that isn't would stick (the first copy of a fact stays) and differ between computers.
    if (!icon || icon.data.length === 0 || icon.data.length > SYNC_LIMITS.iconChars || `sha256-${iconHash(icon.data)}` !== icon.id) return null;
    return { type: 'icon', id: icon.id, set: { mime: icon.mime, data: icon.data } };
  }
  if (!r.at || !isStamp(r.at)) return null;
  if (JSON.stringify(r.set).length > SYNC_LIMITS.thingChars) return null;
  if ('deleted' in r.set && typeof r.set['deleted'] !== 'boolean') {
    const { deleted: _deleted, ...rest } = r.set;
    return Object.keys(rest).length > 0 ? { type: r.type, id: r.id, at: r.at, set: rest } : null;
  }
  return r;
}

/**
 * A record merged into what's known of its thing: each field it sets takes
 * the record's stamp where that's higher (or equal, with the larger value).
 * `changed` names the fields whose value changed. Pure: `thing` is copied.
 */
export function mergeRecord(thing: SyncThing | undefined, r: DataRecord): { thing: SyncThing; changed: string[] } {
  const next: SyncThing = thing ? { type: thing.type, id: thing.id, fields: { ...thing.fields } } : { type: r.type, id: r.id, fields: {} };
  const fact = FACTS.has(r.type);
  const at = fact ? FACT_STAMP : (r.at ?? FACT_STAMP);
  const changed: string[] = [];
  for (const [name, v] of Object.entries(r.set)) {
    const had = next.fields[name];
    if (had) {
      if (fact) continue;
      const order = compareStamps(at, had.at);
      if (order < 0 || (order === 0 && stable(v) <= stable(had.v))) continue;
      if (same(had.v, v)) {
        // The same value, newer: its stamp moves up, so every computer ends with the same stamps.
        next.fields[name] = { v: had.v, at };
        continue;
      }
    }
    next.fields[name] = { v, at };
    changed.push(name);
  }
  return { thing: next, changed };
}

/**
 * A thing as records, for a snapshot: one per stamp its fields carry, oldest
 * first, so a reader merging them gets the thing back exactly. A fact is one
 * record with no stamp.
 */
export function thingRecords(thing: SyncThing): DataRecord[] {
  if (FACTS.has(thing.type)) return [{ type: thing.type, id: thing.id, set: valuesOf(thing) }];
  const byStamp = new Map<string, { at: Stamp; set: SyncValues }>();
  for (const [name, field] of Object.entries(thing.fields)) {
    const key = JSON.stringify(field.at);
    const entry = byStamp.get(key) ?? { at: field.at, set: {} };
    entry.set[name] = field.v;
    byStamp.set(key, entry);
  }
  return [...byStamp.values()].sort((a, b) => compareStamps(a.at, b.at)).map(({ at, set }) => ({ type: thing.type, id: thing.id, at, set }));
}

/* ---------- What this computer writes ---------- */

/** Codecs want a stamp; what this computer writes is compared by value, so any will do. */
const ANY: Stamp = [0, 0, '0000000000000000'];

/** A chord without its own proxy: that's about the network this computer is on (S15 §11). Null for a private window's. */
export function localChordFields(chord: Chord): SyncValues | null {
  const r = chordRecord(chord, ANY);
  if (!r) return null;
  const { proxy: _proxy, ...set } = r.set;
  return set;
}

/**
 * A folder, tab or split, only while it's pinned: Today is this computer's,
 * and a tab leaving Pinned is a deletion for sync (S15 §1). A pinned tab syncs
 * its home, not where you've browsed to: never `url`, and `title` and `icon`
 * only while it's on its pinned address.
 */
export function localNodeFields(node: SidebarNode, icon: string | null): SyncValues | null {
  if (node.section !== 'pinned') return null;
  const set = { ...nodeRecord(node, ANY, icon).set };
  if (node.kind === 'tab') {
    delete set['url'];
    if (node.pinnedUrl !== null && node.url !== node.pinnedUrl) {
      delete set['title'];
      delete set['icon'];
    }
  }
  return set;
}

export const localFavoriteFields = (favorite: Favorite, icon: string | null): SyncValues => ({ ...favoriteRecord(favorite, ANY, icon).set });
export const localThemeFields = (theme: CustomTheme): SyncValues => ({ ...themeRecord(theme, ANY).set });
export const localRouteFields = (route: LinkRoute): SyncValues => ({ ...routeRecord(route, ANY).set });
/** A site's Effects; null once it has none (a site without Effects isn't kept). */
export const localEffectsFields = (site: SiteEffects): SyncValues | null => (hasEffects(site) ? { ...effectsRecord(site, ANY).set } : null);
export const localIconFields = (mime: string, data: string): SyncValues => ({ mime, data });

/** Whether a setting syncs: S15 §1's *exported and synced* ones, and this computer's family of shortcuts. Never the proxy. */
export const syncsSetting = (key: string): boolean => SETTING_TRAVEL[key as keyof Settings] === 'sync' || SETTING_TRAVEL[key as keyof Settings] === 'family';

/** One saved setting as the settings thing's fields (dotted for a group's parts); null for one that doesn't sync. */
export function localSettingFields(key: string, value: unknown, platform: Platform): SyncValues | null {
  return syncsSetting(key) ? settingFields(key, value, platform) : null;
}

/** A computer's `device` record: its name, its system and its Chord. `removed` once another computer (or itself) takes it off. */
export interface SyncDevice {
  id: string;
  name: string;
  os: string;
  app: string;
  /** When it was removed (the stamp's time), or null. */
  removed: number | null;
  /** The generation it moved to by changing the passphrase, as it said in its log under the old one before it went. */
  rekeyed: number | null;
}

export const localDeviceFields = (d: { name: string; os: string; app: string }): SyncValues => ({ name: d.name.slice(0, 100), os: d.os.slice(0, 40), app: d.app.slice(0, 40) });

export function deviceOf(thing: SyncThing): SyncDevice | null {
  if (thing.type !== 'device' || !isDeviceId(thing.id)) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const removed = thing.fields['removed'];
  return {
    id: thing.id,
    name: text(thing.fields['name']?.v, 100) || 'A computer',
    os: text(thing.fields['os']?.v, 40),
    app: text(thing.fields['app']?.v, 40),
    removed: removed?.v === true ? removed.at[0] : null,
    rekeyed: Number.isSafeInteger(thing.fields['rekeyed']?.v) ? (thing.fields['rekeyed']!.v as number) : null,
  };
}

/**
 * What this computer changed in a thing since it last wrote it: the fields to
 * stamp, or null for nothing. `merged` is what's known of it, `before` what
 * this computer wrote last (null: never, or it was gone here), `after` what
 * the model has now (null: gone here, or out of sync's reach, as a tab
 * leaving Pinned).
 * - Gone here, and known and live: a tombstone. Unknown: nothing, since no
 *   other computer has it.
 * - New here, or back: every field (and `deleted: false` if it was gone), so
 *   the whole thing goes out (S15 §1: pinning a tab again writes it whole).
 * - Otherwise: the fields this computer changed that aren't the merged value
 *   already. A field `after` leaves out (a tab's title off its pinned page)
 *   isn't a change.
 */
export function localChanges(merged: SyncThing | undefined, before: SyncValues | null, after: SyncValues | null): SyncValues | null {
  const known = merged !== undefined && Object.keys(merged.fields).length > 0;
  if (after === null) return known && !isGone(merged) ? { deleted: true } : null;
  const base = before && before['deleted'] !== true ? before : null;
  if (!base) {
    const all: SyncValues = { ...after };
    if (isGone(merged)) all['deleted'] = false;
    return all;
  }
  const out: SyncValues = {};
  for (const [name, value] of Object.entries(after)) {
    if (name in base && same(base[name], value)) continue;
    if (merged?.fields[name] && same(merged.fields[name]!.v, value)) continue;
    out[name] = value;
  }
  if (isGone(merged)) out['deleted'] = false;
  return Object.keys(out).length > 0 ? out : null;
}

/* ---------- Where sync stands, for Settings ---------- */

/**
 * A problem that needs you (S15 §8): the folder isn't there (`missing`), the
 * passphrase was changed on another computer (`changed`), another computer
 * has a newer Chord (`newer`), this one was removed (`removed`), two
 * computers set the folder up at once and the other's won (`conflict`), it
 * couldn't write and tries again (`unwritable`), or another computer keeps
 * writing as this one (`copies`).
 */
export type SyncProblem = 'missing' | 'changed' | 'newer' | 'removed' | 'conflict' | 'unwritable' | 'copies' | 'unreadable' | 'stalled';

export interface SyncComputer {
  id: string;
  name: string;
  os: string;
  app: string;
  self: boolean;
  /** When it last wrote to the folder (ms), if this computer has seen it. */
  lastSync: number | null;
}

export interface SyncStatus {
  /**
   * `locked`: on, but this computer keeps no key (Linux without a keyring) and
   * needs the passphrase; `choosing`: joined, and asking what to do with this
   * computer's own setup.
   */
  state: 'off' | 'on' | 'paused' | 'locked' | 'choosing' | 'problem';
  problem: SyncProblem | null;
  /** The folder you picked, as a path to show. */
  folder: string | null;
  computers: SyncComputer[];
  /** The newest change from another computer this one has read. */
  lastChange: { name: string; at: number } | null;
  /** Changes made here, not yet in the folder. */
  pending: number;
  /** Computers whose clocks run more than five minutes ahead: their changes may win over newer ones (S15 §4). */
  ahead: { name: string; ms: number }[];
  /**
   * Who changed the passphrase, when that's the problem, as the old generation's log says (an authenticated record):
   * null when nothing there says so (*Start over*, or a file someone else put there), and Settings names no one.
   */
  changedBy: string | null;
  /** When this computer was removed, when that's the problem. */
  removedAt: number | null;
  /** Things another computer wrote past what sync keeps (SYNC_LIMITS), left out. */
  capped: number;
  /** Parts of other computers' logs passed over: a frame too big to read, or one that can't be told from the next. */
  refused: number;
  /** More computers write to the folder than sync reads (64): the rest are left out. */
  tooMany: boolean;
  /** The folder holds more files Chord doesn't recognise than it looks through: computers it doesn't know yet aren't found. */
  cluttered: boolean;
  /** Things changes made here couldn't win (another computer's stamp is the very last there can be), as Settings names them. */
  stuck: string[];
  /** Computers whose folders hold more junk than a pass looks through: their changes may be slow to come. */
  blocked: string[];
  /** While choosing: this computer's chords, and the synced setup's. */
  choosing: { here: number; synced: number } | null;
}

export const SYNC_OFF: SyncStatus = { state: 'off', problem: null, folder: null, computers: [], lastChange: null, pending: 0, ahead: [], changedBy: null, removedAt: null, capped: 0, refused: 0, tooMany: false, cluttered: false, stuck: [], blocked: [], choosing: null };

/** A clock more than this far ahead of this computer's is named in Settings (S15 §4). */
export const CLOCK_AHEAD_MS = 5 * 60_000;

/* ---------- What another computer's changes do here ---------- */

/** Things to take away, by kind: a tombstone names one thing of one type, never another with the same id. */
export interface SyncGone {
  chords: ChordId[];
  nodes: { id: NodeId; kind: 'folder' | 'tab' | 'split' }[];
  favorites: string[];
  themes: string[];
  routes: string[];
  effects: string[];
}

/** What main applies for one push from chord-data: `sync.apply` in the reducer, and Effects through their service. */
export interface SyncApply {
  chords: Chord[];
  /** Pinned folders, tabs and splits, parents first, each split with its panes. A tab's `url` is its home: an existing tab keeps its own. */
  nodes: SidebarNode[];
  favorites: Favorite[];
  themes: CustomTheme[];
  routes: LinkRoute[];
  settings: SettingsPatch | null;
  effects: SiteEffects[];
  gone: SyncGone;
}

export const emptyApply = (): SyncApply => ({ chords: [], nodes: [], favorites: [], themes: [], routes: [], settings: null, effects: [], gone: { chords: [], nodes: [], favorites: [], themes: [], routes: [], effects: [] } });
export const applyIsEmpty = (a: SyncApply): boolean =>
  a.chords.length + a.nodes.length + a.favorites.length + a.themes.length + a.routes.length + a.effects.length === 0 &&
  !a.settings &&
  Object.values(a.gone).every((list) => list.length === 0);

/** A thing whose merged value changed, and which of its fields did. */
export interface SyncChange {
  thing: SyncThing;
  names: readonly string[];
}

/** What `planApply` reads of the merged copy. */
export interface ApplyContext {
  get(type: string, id: string): SyncThing | undefined;
  /** The live tabs a split holds in the merged copy (their `pos.parent` is it). */
  panes(splitId: string): SyncThing[];
  /** This computer's settings fields as it wrote them, for the shortcuts it has that the synced ones don't. */
  localSettings: SyncValues;
  platform: Platform;
  now: number;
  newId(): string;
}

/** Folders nest at most this deep; one deeper comes in at its section's top level, as an import's do (merge.ts). */
const MAX_DEPTH = 16;

const posOf = (thing: SyncThing | undefined): { chord?: unknown; parent?: unknown; section?: unknown } | undefined => thing?.fields['pos']?.v as never;

function liveNode(ctx: ApplyContext, id: string): SyncThing | undefined {
  for (const type of NODE_TYPES) {
    const thing = ctx.get(type, id);
    if (thing && !isGone(thing)) return thing;
  }
  return undefined;
}

/**
 * Where a node's parent chain leads: null when it ends, or the nodes of a
 * cycle it runs into (two computers each moved a folder into the other), or
 * the depth when it's deeper than folders may nest.
 */
function chainOf(ctx: ApplyContext, start: SyncThing): { cycle: SyncThing[] } | { depth: number } {
  const seen = new Map<string, number>();
  const path: SyncThing[] = [];
  let node: SyncThing | undefined = start;
  while (node) {
    if (seen.has(node.id)) return { cycle: path.slice(seen.get(node.id)) };
    seen.set(node.id, path.length);
    path.push(node);
    if (path.length > MAX_DEPTH + 1) return { depth: path.length - 1 };
    const parent: unknown = posOf(node)?.parent;
    node = typeof parent === 'string' ? liveNode(ctx, parent) : undefined;
  }
  return { depth: path.length - 1 };
}

/** A merged node as the model's, through a Chord file's codec; its home stands in for `url`, which sync never carries. */
function nodeFrom(thing: SyncThing, ctx: ApplyContext): SidebarNode | null {
  const values = valuesOf(thing);
  const set = thing.type === 'tab' ? { title: '', ...values, url: values['pinnedUrl'] } : values;
  const read = nodeFromRecord({ type: thing.type, id: thing.id, at: newestStamp(thing), set }, ctx.now);
  if (!read || read.node.section !== 'pinned') return null;
  if (read.node.kind === 'tab') read.node.favicon = iconUrl(ctx, read.icon);
  return read.node;
}

function iconUrl(ctx: ApplyContext, id: string | null): string | null {
  const thing = id ? ctx.get('icon', id) : undefined;
  const icon = thing ? iconFromRecord({ type: 'icon', id: thing.id, set: valuesOf(thing) }) : null;
  return icon ? `data:${icon.mime};base64,${icon.data}` : null;
}

/**
 * The settings that changed, as a patch: the merged fields checked together
 * by restore's own checks (Google-free mode and Google search can't both
 * win), each changed one taken as restore keeps it, and one restore would put
 * the default in place of left out. Only settings that sync, and this
 * computer's family of shortcuts; the ones it has that the synced ones don't
 * go back to Chord's.
 */
export function syncSettingsPatch(merged: SyncThing, changed: readonly string[], local: SyncValues, platform: Platform): SettingsPatch | null {
  const family = `shortcuts.${shortcutFamily(platform)}`;
  const allowed = (name: string) => name === family || (!name.startsWith('shortcuts.') && syncsSetting(name.split('.')[0]!));
  const values = Object.fromEntries(Object.entries(valuesOf(merged)).filter(([name]) => allowed(name)));
  const restored = restoreSettings(settingsFromFields(values, platform), platform);
  const patch: Record<string, unknown> = {};
  for (const name of changed) {
    if (!allowed(name) || !(name in values)) continue;
    const path = settingPath(name);
    const value = valueAt(restored, path);
    const fallback = valueAt(DEFAULT_SETTINGS, path);
    if (!same(value, values[name]) && same(value, fallback) && !same(values[name], fallback)) continue;
    if (path[0] === 'shortcuts') {
      const keys: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      const mine = local[family];
      for (const action of Object.keys(mine && typeof mine === 'object' ? mine : {})) if (!(action in keys)) keys[action] = null;
      patch['shortcuts'] = keys;
    } else if (path.length === 2) ((patch[path[0]!] ??= {}) as Record<string, unknown>)[path[1]!] = value;
    else patch[path[0]!] = value;
  }
  return Object.keys(patch).length > 0 ? (patch as SettingsPatch) : null;
}

/**
 * What a set of changed things does here, read from the merged copy: each
 * through its Chord-file codec, so a thing that doesn't read as what it says
 * is left out. Folders inside each other break the same way everywhere (the
 * one whose `pos` is newest goes to its section's top level, and nothing is
 * written for it); folders deeper than 16 come in at the top. A split goes
 * only with its panes, and only once it has two: one sent alone would be
 * dissolved here before its tabs arrived. A newer Chord's types, and devices,
 * aren't the store's.
 */
export function planApply(changed: Iterable<SyncChange>, ctx: ApplyContext): SyncApply {
  const out = emptyApply();
  const nodes = new Map<string, SyncThing>();
  let settings: { thing: SyncThing; names: Set<string> } | null = null;
  for (const { thing, names } of changed) {
    if (thing.type === 'settings') {
      settings ??= { thing, names: new Set() };
      settings.thing = thing;
      for (const name of names) settings.names.add(name);
      continue;
    }
    if (NODE_TYPES.has(thing.type)) {
      if (isGone(thing)) out.gone.nodes.push({ id: thing.id, kind: thing.type as 'folder' | 'tab' | 'split' });
      else nodes.set(thing.id, thing);
      continue;
    }
    const gone = isGone(thing);
    const values = valuesOf(thing);
    const record: DataRecord = { type: thing.type, id: thing.id, at: newestStamp(thing), set: values };
    switch (thing.type) {
      case 'chord': {
        if (gone) out.gone.chords.push(thing.id);
        else {
          const { proxy: _proxy, ...set } = values;
          const chord = chordFromRecord({ ...record, set });
          if (chord) out.chords.push(chord);
        }
        break;
      }
      case 'favorite': {
        if (gone) out.gone.favorites.push(thing.id);
        else {
          const read = favoriteFromRecord(record);
          if (read) out.favorites.push({ ...read.favorite, favicon: iconUrl(ctx, read.icon) });
        }
        break;
      }
      case 'theme': {
        if (gone) out.gone.themes.push(thing.id);
        else {
          const theme = themeFromRecord(record);
          if (theme) out.themes.push(theme);
        }
        break;
      }
      case 'route': {
        if (gone) out.gone.routes.push(thing.id);
        else {
          const route = routeFromRecord(record);
          if (route) out.routes.push(route);
        }
        break;
      }
      case 'effects': {
        const site = gone ? null : effectsFromRecord(record, ctx.newId, ctx.now);
        if (site && site.host === thing.id && hasEffects(site)) out.effects.push(site);
        else if (gone || (site && !hasEffects(site))) out.gone.effects.push(thing.id);
        break;
      }
      default:
        break;
    }
  }
  if (settings && !isGone(settings.thing)) out.settings = syncSettingsPatch(settings.thing, [...settings.names], ctx.localSettings, ctx.platform);

  // A tab in a split brings its split, and a split all its panes: they go together, or the split waits.
  for (const thing of [...nodes.values()]) {
    const parent = posOf(thing)?.parent;
    if (thing.type === 'tab' && typeof parent === 'string') {
      const split = ctx.get('split', parent);
      if (split && !isGone(split)) nodes.set(split.id, split);
    }
  }
  const waiting = new Set<string>();
  for (const thing of [...nodes.values()]) {
    if (thing.type !== 'split') continue;
    const panes = ctx.panes(thing.id);
    if (panes.length < 2) {
      nodes.delete(thing.id);
      waiting.add(thing.id);
      continue;
    }
    for (const pane of panes) nodes.set(pane.id, pane);
  }

  // Each node read back, with its parent as the merged copy settles it.
  const read = new Map<string, SidebarNode>();
  for (const thing of nodes.values()) {
    const node = nodeFrom(thing, ctx);
    if (!node) continue;
    if (node.parentId !== null && waiting.has(node.parentId)) node.parentId = null;
    const chain = chainOf(ctx, thing);
    if ('cycle' in chain) {
      // Every computer breaks it the same way: the one moved last goes to its section's top level.
      const last = chain.cycle.reduce((a, b) => (compareStamps(b.fields['pos']?.at ?? FACT_STAMP, a.fields['pos']?.at ?? FACT_STAMP) > 0 ? b : a));
      if (last.id === thing.id) node.parentId = null;
      else if (!nodes.has(last.id)) {
        const broken = nodeFrom(last, ctx);
        if (broken) read.set(last.id, { ...broken, parentId: null });
      }
    } else if (chain.depth > MAX_DEPTH && node.kind !== 'tab') node.parentId = null;
    read.set(node.id, read.get(node.id) ?? node);
  }
  // Parents first, so the reducer can place each in what holds it.
  const placed = new Set<string>();
  const place = (node: SidebarNode, guard = 0) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    const parent = node.parentId === null ? undefined : read.get(node.parentId);
    if (parent && guard <= MAX_DEPTH) place(parent, guard + 1);
    out.nodes.push(node);
  };
  const order = [...read.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : b.kind === 'folder' ? 1 : a.kind === 'split' ? -1 : b.kind === 'split' ? 1 : 0));
  for (const node of order) place(node);
  // A split's panes straight after it.
  const splits = new Map(out.nodes.filter((n) => n.kind === 'split').map((n) => [n.id, [] as SidebarNode[]]));
  const rest: SidebarNode[] = [];
  for (const node of out.nodes) {
    if (node.kind === 'tab' && node.parentId && splits.has(node.parentId)) splits.get(node.parentId)!.push(node);
    else rest.push(node);
  }
  out.nodes = rest.flatMap((n) => (n.kind === 'split' ? [n, ...splits.get(n.id)!.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1))] : [n]));
  return out;
}

/** Things per `sync.apply`: each is one store change on main, small enough for a frame (as an import's parts, merge.ts). */
export const SYNC_PART = 50;

/**
 * A push as `sync.apply` parts: chords first, then nodes (parents first, a
 * split with its panes in one part, so the store never settles a split
 * without them), Favorites, themes, routes and settings, and what goes last,
 * once everything that moved out of it has. Effects go to their service apart.
 */
export function syncParts(apply: SyncApply, size = SYNC_PART): Omit<SyncApply, 'effects'>[] {
  const parts: Omit<SyncApply, 'effects'>[] = [];
  const blank = (): Omit<SyncApply, 'effects'> => ({ chords: [], nodes: [], favorites: [], themes: [], routes: [], settings: null, gone: { chords: [], nodes: [], favorites: [], themes: [], routes: [], effects: [] } });
  let part = blank();
  let things = 0;
  const room = (n = 1) => {
    if (things > 0 && things + n > size) {
      parts.push(part);
      part = blank();
      things = 0;
    }
  };
  for (const chord of apply.chords) {
    room();
    part.chords.push(chord);
    things++;
  }
  for (let i = 0; i < apply.nodes.length; ) {
    const first = apply.nodes[i]!;
    let end = i + 1;
    if (first.kind === 'split') while (end < apply.nodes.length && apply.nodes[end]!.parentId === first.id) end++;
    room(end - i);
    part.nodes.push(...apply.nodes.slice(i, end));
    things += end - i;
    i = end;
  }
  for (const key of ['favorites', 'themes', 'routes'] as const) {
    for (const item of apply[key] as unknown[]) {
      room();
      (part[key] as unknown[]).push(item);
      things++;
    }
  }
  if (apply.settings) part.settings = apply.settings;
  const goneCount = Object.values(apply.gone).reduce((n, list) => n + list.length, 0);
  if (goneCount > 0) {
    room(goneCount);
    part.gone = apply.gone;
  }
  if (things > 0 || part.settings || goneCount > 0) parts.push(part);
  return parts;
}
