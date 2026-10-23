/**
 * Forward-only migrations (ARCHITECTURE.md §7). `PRAGMA user_version` is the
 * number of migrations applied. Each runs in a transaction, after a
 * `VACUUM INTO` backup of the previous version. Tables arrive with the
 * feature that needs them; history, archive and Duet add their own later.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: the sidebar tree, windows, settings and favicons (session restore, M1.1).
  `
  CREATE TABLE profile (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    partition TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO profile (id, name, partition, is_default, created_at) VALUES ('default', 'Default', 'persist:default', 1, 0);

  CREATE TABLE chord (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profile(id),
    name TEXT NOT NULL, icon TEXT NOT NULL,
    theme TEXT NOT NULL,
    rank TEXT NOT NULL,
    duet_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
  ) STRICT;

  -- Writes arrive as whole entities in any order within a batch, so the chord
  -- reference is checked at commit. parent_id isn't a foreign key: restore
  -- repairs a missing folder by moving its children to the section root.
  CREATE TABLE node (
    id TEXT PRIMARY KEY,
    chord_id TEXT NOT NULL REFERENCES chord(id) DEFERRABLE INITIALLY DEFERRED,
    parent_id TEXT,
    section TEXT NOT NULL CHECK (section IN ('pinned','today')),
    kind TEXT NOT NULL CHECK (kind IN ('folder','tab','split')),
    rank TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
  ) STRICT;
  CREATE INDEX node_children ON node(chord_id, section, parent_id, rank) WHERE deleted_at IS NULL;

  CREATE TABLE folder (
    node_id TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
    title TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE tab (
    node_id TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
    pinned_url TEXT,
    custom_title TEXT,
    url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    favicon_key TEXT,
    nav_state BLOB,
    last_active_at INTEGER NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0, zoom REAL
  ) STRICT;

  CREATE TABLE window_state (
    id TEXT PRIMARY KEY,
    bounds TEXT NOT NULL,
    active_chord_id TEXT,
    sidebar_width INTEGER NOT NULL,
    sidebar_mode TEXT NOT NULL DEFAULT 'docked' CHECK (sidebar_mode IN ('docked','collapsed')),
    duet_width INTEGER,
    active_tab_by_chord TEXT NOT NULL DEFAULT '{}'
  ) STRICT;

  CREATE TABLE favicon (
    key TEXT PRIMARY KEY,
    icon_url TEXT, data BLOB NOT NULL, mime TEXT NOT NULL,
    dominant_color TEXT, fetched_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `,
  // 2: what sites were allowed or blocked (permission prompts, M1.1).
  `
  CREATE TABLE site_permission (
    profile_id TEXT NOT NULL, origin TEXT NOT NULL, permission TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow','block')), updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, origin, permission)
  ) STRICT;
  `,
  // 3: the downloads list.
  `
  CREATE TABLE download (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, url TEXT NOT NULL, path TEXT NOT NULL,
    filename TEXT NOT NULL, mime TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('progressing','paused','completed','cancelled','interrupted')),
    received INTEGER NOT NULL, total INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
  ) STRICT;
  `,
  // 4: history and learned command bar picks (M1.4). One row per place (host, port, path,
  // query); frecency is stored as the day its score falls to 1 (see core/rank.ts).
  `
  CREATE TABLE history_url (
    id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, place TEXT NOT NULL,
    url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0,
    last_visit_at INTEGER NOT NULL, decay_day REAL NOT NULL,
    UNIQUE (profile_id, place)
  ) STRICT;
  CREATE INDEX history_recent ON history_url(profile_id, last_visit_at DESC);

  CREATE TABLE history_visit (
    id INTEGER PRIMARY KEY, url_id INTEGER NOT NULL REFERENCES history_url(id) ON DELETE CASCADE,
    visited_at INTEGER NOT NULL, transition TEXT NOT NULL
  ) STRICT;

  CREATE VIRTUAL TABLE history_fts USING fts5(
    title, url, content='history_url', content_rowid='id',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4'
  );
  CREATE TRIGGER history_fts_insert AFTER INSERT ON history_url BEGIN
    INSERT INTO history_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
  END;
  CREATE TRIGGER history_fts_delete AFTER DELETE ON history_url BEGIN
    INSERT INTO history_fts(history_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
  END;
  CREATE TRIGGER history_fts_update AFTER UPDATE OF title, url ON history_url BEGIN
    INSERT INTO history_fts(history_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
    INSERT INTO history_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
  END;

  CREATE TABLE palette_choice (
    chord_id TEXT NOT NULL, text TEXT NOT NULL, destination TEXT NOT NULL,
    uses REAL NOT NULL, last_used_at INTEGER NOT NULL,
    PRIMARY KEY (chord_id, text, destination)
  ) STRICT;
  `,
  // 5: the archive (M1.4): Today tabs that were closed, cleared or unused, with their
  // back/forward history (nav_state, JSON). An entry leaves when its tab comes back.
  // rid is an explicit rowid, so the search index survives VACUUM.
  `
  CREATE TABLE archive_item (
    rid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL, chord_id TEXT NOT NULL,
    url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', favicon_key TEXT, nav_state TEXT,
    reason TEXT NOT NULL CHECK (reason IN ('auto','closed','cleared')),
    archived_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX archive_recent ON archive_item(profile_id, archived_at DESC);

  CREATE VIRTUAL TABLE archive_fts USING fts5(
    title, url, content='archive_item', content_rowid='rid',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4'
  );
  CREATE TRIGGER archive_fts_insert AFTER INSERT ON archive_item BEGIN
    INSERT INTO archive_fts(rowid, title, url) VALUES (new.rid, new.title, new.url);
  END;
  CREATE TRIGGER archive_fts_delete AFTER DELETE ON archive_item BEGIN
    INSERT INTO archive_fts(archive_fts, rowid, title, url) VALUES ('delete', old.rid, old.title, old.url);
  END;
  `,
  // 6: the Favorites row (M1.2): sites every chord shares, in order. Icons live in favicon.
  `
  CREATE TABLE favorite (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    favicon_key TEXT, rank TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  `,
];
