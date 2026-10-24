/**
 * Synthetic browser profiles for the import tests (never a real one): Chrome's
 * Local State, Bookmarks and History; Firefox's profiles.ini, places.sqlite
 * and a mozLz4 session file; Safari's binary Bookmarks.plist and History.db.
 * They're laid out under a stand-in home folder the way each OS does, which
 * development builds read instead of the real one through CHORD_IMPORT_ROOT.
 * The LZ4 compressor and plist writer here exist only to make these files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const CHROMIUM_EPOCH_MS = 11_644_473_600_000;

/* ---------- LZ4 (one block) and mozLz4 ---------- */

/** A valid LZ4 block: greedy matches of 4+ bytes, the last bytes as literals (the format's end rules). */
export function compressLz4Block(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const table = new Map<number, number>();
  const n = input.length;
  const length = (len: number) => {
    for (; len >= 255; len -= 255) out.push(255);
    out.push(len);
  };
  const emit = (from: number, to: number, match?: { offset: number; length: number }) => {
    const literals = to - from;
    const extra = match ? match.length - 4 : 0;
    out.push((Math.min(literals, 15) << 4) | (match ? Math.min(extra, 15) : 0));
    if (literals >= 15) length(literals - 15);
    for (let k = from; k < to; k++) out.push(input[k]!);
    if (!match) return;
    out.push(match.offset & 255, match.offset >> 8);
    if (extra >= 15) length(extra - 15);
  };
  let anchor = 0;
  let i = 0;
  while (i + 12 <= n) {
    const key = input[i]! | (input[i + 1]! << 8) | (input[i + 2]! << 16) | (input[i + 3]! << 24);
    const candidate = table.get(key);
    table.set(key, i);
    if (candidate !== undefined && i - candidate <= 65_535 && [0, 1, 2, 3].every((k) => input[candidate + k] === input[i + k])) {
      let len = 4;
      while (i + len < n - 5 && input[candidate + len] === input[i + len]) len++;
      emit(anchor, i, { offset: i - candidate, length: len });
      i += len;
      anchor = i;
    } else i++;
  }
  emit(anchor, n);
  return Uint8Array.from(out);
}

export function mozLz4(text: string): Uint8Array {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(12);
  header.write('mozLz40\0', 0, 'latin1');
  header.writeUInt32LE(data.length, 8);
  return Buffer.concat([header, compressLz4Block(data)]);
}

/* ---------- Binary plists ---------- */

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

/** A bplist00 file, as CFBinaryPList writes them (4-byte offsets, 2-byte references). */
export function binaryPlist(value: Plist): Uint8Array {
  const objects: Buffer[] = [];
  const marker = (type: number, count: number): Buffer => {
    if (count < 15) return Buffer.from([(type << 4) | count]);
    const size = count < 256 ? 0 : count < 65_536 ? 1 : 2;
    const head = Buffer.alloc(2 + (1 << size));
    head[0] = (type << 4) | 15;
    head[1] = 0x10 | size;
    head.writeUIntBE(count, 2, 1 << size);
    return head;
  };
  const ref = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
  };
  const add = (v: Plist): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    if (typeof v === 'boolean') objects[index] = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === 'number') {
      const b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigInt64BE(BigInt(Math.trunc(v)), 1);
      objects[index] = b;
    } else if (typeof v === 'string') {
      // Printable ASCII as bytes, anything else as UTF-16 big-endian.
      objects[index] = /^[ -~]*$/.test(v)
        ? Buffer.concat([marker(0x5, v.length), Buffer.from(v, 'latin1')])
        : Buffer.concat([marker(0x6, v.length), Buffer.from(v, 'utf16le').swap16()]);
    } else if (Array.isArray(v)) {
      const refs = v.map(add);
      objects[index] = Buffer.concat([marker(0xa, refs.length), ...refs.map(ref)]);
    } else {
      const keys = Object.keys(v).map(add);
      const values = Object.values(v).map(add);
      objects[index] = Buffer.concat([marker(0xd, keys.length), ...keys.map(ref), ...values.map(ref)]);
    }
    return index;
  };
  add(value);
  const head = Buffer.from('bplist00', 'latin1');
  const offsets: number[] = [];
  let at = head.length;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const table = Buffer.alloc(offsets.length * 4);
  offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4;
  trailer[7] = 2;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([head, ...objects, table, trailer]);
}

/* ---------- Profiles ---------- */

export type FixturePlatform = 'win32' | 'darwin' | 'linux';

/** Where each browser keeps its profiles under a stand-in home, on each OS (what src/import/detect.ts looks for). */
export function browserRoots(home: string, platform: FixturePlatform): { chrome: string; firefox: string; safari: string | null } {
  switch (platform) {
    case 'win32':
      return { chrome: join(home, 'AppData/Local/Google/Chrome/User Data'), firefox: join(home, 'AppData/Roaming/Mozilla/Firefox'), safari: null };
    case 'darwin':
      return { chrome: join(home, 'Library/Application Support/Google/Chrome'), firefox: join(home, 'Library/Application Support/Firefox'), safari: join(home, 'Library/Safari') };
    case 'linux':
      return { chrome: join(home, '.config/google-chrome'), firefox: join(home, '.mozilla/firefox'), safari: null };
  }
}

export interface FixtureOptions {
  /** Time the visits are relative to. */
  now?: number;
  /** More bookmarks in a "Big" folder of Chrome's bar, and more history pages (three visits each): for big imports. */
  extraBookmarks?: number;
  extraPages?: number;
}

/** Chrome: two profiles in Local State, one with bookmarks and history ("Alex"), one with only bookmarks ("Work"). */
export function makeChrome(root: string, { now = Date.now(), extraBookmarks = 0, extraPages = 0 }: FixtureOptions = {}): string {
  const profile = join(root, 'Default');
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(root, 'Profile 1'), { recursive: true });
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Alex' }, 'Profile 1': { name: 'Work' } }, profiles_order: ['Default', 'Profile 1'] } }));
  const url = (name: string, href: string) => ({ type: 'url', name, url: href, date_added: '13300000000000000' });
  const folder = (name: string, children: unknown[]) => ({ type: 'folder', name, children });
  const big = Array.from({ length: extraBookmarks }, (_, i) => url(`Big ${i}`, `https://big.test/${i}`));
  const bookmarks = {
    version: 1,
    roots: {
      bookmark_bar: folder('Bookmarks bar', [
        url('Chord', 'https://chord.test/'),
        folder('Recipes', [url('Apple pie', 'https://recipes.test/pie'), folder('Soups', [url('Tomato soup', 'https://recipes.test/soup')])]),
        url('Bookmarklet', 'javascript:alert(1)'),
        folder('Work', [url('Tracker', 'https://tracker.test/')]),
        ...(big.length > 0 ? [folder('Big', big)] : []),
      ]),
      other: folder('Other bookmarks', [url('Someday', 'https://someday.test/')]),
      synced: folder('Mobile bookmarks', []),
    },
  };
  writeFileSync(join(profile, 'Bookmarks'), JSON.stringify(bookmarks));
  writeFileSync(join(root, 'Profile 1', 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: folder('Bookmarks bar', [url('Wiki', 'https://wiki.test/')]) } }));

  const db = new DatabaseSync(join(profile, 'History'));
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
      typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER,
      transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL);
  `);
  const chromeTime = (ms: number) => BigInt(ms + CHROMIUM_EPOCH_MS) * 1000n;
  const addUrl = db.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)');
  const addVisit = db.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)');
  const page = (href: string, title: string, visits: { at: number; transition: number }[], hidden = 0) => {
    const id = Number(addUrl.run(href, title, visits.length, 0, chromeTime(Math.max(...visits.map((v) => v.at))), hidden).lastInsertRowid);
    // Transitions carry qualifier bits above the core type, as Chromium's do.
    for (const v of visits) addVisit.run(id, chromeTime(v.at), v.transition | 0x30000000);
  };
  db.exec('BEGIN');
  page('https://recipes.test/pie', 'Apple pie recipe', [
    { at: now - 3 * DAY, transition: 0 },
    { at: now - DAY, transition: 1 },
  ]);
  page('https://news.test/', 'Morning news', [{ at: now - 2 * DAY, transition: 1 }]);
  // A frame inside a page isn't a page you went to; hidden rows and browser pages aren't history.
  page('https://ads.test/frame', 'Ad frame', [{ at: now - DAY, transition: 3 }]);
  page('https://hidden.test/', 'Hidden', [{ at: now - DAY, transition: 0 }], 1);
  page('chrome://settings/', 'Settings', [{ at: now - DAY, transition: 1 }]);
  for (let i = 0; i < extraPages; i++) {
    page(`https://many.test/${i}`, `Page ${i}`, [0, 1, 2].map((k) => ({ at: now - (i % 60) * DAY - k * 3_600_000, transition: 0 })));
  }
  db.exec('COMMIT');
  db.close();
  return profile;
}

/**
 * Firefox: profiles.ini with the install's default profile (which has
 * places.sqlite and a session) and another without data. The session has a
 * private window, which must never come across.
 */
export function makeFirefox(root: string, { now = Date.now() }: FixtureOptions = {}): string {
  const profile = join(root, 'Profiles', 'abcd1234.default-release');
  mkdirSync(join(profile, 'sessionstore-backups'), { recursive: true });
  mkdirSync(join(root, 'Profiles', 'efgh5678.default'), { recursive: true });
  writeFileSync(
    join(root, 'profiles.ini'),
    [
      '[Install308046B0AF4A39CB]',
      'Default=Profiles/abcd1234.default-release',
      'Locked=1',
      '',
      '[Profile1]',
      'Name=default',
      'IsRelative=1',
      'Path=Profiles/efgh5678.default',
      'Default=1',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/abcd1234.default-release',
      '',
      '[General]',
      'StartWithLastProfile=1',
      'Version=2',
      '',
    ].join('\r\n'),
  );

  const db = new DatabaseSync(join(profile, 'places.sqlite'));
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, session INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR,
      keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER, lastModified INTEGER, guid TEXT, syncStatus INTEGER NOT NULL DEFAULT 0);
  `);
  const place = db.prepare('INSERT INTO moz_places (id, url, title, visit_count, hidden) VALUES (?, ?, ?, ?, 0)');
  const visit = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)');
  const mark = db.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  place.run(1, 'https://news.test/ff', 'Firefox news', 2);
  place.run(2, 'https://longread.test/a', 'A long read', 1);
  place.run(3, 'https://support.mozilla.test/', 'Get Help', 0);
  place.run(4, 'https://later.test/', 'Later', 0);
  place.run(5, 'https://tagged.test/', 'Tagged', 0);
  place.run(6, 'https://embed.test/video', 'Embedded', 1);
  // Microseconds since the Unix epoch; type 2 is typed, 4 embedded.
  visit.run(1, (now - 2 * DAY) * 1000, 1);
  visit.run(1, (now - DAY) * 1000, 2);
  visit.run(2, (now - 5 * DAY) * 1000, 1);
  visit.run(6, (now - DAY) * 1000, 4);
  // The roots, by their fixed GUIDs, then bookmarks; a separator, and a tag (tags aren't bookmarks).
  mark.run(1, 2, null, 0, 0, '', 'root________');
  mark.run(2, 2, null, 1, 0, 'menu', 'menu________');
  mark.run(3, 2, null, 1, 1, 'toolbar', 'toolbar_____');
  mark.run(4, 2, null, 1, 2, 'tags', 'tags________');
  mark.run(5, 2, null, 1, 3, 'unfiled', 'unfiled_____');
  mark.run(6, 2, null, 1, 4, 'mobile', 'mobile______');
  mark.run(10, 1, 1, 3, 0, 'Firefox News', 'bm10');
  mark.run(11, 2, null, 3, 1, 'Reading', 'bm11');
  mark.run(12, 1, 2, 11, 0, 'Long read', 'bm12');
  mark.run(13, 3, null, 11, 1, null, 'bm13');
  mark.run(14, 2, null, 2, 0, 'Mozilla Firefox', 'bm14');
  mark.run(15, 1, 3, 14, 0, 'Get Help', 'bm15');
  mark.run(16, 1, 4, 5, 0, 'Later', 'bm16');
  mark.run(17, 2, null, 4, 0, 'cooking', 'bm17');
  mark.run(18, 1, 5, 17, 0, null, 'bm18');
  db.exec('COMMIT');
  db.close();

  const session = {
    windows: [
      {
        tabs: [
          { entries: [{ url: 'https://open.test/one', title: 'One' }, { url: 'https://open.test/two', title: 'Two' }], index: 2 },
          { entries: [{ url: 'about:newtab', title: 'New Tab' }], index: 1 },
          { entries: [{ url: 'https://open.test/three', title: 'Three' }], index: 1 },
        ],
        selected: 1,
      },
      { isPrivate: true, tabs: [{ entries: [{ url: 'https://secret.test/', title: 'Secret' }], index: 1 }] },
    ],
    _closedWindows: [{ tabs: [{ entries: [{ url: 'https://closed.test/', title: 'Closed' }], index: 1 }] }],
  };
  writeFileSync(join(profile, 'sessionstore-backups', 'recovery.jsonlz4'), mozLz4(JSON.stringify(session)));
  return profile;
}

/** Safari (macOS): Favorites (the bar), the Bookmarks Menu, the Reading List, a folder at the top, and History.db. */
export function makeSafari(dir: string, { now = Date.now() }: FixtureOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  const leaf = (title: string, url: string) => ({ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: url, URIDictionary: { title }, WebBookmarkUUID: url });
  const list = (title: string, children: Plist[]) => ({ WebBookmarkType: 'WebBookmarkTypeList', Title: title, Children: children });
  const plist: Plist = {
    WebBookmarkFileVersion: 1,
    WebBookmarkType: 'WebBookmarkTypeList',
    Children: [
      { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History', WebBookmarkIdentifier: 'History' },
      list('BookmarksBar', [leaf('Apple', 'https://apple.test/'), list('Café ☕', [leaf('Espresso', 'https://coffee.test/espresso')])]),
      list('BookmarksMenu', [leaf('Menu link', 'https://menu.test/')]),
      list('Trips', [leaf('Lisbon', 'https://travel.test/lisbon')]),
      list('com.apple.ReadingList', [leaf('Read me', 'https://reading.test/')]),
    ],
  };
  writeFileSync(join(dir, 'Bookmarks.plist'), binaryPlist(plist));
  const db = new DatabaseSync(join(dir, 'History.db'));
  db.exec(`
    CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL, visit_count INTEGER NOT NULL);
    CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT NULL);
  `);
  const apple = (ms: number) => ms / 1000 - 978_307_200;
  db.prepare('INSERT INTO history_items (id, url, visit_count) VALUES (1, ?, 2), (2, ?, 1)').run('https://apple.test/', 'https://coffee.test/espresso');
  db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (1, ?, ?), (1, ?, ?), (2, ?, ?)').run(
    apple(now - 2 * DAY),
    'Apple (old title)',
    apple(now - DAY),
    'Apple',
    apple(now - 3 * DAY),
    'Espresso',
  );
  db.close();
  return dir;
}

/** Every browser this OS has, under `home`. Returns their profile folders. */
export function makeBrowserFixtures(home: string, platform: FixturePlatform = process.platform as FixturePlatform, options: FixtureOptions = {}): { chrome: string; firefox: string; safari: string | null } {
  const roots = browserRoots(home, platform);
  return { chrome: makeChrome(roots.chrome, options), firefox: makeFirefox(roots.firefox, options), safari: roots.safari ? makeSafari(roots.safari, options) : null };
}
