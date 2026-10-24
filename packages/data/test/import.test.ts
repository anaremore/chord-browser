import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedPage } from '@chord/core';
import { ChordDatabase } from '../src/db';

let dir: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-import-'));
  db = new ChordDatabase(join(dir, 'chord.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const t0 = 1_700_000_000_000;
const page = (url: string, title: string, visits: number[], typed: number[] = []): ImportedPage => ({ url, title, visits, typed });

/** Every visit row, straight from the file. */
function visitRows(): { url_id: number; transition: string }[] {
  db.close();
  const raw = new DatabaseSync(join(dir, 'chord.db'), { readOnly: true });
  const rows = raw.prepare('SELECT url_id, transition FROM history_visit ORDER BY id').all() as { url_id: number; transition: string }[];
  raw.close();
  db = new ChordDatabase(join(dir, 'chord.db'));
  return rows;
}

describe('importing history', () => {
  it('adds pages with every visit, so they’re found and ranked like pages Chord saw itself', () => {
    const added = db.importHistory(
      'i1',
      [page('https://www.recipes.test/pie', 'Apple pie', [t0 - 2 * DAY, t0 - DAY], [t0 - DAY]), page('https://maps.test/', 'Maps', [t0 - 60 * DAY]), page('javascript:void(0)', 'x', [t0])],
      t0,
    );
    expect(added).toBe(2);
    const pie = db.search('apple', null, t0).history[0]!;
    expect(pie).toMatchObject({ url: 'https://www.recipes.test/pie', visitCount: 2, typedCount: 1, lastVisitAt: t0 - DAY });
    // Three uses (one typed counts twice), a day or two old.
    expect(pie.frecency).toBeGreaterThan(2.8);
    expect(pie.frecency).toBeLessThan(3);
    expect(db.search('maps', null, t0).history[0]!.frecency).toBeCloseTo(0.25, 2);
    expect(visitRows().map((v) => v.transition)).toEqual(['import', 'import', 'import']);
  });

  it('adds to a page Chord already knows, keeping its title', () => {
    db.write([], t0, [{ k: 'visit', url: 'https://recipes.test/pie', title: 'Pie (mine)', at: t0 - DAY }]);
    db.importHistory('i1', [page('https://recipes.test/pie', 'Apple pie', [t0 - 3 * DAY])], t0);
    const hit = db.search('pie', null, t0).history[0]!;
    expect(hit).toMatchObject({ title: 'Pie (mine)', visitCount: 2, lastVisitAt: t0 - DAY });
  });

  it('Undo takes exactly the import back, keeping visits Chord saw meanwhile', () => {
    db.write([], t0, [{ k: 'visit', url: 'https://known.test/', title: '', at: t0 - 10 * DAY }]);
    const before = db.search('', null, t0).history;
    db.importHistory('i1', [page('https://known.test/', 'Known', [t0 - 2 * DAY, t0 - DAY]), page('https://new.test/', 'New', [t0 - DAY])], t0);
    // A second batch of the same import, and a visit of Chord's own in between.
    db.write([], t0, [{ k: 'visit', url: 'https://known.test/', title: '', at: t0 }]);
    db.importHistory('i1', [page('https://new.test/', 'New', [t0 - 5 * DAY]), page('https://other.test/', 'Other', [t0 - DAY])], t0);
    expect(db.search('new', null, t0).history[0]!.visitCount).toBe(2);

    db.undoImport('i1', t0);
    expect(db.search('new', null, t0).history).toEqual([]);
    expect(db.search('other', null, t0).history).toEqual([]);
    const known = db.search('', null, t0).history;
    expect(known).toHaveLength(1);
    // Its own two visits (the one before, the one during), its own empty title back.
    expect(known[0]).toMatchObject({ url: 'https://known.test/', title: '', visitCount: 2, lastVisitAt: t0 });
    // Its frecency: what it had, plus Chord's own visit just now.
    expect(known[0]!.frecency).toBeCloseTo(before[0]!.frecency + 1, 5);
    expect(visitRows().map((v) => v.transition)).toEqual(['link', 'link']);
    // Undo again does nothing, and a batch that was still on its way stays out.
    db.undoImport('i1', t0);
    expect(db.importHistory('i1', [page('https://late.test/', 'Late', [t0])], t0)).toBe(0);
    expect(db.search('', null, t0).history).toHaveLength(1);
  });

  it('Undo keeps a page the import brought if Chord used it meanwhile, with Chord’s visits and typed picks', () => {
    db.importHistory('i1', [page('https://news.test/', 'News', [t0 - 5 * DAY, t0 - 4 * DAY])], t0);
    db.write([], t0, [
      { k: 'visit', url: 'https://news.test/', title: '', at: t0 },
      { k: 'choice', chordId: 'c1', text: 'news', destination: 'https://news.test/', address: 'https://news.test/', at: t0 },
    ]);
    db.undoImport('i1', t0);
    const hit = db.search('news', null, t0).history[0]!;
    // One visit and one typed pick: two uses, just now.
    expect(hit).toMatchObject({ url: 'https://news.test/', visitCount: 1, typedCount: 1, lastVisitAt: t0 });
    expect(hit.frecency).toBeCloseTo(2, 5);
  });

  it('undoes overlapping imports one at a time, in any order', () => {
    db.importHistory('a', [page('https://shared.test/', 'Shared', [t0 - 2 * DAY])], t0);
    db.importHistory('b', [page('https://shared.test/', 'Shared', [t0 - DAY, t0 - DAY / 2])], t0);
    db.undoImport('a', t0);
    const left = db.search('shared', null, t0).history[0]!;
    expect(left.visitCount).toBe(2);
    expect(left.frecency).toBeCloseTo(2 ** (-1 / 30) + 2 ** (-0.5 / 30), 5);
    db.undoImport('b', t0);
    expect(db.search('shared', null, t0).history).toEqual([]);
  });

  it('undoes a big import quickly', () => {
    const pages = Array.from({ length: 10_000 }, (_, i) => page(`https://many.test/${i}`, `Page ${i}`, [0, 1, 2, 3, 4].map((k) => t0 - (i % 60) * DAY - k * 3_600_000)));
    for (let at = 0; at < pages.length; at += 500) db.importHistory('big', pages.slice(at, at + 500), t0);
    expect(db.search('many', null, t0).history.length).toBeGreaterThan(0);
    const started = performance.now();
    db.undoImport('big', t0);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(db.search('many', null, t0).history).toEqual([]);
    expect(visitRows()).toEqual([]);
  });

  it('forgets how to undo once chord-data reopens: an import’s Undo lasts the session', () => {
    db.importHistory('i1', [page('https://new.test/', 'New', [t0])], t0);
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'));
    db.undoImport('i1', t0);
    expect(db.search('new', null, t0).history).toHaveLength(1);
  });
});
