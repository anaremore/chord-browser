/** The state of a brand-new profile: one chord, one window, one tab. */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { IDLE_LIVE, SIDEBAR_WIDTH, emptyState, type ChordId, type ChordThemeSpec, type State } from './model';
import { children } from './select';
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

/**
 * Performance runs only (development builds, `CHORD_PERF_TABS`): `pages` as
 * Today tabs below the chord's others, in order. None is loaded until it's
 * opened, like tabs restored at launch, so a few hundred cost no page views.
 */
export function addSleepingTabs(
  state: State,
  chordId: ChordId,
  pages: readonly { url: string; title: string }[],
  { now, newId }: Pick<SeedOptions, 'now' | 'newId'>,
): void {
  const last = children(state, chordId, 'today', null).at(-1);
  const ranks = generateNKeysBetween(last?.rank ?? null, null, pages.length);
  pages.forEach((page, i) => {
    const id = newId();
    // A minute apart, newest first: recent enough that none is archived for being idle.
    const at = now - (i + 1) * 60_000;
    state.nodes[id] = {
      kind: 'tab',
      id,
      chordId,
      section: 'today',
      parentId: null,
      rank: ranks[i]!,
      url: page.url,
      title: page.title,
      pinnedUrl: null,
      customTitle: null,
      favicon: null,
      lastActiveAt: at,
      createdAt: at,
    };
  });
}
