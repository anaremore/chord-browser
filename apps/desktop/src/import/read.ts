/**
 * Reading one browser profile: its bookmarks, open tabs (where readable) and
 * how much history it has; then, when the import runs, its history in batches.
 * Passwords, cookies, autofill and extensions are never opened.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BookmarkRoot, ImportedPage, ImportedTab, ImportPreview } from '@chord/core';
import { CHROMIUM_HISTORY, chromiumBookmarks } from './chromium';
import type { FoundProfile } from './detect';
import { countOf, ImportProblem, openCopy, readIfThere } from './files';
import { FIREFOX_HISTORY, firefoxBookmarks, firefoxTabs } from './firefox';
import { pagesOf } from './history';
import { parseBinaryPlist } from './plist';
import { SAFARI_HISTORY, safariBookmarks } from './safari';

/** Each browser's history database, and the query that reads it as visit rows (./history.ts). */
function historySource(profile: FoundProfile): { file: string; sql: { count: string; pages: string } } {
  switch (profile.browser) {
    case 'firefox':
      return { file: join(profile.dir, 'places.sqlite'), sql: FIREFOX_HISTORY };
    case 'safari':
      return { file: join(profile.dir, 'History.db'), sql: SAFARI_HISTORY };
    default:
      return { file: join(profile.dir, 'History'), sql: CHROMIUM_HISTORY };
  }
}

/** A parser's failure on a damaged file is the profile's: Chord says it couldn't read it. */
function parsed<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new ImportProblem('unreadable');
  }
}

/**
 * Firefox's open tabs: from the session file it keeps while running
 * (recovery), or the one it writes on quitting, whichever is newer; then the
 * one before. None at all is no tabs.
 */
async function firefoxSession(dir: string): Promise<ImportedTab[]> {
  const newest = ['sessionstore-backups/recovery.jsonlz4', 'sessionstore.jsonlz4'].map((name) => join(dir, name));
  const times = await Promise.all(newest.map((file) => stat(file).then((s) => s.mtimeMs, () => -1)));
  const order = newest.map((file, i) => ({ file, at: times[i]! })).sort((a, b) => b.at - a.at).map((c) => c.file);
  for (const file of [...order, join(dir, 'sessionstore-backups/previous.jsonlz4')]) {
    const bytes = await readIfThere(file);
    if (!bytes) continue;
    try {
      return firefoxTabs(bytes);
    } catch {
      // A file caught mid-write, or damaged: the next one.
    }
  }
  return [];
}

/** What a profile holds, read from copies of its files in `temp`. */
export async function readProfile(profile: FoundProfile, temp: string): Promise<ImportPreview> {
  if (profile.denied) throw new ImportProblem('denied');
  const source = historySource(profile);
  const db = await openCopy(source.file, temp);
  try {
    let roots: BookmarkRoot[] = [];
    let tabs: ImportedTab[] | null = null;
    if (profile.browser === 'firefox') {
      if (!db) throw new ImportProblem('missing');
      roots = parsed(() => firefoxBookmarks(db));
      tabs = await firefoxSession(profile.dir);
    } else if (profile.browser === 'safari') {
      const plist = await readIfThere(join(profile.dir, 'Bookmarks.plist'));
      if (plist) roots = parsed(() => safariBookmarks(parseBinaryPlist(plist)));
    } else {
      const json = await readIfThere(join(profile.dir, 'Bookmarks'));
      if (json) roots = parsed(() => chromiumBookmarks(json.toString('utf8'), profile.browser as 'chrome' | 'edge' | 'brave'));
    }
    return { roots, tabs, history: db ? countOf(db, source.sql.count) : 0 };
  } finally {
    db?.close();
  }
}

/** A profile's history, a batch at a time, from a copy of its database in `temp`. Close it when done. */
export async function openHistory(profile: FoundProfile, temp: string): Promise<{ batches: Iterator<ImportedPage[]>; close(): void }> {
  if (profile.denied) throw new ImportProblem('denied');
  const source = historySource(profile);
  const db: DatabaseSync | null = await openCopy(source.file, temp);
  if (!db) return { batches: [][Symbol.iterator](), close: () => undefined };
  const rows = parsed(() => db.prepare(source.sql.pages).iterate());
  return { batches: pagesOf(rows), close: () => db.close() };
}
