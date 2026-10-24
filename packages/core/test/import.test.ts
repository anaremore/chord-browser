import { describe, expect, it } from 'vitest';
import {
  addDecay,
  apply,
  children,
  decayOfVisits,
  defaultChoices,
  emptyState,
  frecencyOn,
  IMPORT_FAVORITES,
  importContext,
  importGroups,
  planImport,
  sortedChords,
  sortedFavorites,
  tabsInOrder,
  used,
  type BookmarkItem,
  type Command,
  type Context,
  type ImportChoices,
  type ImportPreview,
  type State,
} from '../src';

const DAY = 86_400_000;
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

function setup(): { state: State; ctx: Context; run: (cmd: Command) => ReturnType<typeof apply> } {
  let n = 0;
  const ctx: Context = { now: 5_000, newId: () => `id-${String(++n).padStart(4, '0')}` };
  const box = { state: emptyState() };
  box.state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme: THEME, rank: 'a0', createdAt: 0 };
  box.state.nodes['t1'] = {
    kind: 'tab',
    id: 't1',
    chordId: 'c1',
    section: 'pinned',
    parentId: null,
    rank: 'a0',
    url: 'https://mail.test/',
    title: 'Mail',
    pinnedUrl: 'https://mail.test/',
    customTitle: null,
    favicon: null,
    lastActiveAt: 0,
    createdAt: 0,
  };
  box.state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: 't1' }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
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

const link = (title: string, url: string): BookmarkItem => ({ kind: 'link', title, url });
const folder = (title: string, items: BookmarkItem[]): BookmarkItem => ({ kind: 'folder', title, items });

const preview = (): ImportPreview => ({
  roots: [
    {
      kind: 'bar',
      title: 'Bookmarks bar',
      items: [
        link('News', 'https://news.test/'),
        folder('Work', [link('Tracker', 'https://tracker.test/'), folder('Docs', [link('Spec', 'https://docs.test/spec')]), folder('Empty', [])]),
        link('Bookmarklet', 'javascript:alert(1)'),
        link('Forum', 'https://forum.test/'),
      ],
    },
    { kind: 'other', title: 'Other bookmarks', items: [link('Recipe', 'https://food.test/pie'), folder('Travel', [link('Maps', 'https://maps.test/')])] },
  ],
  tabs: [
    { url: 'https://open.test/a', title: 'A' },
    { url: 'about:blank', title: '' },
    { url: 'https://open.test/b', title: 'B' },
    { url: 'https://open.test/a', title: 'A again' },
  ],
  history: 3,
});

const plan = (state: State, choices: ImportChoices, id = 'imp-1') => {
  let n = 0;
  return planImport(importContext(state), preview(), choices, { importId: id, now: 7_000, newId: () => `${id}-${++n}`, themes: [THEME], fallbackChordId: 'c1' });
};

describe('import mapping', () => {
  it('offers the bar’s own links, each top-level folder, and other roots’ own links, leaving out what’s empty or not a web address', () => {
    expect(importGroups(preview())).toEqual([
      { id: 'r0', kind: 'bar', title: 'Bookmarks bar', links: 2 },
      { id: 'r0/1', kind: 'folder', title: 'Work', links: 2 },
      { id: 'r1/1', kind: 'folder', title: 'Travel', links: 1 },
      { id: 'r1', kind: 'loose', title: 'Other bookmarks', links: 1 },
    ]);
    expect(defaultChoices(preview(), 'c1')).toEqual({
      groups: { r0: 'favorites', 'r0/1': 'new', 'r1/1': 'new', r1: 'chord:c1' },
      tabs: 'chord:c1',
      history: true,
    });
  });

  it('makes a chord of a folder (its contents become Pinned), or a closed pinned folder in a chord you have', () => {
    const t = setup();
    const p = plan(t.state, { groups: { 'r0/1': 'new', 'r1/1': 'chord:c1', r1: 'chord:c1' }, tabs: 'skip', history: false });
    expect(p.chords.map((c) => [c.name, c.icon])).toEqual([['Work', 'W']]);
    const work = p.chords[0]!.id;
    const top = p.nodes.filter((n) => n.parentId === null);
    // Work's own links and folders sit at the top of its Pinned; the empty folder is left out.
    expect(top.filter((n) => n.chordId === work).map((n) => (n.kind === 'tab' ? n.title : `[${n.kind === 'folder' ? n.title : ''}]`))).toEqual(['Tracker', '[Docs]']);
    // Travel and Other bookmarks land after Mail, in order, as closed folders.
    const inPersonal = top.filter((n) => n.chordId === 'c1');
    expect(inPersonal.map((n) => n.kind === 'folder' && [n.title, n.collapsed])).toEqual([
      ['Travel', true],
      ['Other bookmarks', true],
    ]);
    expect(inPersonal[0]!.rank > 'a0' && inPersonal[1]!.rank > inPersonal[0]!.rank).toBe(true);
    expect(p.counts).toEqual({ bookmarks: 4, folders: 3, tabs: 0, chords: 1, favorites: 0 });
    // Parents come before their children.
    const seen = new Set<string>();
    for (const node of p.nodes) {
      if (node.parentId) expect(seen.has(node.parentId)).toBe(true);
      seen.add(node.id);
    }
  });

  it('puts the bar’s links in Favorites up to the cap, skipping ones you have, and the rest in a folder', () => {
    const t = setup();
    t.state.favorites['f1'] = { id: 'f1', url: 'https://news.test/', title: 'News', favicon: null, rank: 'a0', createdAt: 0 };
    const many: ImportPreview = { roots: [{ kind: 'bar', title: 'Favorites bar', items: Array.from({ length: 30 }, (_, i) => link(`Site ${i}`, `https://s${i}.test/`)) }], tabs: null, history: 0 };
    let n = 0;
    const p = planImport(importContext(t.state), many, { groups: { r0: 'favorites' }, tabs: 'skip', history: false }, { importId: 'i', now: 1, newId: () => `n${++n}`, themes: [THEME], fallbackChordId: 'c1' });
    expect(p.favorites).toHaveLength(IMPORT_FAVORITES);
    expect(p.favorites[0]!.rank > 'a0').toBe(true);
    const overflow = p.nodes.find((x) => x.kind === 'folder')!;
    expect(overflow.kind === 'folder' && overflow.title).toBe('Favorites bar');
    expect(p.nodes.filter((x) => x.parentId === overflow.id)).toHaveLength(30 - IMPORT_FAVORITES);
  });

  it('brings open tabs to the top of a chord’s Today, once each, web pages only', () => {
    const t = setup();
    const p = plan(t.state, { groups: {}, tabs: 'chord:c1', history: false });
    expect(p.nodes.map((n) => n.kind === 'tab' && [n.section, n.url])).toEqual([
      ['today', 'https://open.test/a'],
      ['today', 'https://open.test/b'],
    ]);
  });

  it('plans from a small summary of the state (where each chord’s Pinned ends and Today starts), which never has a private chord', () => {
    const t = setup();
    t.run({ t: 'window.create', windowId: 'pw', privateChordId: 'secret' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    const context = importContext(t.state);
    expect(context.chords.map((c) => c.id)).toEqual(['c1']);
    expect(context.pinnedEnd).toEqual({ c1: 'a0' });
    expect(context.todayStart).toEqual({ c1: children(t.state, 'c1', 'today', null)[0]!.rank });
    expect(context.separateSignIns).toBe(false);
  });

  it('never lands anything in a private window’s chord, or a chord that isn’t there', () => {
    const t = setup();
    t.run({ t: 'window.create', windowId: 'pw', privateChordId: 'secret' });
    const p = plan(t.state, { groups: { 'r0/1': 'chord:secret', 'r1/1': 'chord:gone', r0: 'chord:secret' }, tabs: 'chord:secret', history: false });
    expect(p.nodes).toEqual([]);
    // And the reducer refuses it too, whatever main sends.
    t.run({ t: 'import.add', importId: 'x', nodes: [{ ...(t.state.nodes['t1'] as never as object), id: 'sneak', chordId: 'secret', section: 'today' } as never] });
    expect(t.state.nodes['sneak']).toBeUndefined();
  });
});

describe('import reducer', () => {
  it('adds an import in parts, loading nothing, and Undo takes all of it away', () => {
    const t = setup();
    const before = t.state;
    const p = plan(t.state, { groups: { r0: 'favorites', 'r0/1': 'new', 'r1/1': 'chord:c1', r1: 'chord:c1' }, tabs: 'chord:c1', history: false });
    const first = t.run({ t: 'import.add', importId: p.importId, chords: p.chords, favorites: p.favorites, nodes: p.nodes.slice(0, 3) });
    t.run({ t: 'import.add', importId: p.importId, nodes: p.nodes.slice(3) });
    expect(first.effects).toEqual([]);
    expect(Object.keys(t.state.live)).toEqual([]);
    expect(sortedChords(t.state).map((c) => c.name)).toEqual(['Personal', 'Work']);
    expect(sortedFavorites(t.state).map((f) => f.url)).toEqual(['https://news.test/', 'https://forum.test/']);
    expect(children(t.state, 'c1', 'today', null)).toHaveLength(2);
    expect(Object.keys(t.state.nodes)).toHaveLength(1 + p.nodes.length);
    // The window stays where it was.
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t1');

    // Undo while the window is on the new chord, looking at one of the open tabs in Personal.
    const work = p.chords[0]!.id;
    t.run({ t: 'chord.activate', windowId: 'w1', chordId: work });
    t.run({ t: 'import.undo', importId: p.importId });
    expect(t.state.chords).toEqual(before.chords);
    expect(Object.keys(t.state.nodes)).toEqual(Object.keys(before.nodes));
    expect(t.state.favorites).toEqual({});
    expect(t.state.imports).toEqual({});
    expect(t.state.windows['w1']!.activeChordId).toBe('c1');
    expect(tabsInOrder(t.state, 'c1').map((x) => x.id)).toEqual(['t1']);
  });

  it('Undo in parts takes the innermost first, never leaving anything without its folder, and the chords last', () => {
    const t = setup();
    const p = plan(t.state, { groups: { 'r0/1': 'new', 'r1/1': 'chord:c1', r1: 'chord:c1' }, tabs: 'chord:c1', history: false });
    t.run({ t: 'import.add', importId: p.importId, chords: p.chords, nodes: p.nodes });
    const total = p.nodes.length;
    let parts = 0;
    while (t.state.imports[p.importId]) {
      t.run({ t: 'import.undo', importId: p.importId, limit: 2 });
      parts++;
      for (const node of Object.values(t.state.nodes)) if (node.parentId) expect(t.state.nodes[node.parentId]).toBeDefined();
      if (t.state.imports[p.importId]) expect(t.state.chords[p.chords[0]!.id]).toBeDefined();
    }
    expect(parts).toBe(Math.ceil(total / 2));
    expect(Object.keys(t.state.nodes)).toEqual(['t1']);
    expect(Object.keys(t.state.chords)).toEqual(['c1']);
  });

  it('Undo leaves no split of one: an imported tab joined with one of yours', () => {
    const t = setup();
    const p = plan(t.state, { groups: {}, tabs: 'chord:c1', history: false });
    t.run({ t: 'import.add', importId: p.importId, nodes: p.nodes });
    const imported = children(t.state, 'c1', 'today', null)[0]!.id;
    t.run({ t: 'tab.unpin', nodeId: 't1' });
    t.run({ t: 'split.join', windowId: 'w1', splitId: 'sp', nodeIds: ['t1', imported], direction: 'row' });
    expect(t.state.nodes['sp']).toBeDefined();
    t.run({ t: 'import.undo', importId: p.importId });
    expect(t.state.nodes['sp']).toBeUndefined();
    expect(t.state.nodes['t1']).toMatchObject({ parentId: null });
  });

  it('Undo moves a window off an imported tab it shows, and closes its page', () => {
    const t = setup();
    const p = plan(t.state, { groups: {}, tabs: 'chord:c1', history: false });
    t.run({ t: 'import.add', importId: p.importId, nodes: p.nodes });
    const opened = children(t.state, 'c1', 'today', null)[0]!.id;
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: opened });
    t.run({ t: 'tab.live', nodeId: opened, live: { loading: true } });
    const undo = t.run({ t: 'import.undo', importId: p.importId });
    expect(undo.effects).toContainEqual({ e: 'view.destroy', nodeId: opened });
    expect(t.state.windows['w1']!.activeTab['c1']).toBe('t1');
  });
});

describe('import frecency', () => {
  it('scores many visits at once the way one visit at a time does', () => {
    const now = 1_700_000_000_000;
    const visits = [now - 40 * DAY, now - 3 * DAY, now - DAY, now];
    let one: number | null = null;
    for (const at of visits) one = used(one, at);
    expect(decayOfVisits(visits, now)).toBeCloseTo(one!, 9);
    expect(decayOfVisits([], now)).toBeNull();
    // Added to what Chord already had: the scores sum.
    const mine = used(null, now - 10 * DAY);
    expect(frecencyOn(addDecay(mine, one!, now), now)).toBeCloseTo(frecencyOn(mine, now) + frecencyOn(one!, now), 9);
  });
});
