import { describe, expect, it } from 'vitest';
import { apply, seedState, type Choice, type Context, type State } from '@chord/core';
import type { HistorySearch } from '@chord/ipc';
import { buildResults, destinationOf } from '../../src/renderer/overlay/results';

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
    const history: HistorySearch = { history: [visit('https://news.test/', 'Chord news', 1)], choices: [], archive: [] };
    const results = buildResults('chord progressions', state, windowId, 'new', history, now);
    expect(results[0]).toMatchObject({ kind: 'open', search: true });
  });

  it('lets a well-used page the text starts lead, ahead of the search', () => {
    const { state, windowId } = stateWith([]);
    const history: HistorySearch = { history: [visit('https://github.com/', 'GitHub', 20)], choices: [], archive: [] };
    const [first, second] = buildResults('git', state, windowId, 'new', history, now);
    expect(first).toMatchObject({ kind: 'history', url: 'https://github.com/' });
    expect(second).toMatchObject({ kind: 'open', search: true });
  });

  it('shows an open tab instead of its history entry', () => {
    const { state, windowId } = stateWith(['https://github.com/']);
    const history: HistorySearch = { history: [visit('https://www.github.com/', 'GitHub', 20)], choices: [], archive: [] };
    const results = buildResults('github', state, windowId, 'new', history, now);
    expect(results.filter((r) => r.kind === 'history')).toHaveLength(0);
    expect(results.some((r) => r.kind === 'tab')).toBe(true);
  });

  it('remembers the pick: what was chosen twice for the same text leads', () => {
    const { state, windowId } = stateWith([]);
    const choices: Choice[] = [{ text: 'set', destination: 'action:app.settings', uses: 1.9, lastUsedAt: now }];
    const [first] = buildResults('set', state, windowId, 'new', { history: [], choices, archive: [] }, now);
    expect(first).toMatchObject({ kind: 'action', action: 'app.settings' });
  });

  it('offers an archived tab in place of its history entry, ranked by how much the page is used', () => {
    const { state, windowId } = stateWith([]);
    const archived = { id: 'a1', chordId: 'c', url: 'https://github.com/anaremore', title: 'anaremore', favicon: null, reason: 'auto' as const, archivedAt: now - 3 * 86_400_000 };
    const history: HistorySearch = { history: [visit('https://github.com/anaremore', 'anaremore', 20)], choices: [], archive: [archived] };
    const results = buildResults('anaremore', state, windowId, 'new', history, now);
    expect(results.filter((r) => r.kind === 'history')).toHaveLength(0);
    expect(results[0]).toMatchObject({ kind: 'archive', archiveId: 'a1' });
    expect(destinationOf(results[0]!)).toBe('github.com/anaremore');
  });

  it("doesn't offer an archived tab whose page is open", () => {
    const { state, windowId } = stateWith(['https://github.com/']);
    const archived = { id: 'a1', chordId: 'c', url: 'https://github.com/', title: 'GitHub', favicon: null, reason: 'closed' as const, archivedAt: now };
    const results = buildResults('github', state, windowId, 'new', { history: [], choices: [], archive: [archived] }, now);
    expect(results.some((r) => r.kind === 'archive')).toBe(false);
  });

  it('knows where each row leads, so picks can be remembered', () => {
    const { state, windowId } = stateWith([]);
    const [action] = buildResults('zoom in', state, windowId, 'new', null, now).filter((r) => r.kind === 'action');
    expect(destinationOf(action!)).toBe('action:view.zoomIn');
  });
});
