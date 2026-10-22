/**
 * chord-data's database (ARCHITECTURE.md §7). Runs only in the chord-data
 * utility process, never on main: `node:sqlite` is synchronous.
 */
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Chord, ChordThemeSpec, FolderNode, PersistedState, SidebarNode, TabNode, WindowModel } from '@chord/core';
import type { WriteOp } from './index';
import { MIGRATIONS } from './migrations';

/** The profile every chord belongs to until "Keep sign-ins separate" exists. */
const DEFAULT_PROFILE = 'default';
const SIDEBAR_WIDTH = 248;

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

export class ChordDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    // Icons no tab uses any more.
    this.db.exec('DELETE FROM favicon WHERE key NOT IN (SELECT favicon_key FROM tab WHERE favicon_key IS NOT NULL)');
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

  /** Everything saved, or null for a brand-new profile. */
  load(): PersistedState | null {
    const chordRows = this.sql('SELECT * FROM chord WHERE deleted_at IS NULL').all() as Row[];
    const settingRows = this.sql('SELECT key, value FROM setting').all() as Row[];
    const settings = Object.fromEntries(settingRows.map((r) => [str(r['key']), parseJson<unknown>(r['value'], null)]));
    if (chordRows.length === 0) return Object.keys(settings).length > 0 ? { chords: [], nodes: [], windows: [], settings } : null;

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
        bounds: parseJson<WindowModel['bounds']>(r['bounds'], null),
      }),
    );

    return { chords, nodes, windows, settings };
  }

  /** One batch, all or nothing. */
  write(ops: readonly WriteOp[], now = Date.now()): void {
    this.transaction(() => {
      for (const op of ops) {
        if (op.k === 'chord') this.writeChord(op.id, op.value, now);
        else if (op.k === 'node') this.writeNode(op.id, op.value, now);
        else if (op.k === 'window') this.writeWindow(op.id, op.value);
        else if (op.value === null) this.sql('DELETE FROM setting WHERE key = ?').run(op.id);
        else this.sql('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(op.id, JSON.stringify(op.value));
      }
    });
  }

  private writeChord(id: string, chord: Chord | null, now: number): void {
    if (!chord) {
      // Hard delete until chords can be deleted (and restored) in M1.3.
      this.sql('DELETE FROM node WHERE chord_id = ?').run(id);
      this.sql('DELETE FROM chord WHERE id = ?').run(id);
      return;
    }
    this.sql(
      `INSERT INTO chord (id, profile_id, name, icon, theme, rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, theme = excluded.theme,
         rank = excluded.rank, updated_at = excluded.updated_at`,
    ).run(id, chord.profileId || DEFAULT_PROFILE, chord.name, chord.icon, JSON.stringify(chord.theme), chord.rank, chord.createdAt, now);
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
    const icon = node.favicon ? splitDataUrl(node.favicon) : null;
    if (icon) {
      this.sql('INSERT INTO favicon (key, data, mime, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').run(icon.key, icon.data, icon.mime, now);
    }
    this.sql(
      `INSERT INTO tab (node_id, pinned_url, custom_title, url, title, favicon_key, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET pinned_url = excluded.pinned_url, custom_title = excluded.custom_title, url = excluded.url,
         title = excluded.title, favicon_key = excluded.favicon_key, last_active_at = excluded.last_active_at`,
    ).run(id, node.pinnedUrl, node.customTitle, node.url, node.title, icon?.key ?? null, node.lastActiveAt);
  }

  private writeWindow(id: string, win: WindowModel | null): void {
    if (!win) {
      this.sql('DELETE FROM window_state WHERE id = ?').run(id);
      return;
    }
    this.sql(
      `INSERT INTO window_state (id, bounds, active_chord_id, sidebar_width, sidebar_mode, active_tab_by_chord) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET bounds = excluded.bounds, active_chord_id = excluded.active_chord_id,
         sidebar_mode = excluded.sidebar_mode, active_tab_by_chord = excluded.active_tab_by_chord`,
    ).run(id, JSON.stringify(win.bounds), win.activeChordId, SIDEBAR_WIDTH, win.sidebar, JSON.stringify(win.activeTab));
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
