/**
 * Safari (macOS): bookmarks from `Bookmarks.plist` (a binary plist,
 * ./plist.ts), history from a copy of `History.db`. Both sit in
 * ~/Library/Safari, which macOS lets an app read only with Full Disk Access.
 */
import type { BookmarkItem, BookmarkRoot } from '@chord/core';
import type { PlistValue } from './plist';

const MAX_DEPTH = 64;

type Dict = { [key: string]: PlistValue };
const isDict = (v: PlistValue | undefined): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
const listOf = (v: PlistValue | undefined): Dict[] => (Array.isArray(v) ? v.filter(isDict) : []);
const text = (v: PlistValue | undefined): string => (typeof v === 'string' ? v : '');

function item(node: Dict, depth: number): BookmarkItem | null {
  const type = node['WebBookmarkType'];
  if (type === 'WebBookmarkTypeLeaf') {
    const url = text(node['URLString']);
    const uri = node['URIDictionary'];
    return url ? { kind: 'link', title: isDict(uri) ? text(uri['title']) : '', url } : null;
  }
  if (type !== 'WebBookmarkTypeList' || depth > MAX_DEPTH) return null;
  return { kind: 'folder', title: text(node['Title']), items: listOf(node['Children']).map((child) => item(child, depth + 1)).filter((i): i is BookmarkItem => i !== null) };
}

/**
 * The plist's roots: Favorites (Safari's bookmarks bar), the Bookmarks Menu,
 * the Reading List, and folders kept at the top of the sidebar.
 */
export function safariBookmarks(plist: PlistValue): BookmarkRoot[] {
  const out: BookmarkRoot[] = [];
  const loose: BookmarkItem[] = [];
  for (const child of listOf(isDict(plist) ? plist['Children'] : undefined)) {
    const title = text(child['Title']);
    const folder = item(child, 0);
    if (title === 'BookmarksBar' && folder?.kind === 'folder') out.unshift({ kind: 'bar', title: 'Favorites', items: folder.items });
    else if (title === 'BookmarksMenu' && folder?.kind === 'folder') out.push({ kind: 'other', title: 'Bookmarks Menu', items: folder.items });
    else if (title === 'com.apple.ReadingList' && folder?.kind === 'folder') out.push({ kind: 'other', title: 'Reading List', items: folder.items });
    // History shows in the sidebar as a "proxy"; it isn't a bookmark.
    else if (folder) loose.push(folder);
  }
  if (loose.length > 0) out.push({ kind: 'other', title: 'Bookmarks', items: loose });
  return out;
}

const WEB = `(i.url LIKE 'http://%' OR i.url LIKE 'https://%')`;

export const SAFARI_HISTORY = {
  count: `SELECT COUNT(*) AS n FROM history_items i WHERE ${WEB} AND EXISTS (SELECT 1 FROM history_visits v WHERE v.history_item = i.id)`,
  // Visit times are seconds since 2001 (Apple's epoch); Safari doesn't say which were typed.
  pages: `SELECT i.id AS id, i.url AS url, v.title AS title, CAST((v.visit_time + 978307200) * 1000 AS INTEGER) AS at, 0 AS typed
       FROM history_items i JOIN history_visits v ON v.history_item = i.id
      WHERE ${WEB}
      ORDER BY i.id, v.visit_time`,
};
