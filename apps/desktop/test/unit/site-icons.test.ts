/**
 * The tabs-with-an-icon index (main/site-icons.ts) a tab arriving on a site
 * reads its icon from: kept up to date from the buckets that changed.
 */
import { emptyState, nodeOf, setNode, type SidebarNode, type State, type TabNode } from '@chord/core';
import { freeze, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { iconOn, LOOK_BUCKETS, TabIconIndex, tabSite } from '../../src/main/site-icons';

function tab(id: string, url: string, favicon: string | null): TabNode {
  return { kind: 'tab', id, chordId: 'c1', section: 'today', parentId: null, rank: `a${id}`, url, title: id, pinnedUrl: null, customTitle: null, favicon, lastActiveAt: 0, createdAt: 0 };
}

type Step = (draft: State) => void;
const add =
  (node: SidebarNode): Step =>
  (draft) =>
    setNode(draft, node);
const change =
  (id: string, fields: Partial<TabNode>): Step =>
  (draft) =>
    void Object.assign(nodeOf(draft, id)!, fields);
const remove =
  (id: string): Step =>
  (draft) => {
    for (const bucket of Object.values(draft.nodes)) delete bucket[id];
  };

/** The tabs (by id) the index gives for `site` after the steps. */
const cases: { name: string; steps: Step[]; site: string; tabs: string[] }[] = [
  { name: 'a tab with an icon is found', steps: [add(tab('t1', 'https://a.test/x', 'icon-a'))], site: 'https://a.test', tabs: ['t1'] },
  { name: 'a tab without one is not', steps: [add(tab('t1', 'https://a.test/x', null))], site: 'https://a.test', tabs: [] },
  { name: 'the site page itself counts', steps: [add(tab('t1', 'https://a.test', 'icon-a'))], site: 'https://a.test', tabs: ['t1'] },
  { name: 'another site is not it', steps: [add(tab('t1', 'https://a.test.evil/x', 'icon-a'))], site: 'https://a.test', tabs: [] },
  { name: 'pages of Chord are no site', steps: [add(tab('t1', 'chord://archive', 'icon'))], site: 'chord://archive', tabs: [] },
  { name: 'an icon that arrives later', steps: [add(tab('t1', 'https://a.test/x', null)), change('t1', { favicon: 'icon-a' })], site: 'https://a.test', tabs: ['t1'] },
  { name: 'an icon that changes', steps: [add(tab('t1', 'https://a.test/x', 'old')), change('t1', { favicon: 'new' })], site: 'https://a.test', tabs: ['t1'] },
  { name: 'an icon that goes', steps: [add(tab('t1', 'https://a.test/x', 'old')), change('t1', { favicon: null })], site: 'https://a.test', tabs: [] },
  { name: 'a tab gone to another site leaves the first', steps: [add(tab('t1', 'https://a.test/x', 'icon-a')), change('t1', { url: 'https://b.test/' })], site: 'https://a.test', tabs: [] },
  { name: 'a tab gone to another site is on the second', steps: [add(tab('t1', 'https://a.test/x', 'icon-a')), change('t1', { url: 'https://b.test/' })], site: 'https://b.test', tabs: ['t1'] },
  { name: 'a closed tab goes', steps: [add(tab('t1', 'https://a.test/x', 'icon-a')), remove('t1')], site: 'https://a.test', tabs: [] },
  {
    name: 'a site with several tabs',
    steps: [add(tab('t1', 'https://a.test/1', 'icon-a')), add(tab('t2', 'https://a.test/2', 'icon-a')), add(tab('t3', 'https://a.test/3', null))],
    site: 'https://a.test',
    tabs: ['t1', 't2'],
  },
  {
    name: 'one of several closed: the rest stay',
    steps: [add(tab('t1', 'https://a.test/1', 'icon-a')), add(tab('t2', 'https://a.test/2', 'icon-a')), remove('t1')],
    site: 'https://a.test',
    tabs: ['t2'],
  },
  {
    name: 'one of several gone elsewhere: the rest stay',
    steps: [add(tab('t1', 'https://a.test/1', 'icon-a')), add(tab('t2', 'https://a.test/2', 'icon-a')), change('t2', { url: 'https://b.test/' })],
    site: 'https://a.test',
    tabs: ['t1'],
  },
  {
    name: 'every one of several closed',
    steps: [add(tab('t1', 'https://a.test/1', 'icon-a')), add(tab('t2', 'https://a.test/2', 'icon-a')), remove('t1'), remove('t2')],
    site: 'https://a.test',
    tabs: [],
  },
];

describe('TabIconIndex', () => {
  it.each(cases)('$name (read after every step)', ({ steps, site, tabs }) => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    for (const step of steps) {
      // Read in between, so each step is caught up from the one before, not read anew.
      void [...index.tabsOn(site)];
      state = produce(state, step);
    }
    const found = [...index.tabsOn(site)];
    expect(found.map((t) => t.id).sort()).toEqual(tabs);
    // The state's own tab, with its icon as it is now.
    for (const t of found) expect(t).toBe(nodeOf(state, t.id));
  });

  it.each(cases)('$name (read only at the end)', ({ steps, site, tabs }) => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    for (const step of steps) state = produce(state, step);
    expect([...index.tabsOn(site)].map((t) => t.id).sort()).toEqual(tabs);
  });

  it.each(cases)('$name (caught up a bucket at a time)', ({ steps, site, tabs }) => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    for (const step of steps) state = produce(state, step);
    let looks = 0;
    while (!index.catchUp(1)) looks++;
    expect(looks).toBeLessThanOrEqual(256);
    expect([...index.known(site)].map((t) => t.id).sort()).toEqual(tabs);
  });

  it('a limited look reads only so many buckets, and goes by what it has read so far', () => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    expect(index.catchUp()).toBe(true);
    // Tabs in many buckets: one look of 4 can't read them all.
    state = produce(state, (draft) => {
      for (let i = 0; i < 64; i++) setNode(draft, tab(`t${i}`, `https://a.test/${i}`, 'icon-a'));
    });
    expect(index.catchUp(4)).toBe(false);
    const partly = [...index.known('https://a.test')].length;
    expect(partly).toBeGreaterThan(0);
    expect(partly).toBeLessThan(64);
    expect(index.catchUp()).toBe(true);
    expect([...index.known('https://a.test')]).toHaveLength(64);
  });

  it('catching up in slices: a slice a turn, one run at a time, to the newest state', () => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    index.catchUp();
    state = produce(state, (draft) => {
      for (let i = 0; i < 64; i++) setNode(draft, tab(`t${i}`, `https://a.test/${i}`, 'icon-a'));
    });
    const turns: (() => void)[] = [];
    const next = (step: () => void) => turns.push(step);
    index.catchUpInSlices(4, next);
    // Nothing runs on the caller's turn.
    expect([...index.known('https://a.test')]).toHaveLength(0);
    // Asked again while it runs: still one run.
    index.catchUpInSlices(4, next);
    expect(turns).toHaveLength(1);
    let ran = 0;
    while (turns.length > 0) {
      turns.shift()!();
      ran++;
      // A change meanwhile is caught up too.
      if (ran === 2) state = produce(state, add(tab('late', 'https://a.test/late', 'icon-a')));
    }
    expect(ran).toBeGreaterThan(1);
    expect([...index.known('https://a.test')]).toHaveLength(65);
    expect(index.catchUp(0)).toBe(true);
  });

  it('a site with no tabs left goes from the index', () => {
    let state: State = freeze(emptyState(), true);
    const index = new TabIconIndex(() => state);
    state = produce(state, add(tab('t1', 'https://a.test/x', 'icon-a')));
    expect(index.size).toBe(1);
    state = produce(state, remove('t1'));
    expect(index.size).toBe(0);
  });
});

describe("iconOn: a navigation's look", () => {
  const site = 'https://example.test';
  const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.35, appearance: 'auto' as const };
  /** Your chord, and a private window's: its tabs spread over many buckets, a few on the site. */
  function start(): State {
    const state = emptyState();
    state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'You', icon: 'Y', theme, rank: 'a0', createdAt: 0 };
    state.chords['p1'] = { id: 'p1', profileId: 'private-1', name: 'Private', icon: 'P', theme, rank: 'a1', createdAt: 0, private: true } as State['chords'][string];
    for (let i = 0; i < 40; i++) setNode(state, { ...tab(`p${i}`, i % 3 === 0 ? `${site}/${i}` : `https://other${i}.test/`, 'private-icon'), chordId: 'p1' });
    return freeze(state, true);
  }
  const closePrivate: Step = (draft) => {
    for (let i = 0; i < 40; i++) remove(`p${i}`)(draft);
    delete draft.chords['p1'];
  };
  const yours = (id: string, url: string, icon: string): Step => add({ ...tab(id, url, icon), chordId: 'c1' });

  /** `read`: changes the index has caught up with; `since`: changes made after, all at once, before the look. */
  const cases: { name: string; read: Step[]; since: Step[]; found: string | null }[] = [
    { name: 'a closed private window lends nothing to the default profile', read: [], since: [closePrivate], found: null },
    { name: 'an open private window lends nothing either', read: [], since: [], found: null },
    { name: 'your own tab there is found', read: [yours('y1', `${site}/a`, 'your-icon')], since: [], found: 'your-icon' },
    { name: 'your tab, found once the private window closed', read: [yours('y1', `${site}/a`, 'your-icon')], since: [closePrivate], found: 'your-icon' },
    { name: 'your tab gone elsewhere since', read: [yours('y1', `${site}/a`, 'your-icon')], since: [change('y1', { url: 'https://elsewhere.test/' }), closePrivate], found: null },
    { name: 'your tab closed since', read: [yours('y1', `${site}/a`, 'your-icon')], since: [remove('y1'), closePrivate], found: null },
    { name: 'your new tab, not read yet', read: [], since: [closePrivate, yours('y1', `${site}/a`, 'your-icon')], found: null },
  ];

  it.each(cases)('$name', ({ read, since, found }) => {
    let state = start();
    const index = new TabIconIndex(() => state);
    for (const step of read) state = produce(state, step);
    index.catchUp();
    for (const step of since) state = produce(state, step);
    // As browser.ts's sessionFor: a chord gone passes for the default profile's.
    const node = iconOn(index, state, site, (n) => (state.chords[n.chordId]?.profileId ?? 'default') === 'default');
    expect(node?.favicon ?? null).toBe(found);
    if (node) expect(node).toBe(nodeOf(state, node.id));
  });

  it("the closed private window's tabs are still in what the index has read: the check, not the index, keeps them out", () => {
    let state = start();
    const index = new TabIconIndex(() => state);
    index.catchUp();
    state = produce(state, closePrivate);
    expect(iconOn(index, state, site, (n) => (state.chords[n.chordId]?.profileId ?? 'default') === 'default')).toBeNull();
    // Only LOOK_BUCKETS read: stale private tabs are left (the rest go in slices, on later turns).
    expect([...index.known(site)].length).toBeGreaterThan(0);
    expect(LOOK_BUCKETS).toBeLessThan(40);
  });
});

describe('tabSite', () => {
  it.each([
    ['https://a.test/x?y#z', 'https://a.test'],
    ['https://a.test', 'https://a.test'],
    ['http://a.test:8080/', 'http://a.test:8080'],
    ['https://a.test?q', 'https://a.test'],
    ['chord://archive', null],
    ['about:blank', null],
    ['file:///C:/x.pdf', null],
  ])('%s: %s', (url, site) => expect(tabSite(url)).toBe(site));
});
