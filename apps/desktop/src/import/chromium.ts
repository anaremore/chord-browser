/**
 * Chrome, Edge and Brave: bookmarks from the profile's `Bookmarks` JSON,
 * history from a copy of its `History` database. Their open tabs are in
 * session files (SNSS), an undocumented binary log of commands that changes
 * between versions; Chord doesn't read them rather than guess.
 */
import type { BookmarkItem, BookmarkRoot } from '@chord/core';

type Chromium = 'chrome' | 'edge' | 'brave';

/** What each browser calls its roots, so they read the way you know them. */
const ROOT_TITLES: Record<Chromium, { bookmark_bar: string; other: string; synced: string }> = {
  chrome: { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' },
  edge: { bookmark_bar: 'Favorites bar', other: 'Other favorites', synced: 'Mobile favorites' },
  brave: { bookmark_bar: 'Bookmarks', other: 'Other bookmarks', synced: 'Mobile bookmarks' },
};

/** Deeper than anyone nests bookmarks. */
const MAX_DEPTH = 64;

interface ChromiumNode {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  children?: unknown;
}

function item(node: ChromiumNode, depth: number): BookmarkItem | null {
  const title = typeof node.name === 'string' ? node.name : '';
  if (node.type === 'url' && typeof node.url === 'string') return { kind: 'link', title, url: node.url };
  if (node.type !== 'folder' || !Array.isArray(node.children) || depth > MAX_DEPTH) return null;
  return { kind: 'folder', title, items: (node.children as ChromiumNode[]).map((child) => item(child ?? {}, depth + 1)).filter((i): i is BookmarkItem => i !== null) };
}

/** The `Bookmarks` file's roots: the bar first, then Other and Mobile. */
export function chromiumBookmarks(json: string, browser: Chromium): BookmarkRoot[] {
  const roots = (JSON.parse(json) as { roots?: Record<string, ChromiumNode> }).roots ?? {};
  const out: BookmarkRoot[] = [];
  for (const key of ['bookmark_bar', 'other', 'synced'] as const) {
    const root = roots[key];
    const folder = root ? item({ ...root, type: 'folder' }, 0) : null;
    if (folder?.kind === 'folder') out.push({ kind: key === 'bookmark_bar' ? 'bar' : 'other', title: ROOT_TITLES[browser][key], items: folder.items });
  }
  return out;
}

/** Chromium's times are microseconds since 1601 (Windows' epoch); in SQL, so they never pass JavaScript's safe integers. */
const EPOCH_MS = 11_644_473_600_000;
const WEB = `(u.url LIKE 'http://%' OR u.url LIKE 'https://%')`;
/** A visit of the page itself: visits of frames inside pages (core transition types 3 and 4) aren't. Type 1 is a typed address. */
const PAGE_VISIT = 'v.url = u.id AND (v.transition & 255) NOT IN (3, 4)';

export const CHROMIUM_HISTORY = {
  count: `SELECT COUNT(*) AS n FROM urls u WHERE u.hidden = 0 AND ${WEB} AND EXISTS (SELECT 1 FROM visits v WHERE ${PAGE_VISIT})`,
  pages: `SELECT u.id AS id, u.url AS url, u.title AS title, v.visit_time / 1000 - ${EPOCH_MS} AS at, (v.transition & 255) = 1 AS typed
       FROM urls u JOIN visits v ON ${PAGE_VISIT}
      WHERE u.hidden = 0 AND ${WEB}
      ORDER BY u.id, v.visit_time`,
};
