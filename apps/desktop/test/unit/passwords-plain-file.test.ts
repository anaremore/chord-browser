/**
 * Never in a plain file (docs/decisions/S17-passwords.md decision 6; use cases 22, 24 and 26), table-driven at
 * each place it's held: main never asks for the passwords' port for a plain file; the export process closes any
 * port it's given unless the file is encrypted and asked for them; the import reads a `login` record only from an
 * encrypted file; and a reader that doesn't know `login` or `passwords` (an older Chord) passes over both. Also:
 * a file's passphrase is never the vault's.
 */
import { describe, expect, it, vi } from 'vitest';
import { dataHeader, loginFromFile, loginRecord, parseHeader, plainWriter, readDataFile } from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import type { ExportProgress, ExportRequest } from '@chord/ipc';

const saves: unknown[] = [];
/** Where the save dialog answers (null: closed), and the export process's replies, as the test sends them. */
let saveTo: string | null = null;
let reply: ((message: unknown) => void) | null = null;
vi.mock('electron', () => ({
  dialog: { showSaveDialog: async (...args: unknown[]) => (saves.push(args), saveTo ? { canceled: false, filePath: saveTo } : { canceled: true }) },
  shell: {},
  utilityProcess: {
    fork: () => ({
      on: (event: string, handler: (message: unknown) => void) => void (event === 'message' && (reply = handler)),
      once: () => undefined,
      postMessage: () => undefined,
      kill: () => undefined,
    }),
  },
}));

const { Exporter } = await import('../../src/main/export');
const { passwordsPort } = await import('../../src/export/passwords');
const { exportText } = await import('../../src/renderer/settings/export-text');

const FILE = 'a long passphrase for the file';
const VAULT = 'correct horse battery staple';

function exporter(asked: string[], vault = VAULT) {
  return new Exporter({
    workerPath: 'unused',
    database: 'unused',
    images: 'unused',
    app: '0.12.0',
    platform: 'linux',
    folder: () => '.',
    data: { flush: async () => undefined, device: async () => '0123456789abcdef', counts: async () => ({}) as never },
    passwords: async (vaultPassphrase) => {
      asked.push(vaultPassphrase ?? '');
      return { port: { close: () => undefined } as never };
    },
    isVaultPassphrase: async (passphrase) => passphrase === vault,
    passwordCount: async () => 3,
  });
}

describe('main: the passwords’ port, only for an encrypted file that asks for them', () => {
  const cases: { what: string; request: ExportRequest; asks: boolean; problem?: string }[] = [
    { what: 'plain, passwords asked for', request: { history: true, assistant: true, passwords: true, passphrase: null }, asks: false, problem: 'cancelled' },
    { what: 'plain, passwords alone', request: { history: false, assistant: false, passwords: true, only: 'passwords', passphrase: null }, asks: false, problem: 'cancelled' },
    { what: 'encrypted, passwords off', request: { history: true, assistant: true, passwords: false, passphrase: FILE }, asks: false, problem: 'cancelled' },
    { what: 'encrypted, passwords on', request: { history: true, assistant: true, passwords: true, passphrase: FILE }, asks: true, problem: 'cancelled' },
    { what: 'encrypted with the vault’s passphrase', request: { history: true, assistant: true, passwords: true, passphrase: VAULT }, asks: false, problem: 'vault-passphrase' },
    { what: 'passwords alone, with the vault’s passphrase', request: { history: false, assistant: false, passwords: true, only: 'passwords', passphrase: VAULT }, asks: false, problem: 'vault-passphrase' },
  ];
  for (const c of cases) {
    it(c.what, async () => {
      const asked: string[] = [];
      // The save dialog is closed in each: what matters is what was asked before it.
      const result = await exporter(asked).run(null, c.request, () => undefined);
      expect(asked.length > 0).toBe(c.asks);
      expect(result).toEqual({ ok: false, problem: c.problem });
    });
  }
});

describe('a file saved without passwords says how many were left out', () => {
  const cases: { what: string; request: ExportRequest; done: { bytes: number; skipped: number; passwords?: number }; want: { passwords?: number; passwordsLeftOut?: number } }[] = [
    { what: 'plain', request: { history: true, assistant: true, passphrase: null }, done: { bytes: 10, skipped: 0 }, want: { passwordsLeftOut: 3 } },
    { what: 'plain, passwords asked for', request: { history: true, assistant: true, passwords: true, passphrase: null }, done: { bytes: 10, skipped: 0 }, want: { passwordsLeftOut: 3 } },
    { what: 'encrypted, passwords off', request: { history: true, assistant: true, passwords: false, passphrase: FILE }, done: { bytes: 10, skipped: 0 }, want: { passwordsLeftOut: 3 } },
    { what: 'encrypted, passwords on', request: { history: true, assistant: true, passwords: true, passphrase: FILE }, done: { bytes: 10, skipped: 0, passwords: 3 }, want: { passwords: 3 } },
  ];
  for (const c of cases) {
    it(c.what, async () => {
      saveTo = 'Chord data.jsonl';
      reply = null;
      const told: ExportProgress[] = [];
      const result = await exporter([]).run(null, c.request, (p) => told.push(p));
      saveTo = null;
      expect(result.ok).toBe(true);
      reply!({ type: 'done', ...c.done });
      const done = told.find((p) => p.phase === 'done')!;
      expect({ passwords: done.passwords, passwordsLeftOut: done.passwordsLeftOut }).toEqual({ passwords: undefined, passwordsLeftOut: undefined, ...c.want });
    });
  }
});

describe('what the result line says', () => {
  const base: ExportProgress = { exportId: 'e', phase: 'done', done: 0, total: 0, share: 1, name: 'Chord data 2026-11-17.jsonl', bytes: 2_400_000 };
  it.each([
    [undefined, 'Saved Chord data 2026-11-17.jsonl, 2.4 MB'],
    [1, 'Saved Chord data 2026-11-17.jsonl, 2.4 MB. Your 1 password was left out'],
    [412, 'Saved Chord data 2026-11-17.jsonl, 2.4 MB. Your 412 passwords were left out'],
  ])('%s left out', (passwordsLeftOut, text) => expect(exportText({ ...base, ...(passwordsLeftOut !== undefined ? { passwordsLeftOut } : {}) })).toBe(text));
  it('with them', () => expect(exportText({ ...base, name: 'Chord data.chorddata', passwords: 2 })).toBe('Saved Chord data.chorddata, 2.4 MB, with 2 passwords'));
});

describe('the vault-passphrase check fails closed', () => {
  it('a check that can’t be made refuses the export', async () => {
    const asked: string[] = [];
    const e = exporter(asked);
    (e as unknown as { options: { isVaultPassphrase(p: string): Promise<boolean> } }).options.isVaultPassphrase = async () => {
      throw new Error('chord-data isn’t answering');
    };
    expect(await e.run(null, { history: true, assistant: true, passwords: true, passphrase: FILE }, () => undefined)).toEqual({ ok: false, problem: 'locked' });
    expect(asked).toEqual([]);
  });
});

describe('the export process: the port closed unread unless the file is encrypted and asked for them', () => {
  const cases: { what: string; job: { passwords: boolean; passphrase: string | null }; used: boolean }[] = [
    { what: 'plain, passwords asked for', job: { passwords: true, passphrase: null }, used: false },
    { what: 'plain', job: { passwords: false, passphrase: null }, used: false },
    { what: 'encrypted, not asked for', job: { passwords: false, passphrase: FILE }, used: false },
    { what: 'encrypted, asked for', job: { passwords: true, passphrase: FILE }, used: true },
  ];
  for (const c of cases) {
    it(c.what, () => {
      let closed = false;
      const port = { close: () => void (closed = true) };
      expect(passwordsPort(c.job, port) === port).toBe(c.used);
      expect(closed).toBe(!c.used);
    });
  }
  it('no port: nothing', () => expect(passwordsPort({ passwords: true, passphrase: FILE }, null)).toBeNull());
});

describe('the import: a `login` record only from an encrypted file', () => {
  const record = loginRecord('019a3c2e-7b1f-7c3d-9a1e-4f2b6c8d0e1a', { origin: 'https://example.com', username: 'ada', password: 'Sekrit', note: '', realm: null, changedAt: 1 }, 1);
  it.each([
    [true, 'https://example.com'],
    [false, null],
  ])('encrypted %s', (encrypted, origin) => expect(loginFromFile(record, encrypted)?.origin ?? null).toBe(origin));
});

describe('a reader that doesn’t know them passes over them (format 1 grows by additions)', () => {
  it('`passwords` in includes is read, a part Chord doesn’t know is dropped', () => {
    const header = parseHeader({ ...dataHeader({ app: '0.12.0', device: '0123456789abcdef', created: 0, includes: ['setup'] }), includes: ['setup', 'passwords', 'someday'] });
    expect(header?.includes).toEqual(['setup', 'passwords']);
  });
  it('a record of a type the reader doesn’t know is read as a record, never refused: the import passes over it', async () => {
    const writer = plainWriter(dataHeader({ app: '0.12.0', device: '0123456789abcdef', created: 0, includes: ['setup'] }));
    const chunks = [writer.head, ...writer.add({ type: 'someday', id: 'x', set: { password: 'Sekrit' } }), ...writer.add({ type: 'route', id: 'example.com', set: {} }), ...writer.end()];
    const read = await readDataFile(Buffer.concat(chunks.map((c) => Buffer.from(c))), null, nodeCrypto);
    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.type)).toEqual(['someday', 'route']);
  });
});
