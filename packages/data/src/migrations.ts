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
  // 6: Chrome extensions installed in each profile (M1.5). notified_version is the version the
  // extension was last told about through runtime.onInstalled (Electron skips Chrome's install step).
  `
  CREATE TABLE extension (
    profile_id TEXT NOT NULL, id TEXT NOT NULL,
    name TEXT NOT NULL, version TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('store','unpacked')), path TEXT NOT NULL,
    notified_version TEXT,
    pinned INTEGER NOT NULL DEFAULT 1,
    installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, id)
  ) STRICT;
  `,
  // 7: the Favorites row (M1.2): sites every chord shares, in order. Icons live in favicon.
  `
  CREATE TABLE favorite (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    favicon_key TEXT, rank TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 8: page zoom you chose for a site, by host (Chrome remembers it too). Shared by every chord.
  `
  CREATE TABLE site_zoom (
    profile_id TEXT NOT NULL, host TEXT NOT NULL, factor REAL NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, host)
  ) STRICT;
  `,
  // 9: Duet (ARCHITECTURE.md §11): Chord's own transcript is the source of truth; a provider's
  // session (provider_session_id) is a cache, resumed when it works. Message bodies are JSON
  // (packages/core/src/duet.ts); text is what the command bar's @duet searches.
  `
  CREATE TABLE duet_thread (
    id TEXT PRIMARY KEY, chord_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex')), model TEXT, provider_session_id TEXT,
    scope TEXT NOT NULL DEFAULT 'ask' CHECK (scope IN ('ask','chord','all')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX duet_thread_chord ON duet_thread(chord_id, last_used_at DESC);
  CREATE TABLE duet_message (
    rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES duet_thread(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','approval','divider')),
    text TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX duet_message_thread ON duet_message(thread_id, created_at, rid);
  CREATE VIRTUAL TABLE duet_fts USING fts5(text, content='duet_message', content_rowid='rid', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER duet_message_ai AFTER INSERT ON duet_message BEGIN
    INSERT INTO duet_fts(rowid, text) VALUES (new.rid, new.text);
  END;
  CREATE TRIGGER duet_message_ad AFTER DELETE ON duet_message BEGIN
    INSERT INTO duet_fts(duet_fts, rowid, text) VALUES ('delete', old.rid, old.text);
  END;
  CREATE TRIGGER duet_message_au AFTER UPDATE OF text ON duet_message BEGIN
    INSERT INTO duet_fts(duet_fts, rowid, text) VALUES ('delete', old.rid, old.text);
    INSERT INTO duet_fts(rowid, text) VALUES (new.rid, new.text);
  END;
  `,
  // 10: split view (Phase 2; 9 is Duet's). A split is a node of kind 'split'; its panes are its
  // child tabs, in rank order. layout is {direction:'row'|'column', sizes:number[]} (shares in pane order).
  `
  CREATE TABLE IF NOT EXISTS split (
    node_id TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
    layout TEXT NOT NULL
  ) STRICT;
  `,
  // 11: link routes (from Crest): a site's links open in a chord. A route to a chord that's gone is
  // dropped at restore. It only adds its own table, if it isn't there yet.
  `
  CREATE TABLE IF NOT EXISTS link_route (
    host TEXT PRIMARY KEY, chord_id TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 12: a page's visits by page (import, ARCHITECTURE.md §9). Without it, deleting a history page (an
  // import's Undo) scans every visit to cascade, and Undo after a big import took minutes. Only an index.
  `
  CREATE INDEX IF NOT EXISTS history_visit_url ON history_visit(url_id, id);
  `,
  // 13: Effects (ARCHITECTURE.md §9, D13): your styles for a site, by host (`www.` folded, a port kept), shared by every
  // chord. css is what you wrote; hidden, presets and duet are JSON; compiled is all of it as the sanitizer made it (what
  // main inserts), with that sanitizer's version, so a newer one makes it again. Private windows' Effects are never here.
  `
  CREATE TABLE IF NOT EXISTS effect (
    host TEXT PRIMARY KEY,
    wet INTEGER NOT NULL DEFAULT 1,
    css TEXT NOT NULL DEFAULT '',
    hidden TEXT NOT NULL DEFAULT '[]',
    presets TEXT NOT NULL DEFAULT '[]',
    duet TEXT NOT NULL DEFAULT '[]',
    compiled TEXT NOT NULL DEFAULT '',
    sanitizer INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 14: a Duet chat's scope can be 'every' (Ask every time: nothing attached for you). SQLite can't change a CHECK,
  // so the table is made again, as SQLite documents: a copy with the new rule, the old one dropped, the copy renamed.
  // Foreign keys are off while migrations run (db.ts), so dropping it doesn't take its messages with it.
  `
  CREATE TABLE duet_thread_next (
    id TEXT PRIMARY KEY, chord_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex')), model TEXT, provider_session_id TEXT,
    scope TEXT NOT NULL DEFAULT 'ask' CHECK (scope IN ('every','ask','chord','all')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO duet_thread_next (id, chord_id, title, provider, model, provider_session_id, scope, created_at, updated_at, last_used_at)
    SELECT id, chord_id, title, provider, model, provider_session_id, scope, created_at, updated_at, last_used_at FROM duet_thread;
  DROP TABLE duet_thread;
  ALTER TABLE duet_thread_next RENAME TO duet_thread;
  CREATE INDEX duet_thread_chord ON duet_thread(chord_id, last_used_at DESC);
  `,
  // 15: each of a site's Effects has its own switch (ARCHITECTURE.md §9). Your CSS's is a column; each hidden element's
  // and Duet patch's is `on` in its JSON. A row from before has neither, and reads as everything on.
  `
  ALTER TABLE effect ADD COLUMN css_on INTEGER NOT NULL DEFAULT 1;
  `,
  // 16: a chord's own proxy (ARCHITECTURE.md §9, Proxies), as JSON; NULL uses the proxy for every chord, which lives in
  // settings. Only a chord with its own sign-ins has one; restore drops any other. Never a password: Chord keeps none.
  `
  ALTER TABLE chord ADD COLUMN proxy TEXT;
  `,
  // 17: Your data's export (docs/decisions/S15-your-data.md §7). Each exported record carries a stamp, which without sync is
  // its row's updated_at: setting, favorite and link_route gain theirs, set when a row's value changes. A row from before
  // has 0, older than anything, since when it last changed isn't known. meta holds this computer's id (64 random bits),
  // made the first time an export needs it and never exported as data.
  `
  ALTER TABLE setting ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE favorite ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE link_route ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `,
  // 18: Your data's import (docs/decisions/S15-your-data.md §5, §12). A Duet chat brought in from a Chord file is marked with
  // when it came: its earlier turns reach a provider only as untrusted data, never in the instructions. NULL for a chat made
  // here. Sync's tables, once 18, come with 19.
  `
  ALTER TABLE duet_thread ADD COLUMN imported_at INTEGER;
  `,
  // 19: sync (docs/decisions/S15-your-data.md §6, §7). sync_record is the merged copy of every synced thing: each field's
  // value (fields) and the stamp of the change that set it (stamps), as JSON objects by field; local is what this
  // computer last wrote of it ({"deleted":true} once it's gone here; NULL, never), which write() compares the model with
  // to stamp only what you changed. sync_outbox holds your stamped changes until the sync worker has appended them to
  // this computer's log; sync_cursor, how far each computer's segments have been read. The clock, the folder, the
  // generation and this computer's own segment are in meta (sync.*). Empty, and untouched by write(), while sync is off.
  `
  CREATE TABLE IF NOT EXISTS sync_record (
    type TEXT NOT NULL, id TEXT NOT NULL, fields TEXT NOT NULL, stamps TEXT NOT NULL, local TEXT,
    PRIMARY KEY (type, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY, record TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS sync_cursor (
    generation INTEGER NOT NULL, device TEXT NOT NULL, segment INTEGER NOT NULL,
    head TEXT NOT NULL, offset INTEGER NOT NULL, frame INTEGER NOT NULL, snapshot INTEGER NOT NULL,
    PRIMARY KEY (generation, device, segment)
  ) STRICT;
  `,
  // 20: what sync's reader remembers of junk in the folder (S15 §13): each name with its size and time when looked
  // into, so it's looked into once, across launches too. At most a few thousand rows (core's MAX_JUNK).
  `
  CREATE TABLE IF NOT EXISTS sync_junk (path TEXT PRIMARY KEY, seen TEXT NOT NULL) STRICT;
  `,
  // 21: who last wrote what sync keeps of each synced row (S15 §13): `user` (something you did), `sync` (another
  // computer's change applied) or `tidy` (this computer adjusting on its own), and when that was made (`at`, ms), by the
  // write's kind and id (`chord`, `node`, `favorite`, `linkRoute`, `effect`, `setting`). A write that changed nothing
  // sync keeps (a tab's last visit) leaves it. Sync's drift check stamps only what you wrote, and joining and the drift
  // check take a row's time from here, not from its last write. A row written before this has none: who wrote it isn't
  // known. And a write too big for one short transaction (a chord with thousands of tabs going), as what it will do, a
  // part a row (part -1: made whole), so a stop partway is finished at the next open (`write_intent`). And what this
  // computer last had of a synced thing before it went here (sync_record.was): brought back (an Undo, a tab pinned
  // again), only what differs from it is a change of yours. And what you changed while a join waited for your choice
  // (`sync_noted`, with when, what it was before, and whether it was in sync at any point in that window): stamped as
  // it ends, even after a crash meanwhile. And, of each segment read, the last frame read (where, its hash, and the
  // file's time then), so one another copy of the profile wrote on from a point, or over its last frame, is read again
  // from its start.
  `
  ALTER TABLE sync_record ADD COLUMN was TEXT;
  ALTER TABLE sync_cursor ADD COLUMN last_at INTEGER;
  ALTER TABLE sync_cursor ADD COLUMN last_hash TEXT;
  ALTER TABLE sync_cursor ADD COLUMN last_mtime REAL;
  CREATE TABLE IF NOT EXISTS row_origin (k TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, at INTEGER, PRIMARY KEY (k, id)) STRICT;
  CREATE TABLE IF NOT EXISTS write_intent (id TEXT NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (id, part)) STRICT;
  CREATE TABLE IF NOT EXISTS sync_noted (k TEXT NOT NULL, id TEXT NOT NULL, at INTEGER, base TEXT, live INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (k, id)) STRICT;
  `,
];
