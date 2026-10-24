/**
 * Firefox: bookmarks and history from a copy of `places.sqlite`, open tabs
 * from its session file (mozLz4-compressed JSON, ./lz4.ts). Private windows
 * are never in that file; Chord skips any window marked private regardless.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BookmarkItem, BookmarkRoot, ImportedTab } from '@chord/core';
import { decompressMozLz4 } from './lz4';

/** Places' root folders, by their fixed GUIDs; tags aren't bookmarks. */
const ROOTS: { guid: string; kind: BookmarkRoot['kind']; title: string }[] = [
  { guid: 'toolbar_____', kind: 'bar', title: 'Bookmarks Toolbar' },
  { guid: 'menu________', kind: 'other', title: 'Bookmarks Menu' },
  { guid: 'unfiled_____', kind: 'other', title: 'Other Bookmarks' },
  { guid: 'mobile______', kind: 'other', title: 'Mobile Bookmarks' },
];
const MAX_DEPTH = 64;

interface Row {
  id: number;
  type: number;
  parent: number;
  title: string | null;
  guid: string;
  url: string | null;
}

export function firefoxBookmarks(db: DatabaseSync): BookmarkRoot[] {
  const rows = db
    .prepare('SELECT b.id AS id, b.type AS type, b.parent AS parent, b.title AS title, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position')
    .all() as unknown as Row[];
  const inside = new Map<number, Row[]>();
  for (const row of rows) {
    const list = inside.get(row.parent);
    if (list) list.push(row);
    else inside.set(row.parent, [row]);
  }
  // Type 1 is a bookmark, 2 a folder, 3 a separator.
  const items = (parent: number, depth: number): BookmarkItem[] =>
    (inside.get(parent) ?? []).flatMap((row): BookmarkItem[] => {
      if (row.type === 1 && row.url) return [{ kind: 'link', title: row.title ?? '', url: row.url }];
      if (row.type === 2 && depth < MAX_DEPTH && row.id !== parent) return [{ kind: 'folder', title: row.title ?? '', items: items(row.id, depth + 1) }];
      return [];
    });
  const out: BookmarkRoot[] = [];
  for (const root of ROOTS) {
    const row = rows.find((r) => r.guid === root.guid);
    if (row) out.push({ kind: root.kind, title: root.title, items: items(row.id, 0) });
  }
  return out;
}

const WEB = `(p.url LIKE 'http://%' OR p.url LIKE 'https://%')`;
/** A visit of the page itself: embedded content, downloads and framed links (visit types 4, 7, 8) aren't. Type 2 is a typed address. */
const PAGE_VISIT = 'v.place_id = p.id AND v.visit_type NOT IN (4, 7, 8)';

export const FIREFOX_HISTORY = {
  count: `SELECT COUNT(*) AS n FROM moz_places p WHERE p.hidden = 0 AND ${WEB} AND EXISTS (SELECT 1 FROM moz_historyvisits v WHERE ${PAGE_VISIT})`,
  pages: `SELECT p.id AS id, p.url AS url, p.title AS title, v.visit_date / 1000 AS at, v.visit_type = 2 AS typed
       FROM moz_places p JOIN moz_historyvisits v ON ${PAGE_VISIT}
      WHERE p.hidden = 0 AND ${WEB}
      ORDER BY p.id, v.visit_date`,
};

interface SessionTab {
  entries?: { url?: unknown; title?: unknown }[];
  index?: unknown;
  hidden?: unknown;
}

/** The open tabs in a session file, window by window: each tab's current page. */
export function firefoxTabs(file: Uint8Array): ImportedTab[] {
  const session = JSON.parse(Buffer.from(decompressMozLz4(file)).toString('utf8')) as { windows?: { isPrivate?: unknown; tabs?: SessionTab[] }[] };
  const tabs: ImportedTab[] = [];
  for (const win of session.windows ?? []) {
    if (win.isPrivate === true) continue;
    for (const tab of win.tabs ?? []) {
      if (tab.hidden === true || !Array.isArray(tab.entries) || tab.entries.length === 0) continue;
      // `index` is 1-based, and points at the page the tab shows.
      const at = typeof tab.index === 'number' ? Math.min(Math.max(1, tab.index), tab.entries.length) - 1 : tab.entries.length - 1;
      const entry = tab.entries[at];
      if (typeof entry?.url === 'string') tabs.push({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : '' });
    }
  }
  return tabs;
}
