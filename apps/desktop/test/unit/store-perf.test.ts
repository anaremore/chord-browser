/**
 * The store's cost on a very large profile (ARCHITECTURE.md §6.1, §9 Import's
 * known limit): 5,000 pinned tabs across chords, one chord of them alone, and
 * an import of 30,000 bookmarks. Each common action's store change, and a
 * mirror applying its patches, timed as the median of several runs.
 */
import { generateNKeysBetween } from 'fractional-indexing';
import { applyPatches, enablePatches } from 'immer';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply, childrenToRead, emptyState, IDLE_LIVE, type Command, type Context, type SidebarNode, type State } from '@chord/core';

enablePatches();

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.35, appearance: 'auto' as const };

function tab(id: string, chordId: string, section: 'pinned' | 'today', parentId: string | null, rank: string, i: number): SidebarNode {
  const url = `https://site${i % 997}.test/page/${i}`;
  return { kind: 'tab', id, chordId, section, parentId, rank, url, title: `Page ${i}`, pinnedUrl: section === 'pinned' ? url : null, customTitle: null, favicon: `data:image/png;base64,${'A'.repeat(64)}`, lastActiveAt: i, createdAt: i };
}

/** Pinned tabs in a chord: folders of 9 tabs, then the rest at its root. */
function fillPinned(state: State, chordId: string, count: number, prefix: string): void {
  const folders = Math.floor(count / 20);
  const rootRanks = generateNKeysBetween(null, null, folders + (count - folders * 9));
  let r = 0;
  let n = 0;
  for (let f = 0; f < folders; f++) {
    const id = `${prefix}f${f}`;
    state.nodes[id] = { kind: 'folder', id, chordId, section: 'pinned', parentId: null, rank: rootRanks[r++]!, title: `Folder ${f}`, collapsed: f % 2 === 0, createdAt: f };
    const inner = generateNKeysBetween(null, null, 9);
    for (let k = 0; k < 9; k++, n++) state.nodes[`${prefix}t${n}`] = tab(`${prefix}t${n}`, chordId, 'pinned', id, inner[k]!, n);
  }
  while (n < count) {
    state.nodes[`${prefix}t${n}`] = tab(`${prefix}t${n}`, chordId, 'pinned', null, rootRanks[r++]!, n);
    n++;
  }
}

/** 5,000 pinned tabs in `chords` chords, ten Today tabs in each, and optionally imported bookmarks in a chord of their own. */
function bigState({ chords, bookmarks }: { chords: number; bookmarks: number }): State {
  const state = emptyState();
  const chordRanks = generateNKeysBetween(null, null, chords + 1);
  for (let c = 0; c < chords; c++) {
    const id = `c${c}`;
    state.chords[id] = { id, profileId: 'default', name: `Chord ${c}`, icon: 'C', theme, rank: chordRanks[c]!, createdAt: c };
    fillPinned(state, id, 5000 / chords, `c${c}-`);
    const today = generateNKeysBetween(null, null, 10);
    for (let k = 0; k < 10; k++) state.nodes[`c${c}-d${k}`] = tab(`c${c}-d${k}`, id, 'today', null, today[k]!, 100_000 + k);
  }
  if (bookmarks > 0) {
    state.chords['imp'] = { id: 'imp', profileId: 'default', name: 'Imported', icon: 'I', theme, rank: chordRanks[chords]!, createdAt: 99 };
    fillPinned(state, 'imp', bookmarks, 'imp-');
  }
  // Somewhere to go when a chord is deleted, even with one.
  state.chords['spare'] = { id: 'spare', profileId: 'default', name: 'Spare', icon: 'S', theme, rank: generateNKeysBetween(chordRanks.at(-1)!, null, 1)[0]!, createdAt: 100 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c0', activeTab: { c0: 'c0-d0' }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.live['c0-d0'] = { ...IDLE_LIVE };
  return state;
}

function ctx(): Context {
  let n = 0;
  return { now: 1_000_000, newId: () => `new-${++n}` };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface Timing {
  /** Medians, for the table. */
  store: number;
  mirror: number;
  /** The fastest runs, which budgets hold: other tests running alongside only ever add to a run. */
  bestStore: number;
  bestMirror: number;
  patches: number;
}

/** A command applied to `base` again and again: its store change, and a mirror applying what it sent, each with its first read of the tree. */
function time(base: State, command: Command, runs = 9): Timing {
  const store: number[] = [];
  const mirror: number[] = [];
  let patches = 0;
  // A mirror's copy came over IPC: its own, not frozen.
  const copy = structuredClone(base);
  for (let i = 0; i < runs + 2; i++) {
    // Each side then reads the new state's tree once, as main's listeners and the sidebar do: the first read of a new state builds its index.
    const t0 = performance.now();
    const result = apply(base, command, ctx());
    childrenToRead(result.state, 'c0', 'pinned');
    const t1 = performance.now();
    childrenToRead(applyPatches(copy, result.patches), 'c0', 'pinned');
    const t2 = performance.now();
    patches = result.patches.length;
    // The first two warm up.
    if (i >= 2) {
      store.push(t1 - t0);
      mirror.push(t2 - t1);
    }
  }
  return { store: median(store), mirror: median(mirror), bestStore: Math.min(...store), bestMirror: Math.min(...mirror), patches };
}

/** The common actions, in the active chord. */
const common: [string, Command][] = [
  ['activate', { t: 'tab.activate', windowId: 'w1', nodeId: 'c0-t0' }],
  ['pin', { t: 'tab.pin', nodeId: 'c0-d3' }],
  ['unpin', { t: 'tab.unpin', nodeId: 'c0-t4' }],
  ['close', { t: 'tab.close', windowId: 'w1', nodeId: 'c0-d2' }],
  ['move', { t: 'node.move', nodeId: 'c0-t3', section: 'pinned', index: 7, parentId: null }],
  ['rename folder', { t: 'folder.rename', nodeId: 'c0-f1', title: 'Renamed' }],
  ['title', { t: 'tab.updated', nodeId: 'c0-t5', title: 'New title' }],
];

const report: string[] = [];
const row = (setup: string, action: string, t: Timing) => report.push(`| ${setup} | ${action} | ${t.store.toFixed(2)} | ${t.mirror.toFixed(2)} | ${t.patches} |`);

/**
 * Budgets (docs/testing/performance.md): a frame for each common action, and
 * 50 ms for deleting a chord or its Undo, at 5,000 pinned tabs; CI's shared
 * machines get twice as long. 30,000 imported bookmarks aren't held to them
 * yet (ARCHITECTURE.md §9, *Import*'s known limit): they're measured only with
 * `CHORD_STORE_REPORT`, for the table.
 */
const enforce = process.env.CHORD_PERF_ENFORCE === '1';
const FRAME = enforce ? 8 : 16;
const DELETE = enforce ? 50 : 100;

describe('store on a very large profile', { timeout: 120_000 }, () => {
  for (const [name, opts, held] of [
    ['5,000 pinned in 10 chords', { chords: 10, bookmarks: 0 }, true],
    ['5,000 pinned in 1 chord', { chords: 1, bookmarks: 0 }, true],
    ['5,000 pinned + 30,000 bookmarks', { chords: 10, bookmarks: 30_000 }, false],
  ] as const) {
    const run = held || Boolean(process.env.CHORD_STORE_REPORT);
    it.runIf(run)(`${name}: each common action takes less than a frame`, () => {
      const s = bigState(opts);
      for (const [action, command] of common) {
        const t = time(s, command);
        row(name, action, t);
        expect(t.patches, action).toBeGreaterThan(0);
        if (!held) continue;
        expect.soft(t.bestStore, `${action}: store`).toBeLessThan(FRAME);
        expect.soft(t.bestMirror, `${action}: mirror`).toBeLessThan(FRAME);
      }
    });

    it.runIf(run)(`${name}: deleting a chord and its Undo`, () => {
      const s = bigState(opts);
      const del = time(s, { t: 'chord.delete', chordId: 'c0' }, 5);
      row(name, 'delete chord', del);
      const deleted = apply(s, { t: 'chord.delete', chordId: 'c0' }, ctx()).state;
      const undo = time(deleted, { t: 'chord.restore', windowId: 'w1', chordId: 'c0' }, 5);
      row(name, 'undo delete', undo);
      expect(del.patches).toBeGreaterThan(0);
      if (!held) return;
      expect.soft(del.bestStore).toBeLessThan(DELETE);
      expect.soft(undo.bestStore).toBeLessThan(DELETE);
    });
  }

  it('reports', () => {
    const table = ['| Setup | Action | Store ms | Mirror ms | Patches |', '|---|---|---|---|---|', ...report].join('\n');
    // `CHORD_STORE_REPORT=<file>` keeps the table, for a before/after.
    if (process.env.CHORD_STORE_REPORT) writeFileSync(process.env.CHORD_STORE_REPORT, `${table}\n`);
    else console.log(table);
  });
});
