/**
 * The tabs-with-an-icon index (main/site-icons.ts) a tab arriving on a site
 * reads its icon from: kept up to date from the buckets that changed.
 */
import { emptyState, nodeOf, setNode, type SidebarNode, type State, type TabNode } from '@chord/core';
import { freeze, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { TabIconIndex, tabSite } from '../../src/main/site-icons';

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
