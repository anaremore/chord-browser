/**
 * chord-data's timed rows (docs/testing/performance.md, *Unit perf suite*). They
 * run in `pnpm test:perf`, one file at a time and nothing beside them, so a
 * wall-clock budget measures Chord and not the rest of the suite sharing the
 * CPUs and the disk. `pnpm test` leaves them out.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedPage } from '@chord/core';
import { ChordDatabase } from '../src/db';
import { MIGRATIONS } from '../src/migrations';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-perf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('chord-data', () => {
  // A new profile's first launch creates chord.db and every table in it. In one transaction since 2026-11-20, not one
  // per migration (db.test.ts counts the commits). Beside it, report only: the migrations alone, both ways, so every
  // runner shows what the change is worth on its disk. On a Windows desk (NTFS, NVMe): the open's median 31 → 26 ms,
  // the migrations 20 → 17 ms, or 37 → 19 ms with each commit synced (`synchronous = FULL`). The budget is ten times
  // the desk's, for a runner's disk.
  it('creates a new profile’s database', () => {
    const times = { open: [] as number[], one: [] as number[], each: [] as number[], eachSynced: [] as number[], oneSynced: [] as number[] };
    const migrate = (name: string, each: boolean, sync: 'NORMAL' | 'FULL') => {
      const db = new DatabaseSync(join(dir, name));
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${sync}; PRAGMA foreign_keys = OFF`);
      const started = performance.now();
      const check = () => expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (each) {
        MIGRATIONS.forEach((m, v) => {
          db.exec(`BEGIN IMMEDIATE; ${m}`);
          check();
          db.exec(`PRAGMA user_version = ${v + 1}; COMMIT`);
        });
      } else {
        db.exec('BEGIN IMMEDIATE');
        for (const m of MIGRATIONS) db.exec(m);
        check();
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length}; COMMIT`);
      }
      const ms = performance.now() - started;
      db.close();
      return ms;
    };
    for (let i = 0; i < 10; i++) {
      const file = join(dir, `new-${i}.db`);
      const started = performance.now();
      new ChordDatabase(file).close();
      times.open.push(performance.now() - started);
      const db = new DatabaseSync(file, { readOnly: true });
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      db.close();
      times.one.push(migrate(`one-${i}.db`, false, 'NORMAL'));
      times.each.push(migrate(`each-${i}.db`, true, 'NORMAL'));
      times.oneSynced.push(migrate(`one-synced-${i}.db`, false, 'FULL'));
      times.eachSynced.push(migrate(`each-synced-${i}.db`, true, 'FULL'));
    }
    const say = (xs: number[]) => `median ${median(xs).toFixed(1)} ms, worst ${Math.max(...xs).toFixed(1)} ms`;
    console.log(
      [
        `new database: ${say(times.open)}`,
        `  its migrations in one commit: ${say(times.one)}; one commit each, as before: ${say(times.each)}`,
        `  each commit synced: in one ${say(times.oneSynced)}; one each ${say(times.eachSynced)}`,
      ].join('\n'),
    );
    expect(median(times.open)).toBeLessThan(250);
  });

  // From import.test.ts: 10,000 pages and their 50,000 visits undone in under 5 s (1.3 s on a Windows desk).
  it('undoes a big import quickly', { timeout: 60_000 }, () => {
    const DAY = 86_400_000;
    const t0 = 1_700_000_000_000;
    const page = (url: string, title: string, visits: number[]): ImportedPage => ({ url, title, visits, typed: [] });
    const file = join(dir, 'chord.db');
    const db = new ChordDatabase(file);
    try {
      const pages = Array.from({ length: 10_000 }, (_, i) => page(`https://many.test/${i}`, `Page ${i}`, [0, 1, 2, 3, 4].map((k) => t0 - (i % 60) * DAY - k * 3_600_000)));
      for (let at = 0; at < pages.length; at += 500) db.importHistory('big', pages.slice(at, at + 500), t0);
      expect(db.search('many', null, t0).history.length).toBeGreaterThan(0);
      const started = performance.now();
      db.undoImport('big', t0);
      const ms = performance.now() - started;
      console.log(`undo of 10,000 pages, 50,000 visits: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(5_000);
      expect(db.search('many', null, t0).history).toEqual([]);
    } finally {
      db.close();
    }
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare('SELECT count(*) AS n FROM history_visit').get()).toEqual({ n: 0 });
    raw.close();
  });
});
