import { applyPatches, enablePatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { apply, children, emptyState, sortedFavorites, tabsInOrder, type Command, type Context, type State, type TabNode } from '../src';

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
  box.state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
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
  it('remembers page zoom per site, clamped to Chromium’s range, and forgets 100%', () => {
    const t = setup();
    t.run({ t: 'zoom.set', host: 'a.test', factor: 1.25 });
    t.run({ t: 'zoom.set', host: 'b.test', factor: 12 });
    expect(t.state.siteZoom).toEqual({ 'a.test': 1.25, 'b.test': 5 });
    t.run({ t: 'zoom.set', host: 'a.test', factor: 1.0000001 });
    expect(t.state.siteZoom).toEqual({ 'b.test': 5 });
  });

  it('forgets everything decided for a site, and spelling settings change field by field', () => {
    const t = setup();
    t.run({ t: 'permission.set', origin: 'https://a.test', permissions: ['camera', 'notifications'], decision: 'allow' });
    t.run({ t: 'permission.forget', origin: 'https://a.test' });
    expect(t.state.sitePermissions).toEqual({});
    t.run({ t: 'settings.set', settings: { spellcheck: { language: 'fr' } } });
    expect(t.state.settings.spellcheck).toEqual({ enabled: true, language: 'fr' });
    t.run({ t: 'settings.set', settings: { spellcheck: { enabled: false } } });
    expect(t.state.settings.spellcheck).toEqual({ enabled: false, language: 'fr' });
  });

  it('sets the interface size to one of its sizes, and ignores anything else', () => {
    const t = setup();
    t.run({ t: 'settings.set', settings: { uiScale: 1.25 } });
    expect(t.state.settings.uiScale).toBe(1.25);
    expect(t.run({ t: 'settings.set', settings: { uiScale: 1.3 as never } }).patches).toHaveLength(0);
    expect(t.state.settings.uiScale).toBe(1.25);
  });

  it('gives new chords their own sign-ins when Settings says so', () => {
    const t = setup();
    const theme = { stops: [{ l: 0.72, c: 0.12, h: 30 }], grain: 0.2, appearance: 'auto' as const };
    t.run({ t: 'chord.create', windowId: 'w1', name: 'Shared', icon: 'S', theme });
    t.run({ t: 'settings.set', settings: { separateSignIns: true } });
    t.run({ t: 'chord.create', windowId: 'w1', name: 'Own', icon: 'O', theme });
    const byName = (name: string) => Object.values(t.state.chords).find((c) => c.name === name)!;
    expect(byName('Shared').profileId).toBe('default');
    expect(byName('Own').profileId).not.toBe('default');
    expect(byName('Own').profileId).not.toBe(byName('Own').id);
  });

  it('moves a chord to its own sign-ins: open pages close, and the shown one reloads in the new session', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    const result = t.run({ t: 'chord.profile', chordId: 'c1', profileId: 'p-work' });
    expect(t.state.chords['c1']!.profileId).toBe('p-work');
    // Both pages close; only the one on screen comes back, already loading.
    expect(result.effects.filter((e) => e.e === 'view.destroy')).toHaveLength(2);
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 'id-002' });
    expect(Object.keys(t.state.live)).toEqual(['id-002']);
    expect(t.state.live['id-002']!.loading).toBe(true);
    // Setting the same profile again changes nothing.
    expect(t.run({ t: 'chord.profile', chordId: 'c1', profileId: 'p-work' }).effects).toEqual([]);
  });

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
    expect(collapsed.effects).toEqual([{ e: 'window.layout', windowId: 'w1', sidebar: 'collapsed', width: 248, animate: true }]);
    expect(t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'collapsed' }).effects).toEqual([]);
    t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'docked' });
    expect(t.state.windows['w1']!.sidebar).toBe('docked');
  });

  it('resizes the sidebar within its range, laying the window out without animating', () => {
    const t = setup();
    const wide = t.run({ t: 'window.sidebarWidth', windowId: 'w1', width: 512.4 });
    expect(t.state.windows['w1']!.sidebarWidth).toBe(400);
    expect(wide.effects).toEqual([{ e: 'window.layout', windowId: 'w1', sidebar: 'docked', width: 400, animate: false }]);
    t.run({ t: 'window.sidebarWidth', windowId: 'w1', width: 120 });
    expect(t.state.windows['w1']!.sidebarWidth).toBe(200);
    expect(t.run({ t: 'window.sidebarWidth', windowId: 'w1', width: 200 }).effects).toEqual([]);
    // Collapsing and docking keep the width.
    const docked = t.run({ t: 'window.sidebar', windowId: 'w1', sidebar: 'collapsed' });
    expect(docked.effects[0]).toMatchObject({ width: 200 });
  });

  it('changes settings, merging motion switches, and ignores no-op changes', () => {
    const t = setup();
    t.run({ t: 'settings.set', settings: { searchEngine: 'kagi', motion: { sidebar: false } } });
    expect(t.state.settings.searchEngine).toBe('kagi');
    expect(t.state.settings.motion).toMatchObject({ sidebar: false, tabMoves: true, followSystem: true });
    expect(t.run({ t: 'settings.set', settings: { motion: { sidebar: false } } }).patches).toHaveLength(0);
  });

  // Switches that start on: search suggestions, update checks, and minimal mode's peek on pointing.
  it.each(['searchSuggestions', 'checkForUpdates', 'sidebarPeek'] as const)('turns %s off and on', (key) => {
    const t = setup();
    expect(t.state.settings[key]).toBe(true);
    t.run({ t: 'settings.set', settings: { [key]: false } });
    expect(t.state.settings[key]).toBe(false);
    expect(t.run({ t: 'settings.set', settings: { [key]: false } }).patches).toHaveLength(0);
    t.run({ t: 'settings.set', settings: { [key]: true } });
    expect(t.state.settings[key]).toBe(true);
  });

  it('Google-free mode never searches with Google, and keeps a non-Google choice', () => {
    const t = setup();
    expect(t.state.settings).toMatchObject({ googleFree: false, searchEngine: 'google' });
    // Turning it on moves off Google.
    t.run({ t: 'settings.set', settings: { googleFree: true } });
    expect(t.state.settings).toMatchObject({ googleFree: true, searchEngine: 'duckduckgo' });
    // Any other engine can be chosen; Google can't.
    t.run({ t: 'settings.set', settings: { searchEngine: 'brave' } });
    expect(t.run({ t: 'settings.set', settings: { searchEngine: 'google' } }).patches).toHaveLength(0);
    expect(t.state.settings.searchEngine).toBe('brave');
    // Off again: the choice stays, and Google can be chosen once more.
    t.run({ t: 'settings.set', settings: { googleFree: false } });
    expect(t.state.settings.searchEngine).toBe('brave');
    t.run({ t: 'settings.set', settings: { searchEngine: 'google' } });
    expect(t.state.settings.searchEngine).toBe('google');
    // Turning it on with a choice in the same change takes that choice.
    t.run({ t: 'settings.set', settings: { googleFree: true, searchEngine: 'kagi' } });
    expect(t.state.settings).toMatchObject({ googleFree: true, searchEngine: 'kagi' });
  });

  it('Safe Browsing: on only with its notice answered, and Google-free mode keeps it off', () => {
    const t = setup();
    expect(t.state.settings).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: false });
    // Turning it on (Settings shows the notice beside the switch) counts as answering it.
    t.run({ t: 'settings.set', settings: { safeBrowsing: true } });
    expect(t.state.settings).toMatchObject({ safeBrowsing: true, safeBrowsingAsked: true });
    t.run({ t: 'settings.set', settings: { safeBrowsing: false } });
    expect(t.state.settings).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: true });
    t.run({ t: 'settings.set', settings: { safeBrowsing: true } });
    // Google-free mode turns it off, and it can't come back on while the mode is on.
    t.run({ t: 'settings.set', settings: { googleFree: true } });
    expect(t.state.settings.safeBrowsing).toBe(false);
    expect(t.run({ t: 'settings.set', settings: { safeBrowsing: true } }).patches).toHaveLength(0);
    // Off again, it stays off until you turn it on.
    t.run({ t: 'settings.set', settings: { googleFree: false } });
    expect(t.state.settings.safeBrowsing).toBe(false);
    t.run({ t: 'settings.set', settings: { safeBrowsing: true } });
    expect(t.state.settings.safeBrowsing).toBe(true);
    // "Not now" on the offer: asked, still off.
    const u = setup();
    u.run({ t: 'settings.set', settings: { safeBrowsing: false, safeBrowsingAsked: true } });
    expect(u.state.settings).toMatchObject({ safeBrowsing: false, safeBrowsingAsked: true });
  });

  it('ad blocking: on by default, unaffected by Google-free mode, and off per site by registrable domain', () => {
    const t = setup();
    expect(t.state.settings.adBlocking).toEqual({ enabled: true, offSites: [] });
    t.run({ t: 'settings.set', settings: { googleFree: true } });
    expect(t.state.settings.adBlocking.enabled).toBe(true);
    t.run({ t: 'settings.set', settings: { adBlocking: { enabled: false } } });
    expect(t.state.settings.adBlocking).toEqual({ enabled: false, offSites: [] });
    // Sites arrive as addresses or names; each is kept once, as its site, and junk is dropped.
    t.run({ t: 'settings.set', settings: { adBlocking: { offSites: ['https://www.nytimes.com/section/world', 'cooking.nytimes.com', 'news.bbc.co.uk', 'not a site', ''] } } });
    expect(t.state.settings.adBlocking.offSites).toEqual(['nytimes.com', 'bbc.co.uk']);
    // The same list again changes nothing.
    expect(t.run({ t: 'settings.set', settings: { adBlocking: { offSites: ['nytimes.com', 'bbc.co.uk'] } } }).patches).toHaveLength(0);
    t.run({ t: 'settings.set', settings: { adBlocking: { offSites: [] } } });
    expect(t.state.settings.adBlocking.offSites).toEqual([]);
  });

  it('a page’s “Block ads on this site”: saved for chords, kept only in a private window, and its pages reload', () => {
    const t = setup();
    const off = t.run({ t: 'adBlocking.site', site: 'https://www.nytimes.com/x', off: true });
    expect(t.state.settings.adBlocking.offSites).toEqual(['nytimes.com']);
    expect(off.effects).toEqual([{ e: 'site.reload', site: 'nytimes.com', chordId: null }]);
    // Already off: nothing happens, nothing reloads.
    expect(t.run({ t: 'adBlocking.site', site: 'nytimes.com', off: true }).effects).toEqual([]);
    // A private window keeps its own, and never saves it.
    t.run({ t: 'window.create', windowId: 'pw', privateChordId: 'pc' });
    const priv = t.run({ t: 'adBlocking.site', site: 'example.org', off: true, chordId: 'pc' });
    expect(t.state.chords['pc']!.blockingOff).toEqual(['example.org']);
    expect(t.state.settings.adBlocking.offSites).toEqual(['nytimes.com']);
    expect(priv.effects).toEqual([{ e: 'site.reload', site: 'example.org', chordId: 'pc' }]);
    // Turning a saved site back on from a private window changes the saved list.
    t.run({ t: 'adBlocking.site', site: 'nytimes.com', off: false, chordId: 'pc' });
    expect(t.state.settings.adBlocking.offSites).toEqual([]);
    // Not a site: ignored.
    expect(t.run({ t: 'adBlocking.site', site: 'chord://settings', off: true }).patches).toHaveLength(0);
  });

  it('a tab’s Safe Browsing warning is kept and cleared like its other live state', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://example.com/' });
    const nodeId = tabsInOrder(t.state, 'c1')[0]!.id;
    const threat = { kind: 'phishing' as const, url: 'https://evil.example/', frameUrl: null };
    t.run({ t: 'tab.live', nodeId, live: { threat } });
    expect(t.state.live[nodeId]!.threat).toEqual(threat);
    expect(t.run({ t: 'tab.live', nodeId, live: { threat: { ...threat } } }).patches).toHaveLength(0);
    t.run({ t: 'tab.live', nodeId, live: { threat: null } });
    expect(t.state.live[nodeId]!.threat).toBeNull();
  });

  it("updates a chord's theme and clamps grain", () => {
    const t = setup();
    t.run({ t: 'chord.theme', chordId: 'c1', theme: { grain: 3, appearance: 'dark' } });
    expect(t.state.chords['c1']!.theme).toMatchObject({ grain: 1, appearance: 'dark' });
    t.run({ t: 'chord.theme', chordId: 'c1', theme: { stops: [{ l: 0.7, c: 0.15, h: 30 }] } });
    expect(t.state.chords['c1']!.theme.stops).toEqual([{ l: 0.7, c: 0.15, h: 30 }]);
  });

  describe('pinning and moving', () => {
    const section = (t: ReturnType<typeof setup>, s: 'pinned' | 'today') =>
      Object.values(t.state.nodes)
        .filter((n) => n.section === s)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((n) => (n as TabNode).url.slice(8, 9));
    const open3 = () => {
      const t = setup();
      for (const u of ['a', 'b', 'c']) t.run({ t: 'tab.open', windowId: 'w1', url: `https://${u}.test/` });
      return t; // Today: c, b, a
    };

    it('pins to the bottom of pinned, keeping the page as home; unpins to the top of Today', () => {
      const t = open3();
      t.run({ t: 'tab.pin', nodeId: 'id-001' });
      t.run({ t: 'tab.pin', nodeId: 'id-003' });
      expect(section(t, 'pinned')).toEqual(['a', 'c']);
      expect(t.state.nodes['id-001']).toMatchObject({ section: 'pinned', pinnedUrl: 'https://a.test/' });
      t.run({ t: 'tab.unpin', nodeId: 'id-001' });
      expect(section(t, 'today')).toEqual(['a', 'b']);
      expect((t.state.nodes['id-001'] as TabNode).pinnedUrl).toBeNull();
    });

    it('moves within a section and between sections, and ignores a drop in place', () => {
      const t = open3();
      t.run({ t: 'node.move', nodeId: 'id-003', section: 'today', index: 2 });
      expect(section(t, 'today')).toEqual(['b', 'a', 'c']);
      t.run({ t: 'node.move', nodeId: 'id-002', section: 'pinned', index: 0 });
      expect(section(t, 'pinned')).toEqual(['b']);
      expect(section(t, 'today')).toEqual(['a', 'c']);
      expect(t.run({ t: 'node.move', nodeId: 'id-001', section: 'today', index: 0 }).patches).toHaveLength(0);
    });

    it('closing a pinned tab unloads it and takes it home; it stays pinned', () => {
      const t = open3();
      t.run({ t: 'tab.pin', nodeId: 'id-003' });
      t.run({ t: 'tab.activate', windowId: 'w1', nodeId: 'id-003' });
      t.run({ t: 'tab.updated', nodeId: 'id-003', url: 'https://c.test/elsewhere' });
      const result = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-003' });
      expect(t.state.nodes['id-003']).toMatchObject({ section: 'pinned', url: 'https://c.test/' });
      expect(t.state.live['id-003']).toBeUndefined();
      expect(result.effects).toContainEqual({ e: 'view.destroy', nodeId: 'id-003' });
      expect(t.state.windows['w1']!.activeTab['c1']).not.toBe('id-003');
      expect(t.state.closed).toHaveLength(0);
    });
  });

  describe('chords', () => {
    const theme = { stops: [{ l: 0.72, c: 0.1, h: 165 }], grain: 0.2, appearance: 'auto' as const };

    it('creates a chord after the others and switches to it, empty', () => {
      const t = setup();
      t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
      const result = t.run({ t: 'chord.create', windowId: 'w1', name: '  Work  ', icon: '♪', theme });
      const id = t.state.windows['w1']!.activeChordId;
      expect(t.state.chords[id]).toMatchObject({ name: 'Work', icon: '♪' });
      expect(t.state.chords[id]!.rank > t.state.chords['c1']!.rank).toBe(true);
      expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: null });
    });

    it('remembers the tab each chord was showing', () => {
      const t = setup();
      t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
      t.run({ t: 'chord.create', windowId: 'w1', name: 'Work', icon: '♪', theme });
      const work = t.state.windows['w1']!.activeChordId;
      t.run({ t: 'tab.open', windowId: 'w1', url: 'https://w.test/' });
      t.run({ t: 'chord.activate', windowId: 'w1', chordId: 'c1' });
      expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
      t.run({ t: 'chord.activate', windowId: 'w1', chordId: work });
      expect(t.state.windows['w1']!.activeTab[work]).toBe('id-003');
    });

    it('cycles with wraparound, and ⌘9 goes to the last chord', () => {
      const t = setup();
      t.run({ t: 'chord.create', windowId: 'w1', name: 'Two', icon: '2', theme });
      t.run({ t: 'chord.create', windowId: 'w1', name: 'Three', icon: '3', theme });
      const name = () => t.state.chords[t.state.windows['w1']!.activeChordId]!.name;
      t.run({ t: 'chord.cycle', windowId: 'w1', direction: 1 });
      expect(name()).toBe('Personal');
      t.run({ t: 'chord.cycle', windowId: 'w1', direction: -1 });
      expect(name()).toBe('Three');
      t.run({ t: 'chord.goto', windowId: 'w1', index: 1 });
      expect(name()).toBe('Two');
      t.run({ t: 'chord.goto', windowId: 'w1', index: 8 });
      expect(name()).toBe('Three');
      t.run({ t: 'chord.goto', windowId: 'w1', index: 5 });
      expect(name()).toBe('Three');
    });

    it('renames, ignoring blank names', () => {
      const t = setup();
      t.run({ t: 'chord.update', chordId: 'c1', name: 'Home', icon: '⌂' });
      t.run({ t: 'chord.update', chordId: 'c1', name: '   ' });
      expect(t.state.chords['c1']).toMatchObject({ name: 'Home', icon: '⌂' });
    });

    it('deletes a chord: its tabs go with it, windows move to a neighbor, and Undo brings it all back', () => {
      const t = setup();
      t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
      t.run({ t: 'chord.create', windowId: 'w1', name: 'Work', icon: '♪', theme });
      const work = t.state.windows['w1']!.activeChordId;
      t.run({ t: 'tab.open', windowId: 'w1', url: 'https://w.test/' });
      const result = t.run({ t: 'chord.delete', chordId: work });
      expect(t.state.chords[work]).toBeUndefined();
      expect(t.state.windows['w1']).toMatchObject({ activeChordId: 'c1', activeTab: { c1: 'id-001' } });
      expect(t.state.windows['w1']!.activeTab[work]).toBeUndefined();
      expect(result.effects).toContainEqual({ e: 'view.destroy', nodeId: 'id-003' });
      expect(t.state.closed).toHaveLength(0);
      // The last chord stays.
      expect(t.run({ t: 'chord.delete', chordId: 'c1' }).patches).toHaveLength(0);

      t.run({ t: 'chord.restore', windowId: 'w1', chordId: work });
      expect(t.state.chords[work]).toMatchObject({ name: 'Work' });
      expect(t.state.windows['w1']).toMatchObject({ activeChordId: work, activeTab: { [work]: 'id-003' } });
      expect(t.state.deletedChords).toHaveLength(0);
    });
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

describe('archive and sleep', () => {
  const open = (t: ReturnType<typeof setup>, ...hosts: string[]) => {
    for (const h of hosts) t.run({ t: 'tab.open', windowId: 'w1', url: `https://${h}.test/` });
  };

  it('closing a Today tab archives it first, keeping it on the ⌘⇧T list with its archive entry', () => {
    const t = setup();
    open(t, 'a', 'b');
    const result = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-001' });
    const saveAt = result.effects.findIndex((e) => e.e === 'archive.save');
    const destroyAt = result.effects.findIndex((e) => e.e === 'view.destroy');
    expect(saveAt).toBeGreaterThanOrEqual(0);
    // Saved before the view goes, so its back/forward history can still be read.
    expect(saveAt).toBeLessThan(destroyAt);
    const save = result.effects[saveAt] as Extract<(typeof result.effects)[number], { e: 'archive.save' }>;
    expect(save.tab).toMatchObject({ url: 'https://a.test/', reason: 'closed', chordId: 'c1' });
    expect(t.state.closed[0]!.archiveId).toBe(save.tab.id);

    const reopened = t.run({ t: 'tab.reopenClosed', windowId: 'w1' });
    expect(reopened.effects[0]).toEqual({ e: 'archive.restored', archiveId: save.tab.id, nodeId: 'id-001' });
  });

  it("closing Chord's own page doesn't archive it", () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'chord://archive/' });
    const result = t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-001' });
    expect(result.effects.some((e) => e.e === 'archive.save')).toBe(false);
    expect(t.state.closed[0]!.archiveId).toBeNull();
  });

  it('auto-archive takes idle tabs quietly: not onto the ⌘⇧T list, never the one on screen', () => {
    const t = setup();
    open(t, 'a', 'b', 'c');
    // c is on screen.
    const result = t.run({ t: 'tab.archive', nodeIds: ['id-001', 'id-002', 'id-003'], reason: 'auto' });
    expect(titles(t.state)).toEqual(['https://c.test/']);
    expect(t.state.closed).toEqual([]);
    expect(result.effects.filter((e) => e.e === 'archive.save')).toHaveLength(2);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-003');
  });

  it('Clear archives the Today tabs you can see, lands on what stays, and ⌘⇧T brings them back', () => {
    const t = setup();
    open(t, 'a', 'b');
    t.run({ t: 'tab.pin', nodeId: 'id-001' });
    t.run({ t: 'tab.archive', nodeIds: ['id-002'], reason: 'cleared' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
    expect(t.state.closed).toHaveLength(1);
    t.run({ t: 'tab.reopenClosed', windowId: 'w1' });
    expect(titles(t.state)).toEqual(['https://a.test/', 'https://b.test/']);
  });

  it('brings a tab back from the archive into its chord, shown or waiting in the sidebar', () => {
    const t = setup();
    open(t, 'a');
    const tab = { id: 'arch-1', chordId: 'c1', url: 'https://old.test/', title: 'Old', favicon: null, reason: 'auto' as const, archivedAt: 5 };
    const waiting = t.run({ t: 'archive.restore', windowId: 'w1', nodeId: 'n-1', tab, activate: false });
    expect(titles(t.state)[0]).toBe('https://old.test/');
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('id-001');
    expect(t.state.live['n-1']).toBeUndefined();
    expect(waiting.effects).toEqual([{ e: 'archive.restored', archiveId: 'arch-1', nodeId: 'n-1' }]);

    const shown = t.run({ t: 'archive.restore', windowId: 'w1', nodeId: 'n-2', tab: { ...tab, id: 'arch-2' }, activate: true });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('n-2');
    const kinds = shown.effects.map((e) => e.e);
    // The saved history is handed over before the view is made.
    expect(kinds.indexOf('archive.restored')).toBeLessThan(kinds.indexOf('view.ensure'));
  });

  it('a tab brought back from the archive leaves the ⌘⇧T list', () => {
    const t = setup();
    open(t, 'a', 'b');
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: 'id-001' });
    const entry = t.state.closed[0]!;
    const tab = { id: entry.archiveId!, chordId: 'c1', url: entry.node.url, title: '', favicon: null, reason: 'closed' as const, archivedAt: 1 };
    t.run({ t: 'archive.restore', windowId: 'w1', nodeId: 'n-1', tab, activate: false });
    expect(t.state.closed).toEqual([]);
  });

  it('sleeps hidden tabs only, dropping their live state', () => {
    const t = setup();
    open(t, 'a', 'b');
    t.run({ t: 'tab.live', nodeId: 'id-001', live: { loading: false } });
    expect(t.run({ t: 'tab.sleep', nodeId: 'id-002' }).effects).toEqual([]);
    const result = t.run({ t: 'tab.sleep', nodeId: 'id-001' });
    expect(result.effects).toEqual([{ e: 'view.sleep', nodeId: 'id-001' }]);
    expect(t.state.live['id-001']).toBeUndefined();
    expect(t.state.nodes['id-001']).toBeDefined();
  });

  it('a tab counts as used until you leave it, so idle time starts then', () => {
    const t = setup();
    open(t, 'a', 'b');
    // An hour later, switch from b to a.
    const later = apply(t.state, { t: 'tab.activate', windowId: 'w1', nodeId: 'id-001' }, { now: 3_600_000, newId: () => 'unused' }).state;
    expect((later.nodes['id-001'] as TabNode).lastActiveAt).toBe(3_600_000);
    // b was in use until just now, and stays just behind a in recently-used order.
    expect((later.nodes['id-002'] as TabNode).lastActiveAt).toBe(3_599_999);
  });

  it('changes the archive and sleep settings', () => {
    const t = setup();
    t.run({ t: 'settings.set', settings: { archiveAfter: '7d', sleepTabs: false } });
    expect(t.state.settings).toMatchObject({ archiveAfter: '7d', sleepTabs: false });
  });
});

describe('folders', () => {
  const open = (t: ReturnType<typeof setup>, url: string) => {
    t.run({ t: 'tab.open', windowId: 'w1', url });
    return t.state.windows['w1']!.activeTab['c1']!;
  };
  const pinnedTree = (state: State, parentId: string | null = null): unknown[] =>
    children(state, 'c1', 'pinned', parentId).map((n) => (n.kind === 'folder' ? { [n.title]: pinnedTree(state, n.id) } : (n as TabNode).url));

  it('makes a folder where a pinned tab was, with the tab inside', () => {
    const t = setup();
    const a = open(t, 'https://a.test/');
    const b = open(t, 'https://b.test/');
    t.run({ t: 'tab.pin', nodeId: a });
    t.run({ t: 'tab.pin', nodeId: b });
    t.run({ t: 'folder.create', folderId: 'f1', chordId: 'c1', title: '  Reading  ', tabId: a });
    expect(pinnedTree(t.state)).toEqual([{ Reading: ['https://a.test/'] }, 'https://b.test/']);
    // From Today, the folder goes at the end of Pinned and the tab is pinned inside it.
    const c = open(t, 'https://c.test/');
    t.run({ t: 'folder.create', folderId: 'f2', chordId: 'c1', title: '', tabId: c });
    expect(pinnedTree(t.state)).toEqual([{ Reading: ['https://a.test/'] }, 'https://b.test/', { 'New folder': ['https://c.test/'] }]);
    expect((t.state.nodes[c] as TabNode).pinnedUrl).toBe('https://c.test/');
  });

  it('nests folders, moves tabs in and out, and never moves a folder into itself', () => {
    const t = setup();
    const a = open(t, 'https://a.test/');
    const b = open(t, 'https://b.test/');
    t.run({ t: 'folder.create', folderId: 'outer', chordId: 'c1', title: 'Outer' });
    t.run({ t: 'folder.create', folderId: 'inner', chordId: 'c1', title: 'Inner' });
    t.run({ t: 'node.move', nodeId: 'inner', section: 'pinned', index: 0, parentId: 'outer' });
    // A Today tab dropped into a folder is pinned there.
    t.run({ t: 'node.move', nodeId: a, section: 'today', index: 0, parentId: 'inner' });
    t.run({ t: 'node.move', nodeId: b, section: 'pinned', index: 1, parentId: 'outer' });
    expect(pinnedTree(t.state)).toEqual([{ Outer: [{ Inner: ['https://a.test/'] }, 'https://b.test/'] }]);
    expect(t.state.nodes[a]!.section).toBe('pinned');
    // Into itself or its own child: refused.
    expect(t.run({ t: 'node.move', nodeId: 'outer', section: 'pinned', index: 0, parentId: 'inner' }).patches).toEqual([]);
    expect(t.run({ t: 'node.move', nodeId: 'outer', section: 'pinned', index: 0, parentId: 'outer' }).patches).toEqual([]);
    // Folders stay in Pinned.
    expect(t.run({ t: 'node.move', nodeId: 'outer', section: 'today', index: 0 }).patches).toEqual([]);
    // Out to Today unpins the tab.
    t.run({ t: 'node.move', nodeId: b, section: 'today', index: 0, parentId: null });
    expect(t.state.nodes[b]).toMatchObject({ section: 'today', parentId: null, pinnedUrl: null });
  });

  it('renames and folds, ignoring empty names and no-ops', () => {
    const t = setup();
    t.run({ t: 'folder.create', folderId: 'f', chordId: 'c1', title: 'Old' });
    t.run({ t: 'folder.rename', nodeId: 'f', title: '  New  ' });
    expect(t.state.nodes['f']).toMatchObject({ title: 'New' });
    expect(t.run({ t: 'folder.rename', nodeId: 'f', title: '   ' }).patches).toEqual([]);
    t.run({ t: 'folder.toggle', nodeId: 'f', collapsed: true });
    expect(t.state.nodes['f']).toMatchObject({ collapsed: true });
    expect(t.run({ t: 'folder.toggle', nodeId: 'f', collapsed: true }).patches).toEqual([]);
  });

  it('deletes a folder with everything in it, and Undo brings it all back', () => {
    const t = setup();
    const a = open(t, 'https://a.test/');
    const b = open(t, 'https://b.test/');
    t.run({ t: 'folder.create', folderId: 'f', chordId: 'c1', title: 'F', tabId: a });
    t.run({ t: 'folder.create', folderId: 'g', chordId: 'c1', title: 'G' });
    t.run({ t: 'node.move', nodeId: 'g', section: 'pinned', index: 1, parentId: 'f' });
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: a });
    const deleted = t.run({ t: 'folder.delete', nodeId: 'f' });
    expect(t.state.nodes['f']).toBeUndefined();
    expect(t.state.nodes['g']).toBeUndefined();
    expect(t.state.nodes[a]).toBeUndefined();
    expect(deleted.effects).toContainEqual({ e: 'view.destroy', nodeId: a });
    // The window lands on the tab that's left.
    expect(t.state.windows['w1']!.activeTab['c1']).toBe(b);
    t.run({ t: 'folder.restore', nodeId: 'f' });
    expect(pinnedTree(t.state)).toEqual([{ F: ['https://a.test/', { G: [] }] }]);
    expect(t.state.deletedFolders).toEqual([]);
  });
});

describe('favorites', () => {
  it('adds pages once, reorders, and removes', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://mail.test/inbox' });
    const mail = t.state.windows['w1']!.activeTab['c1']!;
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://cal.test/' });
    const cal = t.state.windows['w1']!.activeTab['c1']!;
    t.run({ t: 'favorite.add', favoriteId: 'fm', nodeId: mail });
    t.run({ t: 'favorite.add', favoriteId: 'fc', nodeId: cal, index: 0 });
    expect(t.run({ t: 'favorite.add', favoriteId: 'again', nodeId: mail }).patches).toEqual([]);
    const order = () => sortedFavorites(t.state).map((f) => f.url);
    expect(order()).toEqual(['https://cal.test/', 'https://mail.test/inbox']);
    t.run({ t: 'favorite.move', favoriteId: 'fc', index: 1 });
    expect(order()).toEqual(['https://mail.test/inbox', 'https://cal.test/']);
    t.run({ t: 'favorite.remove', favoriteId: 'fm' });
    expect(order()).toEqual(['https://cal.test/']);
  });

  it('switches to a tab on the same site in this chord, or opens one', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://mail.test/inbox' });
    const mail = t.state.windows['w1']!.activeTab['c1']!;
    t.run({ t: 'favorite.add', favoriteId: 'fm', nodeId: mail });
    t.run({ t: 'tab.navigate', nodeId: mail, url: 'https://mail.test/message/7' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://other.test/' });
    t.run({ t: 'favorite.open', windowId: 'w1', favoriteId: 'fm' });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe(mail);
    // Nothing on that site any more: a new tab opens on the favorite's page.
    t.run({ t: 'tab.close', windowId: 'w1', nodeId: mail });
    t.run({ t: 'favorite.open', windowId: 'w1', favoriteId: 'fm' });
    const opened = t.state.nodes[t.state.windows['w1']!.activeTab['c1']!] as TabNode;
    expect(opened.url).toBe('https://mail.test/inbox');
  });
});

describe('moving tabs between chords', () => {
  const twoChords = (profile: string) => {
    const t = setup();
    t.state.chords['c2'] = { ...t.state.chords['c1']!, id: 'c2', name: 'Work', rank: 'b0', profileId: profile };
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    return t;
  };

  it('keeps the page when the sign-ins are the same, and the window lands on a neighbor', () => {
    const t = twoChords('default');
    const b = t.state.windows['w1']!.activeTab['c1']!;
    const moved = t.run({ t: 'node.moveToChord', nodeId: b, chordId: 'c2' });
    expect(t.state.nodes[b]).toMatchObject({ chordId: 'c2', section: 'today', parentId: null });
    expect(moved.effects).not.toContainEqual({ e: 'view.destroy', nodeId: b });
    expect(t.state.live[b]).toBeDefined();
    expect(t.state.windows['w1']!.activeTab['c1']).not.toBe(b);
  });

  it('closes the page when the sign-ins differ, and Undo puts it back exactly', () => {
    const t = twoChords('p-work');
    const b = t.state.windows['w1']!.activeTab['c1']!;
    const before = { ...(t.state.nodes[b] as TabNode) };
    const moved = t.run({ t: 'node.moveToChord', nodeId: b, chordId: 'c2' });
    expect(moved.effects).toContainEqual({ e: 'view.destroy', nodeId: b });
    expect(t.state.live[b]).toBeUndefined();
    t.run({ t: 'node.moveToChord', nodeId: b, chordId: 'c1', place: { section: before.section, parentId: before.parentId, rank: before.rank } });
    expect(t.state.nodes[b]).toMatchObject({ chordId: 'c1', rank: before.rank, section: 'today' });
  });
});

describe('the private line, and several windows', () => {
  const withPrivate = () => {
    const t = setup();
    t.state.chords['p'] = { ...t.state.chords['c1']!, id: 'p', name: 'Private', rank: 'z', profileId: 'private-w2', private: true };
    t.state.windows['w2'] = { id: 'w2', activeChordId: 'p', activeTab: { p: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null, private: true };
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w2', url: 'https://secret.test/' });
    return { t, normal: t.state.windows['w1']!.activeTab['c1']!, secret: t.state.windows['w2']!.activeTab['p']! };
  };

  it('keeps tabs from crossing into or out of a private chord', () => {
    const { t, normal, secret } = withPrivate();
    expect(t.run({ t: 'node.moveToChord', nodeId: normal, chordId: 'p' }).patches).toEqual([]);
    expect(t.run({ t: 'node.moveToChord', nodeId: secret, chordId: 'c1' }).patches).toEqual([]);
  });

  it('makes no folders or favorites from a private window, and pins nothing there', () => {
    const { t, secret } = withPrivate();
    expect(t.run({ t: 'folder.create', folderId: 'f', chordId: 'p', title: 'F', tabId: secret }).patches).toEqual([]);
    expect(t.run({ t: 'favorite.add', favoriteId: 'fav', nodeId: secret }).patches).toEqual([]);
    expect(t.run({ t: 'node.move', nodeId: secret, section: 'pinned', index: 0 }).patches).toEqual([]);
  });

  it('lands every window showing a tab that moves to other sign-ins, and closes its page once', () => {
    const t = setup();
    t.state.chords['c2'] = { ...t.state.chords['c1']!, id: 'c2', name: 'Work', rank: 'b0', profileId: 'p-work' };
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    const b = t.state.windows['w1']!.activeTab['c1']!;
    // A second window (⌘N) on the same chord, on the same tab.
    t.run({ t: 'window.create', windowId: 'w2', from: 'w1' });
    t.run({ t: 'tab.activate', windowId: 'w2', nodeId: b });
    expect(t.state.windows['w2']!.activeTab['c1']).toBe(b);
    const moved = t.run({ t: 'node.moveToChord', nodeId: b, chordId: 'c2' });
    expect(moved.effects.filter((e) => e.e === 'view.destroy')).toEqual([{ e: 'view.destroy', nodeId: b }]);
    for (const w of ['w1', 'w2']) {
      expect(t.state.windows[w]!.activeTab['c1']).not.toBe(b);
      expect(moved.effects).toContainEqual({ e: 'view.show', windowId: w, nodeId: t.state.windows[w]!.activeTab['c1'] });
    }
    // The page closed before either window showed its neighbor.
    const destroyAt = moved.effects.findIndex((e) => e.e === 'view.destroy');
    expect(moved.effects.findIndex((e) => e.e === 'view.show')).toBeGreaterThan(destroyAt);
  });
});

describe('Clear Today and its Undo', () => {
  it('archives Today and brings the same tabs back in place', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    const ids = children(t.state, 'c1', 'today', null).map((n) => n.id);
    const shown = t.state.windows['w1']!.activeTab['c1']!;
    t.run({ t: 'tab.archive', nodeIds: ids, reason: 'cleared' });
    expect(children(t.state, 'c1', 'today', null)).toEqual([]);
    const restored = t.run({ t: 'closed.restore', windowId: 'w1', nodeIds: ids, activate: shown });
    expect(children(t.state, 'c1', 'today', null).map((n) => n.id)).toEqual(ids);
    expect(t.state.windows['w1']!.activeTab['c1']).toBe(shown);
    expect(restored.effects.filter((e) => e.e === 'archive.restored')).toHaveLength(2);
    expect(t.state.closed).toEqual([]);
  });

  it('brings back every tab of a big Clear, not just the last 50 closed', () => {
    const t = setup();
    for (let i = 0; i < 120; i++) t.run({ t: 'tab.open', windowId: 'w1', url: `https://site.test/${i}`, background: true });
    const ids = children(t.state, 'c1', 'today', null).map((n) => n.id);
    expect(ids).toHaveLength(120);
    t.run({ t: 'tab.archive', nodeIds: ids, reason: 'cleared' });
    expect(children(t.state, 'c1', 'today', null)).toEqual([]);
    t.run({ t: 'closed.restore', windowId: 'w1', nodeIds: ids });
    expect(children(t.state, 'c1', 'today', null).map((n) => n.id)).toEqual(ids);
  });
});
