import { applyPatches, enablePatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { apply, emptyState, tabsInOrder, type Command, type Context, type State } from '../src';

enablePatches();

function setup(): { state: State; ctx: Context; run: (cmd: Command) => ReturnType<typeof apply> } {
  let n = 0;
  let now = 1_000;
  const ctx: Context = {
    get now() {
      return now++;
    },
    newId: () => `id-${String(++n).padStart(3, '0')}`,
  };
  const box = { state: emptyState() };
  box.state.chords['c1'] = {
    id: 'c1',
    profileId: 'default',
    name: 'Personal',
    icon: '✦',
    theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.35, appearance: 'auto' },
    rank: 'a0',
    createdAt: 0,
  };
  box.state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', bounds: null };
  const run = (cmd: Command) => {
    const result = apply(box.state, cmd, ctx);
    box.state = result.state;
    return result;
  };
  return {
    get state() {
      return box.state;
    },
    ctx,
    run,
  };
}

const titles = (state: State) => tabsInOrder(state, 'c1').map((t) => t.url);

describe('reducer', () => {
  it('opens new tabs at the top of Today and activates them', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    const result = t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    expect(titles(t.state)).toEqual(['https://b.test/', 'https://a.test/']);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-002');
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 'id-002' });
  });

  it('opens background tabs without switching', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    const result = t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/', background: true });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
    expect(result.effects).not.toContainEqual(expect.objectContaining({ e: 'view.show' }));
  });

  it('closing the active tab lands on the tab below, then above', () => {
    const t = setup();
    for (const u of ['a', 'b', 'c']) t.run({ t: 'tab.open', windowId: 'w1', url: `https://${u}.test/` });
    // order: c, b, a — activate b, close it → a (below)
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'id-002' });
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-002' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
    // close a (last) → c (above)
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-001' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-003');
    // close the only tab → nothing
    const last = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-003' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBeNull();
    expect(last.effects).toContainEqual({ e: 'view.destroy', nodeId: 'id-003' });
  });

  it('reopens closed tabs in reverse order, in place', () => {
    const t = setup();
    for (const u of ['a', 'b']) t.run({ t: 'tab.open', windowId: 'w1', url: `https://${u}.test/` });
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-001' });
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-002' });
    t.run({ t: 'tab.reopenClosed', windowId: 'w1' });
    expect(titles(t.state)).toEqual(['https://b.test/']);
    t.run({ t: 'tab.reopenClosed', windowId: 'w1' });
    expect(titles(t.state)).toEqual(['https://b.test/', 'https://a.test/']);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
  });

  it('cycles through tabs in sidebar order and wraps', () => {
    const t = setup();
    for (const u of ['a', 'b', 'c']) t.run({ t: 'tab.open', windowId: 'w1', url: `https://${u}.test/` });
    // active is c (top); next goes down to b, then a, then wraps to c
    t.run({ t: 'tab.cycle', windowId: 'w1', direction: 1 });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-002');
    t.run({ t: 'tab.cycle', windowId: 'w1', direction: 1 });
    t.run({ t: 'tab.cycle', windowId: 'w1', direction: 1 });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-003');
    t.run({ t: 'tab.cycle', windowId: 'w1', direction: -1 });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
  });

  it('collapses and docks the sidebar, asking main to lay the window out once per change', () => {
    const t = setup();
    const collapsed = t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'collapsed' });
    expect(t.state.windows['w1']!.sidebar).toBe('collapsed');
    expect(collapsed.effects).toEqual([{ e: 'window.layout', windowId: 'w1', sidebar: 'collapsed' }]);
    expect(t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'collapsed' }).effects).toEqual([]);
    t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'docked' });
    expect(t.state.windows['w1']!.sidebar).toBe('docked');
  });

  it('changes settings, merging motion switches, and ignores no-op changes', () => {
    const t = setup();
    t.run({ t: 'settings.set', settings: { searchEngine: 'kagi', motion: { sidebar: false } } });
    expect(t.state.settings.searchEngine).toBe('kagi');
    expect(t.state.settings.motion).toMatchObject({ sidebar: false, tabMoves: true, followSystem: true });
    expect(t.run({ t: 'settings.set', settings: { motion: { sidebar: false } } }).patches).toHaveLength(0);
  });

  it("updates a chord's theme and clamps grain", () => {
    const t = setup();
    t.run({ t: 'chord.theme', chordId: 'c1', theme: { grain: 3, appearance: 'dark' } });
    expect(t.state.chords['c1']!.theme).toMatchObject({ grain: 1, appearance: 'dark' });
    t.run({ t: 'chord.theme', chordId: 'c1', theme: { stops: [{ l: 0.7, c: 0.15, h: 30 }] } });
    expect(t.state.chords['c1']!.theme.stops).toEqual([{ l: 0.7, c: 0.15, h: 30 }]);
  });

  it('produces no patches (and keeps the version) for no-op updates', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    const version = t.state.version;
    const same = t.run({ t: 'tab.updated', nodeId: 'id-001', url: 'https://a.test/' });
    expect(same.patches).toHaveLength(0);
    expect(t.state.version).toBe(version);
  });

  it('patches replay to the same state on a mirror', () => {
    const t = setup();
    let mirror = t.state;
    const commands: Command[] = [
      { t: 'tab.open', windowId: 'w1', url: 'https://a.test/' },
      { t: 'tab.open', windowId: 'w1', url: 'https://b.test/' },
      { t: 'tab.updated', nodeId: 'id-001', title: 'A' },
      { t: 'tab.live', nodeId: 'id-002', live: { loading: false, canGoBack: true } },
      { t: 'tab.close', windowId: 'w1', nodeId: 'id-002' },
    ];
    for (const cmd of commands) mirror = applyPatches(mirror, t.run(cmd).patches);
    expect(mirror).toEqual(t.state);
  });
});
