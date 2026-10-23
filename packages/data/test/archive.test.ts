import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVE_KEEP_MS, type ArchivedTab } from '@chord/core';
import { ChordDatabase } from '../src/db';
import type { NavState } from '../src';

let dir: string;
let file: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-archive-'));
  file = join(dir, 'chord.db');
  db = new ChordDatabase(file);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = Date.now();
const ICON = 'data:image/png;base64,iVBORw0KGgo=';

function tab(id: string, url: string, title: string, archivedAt: number, reason: ArchivedTab['reason'] = 'auto'): ArchivedTab {
  return { id, chordId: 'c1', url, title, favicon: null, reason, archivedAt };
}

const nav: NavState = { entries: [{ url: 'https://a.test/1', title: 'One' }, { url: 'https://a.test/2', title: 'Two', pageState: 'c2Nyb2xs' }], index: 1 };

describe('archive', () => {
  it('keeps archived tabs, newest first, with their icon and history', () => {
    db.write([], now, [
      { k: 'archive', tab: { ...tab('a1', 'https://a.test/2', 'Two', now - 2000), favicon: ICON }, nav },
      { k: 'archive', tab: tab('a2', 'https://b.test/', 'Bravo', now - 1000, 'closed'), nav: null },
    ]);
    const page = db.archiveList('', 10);
    expect(page.items.map((t) => t.id)).toEqual(['a2', 'a1']);
    expect(page.more).toBe(false);
    expect(page.items[1]!.favicon).toBe(ICON);
    expect(db.archiveGet('a1')).toEqual({ tab: { ...tab('a1', 'https://a.test/2', 'Two', now - 2000), favicon: ICON }, nav });
    expect(db.archiveGet('a2')!.nav).toBeNull();
  });

  it('pages: the newest entries, and whether there are more', () => {
    db.write([], now, [1, 2, 3].map((i) => ({ k: 'archive' as const, tab: tab(`a${i}`, `https://x.test/${i}`, `X ${i}`, now - i), nav: null })));
    expect(db.archiveList('', 2)).toMatchObject({ items: [{ id: 'a1' }, { id: 'a2' }], more: true });
  });

  it('finds entries by any word prefix of title or address, and one letter by substring', () => {
    db.write([], now, [
      { k: 'archive', tab: tab('a1', 'https://github.com/anaremore', 'Austin on GitHub', now), nav: null },
      { k: 'archive', tab: tab('a2', 'https://en.wikipedia.org/wiki/Chord', 'Chord - Wikipedia', now - 1), nav: null },
    ]);
    expect(db.archiveList('git aus', 10).items.map((t) => t.id)).toEqual(['a1']);
    expect(db.archiveList('wiki', 10).items.map((t) => t.id)).toEqual(['a2']);
    expect(db.archiveList('i', 10).items.map((t) => t.id).sort()).toEqual(['a1', 'a2']);
    expect(db.archiveList('k', 10).items.map((t) => t.id)).toEqual(['a2']);
    expect(db.archiveList('zz', 10).items).toEqual([]);
    expect(db.search('chord', null, now).archive.map((t) => t.id)).toEqual(['a2']);
  });

  it('an entry leaves when its tab comes back', () => {
    db.write([], now, [{ k: 'archive', tab: tab('a1', 'https://a.test/', 'Alpha', now), nav: null }]);
    db.write([], now, [{ k: 'unarchive', id: 'a1' }]);
    expect(db.archiveList('', 10).items).toEqual([]);
    expect(db.archiveList('alpha', 10).items).toEqual([]);
    expect(db.archiveGet('a1')).toBeNull();
  });

  it('⌘⇧T after a restart: the newest tab you closed or cleared, not ones tidied away', () => {
    db.write([], now, [
      { k: 'archive', tab: tab('closed', 'https://a.test/', 'A', now - 2000, 'closed'), nav: null },
      { k: 'archive', tab: tab('cleared', 'https://b.test/', 'B', now - 1000, 'cleared'), nav: null },
      { k: 'archive', tab: tab('auto', 'https://c.test/', 'C', now, 'auto'), nav: null },
    ]);
    expect(db.archiveLatest(['closed', 'cleared'])!.tab.id).toBe('cleared');
    expect(db.archiveLatest([])).toBeNull();
  });

  it('forgets entries after 30 days, and keeps the icons archived tabs use', () => {
    db.write([], now, [
      { k: 'archive', tab: tab('old', 'https://old.test/', 'Old', now - ARCHIVE_KEEP_MS - 1000), nav: null },
      { k: 'archive', tab: { ...tab('new', 'https://new.test/', 'New', now), favicon: ICON }, nav: null },
    ]);
    db.close();
    db = new ChordDatabase(file);
    expect(db.archiveList('', 10).items.map((t) => t.id)).toEqual(['new']);
    expect(db.archiveList('', 10).items[0]!.favicon).toBe(ICON);
    // The search index forgot it too.
    expect(db.archiveList('old', 10).items).toEqual([]);
  });
});
