/**
 * A big password import, timed (S17, Phase 2: import and export): 5,000 rows into a vault of 500 with
 * CHORD_PASSWORD_PERF=1 (CI's own step), a tenth of it otherwise. chord-data's longest task during the import is held.
 * Moved from password-transfer.test.ts (issue #85): budgets run alone, in `pnpm test:perf`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedLogin, PasswordImportChoices } from '@chord/core';
import { ChordDatabase } from '../src/db';
import type { PasswordOp, PasswordResult } from '../src/passwords';

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';
const NOW = 1_800_000_000_000;

let dir: string;
let db: ChordDatabase;
const run = (op: PasswordOp, now = NOW): Promise<PasswordResult> => db.passwords.run(op, now);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-password-perf-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = (origin: string, username: string, password: string, extra: Partial<ImportedLogin> = {}): ImportedLogin => ({ origin, username, password, note: '', realm: null, changedAt: null, ...extra });

async function vault(...logins: [string, string, string][]): Promise<void> {
  await run({ op: 'setup', passphrase: PASSPHRASE });
  for (const [origin, username, password] of logins) await run({ op: 'add', login: { origin, username, password }, chordId: null }, NOW - 1000);
}

/** A file staged as the import process sends it, in batches. */
function stage(logins: ImportedLogin[]): string {
  const stageId = 'stage-big';
  for (let at = 0; at < logins.length; at += 100) expect(db.passwords.transfer.staged(stageId, { logins: logins.slice(at, at + 100) })).toEqual({ ok: true });
  db.passwords.transfer.staged(stageId, { done: { problem: null } });
  return stageId;
}

const choose = (take: PasswordImportChoices['take']): PasswordImportChoices => ({ take, except: [] });

/**
 * The size S17 measures (5,000 rows into a vault of 500) with CHORD_PASSWORD_PERF=1; a tenth of it otherwise, so
 * `pnpm test:perf` stays quick.
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
    let turns = 0;
    let last = performance.now();
    let watching = true;
    const watch = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      turns++;
      last = now;
      if (watching) setImmediate(watch);
    };
    setImmediate(watch);
    const t0 = performance.now();
    const { importPreview } = await run({ op: 'importPreview', stageId });
    const t1 = performance.now();
    const turnsBefore = turns;
    const { imported } = await run({ op: 'importRun', stageId, importId: 'big', choices: choose('file') });
    const t2 = performance.now();
    watching = false;
    // The file's note differs from every saved one's: all 500 differ, the half with the same password by their note.
    expect(importPreview).toMatchObject({ added: BIG - SAVED, same: 0, different: SAVED });
    expect(imported).toEqual({ added: BIG - SAVED, updated: SAVED, kept: 0, same: 0, stopped: false });
    const importTurns = turns - turnsBefore;
    console.log(`${BIG} rows: preview ${(t1 - t0).toFixed(0)} ms, import ${(t2 - t1).toFixed(0)} ms, longest task ${longest.toFixed(1)} ms, ${importTurns} turns in the import`);
    const full = process.env['CHORD_PASSWORD_PERF'] === '1';
    // That it's sliced, on every runner (#230): a count, which a stalled runner can't change. The import reads the vault
    // a page (100) at a time and then writes for SLICE_MS (4 ms) before each yield, so it turns SAVED / 100 + 1 times
    // without slicing (6 at full size), and once more every few milliseconds with it: 30-odd on CI's Linux runner, 140 on
    // Windows. At full size only: a tenth of it can be written in one slice on a fast machine.
    if (full) expect(importTurns).toBeGreaterThanOrEqual(SAVED / 100 + 10);
    // The budget (S17, Phase 2: import and export), at full size: a tenfold regression of the 9.4 ms measured on CI (10.6
    // ms on an SSD, 40 ms on a slower drive, on Windows) fails. Held off CI and with CHORD_PERF_ENFORCE=1, as #182's are:
    // a shared runner can stall the thread for reasons of its own (302.6 ms once on #188's checks job, against 8-29 ms on
    // main's), so CI holds only a bound no sliced import comes near. At a tenth of the size (`pnpm test:perf`), only that.
    const held = !process.env['CI'] || process.env['CHORD_PERF_ENFORCE'] === '1';
    expect(longest).toBeLessThan(full && held ? 100 : 1000);
    const undo0 = performance.now();
    expect((await run({ op: 'importUndo', importId: 'big' })).undone).toEqual({ removed: BIG - SAVED, restored: SAVED, changed: 0 });
    console.log(`${BIG} rows: undo ${(performance.now() - undo0).toFixed(0)} ms`);
  });
});
