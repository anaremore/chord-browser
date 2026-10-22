/**
 * Rebuilding state from what chord-data saved (ARCHITECTURE.md §6.2). Saved
 * data can be old, partial or inconsistent (a crash mid-write, a newer build
 * downgraded), so this repairs rather than trusts: references to missing
 * chords or tabs are dropped, settings fill in from defaults, and there is
 * always at least one chord and one window.
 */
import {
  DEFAULT_SETTINGS,
  emptyState,
  type Chord,
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

function restoreSettings(saved: Record<string, unknown>): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS, motion: { ...DEFAULT_SETTINGS.motion } };
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
    }
    return fresh;
  }

  const state = emptyState();
  state.settings = restoreSettings(saved.settings);
  state.sitePermissions = restorePermissions(saved.sitePermissions);
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
