/**
 * Passwords in and out, main's side (docs/decisions/S17-passwords.md §10):
 * the gates (busy, no vault, locked, the passphrase as *Show* asks for it),
 * the toast and its Undo, and what Settings is given, against a real
 * chord-data vault. The import process is stood in for by reading the CSV
 * with core's PasswordCsv and staging it as the process does.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordCsv } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import type { PasswordImportProgress, Toast } from '@chord/ipc';

const shown: string[] = [];
vi.mock('electron', () => ({ dialog: {}, shell: { showItemInFolder: (path: string) => shown.push(path) } }));

const { PasswordTransfers } = await import('../../src/main/passwords/transfer');
const { ImportGate } = await import('../../src/main/import');

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';

let dir: string;
let db: ChordDatabase;
let typedRecently: boolean;
let toasts: { windowId: string; toast: Toast }[];
let gate: InstanceType<typeof ImportGate>;
let openPaths: string[] | null;
let savePath: string | null;

const csv = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

function transfers(data: (op: Parameters<ChordDatabase['passwords']['run']>[0]) => ReturnType<ChordDatabase['passwords']['run']> = (op) => db.passwords.run(op)) {
  return new PasswordTransfers({
    workerPath: 'unused',
    data,
    stagePort: async (stageId) => ({ stageId }) as never,
    exportPort: async () => ({ port: true }) as never,
    vault: {
      vaultState: async () => (await db.passwords.run({ op: 'status' })).status!.state,
      confirm: async (passphrase) => {
        const state = (await db.passwords.run({ op: 'status' })).status!.state;
        if (state !== 'open') return { ok: false, problem: 'locked' };
        if (typedRecently) return null;
        if (passphrase === undefined) return { ok: false, problem: 'passphrase' };
        if ((await db.passwords.run({ op: 'verify', passphrase })).problem) return { ok: false, problem: 'wrong' };
        typedRecently = true;
        return null;
      },
      transferred: () => undefined,
      setup: async (passphrase) => {
        const r = await db.passwords.run({ op: 'setup', passphrase });
        return r.problem ? { ok: false, problem: 'invalid' } : ({ ok: true, view: {} } as never);
      },
    },
    gate,
    folder: () => dir,
    openDialog: async () => (openPaths ? { canceled: false, filePaths: openPaths } : { canceled: true, filePaths: [] }),
    saveDialog: async () => (savePath ? { canceled: false, filePath: savePath } : { canceled: true }),
    // The import process: the file read with PasswordCsv and staged on the port's stage, as src/import-file does.
    startProcess: async () => {
      let replied: unknown = null;
      return {
        send: (request, ports) => {
          if (request.type !== 'passwords') return;
          const { stageId } = ports![0] as unknown as { stageId: string };
          const reader = new PasswordCsv();
          const read = [reader.push(readFileSync(request.path, 'utf8')), reader.end()];
          for (const { logins, issues } of read) db.passwords.transfer.staged(stageId, { logins, issues });
          db.passwords.transfer.staged(stageId, { source: reader.source, counts: { rows: reader.counts.rows, otp: reader.counts.otp }, done: { problem: reader.problem } });
          replied = { type: 'passwords', problem: reader.problem };
        },
        next: async () => replied as never,
        end: () => undefined,
      };
    },
    toast: (windowId, toast) => toasts.push({ windowId: String(windowId), toast }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-passwords-transfer-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
  typedRecently = true;
  toasts = [];
  gate = new ImportGate();
  openPaths = null;
  savePath = null;
  shown.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const CHROME = 'name,url,username,password,note\nexample.com,https://example.com/,ada,Sekrit-1,\nshop.example,https://shop.example/,ada,Sekrit-2,\nrouter,android://x@com.example,ada,Sekrit-3,\n';

describe('Import…', () => {
  it('reads, stages and previews; nothing of a password reaches Settings', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    await db.passwords.run({ op: 'add', login: { origin: 'https://example.com', username: 'ada', password: 'old' }, chordId: null });
    openPaths = [csv('Chrome Passwords.csv', CHROME)];
    const opened = await transfers().choose(null);
    expect(opened).toMatchObject({ ok: true, name: 'Chrome Passwords.csv', preview: { state: 'open', source: 'chrome', rows: 3, logins: 2, added: 1, different: 1 } });
    expect(JSON.stringify(opened)).not.toContain('Sekrit');
  });

  const gates: { what: string; setup(): Promise<void> | void; run?: { passphrase?: string }; want: unknown }[] = [
    { what: 'the dialog closed', setup: () => void (openPaths = null), want: { ok: false, problem: 'cancelled' } },
    { what: 'another import running', setup: () => void gate.take('other'), want: { ok: false, problem: 'busy' } },
  ];
  for (const g of gates) {
    it(`choose: ${g.what}`, async () => {
      openPaths = [csv('a.csv', CHROME)];
      await g.setup();
      expect(await transfers().choose(null)).toEqual(g.want);
    });
  }

  const runs: { what: string; vault: 'none' | 'locked' | 'open'; passphrase?: string; want: object }[] = [
    { what: 'no vault, no passphrase: choose one first', vault: 'none', want: { ok: false, problem: 'none' } },
    { what: 'no vault, the first passphrase: made, then imported', vault: 'none', passphrase: PASSPHRASE, want: { ok: true, result: { added: 2 } } },
    { what: 'locked: unlock first', vault: 'locked', want: { ok: false, problem: 'locked' } },
    { what: 'open', vault: 'open', want: { ok: true, result: { added: 2, updated: 0 } } },
  ];
  for (const r of runs) {
    it(`run: ${r.what}`, async () => {
      if (r.vault !== 'none') await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
      if (r.vault === 'locked') await db.passwords.run({ op: 'lock' });
      openPaths = [csv('a.csv', CHROME)];
      const t = transfers();
      const opened = await t.choose(null);
      if (!opened.ok) throw new Error('not opened');
      expect(await t.run(opened.stageId, { take: 'yours', except: [] }, r.passphrase)).toMatchObject(r.want);
    });
  }

  it('a stage Chord didn’t make, or one already imported, is missing', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    const t = transfers();
    expect(await t.run('019a0000-0000-7000-8000-000000000000', { take: 'yours', except: [] })).toEqual({ ok: false, problem: 'missing' });
    openPaths = [csv('a.csv', CHROME)];
    const opened = await t.choose(null);
    if (!opened.ok) throw new Error('not opened');
    await t.run(opened.stageId, { take: 'yours', except: [] });
    expect(await t.run(opened.stageId, { take: 'yours', except: [] })).toEqual({ ok: false, problem: 'missing' });
    expect(await t.preview(opened.stageId)).toBeNull();
  });

  it('the toast says what came in; its Undo (the shell’s import.undo) takes it back and tells Settings', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    openPaths = [csv('a.csv', CHROME)];
    const t = transfers();
    const opened = await t.choose(null);
    if (!opened.ok) throw new Error('not opened');
    const told: PasswordImportProgress[] = [];
    const run = await t.run(opened.stageId, { take: 'yours', except: [] }, undefined, { windowId: 3 as never, notify: (p) => told.push(p) });
    if (!run.ok || !run.importId) throw new Error('not imported');
    expect(toasts.at(-1)).toEqual({ windowId: '3', toast: { id: `import:${run.importId}`, message: 'Imported 2 passwords', action: { label: 'Undo', command: { t: 'import.undo', importId: run.importId } } } });
    expect(t.owns(run.importId)).toBe(true);
    expect(await t.undo(run.importId)).toEqual({ ok: true, undone: { removed: 2, restored: 0, changed: 0 } });
    expect(toasts.at(-1)!.toast.message).toBe('Import undone');
    expect(told.at(-1)).toMatchObject({ phase: 'undone', importId: run.importId });
    expect(t.owns(run.importId)).toBe(false);
    expect((await db.passwords.run({ op: 'status' })).status!.count).toBe(0);
  });

  it('an Undo that fails is kept, says so, and goes through when tried again; one at a time', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    openPaths = [csv('a.csv', CHROME)];
    let failNext = false;
    const t = transfers(async (op) => {
      if (op.op === 'importUndo' && failNext) {
        failNext = false;
        throw new Error('SqliteError');
      }
      return db.passwords.run(op);
    });
    const opened = await t.choose(null);
    if (!opened.ok) throw new Error('not opened');
    const run = await t.run(opened.stageId, { take: 'yours', except: [] }, undefined, { windowId: 4 as never, notify: null });
    if (!run.ok || !run.importId) throw new Error('not imported');
    failNext = true;
    expect(await t.undo(run.importId)).toEqual({ ok: false, problem: 'failed' });
    // Still the import's: the toast offers it again.
    expect(t.owns(run.importId)).toBe(true);
    expect(toasts.at(-1)!.toast).toMatchObject({ message: 'Chord couldn’t undo all of the import', action: { label: 'Try again', command: { t: 'import.undo', importId: run.importId } } });
    // Two at once (the card's and the toast's): one goes, the other is told it's busy.
    const [first, second] = await Promise.all([t.undo(run.importId), t.undo(run.importId)]);
    expect([first, second]).toContainEqual({ ok: false, problem: 'busy' });
    expect([first, second]).toContainEqual({ ok: true, undone: { removed: 2, restored: 0, changed: 0 } });
    expect(t.owns(run.importId)).toBe(false);
    expect(await t.undo(run.importId)).toEqual({ ok: false, problem: 'missing' });
    expect((await db.passwords.run({ op: 'status' })).status!.count).toBe(0);
  });

  it('an Undo chord-data no longer knows (it started again) is forgotten, not offered for ever', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    openPaths = [csv('a.csv', CHROME)];
    const t = transfers(async (op) => (op.op === 'importUndo' ? { problem: 'missing' } : db.passwords.run(op)));
    const opened = await t.choose(null);
    if (!opened.ok) throw new Error('not opened');
    const run = await t.run(opened.stageId, { take: 'yours', except: [] }, undefined, { windowId: 4 as never, notify: null });
    if (!run.ok || !run.importId) throw new Error('not imported');
    expect(await t.undo(run.importId)).toEqual({ ok: false, problem: 'missing' });
    expect(t.owns(run.importId)).toBe(false);
    expect(toasts.at(-1)!.toast).toEqual({ id: `import:${run.importId}`, message: 'Chord can’t undo that import any more' });
  });

  it('nothing new: no toast, no Undo', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    for (const [origin, password] of [['https://example.com', 'Sekrit-1'], ['https://shop.example', 'Sekrit-2']]) await db.passwords.run({ op: 'add', login: { origin: origin!, username: 'ada', password: password! }, chordId: null });
    openPaths = [csv('a.csv', CHROME)];
    const t = transfers();
    const opened = await t.choose(null);
    if (!opened.ok) throw new Error('not opened');
    expect(await t.run(opened.stageId, { take: 'file', except: [] }, undefined, { windowId: 1 as never, notify: null })).toMatchObject({ ok: true, importId: null, result: { same: 2 } });
    expect(toasts).toEqual([]);
  });
});

describe('Export…', () => {
  const cases: { what: string; vault: 'none' | 'open' | 'locked' | 'empty'; typed: boolean; passphrase?: string; save: boolean; want: object }[] = [
    { what: 'no vault', vault: 'none', typed: true, save: true, want: { ok: false, problem: 'none' } },
    { what: 'locked', vault: 'locked', typed: true, save: true, want: { ok: false, problem: 'locked' } },
    { what: 'nothing saved', vault: 'empty', typed: true, save: true, want: { ok: false, problem: 'empty' } },
    { what: 'the passphrase not typed lately: asked for', vault: 'open', typed: false, save: true, want: { ok: false, problem: 'passphrase' } },
    { what: 'the wrong passphrase', vault: 'open', typed: false, passphrase: 'not it at all, sorry', save: true, want: { ok: false, problem: 'wrong' } },
    { what: 'the passphrase typed now', vault: 'open', typed: false, passphrase: PASSPHRASE, save: true, want: { ok: true, count: 1 } },
    { what: 'typed lately', vault: 'open', typed: true, save: true, want: { ok: true, count: 1, name: 'out.csv' } },
    { what: 'the save dialog closed', vault: 'open', typed: true, save: false, want: { ok: false, problem: 'cancelled' } },
  ];
  for (const c of cases) {
    it(c.what, async () => {
      if (c.vault !== 'none') await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
      if (c.vault === 'open' || c.vault === 'locked') await db.passwords.run({ op: 'add', login: { origin: 'https://example.com', username: 'ada', password: 'Sekrit-1' }, chordId: null });
      if (c.vault === 'locked') await db.passwords.run({ op: 'lock' });
      typedRecently = c.typed;
      savePath = c.save ? join(dir, 'out.csv') : null;
      const t = transfers();
      const result = await t.exportCsv(null, c.passphrase);
      expect(result).toMatchObject(c.want);
      if (result.ok) {
        expect(readFileSync(savePath!, 'utf8')).toBe('name,url,username,password,note\nexample.com,https://example.com/,ada,Sekrit-1,\n');
        t.show(result.exportId);
        expect(shown).toEqual([savePath]);
      }
    });
  }

  it('an encrypted Chord file’s port: the same check first', async () => {
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    typedRecently = false;
    const t = transfers();
    expect(await t.exportPort()).toEqual({ problem: 'passphrase' });
    expect(await t.exportPort('not it at all, sorry')).toEqual({ problem: 'wrong' });
    expect(await t.exportPort(PASSPHRASE)).toHaveProperty('port');
    await db.passwords.run({ op: 'lock' });
    expect(await t.exportPort()).toEqual({ problem: 'locked' });
  });
});

describe('for Your data’s export', () => {
  it('counts without opening the vault, and tells the vault’s passphrase from another', async () => {
    const t = transfers();
    expect(await t.count()).toBe(0);
    expect(await t.isVaultPassphrase(PASSPHRASE)).toBe(false);
    await db.passwords.run({ op: 'setup', passphrase: PASSPHRASE });
    await db.passwords.run({ op: 'add', login: { origin: 'https://example.com', username: 'ada', password: 'Sekrit-1' }, chordId: null });
    await db.passwords.run({ op: 'lock' });
    expect(await t.count()).toBe(1);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
    expect(await t.isVaultPassphrase(PASSPHRASE)).toBe(true);
    expect(await t.isVaultPassphrase('another passphrase entirely')).toBe(false);
    // Checking left the vault as it was.
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
  });
});
