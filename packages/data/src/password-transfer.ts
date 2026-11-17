/**
 * Passwords in and out, chord-data's side (docs/decisions/S17-passwords.md
 * §10, phase 2). Only chord-data holds the vault key, so only it compares a
 * file with the vault, writes what comes in, and opens what goes out:
 *
 * - **Staging.** The import process reads a CSV (or a Chord file's `login`
 *   records) and sends the sign-ins here over a port of their own, never
 *   through main. They wait in memory, by a stage id main made, until they're
 *   imported, let go, or 10 minutes pass.
 * - **The preview** compares them with the vault (core's planPasswordImport):
 *   new, the same, or different. Settings gets counts, addresses and
 *   usernames, never a password.
 * - **The import** writes in slices, each one transaction, with chord-data
 *   answering other requests (the command bar's searches) in between. A lock
 *   part way stops it. Its Undo, for the session, keeps sealed copies only.
 * - **Export**: a CSV in Chrome's shape, written by this process to the file
 *   main's save dialog chose; or `login` records, a page at a time, over a
 *   port to the export process, for an encrypted Chord file only.
 *
 * Nothing here logs a value, and no error it throws holds one.
 */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import {
  CONTROL_CHARACTERS,
  importOrigin,
  loginProblem,
  loginRecord,
  PASSWORD_CSV_HEADER,
  PASSWORD_IMPORT_LIMITS,
  passwordCsvLine,
  planPasswordImport,
  takesFile,
  uniqueLogins,
  type DataRecord,
  type ImportedLogin,
  type ImportIssue,
  type LoginSecret,
  type PasswordFileProblem,
  type PasswordImportChoices,
  type PasswordImportResult,
  type PasswordImportSummary,
  type PasswordImportUndone,
  type PasswordSource,
  type VaultLogin,
} from '@chord/core';
import type { VaultState } from './passwords';

/** A sign-in as it's stored: what Undo puts back exactly, sealed. */
export interface StoredLogin {
  id: string;
  site_tag: Buffer;
  sealed: Buffer;
  created_at: number;
  updated_at: number;
}

/** What this needs of the vault (PasswordStore gives it): the key's state, and rows opened, written and put back. */
export interface VaultAccess {
  state(): VaultState;
  /** Counts locks: work that began before one stops. */
  generation(): number;
  /** The Public Suffix List, which writing a sign-in needs (its site's tag). */
  ready(): Promise<void>;
  /** Saved sign-ins opened, by id after `after`, at most `limit`; those that don't open are counted. */
  page(after: string, limit: number): { logins: { id: string; created: number; secret: LoginSecret }[]; unreadable: number; last: string | null };
  /** A new sign-in; its password changed when the file says, else now. */
  insert(login: ImportedLogin, now: number): string | null;
  /** The file's password (and note, when it has one) for a saved one, the one before kept: what it was, for Undo. */
  replace(id: string, login: ImportedLogin, now: number): StoredLogin | null;
  stored(id: string): StoredLogin | null;
  /** Put back as it was, whether it's there or not. */
  restore(row: StoredLogin): void;
  remove(id: string): void;
  /** One transaction. */
  transaction(work: () => void): void;
  /** An import writing (true) or done (false): SQLite's checkpoints come smaller meanwhile, as for history's imports. */
  importing(on: boolean): void;
}

/** The import process → chord-data, on a stage's port. `done` ends it. */
export interface PasswordStageBatch {
  logins?: ImportedLogin[];
  issues?: ImportIssue[];
  /** Added to the stage's counts (`rows`: the file's data rows). */
  counts?: { rows?: number; otp?: number; capped?: number; issuesMore?: number; skipped?: number };
  /** Whose export the file looks like, by its header. */
  source?: PasswordSource | null;
  /** The file read to its end; `problem` when it can't be read at all. */
  done?: { problem: PasswordFileProblem | null };
}
export type PasswordStageReply = { ok: true } | { ok: false; error: string };

export type TransferOp =
  /** What a staged file would do. Locked: the file's own counts only. */
  | { op: 'importPreview'; stageId: string }
  /** Write it, as chosen; `importId` names it for Undo. */
  | { op: 'importRun'; stageId: string; importId: string; choices: PasswordImportChoices }
  | { op: 'importDrop'; stageId: string }
  | { op: 'importUndo'; importId: string }
  /** Every sign-in as a CSV in Chrome's shape, written to `path` (main's save dialog chose it). */
  | { op: 'exportCsv'; path: string };

export interface TransferResult {
  /** `refused`: that stage is being imported already, or that import id was used; `invalid`: the file couldn't be written. */
  problem?: 'locked' | 'none' | 'missing' | 'refused' | 'invalid';
  importPreview?: PasswordImportSummary;
  imported?: PasswordImportResult;
  undone?: PasswordImportUndone;
  exported?: { count: number; unreadable: number };
}

/**
 * How long one transaction of an import writes before chord-data's thread
 * goes back to other requests (the command bar's searches). A row is a seal,
 * a tag and an insert: 100–250 µs on Windows (Node's cipher and HMAC objects
 * are most of it), so a slice is 15–40 rows.
 */
const SLICE_MS = 4;
/** Rows an Undo takes back per transaction: a delete or a put-back each, no crypto. */
const UNDO_SLICE = 200;
/** Rows opened per step when the whole vault is read (a preview, an export): about 40 µs each. */
const PAGE = 100;
/** A file read but not imported is let go after this. */
const STAGE_MS = 10 * 60_000;
/** The characters of sign-ins one file may hold in memory: far past 50,000 real ones (a CSV is at most 64 MB). */
const STAGE_CHARS = 64 * 1024 * 1024;
/** The end of the year 9999, as a stamp's limit (docs/data-format.md). */
const MAX_TIME = 253402300799999;
const ISSUE_KINDS: ReadonlySet<unknown> = new Set(['address', 'app', 'password', 'long', 'kind', 'text']);
/** Text a listed row shows, as the import process cuts it; anything that isn't text is nothing. */
const shown = (v: unknown) => (typeof v === 'string' ? (v.length > PASSWORD_IMPORT_LIMITS.shown ? `${v.slice(0, PASSWORD_IMPORT_LIMITS.shown - 1)}…` : v) : '');

interface Stage {
  logins: ImportedLogin[];
  issues: ImportIssue[];
  counts: { rows: number; otp: number; capped: number; issuesMore: number; skipped: number };
  source: PasswordSource | null;
  problem: PasswordFileProblem | null;
  done: boolean;
  /** The same sign-in twice in the file: kept once, the later row's. */
  duplicates: number;
  /** Characters of the sign-ins held, against STAGE_CHARS. */
  chars: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** An import's Undo: what it added, and what it replaced as it was, sealed; `at`, the time it wrote, so a row changed since is left. */
interface Landed {
  at: number;
  added: string[];
  replaced: StoredLogin[];
  /** What its Undo has taken back so far, and whether one is running. */
  undone: PasswordImportUndone;
  undoing: boolean;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

export class PasswordTransfer {
  private readonly stages = new Map<string, Stage>();
  private readonly landed = new Map<string, Landed>();

  /** How far an import has got, at most ten times a second: chord-data's worker pushes it to main for Settings' bar. */
  onProgress: ((importId: string, done: number, total: number) => void) | null = null;

  constructor(private readonly vault: VaultAccess) {}

  /* ---------- staging ---------- */

  private stage(stageId: string): Stage {
    let stage = this.stages.get(stageId);
    if (!stage) {
      stage = { logins: [], issues: [], counts: { rows: 0, otp: 0, capped: 0, issuesMore: 0, skipped: 0 }, source: null, problem: null, done: false, duplicates: 0, chars: 0, running: false, timer: null };
      this.stages.set(stageId, stage);
    }
    if (stage.timer) clearTimeout(stage.timer);
    stage.timer = setTimeout(() => this.drop(stageId), STAGE_MS);
    stage.timer.unref?.();
    return stage;
  }

  /**
   * A batch from the import process. Checked again here (the process reads
   * untrusted files): each sign-in's address and limits, and no more than one
   * import reads in all.
   */
  staged(stageId: string, batch: PasswordStageBatch): PasswordStageReply {
    if (!batch || typeof batch !== 'object') return { ok: false, error: 'not a batch' };
    const stage = this.stage(stageId);
    if (stage.done) return { ok: false, error: 'stage done' };
    for (const login of Array.isArray(batch.logins) ? batch.logins : []) {
      if (stage.logins.length >= PASSWORD_IMPORT_LIMITS.rows) {
        stage.counts.capped++;
        continue;
      }
      const where = login && typeof login.origin === 'string' ? importOrigin(login.origin) : null;
      const ok =
        where !== null &&
        'origin' in where &&
        where.origin === login.origin &&
        typeof login.username === 'string' &&
        typeof login.password === 'string' &&
        typeof login.note === 'string' &&
        (login.realm === null || typeof login.realm === 'string') &&
        (login.changedAt === null || (Number.isInteger(login.changedAt) && login.changedAt >= 0 && login.changedAt <= MAX_TIME)) &&
        loginProblem(login) === null &&
        !CONTROL_CHARACTERS.test(login.username);
      const size = ok ? login.origin.length + login.username.length + login.password.length + login.note.length + (login.realm?.length ?? 0) : 0;
      // A file's sign-ins are held in memory until they're imported: past STAGE_CHARS in all, the rest are left out.
      if (ok && stage.chars + size > STAGE_CHARS) {
        stage.counts.capped++;
        continue;
      }
      stage.chars += size;
      if (ok) stage.logins.push({ origin: login.origin, username: login.username, password: login.password, note: login.note, realm: login.realm, changedAt: login.changedAt });
      else stage.counts.skipped++;
    }
    for (const issue of Array.isArray(batch.issues) ? batch.issues : []) {
      // What reaches Settings is checked here, whatever the import process sent: the row, why, and short text.
      const kind = issue && ISSUE_KINDS.has(issue.kind) ? issue.kind : null;
      if (!kind || !Number.isInteger(issue.row) || issue.row < 1) continue;
      if (stage.issues.length < PASSWORD_IMPORT_LIMITS.issues) stage.issues.push({ row: issue.row, kind, address: shown(issue.address), username: shown(issue.username), name: shown(issue.name) });
      else stage.counts.issuesMore++;
    }
    const counts = batch.counts && typeof batch.counts === 'object' ? batch.counts : {};
    if (batch.source !== undefined && batch.source !== null && ['chrome', 'firefox', 'safari', 'bitwarden', '1password'].includes(batch.source)) stage.source = batch.source;
    for (const key of ['rows', 'otp', 'capped', 'issuesMore', 'skipped'] as const) {
      const n = counts[key];
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) stage.counts[key] += n;
    }
    if (batch.done) {
      stage.done = true;
      const problem = batch.done.problem;
      stage.problem = problem === null || problem === 'url' || problem === 'password' || problem === 'empty' ? problem : 'unreadable';
      // The file's sign-ins once each, the later row's: what the preview and the import both read.
      const unique = uniqueLogins(stage.logins);
      stage.logins = unique.logins;
      stage.duplicates = unique.duplicates;
    }
    return { ok: true };
  }

  /** The import process went before saying it was done: what it staged can't be trusted to be the whole file. */
  portClosed(stageId: string): void {
    const stage = this.stages.get(stageId);
    if (stage && !stage.done) {
      stage.done = true;
      stage.problem = 'unreadable';
      stage.logins = [];
    }
  }

  private drop(stageId: string): void {
    const stage = this.stages.get(stageId);
    if (!stage || stage.running) return;
    if (stage.timer) clearTimeout(stage.timer);
    this.stages.delete(stageId);
  }

  /* ---------- reading the vault ---------- */

  /** Every saved sign-in, opened a page at a time with other requests in between; null if the vault locked meanwhile. */
  private async everything(): Promise<{ logins: { id: string; created: number; secret: LoginSecret }[]; unreadable: number } | null> {
    const generation = this.vault.generation();
    const logins: { id: string; created: number; secret: LoginSecret }[] = [];
    let unreadable = 0;
    for (let after = ''; ; ) {
      if (this.vault.state() !== 'open' || this.vault.generation() !== generation) return null;
      const page = this.vault.page(after, PAGE);
      logins.push(...page.logins);
      unreadable += page.unreadable;
      if (page.last === null) break;
      after = page.last;
      await yieldNow();
    }
    return { logins, unreadable };
  }

  private static here(logins: { id: string; secret: LoginSecret }[]): VaultLogin[] {
    return logins.map(({ id, secret }) => ({ id, origin: secret.origin, username: secret.username, password: secret.password, realm: secret.realm, note: secret.note }));
  }

  /* ---------- ops ---------- */

  async run(op: TransferOp, now: number): Promise<TransferResult> {
    switch (op.op) {
      case 'importPreview':
        return this.preview(op.stageId);
      case 'importRun':
        return this.import(op.stageId, op.importId, op.choices, now);
      case 'importDrop':
        this.drop(op.stageId);
        return {};
      case 'importUndo':
        return this.undo(op.importId);
      case 'exportCsv':
        return this.exportCsv(op.path);
    }
  }

  private async preview(stageId: string): Promise<TransferResult> {
    const stage = this.stages.get(stageId);
    if (!stage?.done) return { problem: 'missing' };
    this.stage(stageId);
    const state = this.vault.state();
    const summary: PasswordImportSummary = {
      state,
      problem: stage.problem,
      source: stage.source,
      rows: stage.counts.rows,
      logins: stage.logins.length,
      added: 0,
      same: 0,
      different: 0,
      conflicts: [],
      conflictsMore: 0,
      issues: stage.issues,
      issuesMore: stage.counts.issuesMore,
      otp: stage.counts.otp,
      duplicates: stage.duplicates,
      capped: stage.counts.capped,
      skipped: stage.counts.skipped,
    };
    if (state === 'none') summary.added = stage.logins.length;
    if (state !== 'open') return { importPreview: summary };
    const all = await this.everything();
    if (!all) return { importPreview: { ...summary, state: 'locked' } };
    const plan = planPasswordImport(stage.logins, PasswordTransfer.here(all.logins));
    summary.added = plan.added.length;
    summary.same = plan.same.length;
    summary.different = plan.different.length;
    for (const { at, what } of plan.different) {
      if (summary.conflicts.length >= PASSWORD_IMPORT_LIMITS.conflicts) {
        summary.conflictsMore++;
        continue;
      }
      const login = stage.logins[at]!;
      summary.conflicts.push({ at, origin: login.origin, username: login.username, realm: login.realm, what });
    }
    return { importPreview: summary };
  }

  private async import(stageId: string, importId: string, choices: PasswordImportChoices, now: number): Promise<TransferResult> {
    const stage = this.stages.get(stageId);
    if (!stage?.done || stage.problem) return { problem: 'missing' };
    if (stage.running || this.landed.has(importId)) return { problem: 'refused' };
    const state = this.vault.state();
    if (state !== 'open') return { problem: state === 'none' ? 'none' : 'locked' };
    stage.running = true;
    // Its 10 minutes start again: a stage never lapses while it's being imported.
    this.stage(stageId);
    let writing = false;
    try {
      await this.vault.ready();
      const generation = this.vault.generation();
      const all = await this.everything();
      if (!all || this.vault.generation() !== generation) return { problem: 'locked' };
      const plan = planPasswordImport(stage.logins, PasswordTransfer.here(all.logins));
      const except = new Set(choices.except);
      const replace = plan.different.filter(({ at }) => takesFile(choices.take, except, at));
      const result: PasswordImportResult = { added: 0, updated: 0, kept: plan.different.length - replace.length, same: plan.same.length, stopped: false };
      const landed: Landed = { at: now, added: [], replaced: [], undone: { removed: 0, restored: 0, changed: 0 }, undoing: false };
      this.landed.set(importId, landed);
      this.vault.importing(true);
      writing = true;
      type Step = { add: number } | { replace: { at: number; id: string } };
      const steps: Step[] = [...plan.added.map((at) => ({ add: at })), ...replace.map((r) => ({ replace: r }))];
      let reported = 0;
      const report = (done: number, force = false) => {
        if (!force && performance.now() - reported < 100) return;
        reported = performance.now();
        this.onProgress?.(importId, done, steps.length);
      };
      report(0, true);
      try {
        await this.writeSteps(steps, stage, landed, result, generation, now, report);
      } catch (error) {
        // Part written, then it failed (a full disk): what landed keeps its Undo, and says it stopped. Never the error's
        // text: chord-data's replies carry it, and it could quote a row.
        // (A slice that failed rolled back: its rows aren't there, and Undo passes over what it doesn't find.)
        if (landed.added.length === 0 && landed.replaced.length === 0) {
          this.landed.delete(importId);
          // eslint-disable-next-line preserve-caught-error -- its cause could quote a row: only its name goes on.
          throw new Error(error instanceof Error ? error.name : 'error');
        }
        result.stopped = true;
      }
      if (landed.added.length === 0 && landed.replaced.length === 0) this.landed.delete(importId);
      return { imported: result };
    } finally {
      if (writing) this.vault.importing(false);
      stage.running = false;
      // Written (or stopped): the file's passwords leave memory. Another try reads the file again.
      this.drop(stageId);
    }
  }

  private async writeSteps(
    steps: ({ add: number } | { replace: { at: number; id: string } })[],
    stage: Stage,
    landed: Landed,
    result: PasswordImportResult,
    generation: number,
    now: number,
    report: (done: number) => void,
  ): Promise<void> {
    {
      for (let next = 0; next < steps.length; ) {
        // Locked (Lock now, or idle) since it began: it stops here, and what landed keeps its Undo.
        if (this.vault.state() !== 'open' || this.vault.generation() !== generation) {
          result.stopped = true;
          break;
        }
        const until = performance.now() + SLICE_MS;
        this.vault.transaction(() => {
          do {
            const step = steps[next++]!;
            if ('add' in step) {
              const id = this.vault.insert(stage.logins[step.add]!, now);
              if (id) {
                landed.added.push(id);
                result.added++;
              }
            } else {
              const before = this.vault.replace(step.replace.id, stage.logins[step.replace.at]!, now);
              if (before) {
                landed.replaced.push(before);
                result.updated++;
              }
            }
          } while (next < steps.length && performance.now() < until);
        });
        report(next);
        await yieldNow();
      }
    }
  }

  /**
   * An import's Undo, for the session: what it added goes, and what it
   * replaced comes back, sealed as it was. A sign-in changed since (by hand,
   * a save, a later import) stays as it is now, and is counted. Needs no key.
   */
  private async undo(importId: string): Promise<TransferResult> {
    const landed = this.landed.get(importId);
    if (!landed) return { problem: 'missing' };
    // One Undo at a time; what it has taken back leaves `landed` a slice at a time, once committed, so an Undo that
    // fails part way (a full disk) can be tried again for the rest, and nothing is taken back twice.
    if (landed.undoing) return { problem: 'refused' };
    landed.undoing = true;
    this.vault.importing(true);
    try {
      await this.undoSteps(landed);
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- its cause could quote a row: only its name goes on.
      throw new Error(error instanceof Error ? error.name : 'error');
    } finally {
      landed.undoing = false;
      this.vault.importing(false);
    }
    this.landed.delete(importId);
    return { undone: landed.undone };
  }

  private async undoSteps(landed: Landed): Promise<void> {
    while (landed.added.length > 0 || landed.replaced.length > 0) {
      const removing = landed.added.slice(0, UNDO_SLICE);
      const restoring = landed.replaced.slice(0, UNDO_SLICE - removing.length);
      const steps: ({ remove: string } | { restore: StoredLogin })[] = [...removing.map((id) => ({ remove: id })), ...restoring.map((row) => ({ restore: row }))];
      const undone = { ...landed.undone };
      this.vault.transaction(() => {
        for (const step of steps) {
          const id = 'remove' in step ? step.remove : step.restore.id;
          const now = this.vault.stored(id);
          if (!now) continue;
          if (now.updated_at !== landed.at) {
            undone.changed++;
            continue;
          }
          if ('remove' in step) {
            this.vault.remove(id);
            undone.removed++;
          } else {
            this.vault.restore(step.restore);
            undone.restored++;
          }
        }
      });
      // Committed: this slice is done, and counted.
      landed.added.splice(0, removing.length);
      landed.replaced.splice(0, restoring.length);
      landed.undone = undone;
      await yieldNow();
    }
  }

  /**
   * Every sign-in as Chrome's CSV, to the file chosen: `<name>.part` first,
   * renamed once whole (or in place where only that file may be written, a
   * sandbox's document portal). Sorted by site, then username.
   */
  private async exportCsv(path: string): Promise<TransferResult> {
    if (this.vault.state() !== 'open') return { problem: this.vault.state() === 'none' ? 'none' : 'locked' };
    const all = await this.everything();
    if (!all) return { problem: 'locked' };
    const host = (origin: string) => origin.replace(/^[a-z]+:\/\/(www\.)?/, '');
    const logins = all.logins.map((l) => l.secret).sort((a, b) => host(a.origin).localeCompare(host(b.origin)) || a.username.localeCompare(b.username));
    let part = `${path}.part`;
    let fd: number;
    try {
      fd = openSync(part, 'w', 0o600);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'EACCES' && code !== 'EPERM') return { problem: 'invalid' };
      part = path;
      try {
        fd = openSync(path, 'w', 0o600);
      } catch {
        return { problem: 'invalid' };
      }
    }
    try {
      writeSync(fd, PASSWORD_CSV_HEADER);
      for (let from = 0; from < logins.length; from += PAGE) {
        writeSync(fd, logins.slice(from, from + PAGE).map(passwordCsvLine).join(''));
        await yieldNow();
      }
      fsyncSync(fd);
      closeSync(fd);
      if (part !== path) renameSync(part, path);
    } catch {
      try {
        closeSync(fd);
      } catch {
        // Closed already.
      }
      rmSync(part, { force: true });
      return { problem: 'invalid' };
    }
    return { exported: { count: logins.length, unreadable: all.unreadable } };
  }

  /**
   * The export process's next page of `login` records, for an encrypted Chord
   * file (S17 decision 6): only while the vault is open and hasn't locked
   * since `generation` (when main checked the passphrase and made the port).
   */
  exportPage(after: string, limit: number, generation: number): { records: DataRecord[]; last: string | null; unreadable: number } | null {
    if (this.vault.state() !== 'open' || this.vault.generation() !== generation) return null;
    const page = this.vault.page(after, Math.max(1, Math.min(limit, PAGE)));
    return { records: page.logins.map(({ id, created, secret }) => loginRecord(id, secret, created)), last: page.last, unreadable: page.unreadable };
  }

  generation(): number {
    return this.vault.generation();
  }

  /** *Lock now* or idle: a staged file's passwords leave memory (an import's Undo stays: it holds sealed copies only). */
  locked(): void {
    for (const [stageId, stage] of this.stages) if (!stage.running) this.drop(stageId);
  }

  /** chord-data closing, or *Start over*: staged passwords and every Undo go. */
  clear(): void {
    for (const stage of this.stages.values()) if (stage.timer) clearTimeout(stage.timer);
    this.stages.clear();
    this.landed.clear();
  }
}
