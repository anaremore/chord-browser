/**
 * Outside agents' chords in the model (S18 M1c): in memory only, never in the
 * chord switcher, their tabs shown over a window's chord and kept apart from
 * every other command, and kept or closed when the agent's done.
 */
import { describe, expect, it } from 'vitest';
import {
  activeTabId,
  agentChords,
  apply,
  archiveCandidates,
  chordsFor,
  emptyState,
  isAgentChord,
  nodeOf,
  restoreState,
  shownTabs,
  sortedChords,
  type Command,
  type Context,
  type State,
  type TabNode,
} from '../src';

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
  state.chords['c2'] = { id: 'c2', profileId: 'p-work', name: 'Work', icon: '♪', theme, rank: 'a1', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.windows['w2'] = { id: 'w2', activeChordId: 'c2', activeTab: { c2: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const run = (cmd: Command) => {
    const result = apply(state, cmd, ctx);
    state = result.state;
    return result;
  };
  run({ t: 'tab.open', windowId: 'w1', url: 'https://mine.test/' });
  const mine = activeTabId(state, 'w1')!;
  run({ t: 'agent.chord.add', chordId: 'ag', name: 'Claude Code', profileId: 'default' });
  run({ t: 'agent.tab.add', chordId: 'ag', nodeId: 'a1', url: 'https://agent.test/1' });
  run({ t: 'agent.tab.add', chordId: 'ag', nodeId: 'a2', url: 'https://agent.test/2' });
  return { get state() { return state; }, run, mine, ctx };
}

describe('An agent’s chord', () => {
  it('is never in the chord switcher, nor archived (packages/data keeps it out of what’s written)', () => {
    const t = setup();
    expect(isAgentChord(t.state, 'ag')).toBe(true);
    expect(agentChords(t.state).map((c) => c.id)).toEqual(['ag']);
    expect(sortedChords(t.state).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chordsFor(t.state, 'w1').map((c) => c.id)).toEqual(['c1', 'c2']);
    // Never archived either.
    expect(archiveCandidates(t.state, 10 ** 12, 1)).not.toContain('a1');
  });

  it('shows its tab over a window’s chord, which stays as it was; showing anything else lets it go', () => {
    const t = setup();
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    expect(t.state.windows['w1']).toMatchObject({ activeChordId: 'c1', agentTab: 'a1' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe(t.mine);
    expect(activeTabId(t.state, 'w1')).toBe('a1');
    expect(shownTabs(t.state, 'w1')).toEqual(['a1']);
    // Another window showing it takes it; the first goes back to its own tab.
    t.run({ t: 'tab.activate', windowId: 'w2', nodeId: 'a1' });
    expect(t.state.windows['w1']!.agentTab).toBeUndefined();
    expect(activeTabId(t.state, 'w1')).toBe(t.mine);
    // Showing a tab of its own chord, or another chord, lets it go.
    t.run({ t: 'tab.activate', windowId: 'w2', nodeId: 'a2' });
    t.run({ t: 'chord.activate', windowId: 'w2', chordId: 'c1' });
    expect(t.state.windows['w2']!.agentTab).toBeUndefined();
    // Never a private window's.
    t.run({ t: 'window.create', windowId: 'wp', privateChordId: 'cp' });
    t.run({ t: 'tab.activate', windowId: 'wp', nodeId: 'a1' });
    expect(t.state.windows['wp']!.agentTab).toBeUndefined();
  });

  // [the command, as a renderer could send it]
  const refused: [string, (t: ReturnType<typeof setup>) => Command][] = [
    ['moving its tab', () => ({ t: 'node.move', nodeId: 'a1', section: 'pinned', index: 0 })],
    ['moving its tab to your chord', () => ({ t: 'node.moveToChord', nodeId: 'a1', chordId: 'c1' })],
    ['pinning its tab', () => ({ t: 'tab.pin', nodeId: 'a1' })],
    ['making it a favorite', () => ({ t: 'favorite.add', favoriteId: 'f1', nodeId: 'a1' })],
    ['a folder with its tab', () => ({ t: 'folder.create', folderId: 'f1', chordId: 'c1', title: 'x', tabId: 'a1' })],
    ['switching to its chord', () => ({ t: 'chord.activate', windowId: 'w1', chordId: 'ag' })],
    ['renaming its chord', () => ({ t: 'chord.update', chordId: 'ag', name: 'Mine now' })],
    ['deleting its chord', () => ({ t: 'chord.delete', chordId: 'ag' })],
    ['moving your tab into it', (t) => ({ t: 'node.moveToChord', nodeId: t.mine, chordId: 'ag' })],
    ['archiving it', () => ({ t: 'tab.archive', nodeIds: ['a1'], reason: 'cleared' })],
    ['splitting with it', (t) => ({ t: 'split.join', windowId: 'w1', splitId: 's1', nodeIds: [t.mine, 'a1'], direction: 'row' })],
    ['adding a pane beside it', () => ({ t: 'split.add', windowId: 'w1', withId: 'a1', url: 'https://x.test/' })],
  ];
  it.each(refused)('refuses %s', (_name, command) => {
    const t = setup();
    const before = t.state;
    expect(t.run(command(t)).patches).toEqual([]);
    expect(t.state).toBe(before);
  });

  it('closing its tab just removes it: no Reopen, and the window goes back to its own tab', () => {
    const t = setup();
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    const { effects } = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'a1' });
    expect(nodeOf(t.state, 'a1')).toBeUndefined();
    expect(t.state.closed).toEqual([]);
    expect(t.state.windows['w1']!.agentTab).toBeUndefined();
    expect(effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: t.mine });
    expect(effects).toContainEqual({ e: 'view.destroy', nodeId: 'a1' });
  });

  it('Keep closes its pages even with the same sign-ins: they come back as tabs of yours, not an agent’s', () => {
    const t = setup();
    t.run({ t: 'tab.live', nodeId: 'a1', live: { loading: false } });
    expect(t.state.live['a1']).toBeDefined();
    // The same sign-ins: the agent's chord and Personal both use the default profile.
    expect(t.state.chords['ag']!.profileId).toBe(t.state.chords['c1']!.profileId);
    const { effects } = t.run({ t: 'agent.chord.keep', chordId: 'ag', windowId: 'w1' });
    expect((nodeOf(t.state, 'a1') as TabNode).chordId).toBe('c1');
    expect(t.state.live['a1']).toBeUndefined();
    expect(effects).toEqual(expect.arrayContaining([{ e: 'view.destroy', nodeId: 'a1' }, { e: 'view.destroy', nodeId: 'a2' }]));
  });

  it('Keep moves its tabs into the window’s chord; Close all removes it; Undo brings it back', () => {
    const kept = setup();
    kept.run({ t: 'tab.activate', windowId: 'w2', nodeId: 'a2' });
    kept.run({ t: 'agent.chord.keep', chordId: 'ag', windowId: 'w2' });
    expect(kept.state.chords['ag']).toBeUndefined();
    expect((nodeOf(kept.state, 'a1') as TabNode).chordId).toBe('c2');
    // Other sign-ins (Work's): its page closes, and loads again when shown; the window shows it as Work's tab.
    expect(kept.state.windows['w2']).toMatchObject({ activeChordId: 'c2' });
    expect(kept.state.windows['w2']!.agentTab).toBeUndefined();
    expect(kept.state.windows['w2']!.activeTab['c2']).toBe('a2');

    const closed = setup();
    const chord = closed.state.chords['ag']!;
    const tabs = ['a1', 'a2'].map((id) => nodeOf(closed.state, id) as TabNode);
    closed.run({ t: 'agent.chord.remove', chordId: 'ag' });
    expect(closed.state.chords['ag']).toBeUndefined();
    expect(nodeOf(closed.state, 'a1')).toBeUndefined();
    closed.run({ t: 'agent.chord.restore', chord, tabs });
    expect(isAgentChord(closed.state, 'ag')).toBe(true);
    expect(nodeOf(closed.state, 'a2')).toMatchObject({ chordId: 'ag', url: 'https://agent.test/2' });
  });

  it('a window showing an agent’s tab comes back after a restart showing its own', () => {
    const t = setup();
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    const theme = t.state.chords['c1']!.theme;
    const saved = restoreState(
      { chords: [t.state.chords['c1']!, t.state.chords['c2']!], nodes: [nodeOf(t.state, t.mine)!], windows: [t.state.windows['w1']!], settings: {} },
      { now: 1, newId: () => 'n', theme, homeUrl: 'h' },
    );
    expect(saved.windows['w1']!.agentTab).toBeUndefined();
  });
});
