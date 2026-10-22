/** The state of a brand-new profile: one chord, one window, one tab. */
import { generateKeyBetween } from 'fractional-indexing';
import { IDLE_LIVE, emptyState, type ChordThemeSpec, type State } from './model';

export interface SeedOptions {
  now: number;
  newId: () => string;
  theme: ChordThemeSpec;
  homeUrl: string;
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
  state.windows[windowId] = { id: windowId, activeChordId: chordId, activeTab: { [chordId]: tabId }, sidebar: 'docked', bounds: null };
  return state;
}
