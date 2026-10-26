/**
 * Your data's export, chord-data's half (docs/decisions/S15-your-data.md §7):
 * rows into records (core's records.ts), in the file's order: setup, then
 * Today tabs and the icons both use, then history, then Duet. It runs in the
 * export process over a connection of its own, read-only and inside one read
 * transaction, so the export is one moment's data while chord-data goes on
 * writing, and chord-data's thread does nothing for it.
 *
 * Stamps come from each row's `updated_at` (core's rowStamp): an export runs
 * without sync's own. Only what S15 §1 lists is read: never back/forward
 * state, the archive, downloads, windows, extensions or learned picks.
 */
import type { StatementSync } from 'node:sqlite';
import {
  chordRecord,
  DEFAULT_PROFILE,
  effectsRecord,
  favoriteRecord,
  iconId,
  iconRecord,
  imageRecord,
  messageRecord,
  nodeRecord,
  pageRecord,
  permissionRecord,
  restoreChord,
  routeRecord,
  rowStamp,
  settingsRecords,
  themeRecords,
  threadRecord,
  validTheme,
  zoomRecord,
  type DataRecord,
  type DuetImage,
  type DuetMessageBody,
  type DuetThread,
  type ExportCounts,
  type Platform,
  type SidebarNode,
  type SitePermissions,
} from '@chord/core';
import { chordOf, favoriteOf, nodeOf, nodeSelect, num, parseJson, siteEffectsOf, str, type Row } from './rows';

type Sql = (text: string) => StatementSync;

/**
 * The images Duet's messages name: the ones a user gave it, and the ones Codex
 * made. Only with an id Chord makes (24 hex digits), since it becomes a file name.
 */
function imagesOf(body: DuetMessageBody): DuetImage[] {
  const images = body.role === 'user' || body.role === 'assistant' ? (body.images ?? []) : [];
  return Array.isArray(images) ? images.filter((image) => typeof image?.id === 'string' && /^[0-9a-f]{24}$/.test(image.id)) : [];
}

const LIVE_CHORD = 'JOIN chord c ON c.id = n.chord_id AND c.deleted_at IS NULL';

export function exportCounts(sql: Sql): ExportCounts {
  const count = (text: string, ...params: string[]) => num((sql(text).get(...params) as Row)['n']);
  const tabs = (section: string) => count(`SELECT COUNT(*) AS n FROM node n JOIN tab t ON t.node_id = n.id ${LIVE_CHORD} WHERE n.deleted_at IS NULL AND n.section = ?`, section);
  const themes = parseJson<unknown>((sql(`SELECT value FROM setting WHERE key = 'themes'`).get() as Row | undefined)?.['value'], []);
  const images = new Set<string>();
  for (const r of sql(`SELECT body FROM duet_message WHERE body LIKE '%"images":%'`).all() as Row[]) {
    for (const image of imagesOf(parseJson<DuetMessageBody>(r['body'], { role: 'divider', text: '' }))) images.add(image.id);
  }
  return {
    chords: count('SELECT COUNT(*) AS n FROM chord WHERE deleted_at IS NULL'),
    pinnedTabs: tabs('pinned'),
    folders: count(`SELECT COUNT(*) AS n FROM node n JOIN folder f ON f.node_id = n.id ${LIVE_CHORD} WHERE n.deleted_at IS NULL`),
    todayTabs: tabs('today'),
    favorites: count('SELECT COUNT(*) AS n FROM favorite'),
    themes: Array.isArray(themes) ? themes.filter((t) => validTheme(t) !== null).length : 0,
    routes: count(`SELECT COUNT(*) AS n FROM link_route r JOIN chord c ON c.id = r.chord_id AND c.deleted_at IS NULL`),
    effects: count('SELECT COUNT(*) AS n FROM effect'),
    pages: count(`SELECT COUNT(DISTINCT url_id) AS n FROM history_visit v JOIN history_url u ON u.id = v.url_id WHERE u.profile_id = ?`, DEFAULT_PROFILE),
    chats: count('SELECT COUNT(*) AS n FROM duet_thread'),
    images: images.size,
  };
}

export interface ExportOptions {
  /** This computer's id (ChordDatabase.device), for the stamps. */
  device: string;
  /** Which family of keyboard shortcuts this computer writes. */
  platform: Platform;
  history: boolean;
  duet: boolean;
  /** SHA-256 of an icon's bytes, as hex: its record's id. */
  sha256(bytes: Uint8Array): string;
  /** An image's bytes and its thumbnail, from `<userData>/duet/images/`; null when the file has gone. */
  image(image: DuetImage): { data: Uint8Array; thumb: Uint8Array | null } | null;
}

/** Where a record belongs in the file, for the progress line: `setup`, then `today` with the icons, `history`, `duet`. */
export type ExportPhase = 'setup' | 'today' | 'history' | 'duet';

export interface ExportItem {
  phase: ExportPhase;
  record: DataRecord;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/** The sidebar as it reads: each chord's nodes, a parent before what's in it, in rank order. One whose parent is gone comes last. */
function sidebarOrder(nodes: readonly SidebarNode[], chordOrder: readonly string[]): SidebarNode[] {
  const children = new Map<string, SidebarNode[]>();
  for (const node of nodes) {
    const key = `${node.chordId}\n${node.section}\n${node.parentId ?? ''}`;
    children.set(key, [...(children.get(key) ?? []), node]);
  }
  for (const list of children.values()) list.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  const out: SidebarNode[] = [];
  const seen = new Set<string>();
  const walk = (chordId: string, section: string, parentId: string | null) => {
    for (const node of children.get(`${chordId}\n${section}\n${parentId ?? ''}`) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
      walk(chordId, section, node.id);
    }
  };
  for (const chordId of chordOrder) for (const section of ['pinned', 'today']) walk(chordId, section, null);
  return [...out, ...nodes.filter((n) => !seen.has(n.id))];
}

/**
 * Every record an export holds, in order. Rows are read as they're written
 * out (`iterate`), so history and Duet are never all in memory at once.
 */
export function* exportRecords(sql: Sql, options: ExportOptions): Generator<ExportItem> {
  const { device } = options;
  const stamp = (r: Row) => rowStamp(num(r['updated_at']), device);

  // Chords, as restore keeps them: a proxy of its own only with sign-ins of its own.
  const chordRows = sql('SELECT * FROM chord WHERE deleted_at IS NULL ORDER BY rank, id').all() as Row[];
  const chordIds = chordRows.map((r) => str(r['id']));
  const live = new Set(chordIds);
  const nodeRows = (sql(`${nodeSelect()} ORDER BY n.rank, n.id`).all() as Row[]).filter((r) => live.has(str(r['chord_id'])));
  const nodes = sidebarOrder(
    nodeRows.map((r) => nodeOf(r, null)).filter((n): n is SidebarNode => n !== null),
    chordIds,
  );
  const nodeRow = new Map(nodeRows.map((r) => [str(r['id']), r]));
  const favoriteRows = sql('SELECT * FROM favorite ORDER BY rank, id').all() as Row[];

  // Icons are records of their own, by their bytes' hash: one each, however many tabs and Favorites use it.
  const icons = new Map<string, { id: string; mime: string; data: Uint8Array }>();
  const iconFor = (key: unknown): string | null => {
    if (typeof key !== 'string') return null;
    const known = icons.get(key);
    if (known) return known.id;
    const row = sql('SELECT mime, data FROM favicon WHERE key = ?').get(key) as Row | undefined;
    if (!row || !(row['data'] instanceof Uint8Array) || typeof row['mime'] !== 'string') return null;
    const icon = { id: iconId(options.sha256(row['data'])), mime: row['mime'], data: row['data'] };
    icons.set(key, icon);
    return icon.id;
  };

  for (const r of chordRows) {
    const record = chordRecord(restoreChord(chordOf(r)), stamp(r));
    if (record) yield { phase: 'setup', record };
  }
  for (const node of nodes) {
    if (node.section !== 'pinned') continue;
    const r = nodeRow.get(node.id)!;
    yield { phase: 'setup', record: nodeRecord(node, stamp(r), node.kind === 'tab' ? iconFor(r['favicon_key']) : null) };
  }
  for (const r of favoriteRows) yield { phase: 'setup', record: favoriteRecord(favoriteOf(r, null), stamp(r), iconFor(r['favicon_key'])) };

  const settingRows = (sql('SELECT key, value, updated_at FROM setting ORDER BY key').all() as Row[]).map((r) => ({
    key: str(r['key']),
    value: parseJson<unknown>(r['value'], null),
    updatedAt: num(r['updated_at']),
  }));
  for (const record of themeRecords(settingRows.find((r) => r.key === 'themes'), device)) yield { phase: 'setup', record };
  for (const record of settingsRecords(settingRows, device, options.platform)) yield { phase: 'setup', record };

  for (const r of sql('SELECT * FROM link_route ORDER BY host').all() as Row[]) {
    if (live.has(str(r['chord_id']))) yield { phase: 'setup', record: routeRecord({ host: str(r['host']), chordId: str(r['chord_id']), createdAt: num(r['created_at']) }, stamp(r)) };
  }
  for (const r of sql('SELECT * FROM effect ORDER BY host').all() as Row[]) {
    const site = siteEffectsOf(r);
    if (site) yield { phase: 'setup', record: effectsRecord(site, stamp(r)) };
  }
  for (const r of sql('SELECT host, factor, updated_at FROM site_zoom WHERE profile_id = ? ORDER BY host').all(DEFAULT_PROFILE) as Row[]) {
    yield { phase: 'setup', record: zoomRecord(str(r['host']), num(r['factor']), stamp(r)) };
  }
  // A site's decisions made at different times carry different stamps: one record each.
  const decisions = new Map<string, SitePermissions[string]>();
  for (const r of sql('SELECT origin, permission, decision, updated_at FROM site_permission WHERE profile_id = ? ORDER BY origin, updated_at').all(DEFAULT_PROFILE) as Row[]) {
    const key = `${str(r['origin'])}\n${num(r['updated_at'])}`;
    decisions.set(key, { ...decisions.get(key), [str(r['permission'])]: str(r['decision']) });
  }
  for (const [key, set] of decisions) {
    const [origin, updatedAt] = key.split('\n') as [string, string];
    const record = permissionRecord(origin, set, rowStamp(Number(updatedAt), device));
    if (record) yield { phase: 'setup', record };
  }

  for (const node of nodes) {
    if (node.section !== 'today') continue;
    const r = nodeRow.get(node.id)!;
    yield { phase: 'today', record: nodeRecord(node, stamp(r), node.kind === 'tab' ? iconFor(r['favicon_key']) : null) };
  }
  const written = new Set<string>();
  for (const icon of icons.values()) {
    if (written.has(icon.id)) continue;
    written.add(icon.id);
    yield { phase: 'today', record: iconRecord({ id: icon.id, mime: icon.mime, data: base64(icon.data) }) };
  }

  if (options.history) {
    // One page's visits are next to each other, oldest first; a page is written when the next one starts.
    let page: { id: number; url: string; title: string; typed: number; visits: number[] } | null = null;
    const visits = sql(
      `SELECT u.id, u.url, u.title, u.typed_count, v.visited_at FROM history_url u JOIN history_visit v ON v.url_id = u.id
        WHERE u.profile_id = ? ORDER BY u.id, v.visited_at`,
    );
    for (const r of visits.iterate(DEFAULT_PROFILE) as Iterable<Row>) {
      const id = num(r['id']);
      if (page && page.id !== id) yield { phase: 'history', record: pageRecord(page) };
      if (!page || page.id !== id) page = { id, url: str(r['url']), title: str(r['title']), typed: num(r['typed_count']), visits: [] };
      page.visits.push(num(r['visited_at']));
    }
    if (page) yield { phase: 'history', record: pageRecord(page) };
  }

  if (options.duet) {
    // Each chat, then its messages, then their images, so a reader that stops part way has whole chats.
    const messages = sql('SELECT * FROM duet_message WHERE thread_id = ? ORDER BY created_at, rid');
    const imagesWritten = new Set<string>();
    for (const t of sql('SELECT * FROM duet_thread ORDER BY created_at, id').all() as Row[]) {
      const thread: DuetThread = {
        id: str(t['id']),
        chordId: str(t['chord_id']),
        title: str(t['title']),
        provider: str(t['provider']) as DuetThread['provider'],
        model: typeof t['model'] === 'string' ? t['model'] : null,
        providerSessionId: null,
        scope: str(t['scope']) as DuetThread['scope'],
        createdAt: num(t['created_at']),
        updatedAt: num(t['updated_at']),
        lastUsedAt: num(t['last_used_at']),
      };
      yield { phase: 'duet', record: threadRecord(thread) };
      const images: DuetImage[] = [];
      for (const m of messages.iterate(thread.id) as Iterable<Row>) {
        const body = parseJson<DuetMessageBody | null>(m['body'], null);
        if (!body || typeof body !== 'object' || typeof body.role !== 'string') continue;
        yield { phase: 'duet', record: messageRecord({ id: str(m['id']), threadId: thread.id, createdAt: num(m['created_at']), body }) };
        images.push(...imagesOf(body));
      }
      for (const image of images) {
        if (imagesWritten.has(image.id)) continue;
        imagesWritten.add(image.id);
        const bytes = options.image(image);
        if (bytes) yield { phase: 'duet', record: imageRecord(image, base64(bytes.data), bytes.thumb ? base64(bytes.thumb) : null) };
      }
    }
  }
}
