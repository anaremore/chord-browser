/**
 * chord-data's database (ARCHITECTURE.md §7). Runs only in the chord-data
 * utility process, never on main: `node:sqlite` is synchronous.
 */
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  addDecay,
  ARCHIVE_KEEP_MS,
  dayOf,
  decayOfVisits,
  duetMessageText,
  foldChoiceText,
  frecencyOn,
  HALF_LIFE_DAYS,
  isDeviceId,
  newDeviceId,
  pickedAgain,
  placeKey,
  profilePartition,
  SIDEBAR_WIDTH,
  terms,
  used,
  type ArchivedTab,
  type ArchiveReason,
  type Chord,
  type Choice,
  type Download,
  type DuetMessage,
  type DuetThread,
  type ExportCounts,
  type Favorite,
  type ImportedPage,
  type InstalledExtension,
  type LinkRoute,
  type PersistedState,
  type Platform,
  type SavedEffects,
  type SidebarNode,
  type SitePermissions,
  type WindowModel,
} from '@chord/core';
import type { ArchiveEntry, ArchivePage, HistoryEvent, NavState, SearchResult, WriteOp } from './index';
import { runDuet, threadOf, type DuetOp, type DuetResult } from './duet';
import { exportCounts } from './export';
import { MIGRATIONS } from './migrations';
import { chordOf, favoriteOf, iconOf, nodeOf, nodeSelect, num, parseJson, siteEffectsOf, str, strOrNull, type Row } from './rows';
import { SyncStore } from './sync';

/** The profile every chord belongs to until "Keep sign-ins separate" exists. */
const DEFAULT_PROFILE = 'default';
/** History rows a search ranks; the command bar shows a handful. */
const SEARCH_LIMIT = 50;
const MAX_CHOICES_PER_CHORD = 1000;
/** Archive matches the command bar ranks. */
const ARCHIVE_SEARCH_LIMIT = 20;
/** Picks nobody repeats are forgotten after 90 days. */
const CHOICE_LIFETIME_MS = 90 * 86_400_000;
/** What's left of a page's frecency after an import's Undo, as a share of what it had, below which it's rounding. */
const ROUNDING = 1e-9;
/** History pages an import's Undo puts back per transaction: a few milliseconds' work, so searches get in between. */
const UNDO_SLICE = 100;
/** Visit ids an import's Undo takes back per transaction, as many as a Chord file's batch writes. */
const UNDO_VISITS = 1000;
/** Pages of write-ahead log before SQLite checkpoints: its own default, and while an import writes (`importing`). */
const DEFAULT_CHECKPOINT = 1000;
const IMPORT_CHECKPOINT = 250;

/** `data:` favicon URLs are stored once each, by content hash. */
function splitDataUrl(url: string): { key: string; mime: string; data: Uint8Array } | null {
  const match = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const [, mime, , base64, payload] = match;
  const data = base64 ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!), 'utf8');
  return { key: createHash('sha256').update(url).digest('hex'), mime: mime!, data };
}

/** Archive entries with their icons. */
const ARCHIVE_SELECT = `SELECT a.*, i.mime AS icon_mime, i.data AS icon_data FROM archive_item a LEFT JOIN favicon i ON i.key = a.favicon_key`;

function archivedTab(r: Row): ArchivedTab {
  const reason = str(r['reason']);
  return {
    id: str(r['id']),
    chordId: str(r['chord_id']),
    url: str(r['url']),
    title: str(r['title']),
    favicon: iconOf(r),
    reason: reason === 'closed' || reason === 'cleared' ? reason : 'auto',
    archivedAt: num(r['archived_at']),
  };
}

export class ChordDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  /** Imports undone this session: their late batches are ignored. */
  private readonly undoneImports = new Set<string>();
  /** Imports writing now (their batches, or their Undo): while any is, checkpoints come smaller (`importing`). */
  private writingImports = 0;
  /** The largest history_visit id an import has had this session: the next import's visits go above it (`importTables`). */
  private importedUpto = 0;
  /** Sync's tables (sync.ts): write() stamps your changes through it while sync is on. */
  readonly sync: SyncStore;

  constructor(
    readonly file: string,
    platform: Platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.sync = new SyncStore((text) => this.sql(text), () => this.device(), platform);
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
    // Foreign keys are off while the schema changes, as SQLite documents for making a table again (migration 14):
    // dropping the old one mustn't cascade into the rows that point at it. Each migration is checked before it commits.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (let v = from; v < MIGRATIONS.length; v++) {
        this.transaction(() => {
          this.db.exec(MIGRATIONS[v]!);
          const broken = this.db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length > 0) throw new Error(`Migration ${v + 1} left ${broken.length} rows pointing at nothing`);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        });
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
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
    ).map((r) => favoriteOf(r, iconOf(r)));
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
    const siteZoom: Record<string, number> = {};
    for (const r of this.sql('SELECT host, factor FROM site_zoom WHERE profile_id = ?').all(DEFAULT_PROFILE) as Row[]) siteZoom[str(r['host'])] = num(r['factor']);
    const linkRoutes = (this.sql('SELECT host, chord_id, created_at FROM link_route').all() as Row[]).map(
      (r): LinkRoute => ({ host: str(r['host']), chordId: str(r['chord_id']), createdAt: num(r['created_at']) }),
    );
    if (chordRows.length === 0) {
      const anything =
        Object.keys(settings).length > 0 ||
        Object.keys(sitePermissions).length > 0 ||
        downloads.length > 0 ||
        extensions.length > 0 ||
        favorites.length > 0 ||
        Object.keys(siteZoom).length > 0;
      return anything ? { chords: [], nodes: [], windows: [], settings, sitePermissions, downloads, extensions, favorites, siteZoom } : null;
    }

    const chords = chordRows.map(chordOf);
    const nodeRows = this.sql(nodeSelect(', i.mime AS icon_mime, i.data AS icon_data', '\n     LEFT JOIN favicon i ON i.key = t.favicon_key')).all() as Row[];
    const nodes = nodeRows.map((r) => nodeOf(r, iconOf(r))).filter((n): n is SidebarNode => n !== null);

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

    return { chords, nodes, windows, settings, sitePermissions, downloads, extensions, favorites, siteZoom, linkRoutes };
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
        else if (op.k === 'siteZoom') this.writeSiteZoom(op.id, op.value, now);
        else if (op.k === 'linkRoute') this.writeLinkRoute(op.id, op.value, now);
        else if (op.k === 'effect') this.writeEffect(op.id, op.value);
        else if (op.k === 'nav') continue;
        else if (op.value === null) this.sql('DELETE FROM setting WHERE key = ?').run(op.id);
        else
          // updated_at moves only when the value does: it's the setting's stamp in an export (migration 17).
          this.sql(
            `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value,
               updated_at = CASE WHEN value = excluded.value THEN updated_at ELSE excluded.updated_at END`,
          ).run(op.id, JSON.stringify(op.value), now);
      }
      // Histories last: a tab's row may be made in this same batch. A tab that's gone takes its history with it.
      for (const op of ops) {
        // The column is a BLOB (migration 1): the JSON goes in as UTF-8 bytes.
        if (op.k === 'nav') this.sql('UPDATE tab SET nav_state = ? WHERE node_id = ?').run(op.value ? Buffer.from(JSON.stringify(op.value)) : null, op.id);
      }
      // Sync's stamping hook (S15 §7), in the same transaction: what you changed of synced things gets a stamp. Off, it isn't called.
      if (this.sync.stamping) {
        const at = performance.now();
        this.sync.stamp(ops, now);
        this.sync.timed('stamp', performance.now() - at);
      } else if (ops.length > 0 && this.sync.meta.on) this.sync.unstamped = true;
    });
  }

  /** Work in one transaction (sync's merge and its cursor, a slice at a time). */
  atomically<T>(work: () => T): T {
    let out!: T;
    this.transaction(() => {
      out = work();
    });
    return out;
  }

  /** Open tabs' saved back/forward histories, by node id. */
  loadNavs(): Record<string, NavState> {
    const navs: Record<string, NavState> = {};
    for (const r of this.sql('SELECT node_id, nav_state FROM tab WHERE nav_state IS NOT NULL').all() as Row[]) {
      const bytes = r['nav_state'];
      const nav = bytes instanceof Uint8Array ? parseJson<NavState | null>(Buffer.from(bytes).toString('utf8'), null) : null;
      if (nav && Array.isArray(nav.entries) && Number.isInteger(nav.index)) navs[str(r['node_id'])] = nav;
    }
    return navs;
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

  /**
   * What imports changed in history, for their Undo: temporary tables, which
   * last as long as this connection (an import's Undo is offered for a moment,
   * never after a restart). `import_range` holds, for each of an import's
   * batches, the history_visit ids its visits took: a batch is one
   * transaction on this one connection, and its visits take the ids just
   * above both the largest there is and the largest any import has had
   * (`importedUpto`), so no other visit, Chord's or another import's, is ever
   * among them, even with two imports at once or one's Undo freeing ids
   * meanwhile; `import_page` each page it touched, what it added there
   * (visits, typed visits, and its frecency as a decay day), and the page's
   * title and last visit before.
   */
  private importTables(): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS import_range (
        import_id TEXT NOT NULL, above INTEGER NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY (import_id, upto)
      ) STRICT;
      CREATE TEMP TABLE IF NOT EXISTS import_page (
        import_id TEXT NOT NULL, url_id INTEGER NOT NULL, created INTEGER NOT NULL,
        visits INTEGER NOT NULL, typed INTEGER NOT NULL, decay REAL NOT NULL,
        last_visit_before INTEGER NOT NULL, title_before TEXT NOT NULL, title_set TEXT,
        PRIMARY KEY (import_id, url_id)
      ) STRICT;
      CREATE TEMP TABLE IF NOT EXISTS import_thread (import_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (import_id, thread_id)) STRICT;
      CREATE TEMP TABLE IF NOT EXISTS import_message (import_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (import_id, message_id)) STRICT;
    `);
  }

  /**
   * One batch of imported history, all or nothing: another browser's, or a
   * Chord file's. Every visit is kept (as `import` visits) and counts toward
   * frecency as if Chord had seen it, but a visit Chord has already (the same
   * page at the same moment) isn't added again, so importing a file twice adds
   * nothing (S15 §5). A page Chord knows keeps its own title. Returns the pages
   * that gained visits and hadn't from this import before.
   */
  importHistory(importId: string, pages: readonly ImportedPage[], now = Date.now()): number {
    // A batch still on its way when the import was undone stays out.
    if (this.undoneImports.has(importId)) return 0;
    this.importTables();
    let added = 0;
    this.transaction(() => {
      // Its visits take ids above any visit's, and any an import has had: never one an Undo has just freed.
      const above = Math.max(num((this.sql('SELECT COALESCE(MAX(id), 0) AS id FROM history_visit').get() as Row)['id']), this.importedUpto);
      let upto = above;
      for (const page of pages) {
        const place = placeKey(page.url);
        if (!place) continue;
        const row = this.sql('SELECT id, title, typed_count, last_visit_at, decay_day FROM history_url WHERE profile_id = ? AND place = ?').get(DEFAULT_PROFILE, place) as Row | undefined;
        const have = row ? new Set((this.sql('SELECT visited_at FROM history_visit WHERE url_id = ?').all(num(row['id'])) as Row[]).map((r) => num(r['visited_at']))) : null;
        const fresh = (at: number) => Number.isFinite(at) && at > 0 && !have?.has(at);
        const visits = page.visits.filter(fresh);
        const typed = page.typed.filter(fresh);
        // A count without times: the larger of the two counts, so what the file has of Chord's own isn't added again.
        const typedAdded = page.typedCount === undefined ? typed.length : Math.max(0, Math.floor(page.typedCount) - (row ? num(row['typed_count']) : 0));
        const decay = decayOfVisits([...visits, ...typed], now);
        if (visits.length === 0 || decay === null) continue;
        const last = visits.reduce((a, b) => Math.max(a, b), 0);
        let urlId: number;
        let created = false;
        if (row) {
          urlId = num(row['id']);
          this.sql('UPDATE history_url SET visit_count = visit_count + ?, typed_count = typed_count + ?, last_visit_at = MAX(last_visit_at, ?), decay_day = ? WHERE id = ?').run(
            visits.length,
            typedAdded,
            last,
            addDecay(num(row['decay_day']), decay, now),
            urlId,
          );
          // A page without a title takes the import's. Only then: setting the title, even to itself, rewrites its search entry.
          if (!str(row['title']) && page.title) this.sql('UPDATE history_url SET title = ? WHERE id = ?').run(page.title, urlId);
        } else {
          const result = this.sql(
            `INSERT INTO history_url (profile_id, place, url, title, visit_count, typed_count, last_visit_at, decay_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(DEFAULT_PROFILE, place, page.url, page.title, visits.length, typedAdded, last, decay);
          urlId = Number(result.lastInsertRowid);
          created = true;
        }
        // Two addresses of one page (with and without www.) add up; the page's state before is the first one's.
        const noted = this.sql('SELECT decay FROM import_page WHERE import_id = ? AND url_id = ?').get(importId, urlId) as Row | undefined;
        if (noted) {
          this.sql('UPDATE import_page SET visits = visits + ?, typed = typed + ?, decay = ? WHERE import_id = ? AND url_id = ?').run(
            visits.length,
            typedAdded,
            addDecay(num(noted['decay']), decay, now),
            importId,
            urlId,
          );
        } else {
          const titleBefore = row ? str(row['title']) : '';
          this.sql(
            `INSERT INTO import_page (import_id, url_id, created, visits, typed, decay, last_visit_before, title_before, title_set)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(importId, urlId, created ? 1 : 0, visits.length, typedAdded, decay, row ? num(row['last_visit_at']) : 0, titleBefore, row && !titleBefore && page.title ? page.title : null);
        }
        for (const at of visits) this.sql(`INSERT INTO history_visit (id, url_id, visited_at, transition) VALUES (?, ?, ?, 'import')`).run(++upto, urlId, at);
        // A page counts once however many batches (or addresses) bring it visits.
        if (!noted) added++;
      }
      if (upto > above) this.sql('INSERT INTO import_range (import_id, above, upto) VALUES (?, ?, ?)').run(importId, above, upto);
      this.importedUpto = Math.max(this.importedUpto, upto);
    });
    return added;
  }

  /**
   * One batch of a Chord file's Duet chats (S15 §5), all or nothing: threads
   * and messages are added by id, never replaced, so what's here stays as it
   * is and a file imported twice adds nothing. A message goes only into a
   * thread this import added: never into a chat that was here, which a file
   * could otherwise fill with turns you never had (a chat continued on
   * another computer gains its new turns by sync, not by import). Each thread
   * comes marked as imported, with no provider session: nothing is sent
   * anywhere until you write in it. Returns the threads and the number of
   * messages it added.
   */
  importDuet(importId: string, threads: readonly DuetThread[], messages: readonly DuetMessage[]): { threads: string[]; messages: number } {
    const added = { threads: [] as string[], messages: 0 };
    if (this.undoneImports.has(importId)) return added;
    this.importTables();
    this.transaction(() => {
      for (const t of threads) {
        const result = this.sql(
          `INSERT INTO duet_thread (id, chord_id, title, provider, model, provider_session_id, scope, created_at, updated_at, last_used_at, imported_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        ).run(t.id, t.chordId, t.title, t.provider, t.model, t.scope, t.createdAt, t.updatedAt, t.lastUsedAt, t.importedAt ?? Date.now());
        if (result.changes === 0) continue;
        this.sql('INSERT OR IGNORE INTO import_thread (import_id, thread_id) VALUES (?, ?)').run(importId, t.id);
        added.threads.push(t.id);
      }
      for (const m of messages) {
        if (!this.sql('SELECT 1 FROM import_thread WHERE import_id = ? AND thread_id = ?').get(importId, m.threadId)) continue;
        const result = this.sql('INSERT INTO duet_message (id, thread_id, role, text, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(
          m.id,
          m.threadId,
          m.body.role,
          duetMessageText(m.body),
          JSON.stringify(m.body),
          m.createdAt,
        );
        if (result.changes === 0) continue;
        this.sql('INSERT OR IGNORE INTO import_message (import_id, message_id) VALUES (?, ?)').run(importId, m.id);
        added.messages++;
      }
    });
    return added;
  }

  /**
   * An import's Undo: its visits go, and on each page it touched what it
   * added comes off (visits, typed visits, frecency, a title it gave), so what
   * Chord saw before, meanwhile, or from another import stays. A page it
   * brought that nothing else has used goes too. So do the Duet chats and
   * messages it added: the threads come back, for main to end their sessions
   * and delete the providers' copies.
   */
  undoImport(importId: string, now = Date.now()): DuetThread[] {
    const threads: DuetThread[] = [];
    for (;;) {
      const slice = this.undoImportSlice(importId, now);
      threads.push(...slice.threads);
      if (slice.done) return threads;
    }
  }

  /**
   * One slice of an import's Undo, in a transaction of its own, so chord-data
   * answers the command bar's searches between slices (a big import's Undo is
   * thousands of pages; chord-data's worker yields between them): its chats
   * first, then its visits a batch's ids at a time, then `pages` of the
   * history pages it touched at a time. `done` once nothing of it is left.
   */
  undoImportSlice(importId: string, now = Date.now(), pages = UNDO_SLICE): { done: boolean; threads: DuetThread[] } {
    this.undoneImports.add(importId);
    this.importTables();
    const threads = (this.sql('SELECT t.* FROM duet_thread t JOIN import_thread i ON i.thread_id = t.id WHERE i.import_id = ?').all(importId) as Row[]).map(threadOf);
    if (threads.length > 0 || this.sql('SELECT 1 FROM import_message WHERE import_id = ? LIMIT 1').get(importId)) {
      this.transaction(() => {
        this.sql('DELETE FROM duet_message WHERE id IN (SELECT message_id FROM import_message WHERE import_id = ?)').run(importId);
        this.sql('DELETE FROM duet_thread WHERE id IN (SELECT thread_id FROM import_thread WHERE import_id = ?)').run(importId);
        this.sql('DELETE FROM import_message WHERE import_id = ?').run(importId);
        this.sql('DELETE FROM import_thread WHERE import_id = ?').run(importId);
      });
      return { done: false, threads };
    }
    // Its visits, `UNDO_VISITS` ids at a time: the ids its batches took, read straight off the table's key. No other
    // visit is among them (`importTables`); an `import` visit, so never one of Chord's own should a later Chord have
    // reused an id.
    const range = this.sql('SELECT above, upto FROM import_range WHERE import_id = ? ORDER BY upto LIMIT 1').get(importId) as Row | undefined;
    if (range) {
      const upto = num(range['upto']);
      const to = Math.min(upto, num(range['above']) + UNDO_VISITS);
      this.transaction(() => {
        this.sql(`DELETE FROM history_visit WHERE id > ? AND id <= ? AND transition = 'import'`).run(num(range['above']), to);
        if (to >= upto) this.sql('DELETE FROM import_range WHERE import_id = ? AND upto = ?').run(importId, upto);
        else this.sql('UPDATE import_range SET above = ? WHERE import_id = ? AND upto = ?').run(to, importId, upto);
      });
      return { done: false, threads: [] };
    }
    if (!this.sql('SELECT 1 FROM import_page WHERE import_id = ? LIMIT 1').get(importId)) return { done: true, threads: [] };
    let done = true;
    this.transaction(() => {
      const touched = this.sql('SELECT * FROM import_page WHERE import_id = ? LIMIT ?').all(importId, pages + 1) as Row[];
      done = touched.length <= pages;
      for (const page of touched.slice(0, pages)) {
        const urlId = num(page['url_id']);
        this.sql('DELETE FROM import_page WHERE import_id = ? AND url_id = ?').run(importId, urlId);
        // Its visits are gone already: what's left on the page is everyone else's.
        const row = this.sql('SELECT visit_count, typed_count, decay_day FROM history_url WHERE id = ?').get(urlId) as Row | undefined;
        if (!row) continue;
        const left = this.sql('SELECT COUNT(*) AS n, MAX(visited_at) AS last FROM history_visit WHERE url_id = ?').get(urlId) as Row;
        const visits = Math.max(0, num(row['visit_count']) - num(page['visits']));
        const typed = Math.max(0, num(row['typed_count']) - num(page['typed']));
        // Nothing else has used it (not Chord, not another import): it goes, its search entry with it.
        if (num(left['n']) === 0 && visits === 0 && typed === 0) {
          this.sql('DELETE FROM history_url WHERE id = ?').run(urlId);
          continue;
        }
        // Frecency is a sum of decaying uses (core/rank.ts), so the import's share comes off exactly.
        // What's left can be lost to rounding when it was tiny beside the import's: then it's a single old use.
        const total = frecencyOn(num(row['decay_day']), now);
        const score = total - frecencyOn(num(page['decay']), now);
        const decay = score > total * ROUNDING ? dayOf(now) + HALF_LIFE_DAYS * Math.log2(score) : used(null, num(left['last']) || num(page['last_visit_before']) || now);
        this.sql('UPDATE history_url SET visit_count = ?, typed_count = ?, last_visit_at = MAX(?, ?), decay_day = ? WHERE id = ?').run(
          visits,
          typed,
          num(page['last_visit_before']),
          num(left['last']),
          decay,
          urlId,
        );
        // A title it gave goes back, if it's still that one. Only then: setting the title rewrites the page's search entry.
        const titleSet = strOrNull(page['title_set']);
        if (titleSet !== null) this.sql('UPDATE history_url SET title = ? WHERE id = ? AND title = ?').run(str(page['title_before']), urlId, titleSet);
      }
    });
    return { done, threads: [] };
  }

  /**
   * An import starts (true) or stops (false) writing. Meanwhile SQLite's
   * checkpoints, which copy the write-ahead log into the database on this
   * thread and so hold up the command bar's searches, come smaller and more
   * often: at SQLite's 1,000 pages one took about 20 ms during a 50,000-visit
   * import, at 250 about 10, for about half as long again in all (S15 §12).
   */
  importing(on: boolean): void {
    this.writingImports = Math.max(0, this.writingImports + (on ? 1 : -1));
    this.checkpointing();
  }

  /**
   * Sync's worker thread runs the checkpoints, on a connection of its own,
   * while sync merges and main writes what it applied (true), so none runs on
   * this thread meanwhile; then this connection runs them again (false). A
   * checkpoint here took 10–70 ms in the Linux container (S15 §13).
   */
  checkpointElsewhere(on: boolean): void {
    this.elsewhere = on;
    this.checkpointing();
  }

  private elsewhere = false;

  private checkpointing(): void {
    this.db.exec(`PRAGMA wal_autocheckpoint = ${this.elsewhere ? 0 : this.writingImports > 0 ? IMPORT_CHECKPOINT : DEFAULT_CHECKPOINT}`);
  }

  /** Duet's threads and messages (packages/data/src/duet.ts). */
  duet(op: DuetOp): DuetResult {
    return runDuet((text) => this.sql(text), op);
  }

  /**
   * This computer's id, for Your data's header and stamps (S15 §4): 64 random
   * bits, made the first time it's asked for and kept in `meta`.
   */
  device(): string {
    const row = this.sql(`SELECT value FROM meta WHERE key = 'device'`).get() as Row | undefined;
    const kept = row?.['value'];
    if (isDeviceId(kept)) return kept;
    const id = newDeviceId();
    this.sql(`INSERT INTO meta (key, value) VALUES ('device', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(id);
    return id;
  }

  /**
   * A new id for this computer: another computer writes under the old one in
   * sync's folder (a profile folder copied to a new computer, S15 §6).
   */
  newDevice(): string {
    return this.adoptDevice(newDeviceId());
  }

  /** This computer's id from now on: sync takes a new one only once its first snapshot under it is in the folder. */
  adoptDevice(id: string): string {
    this.sql(`INSERT INTO meta (key, value) VALUES ('device', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(id);
    return id;
  }

  /** What an export would hold, for Settings' card: a few counts, read in a millisecond or two (export.ts). */
  exportCounts(): ExportCounts {
    return exportCounts((text) => this.sql(text));
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
      `INSERT INTO chord (id, profile_id, name, icon, theme, rank, proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, name = excluded.name, icon = excluded.icon,
         theme = excluded.theme, rank = excluded.rank, proxy = excluded.proxy, updated_at = excluded.updated_at`,
    ).run(id, profileId, chord.name, chord.icon, JSON.stringify(chord.theme), chord.rank, chord.proxy ? JSON.stringify(chord.proxy) : null, chord.createdAt, now);
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
      this.sql('DELETE FROM split WHERE node_id = ?').run(id);
      this.sql(
        `INSERT INTO folder (node_id, title, collapsed) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET title = excluded.title, collapsed = excluded.collapsed`,
      ).run(id, node.title, node.collapsed ? 1 : 0);
      return;
    }
    if (node.kind === 'split') {
      this.sql('DELETE FROM tab WHERE node_id = ?').run(id);
      this.sql('DELETE FROM folder WHERE node_id = ?').run(id);
      this.sql('INSERT INTO split (node_id, layout) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET layout = excluded.layout').run(
        id,
        JSON.stringify({ direction: node.direction, sizes: node.sizes }),
      );
      return;
    }
    this.sql('DELETE FROM folder WHERE node_id = ?').run(id);
    this.sql('DELETE FROM split WHERE node_id = ?').run(id);
    const iconKey = node.favicon ? this.storeFavicon(node.favicon, now) : null;
    this.sql(
      `INSERT INTO tab (node_id, pinned_url, custom_title, url, title, favicon_key, last_active_at, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET pinned_url = excluded.pinned_url, custom_title = excluded.custom_title, url = excluded.url,
         title = excluded.title, favicon_key = excluded.favicon_key, last_active_at = excluded.last_active_at, muted = excluded.muted`,
    ).run(id, node.pinnedUrl, node.customTitle, node.url, node.title, iconKey, node.lastActiveAt, node.muted ? 1 : 0);
  }

  private writeLinkRoute(host: string, route: LinkRoute | null, now: number): void {
    if (route === null) this.sql('DELETE FROM link_route WHERE host = ?').run(host);
    else
      this.sql(
        `INSERT INTO link_route (host, chord_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET chord_id = excluded.chord_id,
           updated_at = CASE WHEN chord_id = excluded.chord_id THEN updated_at ELSE excluded.updated_at END`,
      ).run(host, route.chordId, route.createdAt, now);
  }

  private writeEffect(host: string, site: SavedEffects | null): void {
    if (!site) {
      this.sql('DELETE FROM effect WHERE host = ?').run(host);
      return;
    }
    this.sql(
      `INSERT INTO effect (host, wet, css, css_on, hidden, presets, duet, compiled, sanitizer, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET wet = excluded.wet, css = excluded.css, css_on = excluded.css_on, hidden = excluded.hidden, presets = excluded.presets,
         duet = excluded.duet, compiled = excluded.compiled, sanitizer = excluded.sanitizer, updated_at = excluded.updated_at`,
    ).run(
      host,
      site.wet ? 1 : 0,
      site.css,
      site.cssOn ? 1 : 0,
      JSON.stringify(site.hidden),
      JSON.stringify(site.presets),
      JSON.stringify(site.duet),
      site.compiled,
      site.sanitizer,
      site.createdAt,
      site.updatedAt,
    );
  }

  /**
   * Every site's Effects, checked as an import would be. A row whose stylesheet
   * isn't what its sanitizer made can't be told from here: main makes it again
   * when the sanitizer's version differs, and trusts nothing else it can't check.
   */
  loadEffects(): SavedEffects[] {
    const out: SavedEffects[] = [];
    for (const r of this.sql('SELECT * FROM effect ORDER BY updated_at').all() as Row[]) {
      const site = siteEffectsOf(r);
      if (site) out.push({ ...site, compiled: str(r['compiled']), sanitizer: num(r['sanitizer']) });
    }
    return out;
  }

  private writeSiteZoom(host: string, factor: number | null, now: number): void {
    if (factor === null) this.sql('DELETE FROM site_zoom WHERE profile_id = ? AND host = ?').run(DEFAULT_PROFILE, host);
    else
      this.sql(
        'INSERT INTO site_zoom (profile_id, host, factor, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, host) DO UPDATE SET factor = excluded.factor, updated_at = excluded.updated_at',
      ).run(DEFAULT_PROFILE, host, factor, now);
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
      `INSERT INTO favorite (id, url, title, favicon_key, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, favicon_key = excluded.favicon_key, rank = excluded.rank,
         updated_at = CASE WHEN url IS excluded.url AND title IS excluded.title AND favicon_key IS excluded.favicon_key AND rank IS excluded.rank
                           THEN updated_at ELSE excluded.updated_at END`,
    ).run(id, favorite.url, favorite.title, iconKey, favorite.rank, favorite.createdAt, now);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
