import { describe, expect, it } from 'vitest';
import { addSleepingTabs, children, seedState, type SeedOptions, type TabNode } from '../src';

let n = 0;
const seed: SeedOptions = {
  now: 10_000_000,
  newId: () => `id-${++n}`,
  theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' },
  homeUrl: 'https://home.test/',
};

describe('addSleepingTabs (performance runs)', () => {
  it('adds the pages below the chord’s tabs, in order, none of them loaded', () => {
    const state = seedState(seed);
    const chordId = Object.keys(state.chords)[0]!;
    const pages = Array.from({ length: 200 }, (_, i) => ({ url: `https://site.test/${i}`, title: `Page ${i}` }));
    addSleepingTabs(state, chordId, pages, seed);

    const today = children(state, chordId, 'today', null) as TabNode[];
    expect(today).toHaveLength(201);
    expect(today[0]!.url).toBe('https://home.test/');
    expect(today.slice(1).map((t) => t.title)).toEqual(pages.map((p) => p.title));
    // Only the home tab is live; the rest wait to be opened.
    expect(Object.keys(state.live)).toEqual([today[0]!.id]);
    // Newest first, and none older than auto-archive would allow on its shortest setting (12 hours).
    expect(today[1]!.lastActiveAt).toBeGreaterThan(today[200]!.lastActiveAt);
    expect(seed.now - today[200]!.lastActiveAt).toBeLessThan(12 * 3600_000);
  });
});
