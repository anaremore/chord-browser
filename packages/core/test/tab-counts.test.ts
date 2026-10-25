import { describe, expect, it } from 'vitest';
import {
  appCount,
  chordsWithCounts,
  cleanCountSites,
  countShows,
  countSite,
  countText,
  countWithin,
  unreadWords,
  apply,
  emptyState,
  IDLE_LIVE,
  pageBadge,
  restoreState,
  sumCounts,
  type State,
} from '../src';

describe('pageBadge: what Chord takes from a page’s preload', () => {
  it.each([
    [3, 3],
    [0, null],
    [null, null],
    ['dot', 'dot'],
    [1_000_000, 1_000_000],
    // Never from Chord's preload; ignored.
    [-1, undefined],
    [2.5, undefined],
    [Number.NaN, undefined],
    ['3', undefined],
    [{}, undefined],
    [undefined, undefined],
  ])('%j → %j', (raw, badge) => {
    expect(pageBadge(raw)).toBe(badge);
  });
});

describe('which counts show', () => {
  const on = { enabled: true, offSites: ['mail.google.com', 'example.org'] };
  it.each([
    ['https://web.telegram.org/a/', on, true],
    ['https://mail.google.com/mail/u/0/', on, false],
    // Google Chat, on another host, still shows.
    ['https://chat.google.com/', on, true],
    // A host under one in the list is hidden with it.
    ['https://www.example.org/inbox', on, false],
    ['https://sub.example.org/', on, false],
    ['https://notexample.org/', on, true],
    ['https://web.telegram.org/a/', { enabled: false, offSites: [] }, false],
  ])('%s → %s', (url, settings, shows) => {
    expect(countShows(url, settings)).toBe(shows);
  });

  it('keeps hosts as typed or taken from an address: lower case, no www, no repeats, nothing else', () => {
    expect(countSite('https://WWW.Example.org/x')).toBe('example.org');
    expect(countSite('mail.google.com')).toBe('mail.google.com');
    expect(cleanCountSites(['mail.google.com', 'https://mail.google.com/', 'not a site', 42, 'x'.repeat(400)])).toEqual(['mail.google.com']);
  });
});

describe('adding up counts', () => {
  it.each([
    [[3, 4], 7],
    [[3, 'dot'], 3],
    [['dot', null], 'dot'],
    [[null, undefined], null],
    [[], null],
  ] as const)('%j → %j', (counts, sum) => {
    expect(sumCounts(counts)).toBe(sum);
  });

  it.each([
    [3, '3', '3 unread'],
    [99, '99', '99 unread'],
    [250, '99+', 'more than 99 unread'],
    ['dot', '', 'unread'],
    [null, '', ''],
  ] as const)('%j reads "%s", heard as "%s"', (count, text, words) => {
    expect(countText(count)).toBe(text);
    expect(unreadWords(count)).toBe(words);
  });
});

describe('counts in the sidebar', () => {
  const tab = (id: string, chordId: string, section: 'pinned' | 'today', parentId: string | null, url: string) =>
    ({ kind: 'tab', id, chordId, section, parentId, rank: 'a0', url, title: id, pinnedUrl: null, customTitle: null, favicon: null, lastActiveAt: 0, createdAt: 0 }) as const;
  /** Personal: a pinned folder holding Telegram (3) and a folder in it with WhatsApp (a dot); Mail in Today. Work: Slack, asleep. */
  function state(): State {
    const s = emptyState();
    s.nodes = {
      f1: { kind: 'folder', id: 'f1', chordId: 'c1', section: 'pinned', parentId: null, rank: 'a0', title: 'Messages', collapsed: true, createdAt: 0 },
      f2: { kind: 'folder', id: 'f2', chordId: 'c1', section: 'pinned', parentId: 'f1', rank: 'a1', title: 'More', collapsed: true, createdAt: 0 },
      telegram: tab('telegram', 'c1', 'pinned', 'f1', 'https://web.telegram.org/'),
      whatsapp: tab('whatsapp', 'c1', 'pinned', 'f2', 'https://web.whatsapp.com/'),
      mail: tab('mail', 'c1', 'today', null, 'https://mail.example.com/'),
      slack: tab('slack', 'c2', 'pinned', null, 'https://app.slack.com/'),
    };
    s.live = { telegram: { ...IDLE_LIVE, badge: 3 }, whatsapp: { ...IDLE_LIVE, badge: 'dot' }, mail: { ...IDLE_LIVE, badge: 250 } };
    return s;
  }

  it('a closed folder adds up what’s inside it, any depth; the icon adds up every tab; a sleeping tab has none', () => {
    const s = state();
    expect(countWithin(s, 'f1')).toBe(3);
    expect(countWithin(s, 'f2')).toBe('dot');
    expect(appCount(s.live)).toBe(253);
    expect([...chordsWithCounts(s)]).toEqual(['c1']);
  });

  it('hides and shows a site’s count from its tab, and keeps the list across a restart', () => {
    const ctx = { now: 1, newId: () => 'x' };
    let s = apply(state(), { t: 'tabCounts.site', site: 'https://mail.google.com/mail/u/0/', off: true }, ctx).state;
    expect(s.settings.tabCounts.offSites).toEqual(['mail.google.com']);
    const seed = { now: 1, newId: () => 'id', theme: { stops: [{ l: 0.72, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'https://home.test/', platform: 'win32' as const };
    const restored = restoreState({ chords: [], nodes: [], windows: [], settings: { tabCounts: { enabled: false, offSites: ['mail.google.com', 'not a site'] } } }, seed);
    expect(restored.settings.tabCounts).toEqual({ enabled: false, offSites: ['mail.google.com'] });
    s = apply(s, { t: 'tabCounts.site', site: 'mail.google.com', off: false }, ctx).state;
    expect(s.settings.tabCounts.offSites).toEqual([]);
  });
});
