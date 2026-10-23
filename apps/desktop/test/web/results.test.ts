import { describe, expect, it } from 'vitest';
import { apply, seedState, type Choice, type Context, type State } from '@chord/core';
import type { HistorySearch } from '@chord/ipc';
import { keywordFor } from '@chord/core';
import { buildResults, completionFor, destinationOf, scopeFor, type Result } from '../../src/renderer/overlay/results';

const now = 1_700_000_000_000;
let n = 0;
const ctx: Context = { now, newId: () => `id-${++n}` };

function stateWith(urls: string[]): { state: State; windowId: string } {
  let state = seedState({ now, newId: ctx.newId, theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });
  const windowId = Object.keys(state.windows)[0]!;
  for (const url of urls) state = apply(state, { t: 'tab.open', windowId, url, background: true }, ctx).state;
  return { state, windowId };
}

const visit = (url: string, title: string, frecency: number) => ({ url, title, visitCount: 1, typedCount: 0, lastVisitAt: now, frecency });

describe('command bar ranking', () => {
  it('puts the search first when nothing clearly matches, then the best matches', () => {
    const { state, windowId } = stateWith([]);
    const history: HistorySearch = { history: [visit('https://news.test/', 'Chord news', 1)], choices: [] };
    const results = buildResults('chord progressions', state, windowId, 'new', history, now);
    expect(results[0]).toMatchObject({ kind: 'open', search: true });
  });

  it('lets a well-used page the text starts lead, ahead of the search', () => {
    const { state, windowId } = stateWith([]);
    const history: HistorySearch = { history: [visit('https://github.com/', 'GitHub', 20)], choices: [] };
    const [first, second] = buildResults('git', state, windowId, 'new', history, now);
    expect(first).toMatchObject({ kind: 'history', url: 'https://github.com/' });
    expect(second).toMatchObject({ kind: 'open', search: true });
  });

  it('shows an open tab instead of its history entry', () => {
    const { state, windowId } = stateWith(['https://github.com/']);
    const history: HistorySearch = { history: [visit('https://www.github.com/', 'GitHub', 20)], choices: [] };
    const results = buildResults('github', state, windowId, 'new', history, now);
    expect(results.filter((r) => r.kind === 'history')).toHaveLength(0);
    expect(results.some((r) => r.kind === 'tab')).toBe(true);
  });

  it('remembers the pick: what was chosen twice for the same text leads', () => {
    const { state, windowId } = stateWith([]);
    const choices: Choice[] = [{ text: 'set', destination: 'action:app.settings', uses: 1.9, lastUsedAt: now }];
    const [first] = buildResults('set', state, windowId, 'new', { history: [], choices }, now);
    expect(first).toMatchObject({ kind: 'action', action: 'app.settings' });
  });

  it('knows where each row leads, so picks can be remembered', () => {
    const { state, windowId } = stateWith([]);
    const [action] = buildResults('zoom in', state, windowId, 'new', null, now).filter((r) => r.kind === 'action');
    expect(destinationOf(action!)).toBe('action:view.zoomIn');
  });
});

describe('inline autocomplete', () => {
  const lead = (url: string): Result => ({ kind: 'history', key: 'h', title: 'Page', detail: '', url });

  it('completes the address of the page that leads', () => {
    const { state, windowId } = stateWith([]);
    const history: HistorySearch = { history: [visit('https://github.com/', 'GitHub', 20)], choices: [] };
    const results = buildResults('git', state, windowId, 'new', history, now);
    expect(completionFor('git', results[0])).toBe('hub.com');
  });

  it('keeps what was typed, in its case, and follows a typed www.', () => {
    expect(completionFor('GIT', lead('https://github.com/anaremore'))).toBe('hub.com/anaremore');
    expect(completionFor('www.git', lead('https://github.com/'))).toBe('hub.com');
  });

  it('never completes a search, a scheme, or a row that is not a page', () => {
    expect(completionFor('git hub', lead('https://github.com/'))).toBe('');
    expect(completionFor('https://git', lead('https://github.com/'))).toBe('');
    expect(completionFor('hub', lead('https://github.com/'))).toBe('');
    expect(completionFor('github.com', lead('https://github.com/'))).toBe('');
    const search: Result = { kind: 'open', key: 'open', title: 'git', detail: '', url: 'https://www.google.com/search?q=git', search: true };
    expect(completionFor('git', search)).toBe('');
  });

  it('an accepted completion that is an open tab’s address switches to that tab', () => {
    const { state, windowId } = stateWith(['https://github.com/anaremore']);
    const [first, second] = buildResults('github.com/anaremore', state, windowId, 'new', null, now);
    expect(first).toMatchObject({ kind: 'tab' });
    expect(second).toMatchObject({ kind: 'open', search: false });
    // Any other address still leads with itself.
    expect(buildResults('github.com/other', state, windowId, 'new', null, now)[0]).toMatchObject({ kind: 'open', search: false });
  });

  it('does not complete when only the title starts with the text', () => {
    const { state, windowId } = stateWith([]);
    const history: HistorySearch = { history: [visit('https://example.com/docs', 'Gitbook docs', 20)], choices: [] };
    const [first] = buildResults('git', state, windowId, 'new', history, now);
    expect(first).toMatchObject({ kind: 'history' });
    expect(completionFor('git', first)).toBe('');
  });
});

describe('scopes', () => {
  it('switches to a keyword on Tab, and on Space only for abbreviations', () => {
    expect(scopeFor('yt', 'tab')).toMatchObject({ kind: 'keyword', keyword: { name: 'YouTube' } });
    expect(scopeFor('yt', 'space')).toMatchObject({ kind: 'keyword' });
    expect(scopeFor('maps', 'tab')).toMatchObject({ kind: 'keyword', keyword: { name: 'Google Maps' } });
    expect(scopeFor('maps', 'space')).toBeNull();
    expect(scopeFor('@History', 'space')).toEqual({ kind: 'filter', filter: 'history' });
    expect(scopeFor('youtube', 'tab')).toBeNull();
  });

  it('offers the filters `@` could start, ahead of everything else', () => {
    const { state, windowId } = stateWith([]);
    const results = buildResults('@', state, windowId, 'new', null, now);
    expect(results.slice(0, 5).map((r) => r.kind === 'scope' && r.detail)).toEqual(['@tabs', '@pinned', '@history', '@chords', '@actions']);
    expect(buildResults('@h', state, windowId, 'new', null, now)[0]).toMatchObject({ kind: 'scope', detail: '@history' });
  });

  it('offers a keyword typed exactly, after the search for the text', () => {
    const { state, windowId } = stateWith([]);
    const [first, second] = buildResults('yt', state, windowId, 'new', null, now);
    expect(first).toMatchObject({ kind: 'open', search: true });
    expect(second).toMatchObject({ kind: 'scope', title: 'Search YouTube' });
  });

  it('a keyword searches its site and ranks only pages there', () => {
    const { state, windowId } = stateWith(['https://www.youtube.com/watch?v=1', 'https://lofi.test/']);
    const tabs = Object.values(state.nodes).filter((n) => n.kind === 'tab');
    let withTitles = state;
    for (const t of tabs) withTitles = apply(withTitles, { t: 'tab.updated', nodeId: t.id, title: 'lofi beats' }, ctx).state;
    const results = buildResults('lofi', withTitles, windowId, 'new', null, now, { scope: { kind: 'keyword', keyword: keywordFor('yt')! } });
    expect(results[0]).toMatchObject({ kind: 'open', url: 'https://www.youtube.com/results?search_query=lofi', detail: 'Search YouTube' });
    expect(results.filter((r) => r.kind === 'tab').map((r) => r.kind === 'tab' && r.tab.url)).toEqual(['https://www.youtube.com/watch?v=1']);
  });

  it('a filter shows only its kind, all of it when nothing is typed', () => {
    const { state, windowId } = stateWith(['https://a.test/', 'https://b.test/']);
    const all = buildResults('', state, windowId, 'new', null, now, { scope: { kind: 'filter', filter: 'tabs' } });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((r) => r.kind === 'tab')).toBe(true);
    const actions = buildResults('', state, windowId, 'new', null, now, { scope: { kind: 'filter', filter: 'actions' } });
    expect(actions.length).toBeGreaterThan(12);
    expect(buildResults('zoom', state, windowId, 'new', null, now, { scope: { kind: 'filter', filter: 'actions' } }).every((r) => r.kind === 'action')).toBe(true);
    const history: HistorySearch = { history: [visit('https://news.test/', 'News', 3)], choices: [] };
    expect(buildResults('', state, windowId, 'new', history, now, { scope: { kind: 'filter', filter: 'history' } })).toEqual([
      expect.objectContaining({ kind: 'history', url: 'https://news.test/' }),
    ]);
  });
});

describe('search suggestions', () => {
  it('come after every local row, as searches with the engine', () => {
    const { state, windowId } = stateWith(['https://chords.test/']);
    const results = buildResults('chord', state, windowId, 'new', null, now, { suggestions: ['chord progressions', 'chord finder'] });
    const firstSuggestion = results.findIndex((r) => r.kind === 'open' && r.suggested);
    expect(results.slice(firstSuggestion).map((r) => r.title)).toEqual(['chord progressions', 'chord finder']);
    expect(results.slice(0, firstSuggestion).some((r) => r.kind === 'tab')).toBe(true);
    expect(results[firstSuggestion]).toMatchObject({ url: 'https://www.google.com/search?q=chord%20progressions', search: true });
  });

  it('never accompany half a filter', () => {
    const { state, windowId } = stateWith([]);
    const results = buildResults('@hi', state, windowId, 'new', null, now, { suggestions: ['@history book'] });
    expect(results.some((r) => r.kind === 'open' && r.suggested)).toBe(false);
  });

  it('never accompany an address', () => {
    const { state, windowId } = stateWith([]);
    const results = buildResults('example.com', state, windowId, 'new', null, now, { suggestions: ['example'] });
    expect(results.some((r) => r.kind === 'open' && r.suggested)).toBe(false);
  });
});
