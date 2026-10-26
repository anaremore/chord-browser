/**
 * Importing a Chord file (docs/decisions/S15-your-data.md §5): this
 * computer's setup and the file's, both as records, merged field by field.
 * The newer stamp wins, so an import adds what's missing and updates what's
 * older, and it never deletes. Into a clearly fresh Chord (`isNewProfile`)
 * everything in the file comes in, as a restore, and the first-run chord
 * makes way.
 *
 * Everything from a file is untrusted. Each thing is read back through its
 * record's codec (records.ts), which checks it as restore checks saved data;
 * a reference to a chord or folder that isn't anywhere is repaired or the
 * thing is left out; no more than `IMPORT_LIMITS` comes in; permissions come
 * in as blocks only; a chord's proxy and Settings' come in only with
 * *Settings from the file*; Effects only with their switch, and main's
 * sanitizer checks every stylesheet again.
 *
 * Pure: the import process plans with this, reading this computer's records
 * from chord.db as an export would, and main applies the plan a part at a
 * time through the reducer's `data.merge`, which checks it once more.
 */
import { DUET_SCOPE_NAMES } from './duet';
import { effectsFromRecord, hasEffects, type SiteEffects } from './effects';
import { SEARCH_ENGINES } from './input';
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  MAX_FAVORITES,
  type Chord,
  type ChordId,
  type CustomTheme,
  type Favorite,
  type LinkRoute,
  type NodeId,
  type Settings,
  type SettingsPatch,
  type SidebarNode,
  type SitePermission,
  type SitePermissions,
} from './model';
import { cleanProxy, proxyLabel, sameProxy, type ProxySettings } from './proxy';
import {
  chordFromRecord,
  favoriteFromRecord,
  iconFromRecord,
  nodeFromRecord,
  permissionFromRecord,
  RECORD_TYPES,
  routeFromRecord,
  settingFields,
  settingsFromFields,
  SETTING_TRAVEL,
  shortcutFamily,
  themeFromRecord,
  zoomFromRecord,
  type DataRecord,
  type PageFacts,
} from './records';
import type { ImportedPage } from './import';
import { restoreSettings } from './restore';
import type { Platform } from './shortcuts';
import { compareStamps, type Stamp } from './stamps';

/** The switches on the preview that decide what comes in. History and Duet chats never pass through here. */
export interface MergeChoices {
  effects: boolean;
  /** *Settings from the file*, and a chord's own proxy: off for a profile with data until you turn it on. */
  settings: boolean;
}

/** Setup, counted: what's new, or newer than yours. */
export interface MergeCounts {
  chords: number;
  pinnedTabs: number;
  todayTabs: number;
  folders: number;
  favorites: number;
  themes: number;
  routes: number;
  /** Sites with Effects. */
  effects: number;
  zoom: number;
  /** Sites with a permission the file blocks. */
  blocks: number;
}

/** A setting the file would change, in words: *Search engine: DuckDuckGo → Google*. */
export interface SettingChange {
  /** The field's name in the file (`adBlocking.enabled`), or `chord.<id>.proxy` for a chord's own proxy. */
  field: string;
  label: string;
  from: string;
  to: string;
}

/** One part of the plan, for one `data.merge`: things to put, each whole, by id. */
export interface MergePart {
  /** Never with a proxy: a chord's own proxy comes only in `proxies`. */
  chords?: Chord[];
  /**
   * Parents before what's in them, in this part or an earlier one; a split
   * always in the same part as its tabs, so no part leaves one empty.
   */
  nodes?: SidebarNode[];
  favorites?: Favorite[];
  themes?: CustomTheme[];
  routes?: LinkRoute[];
  /** Page zoom by host. */
  zoom?: Record<string, number>;
  /** Permissions the file blocks, by origin: never an allow (S15 §5). */
  blocks?: Record<string, SitePermission[]>;
  settings?: SettingsPatch;
  /**
   * Chords' own proxies, by chord (null: the proxy for every chord). Only
   * with *Settings from the file*: a chord's proxy decides where its pages
   * load, so nothing else in a part changes one.
   */
  proxies?: Record<ChordId, ProxySettings | null>;
  /** A new profile's first-run chord, which makes way for the file's: its tabs move to `to`, and it goes (Undo brings it back). */
  makeWay?: { chordId: ChordId; to: ChordId };
}

/**
 * The most one import brings, past what any profile has, so a file can't
 * fill memory or the sidebar: chords, tabs and folders that are new (one
 * already here is updated whatever the count), in the file's order. A folder
 * or split nested deeper than `depth` comes in at its section's top level.
 */
export const IMPORT_LIMITS = { chords: 100, tabs: 10_000, folders: 2_000, depth: 16 } as const;

/** What the limits left out, or (`deep`) moved to their section's top level: the preview's small print says so. */
export interface MergeCapped {
  chords: number;
  tabs: number;
  folders: number;
  deep: number;
}

/**
 * History a fresh Chord may have: a few pages looked at before the import.
 * More, and it's a profile with data (S15 §5).
 */
export const FRESH_PAGES = 20;

/** What an import does to the store, and what the preview says of it. */
export interface MergePlan {
  /** A clearly fresh Chord (`isNewProfile`): the file's things all win, as a restore. */
  newProfile: boolean;
  counts: { new: MergeCounts; newer: MergeCounts };
  chords: Chord[];
  nodes: SidebarNode[];
  favorites: Favorite[];
  themes: CustomTheme[];
  routes: LinkRoute[];
  zoom: Record<string, number>;
  blocks: Record<string, SitePermission[]>;
  /** Null unless *Settings from the file* is on and something changes. */
  settings: SettingsPatch | null;
  /** Chords' own proxies that change: empty unless *Settings from the file* is on. */
  proxies: Record<ChordId, ProxySettings | null>;
  /** Every setting the file would change, named, whether the switch is on or not: the preview lists them. */
  changes: SettingChange[];
  /** Sites with Effects that are new or newer, whether their switch is on or not; `effects` holds them only when it's on. */
  effectsSites: { host: string; new: boolean }[];
  effects: SiteEffects[];
  makeWay: { chordId: ChordId; to: ChordId } | null;
  /** Things of a type this Chord doesn't know: a newer Chord's, passed over (S15 §2, *Versions*). */
  skipped: number;
  /** Things that didn't read as what they say, or point at nothing: left out. */
  unreadable: number;
  /** Favorites past the row's limit (48), left out. */
  favoritesFull: number;
  /** What `IMPORT_LIMITS` left out or moved. */
  capped: MergeCapped;
  /** The chords there'll be once it's in: a Duet chat whose chord isn't among them goes to the chord you're in. */
  chordIds: ChordId[];
}

export interface MergeInput {
  /** This computer's setup and Today tabs, as an export would write them: stamps from each row's `updated_at`. */
  local: readonly DataRecord[];
  /** The file's setup, Today tabs and icons. */
  file: readonly DataRecord[];
  /**
   * How much history and how many Duet chats are here (chord.db's, not
   * setup): a fresh Chord has next to none. Without it, this is a profile
   * with data.
   */
  here?: { pages: number; chats: number };
  choices: MergeChoices;
  platform: Platform;
  now: number;
  newId: () => string;
}

/* ---------- Things and their fields ---------- */

interface Field {
  value: unknown;
  at: Stamp;
}

/** One thing, as all of its records say: each field with the newest stamp any of them gave it. */
interface Thing {
  type: string;
  id: string;
  fields: Map<string, Field>;
}

/** Facts (icons) have no stamp: older than anything. */
const NO_STAMP: Stamp = [0, 0, ''];
const NODE_TYPES: ReadonlySet<string> = new Set(['folder', 'tab', 'split']);
const PERMISSIONS: readonly SitePermission[] = ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'];

function gather(records: readonly DataRecord[]): Map<string, Thing> {
  const out = new Map<string, Thing>();
  for (const r of records) {
    const key = `${r.type}\n${r.id}`;
    let thing = out.get(key);
    if (!thing) out.set(key, (thing = { type: r.type, id: r.id, fields: new Map() }));
    const at = r.at ?? NO_STAMP;
    for (const [name, value] of Object.entries(r.set)) {
      const had = thing.fields.get(name);
      if (!had || compareStamps(at, had.at) >= 0) thing.fields.set(name, { value, at });
    }
  }
  return out;
}

const ofType = (things: Map<string, Thing>, type: string): Thing[] => [...things.values()].filter((t) => t.type === type);
/** A tombstone (sync's): in a file it's ignored, so the thing neither comes in nor goes here (S15 §5). */
const tombstoned = (thing: Thing): boolean => thing.fields.get('deleted')?.value === true;

/** JSON with its keys in order, so two writers' values compare equal whatever order they put keys in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/**
 * The file's fields that win over this computer's: ones it doesn't have, and
 * ones with a newer stamp, or all of them for a restore. `unset` says a field
 * of ours counts as never set (a setting still at its default). Equal values
 * never win: nothing changes.
 */
function winners(file: Thing, mine: Thing | undefined, restore: boolean, unset?: (name: string) => boolean): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const [name, field] of file.fields) {
    if (name === 'deleted') continue;
    const ours = mine?.fields.get(name);
    if (ours && same(ours.value, field.value)) continue;
    if (!ours || restore || unset?.(name) || compareStamps(field.at, ours.at) > 0) out.set(name, field);
  }
  return out;
}

/** Ours, with the file's winning fields over it, as one record (stamped with the newest of them), under `id`. */
function merged(file: Thing, mine: Thing | undefined, won: Map<string, Field>, id = mine?.id ?? file.id): DataRecord {
  const set: Record<string, unknown> = {};
  let at = NO_STAMP;
  for (const fields of [mine?.fields, won]) {
    for (const [name, field] of fields ?? []) {
      if (name === 'deleted') continue;
      set[name] = field.value;
      if (compareStamps(field.at, at) > 0) at = field.at;
    }
  }
  return { type: file.type, id, at, set };
}

const zero = (): MergeCounts => ({ chords: 0, pinnedTabs: 0, todayTabs: 0, folders: 0, favorites: 0, themes: 0, routes: 0, effects: 0, zoom: 0, blocks: 0 });

/** Settings first run changes: the Safe Browsing notice's answer, and pop-out videos switched off once. */
const FIRST_RUN_SETTINGS: ReadonlySet<string> = new Set(['safeBrowsing', 'safeBrowsingAsked', 'autoPip']);
/** Things a fresh Chord has none of: anything of these is something you made or chose. */
const USED_TYPES: ReadonlySet<string> = new Set(['favorite', 'theme', 'route', 'effects', 'zoom', 'permission', 'folder', 'split']);

/**
 * A clearly fresh Chord, which a file restores (S15 §5): only the chord first
 * run made, with no more Today tabs than first run opens (one) and nothing
 * pinned; nothing of `USED_TYPES`; no Duet chats; at most `FRESH_PAGES` of
 * history; and every setting at its default but those first run sets. In
 * doubt (`here` unknown), it's a profile with data: nothing makes way, and
 * *Settings from the file* starts off.
 */
function isNewProfile(local: Map<string, Thing>, here: MergeInput['here'], platform: Platform): boolean {
  if (!here || here.chats > 0 || here.pages > FRESH_PAGES) return false;
  if (ofType(local, 'chord').length !== 1) return false;
  let today = 0;
  for (const thing of local.values()) {
    if (USED_TYPES.has(thing.type)) return false;
    if (thing.type !== 'tab') continue;
    if ((thing.fields.get('pos')?.value as { section?: unknown } | undefined)?.section !== 'today' || ++today > 1) return false;
  }
  const settings = local.get('settings\nsettings');
  if (!settings) return true;
  const defaults = defaultFields(platform);
  for (const [name, field] of settings.fields) {
    if (FIRST_RUN_SETTINGS.has(name)) continue;
    // A field Chord has no default for (another system's shortcuts): only an empty one is as first run left it.
    const fallback = defaults.has(name) ? defaults.get(name) : field.value && typeof field.value === 'object' && Object.keys(field.value).length === 0 ? field.value : null;
    if (!same(field.value, fallback)) return false;
  }
  return true;
}

/* ---------- Settings, in words ---------- */

const ON_OFF = (v: unknown) => (v === true ? 'On' : v === false ? 'Off' : String(v));
const percent = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : String(v));
const sites = (v: unknown) => (Array.isArray(v) ? (v.length === 0 ? 'None' : v.length === 1 ? String(v[0]) : `${v.length} sites`) : String(v));
const named = (names: Record<string, string>) => (v: unknown) => names[String(v)] ?? String(v);
const ENGINE_NAMES = Object.fromEntries(SEARCH_ENGINES.map((e) => [e.id, e.name]));

/** Each setting a file can carry: what Settings calls it, and its values in words. */
const SETTING_NAMES: Record<string, [label: string, describe: (value: unknown) => string]> = {
  searchEngine: ['Search engine', named(ENGINE_NAMES)],
  searchSuggestions: ['Search suggestions', ON_OFF],
  colorScheme: ['Color scheme', named({ system: 'The system’s', light: 'Light', dark: 'Dark' })],
  'interface.contrast': ['Contrast', percent],
  'interface.glass': ['Window tint', percent],
  'motion.followSystem': ['Follow system motion settings', ON_OFF],
  'motion.commandBar': ['Animate into the command bar', ON_OFF],
  'motion.chordSlide': ['Slide between chords', ON_OFF],
  'motion.tabMoves': ['Animate tab moves', ON_OFF],
  'motion.sidebar': ['Animate the sidebar', ON_OFF],
  'motion.colorBlend': ['Blend chord colors', ON_OFF],
  extensionButtons: ['Show extension buttons', named({ sidebar: 'In the sidebar', titleBar: 'In the title bar' })],
  separateSignIns: ['New chords keep their own sign-ins', ON_OFF],
  archiveAfter: ['Archive Today tabs after', named({ '12h': '12 hours', '24h': 'A day', '7d': 'A week', '30d': 'A month', never: 'Never' })],
  sleepTabs: ['Sleep tabs you’re not using', ON_OFF],
  autoPip: ['Pop out playing videos when you switch away', ON_OFF],
  pagePreviews: ['Show page previews', ON_OFF],
  presentingHidesSidebar: ['Hide the sidebar while presenting', ON_OFF],
  sidebarPeek: ['Show the sidebar when you point at the window’s edge', ON_OFF],
  keepScreenshots: ['Keep recent screenshots', ON_OFF],
  'spellcheck.enabled': ['Check spelling as you type', ON_OFF],
  'spellcheck.language': ['Spelling language', (v) => (typeof v === 'string' ? v : 'The system’s')],
  googleFree: ['Google-free mode', ON_OFF],
  safeBrowsing: ['Warn before suspected phishing and malware', ON_OFF],
  safeBrowsingAsked: ['Safe Browsing’s notice answered', named({ true: 'Yes', false: 'No' })],
  'adBlocking.enabled': ['Block ads and trackers', ON_OFF],
  'adBlocking.offSites': ['Sites where ads aren’t blocked', sites],
  'tabCounts.enabled': ['Show counts on tabs', ON_OFF],
  'tabCounts.offSites': ['Sites whose counts are hidden', sites],
  'duet.enabled': ['Show Duet', ON_OFF],
  'duet.keep': ['Keep Duet chats', named({ forever: 'Forever', '90d': '90 days', '30d': '30 days' })],
  'duet.scope': ['What Duet can read', named(DUET_SCOPE_NAMES)],
  'duet.readsNothing': ['Duet reads nothing', ON_OFF],
  'duet.neverSites': ['Sites Duet never reads', sites],
  'duet.offChords': ['Chords where Duet is off', (v) => (Array.isArray(v) ? (v.length === 0 ? 'None' : `${v.length} chords`) : String(v))],
  'duet.codexImages': ['Codex can make images', ON_OFF],
  externalLinks: ['Links from other apps open in', named({ mini: 'A mini window', tab: 'A new tab' })],
  'reader.size': ['Reader view’s text size', (v) => String(v)],
  'reader.width': ['Reader view’s line width', named({ narrow: 'Narrow', medium: 'Medium', wide: 'Wide' })],
  'reader.theme': ['Reader view’s colors', named({ chord: 'The chord’s', light: 'Light', dark: 'Dark', sepia: 'Sepia' })],
  'reader.font': ['Reader view’s font', named({ sans: 'Sans serif', serif: 'Serif' })],
  'effects.wet': ['Effects on every site', named({ true: 'Wet', false: 'Dry' })],
  encryptExports: ['Encrypt exports with a passphrase', ON_OFF],
  proxy: ['Proxy for every chord', (v) => (v && typeof v === 'object' ? proxyLabel(v as ProxySettings) : 'The system’s proxy')],
};

const shortcutsText = (v: unknown) => {
  const n = v && typeof v === 'object' ? Object.keys(v).length : 0;
  return n === 0 ? 'Chord’s own' : `${n} changed`;
};

function settingName(field: string): [string, (value: unknown) => string] {
  if (field.startsWith('shortcuts.')) return ['Keyboard shortcuts', shortcutsText];
  return SETTING_NAMES[field] ?? [field, (v) => (typeof v === 'string' ? v : JSON.stringify(v))];
}

/** Each field's default, as a file would carry it. */
function defaultFields(platform: Platform): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of Object.keys(SETTING_TRAVEL) as (keyof Settings)[]) {
    for (const [name, value] of Object.entries(settingFields(key, DEFAULT_SETTINGS[key], platform) ?? {})) out.set(name, value);
  }
  return out;
}

/** Where a field lives in Settings: `adBlocking.offSites` is two steps, `shortcuts.other` is `shortcuts`. */
const pathOf = (field: string): string[] => (field.startsWith('shortcuts.') ? ['shortcuts'] : field.split('.'));
const at = (from: unknown, path: readonly string[]): unknown => path.reduce<unknown>((v, step) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[step] : undefined), from);

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const had = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && had && typeof had === 'object' && !Array.isArray(had) ? { ...had, ...value } : value;
  }
  return out;
}

/**
 * The file's settings that win, checked as restore checks saved ones: a value
 * restore keeps (or tidies, as a list of sites) comes in; one it would replace
 * with the default doesn't. Ours and theirs are checked together, so a
 * combination neither wrote still makes sense (Google-free mode and Google
 * search can't both win). Returns the patch and each change in words.
 */
function settingsMerge(file: Thing, mine: Thing | undefined, restore: boolean, platform: Platform): { patch: SettingsPatch; changes: SettingChange[] } {
  const defaults = defaultFields(platform);
  const family = `shortcuts.${shortcutFamily(platform)}`;
  // A setting still at its default here counts as never set: the file's comes in, whatever the stamps say.
  const won = winners(file, mine, restore, (name) => same(mine?.fields.get(name)?.value, defaults.get(name)));
  for (const name of [...won.keys()]) {
    const known = defaults.has(name) || name === family;
    if (!known || (name.startsWith('shortcuts.') && name !== family)) won.delete(name);
  }
  const fieldsOf = (fields: Iterable<[string, Field]>) => Object.fromEntries([...fields].map(([name, f]) => [name, f.value]));
  const ours = settingsFromFields(fieldsOf(mine?.fields ?? []), platform);
  const current = restoreSettings(ours, platform);
  const next = restoreSettings(deepMerge(ours, settingsFromFields(fieldsOf(won), platform)), platform);
  const patch: Record<string, unknown> = {};
  const changes: SettingChange[] = [];
  if (won.size === 0) return { patch: {}, changes };
  // In Settings' order. A field the file doesn't win can still change with one it does (Google-free mode moves search off Google).
  for (const name of new Set([...defaults.keys(), family])) {
    const path = pathOf(name);
    const value = at(next, path);
    const before = at(current, path);
    if (same(value, before)) continue;
    const field = won.get(name);
    const fallback = at(DEFAULT_SETTINGS, path);
    // Not a value Chord can use: restore put the default in its place.
    if (field && !same(value, field.value) && same(value, fallback) && !same(field.value, fallback)) continue;
    const [label, describe] = settingName(name);
    changes.push({ field: name, label, from: describe(before), to: describe(value) });
    if (path[0] === 'shortcuts') {
      // A family's shortcuts are one field: the file's, and ours that it doesn't have go back to Chord's.
      const keys: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const action of Object.keys(before as Record<string, unknown>)) if (!(action in keys)) keys[action] = null;
      patch['shortcuts'] = keys;
    } else if (path.length === 2) {
      const group = (patch[path[0]!] ??= {}) as Record<string, unknown>;
      group[path[1]!] = value;
    } else patch[path[0]!] = value;
  }
  return { patch: patch as SettingsPatch, changes };
}

/* ---------- What's kept of a file ---------- */

/**
 * A page's visits that come in from a file: its newest, far past what years
 * of daily use makes. A line can hold millions; more would be a long write
 * and a pile of memory, and what's left out is old and counts for next to
 * nothing in frecency.
 */
export const MAX_PAGE_VISITS = 10_000;

/**
 * A page from a Chord file as history batches take it: its newest
 * `MAX_PAGE_VISITS` visits, `per` at a time, so no batch (one transaction on
 * chord-data's thread) is ever bigger, however many a line holds. How often
 * it was typed goes with the first share only: chord-data adds what's past
 * its own count once.
 */
export function pageShares(page: PageFacts, per: number, max = MAX_PAGE_VISITS): ImportedPage[] {
  const newest = page.visits.slice(-max);
  const shares: ImportedPage[] = [];
  for (let at = 0; at < newest.length; at += per) {
    shares.push({ url: page.url, title: page.title, visits: newest.slice(at, at + per), typed: [], ...(at === 0 ? { typedCount: page.typed } : {}) });
  }
  return shares;
}

/** The fields each setup record's codec (records.ts) reads, and `deleted`, a tombstone's. */
const SETUP_FIELDS: Record<string, readonly string[]> = {
  chord: ['name', 'icon', 'theme', 'rank', 'profile', 'created', 'proxy', 'deleted'],
  folder: ['pos', 'title', 'collapsed', 'created', 'deleted'],
  split: ['pos', 'direction', 'sizes', 'created', 'deleted'],
  tab: ['pos', 'url', 'pinnedUrl', 'title', 'customTitle', 'icon', 'muted', 'created', 'deleted'],
  favorite: ['url', 'title', 'icon', 'rank', 'created', 'deleted'],
  theme: ['name', 'stops', 'grain', 'deleted'],
  route: ['chord', 'created', 'deleted'],
  effects: ['wet', 'css', 'cssOn', 'hidden', 'presets', 'duet', 'deleted'],
  icon: ['mime', 'data'],
  zoom: ['factor', 'deleted'],
  permission: [...PERMISSIONS, 'deleted'],
};

const settingNames = new Map<Platform, readonly string[]>();

/**
 * A file's setup record as an import keeps it until the plan: only the fields
 * planMerge reads (for `settings`, the settings Chord knows), so nothing else
 * a file carries stays in memory. Null for a type that isn't setup.
 */
export function setupRecord(r: DataRecord, platform: Platform): DataRecord | null {
  let names = SETUP_FIELDS[r.type];
  if (r.type === 'settings') {
    names = settingNames.get(platform);
    if (!names) settingNames.set(platform, (names = [...defaultFields(platform).keys(), `shortcuts.${shortcutFamily(platform)}`, 'deleted']));
  }
  if (!names) return null;
  const set: Record<string, unknown> = {};
  for (const name of names) if (Object.hasOwn(r.set, name)) set[name] = r.set[name];
  return r.at ? { type: r.type, id: r.id, at: r.at, set } : { type: r.type, id: r.id, set };
}

/* ---------- The plan ---------- */

/** An icon record as a `data:` URL, the way the model keeps a tab's or a Favorite's. */
function iconUrls(file: Map<string, Thing>): Map<string, string> {
  const out = new Map<string, string>();
  for (const thing of ofType(file, 'icon')) {
    const icon = iconFromRecord(merged(thing, undefined, thing.fields));
    if (icon) out.set(icon.id, `data:${icon.mime};base64,${icon.data}`);
  }
  return out;
}

export function planMerge({ local: localRecords, file: fileRecords, here, choices, platform, now, newId }: MergeInput): MergePlan {
  const local = gather(localRecords);
  const file = gather(fileRecords);
  const newProfile = isNewProfile(local, here, platform);
  const restore = newProfile;
  const counts = { new: zero(), newer: zero() };
  const count = (fresh: boolean, key: keyof MergeCounts) => counts[fresh ? 'new' : 'newer'][key]++;
  const plan: MergePlan = {
    newProfile,
    counts,
    chords: [],
    nodes: [],
    favorites: [],
    themes: [],
    routes: [],
    zoom: {},
    blocks: {},
    settings: null,
    proxies: {},
    changes: [],
    effectsSites: [],
    effects: [],
    makeWay: null,
    skipped: 0,
    unreadable: 0,
    favoritesFull: 0,
    capped: { chords: 0, tabs: 0, folders: 0, deep: 0 },
    chordIds: [],
  };
  for (const thing of file.values()) if (!(RECORD_TYPES as readonly string[]).includes(thing.type)) plan.skipped++;
  const things = (type: string) => ofType(file, type).filter((t) => !tombstoned(t));
  const mineOf = (thing: Thing) => local.get(`${thing.type}\n${thing.id}`);
  const icons = iconUrls(file);

  // Chords. One you have keeps its sign-ins (an import never signs a chord out); a new one keeps its own if it had
  // them, under a profile no chord here uses. A chord's own proxy decides where its pages load: like settings, it's
  // named in the preview either way, and comes in only with Settings from the file, apart (`proxies`), so nothing
  // else of a chord, nor the proxy as a file holds it (never a password), ever changes the one it has.
  const localChords = ofType(local, 'chord');
  const chordsAfter = new Set(localChords.map((t) => t.id));
  const profilesHere = new Map<string, string>();
  for (const t of localChords) {
    const profile = t.fields.get('profile')?.value;
    if (typeof profile === 'string' && profile !== DEFAULT_PROFILE) profilesHere.set(profile, t.id);
  }
  const profiles = new Map<string, string>();
  let newChords = 0;
  const cappedChords = new Set<string>();
  for (const thing of things('chord')) {
    const mine = mineOf(thing);
    const won = winners(thing, mine, restore);
    if (mine) won.delete('profile');
    const proxyWon = won.get('proxy');
    won.delete('proxy');
    // Its own proxy needs sign-ins of its own: the ones it has here, or the file's for a new one.
    const ownSignIns = (mine ?? thing).fields.get('profile')?.value !== DEFAULT_PROFILE;
    let proxy: { to: ProxySettings | null } | null = null;
    if (proxyWon && ownSignIns) {
      const to = proxyWon.value === null ? null : cleanProxy(proxyWon.value);
      const from = mine ? cleanProxy(mine.fields.get('proxy')?.value) : null;
      if ((to || proxyWon.value === null) && (to || mine) && !sameProxy(to, from)) {
        const name = String(won.get('name')?.value ?? mine?.fields.get('name')?.value ?? 'A chord');
        const describe = (v: ProxySettings | null) => (v ? proxyLabel(v) : 'The proxy for every chord');
        plan.changes.push({ field: `chord.${thing.id}.proxy`, label: `${name}’s own proxy`, from: describe(from), to: describe(to) });
        if (choices.settings) proxy = { to };
      }
    }
    if (!mine && newChords >= IMPORT_LIMITS.chords) {
      plan.capped.chords++;
      cappedChords.add(thing.id);
      continue;
    }
    if (mine && won.size === 0) {
      if (proxy) plan.proxies[thing.id] = proxy.to;
      continue;
    }
    const record = merged(thing, mine, won);
    delete record.set['proxy'];
    const profile = record.set['profile'];
    if (!mine && typeof profile === 'string' && profile !== DEFAULT_PROFILE) {
      const owner = profilesHere.get(profile);
      if (owner && owner !== thing.id) {
        if (!profiles.has(profile)) profiles.set(profile, newId());
        record.set['profile'] = profiles.get(profile);
      }
    }
    const chord = chordFromRecord(record);
    if (!chord) {
      plan.unreadable++;
      continue;
    }
    plan.chords.push(chord);
    chordsAfter.add(chord.id);
    if (!mine) newChords++;
    if (proxy && chord.profileId !== DEFAULT_PROFILE) plan.proxies[chord.id] = proxy.to;
    count(!mine, 'chords');
  }
  // The first-run chord makes way for the file's: its tabs go to the first of them, and it goes (Undo brings it back).
  const added = plan.chords.filter((c) => !local.has(`chord\n${c.id}`)).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  if (newProfile && added.length > 0 && localChords.length === 1 && !file.has(`chord\n${localChords[0]!.id}`)) {
    plan.makeWay = { chordId: localChords[0]!.id, to: added[0]!.id };
    chordsAfter.delete(localChords[0]!.id);
  }

  // Folders, tabs and splits.
  const localNodes = new Map<string, Thing>();
  for (const thing of local.values()) if (NODE_TYPES.has(thing.type)) localNodes.set(thing.id, thing);
  const planned = new Map<NodeId, { node: SidebarNode; isNew: boolean }>();
  for (const thing of [...things('folder'), ...things('split'), ...things('tab')]) {
    const mine = localNodes.get(thing.id);
    // The same id as something else here: not the same thing, whatever the file says.
    if (mine && mine.type !== thing.type) {
      plan.unreadable++;
      continue;
    }
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const read = nodeFromRecord(merged(thing, mine, won), now);
    if (read && cappedChords.has(read.node.chordId)) {
      plan.capped[read.node.kind === 'folder' ? 'folders' : 'tabs']++;
      continue;
    }
    if (!read || !chordsAfter.has(read.node.chordId)) {
      plan.unreadable++;
      continue;
    }
    const node = read.node;
    // A tab's icon comes from the file's icon records; one whose icon didn't change keeps the one it has (null).
    if (node.kind === 'tab') node.favicon = mine && !won.has('icon') ? null : read.icon ? (icons.get(read.icon) ?? null) : null;
    planned.set(node.id, { node, isNew: !mine });
  }
  // What's new, within the limits, in the file's order: folders, then splits and tabs (a split counts as one of its tabs).
  const room = { tabs: IMPORT_LIMITS.tabs, folders: IMPORT_LIMITS.folders };
  for (const [id, { node, isNew }] of planned) {
    if (!isNew) continue;
    const kind = node.kind === 'folder' ? 'folders' : 'tabs';
    if (room[kind] > 0) room[kind]--;
    else {
      planned.delete(id);
      plan.capped[kind]++;
    }
  }
  const localPos = (id: string) => localNodes.get(id)?.fields.get('pos')?.value as { chord?: string; section?: string; parent?: string | null } | undefined;
  const kindOf = (id: string) => planned.get(id)?.node.kind ?? localNodes.get(id)?.type;
  const chordOf = (id: string) => planned.get(id)?.node.chordId ?? localPos(id)?.chord;
  const sectionOf = (id: string) => planned.get(id)?.node.section ?? localPos(id)?.section;
  const parentOf = (id: string) => (planned.has(id) ? planned.get(id)!.node.parentId : (localPos(id)?.parent ?? null));
  for (const { node } of planned.values()) {
    const parent = node.parentId;
    if (parent === null) continue;
    const kind = kindOf(parent);
    // A folder holds anything but a folder in a split; a split holds tabs. Anything else goes to its section's root, as restore repairs.
    const fits = chordOf(parent) === node.chordId && (kind === 'folder' ? true : kind === 'split' && node.kind === 'tab');
    if (!fits) node.parentId = null;
    else (node as { section: string }).section = sectionOf(parent) ?? node.section;
  }
  // A folder inside itself (two computers moved each into the other) goes to its section's root.
  for (const { node } of planned.values()) {
    const seen = new Set<string>([node.id]);
    for (let up = node.parentId; up !== null; up = parentOf(up)) {
      if (seen.has(up)) {
        node.parentId = null;
        break;
      }
      seen.add(up);
    }
  }
  for (const { node } of planned.values()) {
    if (node.kind === 'tab') node.pinnedUrl = node.section === 'pinned' ? (node.pinnedUrl ?? node.url) : null;
  }
  // Depth first, parents before what's in them: any prefix of the list is whole trees, and a split's tabs follow it
  // at once (mergeParts keeps them in its part). A folder or split nested deeper than the limit comes in at its
  // section's top level, with what's in it.
  const inside = new Map<NodeId, NodeId[]>();
  const tops: NodeId[] = [];
  for (const [id, { node }] of planned) {
    if (node.parentId === null || !planned.has(node.parentId)) tops.push(id);
    else if (inside.has(node.parentId)) inside.get(node.parentId)!.push(id);
    else inside.set(node.parentId, [id]);
  }
  const ancestors = (parentId: NodeId | null): number => {
    let n = 0;
    for (let up = parentId; up !== null && n <= IMPORT_LIMITS.depth; up = parentOf(up)) n++;
    return n;
  };
  const placed = new Set<NodeId>();
  const place = (id: NodeId, depth: number) => {
    const stack: [NodeId, number][] = [[id, depth]];
    while (stack.length > 0) {
      const [next, deep] = stack.pop()!;
      if (placed.has(next)) continue;
      const entry = planned.get(next)!;
      let level = deep;
      if (entry.node.kind !== 'tab' && level >= IMPORT_LIMITS.depth) {
        entry.node.parentId = null;
        level = 0;
        plan.capped.deep++;
      }
      plan.nodes.push(entry.node);
      placed.add(next);
      if (entry.node.kind === 'folder') count(entry.isNew, 'folders');
      else if (entry.node.kind === 'tab') count(entry.isNew, entry.node.section === 'pinned' ? 'pinnedTabs' : 'todayTabs');
      const children = inside.get(next) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, level + 1]);
    }
  };
  for (const id of tops) place(id, ancestors(planned.get(id)!.node.parentId));
  // Nothing is left over once folders inside each other are undone (above); were anything, it would come in at the top level.
  for (const [id, { node }] of planned) {
    if (placed.has(id)) continue;
    node.parentId = null;
    place(id, 0);
  }

  // Favorites: one with an address you have is that Favorite, so a file never doubles one.
  const localFavorites = ofType(local, 'favorite');
  const byUrl = new Map(localFavorites.map((t) => [String(t.fields.get('url')?.value), t]));
  const urls = new Set<string>();
  const updated = new Set<string>();
  let favorites = localFavorites.length;
  for (const thing of things('favorite')) {
    const url = thing.fields.get('url')?.value;
    const mine = mineOf(thing) ?? (typeof url === 'string' ? byUrl.get(url) : undefined);
    // The same address twice in one file: the first is the Favorite.
    if ((!mine && typeof url === 'string' && urls.has(url)) || (mine && updated.has(mine.id))) continue;
    if (mine) updated.add(mine.id);
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const read = favoriteFromRecord(merged(thing, mine, won));
    if (!read) {
      plan.unreadable++;
      continue;
    }
    if (!mine && favorites >= MAX_FAVORITES) {
      plan.favoritesFull++;
      continue;
    }
    if (!mine) favorites++;
    urls.add(read.favorite.url);
    read.favorite.favicon = mine && !won.has('icon') ? null : read.icon ? (icons.get(read.icon) ?? null) : null;
    plan.favorites.push(read.favorite);
    count(!mine, 'favorites');
  }

  for (const thing of things('theme')) {
    const mine = mineOf(thing);
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const theme = themeFromRecord(merged(thing, mine, won));
    if (!theme) plan.unreadable++;
    else {
      plan.themes.push(theme);
      count(!mine, 'themes');
    }
  }

  for (const thing of things('route')) {
    const mine = mineOf(thing);
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const route = routeFromRecord(merged(thing, mine, won));
    if (!route || !chordsAfter.has(route.chordId)) plan.unreadable++;
    else {
      plan.routes.push(route);
      count(!mine, 'routes');
    }
  }

  for (const thing of things('zoom')) {
    const mine = mineOf(thing);
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const zoom = zoomFromRecord(merged(thing, mine, won));
    if (!zoom) plan.unreadable++;
    else {
      plan.zoom[zoom.host] = zoom.factor;
      count(!mine, 'zoom');
    }
  }

  // Permissions: only blocks. An allow from a file would let a site use your camera without asking.
  for (const thing of things('permission')) {
    const mine = mineOf(thing);
    const blocks: Thing = { ...thing, fields: new Map([...thing.fields].filter(([name, f]) => PERMISSIONS.includes(name as SitePermission) && f.value === 'block')) };
    const won = winners(blocks, mine, restore);
    if (won.size === 0) continue;
    const read = permissionFromRecord(merged(blocks, undefined, won, thing.id));
    if (!read) {
      plan.unreadable++;
      continue;
    }
    plan.blocks[read.origin] = Object.keys(read.decisions as SitePermissions[string]) as SitePermission[];
    count(!mine, 'blocks');
  }

  const settings = file.get('settings\nsettings');
  if (settings && !tombstoned(settings)) {
    const { patch, changes } = settingsMerge(settings, local.get('settings\nsettings'), restore, platform);
    plan.changes.unshift(...changes);
    if (choices.settings && Object.keys(patch).length > 0) plan.settings = patch;
  }

  // Effects: listed in the preview whether their switch is on or not; a site whose Effects would end up empty is left alone.
  for (const thing of things('effects')) {
    const mine = mineOf(thing);
    const won = winners(thing, mine, restore);
    if (mine && won.size === 0) continue;
    const site = effectsFromRecord(merged(thing, mine, won), newId, now);
    if (!site || !hasEffects(site)) {
      if (!site) plan.unreadable++;
      continue;
    }
    plan.effectsSites.push({ host: site.host, new: !mine });
    count(!mine, 'effects');
    if (choices.effects) plan.effects.push(site);
  }

  plan.chordIds = [...chordsAfter];
  return plan;
}

/** Things per `data.merge`: each is one store change on main, small enough to fit in a frame. */
export const MERGE_PART = 200;

/**
 * The plan as `data.merge` parts: chords first, then folders and tabs (parents
 * first, a split with its tabs in one part: the store settles splits after
 * every part, and one without its tabs would go), then the rest; Settings,
 * chords' own proxies and the first-run chord making way come last, once
 * everything they point at is in.
 */
export function mergeParts(plan: MergePlan, size = MERGE_PART): MergePart[] {
  const parts: MergePart[] = [];
  let part: MergePart = {};
  let things = 0;
  const room = () => {
    if (things < size) return;
    parts.push(part);
    part = {};
    things = 0;
  };
  const add = <K extends 'chords' | 'nodes' | 'favorites' | 'themes' | 'routes'>(key: K, list: NonNullable<MergePart[K]>) => {
    for (const item of list) {
      room();
      ((part[key] ??= [] as never) as unknown[]).push(item);
      things++;
    }
  };
  const map = <K extends 'zoom' | 'blocks'>(key: K, record: NonNullable<MergePart[K]>) => {
    for (const [name, value] of Object.entries(record)) {
      room();
      ((part[key] ??= {} as never) as Record<string, unknown>)[name] = value;
      things++;
    }
  };
  add('chords', plan.chords);
  // A split's tabs follow it in the plan (depth first): together, they start a part of their own if they don't fit.
  for (let i = 0; i < plan.nodes.length; ) {
    const first = plan.nodes[i]!;
    let end = i + 1;
    if (first.kind === 'split') while (end < plan.nodes.length && plan.nodes[end]!.parentId === first.id) end++;
    if (things > 0 && things + (end - i) > size) {
      parts.push(part);
      part = {};
      things = 0;
    }
    (part.nodes ??= []).push(...plan.nodes.slice(i, end));
    things += end - i;
    i = end;
  }
  add('favorites', plan.favorites);
  add('themes', plan.themes);
  add('routes', plan.routes);
  map('zoom', plan.zoom);
  map('blocks', plan.blocks);
  if (plan.settings) part.settings = plan.settings;
  if (Object.keys(plan.proxies).length > 0) part.proxies = plan.proxies;
  if (plan.makeWay) part.makeWay = plan.makeWay;
  if (Object.keys(part).length > 0) parts.push(part);
  return parts;
}

/** What an import from a Chord file brought: the toast and Settings say it. */
export interface ImportedCounts {
  chords: number;
  /** Pinned and Today tabs, new or updated. */
  tabs: number;
  favorites: number;
  /** The rest of setup: folders, themes, routes, zoom, blocks. */
  other: number;
  /** Sites with Effects. */
  effects: number;
  settings: number;
  /** History pages that gained visits. */
  pages: number;
  chats: number;
}

const numbers = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${numbers.format(n)} ${n === 1 ? one : many}`;

/** "Imported 2 chords, 40 tabs, 3 Favorites and 3,000 pages of history", without a full stop: a toast's or Settings' line. */
export function importedText(counts: ImportedCounts): string {
  const parts = [
    counts.chords ? plural(counts.chords, 'chord') : '',
    counts.tabs ? plural(counts.tabs, 'tab') : '',
    counts.favorites ? plural(counts.favorites, 'Favorite') : '',
    counts.effects ? `Effects for ${plural(counts.effects, 'site')}` : '',
    counts.settings ? plural(counts.settings, 'setting') : '',
    counts.pages ? `${plural(counts.pages, 'page')} of history` : '',
    counts.chats ? plural(counts.chats, 'Duet chat') : '',
  ].filter(Boolean);
  if (parts.length === 0) return counts.other ? 'Imported your setup' : 'Everything in the file was here already';
  return `Imported ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}`;
}

/** What an import from a Chord file changed, as it was before, so its Undo can put it back (this session only, never saved). */
export interface MergeUndo {
  /** Things it updated, by id, as they were. */
  chords: Record<ChordId, Chord>;
  nodes: Record<NodeId, SidebarNode>;
  favorites: Record<string, Favorite>;
  /** Null: it added the theme, route, zoom or site. */
  themes: Record<string, CustomTheme | null>;
  routes: Record<string, LinkRoute | null>;
  zoom: Record<string, number | null>;
  permissions: Record<string, SitePermissions[string] | null>;
  /** Each setting it changed, before and after (as JSON): Undo puts one back only if it's still as the import left it. */
  settings: Partial<Record<keyof Settings, { before: unknown; after: string }>>;
  /** Every folder, tab and split it added. */
  added: NodeId[];
  /** The first-run chord that made way, with its tabs as they were. */
  madeWay: { chord: Chord; nodes: SidebarNode[]; to: ChordId } | null;
  /** Undo has put the updated things back (its first part); what's left is taking away what it added. */
  restored: boolean;
}

export const emptyMergeUndo = (): MergeUndo => ({
  chords: {},
  nodes: {},
  favorites: {},
  themes: {},
  routes: {},
  zoom: {},
  permissions: {},
  settings: {},
  added: [],
  madeWay: null,
  restored: false,
});
