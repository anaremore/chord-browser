import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { habit, learnedPoints } from '@chord/core';
import { ChordDatabase } from '../src/db';

let dir: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-history-'));
  db = new ChordDatabase(join(dir, 'chord.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const t0 = 1_700_000_000_000;

describe('history', () => {
  it('keeps one row per page, counting visits, and finds it by any word prefix', () => {
    db.write([], t0, [
      { k: 'visit', url: 'https://www.github.com/anaremore/chord-browser', title: 'chord-browser', at: t0 },
      { k: 'visit', url: 'https://github.com/anaremore/chord-browser#readme', title: '', at: t0 + 1000 },
      { k: 'visit', url: 'https://en.wikipedia.org/wiki/Chord_(music)', title: 'Chord (music) - Wikipedia', at: t0 },
    ]);
    const hits = db.search('chord', null, t0 + 2000).history;
    expect(hits.map((h) => h.title).sort()).toEqual(['Chord (music) - Wikipedia', 'chord-browser']);
    const repo = hits.find((h) => h.title === 'chord-browser')!;
    expect(repo.visitCount).toBe(2);
    expect(repo.frecency).toBeCloseTo(2, 1);
    expect(db.search('git anar', null, t0).history).toHaveLength(1);
    // One letter is too little to search history.
    expect(db.search('c', null, t0).history).toEqual([]);
  });

  it('takes titles that arrive after the visit', () => {
    db.write([], t0, [{ k: 'visit', url: 'https://a.test/', title: '', at: t0 }]);
    db.write([], t0, [{ k: 'title', url: 'https://a.test/', title: 'Alpha Centauri' }]);
    expect(db.search('alpha', null, t0).history[0]!.title).toBe('Alpha Centauri');
  });

  it('lets frecency fade: a visit a month ago counts half', () => {
    db.write([], t0, [{ k: 'visit', url: 'https://a.test/', title: 'Alpha', at: t0 }]);
    expect(db.search('alpha', null, t0 + 30 * DAY).history[0]!.frecency).toBeCloseTo(0.5, 2);
  });
});

describe('learned picks', () => {
  it('remembers picks per chord, and a typed pick counts as another use of the page', () => {
    const pick = (at: number) => ({ k: 'choice' as const, chordId: 'c1', text: 'GH', destination: 'github.com', address: 'https://github.com/', at });
    db.write([], t0, [{ k: 'visit', url: 'https://github.com/', title: 'GitHub', at: t0 }, pick(t0), pick(t0 + 1000)]);
    const result = db.search('gh', 'c1', t0 + 2000);
    expect(result.choices).toHaveLength(1);
    expect(learnedPoints(result.choices, 'gh', 'github.com', t0 + 2000)).toBeGreaterThan(500);
    expect(habit(result.choices, 'gh', t0 + 2000)).toBe('github.com');
    expect(db.search('gh', 'c2', t0).choices).toEqual([]);
    expect(db.search('github', null, t0 + 2000).history[0]).toMatchObject({ visitCount: 1, typedCount: 2 });
  });
});
