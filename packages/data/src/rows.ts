/**
 * chord-data's rows as the model has them: what the database reads back at
 * launch (db.ts) and what an export writes out (export.ts). Unchecked beyond
 * their types: restore, and a reader of an export, check the rest.
 */
import { cleanSiteEffects, type Chord, type ChordThemeSpec, type Favorite, type FolderNode, type SidebarNode, type SiteEffects, type SplitNode, type TabNode } from '@chord/core';

export type Row = Record<string, unknown>;

export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
export const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const num = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0);

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const joinDataUrl = (mime: string, data: Uint8Array) => `data:${mime};base64,${Buffer.from(data).toString('base64')}`;

/** A row's icon as the model keeps it: a `data:` URL, from the favicon row joined as icon_mime and icon_data. */
export const iconOf = (r: Row): string | null =>
  typeof r['icon_mime'] === 'string' && r['icon_data'] instanceof Uint8Array ? joinDataUrl(r['icon_mime'], r['icon_data']) : null;

/** A chord as saved. Its proxy is checked by restore (core's cleanProxy), as every JSON column is at the boundary. */
export function chordOf(r: Row): Chord {
  const proxy = parseJson<Chord['proxy'] | null>(r['proxy'], null);
  return {
    id: str(r['id']),
    profileId: str(r['profile_id']),
    name: str(r['name']),
    icon: str(r['icon']),
    theme: parseJson<ChordThemeSpec>(r['theme'], { stops: [{ l: 0.72, c: 0.12, h: 300 }], grain: 0.2, appearance: 'auto' }),
    rank: str(r['rank']),
    createdAt: num(r['created_at']),
    ...(proxy ? { proxy } : {}),
  };
}

/** Sidebar nodes with their tab, folder or split row (and `extra` columns, such as the icon's), for `nodeOf`. */
export const nodeSelect = (extra = '', joins = '') =>
  `SELECT n.*, t.url, t.title AS tab_title, t.pinned_url, t.custom_title, t.last_active_at, t.muted, t.favicon_key,
          f.title AS folder_title, f.collapsed, s.layout AS split_layout${extra}
     FROM node n
     LEFT JOIN tab t ON t.node_id = n.id
     LEFT JOIN folder f ON f.node_id = n.id
     LEFT JOIN split s ON s.node_id = n.id${joins}
    WHERE n.deleted_at IS NULL`;

/** A sidebar node from `nodeSelect`'s row, with its icon; null for a row missing its tab, folder or split. */
export function nodeOf(r: Row, favicon: string | null): SidebarNode | null {
  const base = { id: str(r['id']), chordId: str(r['chord_id']), parentId: strOrNull(r['parent_id']), rank: str(r['rank']), createdAt: num(r['created_at']) };
  if (r['kind'] === 'tab' && typeof r['url'] === 'string') {
    const tab: TabNode = {
      ...base,
      kind: 'tab',
      section: r['section'] === 'pinned' ? 'pinned' : 'today',
      url: r['url'],
      title: str(r['tab_title']),
      pinnedUrl: strOrNull(r['pinned_url']),
      customTitle: strOrNull(r['custom_title']),
      favicon,
      lastActiveAt: num(r['last_active_at']),
      ...(num(r['muted']) === 1 ? { muted: true } : {}),
    };
    return tab;
  }
  if (r['kind'] === 'folder' && typeof r['folder_title'] === 'string') {
    const folder: FolderNode = { ...base, kind: 'folder', section: 'pinned', title: r['folder_title'], collapsed: num(r['collapsed']) === 1 };
    return folder;
  }
  if (r['kind'] === 'split' && typeof r['split_layout'] === 'string') {
    // Restore checks the panes and sizes (core settleSplits); here they're just read back.
    const layout = parseJson<{ direction?: unknown; sizes?: unknown }>(r['split_layout'], {});
    const split: SplitNode = {
      ...base,
      kind: 'split',
      section: r['section'] === 'pinned' ? 'pinned' : 'today',
      direction: layout.direction === 'column' ? 'column' : 'row',
      sizes: Array.isArray(layout.sizes) ? layout.sizes.filter((s): s is number => typeof s === 'number') : [],
    };
    return split;
  }
  return null;
}

export function favoriteOf(r: Row, favicon: string | null): Favorite {
  return { id: str(r['id']), url: str(r['url']), title: str(r['title']), favicon, rank: str(r['rank']), createdAt: num(r['created_at']) };
}

/** A site's Effects as saved, checked as an import would be (core's cleanSiteEffects); null for a row that isn't one. */
export function siteEffectsOf(r: Row): SiteEffects | null {
  return cleanSiteEffects({
    host: r['host'],
    wet: num(r['wet']) !== 0,
    css: r['css'],
    cssOn: num(r['css_on']) !== 0,
    hidden: parseJson<unknown>(r['hidden'], []),
    presets: parseJson<unknown>(r['presets'], []),
    duet: parseJson<unknown>(r['duet'], []),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
  });
}
