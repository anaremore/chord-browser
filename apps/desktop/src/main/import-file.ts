/**
 * Your data's import from a Chord file, main's side
 * (docs/decisions/S15-your-data.md §5, §7), which only routes (performance
 * rules 1 and 4). Main asks which file with the system's open dialog and keeps
 * its path; a process of its own (*Chord Import*, src/import-file) reads it,
 * with the passphrase if it's encrypted, and counts what it would bring. On
 * *Import*, main writes what's pending, the process plans against this
 * computer's data, and main applies the plan a part at a time through the
 * store (`data.merge`, which checks every part again) and hands Effects to
 * their service, which sanitizes each stylesheet. History and chats go from
 * the process straight to chord-data over a port; main hears only how far
 * it's got. One import runs at a time, and one Undo, from the window's toast
 * or Settings, takes all of it back.
 */
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { importedText, sortedChords, uuidv7, type Command, type DuetImage, type DuetThread, type MergePart, type Platform, type SiteEffects, type State, type WindowId } from '@chord/core';
import { ImportedSettings, type FileChooseResult, type FileImportChoices, type FileImportCounts, type FileImportProgress, type FileOpenResult, type FileRunResult, type Toast } from '@chord/ipc';
import { dialog, type BaseWindow, type MessagePortMain, type OpenDialogOptions } from 'electron';
import type { FileJob, FileReply, FileRequest } from '../import-file/worker';
import { ImportProcess, within } from './import';

/** A read that says nothing for this long has stopped: a long one says it's still reading every second. */
const READ_STALL_MS = 60_000;
/** A step of the plan, or a batch of history or chats. */
const STEP_TIMEOUT_MS = 60_000;
/** A file read but not imported is let go after this, with its key. */
const IDLE_MS = 10 * 60_000;
/** Folders and tabs an Undo takes away per store change. */
const UNDO_PART = 200;
const MAX_UNDO_PARTS = 10_000;

const EXTENSIONS: Record<DuetImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const NONE: FileImportCounts = { chords: 0, tabs: 0, favorites: 0, other: 0, effects: 0, settings: 0, pages: 0, chats: 0 };

export interface FileImporterOptions {
  /** The import process's script, as built (out/main/import-file.js). */
  workerPath: string;
  database: string;
  /** `<userData>/duet/images`. */
  images: string;
  platform: Platform;
  /** Where the open dialog starts the first time. */
  folder(): string;
  state(): State;
  dispatch(command: Command): void;
  /** chord-data: what's pending written first, this computer's id, a port for history and chats, and an import's Undo (the chats it took away come back). */
  data: { flush(): Promise<void>; device(): Promise<string>; port(importId: string): Promise<MessagePortMain>; undo(importId: string): Promise<DuetThread[]> };
  effects: { importSites(importId: string, sites: SiteEffects[]): Promise<void>; undoImport(importId: string): Promise<void> };
  /** Duet's lists follow chats that came in or went; ones that went end their sessions. */
  duet(): { importChanged(removed?: readonly DuetThread[]): Promise<void> } | undefined;
  toast(windowId: WindowId, toast: Toast): void;
}

type FileProcess = ImportProcess<FileRequest, FileReply>;

/** A file chosen, read by its own process, which keeps what it needs until it's imported or let go. */
interface Session {
  fileId: string;
  path: string;
  name: string;
  process: FileProcess;
  ready: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
}

interface Running {
  importId: string;
  process: FileProcess;
  cancelled: boolean;
  finished: Promise<void>;
}

export class FileImporter {
  private session: Session | null = null;
  private running: Running | null = null;
  private choosing = false;
  private readonly processes = new Set<FileProcess>();
  /** Each import this session, for its Undo: where it reports, and the chats' images it wrote. */
  private readonly imports = new Map<string, { notify(progress: FileImportProgress): void; images: DuetImage[] }>();
  /** The last folder a file came from: the dialog opens there next time. */
  private folder: string | null = null;

  constructor(private readonly options: FileImporterOptions) {}

  /** Whether an import is this one's: the window's toast dispatches import.undo for both kinds. */
  owns(importId: string): boolean {
    return this.imports.has(importId);
  }

  private letGo(): void {
    if (!this.session) return;
    clearTimeout(this.session.idle);
    this.session.process.end();
    this.session = null;
  }

  /** The system's open dialog; the file is then the one this session reads. */
  async choose(parent: BaseWindow | null): Promise<FileChooseResult> {
    if (this.running || this.choosing) return { ok: false, problem: 'busy' };
    this.choosing = true;
    try {
      const options: OpenDialogOptions = {
        title: 'Import a Chord file',
        defaultPath: this.folder ?? this.options.folder(),
        filters: [
          { name: 'Chord data', extensions: ['jsonl', 'chorddata'] },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      };
      const chosen = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const path = chosen.filePaths[0];
      if (chosen.canceled || !path) return { ok: false, problem: 'cancelled' };
      this.folder = dirname(path);
      this.letGo();
      const process = await ImportProcess.start<FileRequest, FileReply>(this.options.workerPath, { temp: false });
      this.processes.add(process);
      void process.closed.then(() => this.processes.delete(process));
      this.session = { fileId: uuidv7(), path, name: basename(path), process, ready: false, idle: undefined };
      return { ok: true, fileId: this.session.fileId, name: this.session.name };
    } finally {
      this.choosing = false;
    }
  }

  /** Read the chosen file in its process, with its passphrase if it's encrypted (passed on, kept nowhere here), and count what it would bring. */
  async open(fileId: string, passphrase: string | null): Promise<FileOpenResult> {
    const session = this.session?.fileId === fileId ? this.session : null;
    if (!session) return { ok: false, problem: 'missing' };
    if (this.running) return { ok: false, problem: 'busy' };
    clearTimeout(session.idle);
    session.ready = false;
    // What's waiting to be written goes first, so what's here is counted as it is.
    await this.options.data.flush();
    const job: FileJob = { path: session.path, database: this.options.database, images: this.options.images, device: await this.options.data.device(), platform: this.options.platform };
    session.process.send({ type: 'open', job, passphrase });
    let reply = await session.process.next(READ_STALL_MS);
    while (reply?.type === 'reading') reply = await session.process.next(READ_STALL_MS);
    // Another file was chosen meanwhile, and this one let go.
    if (this.session !== session) return { ok: false, problem: 'missing' };
    if (!reply) {
      this.letGo();
      return { ok: false, problem: 'unreadable' };
    }
    session.idle = setTimeout(() => this.session === session && this.letGo(), IDLE_MS);
    if (reply.type === 'opened') {
      session.ready = true;
      return { ok: true, preview: { fileId, name: session.name, ...reply.preview } };
    }
    return { ok: false, problem: reply.type === 'problem' ? reply.problem : 'unreadable' };
  }

  /** Import the file read last into `windowId`'s Chord (never a private window's), reporting to `notify`. Returns at once; the import goes on. */
  run(fileId: string, choices: FileImportChoices, windowId: WindowId, notify: (progress: FileImportProgress) => void): FileRunResult {
    if (this.running) return { ok: false, problem: 'busy' };
    const session = this.session?.fileId === fileId && this.session.ready ? this.session : null;
    const win = this.options.state().windows[windowId];
    if (!session || !win || win.private) return { ok: false, problem: 'missing' };
    // The run owns the process from here.
    clearTimeout(session.idle);
    this.session = null;
    const importId = uuidv7();
    this.imports.set(importId, { notify, images: [] });
    const running: Running = { importId, process: session.process, cancelled: false, finished: Promise.resolve() };
    running.finished = this.work(running, session.name, choices, windowId)
      .catch((error: unknown) => console.error('Import failed:', error))
      .finally(() => {
        session.process.end();
        if (this.running === running) this.running = null;
      });
    this.running = running;
    return { ok: true, importId };
  }

  /** A part as the store takes it: Settings from the file pass the schema Settings' own changes do; the reducer checks the rest. */
  private checked(part: MergePart): MergePart {
    if (!part.settings) return part;
    const settings = ImportedSettings.safeParse(part.settings);
    const { settings: _unchecked, ...rest } = part;
    return settings.success ? { ...rest, settings: settings.data } : rest;
  }

  private async work(running: Running, name: string, choices: FileImportChoices, windowId: WindowId): Promise<void> {
    const { importId, process } = running;
    const record = this.imports.get(importId)!;
    const counts: FileImportCounts = { ...NONE };
    let total = 0;
    let done = 0;
    const report = (phase: FileImportProgress['phase']) => record.notify({ importId, phase, done, total, counts: { ...counts } });
    let failed = false;
    try {
      // What's pending is in chord.db, which the plan weighs the file against.
      await this.options.data.flush();
      const state = this.options.state();
      const chordId = state.windows[windowId]?.activeChordId ?? sortedChords(state)[0]?.id ?? '';
      report('setup');
      const planned = await process.ask({ type: 'plan', choices, chordId, scope: state.settings.duet.scope }, STEP_TIMEOUT_MS);
      if (planned?.type !== 'plan') throw new Error('no plan');
      Object.assign(counts, planned.counts);
      total = planned.history;
      report('setup');
      // A part at a time, each its own store change; asking for the next lets input and painting go first.
      let part = await process.ask({ type: 'more' }, STEP_TIMEOUT_MS);
      while (!running.cancelled && (part?.type === 'part' || part?.type === 'effects')) {
        if (part.type === 'part') this.options.dispatch({ t: 'data.merge', importId, ...this.checked(part.part) });
        else await this.options.effects.importSites(importId, part.sites);
        part = await process.ask({ type: 'more' }, STEP_TIMEOUT_MS);
      }
      if (running.cancelled) return;
      if (part?.type !== 'planned') throw new Error('the plan stopped');
      if (choices.history || choices.duet) {
        report(total > 0 ? 'history' : 'duet');
        process.send({ type: 'rest' }, [await within(this.options.data.port(importId), STEP_TIMEOUT_MS)]);
        for (;;) {
          const reply = await process.next(STEP_TIMEOUT_MS);
          if (running.cancelled) return;
          if (reply?.type === 'reading') continue;
          if (reply?.type === 'pages') {
            counts.pages += reply.added;
            done = reply.done;
            report('history');
            continue;
          }
          if (reply?.type === 'chats') {
            counts.chats += reply.threads.length;
            record.images.push(...reply.images);
            report('duet');
            continue;
          }
          if (reply?.type !== 'done') failed = true;
          break;
        }
        if (choices.duet) await this.options.duet()?.importChanged();
      }
    } catch (error) {
      if (running.cancelled) return;
      console.error('Import failed:', error);
      failed = true;
    }
    if (running.cancelled) return;
    report(failed ? 'failed' : 'done');
    // Whatever landed, even from an import that stopped part way, gets its Undo.
    const landed = Boolean(this.options.state().imports[importId]) || counts.pages > 0 || counts.chats > 0 || counts.effects > 0;
    const message = !failed ? importedText(counts) : landed ? `${importedText(counts)}. Chord couldn’t import all of it.` : `Chord couldn’t import ${name}`;
    this.options.toast(windowId, { id: `import:${importId}`, message, ...(landed ? { action: { label: 'Undo', command: { t: 'import.undo', importId } } } : {}) });
  }

  /**
   * Undo: a running import stops first; then what it updated goes back and
   * what it added goes, in parts as it came, then its history, chats (their
   * sessions end), Effects and the chats' images.
   */
  async undo(importId: string): Promise<void> {
    const record = this.imports.get(importId);
    if (!record) return;
    const running = this.running?.importId === importId ? this.running : null;
    if (running) {
      running.cancelled = true;
      running.process.end();
      await running.finished;
    }
    for (let i = 0; i < MAX_UNDO_PARTS && this.options.state().imports[importId]; i++) {
      this.options.dispatch({ t: 'import.undo', importId, limit: UNDO_PART });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const removed = await within(this.options.data.undo(importId), STEP_TIMEOUT_MS).catch(() => [] as DuetThread[]);
    await this.options.duet()?.importChanged(removed);
    await this.options.effects.undoImport(importId);
    await Promise.all(
      record.images.flatMap((image) => [
        rm(join(this.options.images, `${image.id}.${EXTENSIONS[image.mime] ?? 'jpg'}`), { force: true }),
        rm(join(this.options.images, `${image.id}.thumb.jpg`), { force: true }),
      ]),
    ).catch(() => undefined);
    record.notify({ importId, phase: 'undone', done: 0, total: 0, counts: { ...NONE } });
    this.imports.delete(importId);
  }

  /** Quitting: every import process stops, and the key with it. */
  async quit(): Promise<void> {
    if (this.running) this.running.cancelled = true;
    clearTimeout(this.session?.idle);
    const all = [...this.processes];
    for (const process of all) process.end();
    await Promise.all(all.map((process) => process.closed));
  }
}
