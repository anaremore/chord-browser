/**
 * chord-data's database (ARCHITECTURE.md §7). Runs only in the chord-data
 * utility process, never on main: `node:sqlite` is synchronous.
 */
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  ARCHIVE_KEEP_MS,
  foldChoiceText,
  frecencyOn,
  pickedAgain,
  placeKey,
  profilePartition,
  SIDEBAR_WIDTH,
  terms,
  used,
  type ArchivedTab,
  type ArchiveReason,
  type Chord,
  type ChordThemeSpec,
  type Choice,
  type Download,
  type Favorite,
  type InstalledExtension,
  type FolderNode,
  type PersistedState,
  type SidebarNode,
  type SitePermissions,
  type TabNode,
  type WindowModel,
} from '@chord/core';
import type { ArchiveEntry, ArchivePage, HistoryEvent, NavState, SearchResult, WriteOp } from './index';
import { MIGRATIONS } from './migrations';

/** The profile every chord belongs to until "Keep sign-ins separate" exists. */
const DEFAULT_PROFILE = 'default';
/** History rows a search ranks; the command bar shows a handful. */
const SEARCH_LIMIT = 50;
const MAX_CHOICES_PER_CHORD = 1000;
/** Archive matches the command bar ranks. */
const ARCHIVE_SEARCH_LIMIT = 20;
/** Picks nobody repeats are forgotten after 90 days. */
const CHOICE_LIFETIME_MS = 90 * 86_400_000;

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0);

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** `data:` favicon URLs are stored once each, by content hash. */
function splitDataUrl(url: string): { key: string; mime: string; data: Uint8Array } | null {
  const match = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const [, mime, , base64, payload] = match;
  const data = base64 ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!), 'utf8');
  return { key: createHash('sha256').update(url).digest('hex'), mime: mime!, data };
}

const joinDataUrl = (mime: string, data: Uint8Array) => `data:${mime};base64,${Buffer.from(data).toString('base64')}`;

/** Archive entries with their icons. */
const ARCHIVE_SELECT = `SELECT a.*, i.mime AS icon_mime, i.data AS icon_data FROM archive_item a LEFT JOIN favicon i ON i.key = a.favicon_key`;

function archivedTab(r: Row): ArchivedTab {
  const reason = str(r['reason']);
  return {
    id: str(r['id']),
    chordId: str(r['chord_id']),
    url: str(r['url']),
    title: str(r['title']),
    favicon: typeof r['icon_mime'] === 'string' && r['icon_data'] instanceof Uint8Array ? joinDataUrl(r['icon_mime'], r['icon_data']) : null,
    reason: reason === 'closed' || reason === 'cleared' ? reason : 'auto',
    archivedAt: num(r['archived_at']),
  };
}

export class ChordDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    // Archived tabs past their keep-by date, icons nothing uses any more, and picks unused for their lifetime.
    this.db.prepare('DELETE FROM archive_item WHERE archived_at < ?').run(Date.now() - ARCHIVE_KEEP_MS);
    this.db.exec(
      `DELETE FROM favicon WHERE key NOT IN (SELECT favicon_key FROM tab WHERE favicon_key IS NOT NULL
         UNION SELECT favicon_key FROM archive_item WHERE favicon_key IS NOT NULL
         UNION SELECT favicon_key FROM favorite WHERE favicon_key IS NOT NULL)`,
    );
    this.db.prepare('DELETE FROM palette_choice WHERE last_used_at < ?').run(Date.now() - CHOICE_LIFETIME_MS);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  get version(): number {
    return num((this.db.prepare('PRAGMA user_version').get() as Row)['user_version']);
  }

  private migrate(): void {
    const from = this.version;
    if (from >= MIGRATIONS.length) return;
    if (from > 0) {
      // A copy of the old version first, so a failed migration loses nothing.
      const backup = `${this.file}.v${from}.bak`;
      if (existsSync(backup)) rmSync(backup);
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Profiles no chord uses any more (its sign-ins were shared again, or the
   * chord was deleted): their rows go. Returns their partitions. Main deletes
   * the sign-ins on disk itself, from the folders (removeUnusedPartitions),
   * because a profile switched on and off between two writes never gets a row.
   */
  pruneProfiles(): string[] {
    const unused = this.sql('SELECT id, partition FROM profile WHERE is_default = 0 AND id NOT IN (SELECT profile_id FROM chord)').all() as Row[];
    for (const r of unused) this.sql('DELETE FROM profile WHERE id = ?').run(str(r['id']));
    return unused.map((r) => str(r['partition']));
  }

  /** Everything saved, or null for a brand-new profile. */
  load(): PersistedState | null {
    const chordRows = this.sql('SELECT * FROM chord WHERE deleted_at IS NULL').all() as Row[];
    const settingRows = this.sql('SELECT key, value FROM setting').all() as Row[];
    const settings = Object.fromEntries(settingRows.map((r) => [str(r['key']), parseJson<unknown>(r['value'], null)]));
    const sitePermissions: SitePermissions = {};
    for (const r of this.sql('SELECT origin, permission, decision FROM site_permission WHERE profile_id = ?').all(DEFAULT_PROFILE) as Row[]) {
      (sitePermissions[str(r['origin'])] ??= {})[str(r['permission']) as keyof SitePermissions[string]] = r['decision'] === 'allow' ? 'allow' : 'block';
    }
    const downloads = (this.sql('SELECT * FROM download WHERE profile_id = ?').all(DEFAULT_PROFILE) as Row[]).map(
      (r): Download => ({
        id: str(r['id']),
        url: str(r['url']),
        filename: str(r['filename']),
        path: str(r['path']),
        mime: str(r['mime']),
        state: str(r['state']) as Download['state'],
        received: num(r['received']),
        total: num(r['total']),
        speed: 0,
        startedAt: num(r['started_at']),
        endedAt: r['ended_at'] === null ? null : num(r['ended_at']),
      }),
    );
    const favorites = (
      this.sql(
        `SELECT f.*, i.mime AS icon_mime, i.data AS icon_data FROM favorite f LEFT JOIN favicon i ON i.key = f.favicon_key`,
      ).all() as Row[]
    ).map(
      (r): Favorite => ({
        id: str(r['id']),
        url: str(r['url']),
        title: str(r['title']),
        favicon: typeof r['icon_mime'] === 'string' && r['icon_data'] instanceof Uint8Array ? joinDataUrl(r['icon_mime'], r['icon_data']) : null,
        rank: str(r['rank']),
        createdAt: num(r['created_at']),
      }),
    );
    const extensions = (this.sql('SELECT * FROM extension').all() as Row[]).map(
      (r): InstalledExtension => ({
        id: str(r['id']),
        profileId: str(r['profile_id']),
        name: str(r['name']),
        version: str(r['version']),
        source: r['source'] === 'unpacked' ? 'unpacked' : 'store',
        path: str(r['path']),
        notifiedVersion: strOrNull(r['notified_version']),
        pinned: num(r['pinned']) !== 0,
        installedAt: num(r['installed_at']),
        updatedAt: num(r['updated_at']),
      }),
    );
    if (chordRows.length === 0) {
      const anything =
        Object.keys(settings).length > 0 || Object.keys(sitePermissions).length > 0 || downloads.length > 0 || extensions.length > 0 || favorites.length > 0;
      return anything ? { chords: [], nodes: [], windows: [], settings, sitePermissions, downloads, extensions, favorites } : null;
    }

    const chords = chordRows.map(
      (r): Chord => ({
        id: str(r['id']),
        profileId: str(r['profile_id']),
        name: str(r['name']),
        icon: str(r['icon']),
        theme: parseJson<ChordThemeSpec>(r['theme'], { stops: [{ l: 0.72, c: 0.12, h: 300 }], grain: 0.2, appearance: 'auto' }),
        rank: str(r['rank']),
        createdAt: num(r['created_at']),
      }),
    );

    const nodeRows = this.sql(
      `SELECT n.*, t.url, t.title AS tab_title, t.pinned_url, t.custom_title, t.last_active_at,
              f.title AS folder_title, f.collapsed, i.mime AS icon_mime, i.data AS icon_data
         FROM node n
         LEFT JOIN tab t ON t.node_id = n.id
         LEFT JOIN folder f ON f.node_id = n.id
         LEFT JOIN favicon i ON i.key = t.favicon_key
        WHERE n.deleted_at IS NULL`,
    ).all() as Row[];
    const nodes: SidebarNode[] = [];
    for (const r of nodeRows) {
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
          favicon: typeof r['icon_mime'] === 'string' && r['icon_data'] instanceof Uint8Array ? joinDataUrl(r['icon_mime'], r['icon_data']) : null,
          lastActiveAt: num(r['last_active_at']),
        };
        nodes.push(tab);
      } else if (r['kind'] === 'folder' && typeof r['folder_title'] === 'string') {
        const folder: FolderNode = { ...base, kind: 'folder', section: 'pinned', title: r['folder_title'], collapsed: num(r['collapsed']) === 1 };
        nodes.push(folder);
      }
    }

    const windows = (this.sql('SELECT * FROM window_state').all() as Row[]).map(
      (r): WindowModel => ({
        id: str(r['id']),
        activeChordId: str(r['active_chord_id']),
        activeTab: parseJson<WindowModel['activeTab']>(r['active_tab_by_chord'], {}),
        sidebar: r['sidebar_mode'] === 'collapsed' ? 'collapsed' : 'docked',
        sidebarWidth: num(r['sidebar_width']),
        bounds: parseJson<WindowModel['bounds']>(r['bounds'], null),
      }),
    );

    return { chords, nodes, windows, settings, sitePermissions, downloads, extensions, favorites };
  }

  /** One batch, all or nothing. */
  write(ops: readonly WriteOp[], now = Date.now(), events: readonly HistoryEvent[] = []): void {
    this.transaction(() => {
      for (const event of events) this.record(event);
      for (const op of ops) {
        if (op.k === 'chord') this.writeChord(op.id, op.value, now);
        else if (op.k === 'node') this.writeNode(op.id, op.value, now);
        else if (op.k === 'window') this.writeWindow(op.id, op.value);
        else if (op.k === 'sitePermission') this.writeSitePermissions(op.id, op.value, now);
        else if (op.k === 'download') this.writeDownload(op.id, op.value);
        else if (op.k === 'favorite') this.writeFavorite(op.id, op.value, now);
        else if (op.k === 'extension') this.writeExtension(op.id, op.value);
        else if (op.value === null) this.sql('DELETE FROM setting WHERE key = ?').run(op.id);
        else this.sql('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(op.id, JSON.stringify(op.value));
      }
    });
  }

  private record(event: HistoryEvent): void {
    if (event.k === 'archive') {
      const { tab, nav } = event;
      const icon = tab.favicon ? this.storeFavicon(tab.favicon, tab.archivedAt) : null;
      this.sql(
        `INSERT INTO archive_item (id, profile_id, chord_id, url, title, favicon_key, nav_state, reason, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).run(tab.id, DEFAULT_PROFILE, tab.chordId, tab.url, tab.title, icon, nav ? JSON.stringify(nav) : null, tab.reason, tab.archivedAt);
      return;
    }
    if (event.k === 'unarchive') {
      this.sql('DELETE FROM archive_item WHERE id = ?').run(event.id);
      return;
    }
    if (event.k === 'title') {
      const place = placeKey(event.url);
      if (place && event.title) {
        this.sql('UPDATE history_url SET title = ? WHERE profile_id = ? AND place = ? AND title != ?').run(event.title, DEFAULT_PROFILE, place, event.title);
      }
      return;
    }
    if (event.k === 'visit') {
      const id = this.use(event.url, event.title, event.at, { visit: true, typed: false });
      if (id !== null) this.sql('INSERT INTO history_visit (url_id, visited_at, transition) VALUES (?, ?, ?)').run(id, event.at, 'link');
      return;
    }
    // A pick: learned for its text, and a typed use of its address (so a typed visit counts twice).
    if (event.address) this.use(event.address, '', event.at, { visit: false, typed: true });
    const text = foldChoiceText(event.text);
    if (!text) return;
    const previous = this.sql('SELECT uses, last_used_at FROM palette_choice WHERE chord_id = ? AND text = ? AND destination = ?').get(
      event.chordId,
      text,
      event.destination,
    ) as Row | undefined;
    const uses = pickedAgain(
      previous ? { text, destination: event.destination, uses: num(previous['uses']), lastUsedAt: num(previous['last_used_at']) } : undefined,
      event.at,
    );
    this.sql(
      `INSERT INTO palette_choice (chord_id, text, destination, uses, last_used_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chord_id, text, destination) DO UPDATE SET uses = excluded.uses, last_used_at = excluded.last_used_at`,
    ).run(event.chordId, text, event.destination, uses, event.at);
    this.sql(
      `DELETE FROM palette_choice WHERE chord_id = ? AND rowid NOT IN
         (SELECT rowid FROM palette_choice WHERE chord_id = ? ORDER BY last_used_at DESC LIMIT ?)`,
    ).run(event.chordId, event.chordId, MAX_CHOICES_PER_CHORD);
  }

  /** One more use of a page: a visit, a typed pick, or both. Returns its history row, or null for non-web pages. */
  private use(url: string, title: string, at: number, how: { visit: boolean; typed: boolean }): number | null {
    const place = placeKey(url);
    if (!place) return null;
    const row = this.sql('SELECT id, url, decay_day FROM history_url WHERE profile_id = ? AND place = ?').get(DEFAULT_PROFILE, place) as Row | undefined;
    const decay = used(row ? num(row['decay_day']) : null, at);
    if (row) {
      this.sql(
        `UPDATE history_url SET url = ?, title = CASE WHEN ? = '' THEN title ELSE ? END,
           visit_count = visit_count + ?, typed_count = typed_count + ?, last_visit_at = MAX(last_visit_at, ?), decay_day = ?
         WHERE id = ?`,
      ).run(how.visit ? url : (str(row['url']) || url), title, title, how.visit ? 1 : 0, how.typed ? 1 : 0, at, decay, num(row['id']));
      return num(row['id']);
    }
    const result = this.sql(
      `INSERT INTO history_url (profile_id, place, url, title, visit_count, typed_count, last_visit_at, decay_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(DEFAULT_PROFILE, place, url, title, how.visit ? 1 : 0, how.typed ? 1 : 0, at, decay);
    return Number(result.lastInsertRowid);
  }

  /**
   * History pages matching every typed word as a prefix (FTS5, best bm25
   * first), and the chord's picks for text starting with what was typed.
   * One letter matches nothing in history: the index starts at two. Nothing
   * at all (the command bar's `@history` before you type) lists recent pages.
   */
  search(query: string, chordId: string | null, now = Date.now()): SearchResult {
    const words = terms(query).filter((w) => [...w].length >= 2);
    const rows: Row[] = !query.trim()
      ? (this.sql(
          `SELECT url, title, visit_count, typed_count, last_visit_at, decay_day
             FROM history_url WHERE profile_id = ? ORDER BY last_visit_at DESC LIMIT ?`,
        ).all(DEFAULT_PROFILE, SEARCH_LIMIT) as Row[])
      : words.length === 0
        ? []
        : (this.sql(
            `SELECT h.url, h.title, h.visit_count, h.typed_count, h.last_visit_at, h.decay_day
               FROM history_fts JOIN history_url h ON h.id = history_fts.rowid
              WHERE history_fts MATCH ? AND h.profile_id = ?
              ORDER BY bm25(history_fts) LIMIT ?`,
          ).all(words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(' '), DEFAULT_PROFILE, SEARCH_LIMIT) as Row[]);
    const history = rows.map((r) => ({
      url: str(r['url']),
      title: str(r['title']),
      visitCount: num(r['visit_count']),
      typedCount: num(r['typed_count']),
      lastVisitAt: num(r['last_visit_at']),
      frecency: frecencyOn(num(r['decay_day']), now),
    }));
    // The archive the same way: nothing typed (`@archive` before you type) lists the newest.
    const archive = !query.trim()
      ? this.archiveList('', ARCHIVE_SEARCH_LIMIT).items
      : words.length === 0
        ? []
        : this.archiveMatching(words, ARCHIVE_SEARCH_LIMIT, 'bm25(archive_fts)');
    const text = foldChoiceText(query);
    const choices: Choice[] =
      chordId && text
        ? (
            this.sql(`SELECT text, destination, uses, last_used_at FROM palette_choice WHERE chord_id = ? AND substr(text, 1, ?) = ?`).all(
              chordId,
              text.length,
              text,
            ) as Row[]
          ).map((r) => ({ text: str(r['text']), destination: str(r['destination']), uses: num(r['uses']), lastUsedAt: num(r['last_used_at']) }))
        : [];
    return { history, choices, archive };
  }

  /**
   * The archive page: the newest `limit` entries whose title or address has
   * every typed word (as a prefix), or contains the text when it's one letter.
   */
  archiveList(query: string, limit: number): ArchivePage {
    const trimmed = query.trim();
    const words = terms(trimmed).filter((w) => [...w].length >= 2);
    let rows: Row[];
    if (!trimmed) {
      rows = this.sql(`${ARCHIVE_SELECT} WHERE a.profile_id = ? ORDER BY a.archived_at DESC, a.rid DESC LIMIT ?`).all(DEFAULT_PROFILE, limit + 1) as Row[];
    } else if (words.length === 0) {
      const like = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      rows = this.sql(
        `${ARCHIVE_SELECT} WHERE a.profile_id = ? AND (a.title LIKE ? ESCAPE '\\' OR a.url LIKE ? ESCAPE '\\')
          ORDER BY a.archived_at DESC, a.rid DESC LIMIT ?`,
      ).all(DEFAULT_PROFILE, like, like, limit + 1) as Row[];
    } else {
      return this.archivePage(this.archiveMatching(words, limit + 1, 'a.archived_at DESC, a.rid DESC'), limit);
    }
    return this.archivePage(rows.map(archivedTab), limit);
  }

  private archivePage(items: ArchivedTab[], limit: number): ArchivePage {
    return { items: items.slice(0, limit), more: items.length > limit };
  }

  private archiveMatching(words: string[], limit: number, order: string): ArchivedTab[] {
    const match = words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(' ');
    return (
      this.sql(
        `${ARCHIVE_SELECT} JOIN archive_fts ON archive_fts.rowid = a.rid
          WHERE archive_fts MATCH ? AND a.profile_id = ? ORDER BY ${order} LIMIT ?`,
      ).all(match, DEFAULT_PROFILE, limit) as Row[]
    ).map(archivedTab);
  }

  /** One entry, with the history it needs to come back. */
  archiveGet(id: string): ArchiveEntry | null {
    const row = this.sql(`${ARCHIVE_SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    return row ? { tab: archivedTab(row), nav: parseJson<NavState | null>(row['nav_state'], null) } : null;
  }

  /** The newest entry archived for one of `reasons`: what ⌘⇧T reopens once this session's list runs out. */
  archiveLatest(reasons: readonly ArchiveReason[]): ArchiveEntry | null {
    if (reasons.length === 0) return null;
    const row = this.sql(
      `${ARCHIVE_SELECT} WHERE a.profile_id = ? AND a.reason IN (${reasons.map(() => '?').join(', ')})
        ORDER BY a.archived_at DESC, a.rid DESC LIMIT 1`,
    ).get(DEFAULT_PROFILE, ...reasons) as Row | undefined;
    return row ? { tab: archivedTab(row), nav: parseJson<NavState | null>(row['nav_state'], null) } : null;
  }

  /** A `data:` icon, stored once by content hash; returns its key. */
  private storeFavicon(url: string, now: number): string | null {
    const icon = splitDataUrl(url);
    if (!icon) return null;
    this.sql('INSERT INTO favicon (key, data, mime, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').run(icon.key, icon.data, icon.mime, now);
    return icon.key;
  }

  private writeChord(id: string, chord: Chord | null, now: number): void {
    if (!chord) {
      // Hard delete until chords can be deleted (and restored) in M1.3.
      this.sql('DELETE FROM node WHERE chord_id = ?').run(id);
      this.sql('DELETE FROM chord WHERE id = ?').run(id);
      return;
    }
    const profileId = chord.profileId || DEFAULT_PROFILE;
    // A chord that keeps its sign-ins separate has a profile of its own.
    if (profileId !== DEFAULT_PROFILE) {
      this.sql('INSERT OR IGNORE INTO profile (id, name, partition, is_default, created_at) VALUES (?, ?, ?, 0, ?)').run(
        profileId,
        chord.name,
        profilePartition(profileId),
        now,
      );
    }
    this.sql(
      `INSERT INTO chord (id, profile_id, name, icon, theme, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, name = excluded.name, icon = excluded.icon,
         theme = excluded.theme, rank = excluded.rank, updated_at = excluded.updated_at`,
    ).run(id, profileId, chord.name, chord.icon, JSON.stringify(chord.theme), chord.rank, chord.createdAt, now);
  }

  private writeNode(id: string, node: SidebarNode | null, now: number): void {
    if (!node) {
      this.sql('DELETE FROM node WHERE id = ?').run(id);
      return;
    }
    this.sql(
      `INSERT INTO node (id, chord_id, parent_id, section, kind, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET chord_id = excluded.chord_id, parent_id = excluded.parent_id, section = excluded.section,
         kind = excluded.kind, rank = excluded.rank, updated_at = excluded.updated_at`,
    ).run(id, node.chordId, node.parentId, node.section, node.kind, node.rank, node.createdAt, now);
    if (node.kind === 'folder') {
      this.sql('DELETE FROM tab WHERE node_id = ?').run(id);
      this.sql(
        `INSERT INTO folder (node_id, title, collapsed) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET title = excluded.title, collapsed = excluded.collapsed`,
      ).run(id, node.title, node.collapsed ? 1 : 0);
      return;
    }
    this.sql('DELETE FROM folder WHERE node_id = ?').run(id);
    const iconKey = node.favicon ? this.storeFavicon(node.favicon, now) : null;
    this.sql(
      `INSERT INTO tab (node_id, pinned_url, custom_title, url, title, favicon_key, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET pinned_url = excluded.pinned_url, custom_title = excluded.custom_title, url = excluded.url,
         title = excluded.title, favicon_key = excluded.favicon_key, last_active_at = excluded.last_active_at`,
    ).run(id, node.pinnedUrl, node.customTitle, node.url, node.title, iconKey, node.lastActiveAt);
  }

  private writeSitePermissions(origin: string, decisions: SitePermissions[string] | null, now: number): void {
    this.sql('DELETE FROM site_permission WHERE profile_id = ? AND origin = ?').run(DEFAULT_PROFILE, origin);
    for (const [permission, decision] of Object.entries(decisions ?? {})) {
      this.sql('INSERT INTO site_permission (profile_id, origin, permission, decision, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        DEFAULT_PROFILE,
        origin,
        permission,
        decision,
        now,
      );
    }
  }

  private writeDownload(id: string, d: Download | null): void {
    if (!d) {
      this.sql('DELETE FROM download WHERE id = ?').run(id);
      return;
    }
    this.sql(
      `INSERT INTO download (id, profile_id, url, path, filename, mime, state, received, total, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path, filename = excluded.filename, state = excluded.state,
         received = excluded.received, total = excluded.total, ended_at = excluded.ended_at`,
    ).run(id, DEFAULT_PROFILE, d.url, d.path, d.filename, d.mime, d.state, d.received, d.total, d.startedAt, d.endedAt);
  }

  /** `key` is `extensionKey(profileId, id)`; a deletion only has the key to go on. */
  private writeExtension(key: string, e: InstalledExtension | null): void {
    if (!e) {
      const split = key.lastIndexOf(':');
      this.sql('DELETE FROM extension WHERE profile_id = ? AND id = ?').run(key.slice(0, split), key.slice(split + 1));
      return;
    }
    this.sql(
      `INSERT INTO extension (profile_id, id, name, version, source, path, notified_version, pinned, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, id) DO UPDATE SET name = excluded.name, version = excluded.version, source = excluded.source,
         path = excluded.path, notified_version = excluded.notified_version, pinned = excluded.pinned, updated_at = excluded.updated_at`,
    ).run(e.profileId, e.id, e.name, e.version, e.source, e.path, e.notifiedVersion, e.pinned ? 1 : 0, e.installedAt, e.updatedAt);
  }

  private writeWindow(id: string, win: WindowModel | null): void {
    if (!win) {
      this.sql('DELETE FROM window_state WHERE id = ?').run(id);
      return;
    }
    this.sql(
      `INSERT INTO window_state (id, bounds, active_chord_id, sidebar_width, sidebar_mode, active_tab_by_chord) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET bounds = excluded.bounds, active_chord_id = excluded.active_chord_id,
         sidebar_width = excluded.sidebar_width, sidebar_mode = excluded.sidebar_mode, active_tab_by_chord = excluded.active_tab_by_chord`,
    ).run(id, JSON.stringify(win.bounds), win.activeChordId, win.sidebarWidth ?? SIDEBAR_WIDTH.default, win.sidebar, JSON.stringify(win.activeTab));
  }

  private writeFavorite(id: string, favorite: Favorite | null, now: number): void {
    if (!favorite) {
      this.sql('DELETE FROM favorite WHERE id = ?').run(id);
      return;
    }
    const iconKey = favorite.favicon ? this.storeFavicon(favorite.favicon, now) : null;
    this.sql(
      `INSERT INTO favorite (id, url, title, favicon_key, rank, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, favicon_key = excluded.favicon_key, rank = excluded.rank`,
    ).run(id, favorite.url, favorite.title, iconKey, favorite.rank, favorite.createdAt);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
