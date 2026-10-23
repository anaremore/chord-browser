/** The state of a brand-new profile: one chord, one window, one tab. */
import { generateKeyBetween } from 'fractional-indexing';
import { IDLE_LIVE, SIDEBAR_WIDTH, emptyState, type ChordThemeSpec, type State } from './model';
import type { Platform } from './shortcuts';

export interface SeedOptions {
  now: number;
  newId: () => string;
  theme: ChordThemeSpec;
  homeUrl: string;
  /** A brand-new profile starts in first-run onboarding (DESIGN.md §8.1); `--no-first-run` skips it. */
  firstRun?: boolean;
  /** This OS, so saved shortcut changes it keeps for itself are dropped. */
  platform?: Platform;
}

export function seedState({ now, newId, theme, homeUrl }: SeedOptions): State {
  const state = emptyState();
  const chordId = newId();
  const windowId = newId();
  const tabId = newId();
  state.chords[chordId] = { id: chordId, profileId: 'default', name: 'Personal', icon: '✦', theme, rank: generateKeyBetween(null, null), createdAt: now };
  state.nodes[tabId] = {
    kind: 'tab',
    id: tabId,
    chordId,
    section: 'today',
    parentId: null,
    rank: generateKeyBetween(null, null),
    url: homeUrl,
    title: '',
    pinnedUrl: null,
    customTitle: null,
    favicon: null,
    lastActiveAt: now,
    createdAt: now,
  };
  state.live[tabId] = { ...IDLE_LIVE, loading: true };
  state.windows[windowId] = { id: windowId, activeChordId: chordId, activeTab: { [chordId]: tabId }, sidebar: 'docked', sidebarWidth: SIDEBAR_WIDTH.default, bounds: null };
  return state;
}
