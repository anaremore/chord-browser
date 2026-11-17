/**
 * Passwords in and out, chord-data's side (docs/decisions/S17-passwords.md
 * §10, §13 layer 4): a staged file against the vault (open, locked, none),
 * the import as chosen, its Undo, a lock part way, the same file again, the
 * CSV export read back, the `login` records' pages, and 5,000 rows timed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginFromRecord, PasswordCsv, type ImportedLogin, type PasswordImportChoices } from '@chord/core';
import { ChordDatabase } from '../src/db';
import type { PasswordOp, PasswordResult } from '../src/passwords';

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';
const NOW = 1_800_000_000_000;

let dir: string;
let db: ChordDatabase;
const run = (op: PasswordOp, now = NOW): Promise<PasswordResult> => db.passwords.run(op, now);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-password-transfer-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = (origin: string, username: string, password: string, extra: Partial<ImportedLogin> = {}): ImportedLogin => ({ origin, username, password, note: '', realm: null, changedAt: null, ...extra });

async function vault(...logins: [string, string, string][]): Promise<string[]> {
  await run({ op: 'setup', passphrase: PASSPHRASE });
  const ids: string[] = [];
  for (const [origin, username, password] of logins) ids.push((await run({ op: 'add', login: { origin, username, password }, chordId: null }, NOW - 1000)).id!);
  return ids;
}

let stages = 0;
/** A file staged as the import process sends it, in batches. */
function stage(logins: ImportedLogin[], extra: Parameters<ChordDatabase['passwords']['transfer']['staged']>[1] = {}): string {
  const stageId = `stage-${++stages}`;
  for (let at = 0; at < logins.length; at += 100) expect(db.passwords.transfer.staged(stageId, { logins: logins.slice(at, at + 100) })).toEqual({ ok: true });
  db.passwords.transfer.staged(stageId, { ...extra, done: { problem: null } });
  return stageId;
}

/** What the vault holds now, opened: origin, username, password, note. */
async function contents(): Promise<string[]> {
  const { logins } = await run({ op: 'list', chordId: null });
  const out: string[] = [];
  for (const l of logins!) out.push(`${l.origin} ${l.username} ${(await run({ op: 'reveal', id: l.id })).password} ${l.note}`.trim());
  return out.sort();
}

const choose = (take: PasswordImportChoices['take'], except: number[] = []): PasswordImportChoices => ({ take, except });

describe('the preview', () => {
  it('open: new, the same, and different, by address and username; never a password', async () => {
    await vault(['https://a.example', 'ada', 'same'], ['https://b.example', 'ada', 'old']);
    const stageId = stage([login('https://a.example', 'ada', 'same'), login('https://b.example', 'ada', 'new-Sekrit'), login('https://c.example', 'ada', 'x'), login('https://c.example', 'ada', 'y')], {
      issues: [{ row: 9, kind: 'app', address: 'android://x', username: 'ada', name: '' }],
      counts: { otp: 2 },
    });
    const { importPreview } = await run({ op: 'importPreview', stageId });
    expect(importPreview).toMatchObject({ state: 'open', problem: null, logins: 3, added: 1, same: 1, different: 1, duplicates: 1, otp: 2, conflictsMore: 0, issuesMore: 0 });
    expect(importPreview!.conflicts).toEqual([{ at: 1, origin: 'https://b.example', username: 'ada', realm: null, what: ['password'] }]);
    expect(importPreview!.issues).toHaveLength(1);
    expect(JSON.stringify(importPreview)).not.toMatch(/Sekrit|old/);
  });

  it('locked: the file’s own counts only, nothing compared', async () => {
    await vault(['https://a.example', 'ada', 'same']);
    await run({ op: 'lock' });
    const { importPreview } = await run({ op: 'importPreview', stageId: stage([login('https://a.example', 'ada', 'same')]) });
    expect(importPreview).toMatchObject({ state: 'locked', logins: 1, added: 0, same: 0, different: 0 });
  });

  it('no vault yet: everything is new, and Import waits for the passphrase', async () => {
    const stageId = stage([login('https://a.example', 'ada', '1'), login('https://b.example', 'ada', '2')]);
    expect((await run({ op: 'importPreview', stageId })).importPreview).toMatchObject({ state: 'none', added: 2 });
    expect((await run({ op: 'importRun', stageId, importId: 'i1', choices: choose('yours') })).problem).toBe('none');
    await run({ op: 'setup', passphrase: PASSPHRASE });
    expect((await run({ op: 'importRun', stageId, importId: 'i1', choices: choose('yours') })).imported).toMatchObject({ added: 2 });
  });

  it('a stage that isn’t done, or was let go, isn’t there', async () => {
    db.passwords.transfer.staged('half', { logins: [login('https://a.example', 'a', '1')] });
    expect((await run({ op: 'importPreview', stageId: 'half' })).problem).toBe('missing');
    const stageId = stage([login('https://a.example', 'a', '1')]);
    await run({ op: 'importDrop', stageId });
    expect((await run({ op: 'importPreview', stageId })).problem).toBe('missing');
  });

  it('an import process that went part way: nothing of it comes in', async () => {
    await vault();
    db.passwords.transfer.staged('cut', { logins: [login('https://a.example', 'a', '1')] });
    db.passwords.transfer.portClosed('cut');
    expect((await run({ op: 'importPreview', stageId: 'cut' })).importPreview).toMatchObject({ problem: 'unreadable', logins: 0 });
    expect((await run({ op: 'importRun', stageId: 'cut', importId: 'i', choices: choose('file') })).problem).toBe('missing');
  });

  it('checks what the import process sends again', async () => {
    await vault();
    const stageId = stage([
      login('https://a.example', 'ada', 'ok'),
      login('https://a.example/path', 'ada', 'not an origin'),
      login('javascript:alert(1)', 'ada', 'x'),
      login('https://b.example', 'ada', ''),
      login('https://c.example', 'u'.repeat(501), 'x'),
      { ...login('https://d.example', 'ada', 'x'), realm: 5 as unknown as string },
    ]);
    expect((await run({ op: 'importPreview', stageId })).importPreview).toMatchObject({ logins: 1, skipped: 5 });
  });
});

describe('what the import process sends, checked again (a security review)', () => {
  it('junk is refused, never thrown on; listed rows are cut and typed; an unknown problem reads as unreadable', async () => {
    const transfer = db.passwords.transfer;
    for (const junk of [null, 7, 'x', { logins: 'no' }, { logins: [null, 3, { origin: 5 }] }, { issues: [null, { row: 'a', kind: 'app' }, { row: 2, kind: 'evil' }] }])
      expect(() => transfer.staged('junk', junk as never)).not.toThrow();
    transfer.staged('junk', { issues: [{ row: 3, kind: 'app', address: 'a'.repeat(10_000), username: { evil: true } as never, name: 'n' }] });
    transfer.staged('junk', { logins: [login('https://a.example', 'a', '1', { changedAt: 9e15 })], done: { problem: 'whatever' as never } });
    const { importPreview } = await run({ op: 'importPreview', stageId: 'junk' });
    expect(importPreview!.problem).toBe('unreadable');
    expect(importPreview!.issues).toEqual([{ row: 3, kind: 'app', address: `${'a'.repeat(199)}…`, username: '', name: 'n' }]);
    // A change time past the year 9999 isn't one.
    expect(importPreview!.logins).toBe(0);
  });

  it('a lock lets a staged file go: its passwords leave memory', async () => {
    await vault();
    const stageId = stage([login('https://a.example', 'a', '1')]);
    await run({ op: 'lock' });
    await run({ op: 'unlock', passphrase: PASSPHRASE });
    expect((await run({ op: 'importPreview', stageId })).problem).toBe('missing');
  });

  it('a failure part way (a full disk) keeps what landed, with its Undo', async () => {
    await vault();
    const vaultAccess = (db.passwords.transfer as unknown as { vault: { transaction(work: () => void): void } }).vault;
    const real = vaultAccess.transaction.bind(vaultAccess);
    let slices = 0;
    vaultAccess.transaction = (work) => {
      if (++slices === 3) throw Object.assign(new Error('database or disk is full: Sekrit'), { name: 'SqliteError' });
      real(work);
    };
    // Rows whose writes take long enough for several slices.
    const file = Array.from({ length: 3000 }, (_, i) => login(`https://s${i}.example`, 'ada', `p${i}`));
    const { imported } = await run({ op: 'importRun', stageId: stage(file), importId: 'i1', choices: choose('yours') });
    vaultAccess.transaction = real;
    expect(imported!.stopped).toBe(true);
    const count = (await run({ op: 'status' })).status!.count;
    expect(count).toBeGreaterThan(0);
    expect((await run({ op: 'importUndo', importId: 'i1' })).undone!.removed).toBe(count);
    expect((await run({ op: 'status' })).status!.count).toBe(0);
  });
});

describe('the import', () => {
  it('as chosen: new ones in, yours kept or the file’s taken (the one before kept), the same untouched', async () => {
    const [, b, c] = await vault(['https://a.example', 'ada', 'same'], ['https://b.example', 'ada', 'old-b'], ['https://c.example', 'ada', 'old-c']);
    const file = [login('https://a.example', 'ada', 'same'), login('https://b.example', 'ada', 'new-b', { note: 'from the file' }), login('https://c.example', 'ada', 'new-c'), login('https://d.example', 'ada', 'd', { realm: 'Admin' })];
    const stageId = stage(file);
    // Keep yours, except c (place 2 in the file).
    const { imported } = await run({ op: 'importRun', stageId, importId: 'i1', choices: choose('yours', [2]) });
    expect(imported).toEqual({ added: 1, updated: 1, kept: 1, same: 1, stopped: false });
    expect(await contents()).toEqual(['https://a.example ada same', 'https://b.example ada old-b', 'https://c.example ada new-c', 'https://d.example ada d'].sort());
    // The one replaced keeps the one before it, as an update does.
    expect((await run({ op: 'revert', id: c!, changedAt: NOW })).id).toBe(c);
    expect((await run({ op: 'reveal', id: c! })).password).toBe('old-c');
    expect((await run({ op: 'reveal', id: b! })).password).toBe('old-b');
    // A sign-in box's realm came in with it.
    expect((await run({ op: 'list', chordId: null })).logins!.find((l) => l.origin === 'https://d.example')?.realm).toBe('Admin');
    // The file's passwords left memory with the import.
    expect((await run({ op: 'importPreview', stageId })).problem).toBe('missing');
  });

  it('take the file’s: its note too when it has one', async () => {
    await vault(['https://b.example', 'ada', 'old-b']);
    await run({ op: 'importRun', stageId: stage([login('https://b.example', 'ada', 'new-b', { note: 'n' })]), importId: 'i', choices: choose('file') });
    expect(await contents()).toEqual(['https://b.example ada new-b n']);
  });

  it('a Chord file’s change time is kept', async () => {
    await vault();
    await run({ op: 'importRun', stageId: stage([login('https://a.example', 'ada', 'x', { changedAt: 1234 })]), importId: 'i', choices: choose('yours') });
    const id = (await run({ op: 'list', chordId: null })).logins![0]!.id;
    expect(db.passwords.transfer.exportPage('', 10, db.passwords.transfer.generation())!.records[0]!.set['changed']).toBe(1234);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the same file again: everything is already saved, and nothing is written', async () => {
    await vault();
    const file = [login('https://a.example', 'ada', '1'), login('https://b.example', 'bo', '2')];
    await run({ op: 'importRun', stageId: stage(file), importId: 'i1', choices: choose('yours') });
    const again = stage(file);
    expect((await run({ op: 'importPreview', stageId: again })).importPreview).toMatchObject({ added: 0, same: 2, different: 0 });
    expect((await run({ op: 'importRun', stageId: again, importId: 'i2', choices: choose('file') })).imported).toEqual({ added: 0, updated: 0, kept: 0, same: 2, stopped: false });
    expect((await run({ op: 'importUndo', importId: 'i2' })).problem).toBe('missing');
  });

  it('locked part way: it stops, and what landed has its Undo', async () => {
    await vault();
    const file = Array.from({ length: 1000 }, (_, i) => login(`https://s${i}.example`, 'ada', `p${i}`));
    const going = run({ op: 'importRun', stageId: stage(file), importId: 'i1', choices: choose('yours') });
    while ((await run({ op: 'status' })).status!.count === 0) await new Promise((resolve) => setImmediate(resolve));
    await run({ op: 'lock' });
    const { imported } = await going;
    expect(imported!.stopped).toBe(true);
    expect(imported!.added).toBeGreaterThan(0);
    expect(imported!.added).toBeLessThan(1000);
    // Undo needs no key.
    expect((await run({ op: 'importUndo', importId: 'i1' })).undone).toEqual({ removed: imported!.added, restored: 0, changed: 0 });
    expect((await run({ op: 'status' })).status!.count).toBe(0);
  });

  it('locked before it begins: nothing', async () => {
    await vault();
    await run({ op: 'lock' });
    expect((await run({ op: 'importRun', stageId: stage([login('https://a.example', 'a', '1')]), importId: 'i', choices: choose('yours') })).problem).toBe('locked');
  });

  it('one import at a time from a stage, and an import id once', async () => {
    await vault();
    const stageId = stage([login('https://a.example', 'a', '1')]);
    const first = run({ op: 'importRun', stageId, importId: 'i1', choices: choose('yours') });
    expect((await run({ op: 'importRun', stageId, importId: 'i2', choices: choose('yours') })).problem).toBe('refused');
    await first;
    expect((await run({ op: 'importRun', stageId: stage([login('https://b.example', 'a', '1')]), importId: 'i1', choices: choose('yours') })).problem).toBe('refused');
  });
});

describe('Undo', () => {
  it('takes away what came in and puts back what was replaced, sealed as it was', async () => {
    const [b] = await vault(['https://b.example', 'ada', 'old-b']);
    const before = db.passwords.transfer.exportPage('', 10, db.passwords.transfer.generation())!.records;
    await run({ op: 'importRun', stageId: stage([login('https://a.example', 'ada', 'a'), login('https://b.example', 'ada', 'new-b')]), importId: 'i1', choices: choose('file') });
    expect((await run({ op: 'importUndo', importId: 'i1' })).undone).toEqual({ removed: 1, restored: 1, changed: 0 });
    expect(await contents()).toEqual(['https://b.example ada old-b']);
    expect(db.passwords.transfer.exportPage('', 10, db.passwords.transfer.generation())!.records).toEqual(before);
    expect((await run({ op: 'reveal', id: b! })).password).toBe('old-b');
    // Once.
    expect((await run({ op: 'importUndo', importId: 'i1' })).problem).toBe('missing');
  });

  it('leaves what you changed since, and says so', async () => {
    await vault(['https://b.example', 'ada', 'old-b']);
    await run({ op: 'importRun', stageId: stage([login('https://a.example', 'ada', 'a'), login('https://b.example', 'ada', 'new-b')]), importId: 'i1', choices: choose('file') });
    const { logins } = await run({ op: 'list', chordId: null });
    for (const l of logins!) await run({ op: 'edit', id: l.id, patch: { note: 'mine now' } }, NOW + 5000);
    expect((await run({ op: 'importUndo', importId: 'i1' })).undone).toEqual({ removed: 0, restored: 0, changed: 2 });
    expect(await contents()).toEqual(['https://a.example ada a mine now', 'https://b.example ada new-b mine now']);
  });

  it('goes with Start over, and with chord-data', async () => {
    await vault();
    await run({ op: 'importRun', stageId: stage([login('https://a.example', 'ada', 'a')]), importId: 'i1', choices: choose('yours') });
    await run({ op: 'lock' });
    await run({ op: 'startOver' });
    expect((await run({ op: 'importUndo', importId: 'i1' })).problem).toBe('missing');
  });
});

describe('export', () => {
  it('a CSV in Chrome’s shape that reads back as the vault, sorted by site', async () => {
    await vault(['https://www.b.example', 'ada', 'p,"b"\nx'], ['http://10.0.0.1:8080', '', '=1+1'], ['https://a.example', 'bo', 'a']);
    const path = join(dir, 'Chord passwords.csv');
    expect((await run({ op: 'exportCsv', path })).exported).toEqual({ count: 3, unreadable: 0 });
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n')[0]).toBe('name,url,username,password,note');
    const csv = new PasswordCsv();
    const logins = [...csv.push(text).logins, ...csv.end().logins];
    expect(logins.map((l) => `${l.origin} ${l.username} ${l.password}`)).toEqual(['http://10.0.0.1:8080  =1+1', 'https://a.example bo a', 'https://www.b.example ada p,"b"\nx']);
  });

  it('locked, or no vault: nothing written', async () => {
    const path = join(dir, 'out.csv');
    expect((await run({ op: 'exportCsv', path })).problem).toBe('none');
    await vault(['https://a.example', 'a', '1']);
    await run({ op: 'lock' });
    expect((await run({ op: 'exportCsv', path })).problem).toBe('locked');
    expect(() => readFileSync(path)).toThrow();
  });

  it('login records a page at a time, round trip; none once locked since', async () => {
    await vault(...Array.from({ length: 7 }, (_, i): [string, string, string] => [`https://s${i}.example`, `u${i}`, `p${i}`]));
    const generation = db.passwords.transfer.generation();
    const records = [];
    for (let after = ''; ; ) {
      const page = db.passwords.transfer.exportPage(after, 3, generation)!;
      records.push(...page.records);
      if (page.last === null) break;
      after = page.last;
    }
    expect(records).toHaveLength(7);
    const stageId = stage(records.map((r) => loginFromRecord(JSON.parse(JSON.stringify(r)))!));
    expect((await run({ op: 'importPreview', stageId })).importPreview).toMatchObject({ same: 7, added: 0 });
    await run({ op: 'lock' });
    await run({ op: 'unlock', passphrase: PASSPHRASE });
    expect(db.passwords.transfer.exportPage('', 3, generation)).toBeNull();
  });
});

/**
 * The size S17 measures (5,000 rows into a vault of 500) with CHORD_PASSWORD_PERF=1; a tenth of it otherwise, so
 * the suite's other timed tests, running beside it, aren't starved of CPU.
 */
const BIG = process.env['CHORD_PASSWORD_PERF'] === '1' ? 5000 : 500;
const SAVED = BIG / 10;

describe(`${BIG} rows`, () => {
  it('compared and written in slices, none long', { timeout: 60_000 }, async () => {
    await vault(...Array.from({ length: SAVED }, (_, i): [string, string, string] => [`https://s${i}.example`, 'ada', i % 2 ? `p${i}` : 'old']));
    const file = Array.from({ length: BIG }, (_, i) => login(`https://s${i}.example`, 'ada', `p${i}`, { note: 'imported' }));
    const stageId = stage(file);
    // The longest stretch chord-data's thread is held: the gaps between turns of a loop that yields as often as it can.
    let longest = 0;
    let last = performance.now();
    let watching = true;
    const watch = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (watching) setImmediate(watch);
    };
    setImmediate(watch);
    const t0 = performance.now();
    const { importPreview } = await run({ op: 'importPreview', stageId });
    const t1 = performance.now();
    const { imported } = await run({ op: 'importRun', stageId, importId: 'big', choices: choose('file') });
    const t2 = performance.now();
    watching = false;
    // The file's note differs from every saved one's: all 500 differ, the half with the same password by their note.
    expect(importPreview).toMatchObject({ added: BIG - SAVED, same: 0, different: SAVED });
    expect(imported).toEqual({ added: BIG - SAVED, updated: SAVED, kept: 0, same: 0, stopped: false });
    console.log(`${BIG} rows: preview ${(t1 - t0).toFixed(0)} ms, import ${(t2 - t1).toFixed(0)} ms, longest task ${longest.toFixed(1)} ms`);
    // A generous bound for CI's machines; the number above is what the PR reports.
    expect(longest).toBeLessThan(1000);
    const undo0 = performance.now();
    expect((await run({ op: 'importUndo', importId: 'big' })).undone).toEqual({ removed: BIG - SAVED, restored: SAVED, changed: 0 });
    console.log(`${BIG} rows: undo ${(performance.now() - undo0).toFixed(0)} ms`);
  });
});
