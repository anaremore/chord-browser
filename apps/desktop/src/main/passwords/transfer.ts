/**
 * Passwords in and out, main's side (docs/decisions/S17-passwords.md §10,
 * phase 2), which only routes and decides, as the vault's service does: no
 * password passes through here.
 *
 * - **Import…** (a CSV from another browser or manager): main shows the open
 *   dialog and keeps the path; the import process (src/import-file) reads it
 *   and sends its sign-ins straight to chord-data over a port, where they're
 *   staged by an id main made. The preview, the import and its Undo are
 *   chord-data's (`@chord/data/password-transfer`); main asks for them,
 *   opening the vault first where it can be opened unasked, and choosing the
 *   first passphrase when there's no vault yet. One import of any kind at a
 *   time (`ImportGate`).
 * - **A Chord file's passwords** are staged the same way while Your data's
 *   import reads the file (main/import-file.ts asks for a stage here), and
 *   come in with it, as chosen, into an open vault.
 * - **Export…**: the passphrase as *Show* asks for it (typed in the last 5
 *   minutes, or now), then the save dialog; chord-data writes the CSV to the
 *   file chosen. For an encrypted Chord file, the same check, then a port on
 *   which the export process reads the `login` records.
 *
 * Nothing here logs a value.
 */
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { uuidv7, type PasswordImportChoices, type PasswordImportSummary, type PasswordImportUndone, type WindowId } from '@chord/core';
import type { PasswordOp, PasswordResult, VaultState } from '@chord/data';
import type { PasswordExportResult, PasswordImportOpened, PasswordImportProgress, PasswordImportRun, PasswordRevealResult, PasswordStepResult, Toast } from '@chord/ipc';
import { dialog, shell, type BaseWindow, type MessagePortMain, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import type { FileReply, FileRequest } from '../../import-file/worker';
import { ImportProcess, type ImportGate } from '../import';

/** A CSV that says nothing for this long while it's read has stopped (64 MB reads in well under a second). */
const READ_MS = 60_000;

/** The vault's service, as far as import and export need it (main/passwords/service.ts). */
export interface TransferVault {
  vaultState(): Promise<VaultState>;
  confirm(passphrase?: string): Promise<Exclude<PasswordRevealResult, { ok: true }> | null>;
  transferred(changed: boolean): void;
  setup(passphrase: string): Promise<PasswordStepResult>;
}

/** The import process, as far as reading a CSV needs it: tests stand in for it. */
export interface CsvProcess {
  send(request: FileRequest, transfer?: MessagePortMain[]): void;
  next(timeoutMs: number): Promise<FileReply | null>;
  end(): void;
}

export interface PasswordTransferOptions {
  /** The import process's script, as built (out/main/import-file.js). */
  workerPath: string;
  /** chord-data's vault. Throws when chord-data can't answer. */
  data(op: PasswordOp): Promise<PasswordResult>;
  /** A port to chord-data on which the import process stages a file's passwords. */
  stagePort(stageId: string): Promise<MessagePortMain>;
  /** A port to chord-data on which the export process reads the `login` records. */
  exportPort(): Promise<MessagePortMain>;
  vault: TransferVault;
  /** Shared with Your data's imports: one import at a time. */
  gate: ImportGate;
  /** Where the dialogs open the first time (Downloads). */
  folder(): string;
  /** chord-data's reports of how far an import has written. */
  onProgress?(listener: (importId: string, done: number, total: number) => void): void;
  /** A window's toast: *Imported 384 passwords*, with Undo (the shell's `import.undo`, which main routes here). */
  toast?(windowId: WindowId, toast: Toast): void;
  /** Tests: the dialogs and the process. */
  openDialog?(parent: BaseWindow | null, options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  saveDialog?(parent: BaseWindow | null, options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  startProcess?(): Promise<CsvProcess>;
  now?: () => Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Chord passwords 2026-11-17.csv": this computer's date. */
export const passwordExportName = (now: Date) => `Chord passwords ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;

const showOpen = (parent: BaseWindow | null, options: OpenDialogOptions) => (parent && !parent.isDestroyed() ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
const showSave = (parent: BaseWindow | null, options: SaveDialogOptions) => (parent && !parent.isDestroyed() ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options));

export class PasswordTransfers {
  /** Files staged in chord-data this session, by stage id: a renderer names one, never a path. */
  private readonly stages = new Set<string>();
  /** Imports this session with something to undo: the window its toast is in, and Settings' card to tell. */
  private readonly imports = new Map<string, { windowId: WindowId | null; notify: ((progress: PasswordImportProgress) => void) | null; stageId: string }>();
  /** The import writing now, for chord-data's progress. */
  private writing: { importId: string; stageId: string; notify: ((progress: PasswordImportProgress) => void) | null } | null = null;
  /** A dialog, a read or an import between its click and its answer: one at a time. */
  private working = false;
  private folder: string | null = null;
  /** CSVs saved this session, by id, for *Show in folder*: a renderer names an export, never a path. */
  private readonly saved = new Map<string, string>();

  constructor(private readonly options: PasswordTransferOptions) {
    options.onProgress?.((importId, done, total) => {
      const writing = this.writing;
      if (writing?.importId === importId) writing.notify?.({ stageId: writing.stageId, importId: null, phase: 'writing', done, total });
    });
  }

  /** Whether an import is this one's: the window's toast dispatches `import.undo` for every kind. */
  owns(importId: string): boolean {
    return this.imports.has(importId);
  }

  private get busy(): boolean {
    return this.working || this.options.gate.busy;
  }

  private async startProcess(): Promise<CsvProcess> {
    return this.options.startProcess ? this.options.startProcess() : ImportProcess.start<FileRequest, FileReply>(this.options.workerPath, { temp: false });
  }

  /* ---------- import ---------- */

  /** *Import…*: the open dialog, then the CSV read in the import process, staged in chord-data, and its preview. */
  async choose(parent: BaseWindow | null): Promise<PasswordImportOpened> {
    if (this.busy) return { ok: false, problem: 'busy' };
    this.working = true;
    try {
      const options: OpenDialogOptions = {
        title: 'Import passwords',
        defaultPath: this.folder ?? this.options.folder(),
        filters: [
          { name: 'Passwords (CSV)', extensions: ['csv'] },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      };
      const chosen = await (this.options.openDialog ?? showOpen)(parent, options);
      const path = chosen.filePaths[0];
      if (chosen.canceled || !path) return { ok: false, problem: 'cancelled' };
      this.folder = dirname(path);
      const stageId = uuidv7();
      const process = await this.startProcess();
      let reply: FileReply | null = null;
      try {
        process.send({ type: 'passwords', path }, [await this.options.stagePort(stageId)]);
        reply = await process.next(READ_MS);
      } catch {
        reply = null;
      } finally {
        process.end();
      }
      if (reply?.type !== 'passwords') {
        await this.drop(stageId);
        return { ok: false, problem: 'unreadable' };
      }
      this.stages.add(stageId);
      const preview = await this.preview(stageId);
      if (!preview) return { ok: false, problem: 'unreadable' };
      return { ok: true, stageId, name: basename(path), preview };
    } finally {
      this.working = false;
    }
  }

  /** A Chord file's passwords, for Your data's import: a stage and its port, which the import process fills while it reads the file. */
  async stageForFile(): Promise<{ stageId: string; port: MessagePortMain }> {
    const stageId = uuidv7();
    const port = await this.options.stagePort(stageId);
    this.stages.add(stageId);
    return { stageId, port };
  }

  /** What a staged file would do, against the vault as it is now; opened unasked first where it can be. Null when it's gone. */
  async preview(stageId: string): Promise<PasswordImportSummary | null> {
    if (!this.stages.has(stageId)) return null;
    const state = await this.options.vault.vaultState().catch(() => 'locked' as const);
    const result = await this.options.data({ op: 'importPreview', stageId }).catch((): PasswordResult => ({}));
    if (!result.importPreview) {
      this.stages.delete(stageId);
      return null;
    }
    if (state === 'open') this.options.vault.transferred(false);
    return result.importPreview;
  }

  /**
   * *Import*, as chosen. No vault yet: `passphrase` makes it first (the
   * passphrase step). Locked: refused, so Settings asks to unlock first.
   * Holds the import gate while it writes.
   */
  async run(stageId: string, choices: PasswordImportChoices, passphrase?: string, target: { windowId: WindowId | null; notify: ((progress: PasswordImportProgress) => void) | null } = { windowId: null, notify: null }): Promise<PasswordImportRun> {
    if (!this.stages.has(stageId)) return { ok: false, problem: 'missing' };
    if (this.busy) return { ok: false, problem: 'busy' };
    const importId = uuidv7();
    if (!this.options.gate.take(importId)) return { ok: false, problem: 'busy' };
    this.working = true;
    try {
      const run = await this.write(stageId, importId, choices, passphrase, target);
      if (run.ok && run.importId && target.windowId !== null) {
        const n = run.result.added + run.result.updated;
        this.options.toast?.(target.windowId, { id: `import:${importId}`, message: `Imported ${n === 1 ? '1 password' : `${new Intl.NumberFormat('en-US').format(n)} passwords`}`, action: { label: 'Undo', command: { t: 'import.undo', importId } } });
      }
      return run;
    } finally {
      this.working = false;
      this.options.gate.letGo(importId);
    }
  }

  /** The import itself, inside the gate: also how Your data's import brings a Chord file's passwords in (`runForFile`). */
  private async write(
    stageId: string,
    importId: string,
    choices: PasswordImportChoices,
    passphrase?: string,
    target: { windowId: WindowId | null; notify: ((progress: PasswordImportProgress) => void) | null } = { windowId: null, notify: null },
  ): Promise<PasswordImportRun> {
    let state = await this.options.vault.vaultState().catch(() => 'locked' as const);
    if (state === 'none') {
      if (passphrase === undefined) return { ok: false, problem: 'none' };
      const made = await this.options.vault.setup(passphrase);
      if (!made.ok) return { ok: false, problem: made.problem === 'exists' ? 'busy' : made.problem === 'io' ? 'io' : 'invalid' };
      state = 'open';
    }
    if (state !== 'open') return { ok: false, problem: 'locked' };
    let result: PasswordResult;
    this.writing = { importId, stageId, notify: target.notify };
    try {
      result = await this.options.data({ op: 'importRun', stageId, importId, choices });
    } catch {
      return { ok: false, problem: 'io' };
    } finally {
      this.writing = null;
    }
    // Written or not, the file's passwords have left chord-data's memory (it drops a stage it imported).
    this.stages.delete(stageId);
    if (!result.imported) {
      const problem = result.problem;
      return { ok: false, problem: problem === 'locked' || problem === 'none' || problem === 'missing' ? problem : problem === 'refused' ? 'busy' : 'io' };
    }
    const landed = result.imported.added + result.imported.updated > 0;
    if (landed) this.imports.set(importId, { windowId: target.windowId, notify: target.notify, stageId });
    this.options.vault.transferred(landed);
    return { ok: true, importId: landed ? importId : null, result: result.imported };
  }

  /** Your data's import, once its setup is in: the file's passwords, as chosen, into the vault if it's open (never asking here). */
  async runForFile(stageId: string, choices: PasswordImportChoices): Promise<PasswordImportRun> {
    if (!this.stages.has(stageId)) return { ok: false, problem: 'missing' };
    return this.write(stageId, uuidv7(), choices);
  }

  /** The file let go: its passwords leave chord-data's memory. */
  async drop(stageId: string): Promise<void> {
    this.stages.delete(stageId);
    await this.options.data({ op: 'importDrop', stageId }).catch(() => undefined);
  }

  /** An import's Undo, this session: null when there's nothing to undo. */
  async undo(importId: string): Promise<PasswordImportUndone | null> {
    const record = this.imports.get(importId);
    if (!record) return null;
    this.imports.delete(importId);
    const result = await this.options.data({ op: 'importUndo', importId }).catch((): PasswordResult => ({}));
    if (!result.undone) return null;
    this.options.vault.transferred(true);
    // Settings' card and the window's toast both say so, whichever Undo was pressed.
    record.notify?.({ stageId: record.stageId, importId, phase: 'undone', done: 0, total: 0, undone: result.undone });
    if (record.windowId !== null) this.options.toast?.(record.windowId, { id: `import:${importId}`, message: 'Import undone' });
    return result.undone;
  }

  /* ---------- export ---------- */

  /** The check before anything leaves (S17 §7): Show's, for every export of passwords. */
  private async check(passphrase?: string): Promise<'passphrase' | 'wrong' | 'locked' | 'none' | 'io' | null> {
    const state = await this.options.vault.vaultState().catch(() => 'locked' as const);
    if (state === 'none') return 'none';
    const stop = await this.options.vault.confirm(passphrase);
    if (!stop) return null;
    return stop.problem === 'missing' ? 'io' : stop.problem;
  }

  /** *Export…*: the passphrase check, then the save dialog; chord-data writes the CSV there. */
  async exportCsv(parent: BaseWindow | null, passphrase?: string): Promise<PasswordExportResult> {
    if (this.working) return { ok: false, problem: 'busy' };
    this.working = true;
    try {
      const stop = await this.check(passphrase);
      if (stop) return { ok: false, problem: stop };
      const { status } = await this.options.data({ op: 'status' }).catch((): PasswordResult => ({}));
      if (!status?.count) return { ok: false, problem: 'empty' };
      const options: SaveDialogOptions = {
        title: 'Export passwords',
        defaultPath: join(this.folder ?? this.options.folder(), passwordExportName((this.options.now ?? (() => new Date()))())),
        filters: [{ name: 'Passwords (CSV)', extensions: ['csv'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      };
      const chosen = await (this.options.saveDialog ?? showSave)(parent, options);
      if (chosen.canceled || !chosen.filePath) return { ok: false, problem: 'cancelled' };
      this.folder = dirname(chosen.filePath);
      const result = await this.options.data({ op: 'exportCsv', path: chosen.filePath }).catch((): PasswordResult => ({ problem: 'invalid' }));
      // chord-data gone part way (a crash) can't take its unfinished file with it: every password in it is in the clear.
      if (!result.exported) await rm(`${chosen.filePath}.part`, { force: true, maxRetries: 3 }).catch(() => undefined);
      if (!result.exported) return { ok: false, problem: result.problem === 'locked' || result.problem === 'none' ? result.problem : 'io' };
      this.options.vault.transferred(false);
      const exportId = uuidv7();
      this.saved.set(exportId, chosen.filePath);
      return { ok: true, exportId, name: basename(chosen.filePath), count: result.exported.count };
    } finally {
      this.working = false;
    }
  }

  /** How many passwords are saved: chord-data counts the rows without the key, so nothing opens and *Lock after* doesn't restart. */
  async count(): Promise<number> {
    const { status } = await this.options.data({ op: 'status' }).catch((): PasswordResult => ({}));
    return status?.count ?? 0;
  }

  /** Whether `passphrase` is the vault's (chord-data's `verify`, which leaves the vault as it is): a file's must never be. */
  async isVaultPassphrase(passphrase: string): Promise<boolean> {
    const result = await this.options.data({ op: 'verify', passphrase }).catch((): PasswordResult => ({ problem: 'invalid' }));
    return result.problem === undefined;
  }

  /** *Show in folder*: the CSV saved, selected in the system's file manager. */
  show(exportId: string): void {
    const path = this.saved.get(exportId);
    if (path) shell.showItemInFolder(path);
  }

  /** For an encrypted Chord file with *Passwords* on: the check, then a port on which the export process reads them. */
  async exportPort(passphrase?: string): Promise<{ port: MessagePortMain } | { problem: 'passphrase' | 'wrong' | 'locked' }> {
    const stop = await this.check(passphrase);
    if (stop) return { problem: stop === 'passphrase' || stop === 'wrong' ? stop : 'locked' };
    try {
      const port = await this.options.exportPort();
      this.options.vault.transferred(false);
      return { port };
    } catch {
      return { problem: 'locked' };
    }
  }
}
