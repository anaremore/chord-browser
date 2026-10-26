/**
 * Your data's export, main's side (docs/decisions/S15-your-data.md §7), which
 * only routes (performance rules 1 and 4). Main writes what's pending, asks
 * where to save with the system's dialog, and starts an export process with
 * the database's path, the images folder, the target and the passphrase if
 * there is one. That process reads and writes everything itself; main hears
 * how far it's got, passes it on to Settings, and ends the process after. One
 * export runs at a time.
 */
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { uuidv7, type ExportCounts, type Platform } from '@chord/core';
import type { ExportProblem, ExportProgress, ExportRequest, ExportRunResult } from '@chord/ipc';
import { dialog, shell, utilityProcess, type BaseWindow, type SaveDialogOptions, type UtilityProcess } from 'electron';
import type { ExportJob, ExportMessage, ExportReply } from '../export/worker';

/** An export that says nothing for this long has stopped. Every chunk of a megabyte, and every tenth of a second, it says how far it's got. */
const STALL_MS = 60_000;

export interface ExporterOptions {
  /** The export process's script, as built (out/main/export.js). */
  workerPath: string;
  database: string;
  images: string;
  app: string;
  platform: Platform;
  /** Where the save dialog starts the first time. */
  folder(): string;
  /** chord-data: what's pending written first, this computer's id, and what an export would hold. */
  data: { flush(): Promise<void>; device(): Promise<string>; counts(): Promise<ExportCounts> };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Chord data 2026-11-30.jsonl", or `.chorddata` encrypted (S15 §2, *Extension and MIME type*). The date is this computer's. */
export function exportName(now: Date, encrypted: boolean): string {
  return `Chord data ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${encrypted ? 'chorddata' : 'jsonl'}`;
}

interface Running {
  id: string;
  child: UtilityProcess;
  target: string;
  finished: Promise<void>;
}

export class Exporter {
  private running: Running | null = null;
  /** An export between its click and its process: the dialog, then what's pending written. One at a time, from the click on. */
  private starting = false;
  /** Where each finished export was saved, by id, for *Show in folder*: a renderer names an export, never a path. */
  private readonly saved = new Map<string, string>();
  /** The last folder saved to this session: the dialog opens there next time. */
  private folder: string | null = null;

  constructor(private readonly options: ExporterOptions) {}

  counts(): Promise<ExportCounts> {
    return this.options.data.counts();
  }

  /** The save dialog, then the export, which goes on by itself and reports to `notify`. */
  async run(parent: BaseWindow | null, request: ExportRequest, notify: (progress: ExportProgress) => void): Promise<ExportRunResult> {
    if (this.running || this.starting) return { ok: false, problem: 'busy' };
    this.starting = true;
    try {
      return await this.start(parent, request, notify);
    } finally {
      this.starting = false;
    }
  }

  private async start(parent: BaseWindow | null, request: ExportRequest, notify: (progress: ExportProgress) => void): Promise<ExportRunResult> {
    const encrypted = request.passphrase !== null;
    const dialogOptions: SaveDialogOptions = {
      title: 'Export your data',
      defaultPath: join(this.folder ?? this.options.folder(), exportName(new Date(), encrypted)),
      filters: [encrypted ? { name: 'Encrypted Chord data', extensions: ['chorddata'] } : { name: 'JSON Lines', extensions: ['jsonl'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const chosen = parent && !parent.isDestroyed() ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (chosen.canceled || !chosen.filePath) return { ok: false, problem: 'cancelled' };
    const target = chosen.filePath;
    this.folder = dirname(target);
    const name = basename(target);
    const id = uuidv7();
    // What's waiting to be written goes first, so the file has the last moment's changes.
    await this.options.data.flush();
    const device = await this.options.data.device();
    const job: ExportJob = {
      database: this.options.database,
      images: this.options.images,
      target,
      device,
      app: this.options.app,
      platform: this.options.platform,
      history: request.history,
      duet: request.duet,
      passphrase: request.passphrase,
    };
    const child = utilityProcess.fork(this.options.workerPath, [], { serviceName: 'Chord Export', stdio: 'ignore' });
    const running: Running = { id, child, target, finished: Promise.resolve() };
    this.running = running;
    running.finished = this.follow(running, name, notify);
    child.postMessage({ type: 'run', job } satisfies ExportMessage);
    return { ok: true, exportId: id, name };
  }

  /** Passes the process's progress on until it's done, fails, goes quiet or exits; then ends it. */
  private follow(running: Running, name: string, notify: (progress: ExportProgress) => void): Promise<void> {
    const { id, child, target } = running;
    return new Promise((resolve) => {
      let ended = false;
      let stall: ReturnType<typeof setTimeout> | undefined;
      /** What the process is writing until the file's whole: `.part`, unless it says it writes the file itself. */
      let writing: string | null = `${target}.part`;
      const end = (outcome: { bytes: number; skipped: number } | { problem: ExportProblem }) => {
        if (ended) return;
        ended = true;
        clearTimeout(stall);
        child.kill();
        if (this.running === running) this.running = null;
        if ('bytes' in outcome) {
          this.saved.set(id, target);
          notify({ exportId: id, phase: 'done', done: 0, total: 0, share: 1, name, bytes: outcome.bytes, ...(outcome.skipped ? { skipped: outcome.skipped } : {}) });
        } else {
          // A process that's gone can't take its unfinished file with it.
          if (writing) void rm(writing, { force: true, maxRetries: 3 }).catch(() => undefined);
          notify({ exportId: id, phase: 'failed', done: 0, total: 0, share: 0, name, problem: outcome.problem });
        }
        resolve();
      };
      const quiet = () => {
        clearTimeout(stall);
        stall = setTimeout(() => end({ problem: 'read' }), STALL_MS);
      };
      quiet();
      child.on('message', (message: ExportReply) => {
        quiet();
        if (message.type === 'progress') notify({ exportId: id, phase: message.phase, done: message.done, total: message.total, share: message.share, name });
        else if (message.type === 'writing') writing = message.path === target || message.path === `${target}.part` ? message.path : null;
        else if (message.type === 'done') end({ bytes: message.bytes, skipped: message.skipped });
        else end({ problem: message.problem });
      });
      child.once('exit', () => end({ problem: 'read' }));
    });
  }

  /** *Show in folder*: the saved file, selected in the system's file manager. */
  show(exportId: string): void {
    const path = this.saved.get(exportId);
    if (path) shell.showItemInFolder(path);
  }

  /** Quitting: an export still being written stops, and its unfinished file goes. */
  async quit(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.child.kill();
    await running.finished;
  }
}
