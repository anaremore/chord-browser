import { describe, expect, it } from 'vitest';
import {
  apply,
  chordsFor,
  restoreState,
  downloadsFor,
  emptyState,
  isPrivateProfile,
  profilePartition,
  sortedChords,
  tabsInOrder,
  type Command,
  type Context,
  type Download,
  type State,
  type TabNode,
} from '../src';

/** Two chords and one window; ids come out as id-001, id-002, … */
function setup() {
  let n = 0;
  let now = 1_000;
  const ctx: Context = {
    get now() {
      return now++;
    },
    newId: () => `id-${String(++n).padStart(3, '0')}`,
  };
  let state: State = emptyState();
  const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['c2'] = { id: 'c2', profileId: 'default', name: 'Work', icon: '♪', theme, rank: 'a1', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', bounds: { x: 100, y: 80, width: 1200, height: 800, maximized: false } };
  const run = (cmd: Command) => {
    const result = apply(state, cmd, ctx);
    state = result.state;
    return result;
  };
  return {
    get state() {
      return state;
    },
    run,
  };
}

const tabsInOrderIds = (state: State) => tabsInOrder(state, 'c1').map((t) => t.id);

const shows = (state: State, windowId: string) => {
  const w = state.windows[windowId]!;
  return w.activeTab[w.activeChordId] ?? null;
};

describe('windows', () => {
  it('a new window starts on the chord you are in, showing nothing, cascaded from the old one', () => {
    const t = setup();
    t.run({ t: 'chord.activate', windowId: 'w1', chordId: 'c2' });
    const result = t.run({ t: 'window.create', windowId: 'w2', from: 'w1' });
    expect(result.effects).toEqual([{ e: 'window.open', windowId: 'w2' }]);
    expect(t.state.windows['w2']).toMatchObject({ activeChordId: 'c2', activeTab: { c2: null }, bounds: { x: 128, y: 108, maximized: false } });
    expect(t.state.windows['w2']!.private).toBeUndefined();
  });

  it('a tab shows in one window at a time: taking it leaves the other window on its last other tab', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    t.run({ t: 'window.create', windowId: 'w2', from: 'w1' });
    expect(shows(t.state, 'w1')).toBe('id-002');
    const result = t.run({ t: 'tab.activate', windowId: 'w2', nodeId: 'id-002' });
    expect(shows(t.state, 'w2')).toBe('id-002');
    expect(shows(t.state, 'w1')).toBe('id-001');
    // The window giving it up goes first, so the page never has two parents.
    const shown = result.effects.filter((e) => e.e === 'view.show');
    expect(shown).toEqual([
      { e: 'view.show', windowId: 'w1', nodeId: 'id-001' },
      { e: 'view.show', windowId: 'w2', nodeId: 'id-002' },
    ]);
  });

  it('landing on a chord, or after a close, never takes a tab another window shows', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'window.create', windowId: 'w2', from: 'w1' });
    t.run({ t: 'chord.activate', windowId: 'w2', chordId: 'c2' });
    // Back to Personal in w2: its only tab is on screen in w1, so w2 shows nothing.
    t.run({ t: 'chord.activate', windowId: 'w2', chordId: 'c1' });
    expect(shows(t.state, 'w2')).toBeNull();
    expect(shows(t.state, 'w1')).toBe('id-001');

    t.run({ t: 'tab.open', windowId: 'w2', url: 'https://b.test/' });
    t.run({ t: 'tab.open', windowId: 'w2', url: 'https://c.test/' });
    // Closing c in w2 lands on b (free), not a (w1's), even though a is right below it in Today.
    expect(tabsInOrderIds(t.state)).toEqual(['id-003', 'id-002', 'id-001']);
    t.run({ t: 'tab.close', windowId: 'w2', nodeId: 'id-003' });
    expect(shows(t.state, 'w2')).toBe('id-002');
    t.run({ t: 'tab.close', windowId: 'w2', nodeId: 'id-002' });
    expect(shows(t.state, 'w2')).toBeNull();
    expect(shows(t.state, 'w1')).toBe('id-001');
  });

  it('closing one of several windows forgets only that window', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'window.create', windowId: 'w2', from: 'w1' });
    t.run({ t: 'window.close', windowId: 'w1' });
    expect(Object.keys(t.state.windows)).toEqual(['w2']);
    expect(t.state.nodes['id-001']).toBeDefined();
  });
});

describe('private windows', () => {
  const download = (id: string, privateWindow?: string): Download => ({
    id,
    url: `https://a.test/${id}`,
    filename: `${id}.zip`,
    path: `/d/${id}.zip`,
    mime: 'application/zip',
    state: 'completed',
    received: 1,
    total: 1,
    speed: 0,
    startedAt: 1,
    endedAt: 2,
    ...(privateWindow ? { privateWindow } : {}),
  });

  function withPrivate() {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'window.create', windowId: 'p1', from: 'w1', privateChordId: 'pc' });
    t.run({ t: 'tab.open', windowId: 'p1', url: 'https://secret.test/' });
    return t;
  }

  it('has a chord of its own, with in-memory sign-ins, that only it sees', () => {
    const t = withPrivate();
    const chord = t.state.chords['pc']!;
    expect(chord).toMatchObject({ name: 'Private', private: true, theme: { appearance: 'dark' } });
    expect(isPrivateProfile(chord.profileId)).toBe(true);
    expect(profilePartition(chord.profileId).startsWith('persist:')).toBe(false);
    expect(t.state.windows['p1']).toMatchObject({ private: true, activeChordId: 'pc' });
    expect(sortedChords(t.state).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chordsFor(t.state, 'w1').map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chordsFor(t.state, 'p1').map((c) => c.id)).toEqual(['pc']);
    expect((t.state.nodes['id-002'] as TabNode).chordId).toBe('pc');
  });

  it('keeps its tabs and normal tabs apart, and has no other chords to switch to', () => {
    const t = withPrivate();
    expect(t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'id-002' }).patches).toEqual([]);
    expect(t.run({ t: 'tab.activate', windowId: 'p1', nodeId: 'id-001' }).patches).toEqual([]);
    expect(t.run({ t: 'chord.activate', windowId: 'p1', chordId: 'c1' }).patches).toEqual([]);
    expect(t.run({ t: 'chord.cycle', windowId: 'p1', direction: 1 }).patches).toEqual([]);
    expect(t.run({ t: 'chord.goto', windowId: 'p1', index: 0 }).patches).toEqual([]);
    expect(t.run({ t: 'chord.activate', windowId: 'w1', chordId: 'pc' }).patches).toEqual([]);
    expect(t.run({ t: 'chord.create', windowId: 'p1', name: 'X', icon: 'X', theme: t.state.chords['c1']!.theme }).patches).toEqual([]);
  });

  it('pins nothing, archives nothing, and reopens its closed tabs only in itself', () => {
    const t = withPrivate();
    expect(t.run({ t: 'tab.pin', nodeId: 'id-002' }).patches).toEqual([]);
    expect(t.run({ t: 'node.move', nodeId: 'id-002', section: 'pinned', index: 0 }).patches).toEqual([]);
    const closed = t.run({ t: 'tab.close', windowId: 'p1', nodeId: 'id-002' });
    expect(closed.effects.some((e) => e.e === 'archive.save')).toBe(false);
    // ⌘⇧T in the normal window doesn't bring the private tab there…
    expect(t.run({ t: 'tab.reopenClosed', windowId: 'w1' }).patches).toEqual([]);
    // …but the private window gets it back.
    t.run({ t: 'tab.reopenClosed', windowId: 'p1' });
    expect(shows(t.state, 'p1')).toBe('id-002');
    // Idle tidying never touches it.
    expect(t.run({ t: 'tab.archive', nodeIds: ['id-002'], reason: 'auto' }).patches).toEqual([]);
  });

  it('lists only its own downloads, and Clear clears only those', () => {
    const t = withPrivate();
    t.run({ t: 'download.update', download: download('n') });
    t.run({ t: 'download.update', download: download('p', 'p1') });
    expect(downloadsFor(t.state, 'w1').map((d) => d.id)).toEqual(['n']);
    expect(downloadsFor(t.state, 'p1').map((d) => d.id)).toEqual(['p']);
    t.run({ t: 'download.clear', windowId: 'p1' });
    expect(Object.keys(t.state.downloads)).toEqual(['n']);
  });

  it('closing it forgets everything in it, and late download news stays forgotten', () => {
    const t = withPrivate();
    t.run({ t: 'download.update', download: download('p', 'p1') });
    t.run({ t: 'tab.close', windowId: 'p1', nodeId: 'id-002' });
    t.run({ t: 'tab.open', windowId: 'p1', url: 'https://other.test/' });
    const result = t.run({ t: 'window.close', windowId: 'p1' });
    expect(result.effects).toContainEqual({ e: 'view.destroy', nodeId: 'id-003' });
    expect(t.state.windows['p1']).toBeUndefined();
    expect(t.state.chords['pc']).toBeUndefined();
    expect(Object.values(t.state.nodes).some((n) => n.chordId === 'pc')).toBe(false);
    expect(t.state.closed.some((c) => c.node.chordId === 'pc')).toBe(false);
    expect(t.state.downloads['p']).toBeUndefined();
    expect(t.run({ t: 'download.update', download: download('p', 'p1') }).patches).toEqual([]);
    // The normal window and its tab are untouched.
    expect(shows(t.state, 'w1')).toBe('id-001');
  });
});

describe('restoring windows', () => {
  it('gives a tab to one window only, and never brings back a private window', () => {
    const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
    const tab = { kind: 'tab' as const, id: 't1', chordId: 'c1', section: 'today' as const, parentId: null, rank: 'a0', url: 'https://a.test/', title: 'A', pinnedUrl: null, customTitle: null, favicon: null, lastActiveAt: 1, createdAt: 1 };
    const win = (id: string, extra = {}) => ({ id, activeChordId: 'c1', activeTab: { c1: 't1' }, sidebar: 'docked' as const, bounds: null, ...extra });
    const state = restoreState(
      {
        chords: [
          { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 },
          { id: 'pc', profileId: 'private-p', name: 'Private', icon: '', theme, rank: 'z', createdAt: 0, private: true },
        ],
        nodes: [tab],
        windows: [win('w1'), win('w2'), win('p', { private: true })],
        settings: {},
      },
      { now: 1, newId: () => 'n', theme, homeUrl: 'h' },
    );
    expect(Object.keys(state.windows)).toEqual(['w1', 'w2']);
    expect(shows(state, 'w1')).toBe('t1');
    expect(shows(state, 'w2')).toBeNull();
    expect(state.chords['pc']).toBeUndefined();
  });
});
