/**
 * Rebuilding state from what chord-data saved (ARCHITECTURE.md §6.2). Saved
 * data can be old, partial or inconsistent (a crash mid-write, a newer build
 * downgraded), so this repairs rather than trusts: references to missing
 * chords or tabs are dropped, settings fill in from defaults, and there is
 * always at least one chord and one window.
 */
import {
  defaultSettings,
  type ArchiveAfter,
  emptyState,
  GOOGLE_FREE_ENGINE,
  MAX_ZOOM,
  MIN_ZOOM,
  SIDEBAR_WIDTH,
  extensionKey,
  isUiScale,
  type Chord,
  type CustomTheme,
  type Favorite,
  type Oklch,
  type Download,
  type InstalledExtension,
  type LinkRoute,
  type MotionSettings,
  type Settings,
  type SidebarNode,
  type SitePermission,
  type SitePermissions,
  type State,
  type WindowModel,
} from './model';
import { cleanOverrides } from './bindings';
import { ARCHIVE_AFTER_MS } from './idle';
import { SEARCH_ENGINES } from './input';
import { routeHost } from './links';
import { seedState, type SeedOptions } from './seed';
import { sortedChords } from './select';
import type { Platform } from './shortcuts';
import { settleSplits, shownWith } from './split';

/** Everything chord-data persists; live engine state and the version never are. */
export interface PersistedState {
  chords: Chord[];
  nodes: SidebarNode[];
  windows: WindowModel[];
  /** Saved settings by key; unknown or malformed keys are ignored. */
  settings: Record<string, unknown>;
  /** Remembered permission decisions, by origin. */
  sitePermissions?: SitePermissions;
  downloads?: Download[];
  extensions?: InstalledExtension[];
  /** The Favorites row. */
  favorites?: Favorite[];
  /** Page zoom by host. */
  siteZoom?: Record<string, number>;
  /** Link routes: a site's links open in a chord. */
  linkRoutes?: LinkRoute[];
}

/** Routes that still make sense: a plausible host, pointing at a chord that's still there (and isn't a private window's). */
function restoreRoutes(saved: LinkRoute[] | undefined, chords: Record<string, Chord>): Record<string, LinkRoute> {
  const out: Record<string, LinkRoute> = {};
  for (const route of saved ?? []) {
    const host = typeof route?.host === 'string' ? routeHost(route.host) : null;
    const chord = typeof route?.chordId === 'string' ? chords[route.chordId] : undefined;
    if (!host || host !== route.host || !chord || chord.private) continue;
    out[host] = { host, chordId: chord.id, createdAt: typeof route.createdAt === 'number' ? route.createdAt : 0 };
  }
  return out;
}

/** The mini window's remembered size, if it's a sensible one. */
function restoreMiniSize(saved: unknown): Settings['miniWindowSize'] {
  if (!saved || typeof saved !== 'object') return null;
  const { width, height } = saved as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 360 && n <= 4000;
  return ok(width) && ok(height) ? { width: Math.round(width), height: Math.round(height) } : null;
}

/** A dictionary language code, as Chromium names them: `en-US`, `pt-BR`, `es-419`, `fr`. */
export const isLanguageCode = (code: string): boolean => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code);

/** Zoom levels that still make sense: a host and a factor in Chromium's range, other than 100%. */
function restoreZoom(saved: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [host, factor] of Object.entries(saved ?? {})) {
    if (host && typeof factor === 'number' && factor >= MIN_ZOOM && factor <= MAX_ZOOM && Math.abs(factor - 1) >= 0.001) out[host] = factor;
  }
  return out;
}

/** Favorites that still make sense: a web address and a rank. */
function restoreFavorites(saved: Favorite[] | undefined): Record<string, Favorite> {
  const out: Record<string, Favorite> = {};
  for (const f of saved ?? []) {
    if (typeof f.id === 'string' && /^https?:/i.test(f.url) && typeof f.rank === 'string') out[f.id] = f;
  }
  return out;
}

/** Downloads cut off by quitting can't continue in a new session: they come back as interrupted. */
function restoreDownloads(saved: Download[] | undefined): Record<string, Download> {
  const out: Record<string, Download> = {};
  for (const d of saved ?? []) {
    const unfinished = d.state === 'progressing' || d.state === 'paused';
    out[d.id] = unfinished ? { ...d, state: 'interrupted', speed: 0, endedAt: d.endedAt ?? d.startedAt } : d;
  }
  return out;
}

const EXTENSION_ID = /^[a-p]{32}$/;

/** Installed extensions that still make sense; anything malformed is dropped (and simply not loaded). */
export function restoreExtensions(saved: readonly InstalledExtension[] | undefined): Record<string, InstalledExtension> {
  const out: Record<string, InstalledExtension> = {};
  for (const e of saved ?? []) {
    if (!e || !EXTENSION_ID.test(e.id) || typeof e.profileId !== 'string' || !e.profileId) continue;
    if (e.source !== 'store' && e.source !== 'unpacked') continue;
    if (typeof e.path !== 'string' || !e.path || typeof e.version !== 'string' || !e.version) continue;
    out[extensionKey(e.profileId, e.id)] = {
      id: e.id,
      profileId: e.profileId,
      name: typeof e.name === 'string' ? e.name : e.id,
      version: e.version,
      source: e.source,
      path: e.path,
      notifiedVersion: typeof e.notifiedVersion === 'string' ? e.notifiedVersion : null,
      pinned: e.pinned !== false,
      installedAt: Number.isFinite(e.installedAt) ? e.installedAt : 0,
      updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
    };
  }
  return out;
}

const PERMISSIONS: readonly SitePermission[] = ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'];

function restorePermissions(saved: SitePermissions | undefined): SitePermissions {
  const out: SitePermissions = {};
  for (const [origin, decisions] of Object.entries(saved ?? {})) {
    for (const permission of PERMISSIONS) {
      const decision = decisions[permission];
      if (decision === 'allow' || decision === 'block') (out[origin] ??= {})[permission] = decision;
    }
  }
  return out;
}

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isOklch = (v: unknown): v is Oklch => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Oklch;
  return isUnit(o.l) && typeof o.c === 'number' && o.c >= 0 && o.c <= 0.4 && typeof o.h === 'number' && o.h >= 0 && o.h <= 360;
};

/** Saved custom themes that still make sense (1–3 valid colors, a name, an id). */
export function validTheme(v: unknown): CustomTheme | null {
  const t = v as Partial<CustomTheme> | null;
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || !Array.isArray(t.stops)) return null;
  if (t.stops.length < 1 || t.stops.length > 3 || !t.stops.every(isOklch) || !isUnit(t.grain)) return null;
  return { id: t.id, name: t.name.slice(0, 40), stops: t.stops.map((s) => ({ l: s.l, c: s.c, h: s.h })), grain: t.grain };
}

function restoreSettings(saved: Record<string, unknown>, platform?: Platform): Settings {
  const settings = defaultSettings();
  settings.shortcuts = cleanOverrides(saved['shortcuts'], platform);
  const scheme = saved['colorScheme'];
  if (scheme === 'system' || scheme === 'light' || scheme === 'dark') settings.colorScheme = scheme;
  const ui = saved['interface'] as Record<string, unknown> | undefined;
  if (ui && typeof ui === 'object') {
    if (isUnit(ui['contrast'])) settings.interface.contrast = ui['contrast'];
    if (isUnit(ui['glass'])) settings.interface.glass = ui['glass'];
  }
  const buttons = saved['extensionButtons'];
  if (buttons === 'sidebar' || buttons === 'titleBar') settings.extensionButtons = buttons;
  if (Array.isArray(saved['themes'])) settings.themes = saved['themes'].map(validTheme).filter((t): t is CustomTheme => t !== null);
  if (typeof saved['separateSignIns'] === 'boolean') settings.separateSignIns = saved['separateSignIns'];
  if (typeof saved['onboarded'] === 'boolean') settings.onboarded = saved['onboarded'];
  const archiveAfter = saved['archiveAfter'];
  if (typeof archiveAfter === 'string' && archiveAfter in ARCHIVE_AFTER_MS) settings.archiveAfter = archiveAfter as ArchiveAfter;
  if (typeof saved['sleepTabs'] === 'boolean') settings.sleepTabs = saved['sleepTabs'];
  for (const key of ['searchSuggestions', 'checkForUpdates'] as const) {
    if (typeof saved[key] === 'boolean') settings[key] = saved[key];
  }
  if (typeof saved['autoPip'] === 'boolean') settings.autoPip = saved['autoPip'];
  if (saved['externalLinks'] === 'mini' || saved['externalLinks'] === 'tab') settings.externalLinks = saved['externalLinks'];
  settings.miniWindowSize = restoreMiniSize(saved['miniWindowSize']);
  if (typeof saved['pagePreviews'] === 'boolean') settings.pagePreviews = saved['pagePreviews'];
  if (isUiScale(saved['uiScale'])) settings.uiScale = saved['uiScale'];
  const spellcheck = saved['spellcheck'] as Record<string, unknown> | undefined;
  if (spellcheck && typeof spellcheck === 'object') {
    if (typeof spellcheck['enabled'] === 'boolean') settings.spellcheck.enabled = spellcheck['enabled'];
    const language = spellcheck['language'];
    if (typeof language === 'string' && isLanguageCode(language)) settings.spellcheck.language = language;
  }
  const engine = saved['searchEngine'];
  if (typeof engine === 'string' && SEARCH_ENGINES.some((e) => e.id === engine)) settings.searchEngine = engine as Settings['searchEngine'];
  if (typeof saved['googleFree'] === 'boolean') settings.googleFree = saved['googleFree'];
  if (settings.googleFree && settings.searchEngine === 'google') settings.searchEngine = GOOGLE_FREE_ENGINE;
  // A profile saved before Safe Browsing existed never saw its notice: it stays off, and is offered once.
  if (typeof saved['safeBrowsingAsked'] === 'boolean') settings.safeBrowsingAsked = saved['safeBrowsingAsked'];
  if (typeof saved['safeBrowsing'] === 'boolean') settings.safeBrowsing = saved['safeBrowsing'] && settings.safeBrowsingAsked && !settings.googleFree;
  const motion = saved['motion'];
  if (motion && typeof motion === 'object') {
    for (const key of Object.keys(settings.motion) as (keyof MotionSettings)[]) {
      const value = (motion as Record<string, unknown>)[key];
      if (typeof value === 'boolean') settings.motion[key] = value;
    }
  }
  const duet = saved['duet'] as Record<string, unknown> | undefined;
  if (duet && typeof duet === 'object') {
    if (typeof duet['enabled'] === 'boolean') settings.duet.enabled = duet['enabled'];
    if (duet['provider'] === 'claude' || duet['provider'] === 'codex') settings.duet.provider = duet['provider'];
    if (typeof duet['model'] === 'string' && duet['model'].length <= 100) settings.duet.model = duet['model'];
    if (duet['keep'] === 'forever' || duet['keep'] === '90d' || duet['keep'] === '30d') settings.duet.keep = duet['keep'];
    if (duet['scope'] === 'ask' || duet['scope'] === 'chord' || duet['scope'] === 'all') settings.duet.scope = duet['scope'];
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 300).slice(0, 500) : []);
    settings.duet.neverSites = strings(duet['neverSites']);
    settings.duet.offChords = strings(duet['offChords']);
  }
  return settings;
}

/**
 * The state to start with: the saved one, repaired, or a fresh seed when
 * nothing usable was saved. `seed` supplies ids, time, the home page and the
 * first chord's theme for that case.
 */
export function restoreState(saved: PersistedState | null, seed: SeedOptions): State {
  if (!saved || !saved.chords.some((c) => !c.private)) {
    const fresh = seedState(seed);
    if (saved) {
      fresh.settings = restoreSettings(saved.settings, seed.platform);
      fresh.sitePermissions = restorePermissions(saved.sitePermissions);
      fresh.downloads = restoreDownloads(saved.downloads);
      fresh.favorites = restoreFavorites(saved.favorites);
      fresh.extensions = restoreExtensions(saved.extensions);
      fresh.siteZoom = restoreZoom(saved.siteZoom);
    }
    // No chords yet: first run, unless onboarding already finished once (or --no-first-run).
    if (seed.firstRun && saved?.settings['onboarded'] !== true) fresh.settings.onboarded = false;
    return fresh;
  }

  const state = emptyState();
  state.settings = restoreSettings(saved.settings, seed.platform);
  state.sitePermissions = restorePermissions(saved.sitePermissions);
  state.downloads = restoreDownloads(saved.downloads);
  state.favorites = restoreFavorites(saved.favorites);
  state.extensions = restoreExtensions(saved.extensions);
  state.siteZoom = restoreZoom(saved.siteZoom);
  // A private window's chord is never saved; if one ever were, it doesn't come back.
  for (const chord of saved.chords) if (!chord.private) state.chords[chord.id] = chord;
  state.linkRoutes = restoreRoutes(saved.linkRoutes, state.chords);
  for (const node of saved.nodes) {
    if (!state.chords[node.chordId]) continue;
    state.nodes[node.id] = { ...node };
  }
  // Children whose folder (or split) is gone move to the section root rather than vanish.
  for (const node of Object.values(state.nodes)) {
    if (node.parentId && !state.nodes[node.parentId]) node.parentId = null;
  }
  // Splits come back whole: two to four panes, sizes that match (split.ts).
  for (const node of Object.values(state.nodes)) {
    if (node.kind === 'split') node.sizes = Array.isArray(node.sizes) ? node.sizes.filter((s) => typeof s === 'number') : [];
  }
  settleSplits(state);
  // No live entries: every tab starts unloaded, and gets one when its page starts loading.

  const firstChord = sortedChords(state)[0]!;
  // A tab shows in one window at a time; if saved windows disagree, the first keeps it.
  const shown = new Set<string>();
  for (const win of saved.windows) {
    if (win.private) continue;
    const activeChordId = state.chords[win.activeChordId] ? win.activeChordId : firstChord.id;
    const activeTab: WindowModel['activeTab'] = {};
    for (const [chordId, tabId] of Object.entries(win.activeTab)) {
      if (!state.chords[chordId]) continue;
      activeTab[chordId] = tabId && state.nodes[tabId]?.kind === 'tab' && state.nodes[tabId]?.chordId === chordId ? tabId : null;
    }
    // A split shows all its panes, so it's the whole group that one window keeps.
    const showing = activeTab[activeChordId];
    const group = showing ? shownWith(state, showing) : [];
    if (group.some((id) => shown.has(id))) activeTab[activeChordId] = null;
    else for (const id of group) shown.add(id);
    activeTab[activeChordId] ??= null;
    const width = win.sidebarWidth;
    const sidebarWidth = typeof width === 'number' && width >= SIDEBAR_WIDTH.min && width <= SIDEBAR_WIDTH.max ? width : SIDEBAR_WIDTH.default;
    state.windows[win.id] = { ...win, activeChordId, activeTab, sidebarWidth };
  }
  if (Object.keys(state.windows).length === 0) {
    const id = seed.newId();
    state.windows[id] = { id, activeChordId: firstChord.id, activeTab: { [firstChord.id]: null }, sidebar: 'docked', sidebarWidth: SIDEBAR_WIDTH.default, bounds: null };
  }
  return state;
}
