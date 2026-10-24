import { describe, expect, it } from 'vitest';
import {
  apply,
  emptyState,
  isCrossSite,
  restoreState,
  routeCovers,
  routeFor,
  routeHost,
  routeKey,
  siteOf,
  tabsInOrder,
  type Chord,
  type Command,
  type Context,
  type PersistedState,
  type State,
} from '../src';

const chord = (id: string, name: string, extra: Partial<Chord> = {}): Chord => ({
  id,
  profileId: 'default',
  name,
  icon: '✦',
  theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' },
  rank: id,
  createdAt: 0,
  ...extra,
});

function setup() {
  let n = 0;
  let now = 1_000;
  const ctx: Context = {
    get now() {
      return now++;
    },
    newId: () => `id-${String(++n).padStart(3, '0')}`,
  };
  const box = { state: emptyState() };
  box.state.chords['c1'] = chord('c1', 'Personal');
  box.state.chords['c2'] = chord('c2', 'Work');
  box.state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null, c2: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const run = (cmd: Command) => {
    const result = apply(box.state, cmd, ctx);
    box.state = result.state;
    return result;
  };
  return {
    get state(): State {
      return box.state;
    },
    run,
  };
}

describe('sites', () => {
  it('groups hosts by their registrable domain', () => {
    expect(siteOf('docs.google.com')).toBe('google.com');
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('alice.github.io')).toBe('alice.github.io');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('localhost')).toBe('localhost');
  });

  it('counts a link as leaving only when it goes to another site', () => {
    expect(isCrossSite('https://docs.google.com/a', 'https://mail.google.com/b')).toBe(false);
    expect(isCrossSite('https://github.com/x', 'https://linear.app/y')).toBe(true);
    expect(isCrossSite('http://127.0.0.1:8080/', 'http://localhost:8080/')).toBe(true);
    expect(isCrossSite('https://github.com/', 'mailto:a@example.com')).toBe(false);
  });
});

describe('link routes', () => {
  it('reads a typed site as the host it matches', () => {
    expect(routeHost('https://www.GitHub.com/anaremore')).toBe('github.com');
    expect(routeHost('linear.app')).toBe('linear.app');
    expect(routeHost('localhost')).toBe('localhost');
    expect(routeHost('not a site')).toBeNull();
    expect(routeHost('intranet')).toBeNull();
    expect(routeHost('')).toBeNull();
  });

  it('keys a route by its site and, when given, its path', () => {
    expect(routeKey('github.com')).toBe('github.com');
    expect(routeKey('https://www.GitHub.com/')).toBe('github.com');
    expect(routeKey('github.com/Acme/*')).toBe('github.com/acme');
    expect(routeKey('https://github.com/acme/?tab=repositories#top')).toBe('github.com/acme');
    expect(routeKey('github.com/acme/chord/')).toBe('github.com/acme/chord');
    expect(routeKey('not a site/acme')).toBeNull();
  });

  it('covers the host, www and subdomains, but not lookalikes', () => {
    expect(routeCovers('github.com', 'github.com')).toBe(true);
    expect(routeCovers('github.com', 'www.github.com')).toBe(true);
    expect(routeCovers('github.com', 'gist.github.com')).toBe(true);
    expect(routeCovers('github.com', 'notgithub.com')).toBe(false);
    // With a path: that path and below it, any case; not a longer name that starts the same.
    expect(routeCovers('github.com/acme', 'github.com', '/acme')).toBe(true);
    expect(routeCovers('github.com/acme', 'github.com', '/ACME/chord/pulls')).toBe(true);
    expect(routeCovers('github.com/acme', 'github.com', '/acmecorp')).toBe(false);
    expect(routeCovers('github.com/acme', 'github.com', '/')).toBe(false);
    expect(routeCovers('github.com/acme', 'gist.github.com', '/acme/1')).toBe(true);
  });

  it('picks the most specific route, and only to a chord that can take it', () => {
    const t = setup();
    t.run({ t: 'linkRoute.set', host: 'google.com', chordId: 'c1' });
    t.run({ t: 'linkRoute.set', host: 'https://docs.google.com/', chordId: 'c2' });
    expect(routeFor(t.state, 'https://docs.google.com/d/1')).toBe('c2');
    expect(routeFor(t.state, 'https://mail.google.com/')).toBe('c1');
    expect(routeFor(t.state, 'https://example.com/')).toBeNull();
    // A path's route beats its site's: one organization's GitHub to Work, the rest of GitHub elsewhere.
    t.run({ t: 'linkRoute.set', host: 'github.com', chordId: 'c1' });
    t.run({ t: 'linkRoute.set', host: 'github.com/acme/*', chordId: 'c2' });
    expect(Object.keys(t.state.linkRoutes)).toContain('github.com/acme');
    expect(routeFor(t.state, 'https://github.com/acme/chord/pull/7')).toBe('c2');
    expect(routeFor(t.state, 'https://github.com/someone-else')).toBe('c1');
    t.run({ t: 'linkRoute.delete', host: 'github.com/acme' });
    expect(routeFor(t.state, 'https://github.com/acme/chord')).toBe('c1');
    // Not a route to a private window's chord.
    t.run({ t: 'linkRoute.set', host: 'secret.example', chordId: 'c2' });
    const withPrivate = { ...t.state, chords: { ...t.state.chords, c2: { ...t.state.chords['c2']!, private: true } } };
    expect(routeFor(withPrivate, 'https://secret.example/')).toBeNull();
  });

  it('sends a typed address to its route’s chord, and the window goes there', () => {
    const t = setup();
    t.run({ t: 'linkRoute.set', host: 'linear.app', chordId: 'c2' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://linear.app/team', route: true });
    expect(tabsInOrder(t.state, 'c2').map((tab) => tab.url)).toEqual(['https://linear.app/team']);
    expect(t.state.windows['w1']!.activeChordId).toBe('c2');
    // Without `route` (a link in a page), it stays where it was opened.
    t.run({ t: 'chord.activate', windowId: 'w1', chordId: 'c1' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://linear.app/other' });
    expect(tabsInOrder(t.state, 'c1').map((tab) => tab.url)).toEqual(['https://linear.app/other']);
  });

  it('replaces a site’s route, and forgets it', () => {
    const t = setup();
    t.run({ t: 'linkRoute.set', host: 'github.com', chordId: 'c1' });
    t.run({ t: 'linkRoute.set', host: 'github.com', chordId: 'c2' });
    expect(Object.values(t.state.linkRoutes)).toEqual([{ host: 'github.com', chordId: 'c2', createdAt: expect.any(Number) }]);
    t.run({ t: 'linkRoute.delete', host: 'github.com' });
    expect(t.state.linkRoutes).toEqual({});
  });

  it('drops routes whose chord is gone when restoring', () => {
    const saved: PersistedState = {
      chords: [chord('c1', 'Personal')],
      nodes: [],
      windows: [],
      settings: {},
      linkRoutes: [
        { host: 'github.com', chordId: 'c1', createdAt: 5 },
        { host: 'linear.app', chordId: 'gone', createdAt: 6 },
        { host: 'WWW.Bad Host', chordId: 'c1', createdAt: 7 },
      ],
    };
    const state = restoreState(saved, { now: 1, newId: () => 'w', theme: chord('x', 'x').theme, homeUrl: 'https://home.test/' });
    expect(Object.keys(state.linkRoutes)).toEqual(['github.com']);
  });
});

describe('tab.adopt', () => {
  it('makes a page that wasn’t a tab (Peek, a mini window) the top of a chord’s Today, shown in the window', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    const result = t.run({
      t: 'tab.adopt',
      windowId: 'w1',
      nodeId: 'peek-1',
      chordId: 'c2',
      url: 'https://b.test/page',
      title: 'B',
      live: { canGoBack: true },
    });
    expect(tabsInOrder(t.state, 'c2').map((tab) => tab.id)).toEqual(['peek-1']);
    expect(t.state.windows['w1']!.activeChordId).toBe('c2');
    expect(t.state.live['peek-1']).toMatchObject({ canGoBack: true, loading: false });
    expect(result.effects).toContainEqual({ e: 'view.show', windowId: 'w1', nodeId: 'peek-1' });
    // The same page can't become two tabs.
    expect(t.run({ t: 'tab.adopt', windowId: 'w1', nodeId: 'peek-1', url: 'https://b.test/', title: '' }).patches).toEqual([]);
  });

  it('never lands in a chord the window can’t show', () => {
    const t = setup();
    expect(t.run({ t: 'tab.adopt', windowId: 'w1', nodeId: 'x', chordId: 'missing', url: 'https://b.test/', title: '' }).patches).toEqual([]);
  });

  it('lands above the Today tabs already there, in the window’s chord by default', () => {
    const t = setup();
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://a.test/' });
    t.run({ t: 'tab.open', windowId: 'w1', url: 'https://b.test/' });
    t.run({ t: 'tab.adopt', windowId: 'w1', nodeId: 'mini-1', url: 'https://c.test/', title: 'C' });
    expect(tabsInOrder(t.state, 'c1').map((tab) => tab.url)).toEqual(['https://c.test/', 'https://b.test/', 'https://a.test/']);
  });

  it('keeps a private window’s Peek in its own chord, and nothing crosses the private line', () => {
    const t = setup();
    t.run({ t: 'window.create', windowId: 'pw', privateChordId: 'pc' });
    t.run({ t: 'tab.adopt', windowId: 'pw', nodeId: 'peek-p', chordId: 'pc', url: 'https://b.test/', title: '' });
    expect(t.state.nodes['peek-p']).toMatchObject({ chordId: 'pc', section: 'today' });
    // Not into a normal chord from a private window, nor into the private chord from a normal one.
    expect(t.run({ t: 'tab.adopt', windowId: 'pw', nodeId: 'x', chordId: 'c1', url: 'https://b.test/', title: '' }).patches).toEqual([]);
    expect(t.run({ t: 'tab.adopt', windowId: 'w1', nodeId: 'y', chordId: 'pc', url: 'https://b.test/', title: '' }).patches).toEqual([]);
  });
});

describe('external links setting', () => {
  it('chooses where links from other apps open, and remembers the mini window’s size within bounds', () => {
    const t = setup();
    expect(t.state.settings.externalLinks).toBe('mini');
    t.run({ t: 'settings.set', settings: { externalLinks: 'tab', miniWindowSize: { width: 120, height: 9000 } } });
    expect(t.state.settings.externalLinks).toBe('tab');
    expect(t.state.settings.miniWindowSize).toEqual({ width: 360, height: 4000 });
  });
});
