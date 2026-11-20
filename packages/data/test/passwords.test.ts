/**
 * The vault (docs/decisions/S17-passwords.md §7, §13 layer 4): migration 24,
 * the passphrase and the kept key, sealing and opening, tags, matching on the
 * page's origin, saving and updating, Delete's Undo, and that nothing of a
 * password or a site reaches chord.db's bytes in the clear.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChordDatabase } from '../src/db';
import { MIGRATIONS } from '../src/migrations';
import type { PasswordOp, PasswordResult } from '../src/passwords';

/** A cheap scrypt: S15's parameters take half a second each time. */
const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';
const PASSWORD = 'hunter2-Sekrit-Zq9!';

let dir: string;
let file: string;
let db: ChordDatabase;
const run = (op: PasswordOp, now?: number): Promise<PasswordResult> => db.passwords.run(op, now);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-passwords-data-'));
  file = join(dir, 'chord.db');
  db = new ChordDatabase(file, 'linux', KDF);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A vault, open, with one GitHub sign-in. */
async function withLogin(origin = 'https://github.com', username = 'ada@acme.dev', password = PASSWORD, chordId: string | null = 'work'): Promise<string> {
  if ((await run({ op: 'status' })).status!.state === 'none') await run({ op: 'setup', passphrase: PASSPHRASE });
  const added = await run({ op: 'add', login: { origin, username, password }, chordId });
  expect(added.problem).toBeUndefined();
  return added.id!;
}

/** chord.db opened beside the vault, as anything else on the computer could open it; closed after each test. */
let handles: DatabaseSync[] = [];
const raw = () => {
  const handle = new DatabaseSync(file);
  handles.push(handle);
  return handle;
};
afterEach(() => {
  for (const handle of handles) if (handle.isOpen) handle.close();
  handles = [];
});

describe('migration 24', () => {
  it('adds the vault’s tables, empty, on the newest version', () => {
    expect(db.version).toBe(MIGRATIONS.length);
    const tables = (raw().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'login%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['login', 'login_never', 'login_use']);
  });
});

describe('the passphrase and the key', () => {
  it('has no vault until the first passphrase, and opens with it', async () => {
    expect((await run({ op: 'status' })).status).toEqual({ state: 'none', kept: false, count: 0 });
    expect((await run({ op: 'list', chordId: null })).problem).toBe('none');
    expect((await run({ op: 'setup', passphrase: 'short' })).problem).toBe('invalid');
    expect((await run({ op: 'setup', passphrase: PASSPHRASE })).status).toEqual({ state: 'open', kept: false, count: 0 });
    expect((await run({ op: 'setup', passphrase: 'another long passphrase' })).problem).toBe('exists');
  });

  it.each([
    ['the passphrase', PASSPHRASE, undefined, 'open'],
    ['the same passphrase composed differently (NFC)', `${PASSPHRASE} café`, `${PASSPHRASE} café`, 'open'],
    ['another passphrase', 'not the passphrase at all', undefined, 'locked'],
    ['an empty one', '', undefined, 'locked'],
  ] as const)('unlocks with %s, or fails closed', async (_what, typed, setWith, state) => {
    await run({ op: 'setup', passphrase: setWith ?? PASSPHRASE });
    await run({ op: 'lock' });
    const answer = await run({ op: 'unlock', passphrase: typed });
    expect(answer.status!.state).toBe(state);
    expect(answer.problem).toBe(state === 'open' ? undefined : 'wrong');
  });

  it('locks: the ops that need the key say so, and nothing else changes', async () => {
    const id = await withLogin();
    await run({ op: 'lock' });
    expect((await run({ op: 'status' })).status).toEqual({ state: 'locked', kept: false, count: 1 });
    for (const op of [{ op: 'list', chordId: null }, { op: 'reveal', id }, { op: 'fill', id, origin: 'https://github.com', chordId: null }, { op: 'key' }] as PasswordOp[]) {
      const answer = await run(op);
      expect(answer.problem).toBe('locked');
      expect(answer.password).toBeUndefined();
    }
  });

  it('an unlock typed before a lock doesn’t open the vault after it', async () => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    await run({ op: 'lock' });
    const unlocking = run({ op: 'unlock', passphrase: PASSPHRASE });
    await run({ op: 'lock' });
    // It says so, so main doesn't take the passphrase as typed and opened.
    expect((await unlocking).problem).toBe('locked');
    expect((await run({ op: 'status' })).status!.state).toBe('locked');
  });

  it('a kept key read before a lock doesn’t open the vault after it', async () => {
    await withLogin();
    const { key } = await run({ op: 'key' });
    await run({ op: 'lock' });
    const { generation } = await run({ op: 'status' });
    await run({ op: 'lock' });
    expect((await run({ op: 'open', key: new Uint8Array(key!), generation })).problem).toBe('locked');
    const now = (await run({ op: 'status' })).generation;
    expect((await run({ op: 'open', key: key!, generation: now })).status!.state).toBe('open');
  });

  it('Lock now holds across a relaunch: the kept key waits for the passphrase', async () => {
    await withLogin();
    const { key } = await run({ op: 'key' });
    await run({ op: 'lock', held: true });
    db.close();
    db = new ChordDatabase(file, 'linux', KDF);
    expect((await run({ op: 'status' })).held).toBe(true);
    expect((await run({ op: 'open', key: new Uint8Array(key!) })).problem).toBe('locked');
    await run({ op: 'unlock', passphrase: PASSPHRASE });
    expect((await run({ op: 'status' })).held).toBe(false);
    await run({ op: 'lock' });
    expect((await run({ op: 'open', key: key! })).status!.state).toBe('open');
  });

  it('a fill says which origin (and realm) the sign-in was saved for, so main checks the match too', async () => {
    const id = await withLogin('https://github.com');
    expect(await run({ op: 'fill', id, origin: 'https://gist.github.com', chordId: null })).toEqual({ password: PASSWORD, loginOrigin: 'https://github.com', loginRealm: null });
  });

  it('a stored check of the wrong length fails closed, and throws nothing', async () => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    const { key } = await run({ op: 'key' });
    await run({ op: 'lock' });
    const r = raw();
    const meta = JSON.parse((r.prepare(`SELECT value FROM meta WHERE key = 'passwords'`).get() as { value: string }).value);
    r.prepare(`UPDATE meta SET value = ? WHERE key = 'passwords'`).run(JSON.stringify({ ...meta, check: 'c2hvcnQ=' }));
    expect((await run({ op: 'open', key: key! })).problem).toBe('wrong');
    expect((await run({ op: 'unlock', passphrase: PASSPHRASE })).problem).toBe('wrong');
  });

  it('verifies the passphrase without changing anything, and changes it without sealing a row again', async () => {
    const id = await withLogin();
    const before = raw().prepare('SELECT sealed FROM login WHERE id = ?').get(id) as { sealed: Uint8Array };
    expect((await run({ op: 'verify', passphrase: PASSPHRASE })).problem).toBeUndefined();
    expect((await run({ op: 'verify', passphrase: 'wrong wrong wrong' })).problem).toBe('wrong');
    expect((await run({ op: 'passphrase', current: 'wrong wrong wrong', next: 'a brand new passphrase' })).problem).toBe('wrong');
    expect((await run({ op: 'passphrase', current: PASSPHRASE, next: 'short' })).problem).toBe('invalid');
    expect((await run({ op: 'passphrase', current: PASSPHRASE, next: 'a brand new passphrase' })).status!.state).toBe('open');
    const after = raw().prepare('SELECT sealed FROM login WHERE id = ?').get(id) as { sealed: Uint8Array };
    expect(Buffer.from(after.sealed).equals(Buffer.from(before.sealed))).toBe(true);
    await run({ op: 'lock' });
    expect((await run({ op: 'unlock', passphrase: PASSPHRASE })).problem).toBe('wrong');
    expect((await run({ op: 'unlock', passphrase: 'a brand new passphrase' })).status!.state).toBe('open');
    expect((await run({ op: 'reveal', id })).password).toBe(PASSWORD);
  });

  it('keeps a copy for the OS to wrap; opens with the key, and refuses another', async () => {
    const id = await withLogin();
    const { key } = await run({ op: 'key' });
    expect(key).toHaveLength(32);
    await run({ op: 'keep', blob: 'b3Mtd3JhcHBlZA==' });
    expect((await run({ op: 'kept' })).blob).toBe('b3Mtd3JhcHBlZA==');
    expect((await run({ op: 'status' })).status!.kept).toBe(true);
    await run({ op: 'lock' });
    // A key that isn't this vault's (a profile copied from elsewhere, a stale copy): fails closed.
    const other = new Uint8Array(32).fill(7);
    expect((await run({ op: 'open', key: other })).problem).toBe('wrong');
    expect(other.every((b) => b === 0)).toBe(true);
    expect((await run({ op: 'open', key: new Uint8Array(16) })).problem).toBe('wrong');
    expect((await run({ op: 'open', key: key! })).status!.state).toBe('open');
    expect((await run({ op: 'reveal', id })).password).toBe(PASSWORD);
    await run({ op: 'keep', blob: null });
    expect((await run({ op: 'status' })).status!.kept).toBe(false);
  });

  it('starts over: every sign-in, the never list and the key go', async () => {
    await withLogin();
    await run({ op: 'never', origin: 'https://example.com' });
    await run({ op: 'lock' });
    expect((await run({ op: 'startOver' })).status).toEqual({ state: 'none', kept: false, count: 0 });
    const db2 = raw();
    expect(db2.prepare('SELECT COUNT(*) AS n FROM login_never').get()).toEqual({ n: 0 });
    expect(db2.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key = 'passwords'`).get()).toEqual({ n: 0 });
  });

  it('a reopened chord.db is locked, and opens with the passphrase', async () => {
    const id = await withLogin();
    db.close();
    db = new ChordDatabase(file, 'linux', KDF);
    expect((await run({ op: 'status' })).status!.state).toBe('locked');
    await run({ op: 'unlock', passphrase: PASSPHRASE });
    expect((await run({ op: 'reveal', id })).password).toBe(PASSWORD);
  });
});

describe('sealing', () => {
  it('a blob moved to another row doesn’t open there', async () => {
    const a = await withLogin('https://github.com', 'ada');
    const b = await withLogin('https://github.com', 'grace', 'another-password');
    const r = raw();
    const sealedA = (r.prepare('SELECT sealed FROM login WHERE id = ?').get(a) as { sealed: Uint8Array }).sealed;
    r.prepare('UPDATE login SET sealed = ? WHERE id = ?').run(sealedA, b);
    r.close();
    expect((await run({ op: 'reveal', id: a })).password).toBe(PASSWORD);
    expect((await run({ op: 'reveal', id: b })).problem).toBe('missing');
    const list = await run({ op: 'list', chordId: null });
    expect(list.logins!.map((l) => l.username)).toEqual(['ada']);
    expect(list.unreadable).toBe(1);
  });

  it.each([
    ['a flipped bit in the ciphertext', (s: Buffer) => (s[20]! ^= 1)],
    ['a flipped bit in the tag', (s: Buffer) => (s[s.length - 1]! ^= 1)],
    ['another format version', (s: Buffer) => (s[0] = 2)],
  ])('%s fails closed', async (_what, damage) => {
    const id = await withLogin();
    const r = raw();
    const sealed = Buffer.from((r.prepare('SELECT sealed FROM login WHERE id = ?').get(id) as { sealed: Uint8Array }).sealed);
    damage(sealed);
    r.prepare('UPDATE login SET sealed = ? WHERE id = ?').run(sealed, id);
    r.close();
    expect((await run({ op: 'reveal', id })).problem).toBe('missing');
    expect((await run({ op: 'fill', id, origin: 'https://github.com', chordId: null })).password).toBeUndefined();
  });

  it('seals each sign-in with its own nonce: the same sign-in twice is two different blobs', async () => {
    const a = await withLogin();
    const b = await withLogin();
    const r = raw();
    const blob = (id: string) => Buffer.from((r.prepare('SELECT sealed FROM login WHERE id = ?').get(id) as { sealed: Uint8Array }).sealed);
    expect(blob(a).equals(blob(b))).toBe(false);
  });

  it('an old copy of the key doesn’t linger: not the OS’s after Keep unlocked goes off, not the old wrap after a new passphrase, in chord.db, its log or a backup', async () => {
    await withLogin();
    const KEPT = 'S0VQVC1CWS1USEUtT1MtZm9yLXRoaXMtdGVzdA==';
    await run({ op: 'keep', blob: KEPT });
    const metaOf = (r = raw()) => JSON.parse((r.prepare(`SELECT value FROM meta WHERE key = 'passwords'`).get() as { value: string }).value) as { key: string };
    const oldWrap = metaOf().key;
    // A migration's backup made while both were current (a later Chord's migration would make one).
    raw().exec(`VACUUM INTO '${join(dir, 'chord.db.v24.bak').replaceAll("'", "''")}'`);
    await run({ op: 'keep', blob: null });
    await run({ op: 'passphrase', current: PASSPHRASE, next: 'a brand new passphrase' });
    for (const h of handles) if (h.isOpen) h.close();
    handles = [];
    const files = readdirSync(dir).filter((n) => n.startsWith('chord.db'));
    expect(files).toContain('chord.db.v24.bak');
    for (const name of files) {
      const bytes = readFileSync(join(dir, name));
      expect(bytes.includes(Buffer.from(KEPT)), `the kept copy in ${name}`).toBe(false);
      expect(bytes.includes(Buffer.from(oldWrap)), `the old wrap in ${name}`).toBe(false);
    }
    // The backup has the vault as it is now: the new passphrase opens it, the old one doesn't.
    expect(metaOf(raw()).key).not.toBe(oldWrap);
    const backup = new DatabaseSync(join(dir, 'chord.db.v24.bak'));
    expect(metaOf(backup).key).toBe(metaOf(raw()).key);
    backup.close();
  });

  it('an unlock in flight doesn’t bring back the kept key when Keep unlocked goes off meanwhile', async () => {
    await withLogin();
    await run({ op: 'keep', blob: 'S0VQVC1SQUNF' });
    await run({ op: 'lock', held: true });
    const unlocking = run({ op: 'unlock', passphrase: PASSPHRASE });
    await run({ op: 'keep', blob: null });
    expect((await unlocking).status!.state).toBe('open');
    expect((await run({ op: 'kept' })).blob).toBeNull();
    expect((await run({ op: 'status' })).held).toBe(false);
  });

  it('Lock now during a passphrase change holds', async () => {
    await withLogin();
    const changing = run({ op: 'passphrase', current: PASSPHRASE, next: 'a brand new passphrase' });
    await run({ op: 'lock', held: true });
    expect((await changing).problem).toBeUndefined();
    expect((await run({ op: 'status' })).held).toBe(true);
  });

  it('won’t start over while open', async () => {
    await withLogin();
    expect((await run({ op: 'startOver' })).problem).toBe('refused');
    expect((await run({ op: 'status' })).status!.count).toBe(1);
  });

  it('a checkpoint another connection holds up is tried again: the old copy goes once it can', async () => {
    await withLogin();
    const KEPT = 'S0VQVC1CVVNZLUNIRUNLUE9JTlQ=';
    await run({ op: 'keep', blob: KEPT });
    // An export's read, holding the log.
    const reader = raw();
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM login').get();
    await run({ op: 'keep', blob: null });
    expect(readFileSync(file).includes(Buffer.from(KEPT)), 'still in chord.db while the reader holds the log').toBe(true);
    reader.exec('COMMIT');
    reader.close();
    db.close();
    for (const name of readdirSync(dir).filter((n) => n.startsWith('chord.db'))) {
      expect(readFileSync(join(dir, name)).includes(Buffer.from(KEPT)), `the kept copy in ${name}`).toBe(false);
    }
    db = new ChordDatabase(file, 'linux', KDF);
  });

  it('a backup never gets the OS-kept copy, nor Lock now', async () => {
    await withLogin();
    raw().exec(`VACUUM INTO '${join(dir, 'chord.db.v24.bak').replaceAll("'", "''")}'`);
    const KEPT = 'S0VQVC1JTi1CQUNLVVA=';
    await run({ op: 'keep', blob: KEPT });
    await run({ op: 'lock', held: true });
    await run({ op: 'unlock', passphrase: PASSPHRASE });
    await run({ op: 'passphrase', current: PASSPHRASE, next: 'a brand new passphrase' });
    const bak = join(dir, 'chord.db.v24.bak');
    expect(readFileSync(bak).includes(Buffer.from(KEPT))).toBe(false);
    expect(existsSync(`${bak}-journal`)).toBe(false);
    const backup = new DatabaseSync(bak);
    const meta = JSON.parse((backup.prepare(`SELECT value FROM meta WHERE key = 'passwords'`).get() as { value: string }).value) as { kept: unknown; held?: unknown };
    backup.close();
    expect([meta.kept, meta.held]).toEqual([null, undefined]);
  });

  it('starting over takes the vault out of the backups too', async () => {
    await withLogin();
    raw().exec(`VACUUM INTO '${join(dir, 'chord.db.v24.bak').replaceAll("'", "''")}'`);
    await run({ op: 'lock' });
    await run({ op: 'startOver' });
    const backup = new DatabaseSync(join(dir, 'chord.db.v24.bak'));
    expect(backup.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key = 'passwords'`).get()).toEqual({ n: 0 });
    backup.close();
  });

  it('chord.db, its write-ahead log and its backups never hold a password, a username, a site or a realm in the clear', async () => {
    const id = await withLogin('https://secret-site.example', 'ada.lovelace@acme.dev');
    await run({ op: 'edit', id, patch: { password: 'second-Password-Qx7', note: 'the note is sealed too' } });
    // The browser's own sign-in box: its realm is sealed with the rest, never a column of its own (the row has its site's tag only).
    await run({ op: 'save', origin: 'http://hidden-router.example:8080', realm: 'Secret Realm Name', username: 'box-user@acme.dev', password: 'box-Password-Qx7', chordId: null });
    const columns = (raw().prepare('PRAGMA table_info(login)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(['id', 'site_tag', 'sealed', 'created_at', 'updated_at']);
    await run({ op: 'never', origin: 'https://never-here.example' });
    db.close();
    db = new ChordDatabase(file, 'linux', KDF);
    raw().exec(`VACUUM INTO '${join(dir, 'chord.db.v24.bak').replaceAll("'", "''")}'`);
    for (const path of [file, `${file}-wal`, `${file}-shm`, join(dir, 'chord.db.v24.bak')]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      for (const secret of [PASSWORD, 'second-Password-Qx7', 'ada.lovelace@acme.dev', 'secret-site', 'never-here', 'the note is sealed', PASSPHRASE, 'Secret Realm', 'hidden-router', 'box-user', 'box-Password']) {
        expect(bytes.includes(Buffer.from(secret, 'utf8')), `${secret} in ${path}`).toBe(false);
        expect(bytes.includes(Buffer.from(secret, 'utf16le')), `${secret} (UTF-16) in ${path}`).toBe(false);
      }
    }
  });
});

describe('tags', () => {
  it.each([
    ['the same host', 'https://github.com', 'https://github.com', true],
    ['another host of the site', 'https://login.github.com', 'https://gist.github.com', true],
    ['http and https of one host', 'http://github.com', 'https://github.com', true],
    ['private suffixes apart', 'https://a.github.io', 'https://b.github.io', false],
    ['another site', 'https://github.com', 'https://gitlab.com', false],
    ['an address and its port', 'http://10.0.0.1:8080', 'http://10.0.0.1:8081', false],
  ])('%s: one tag %s', async (_what, a, b, same) => {
    await withLogin(a, 'one');
    await withLogin(b, 'two');
    const tags = (raw().prepare('SELECT DISTINCT hex(site_tag) AS t FROM login').all() as { t: string }[]).map((r) => r.t);
    expect(tags).toHaveLength(same ? 1 : 2);
    expect(tags[0]).toMatch(/^[0-9A-F]{32}$/);
  });

  it('tags with the vault’s own key: another vault tags the same site differently', async () => {
    await withLogin('https://github.com');
    const first = (raw().prepare('SELECT hex(site_tag) AS t FROM login').get() as { t: string }).t;
    await run({ op: 'lock' });
    await run({ op: 'startOver' });
    await withLogin('https://github.com');
    expect((raw().prepare('SELECT hex(site_tag) AS t FROM login').get() as { t: string }).t).not.toBe(first);
  });
});

describe('the API the menu and the save card call', () => {
  it('lists a site’s sign-ins with usernames only, and when the asking chord last used each', async () => {
    const work = await withLogin('https://github.com', 'ada@acme.dev', PASSWORD, 'work');
    await withLogin('https://gist.github.com', 'ada.lovelace', 'pw-2', 'personal');
    await withLogin('https://gitlab.com', 'nope', 'pw-3', 'work');
    const { logins } = await run({ op: 'forSite', origin: 'https://github.com/login', chordId: 'work' });
    expect(logins!.map((l) => [l.username, l.origin, l.chordUsed !== null])).toEqual(
      expect.arrayContaining([
        ['ada@acme.dev', 'https://github.com', true],
        ['ada.lovelace', 'https://gist.github.com', false],
      ]),
    );
    expect(logins).toHaveLength(2);
    expect(JSON.stringify(logins)).not.toContain(PASSWORD);
    expect(logins!.find((l) => l.id === work)!.lastUsed).not.toBeNull();
  });

  it.each([
    ['its own origin', 'https://github.com', 'https://github.com', true],
    ['another host of its site', 'https://gist.github.com', 'https://github.com', true],
    ['saved on http, the page on https', 'https://github.com', 'http://github.com', true],
    ['saved on https, the page on http', 'http://github.com', 'https://github.com', false],
    ['a look-alike', 'https://github.com.evil.example', 'https://github.com', false],
    ['another private suffix', 'https://b.github.io', 'https://a.github.io', false],
    ['not a web page', 'chord://settings', 'https://github.com', false],
  ])('fills for %s: %s', async (_what, page, saved, fills) => {
    const id = await withLogin(saved);
    const answer = await run({ op: 'fill', id, origin: page, chordId: 'work' });
    if (fills) expect(answer.password).toBe(PASSWORD);
    else expect(answer).toEqual({ problem: 'refused' });
  });

  it('a fill records which chord used it; a private window’s (no chord) records nothing', async () => {
    const id = await withLogin('https://github.com', 'ada', PASSWORD, null);
    await run({ op: 'fill', id, origin: 'https://github.com', chordId: null }, 1000);
    expect((await run({ op: 'list', chordId: 'work' })).logins![0]!.lastUsed).toBeNull();
    await run({ op: 'fill', id, origin: 'https://github.com', chordId: 'work' }, 2000);
    const [login] = (await run({ op: 'list', chordId: 'work' })).logins!;
    expect([login!.lastUsed, login!.chordUsed]).toEqual([2000, 2000]);
    expect((await run({ op: 'list', chordId: 'personal' })).logins![0]!.chordUsed).toBeNull();
  });

  it.each([
    ['nothing saved for the username', { username: 'grace', password: PASSWORD }, 'new'],
    ['the same username, another password', { username: 'ada', password: 'changed' }, 'update'],
    ['exactly what’s saved', { username: 'ada', password: PASSWORD }, 'same'],
  ] as const)('compares a candidate: %s → %s', async (_what, candidate, kind) => {
    const id = await withLogin('https://github.com', 'ada');
    const { candidate: found } = await run({ op: 'compare', origin: 'https://github.com', ...candidate });
    expect(found!.kind).toBe(kind);
    if (found!.kind !== 'new') expect(found!.id).toBe(id);
  });

  it.each([
    // A site that takes a code after the password (main says so, from Apple's list): the code is no new password.
    ['Sekrit-pass', 'Sekrit-pass123456', true, 'same'],
    ['pass2024', 'pass2024123456', true, 'same'],
    ['Sekrit-pass', 'Sekrit-pass12345', true, 'update'],
    ['Sekrit-pass', 'Sekrit-pass123456789', true, 'update'],
    // Any other site: 6 digits after it is another password, and the Update card shows.
    ['Sekrit-pass', 'Sekrit-pass123456', false, 'update'],
  ] as const)('saved %s, submitted %s, appendsCode %s → %s', async (saved, submitted, appendsCode, kind) => {
    const id = await withLogin('https://www.example.com', 'ada', saved);
    const { candidate: found } = await run({ op: 'compare', origin: 'https://www.example.com', username: 'ada', password: submitted, ...(appendsCode ? { appendsCode } : {}) });
    expect(found).toEqual({ kind, id });
  });

  it('saves a new sign-in, and updates one keeping the password before it; an http one moves to https', async () => {
    const id = await withLogin('http://github.com', 'ada');
    const saved = await run({ op: 'save', origin: 'https://github.com', username: 'ada', password: 'new-password', chordId: 'work', replace: id }, 5000);
    expect(saved.id).toBe(id);
    const [login] = (await run({ op: 'list', chordId: 'work' })).logins!;
    expect(login!.origin).toBe('https://github.com');
    expect((await run({ op: 'reveal', id })).password).toBe('new-password');
    // The old password is kept inside the blob, for a wrong update.
    expect((await run({ op: 'fill', id, origin: 'https://github.com', chordId: null })).password).toBe('new-password');
    const other = await run({ op: 'save', origin: 'https://gitlab.com', username: 'ada', password: 'x', chordId: null });
    expect(other.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await run({ op: 'save', origin: 'https://gitlab.com', username: 'ada', password: 'y', chordId: null, replace: id })).problem).toBe('refused');
  });

  it.each([
    ['an empty password', { origin: 'https://a.example', username: 'u', password: '' }],
    ['a password over 1,000 characters', { origin: 'https://a.example', username: 'u', password: 'x'.repeat(1001) }],
    ['a username over 500', { origin: 'https://a.example', username: 'u'.repeat(501), password: 'p' }],
    ['a page that isn’t http or https', { origin: 'file:///etc/passwd', username: 'u', password: 'p' }],
    ['an address with a password in it', { origin: 'https://u:p@a.example', username: 'u', password: 'p' }],
  ])('refuses %s, and keeps nothing', async (_what, login) => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    expect((await run({ op: 'add', login, chordId: null })).problem).toBe('invalid');
    expect((await run({ op: 'status' })).status!.count).toBe(0);
  });

  it('deletes with an Undo that brings it back as it was, with its uses', async () => {
    const id = await withLogin('https://github.com', 'ada', PASSWORD, 'work');
    expect((await run({ op: 'delete', id })).id).toBe(id);
    expect((await run({ op: 'list', chordId: 'work' })).logins).toEqual([]);
    expect((await run({ op: 'undelete', id })).id).toBe(id);
    const [login] = (await run({ op: 'list', chordId: 'work' })).logins!;
    expect([login!.id, login!.chordUsed !== null]).toEqual([id, true]);
    expect((await run({ op: 'reveal', id })).password).toBe(PASSWORD);
    expect((await run({ op: 'undelete', id })).problem).toBe('missing');
  });

  it('edits: the address, the username, the note, the password', async () => {
    const id = await withLogin('https://github.com', 'ada');
    await run({ op: 'edit', id, patch: { origin: 'https://gitlab.com', username: 'grace', note: 'work account', password: 'p2' } });
    const [login] = (await run({ op: 'list', chordId: null })).logins!;
    expect([login!.origin, login!.username, login!.note]).toEqual(['https://gitlab.com', 'grace', 'work account']);
    expect((await run({ op: 'forSite', origin: 'https://github.com', chordId: null })).logins).toEqual([]);
    expect((await run({ op: 'forSite', origin: 'https://gitlab.com', chordId: null })).logins).toHaveLength(1);
    expect((await run({ op: 'edit', id, patch: { origin: 'ftp://x' } })).problem).toBe('invalid');
  });

  it('remembers sites never to save for, by site, and lists them', async () => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    await run({ op: 'never', origin: 'https://login.example.com' });
    await run({ op: 'never', origin: 'https://www.example.com' });
    expect((await run({ op: 'isNever', origin: 'https://example.com/signup' })).never).toBe(true);
    expect((await run({ op: 'isNever', origin: 'https://example.org' })).never).toBe(false);
    expect((await run({ op: 'nevers' })).nevers).toEqual(['example.com']);
    await run({ op: 'forgetNever', site: 'example.com' });
    expect((await run({ op: 'nevers' })).nevers).toEqual([]);
  });
});

describe('sign-ins from the browser’s own box (S17 §10): by origin and realm, apart from forms', () => {
  const ROUTER = 'http://router.test:8080';

  it('saves with the realm, matches only that origin and realm, and keeps forms and the box apart', async () => {
    const form = await withLogin(ROUTER, 'ada@example.com', 'form-Sekrit');
    const saved = await run({ op: 'save', origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit', chordId: 'work' });
    expect(saved.id).toBeDefined();
    expect(saved.id).not.toBe(form);

    const box = (origin: string, realm: string) => run({ op: 'forSite', origin, realm, chordId: 'work' }).then((r) => r.logins!.map((l) => l.id));
    expect(await box(ROUTER, 'Router admin')).toEqual([saved.id]);
    // Another realm, port or scheme on the same host: nothing.
    expect(await box(ROUTER, 'Other')).toEqual([]);
    expect(await box('http://router.test:8081', 'Router admin')).toEqual([]);
    expect(await box('https://router.test:8080', 'Router admin')).toEqual([]);
    // A form on the same origin is offered its own only.
    expect((await run({ op: 'forSite', origin: ROUTER, chordId: 'work' })).logins!.map((l) => l.id)).toEqual([form]);
    // The list says which is which.
    const listed = (await run({ op: 'list', chordId: null })).logins!;
    expect(listed.find((l) => l.id === saved.id)!.realm).toBe('Router admin');
    expect(listed.find((l) => l.id === form)!.realm).toBeNull();
  });

  it('fills the box only for its origin and realm, and never a form from it (nor the box from a form)', async () => {
    const form = await withLogin(ROUTER, 'ada@example.com', 'form-Sekrit');
    const { id } = await run({ op: 'save', origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit', chordId: null });
    expect((await run({ op: 'fill', id: id!, origin: ROUTER, realm: 'Router admin', chordId: null })).password).toBe('box-Sekrit');
    expect((await run({ op: 'fill', id: id!, origin: ROUTER, realm: 'Other', chordId: null })).problem).toBe('refused');
    expect((await run({ op: 'fill', id: id!, origin: 'https://router.test:8080', realm: 'Router admin', chordId: null })).problem).toBe('refused');
    expect((await run({ op: 'fill', id: id!, origin: ROUTER, chordId: null })).problem).toBe('refused');
    expect((await run({ op: 'fill', id: form, origin: ROUTER, realm: 'Router admin', chordId: null })).problem).toBe('refused');
  });

  it('compares and updates within the realm, keeping the password before it', async () => {
    await withLogin(ROUTER, 'ada@example.com', 'form-Sekrit');
    const compare = (password: string, realm = 'Router admin') => run({ op: 'compare', origin: ROUTER, realm, username: 'ada@example.com', password }).then((r) => r.candidate!);
    // The form's sign-in for the same username doesn't count.
    expect(await compare('box-Sekrit')).toEqual({ kind: 'new' });
    const { id } = await run({ op: 'save', origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit', chordId: null });
    expect(await compare('box-Sekrit')).toEqual({ kind: 'same', id });
    expect(await compare('new-Sekrit')).toEqual({ kind: 'update', id });
    expect(await compare('box-Sekrit', 'Other')).toEqual({ kind: 'new' });
    const updated = await run({ op: 'save', origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'new-Sekrit', chordId: null, replace: id! }, 5000);
    expect(updated).toEqual({ id, changedAt: 5000 });
    expect((await run({ op: 'reveal', id: id! })).password).toBe('new-Sekrit');
    // A form's save can't replace the box's, nor another realm's.
    expect((await run({ op: 'save', origin: ROUTER, username: 'ada@example.com', password: 'x', chordId: null, replace: id! })).problem).toBe('refused');
    expect((await run({ op: 'save', origin: ROUTER, realm: 'Other', username: 'ada@example.com', password: 'x', chordId: null, replace: id! })).problem).toBe('refused');
    // Undo of that update: the one before it back, and the wrong one kept as the one before; only once, and never
    // for an update that isn't the latest change.
    expect((await run({ op: 'revert', id: id!, changedAt: 4999 })).problem).toBe('refused');
    expect((await run({ op: 'revert', id: id!, changedAt: 5000 }, 6000)).id).toBe(id);
    expect((await run({ op: 'reveal', id: id! })).password).toBe('box-Sekrit');
    expect((await run({ op: 'revert', id: id!, changedAt: 5000 })).problem).toBe('refused');
    expect((await run({ op: 'reveal', id: id! })).password).toBe('box-Sekrit');
    expect((await run({ op: 'revert', id: 'gone', changedAt: 5000 })).problem).toBe('missing');
    // Edited in Settings, it stays the box's.
    await run({ op: 'edit', id: id!, patch: { note: 'the router' } });
    expect((await run({ op: 'list', chordId: null })).logins!.find((l) => l.id === id)!.realm).toBe('Router admin');
  });
});

describe('generated passwords (S17 §6, phase 2): saved when filled, Not confirmed until a submit works', () => {
  const SITE = 'https://example.com';
  const GENERATED = 'Gen3rated-Pa55word-x';
  const presave = async (origin = SITE) => {
    if ((await run({ op: 'status' })).status!.state === 'none') await run({ op: 'setup', passphrase: PASSPHRASE });
    const saved = await run({ op: 'presave', origin, password: GENERATED, chordId: 'work' }, 1000);
    expect(saved.problem).toBeUndefined();
    return saved.id!;
  };
  const listed = async (id: string) => (await run({ op: 'list', chordId: null })).logins!.find((l) => l.id === id);

  it('presaves with no username, marked unconfirmed, sealed like any other', async () => {
    const id = await presave();
    expect(await listed(id)).toMatchObject({ origin: SITE, username: '', unconfirmed: true, realm: null });
    expect((await run({ op: 'reveal', id })).password).toBe(GENERATED);
    // A page's form fills from it, as from any sign-in.
    expect((await run({ op: 'fill', id, origin: SITE, chordId: null })).password).toBe(GENERATED);
  });

  it('presaves on a site you said never to save for: generating is asking', async () => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    await run({ op: 'never', origin: SITE });
    expect((await run({ op: 'presave', origin: SITE, password: GENERATED, chordId: null })).id).toBeDefined();
  });

  it('takes its username at the submit, still unconfirmed; then a submit that worked confirms it', async () => {
    const id = await presave();
    expect((await run({ op: 'pending', id, origin: SITE, username: 'ada@example.com' })).id).toBe(id);
    expect(await listed(id)).toMatchObject({ username: 'ada@example.com', unconfirmed: true });
    expect((await run({ op: 'confirm', id, origin: SITE, username: 'ada@example.com', password: GENERATED })).id).toBe(id);
    const login = await listed(id);
    expect(login!.username).toBe('ada@example.com');
    expect(login!.unconfirmed).toBeUndefined();
    // Confirmed, it's changed only by Save or Settings.
    expect((await run({ op: 'pending', id, origin: SITE, username: 'grace' })).problem).toBe('refused');
    expect((await run({ op: 'confirm', id, origin: SITE })).problem).toBe('refused');
  });

  it('a password typed over the generated one, before the submit, replaces it and keeps it as the one before', async () => {
    const id = await presave();
    await run({ op: 'pending', id, origin: SITE, password: 'typed-instead' }, 2000);
    expect((await run({ op: 'reveal', id })).password).toBe('typed-instead');
  });

  it('is changed only for its own site, and only a form sign-in', async () => {
    const id = await presave();
    expect((await run({ op: 'pending', id, origin: 'https://example.org', username: 'x' })).problem).toBe('refused');
    expect((await run({ op: 'confirm', id, origin: 'https://example.org' })).problem).toBe('refused');
    expect((await run({ op: 'pending', id: 'nope', origin: SITE, username: 'x' })).problem).toBe('missing');
    expect(await listed(id)).toMatchObject({ username: '', unconfirmed: true });
  });

  it('a save over it (a sign-in that worked, an update card) confirms it', async () => {
    const id = await presave();
    await run({ op: 'save', origin: SITE, username: 'ada', password: GENERATED, chordId: null, replace: id });
    expect((await listed(id))!.unconfirmed).toBeUndefined();
  });

  it('is never in the clear in chord.db, nor whether it’s confirmed', async () => {
    const id = await presave();
    await run({ op: 'pending', id, origin: SITE, username: 'pending-user@example.com' });
    expect((raw().prepare('PRAGMA table_info(login)').all() as { name: string }[]).map((c) => c.name)).toEqual(['id', 'site_tag', 'sealed', 'created_at', 'updated_at']);
    db.close();
    db = new ChordDatabase(file, 'linux', KDF);
    for (const name of readdirSync(dir).filter((n) => n.startsWith('chord.db'))) {
      const bytes = readFileSync(join(dir, name));
      for (const secret of [GENERATED, 'pending-user', 'unconfirmed']) expect(bytes.includes(Buffer.from(secret, 'utf8')), `${secret} in ${name}`).toBe(false);
    }
  });

  it('finds a change form’s account by its current password: one, several, or none', async () => {
    await run({ op: 'setup', passphrase: PASSPHRASE });
    const a = (await run({ op: 'add', login: { origin: SITE, username: 'ada', password: 'shared-old' }, chordId: null })).id!;
    const b = (await run({ op: 'add', login: { origin: 'https://login.example.com', username: 'bob', password: 'shared-old' }, chordId: null })).id!;
    await run({ op: 'add', login: { origin: SITE, username: 'cy', password: 'other' }, chordId: null });
    await run({ op: 'add', login: { origin: 'https://example.org', username: 'dee', password: 'shared-old' }, chordId: null });
    await run({ op: 'save', origin: SITE, realm: 'Box', username: 'eve', password: 'shared-old', chordId: null });
    const match = async (current: string) => (await run({ op: 'matchCurrent', origin: SITE, current })).logins!.map((l) => l.id).sort();
    // Another host of the site counts; another site and the browser's own box don't.
    expect(await match('shared-old')).toEqual([a, b].sort());
    expect(await match('other')).toHaveLength(1);
    expect(await match('nobody-has-this')).toEqual([]);
    expect(JSON.stringify((await run({ op: 'matchCurrent', origin: SITE, current: 'shared-old' })).logins)).not.toContain('shared-old');
  });
});
