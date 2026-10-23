import { describe, expect, it } from 'vitest';
import { ARCHIVE_AFTER_MS, archiveCandidates, emptyState, sleepCandidates, visibleTabs, type State, type TabNode } from '../src';

const HOUR = 3_600_000;
const now = 100 * 24 * HOUR;

function tab(id: string, section: TabNode['section'], idleFor: number, chordId = 'c1'): TabNode {
  return {
    kind: 'tab',
    id,
    chordId,
    section,
    parentId: null,
    rank: id,
    url: `https://${id}.test/`,
    title: id,
    pinnedUrl: section === 'pinned' ? `https://${id}.test/` : null,
    customTitle: null,
    favicon: null,
    lastActiveAt: now - idleFor,
    createdAt: 0,
  };
}

function state(tabs: TabNode[], shown: Record<string, string | null> = {}): State {
  const s = emptyState();
  for (const t of tabs) s.nodes[t.id] = t;
  s.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null, ...shown }, sidebar: 'docked', bounds: null };
  return s;
}

describe('auto-archive', () => {
  const after = ARCHIVE_AFTER_MS['12h']!;

  it('takes Today tabs unused longer than the setting, oldest first', () => {
    const s = state([tab('fresh', 'today', HOUR), tab('old', 'today', 13 * HOUR), tab('older', 'today', 40 * HOUR)]);
    expect(archiveCandidates(s, now, after)).toEqual(['older', 'old']);
  });

  it('never takes pinned tabs, tabs on screen, or busy tabs', () => {
    const s = state([tab('pinned', 'pinned', 99 * HOUR), tab('shown', 'today', 99 * HOUR), tab('playing', 'today', 99 * HOUR), tab('idle', 'today', 99 * HOUR)], {
      c1: 'shown',
    });
    expect(archiveCandidates(s, now, after, new Set(['playing']))).toEqual(['idle']);
  });

  it('a tab another chord last showed is still idle: only what is on screen counts', () => {
    const s = state([tab('elsewhere', 'today', 99 * HOUR, 'c2')], { c2: 'elsewhere' });
    expect(visibleTabs(s).has('elsewhere')).toBe(false);
    expect(archiveCandidates(s, now, after)).toEqual(['elsewhere']);
  });

  it('archives nothing when set to never', () => {
    expect(archiveCandidates(state([tab('old', 'today', 999 * HOUR)]), now, ARCHIVE_AFTER_MS.never)).toEqual([]);
  });
});

describe('sleeping tabs', () => {
  it('sleeps loaded tabs, pinned or not, hidden long enough, but not busy or shown ones', () => {
    const s = state(
      [tab('pinned', 'pinned', 2 * HOUR), tab('today', 'today', 2 * HOUR), tab('recent', 'today', 10 * 60_000), tab('busy', 'today', 2 * HOUR), tab('shown', 'today', 2 * HOUR)],
      { c1: 'shown' },
    );
    const loaded = ['pinned', 'today', 'recent', 'busy', 'shown'];
    expect(sleepCandidates(s, now, HOUR, loaded, new Set(['busy'])).sort()).toEqual(['pinned', 'today']);
  });

  it('only considers tabs that are loaded', () => {
    const s = state([tab('asleep', 'today', 5 * HOUR)]);
    expect(sleepCandidates(s, now, HOUR, [])).toEqual([]);
  });
});
