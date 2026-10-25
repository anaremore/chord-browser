import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, restoreState, type Chord, type PersistedState, type SeedOptions, type TabNode, type WindowModel } from '../src';

let n = 0;
const seed: SeedOptions = {
  now: 1000,
  newId: () => `new-${++n}`,
  theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' },
  homeUrl: 'https://home.test/',
};

const chord = (id: string, rank: string): Chord => ({
  id,
  profileId: 'default',
  name: id,
  icon: '✦',
  theme: seed.theme,
  rank,
  createdAt: 0,
});

const tab = (id: string, chordId: string, parentId: string | null = null): TabNode => ({
  kind: 'tab',
  id,
  chordId,
  section: 'today',
  parentId,
  rank: 'a0',
  url: `https://${id}.test/`,
  title: id,
  pinnedUrl: null,
  customTitle: null,
  favicon: null,
  lastActiveAt: 0,
  createdAt: 0,
});

const win = (id: string, activeChordId: string, activeTab: WindowModel['activeTab']): WindowModel => ({
  id,
  activeChordId,
  activeTab,
  sidebar: 'collapsed',
  sidebarWidth: 300,
  bounds: { x: 10, y: 20, width: 900, height: 700, maximized: false },
});

describe('restoreState', () => {
  it('seeds a fresh profile when nothing was saved', () => {
    const state = restoreState(null, seed);
    expect(Object.values(state.chords)).toHaveLength(1);
    expect(Object.values(state.nodes).map((t) => (t as TabNode).url)).toEqual(['https://home.test/']);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('auto picture-in-picture: off for a new profile; a profile from before is marked for its one-time switch-off; a choice made after stays', () => {
    expect(restoreState(null, seed).settings).toMatchObject({ autoPip: false, autoPipDefaultOff: true });
    const before: PersistedState = { chords: [], nodes: [], windows: [], settings: { autoPip: true } };
    // Main sees the mark missing and switches it off once, through the store, so it's saved (index.ts).
    expect(restoreState(before, seed).settings).toMatchObject({ autoPip: true, autoPipDefaultOff: false });
    const after: PersistedState = { chords: [], nodes: [], windows: [], settings: { autoPip: true, autoPipDefaultOff: true } };
    expect(restoreState(after, seed).settings).toMatchObject({ autoPip: true, autoPipDefaultOff: true });
  });

  it('what Duet can read: Nothing and every scope come back as saved; anything else is the default', () => {
    const duet = (saved: Record<string, unknown>) => restoreState({ chords: [], nodes: [], windows: [], settings: { duet: saved } }, seed).settings.duet;
    expect(duet({ readsNothing: true, scope: 'every' })).toMatchObject({ readsNothing: true, scope: 'every' });
    expect(duet({ scope: 'all' })).toMatchObject({ readsNothing: false, scope: 'all' });
    expect(duet({ readsNothing: 'yes', scope: 'nothing' })).toMatchObject({ readsNothing: false, scope: DEFAULT_SETTINGS.duet.scope });
  });

  it('brings back chords, tabs, windows and settings as saved, with idle engine state', () => {
    const saved: PersistedState = {
      chords: [chord('c1', 'a0')],
      nodes: [tab('t1', 'c1'), tab('t2', 'c1')],
      windows: [win('w1', 'c1', { c1: 't2' })],
      settings: { searchEngine: 'kagi', motion: { sidebar: false }, searchSuggestions: false, checkForUpdates: false },
    };
    const state = restoreState(saved, seed);
    expect(Object.keys(state.nodes)).toEqual(['t1', 't2']);
    expect(state.settings).toMatchObject({ searchSuggestions: false, checkForUpdates: false });
    expect(state.windows['w1']).toMatchObject({ activeChordId: 'c1', activeTab: { c1: 't2' }, sidebar: 'collapsed', bounds: { x: 10 } });
    expect(state.live).toEqual({}); // every tab starts unloaded
    expect(state.settings.searchEngine).toBe('kagi');
    expect(state.settings.motion).toEqual({ ...DEFAULT_SETTINGS.motion, sidebar: false });
    expect(state.version).toBe(0);
    expect(state.closed).toEqual([]);
  });

  it('repairs dangling references instead of trusting them', () => {
    const saved: PersistedState = {
      chords: [chord('c1', 'a1'), chord('c0', 'a0')],
      nodes: [tab('orphan', 'gone'), tab('child', 'c1', 'missing-folder'), tab('t1', 'c1')],
      windows: [win('w1', 'gone', { gone: 't1', c1: 'orphan' })],
      settings: { searchEngine: 'evil', motion: { sidebar: 'yes' }, searchSuggestions: 'no', unknown: 1 },
    };
    const state = restoreState(saved, seed);
    expect(state.nodes['orphan']).toBeUndefined();
    expect(state.nodes['child']!.parentId).toBeNull();
    // The active chord falls back to the first by rank; tabs from other chords don't stay active.
    expect(state.windows['w1']).toMatchObject({ activeChordId: 'c0', activeTab: { c1: null, c0: null } });
    // A saved profile without the mark gets auto picture-in-picture's one-time switch-off (index.ts).
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, autoPipDefaultOff: false });
  });

  it('restores Google-free mode, and never with Google as its engine', () => {
    const restored = (settings: Record<string, unknown>) => restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings }, seed).settings;
    expect(restored({ googleFree: true, searchEngine: 'brave' })).toMatchObject({ googleFree: true, searchEngine: 'brave' });
    expect(restored({ googleFree: true, searchEngine: 'google' })).toMatchObject({ googleFree: true, searchEngine: 'duckduckgo' });
    expect(restored({ googleFree: 'yes' })).toMatchObject({ googleFree: false, searchEngine: 'google' });
  });

  it('restores Safe Browsing only as it was answered, and never in Google-free mode', () => {
    const restored = (settings: Record<string, unknown>) => restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings }, seed).settings;
    // A profile from before Safe Browsing never saw its notice: off, and still to be offered.
    expect(restored({})).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: false });
    expect(restored({ safeBrowsing: true, safeBrowsingAsked: true })).toMatchObject({ safeBrowsing: true, safeBrowsingAsked: true });
    expect(restored({ safeBrowsing: false, safeBrowsingAsked: true })).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: true });
    // On without its notice answered can't be: it stays off.
    expect(restored({ safeBrowsing: true })).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: false });
    expect(restored({ safeBrowsing: true, safeBrowsingAsked: true, googleFree: true })).toMatchObject({ safeBrowsing: false, googleFree: true });
  });

  it('restores ad blocking, on for profiles from before it existed, with only real sites off', () => {
    const restored = (settings: Record<string, unknown>) => restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings }, seed).settings;
    expect(restored({}).adBlocking).toEqual({ enabled: true, offSites: [] });
    expect(restored({ adBlocking: { enabled: false, offSites: ['example.com', 'www.example.org', 42, '%%%'] } }).adBlocking).toEqual({ enabled: false, offSites: ['example.com', 'example.org'] });
    expect(restored({ adBlocking: { enabled: 'no' } }).adBlocking.enabled).toBe(true);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['on for a new profile, and for one saved before the setting', {}, true],
    ['off as saved', { sidebarPeek: false }, false],
    ['on as saved', { sidebarPeek: true }, true],
    ['anything but a boolean: on', { sidebarPeek: 'no' }, true],
  ])('restores minimal mode’s peek on pointing: %s', (_name, settings, expected) => {
    expect(restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings }, seed).settings.sidebarPeek).toBe(expected);
  });

  it('restores the interface size only as one of its sizes', () => {
    const restored = (settings: Record<string, unknown>) => restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings }, seed).settings;
    expect(restored({ uiScale: 1.5 }).uiScale).toBe(1.5);
    expect(restored({ uiScale: 4 }).uiScale).toBe(1);
    expect(restored({}).uiScale).toBe(1);
  });

  it('always has a window to open', () => {
    const state = restoreState({ chords: [chord('c1', 'a0')], nodes: [], windows: [], settings: {} }, seed);
    const [only] = Object.values(state.windows);
    expect(only).toMatchObject({ activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked' });
  });

  it('keeps page zoom per site and spelling settings that make sense, and drops the rest', () => {
    const saved: PersistedState = {
      chords: [chord('c1', 'a0')],
      nodes: [],
      windows: [],
      settings: { spellcheck: { enabled: false, language: 'pt-BR' } },
      siteZoom: { 'a.test': 1.25, 'b.test': 9, 'c.test': 1, '': 1.5, 'd.test:8080': 0.5 },
    };
    const state = restoreState(saved, seed);
    expect(state.siteZoom).toEqual({ 'a.test': 1.25, 'd.test:8080': 0.5 });
    expect(state.settings.spellcheck).toEqual({ enabled: false, language: 'pt-BR' });
    const bad = restoreState({ ...saved, settings: { spellcheck: { enabled: 'yes', language: 'not a language!' } } }, seed);
    expect(bad.settings.spellcheck).toEqual(DEFAULT_SETTINGS.spellcheck);
  });
});
