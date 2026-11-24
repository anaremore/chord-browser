/**
 * Merging many small changes to one big synced thing (S15 §7): one slice reads and writes the thing once, not once a
 * record. First built, each record rewrote it: about 470 ms for this slice; held to 150 ms. sync.test.ts checks what
 * the slice merges; this is its budget, moved here (issue #85) so it runs alone, in `pnpm test:perf`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedState, type Context, type DataRecord, type Stamp } from '@chord/core';
import { ChordDatabase } from '../src/db';
import { opsForState } from '../src';

const BUDGET_MS = 150;
const RUNS = 5;
const OTHER = '00000000000000bb';
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

let dir: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-perf-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ctx: Context = { now: 5000, newId: () => `id-${++n}` };
const at = (ms: number): Stamp => [Date.now() + ms, 0, OTHER];

describe('sync: many small changes to one big thing', () => {
  it(`one slice of 100 changes to a 1 MB thing: under ${BUDGET_MS} ms (the fastest of ${RUNS})`, () => {
    db.write(opsForState(seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' })));
    db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk' });
    db.atomically(() => db.sync.addLocal('all'));
    db.atomically(() => db.sync.merge([{ type: 'widget', id: 'big', at: at(1), set: { blob: 'x'.repeat(1024 * 1024) } }], Date.now()));
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const small = Array.from({ length: 100 }, (_, i): DataRecord => ({ type: 'widget', id: 'big', at: at(run * 100 + i + 2), set: { tick: i } }));
      const started = performance.now();
      const result = db.atomically(() => db.sync.merge(small, Date.now(), 512 * 1024));
      times.push(performance.now() - started);
      expect(result.consumed).toBe(100);
    }
    const fastest = Math.min(...times);
    console.log(`100 small changes to a 1 MB thing: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
    expect(fastest).toBeLessThan(BUDGET_MS);
  });
});
