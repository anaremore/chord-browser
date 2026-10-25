import { describe, expect, it } from 'vitest';
import { apply, emptyState, restoreState, shareableTabs, type Command, type Context, type State, type TabNode } from '../src';

function setup() {
  let n = 0;
  let now = 1000;
  const ctx: Context = {
    get now() {
      return now++;
    },
    newId: () => `id-${++n}`,
  };
  let state: State = emptyState();
  const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['c2'] = { id: 'c2', profileId: 'p-work', name: 'Work', icon: '♪', theme, rank: 'b0', createdAt: 0 };
  state.chords['p'] = { id: 'p', profileId: 'private-w2', name: 'Private', icon: '', theme, rank: 'z', createdAt: 0, private: true };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.windows['w2'] = { id: 'w2', activeChordId: 'p', activeTab: { p: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null, private: true };
  const run = (command: Command) => (state = apply(state, command, ctx).state);
  const open = (windowId: string, chordId: string, url: string) => {
    if (state.windows[windowId]!.activeChordId !== chordId) run({ t: 'chord.activate', windowId, chordId });
    run({ t: 'tab.open', windowId, url });
    return state.windows[windowId]!.activeTab[chordId]!;
  };
  const meet = open('w1', 'c1', 'https://meet.test/');
  const slides = open('w1', 'c1', 'https://slides.test/');
  const archive = open('w1', 'c1', 'chord://archive/');
  const sheet = open('w1', 'c2', 'https://sheet.test/');
  const asleep = open('w1', 'c2', 'https://asleep.test/');
  const secret = open('w2', 'p', 'https://secret.test/');
  const call = open('w2', 'p', 'https://call.test/');
  return { state: () => state, run, meet, slides, archive, sheet, asleep, secret, call };
}

const ids = (tabs: TabNode[]) => tabs.map((t) => t.id);

describe('which tabs a page may share', () => {
  it('the asking tab first, then the most recently used web pages with a page, in every chord; never Chord’s own', () => {
    const t = setup();
    const loaded = [t.meet, t.slides, t.archive, t.sheet, t.secret, t.call];
    // The asleep tab has no page to share, and the archive is Chord's own page.
    expect(ids(shareableTabs(t.state(), t.meet, loaded))).toEqual([t.meet, t.sheet, t.slides]);
  });

  it('a private window’s page sees only its own window’s tabs, and no other page ever sees them', () => {
    const t = setup();
    const loaded = [t.meet, t.slides, t.sheet, t.secret, t.call];
    expect(ids(shareableTabs(t.state(), t.call, loaded))).toEqual([t.call, t.secret]);
    expect(ids(shareableTabs(t.state(), t.slides, loaded))).not.toContain(t.secret);
  });

  it('nothing for a page that isn’t a tab', () => {
    const t = setup();
    expect(shareableTabs(t.state(), 'peek-page', [t.meet])).toEqual([]);
  });
});

describe('presenting mode', () => {
  it('a share starts it and the last one ends it, unless you turned it on yourself', () => {
    const t = setup();
    t.run({ t: 'presenting.set', on: true, by: 'share' });
    expect(t.state().presenting).toBe('share');
    t.run({ t: 'presenting.set', on: false, by: 'share' });
    expect(t.state().presenting).toBeNull();

    t.run({ t: 'presenting.set', on: true, by: 'you' });
    t.run({ t: 'presenting.set', on: true, by: 'share' });
    t.run({ t: 'presenting.set', on: false, by: 'share' });
    expect(t.state().presenting).toBe('you');
  });

  it('turned off while sharing, it stays off until a share starts again', () => {
    const t = setup();
    t.run({ t: 'presenting.set', on: true, by: 'share' });
    t.run({ t: 'presenting.set', on: false, by: 'you' });
    expect(t.state().presenting).toBeNull();
    t.run({ t: 'presenting.set', on: false, by: 'share' });
    expect(t.state().presenting).toBeNull();
    t.run({ t: 'presenting.set', on: true, by: 'share' });
    expect(t.state().presenting).toBe('share');
  });

  it('is never saved, nor are the windows being shared', () => {
    const t = setup();
    const result = apply(t.state(), { t: 'presenting.set', on: true, by: 'you' }, { now: 1, newId: () => 'x' });
    expect(result.patches.map((p) => p.path[0])).toEqual(['presenting', 'version']);
    const restored = restoreState(null, { now: 1, newId: () => 'x', theme: t.state().chords['c1']!.theme, homeUrl: 'https://home.test/', firstRun: false, platform: 'linux' });
    expect(restored.presenting).toBeNull();
    expect(restored.sharedWindows).toEqual([]);
  });

  it('collapsing the sidebar while presenting is a setting, off to start with', () => {
    const t = setup();
    expect(t.state().settings.presentingHidesSidebar).toBe(false);
    t.run({ t: 'settings.set', settings: { presentingHidesSidebar: true } });
    expect(t.state().settings.presentingHidesSidebar).toBe(true);
    const restored = restoreState(
      { chords: [], nodes: [], windows: [], settings: { presentingHidesSidebar: true }, sitePermissions: {}, downloads: [], favorites: [], extensions: [], siteZoom: {}, linkRoutes: [] },
      { now: 1, newId: () => 'x', theme: t.state().chords['c1']!.theme, homeUrl: 'https://home.test/', firstRun: false, platform: 'linux' },
    );
    expect(restored.settings.presentingHidesSidebar).toBe(true);
  });
});

describe('the windows being shared', () => {
  it('only windows that exist, once each, and a closed window leaves the list', () => {
    const t = setup();
    t.run({ t: 'sharing.windows', windowIds: ['w2', 'w1', 'w1', 'gone'] });
    expect(t.state().sharedWindows).toEqual(['w1', 'w2']);
    t.run({ t: 'window.close', windowId: 'w2' });
    expect(t.state().sharedWindows).toEqual(['w1']);
  });

  it('the same list again changes nothing', () => {
    const t = setup();
    t.run({ t: 'sharing.windows', windowIds: ['w1'] });
    expect(apply(t.state(), { t: 'sharing.windows', windowIds: ['w1'] }, { now: 1, newId: () => 'x' }).patches).toEqual([]);
  });
});
