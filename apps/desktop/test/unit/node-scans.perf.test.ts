/**
 * Reads on hot paths that once went over every node, at 5,000 pinned tabs
 * and with 30,000 bookmarks besides (ARCHITECTURE.md §6.1, *Large
 * profiles*): a chord switch's announcement (renderer/shell/App.tsx; agent
 * chords read their tabs the same way), and a tab arriving on a site Chord
 * keeps no icon for (main/tabs.ts `knownIcon`). Each is timed as it is now
 * and as it was (a pass over every node), the fastest of many runs.
 */
import { emptyState, nodeList, nodeOf, nodesOfChord, setNode, type SidebarNode, type State, type TabNode } from '@chord/core';
import { freeze, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { TabIconIndex } from '../../src/main/site-icons';

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.35, appearance: 'auto' as const };

function tab(id: string, chordId: string, i: number): SidebarNode {
  const url = `https://site${i % 997}.test/page/${i}`;
  return { kind: 'tab', id, chordId, section: 'pinned', parentId: null, rank: `a${String(i).padStart(6, '0')}`, url, title: `Page ${i}`, pinnedUrl: url, customTitle: null, favicon: `data:image/png;base64,${'A'.repeat(64)}`, lastActiveAt: i, createdAt: i };
}

/** `tabs` pinned tabs over `chords` chords (as in store.perf.test.ts, without folders: a scan reads every node either way). */
function bigState(chords: number, tabs: number): State {
  const state = emptyState();
  for (let c = 0; c < chords; c++) state.chords[`c${c}`] = { id: `c${c}`, profileId: 'default', name: `Chord ${c}`, icon: 'C', theme, rank: `a${c}`, createdAt: c };
  for (let i = 0; i < tabs; i++) setNode(state, tab(`t${i}`, `c${i % chords}`, i));
  state.windows['w1'] = { id: 'w1', activeChordId: 'c0', activeTab: {}, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  return freeze(state, true);
}

const RUNS = 41;
function best(run: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < RUNS + 3; i++) {
    const t0 = performance.now();
    run();
    // The first three warm up.
    if (i >= 3) times.push(performance.now() - t0);
  }
  return Math.min(...times);
}

/** A chord switch announces its counts: the old way, every node; the new, the chord's own from the index. */
function chordSwitch(state: State, chordId: string) {
  const before = () => nodeList(state).filter((n) => n.kind === 'tab' && n.chordId === chordId).length;
  const after = () => nodesOfChord(state, chordId).filter((n) => n.kind === 'tab').length;
  nodesOfChord(state, chordId); // The sidebar has read this state already.
  expect(after()).toBe(before());
  return { before: best(before), after: best(after) };
}

/**
 * A tab goes to a site no tab is on (each run, one tab has navigated since the last: one bucket changed), and its
 * icon is looked for: the old way, every node; the new, the index caught up from that bucket.
 */
function newOrigin(base: State) {
  let state = base;
  let n = 0;
  const navigate = () => {
    const id = `t${(n * 7919) % 5000}`;
    state = produce(state, (draft) => {
      (nodeOf(draft, id) as TabNode).title = `Visited ${n++}`;
    });
  };
  const site = 'https://nowhere-yet.test';
  const scan = () => {
    for (const node of nodeList(state)) if (node.kind === 'tab' && node.favicon && (node.url === site || node.url.startsWith(`${site}/`))) return node.favicon;
    return null;
  };
  const index = new TabIconIndex(() => state);
  const t0 = performance.now();
  void [...index.tabsOn(site)];
  const build = performance.now() - t0;
  const lookup = () => {
    for (const node of index.tabsOn(site)) return node.favicon;
    return null;
  };
  const timed = (look: () => string | null) => {
    const times: number[] = [];
    for (let i = 0; i < RUNS + 3; i++) {
      navigate();
      const t = performance.now();
      expect(look()).toBeNull();
      if (i >= 3) times.push(performance.now() - t);
    }
    return Math.min(...times);
  };
  return { before: timed(scan), after: timed(lookup), build };
}

/** Budgets (docs/testing/performance.md): each read ≤ 0.5 ms now; CI's shared machines get twice as long. */
const enforce = process.env.CHORD_PERF_ENFORCE === '1';
const BUDGET = enforce ? 0.5 : 1;

describe('reads that once went over every node', () => {
  for (const [name, chords, tabs] of [
    ['5,000 pinned in 10 chords', 10, 5_000],
    ['35,000 nodes in 10 chords', 10, 35_000],
  ] as const) {
    it(`${name}: a chord switch, and a tab arriving on a new site`, () => {
      const state = bigState(chords, tabs);
      const sw = chordSwitch(state, 'c3');
      const nav = newOrigin(state);
      console.log(
        `${name}: chord switch ${sw.before.toFixed(3)} → ${sw.after.toFixed(3)} ms; new site's icon ${nav.before.toFixed(3)} → ${nav.after.toFixed(3)} ms (index built once in ${nav.build.toFixed(1)} ms)`,
      );
      expect.soft(sw.after, 'chord switch').toBeLessThan(BUDGET);
      expect.soft(nav.after, "new site's icon").toBeLessThan(BUDGET);
    });
  }
});
