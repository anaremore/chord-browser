/**
 * Rebuilding state from what chord-data saved (ARCHITECTURE.md §6.2). Saved
 * data can be old, partial or inconsistent (a crash mid-write, a newer build
 * downgraded), so this repairs rather than trusts: references to missing
 * chords or tabs are dropped, settings fill in from defaults, and there is
 * always at least one chord and one window.
 */
import {
  defaultSettings,
  emptyState,
  type Chord,
  type CustomTheme,
  type Oklch,
  type Download,
  type MotionSettings,
  type Settings,
  type SidebarNode,
  type SitePermission,
  type SitePermissions,
  type State,
  type WindowModel,
} from './model';
import { SEARCH_ENGINES } from './input';
import { seedState, type SeedOptions } from './seed';
import { sortedChords } from './select';

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

function restoreSettings(saved: Record<string, unknown>): Settings {
  const settings = defaultSettings();
  const scheme = saved['colorScheme'];
  if (scheme === 'system' || scheme === 'light' || scheme === 'dark') settings.colorScheme = scheme;
  const ui = saved['interface'] as Record<string, unknown> | undefined;
  if (ui && typeof ui === 'object') {
    if (isUnit(ui['contrast'])) settings.interface.contrast = ui['contrast'];
    if (isUnit(ui['glass'])) settings.interface.glass = ui['glass'];
  }
  if (Array.isArray(saved['themes'])) settings.themes = saved['themes'].map(validTheme).filter((t): t is CustomTheme => t !== null);
  if (typeof saved['separateSignIns'] === 'boolean') settings.separateSignIns = saved['separateSignIns'];
  const engine = saved['searchEngine'];
  if (typeof engine === 'string' && SEARCH_ENGINES.some((e) => e.id === engine)) settings.searchEngine = engine as Settings['searchEngine'];
  const motion = saved['motion'];
  if (motion && typeof motion === 'object') {
    for (const key of Object.keys(settings.motion) as (keyof MotionSettings)[]) {
      const value = (motion as Record<string, unknown>)[key];
      if (typeof value === 'boolean') settings.motion[key] = value;
    }
  }
  return settings;
}

/**
 * The state to start with: the saved one, repaired, or a fresh seed when
 * nothing usable was saved. `seed` supplies ids, time, the home page and the
 * first chord's theme for that case.
 */
export function restoreState(saved: PersistedState | null, seed: SeedOptions): State {
  if (!saved || saved.chords.length === 0) {
    const fresh = seedState(seed);
    if (saved) {
      fresh.settings = restoreSettings(saved.settings);
      fresh.sitePermissions = restorePermissions(saved.sitePermissions);
      fresh.downloads = restoreDownloads(saved.downloads);
    }
    return fresh;
  }

  const state = emptyState();
  state.settings = restoreSettings(saved.settings);
  state.sitePermissions = restorePermissions(saved.sitePermissions);
  state.downloads = restoreDownloads(saved.downloads);
  for (const chord of saved.chords) state.chords[chord.id] = chord;
  for (const node of saved.nodes) {
    if (!state.chords[node.chordId]) continue;
    state.nodes[node.id] = { ...node };
  }
  // Children whose folder is gone move to the section root rather than vanish.
  for (const node of Object.values(state.nodes)) {
    if (node.parentId && !state.nodes[node.parentId]) node.parentId = null;
  }
  // No live entries: every tab starts unloaded, and gets one when its page starts loading.

  const firstChord = sortedChords(state)[0]!;
  for (const win of saved.windows) {
    const activeChordId = state.chords[win.activeChordId] ? win.activeChordId : firstChord.id;
    const activeTab: WindowModel['activeTab'] = {};
    for (const [chordId, tabId] of Object.entries(win.activeTab)) {
      if (!state.chords[chordId]) continue;
      activeTab[chordId] = tabId && state.nodes[tabId]?.kind === 'tab' && state.nodes[tabId]?.chordId === chordId ? tabId : null;
    }
    activeTab[activeChordId] ??= null;
    state.windows[win.id] = { ...win, activeChordId, activeTab };
  }
  if (Object.keys(state.windows).length === 0) {
    const id = seed.newId();
    state.windows[id] = { id, activeChordId: firstChord.id, activeTab: { [firstChord.id]: null }, sidebar: 'docked', bounds: null };
  }
  return state;
}
