/**
 * The snapshot's part in main (S18 M2b): cleaning the page script's answer, issuing refs, the outline and the result,
 * on what the agents.spec journey's pages give (a typical page: 1,203 nodes, 600 keys; a 20,000-element one: 16,003
 * nodes, 2,000 keys). Each row prints what it measured. Measured (2026-11-22, Windows x64): a typical page's median
 * 0.9 to 1.8 ms (the plan's target, under 2 ms), the huge page's 7.6 to 9.2 ms (12.2 ms before names without hidden
 * characters skipped cleanPageText's passes), 8.4 to 11.8 ms over later runs; an answer of 2,000,000 text nodes, cut to
 * the scan's 20,000 first, 10.9 ms. The budgets leave CI's slower runners room: 3 ms, and 20 ms for the big ones.
 */
import { describe, expect, it } from 'vitest';

// Core compiles without DOM or Node types; both are globals where the tests run.
declare const performance: { now(): number };
declare const console: { log(...args: unknown[]): void };
import { cleanSnapshotRead, ElementRefs, snapshotKeys, snapshotOutline, snapshotResult } from '../src';

function answer(rows: number, maxKeys: number) {
  const nodes: unknown[] = [{ depth: 0, role: 'main', name: '' }, { depth: 1, role: 'heading', name: 'Rows', level: 1 }, { depth: 1, role: 'list', name: '' }];
  let key = 0;
  for (let i = 0; i < rows; i++) {
    nodes.push({ depth: 2, role: 'listitem', name: '' });
    nodes.push({ depth: 3, role: 'link', name: `Row ${i}`, ...(key < maxKeys ? { key: key++ } : {}) });
    nodes.push({ depth: 3, role: 'text', name: `Note ${i}` });
    nodes.push({ depth: 3, role: 'button', name: `Act ${i}`, ...(key < maxKeys ? { key: key++ } : {}) });
  }
  return { url: 'https://rows.test/', title: 'Rows', nodes, cut: {} };
}

function time(rows: number, maxKeys: number, runs: number): number[] {
  const raw = answer(rows, maxKeys);
  const refs = new ElementRefs();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const read = cleanSnapshotRead(raw)!;
    const issued = refs.issue('p1', `t${i}`, snapshotKeys(read));
    const outline = snapshotOutline(read, issued);
    snapshotResult({ ref: 'a1', url: read.url, title: read.title, outline: outline.text, refs: outline.refs, retrievedAt: 0, pageId: 'p1' });
    times.push(performance.now() - started);
  }
  return times.sort((a, b) => a - b);
}

describe('The snapshot in main', () => {
  it('an answer of 2,000,000 text nodes (a hostile page): cut to the scan’s bound before anything else (review 1 of #104)', () => {
    const flood = { url: 'https://flood.test/', title: 'Flood', nodes: Array.from({ length: 2_000_000 }, () => ({ depth: 0, role: 'text', name: 'x' })), cut: {} };
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const read = cleanSnapshotRead(flood)!;
      const refs = new ElementRefs();
      const outline = snapshotOutline(read, refs.issue('p1', 't', []));
      snapshotResult({ ref: 'a1', url: read.url, title: read.title, outline: outline.text, refs: 0, retrievedAt: 0 });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[5]!;
    console.log(`[perf] snapshot in main, 2,000,000 text nodes: median ${median.toFixed(2)} ms, worst ${times[9]!.toFixed(2)} ms`);
    expect(median).toBeLessThan(20);
  });

  // [what, rows, keys at most, the median's budget (ms)]
  const rows: [string, number, number, number][] = [
    ['a typical page (1,203 nodes, 600 refs)', 300, 600, 3],
    ['a 20,000-element page (16,003 nodes, 2,000 refs)', 4000, 2000, 20],
  ];
  it.each(rows)('%s', (_what, count, keys, budget) => {
    time(count, keys, 20);
    const times = time(count, keys, 30);
    const median = times[Math.floor(times.length / 2)]!;
    console.log(`[perf] snapshot in main, ${_what}: median ${median.toFixed(2)} ms, worst ${times[times.length - 1]!.toFixed(2)} ms`);
    expect(median).toBeLessThan(budget);
  });
});
