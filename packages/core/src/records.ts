/**
 * Your data's records (docs/decisions/S15-your-data.md §1, docs/data-format.md):
 * the one format export and sync share. A record names one thing (`type`,
 * `id`), the fields it sets, and their stamp (`at`, stamps.ts). History, Duet
 * chats and icons are facts that never change once made, so theirs have none.
 *
 * Each type has a pair of codecs: model → record, and record → model, which
 * checks what it reads the way restore checks saved data. Only what S15 lists
 * goes in: never back/forward state, live state, a private window's chord,
 * the time a tab was last shown, a Duet chat's provider session, or anything
 * that's a path on this computer.
 */
import { DUET_PROVIDERS, isDuetScope, type DuetAttachment, type DuetCitation, type DuetImage, type DuetMessage, type DuetMessageBody, type DuetThread } from './duet';
import { routeKey } from './links';
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  isPrivateProfile,
  MAX_ZOOM,
  MIN_ZOOM,
  type Chord,
  type ChordThemeSpec,
  type CustomTheme,
  type Favorite,
  type FolderNode,
  type LinkRoute,
  type PermissionDecision,
  type Section,
  type Settings,
  type SidebarNode,
  type SitePermission,
  type SitePermissions,
  type SplitNode,
  type TabNode,
} from './model';
import { ARCHIVE_URL } from './idle';
import { cleanProxy, type ProxySettings } from './proxy';
import { validTheme } from './restore';
import type { Platform } from './shortcuts';
import { isStamp, rowStamp, compareStamps, type Stamp } from './stamps';

// Core compiles without DOM types; URL is a global in Node and every browser.
declare const URL: new (url: string) => { protocol: string; username: string; password: string; href: string };

export type RecordType =
  | 'chord'
  | 'folder'
  | 'tab'
  | 'split'
  | 'favorite'
  | 'theme'
  | 'settings'
  | 'route'
  | 'effects'
  | 'icon'
  | 'zoom'
  | 'permission'
  | 'page'
  | 'thread'
  | 'message'
  | 'image'
  /** Sync's: a computer's name, system and Chord (S15 §6). Never in an export. */
  | 'device';

export const RECORD_TYPES: readonly RecordType[] = ['chord', 'folder', 'tab', 'split', 'favorite', 'theme', 'settings', 'route', 'effects', 'icon', 'zoom', 'permission', 'page', 'thread', 'message', 'image', 'device'];

/** One line of a file: one thing, the fields this line sets, and (setup only) their stamp. Fields it doesn't list keep their values. */
export interface DataRecord {
  /** A string: a newer Chord's types are kept and passed over, never refused. */
  type: string;
  id: string;
  at?: Stamp;
  set: Record<string, unknown>;
}

/** Where a sidebar node is: one field, so a merge can't leave a tab half-moved. */
export interface RecordPos {
  chord: string;
  section: Section;
  parent: string | null;
  rank: string;
}

/** The longest id any record has (a page's is its address). */
const MAX_ID = 32_768;

/** Whether a parsed line is shaped like a record: a type, an id, fields, and a stamp if it has one. What the type means isn't checked. */
export function isDataRecord(raw: unknown): raw is DataRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r['type'] !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(r['type'])) return false;
  if (typeof r['id'] !== 'string' || r['id'].length === 0 || r['id'].length > MAX_ID) return false;
  if (!r['set'] || typeof r['set'] !== 'object' || Array.isArray(r['set'])) return false;
  return r['at'] === undefined || isStamp(r['at']);
}

/* ---------- Checks for what's read ---------- */

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isRank = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isWebUrl = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_ID && /^https?:\/\/[^\s/]/i.test(v);
const record = (type: RecordType, id: string, set: Record<string, unknown>, at?: Stamp): DataRecord => (at ? { type, id, at, set } : { type, id, set });

/** A chord's colors, as one field. */
function chordThemeOf(theme: ChordThemeSpec): Record<string, unknown> {
  return { stops: theme.stops.map(({ l, c, h }) => ({ l, c, h })), grain: theme.grain, appearance: theme.appearance, ...(theme.themeId ? { themeId: theme.themeId } : {}) };
}

function chordThemeFrom(raw: unknown): ChordThemeSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  // Stops and grain are checked as a custom theme's are.
  const colors = validTheme({ id: 'chord', name: '', stops: t['stops'], grain: t['grain'] });
  const appearance = t['appearance'];
  if (!colors || (appearance !== 'light' && appearance !== 'dark' && appearance !== 'auto')) return null;
  const themeId = text(t['themeId'], 100);
  return { stops: colors.stops, grain: colors.grain, appearance, ...(themeId ? { themeId } : {}) };
}

/**
 * A proxy as a file holds it: one Chord can use (core's cleanProxy), and never
 * a password, not even one in a configuration file's address. Null for one
 * that can't be used.
 */
export function exportedProxy(value: unknown): ProxySettings | null {
  const proxy = cleanProxy(value);
  if (!proxy?.pac || proxy.pac.startsWith('data:')) return proxy;
  const url = new URL(proxy.pac);
  if (!url.username && !url.password) return proxy;
  url.username = '';
  url.password = '';
  return { ...proxy, pac: url.href } as ProxySettings;
}

/** Where a tab read from a file may be: a web page, or Chord's archive page. The reducer checks an import's tabs with it again. */
export const isTabUrl = (v: unknown): v is string => isWebUrl(v) || (typeof v === 'string' && v.startsWith(ARCHIVE_URL));

/* ---------- Setup ---------- */

/**
 * A chord, with whether it keeps its own sign-ins (`profile`) and its own
 * proxy (`proxy`, null for the proxy for every chord). A private window's
 * chord is never a record. The proxy is exported, never synced: it's about
 * the network this computer is on (S15 §1, §11).
 */
export function chordRecord(chord: Chord, at: Stamp): DataRecord | null {
  if (chord.private) return null;
  return record(
    'chord',
    chord.id,
    { name: chord.name, icon: chord.icon, theme: chordThemeOf(chord.theme), rank: chord.rank, profile: chord.profileId, created: chord.createdAt, proxy: chord.proxy ? exportedProxy(chord.proxy) : null },
    at,
  );
}

export function chordFromRecord(r: DataRecord): Chord | null {
  const s = r.set;
  const name = text(s['name'], 200);
  const icon = text(s['icon'], 64);
  const theme = chordThemeFrom(s['theme']);
  // Its own sign-ins, or everyone's; never a private window's, which only a private window has.
  const profile = s['profile'] === DEFAULT_PROFILE || (isId(s['profile']) && !isPrivateProfile(s['profile'])) ? (s['profile'] as string) : null;
  if (r.type !== 'chord' || !isId(r.id) || name === null || icon === null || !theme || !isRank(s['rank']) || !profile) return null;
  // As restore does: a proxy of its own only with sign-ins of its own, and only one that can be used.
  const proxy = profile !== DEFAULT_PROFILE && s['proxy'] ? cleanProxy(s['proxy']) : null;
  return { id: r.id, profileId: profile, name, icon, theme, rank: s['rank'], createdAt: time(s['created']) ?? 0, ...(proxy ? { proxy } : {}) };
}

const posOf = (node: SidebarNode): RecordPos => ({ chord: node.chordId, section: node.section, parent: node.parentId, rank: node.rank });

function posFrom(raw: unknown): RecordPos | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!isId(p['chord']) || (p['section'] !== 'pinned' && p['section'] !== 'today') || !isRank(p['rank'])) return null;
  if (p['parent'] !== null && !isId(p['parent'])) return null;
  return { chord: p['chord'], section: p['section'], parent: p['parent'] as string | null, rank: p['rank'] };
}

/**
 * A folder, tab or split. A tab's icon is an `icon` record's id (`iconId`),
 * or null. Never its back/forward history, when it was last shown, or
 * anything live: a tab comes back at its address, unloaded.
 */
export function nodeRecord(node: SidebarNode, at: Stamp, icon: string | null = null): DataRecord {
  const pos = posOf(node);
  switch (node.kind) {
    case 'folder':
      return record('folder', node.id, { pos, title: node.title, collapsed: node.collapsed, created: node.createdAt }, at);
    case 'split':
      return record('split', node.id, { pos, direction: node.direction, sizes: [...node.sizes], created: node.createdAt }, at);
    case 'tab':
      return record(
        'tab',
        node.id,
        { pos, url: node.url, pinnedUrl: node.pinnedUrl, title: node.title, customTitle: node.customTitle, icon, muted: Boolean(node.muted), created: node.createdAt },
        at,
      );
  }
}

/**
 * A folder, tab or split read back, with a tab's icon id for the caller to
 * find among the icon records (they come later in a file). It arrives
 * unloaded: `now` is when it was last shown.
 */
export function nodeFromRecord(r: DataRecord, now: number): { node: SidebarNode; icon: string | null } | null {
  const s = r.set;
  const pos = posFrom(s['pos']);
  if (!isId(r.id) || !pos) return null;
  const base = { id: r.id, chordId: pos.chord, parentId: pos.parent, rank: pos.rank, createdAt: time(s['created']) ?? 0 };
  if (r.type === 'folder') {
    const title = text(s['title'], 1000);
    if (title === null || pos.section !== 'pinned') return null;
    const folder: FolderNode = { ...base, kind: 'folder', section: 'pinned', title, collapsed: s['collapsed'] === true };
    return { node: folder, icon: null };
  }
  if (r.type === 'split') {
    const sizes = Array.isArray(s['sizes']) ? s['sizes'].filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1) : [];
    const split: SplitNode = { ...base, kind: 'split', section: pos.section, direction: s['direction'] === 'column' ? 'column' : 'row', sizes };
    return { node: split, icon: null };
  }
  if (r.type !== 'tab') return null;
  const url = s['url'];
  const title = text(s['title'], 10_000);
  if (!isTabUrl(url) || title === null) return null;
  const pinnedUrl = pos.section === 'pinned' && isTabUrl(s['pinnedUrl']) ? s['pinnedUrl'] : null;
  const tab: TabNode = {
    ...base,
    kind: 'tab',
    section: pos.section,
    url,
    title,
    pinnedUrl,
    customTitle: text(s['customTitle'], 1000),
    favicon: null,
    lastActiveAt: now,
    ...(s['muted'] === true ? { muted: true } : {}),
  };
  return { node: tab, icon: typeof s['icon'] === 'string' && isIconId(s['icon']) ? s['icon'] : null };
}

export function favoriteRecord(favorite: Favorite, at: Stamp, icon: string | null = null): DataRecord {
  return record('favorite', favorite.id, { url: favorite.url, title: favorite.title, icon, rank: favorite.rank, created: favorite.createdAt }, at);
}

export function favoriteFromRecord(r: DataRecord): { favorite: Favorite; icon: string | null } | null {
  const s = r.set;
  const title = text(s['title'], 1000);
  if (r.type !== 'favorite' || !isId(r.id) || !isWebUrl(s['url']) || title === null || !isRank(s['rank'])) return null;
  return {
    favorite: { id: r.id, url: s['url'], title, favicon: null, rank: s['rank'], createdAt: time(s['created']) ?? 0 },
    icon: typeof s['icon'] === 'string' && isIconId(s['icon']) ? s['icon'] : null,
  };
}

/** A theme you made: a record of its own, so two computers that each add one keep both. */
export function themeRecord(theme: CustomTheme, at: Stamp): DataRecord {
  return record('theme', theme.id, { name: theme.name, stops: theme.stops.map(({ l, c, h }) => ({ l, c, h })), grain: theme.grain }, at);
}

export function themeFromRecord(r: DataRecord): CustomTheme | null {
  return r.type === 'theme' && isId(r.id) ? validTheme({ id: r.id, name: r.set['name'], stops: r.set['stops'], grain: r.set['grain'] }) : null;
}

export function routeRecord(route: LinkRoute, at: Stamp): DataRecord {
  return record('route', route.host, { chord: route.chordId, created: route.createdAt }, at);
}

export function routeFromRecord(r: DataRecord): LinkRoute | null {
  if (r.type !== 'route' || routeKey(r.id) !== r.id || !isId(r.set['chord'])) return null;
  return { host: r.id, chordId: r.set['chord'], createdAt: time(r.set['created']) ?? 0 };
}

/** Page zoom you chose for a site, by host. Exported, never synced: it depends on the display. */
export function zoomRecord(host: string, factor: number, at: Stamp): DataRecord {
  return record('zoom', host, { factor }, at);
}

export function zoomFromRecord(r: DataRecord): { host: string; factor: number } | null {
  const factor = r.set['factor'];
  if (r.type !== 'zoom' || !/^[a-z0-9.:[\]-]{1,300}$/.test(r.id) || typeof factor !== 'number' || !(factor >= MIN_ZOOM && factor <= MAX_ZOOM)) return null;
  return { host: r.id, factor };
}

const PERMISSIONS: readonly SitePermission[] = ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'];

/** A site's remembered decisions, one field each. Exported, never synced; an import takes only `block` (S15 §5). */
export function permissionRecord(origin: string, decisions: SitePermissions[string], at: Stamp): DataRecord | null {
  const set: Record<string, PermissionDecision> = {};
  for (const permission of PERMISSIONS) {
    const decision = decisions[permission];
    if (decision === 'allow' || decision === 'block') set[permission] = decision;
  }
  return Object.keys(set).length > 0 ? record('permission', origin, set, at) : null;
}

export function permissionFromRecord(r: DataRecord): { origin: string; decisions: SitePermissions[string] } | null {
  if (r.type !== 'permission' || !/^https?:\/\/[^\s/]+$/.test(r.id)) return null;
  const decisions: SitePermissions[string] = {};
  for (const permission of PERMISSIONS) {
    const decision = r.set[permission];
    if (decision === 'allow' || decision === 'block') decisions[permission] = decision;
  }
  return Object.keys(decisions).length > 0 ? { origin: r.id, decisions } : null;
}

/* ---------- Settings ---------- */

/**
 * How each setting travels (S15 §1, "Which settings travel"):
 * - `sync`: exported and synced.
 * - `export`: exported, so a restore brings it back, but never synced: it's
 *   about the network this computer is on (the proxy).
 * - `computer`: neither, it's about this computer (its display, how Chord
 *   was installed, the window sizes you left).
 * - `once`: neither, a one-time flag.
 * - `records`: moved out, into records of their own (themes).
 * - `family`: keyboard shortcuts, per OS family (`shortcuts.mac`, `shortcuts.other`).
 * Typed by every key of Settings, so a new setting doesn't build until it says how it travels.
 */
export type SettingTravel = 'sync' | 'export' | 'computer' | 'once' | 'records' | 'family';

export const SETTING_TRAVEL: Record<keyof Settings, SettingTravel> = {
  searchEngine: 'sync',
  searchSuggestions: 'sync',
  motion: 'sync',
  colorScheme: 'sync',
  interface: 'sync',
  uiScale: 'computer',
  themes: 'records',
  extensionButtons: 'sync',
  checkForUpdates: 'computer',
  separateSignIns: 'sync',
  onboarded: 'once',
  archiveAfter: 'sync',
  sleepTabs: 'sync',
  autoPip: 'sync',
  autoPipDefaultOff: 'once',
  pagePreviews: 'sync',
  presentingHidesSidebar: 'sync',
  sidebarPeek: 'sync',
  keepScreenshots: 'sync',
  shortcuts: 'family',
  spellcheck: 'sync',
  googleFree: 'sync',
  safeBrowsing: 'sync',
  safeBrowsingAsked: 'sync',
  adBlocking: 'sync',
  tabCounts: 'sync',
  duet: 'sync',
  externalLinks: 'sync',
  miniWindowSize: 'computer',
  reader: 'sync',
  effects: 'sync',
  devtools: 'computer',
  proxy: 'export',
  encryptExports: 'sync',
};

/**
 * Settings whose parts are fields of their own, with dotted names
 * (`adBlocking.offSites`): the groups a settings change merges into part by
 * part. A setting that's replaced whole (the proxy, a list) is one field.
 */
const GROUPS = ['motion', 'interface', 'spellcheck', 'adBlocking', 'tabCounts', 'duet', 'reader', 'effects'] as const;
type Group = (typeof GROUPS)[number];
/** Duet's app and model depend on which CLI is installed on this computer. */
const NOT_EXPORTED: Partial<Record<Group, readonly string[]>> = { duet: ['provider', 'model'] };

const isGroup = (key: string): key is Group => (GROUPS as readonly string[]).includes(key);
const groupParts = (group: Group): string[] => Object.keys(DEFAULT_SETTINGS[group]).filter((part) => !NOT_EXPORTED[group]?.includes(part));
/** A Mac's shortcuts don't fit Windows or Linux, and the other way round. */
export const shortcutFamily = (platform: Platform): 'mac' | 'other' => (platform === 'darwin' ? 'mac' : 'other');

/**
 * One saved setting as a settings record's fields; null for one that doesn't
 * travel. `value` is as chord-data keeps it (JSON, unchecked): a reader of
 * the record checks it the way restore does.
 */
export function settingFields(key: string, value: unknown, platform: Platform): Record<string, unknown> | null {
  const travel = SETTING_TRAVEL[key as keyof Settings];
  if (key === 'proxy') {
    const proxy = exportedProxy(value);
    return proxy ? { proxy } : null;
  }
  if (travel === 'sync' || travel === 'export') {
    if (!isGroup(key)) return { [key]: value };
    if (!value || typeof value !== 'object') return null;
    const fields: Record<string, unknown> = {};
    for (const part of groupParts(key)) {
      const v = (value as Record<string, unknown>)[part];
      if (v !== undefined) fields[`${key}.${part}`] = v;
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }
  if (travel === 'family') return { [`shortcuts.${shortcutFamily(platform)}`]: value ?? {} };
  return null;
}

/**
 * The settings in records, as chord-data keeps them (by key, groups whole),
 * for restore's checks. Only this computer's family of shortcuts is read;
 * fields that aren't settings, or don't travel, are left out.
 */
export function settingsFromFields(fields: Record<string, unknown>, platform: Platform): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    const dot = name.indexOf('.');
    const key = dot < 0 ? name : name.slice(0, dot);
    const part = dot < 0 ? null : name.slice(dot + 1);
    const travel = SETTING_TRAVEL[key as keyof Settings];
    if (travel === 'family') {
      if (part === shortcutFamily(platform)) out['shortcuts'] = value;
    } else if ((travel === 'sync' || travel === 'export') && isGroup(key) && part && groupParts(key).includes(part)) {
      ((out[key] ??= {}) as Record<string, unknown>)[part] = value;
    } else if ((travel === 'sync' || travel === 'export') && !isGroup(key) && part === null) {
      out[key] = value;
    }
  }
  return out;
}

/** A row of chord-data's `setting` table: one setting, as JSON, and when it last changed. */
export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

/**
 * The settings record: one field per setting that travels. Settings changed
 * at different times carry different stamps, so it's one record per stamp,
 * oldest first (S15 §1). Themes become records of their own (`themeRecords`).
 */
export function settingsRecords(rows: readonly SettingRow[], device: string, platform: Platform): DataRecord[] {
  const byStamp = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const fields = settingFields(row.key, row.value, platform);
    if (!fields) continue;
    const at = rowStamp(row.updatedAt, device)[0];
    byStamp.set(at, { ...byStamp.get(at), ...fields });
  }
  return [...byStamp]
    .map(([ms, set]) => record('settings', 'settings', set, rowStamp(ms, device)))
    .sort((a, b) => compareStamps(a.at!, b.at!));
}

/** The themes you made, from the `themes` setting's row: each one's record has that row's stamp. */
export function themeRecords(row: SettingRow | undefined, device: string): DataRecord[] {
  if (!row || !Array.isArray(row.value)) return [];
  return row.value.map(validTheme).filter((t): t is CustomTheme => t !== null).map((t) => themeRecord(t, rowStamp(row.updatedAt, device)));
}

/* ---------- Icons ---------- */

/** An icon's id: `sha256-` and the hex of its bytes' SHA-256, so the same picture is one record however many use it. */
export const iconId = (sha256Hex: string): string => `sha256-${sha256Hex}`;
export const isIconId = (value: string): boolean => /^sha256-[0-9a-f]{64}$/.test(value);

/** The icons Chord keeps are small: anything bigger isn't one. */
const MAX_ICON_BASE64 = 1_400_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** An icon some record above uses: its type and its bytes, in base64. */
export function iconRecord(icon: { id: string; mime: string; data: string }): DataRecord {
  return record('icon', icon.id, { mime: icon.mime, data: icon.data });
}

export function iconFromRecord(r: DataRecord): { id: string; mime: string; data: string } | null {
  const mime = text(r.set['mime'], 100);
  const data = text(r.set['data'], MAX_ICON_BASE64);
  if (r.type !== 'icon' || !isIconId(r.id) || !mime || !/^image\/[a-z0-9.+-]+$/.test(mime) || data === null || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  return { id: r.id, mime, data };
}

/* ---------- History ---------- */

/** A page you visited: its address (the id), its title, every visit (ms, oldest first) and how often you typed it. */
export interface PageFacts {
  url: string;
  title: string;
  visits: number[];
  typed: number;
}

export function pageRecord(page: PageFacts): DataRecord {
  return record('page', page.url, { title: page.title, visits: [...page.visits].sort((a, b) => a - b), typed: page.typed });
}

export function pageFromRecord(r: DataRecord): PageFacts | null {
  const title = text(r.set['title'], 10_000) ?? '';
  const visits = Array.isArray(r.set['visits']) ? r.set['visits'].filter((v): v is number => time(v) !== null && v > 0) : [];
  const typed = time(r.set['typed']) ?? 0;
  if (r.type !== 'page' || !isWebUrl(r.id) || visits.length === 0) return null;
  return { url: r.id, title, visits: visits.sort((a, b) => a - b), typed };
}

/* ---------- Duet ---------- */

/** A chat, without its provider session: that's the CLI's own cache, and an imported chat starts a new one. */
export function threadRecord(thread: DuetThread): DataRecord {
  return record('thread', thread.id, {
    chord: thread.chordId,
    title: thread.title,
    provider: thread.provider,
    model: thread.model,
    scope: thread.scope,
    created: thread.createdAt,
    updated: thread.updatedAt,
    lastUsed: thread.lastUsedAt,
  });
}

export function threadFromRecord(r: DataRecord): DuetThread | null {
  const s = r.set;
  const title = text(s['title'], 1000);
  const created = time(s['created']);
  if (r.type !== 'thread' || !isId(r.id) || !isId(s['chord']) || title === null || created === null) return null;
  if (!DUET_PROVIDERS.includes(s['provider'] as DuetThread['provider'])) return null;
  return {
    id: r.id,
    chordId: s['chord'],
    title,
    provider: s['provider'] as DuetThread['provider'],
    model: text(s['model'], 100),
    providerSessionId: null,
    scope: isDuetScope(s['scope']) ? s['scope'] : 'ask',
    createdAt: created,
    updatedAt: time(s['updated']) ?? created,
    lastUsedAt: time(s['lastUsed']) ?? created,
  };
}

const IMAGE_MIMES: readonly DuetImage['mime'][] = ['image/jpeg', 'image/png', 'image/webp'];
const isImageId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);

/** An image as a message names it: never where Codex saved its own copy, a path on this computer. */
function imageRef(image: DuetImage): DuetImage {
  return { id: image.id, mime: image.mime, width: image.width, height: image.height, ...(image.prompt ? { prompt: image.prompt } : {}) };
}

function imageRefFrom(raw: unknown): DuetImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  const size = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : null);
  const width = size(i['width']);
  const height = size(i['height']);
  if (!isImageId(i['id']) || !IMAGE_MIMES.includes(i['mime'] as DuetImage['mime']) || !width || !height) return null;
  const prompt = text(i['prompt'], 4000);
  return { id: i['id'], mime: i['mime'] as DuetImage['mime'], width, height, ...(prompt ? { prompt } : {}) };
}

/**
 * A message's body as Chord stores it, less what's about this computer or
 * this moment: a citation's tab, a fill card's values (never saved anyway),
 * how many images a reply was still making, and Codex's own copy of one.
 */
export function exportedBody(body: DuetMessageBody): DuetMessageBody {
  // As stored, which an older Chord may have written with less in it.
  switch (body.role) {
    case 'user':
      return { role: 'user', text: body.text, attachments: (body.attachments ?? []).map(({ ref, url, title }) => ({ ref, url, title })), ...(body.images ? { images: body.images.map(imageRef) } : {}) };
    case 'assistant': {
      const { making: _making, images, citations, ...rest } = body;
      return { ...rest, citations: (citations ?? []).map((c) => ({ ...c, tabId: null })), ...(images ? { images: images.map(imageRef) } : {}) };
    }
    case 'tool': {
      const { fill: _fill, ...rest } = body;
      return rest;
    }
    default:
      return body;
  }
}

export function messageRecord(message: DuetMessage): DataRecord {
  return record('message', message.id, { thread: message.threadId, created: message.createdAt, body: exportedBody(message.body) });
}

const STATUSES = ['streaming', 'done', 'interrupted', 'error'] as const;
const DECISIONS = ['pending', 'once', 'thread', 'denied', 'expired'] as const;
/** A chat's handle for a tab ("t3"), as Duet's citations and attachments name it. */
const isTabRef = (v: unknown): v is string => typeof v === 'string' && /^t\d{1,4}$/.test(v);
/** At most this many attachments, citations, images or targets in one message: far more than Chord ever writes. */
const MAX_PER_MESSAGE = 200;

/**
 * A body read back: each role's fields checked, every list and string within
 * what Chord itself writes; links that aren't http(s) are dropped, as they
 * would be on import (S15 §5), so a file's `javascript:` never becomes a link.
 */
function bodyFrom(raw: unknown): DuetMessageBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_PER_MESSAGE) : []).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
  const images = Array.isArray(b['images']) ? list(b['images']).map(imageRefFrom).filter((i): i is DuetImage => i !== null) : null;
  switch (b['role']) {
    case 'user': {
      const value = text(b['text'], 200_000);
      if (value === null) return null;
      const attachments = list(b['attachments'])
        .filter((a) => isTabRef(a['ref']) && isWebUrl(a['url']) && text(a['title'], 10_000) !== null)
        .map((a): DuetAttachment => ({ ref: a['ref'] as string, url: a['url'] as string, title: a['title'] as string }));
      return { role: 'user', text: value, attachments, ...(images ? { images } : {}) };
    }
    case 'assistant': {
      const value = text(b['text'], 400_000);
      if (value === null) return null;
      const citations = list(b['citations'])
        .filter((c) => Number.isInteger(c['n']) && (c['n'] as number) > 0 && isTabRef(c['ref']) && isWebUrl(c['url']) && text(c['title'], 10_000) !== null && text(c['quote'], 2000) !== null)
        .map((c): DuetCitation => ({
          n: c['n'] as number,
          ref: c['ref'] as string,
          url: c['url'] as string,
          title: c['title'] as string,
          quote: c['quote'] as string,
          tabId: null,
          ...(Number.isInteger(c['page']) && (c['page'] as number) > 0 ? { page: c['page'] as number } : {}),
        }));
      const status = STATUSES.includes(b['status'] as (typeof STATUSES)[number]) ? (b['status'] as (typeof STATUSES)[number]) : 'done';
      const error = text(b['error'], 4000);
      return { role: 'assistant', text: value, citations, status, ...(error ? { error } : {}), ...(images ? { images } : {}) };
    }
    case 'tool': {
      const tool = text(b['tool'], 100);
      const summary = text(b['summary'], 4000);
      const detail = text(b['detail'], 20_000);
      return tool !== null && summary !== null && detail !== null ? { role: 'tool', tool, summary, detail, ok: b['ok'] === true } : null;
    }
    case 'approval': {
      const tool = text(b['tool'], 100);
      const description = text(b['description'], 4000);
      const target = Array.isArray(b['target']) ? b['target'].slice(0, MAX_PER_MESSAGE).filter((t): t is string => typeof t === 'string' && t.length <= 2000) : [];
      const decision = DECISIONS.includes(b['decision'] as (typeof DECISIONS)[number]) ? (b['decision'] as (typeof DECISIONS)[number]) : 'expired';
      return tool !== null && description !== null ? { role: 'approval', tool, description, target, decision } : null;
    }
    case 'divider': {
      const value = text(b['text'], 1000);
      return value === null ? null : { role: 'divider', text: value };
    }
    default:
      return null;
  }
}

export function messageFromRecord(r: DataRecord): DuetMessage | null {
  const body = bodyFrom(r.set['body']);
  const created = time(r.set['created']);
  if (r.type !== 'message' || !isId(r.id) || !isId(r.set['thread']) || !body || created === null) return null;
  return { id: r.id, threadId: r.set['thread'], createdAt: created, body };
}

/** An image in a chat, with its bytes and (one you gave Duet) its thumbnail, in base64. */
export function imageRecord(image: DuetImage, data: string, thumb: string | null): DataRecord {
  return record('image', image.id, { mime: image.mime, width: image.width, height: image.height, data, thumb, prompt: image.prompt ?? null });
}

/** A line is at most 32 MB (S15 §5), and an image's bytes are nearly all of its line. */
const MAX_IMAGE_BASE64 = 32_000_000;

export function imageFromRecord(r: DataRecord): { image: DuetImage; data: string; thumb: string | null } | null {
  const image = imageRefFrom({ ...r.set, id: r.id });
  const data = text(r.set['data'], MAX_IMAGE_BASE64);
  const thumb = text(r.set['thumb'], MAX_ICON_BASE64);
  if (r.type !== 'image' || !image || !data || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  return { image, data, thumb: thumb && thumb.length % 4 === 0 && BASE64.test(thumb) ? thumb : null };
}
