/**
 * Import from other browsers (ARCHITECTURE.md §9), main's side, which only
 * routes (performance rules 1 and 4). The import process (src/import) finds
 * profiles, reads the one you pick from copies of its files, keeps it, and
 * plans the import; main hands it a small summary of the state, adds what it
 * plans to the store a part at a time, and connects it straight to
 * chord-data for the history, hearing only how far it's got. One import runs
 * at a time; its Undo (the toast, or Settings) takes back the chords,
 * folders, tabs, favorites and history it added.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMPORT_BROWSER_NAMES,
  importContext,
  sortedChords,
  uuidv7,
  type ChordId,
  type ChordThemeSpec,
  type Command,
  type ImportChoices,
  type State,
  type WindowId,
} from '@chord/core';
import type { ImportCounts, ImportPreviewResult, ImportProblem, ImportProgress, ImportRunResult, ImportSource, Toast } from '@chord/ipc';
import { PRESETS, presetStops, type PresetId } from '@chord/tokens';
import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { FoundProfile, ImportEnv } from '../import/detect';
import type { ImportReply, ImportRequest } from '../import/worker';

const SCAN_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 120_000;
/** A step of the plan, or a batch of history. */
const STEP_TIMEOUT_MS = 60_000;
/** A profile read but not imported is let go after this, with its copies. */
const IDLE_MS = 10 * 60_000;
/** Copies an import process never got to clean up (Chord was killed mid-import), swept once they're this old. */
const STALE_MS = 60 * 60_000;
/** Folders and tabs an Undo takes away per store change, as the import added them. */
const UNDO_PART = 200;
const MAX_UNDO_PARTS = 10_000;
const PREFIX = 'chord-import-';

export interface ImporterOptions {
  /** The import process's script, as built (out/main/import.js). */
  workerPath: string;
  env(): ImportEnv;
  state(): State;
  dispatch(command: Command): void;
  /** chord-data: a port for an import's history batches, and an import's Undo. */
  history: { port(importId: string): Promise<MessagePortMain>; undo(importId: string): Promise<void> };
  toast(windowId: WindowId, toast: Toast): void;
}

/** A profile's handle for renderers: its folder, hashed. */
const keyOf = (profile: FoundProfile) => createHash('sha256').update(profile.dir).digest('hex').slice(0, 16);

const numbers = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${numbers.format(n)} ${n === 1 ? one : many}`;
const NONE: ImportCounts = { bookmarks: 0, folders: 0, chords: 0, favorites: 0, tabs: 0, pages: 0 };

/** "Chrome", "Chrome · Work" when it has several profiles, "Firefox (Flatpak)". */
function sourcesOf(profiles: FoundProfile[]): ImportSource[] {
  return profiles.map((p) => {
    const several = profiles.filter((o) => o.browser === p.browser).length > 1;
    const variant = p.variant === 'flatpak' ? ' (Flatpak)' : p.variant === 'snap' ? ' (Snap)' : '';
    return { key: keyOf(p), browser: p.browser, label: `${IMPORT_BROWSER_NAMES[p.browser]}${variant}${several ? ` · ${p.name}` : ''}`, denied: p.denied };
  });
}

/** New chords' colors: the presets in turn, starting after as many as there are chords, so they differ from the ones you have. */
function themesFor(state: State): ChordThemeSpec[] {
  const ids = Object.keys(PRESETS) as PresetId[];
  const start = sortedChords(state).length;
  return ids.map((_, i) => ids[(start + i) % ids.length]!).map((id) => ({ stops: presetStops(id), grain: 0.2, appearance: 'auto', themeId: `preset:${id}` }));
}

/** "Imported 6 tabs, 1,204 bookmarks and 34,551 pages of history from Chrome". */
export function doneMessage(counts: ImportCounts, browser: string): string {
  const parts = [
    counts.tabs > 0 ? plural(counts.tabs, 'tab') : '',
    counts.bookmarks + counts.favorites > 0 ? plural(counts.bookmarks + counts.favorites, 'bookmark') : '',
    counts.pages > 0 ? `${plural(counts.pages, 'page')} of history` : '',
  ].filter(Boolean);
  if (parts.length === 0) return `Nothing to import from ${browser}`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Imported ${list} from ${browser}`;
}

/** A promise that gives up after `ms` (chord-data that never answers mustn't hold an import or its Undo forever). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * One import process, with a temp folder for its copies; the folder goes
 * when the process ends, however it ends (`closed` says when it's gone).
 * Replies that arrive before they're asked for wait in order.
 */
class ImportProcess {
  private readonly child: UtilityProcess;
  private readonly inbox: ImportReply[] = [];
  private waiting: ((reply: ImportReply | null) => void) | null = null;
  private exited = false;
  readonly closed: Promise<void>;

  private constructor(path: string, readonly temp: string) {
    this.child = utilityProcess.fork(path, [], { serviceName: 'Chord Import', stdio: 'ignore' });
    this.child.on('message', (reply: ImportReply) => {
      if (this.waiting) this.settle(reply);
      else this.inbox.push(reply);
    });
    this.closed = new Promise((resolve) => {
      this.child.once('exit', () => {
        this.exited = true;
        this.settle(null);
        void rm(temp, { recursive: true, force: true, maxRetries: 3 })
          .catch(() => undefined)
          .then(() => resolve());
      });
    });
  }

  static async start(path: string): Promise<ImportProcess> {
    return new ImportProcess(path, await mkdtemp(join(tmpdir(), PREFIX)));
  }

  private settle(reply: ImportReply | null): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(reply);
  }

  send(request: ImportRequest, transfer: MessagePortMain[] = []): void {
    if (!this.exited) this.child.postMessage(request, transfer);
  }

  /** The next reply; null if the process ended, took too long (it's stopped then), or is already being waited on. */
  next(timeoutMs: number): Promise<ImportReply | null> {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift()!);
    if (this.exited || this.waiting) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(null);
        this.end();
      }, timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
    });
  }

  ask(request: ImportRequest, timeoutMs: number): Promise<ImportReply | null> {
    this.send(request);
    return this.next(timeoutMs);
  }

  end(): void {
    this.child.kill();
  }
}

/** A profile read and kept by its own import process, until it's imported or let go. */
interface Session {
  key: string;
  profile: FoundProfile;
  process: ImportProcess;
  /** Read, and kept: it can be imported. */
  ready: boolean;
  /** Pages of history it has. */
  history: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}

interface Running {
  importId: string;
  process: ImportProcess;
  cancelled: boolean;
  finished: Promise<void>;
}

export class Importer {
  /** The profiles the last search found, by key: renderers name one, never a path. */
  private profiles = new Map<string, FoundProfile>();
  private session: Session | null = null;
  private running: Running | null = null;
  /** Every import process alive, so quitting can end them all and wait for their copies to go. */
  private readonly processes = new Set<ImportProcess>();
  /** Where each import reports, for Undo's report too. */
  private readonly notifiers = new Map<string, (progress: ImportProgress) => void>();

  constructor(private readonly options: ImporterOptions) {}

  private async start(): Promise<ImportProcess> {
    const process = await ImportProcess.start(this.options.workerPath);
    this.processes.add(process);
    void process.closed.then(() => this.processes.delete(process));
    return process;
  }

  private letGo(): void {
    if (!this.session) return;
    clearTimeout(this.session.idle);
    this.session.process.end();
    this.session = null;
  }

  /** The browsers and profiles on this computer. */
  async sources(): Promise<ImportSource[]> {
    const process = await this.start();
    try {
      const reply = await process.ask({ type: 'scan', env: this.options.env() }, SCAN_TIMEOUT_MS);
      const profiles = reply?.type === 'profiles' ? reply.profiles : [];
      this.profiles = new Map(profiles.map((p) => [keyOf(p), p]));
      return sourcesOf(profiles);
    } finally {
      process.end();
    }
  }

  /** Read a profile in a process of its own, which keeps it; groups start out mapped to new chords, or `chordId`. */
  async read(key: string, chordId: ChordId): Promise<ImportPreviewResult> {
    const profile = this.profiles.get(key);
    if (!profile) return { ok: false, problem: 'missing' };
    if (profile.denied) return { ok: false, problem: 'denied' };
    if (this.running) return { ok: false, problem: 'busy' };
    const process = await this.start();
    // Whatever was read before, or started reading meanwhile, is let go: one kept profile at a time.
    this.letGo();
    const session: Session = { key, profile, process, ready: false, history: 0, idle: undefined };
    this.session = session;
    const reply = await process.ask({ type: 'read', profile, temp: process.temp, chordId }, READ_TIMEOUT_MS);
    // Another profile was picked meanwhile, and this one let go (its process has ended).
    if (this.session !== session) return { ok: false, problem: 'missing' };
    if (reply?.type !== 'overview') {
      this.letGo();
      return { ok: false, problem: reply?.type === 'error' ? reply.problem : 'unreadable' };
    }
    session.ready = true;
    session.history = reply.overview.history;
    session.idle = setTimeout(() => this.session === session && this.letGo(), IDLE_MS);
    return { ok: true, summary: { key, ...reply.overview } };
  }

  /**
   * Import the profile read last into `windowId`'s chords (never a private
   * window), reporting to `notify`. Returns at once; the import goes on.
   */
  run(key: string, choices: ImportChoices, windowId: WindowId, notify: (progress: ImportProgress) => void): ImportRunResult {
    if (this.running) return { ok: false, problem: 'busy' };
    const session = this.session?.key === key && this.session.ready ? this.session : null;
    const win = this.options.state().windows[windowId];
    if (!session || !win || win.private) return { ok: false, problem: 'missing' };
    // The run owns the process from here.
    clearTimeout(session.idle);
    this.session = null;
    const importId = uuidv7();
    this.notifiers.set(importId, notify);
    const running: Running = { importId, process: session.process, cancelled: false, finished: Promise.resolve() };
    running.finished = this.work(running, session, choices, windowId)
      .catch((error: unknown) => console.error('Import failed:', error))
      .finally(() => {
        session.process.end();
        if (this.running === running) this.running = null;
      });
    this.running = running;
    return { ok: true, importId };
  }

  private async work(running: Running, session: Session, choices: ImportChoices, windowId: WindowId): Promise<void> {
    const { importId, process } = running;
    const counts: ImportCounts = { ...NONE };
    const total = choices.history ? session.history : 0;
    const report = (phase: ImportProgress['phase'], problem?: ImportProblem) =>
      this.notifiers.get(importId)?.({ importId, phase, done: counts.pages, total, counts: { ...counts }, ...(problem ? { problem } : {}) });
    let problem: ImportProblem | undefined;
    try {
      const state = this.options.state();
      const fallbackChordId = state.windows[windowId]?.activeChordId ?? sortedChords(state)[0]?.id ?? '';
      const planned = await process.ask({ type: 'plan', importId, choices, context: importContext(state), themes: themesFor(state), fallbackChordId }, STEP_TIMEOUT_MS);
      if (planned?.type !== 'plan') throw new Error(`no plan (${planned?.type === 'error' ? planned.problem : 'no answer'})`);
      report('bookmarks');
      if (planned.chords.length > 0 || planned.favorites.length > 0) this.options.dispatch({ t: 'import.add', importId, chords: planned.chords, favorites: planned.favorites });
      counts.chords = planned.counts.chords;
      counts.favorites = planned.counts.favorites;
      // A part at a time, each its own store change; asking for the next lets input and painting go first.
      let part = await process.ask({ type: 'more' }, STEP_TIMEOUT_MS);
      while (part?.type === 'nodes' && !running.cancelled) {
        this.options.dispatch({ t: 'import.add', importId, nodes: part.nodes });
        for (const node of part.nodes) {
          if (node.kind === 'folder') counts.folders++;
          else if (node.section === 'today') counts.tabs++;
          else counts.bookmarks++;
        }
        part = await process.ask({ type: 'more' }, STEP_TIMEOUT_MS);
      }
      if (running.cancelled) return;
      if (part?.type !== 'planned') throw new Error('the plan stopped');

      if (total > 0) {
        report('history');
        process.send({ type: 'history', importId }, [await within(this.options.history.port(importId), STEP_TIMEOUT_MS)]);
        for (;;) {
          const batch = await process.next(STEP_TIMEOUT_MS);
          if (running.cancelled) return;
          if (batch?.type === 'pages') {
            counts.pages += batch.added;
            report('history');
            continue;
          }
          if (batch?.type !== 'done') problem = batch?.type === 'error' ? batch.problem : 'unreadable';
          break;
        }
      }
    } catch (error) {
      if (running.cancelled) return;
      console.error('Import failed:', error);
      problem ??= 'unreadable';
    }
    if (running.cancelled) return;
    report(problem ? 'failed' : 'done', problem);
    // Whatever landed, even from an import that stopped part way, gets its Undo.
    const browser = IMPORT_BROWSER_NAMES[session.profile.browser];
    const landed = Boolean(this.options.state().imports[importId]) || counts.pages > 0;
    const message = !problem ? doneMessage(counts, browser) : landed ? `${doneMessage(counts, browser)}. Chord couldn’t read all of it.` : `Chord couldn’t import from ${browser}`;
    this.options.toast(windowId, { id: `import:${importId}`, message, ...(landed ? { action: { label: 'Undo', command: { t: 'import.undo', importId } } } : {}) });
  }

  /** Undo: a running import stops first; then what it added goes, in parts as it came, history included. */
  async undo(importId: string): Promise<void> {
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
    await within(this.options.history.undo(importId), STEP_TIMEOUT_MS).catch(() => undefined);
    this.notifiers.get(importId)?.({ importId, phase: 'undone', done: 0, total: 0, counts: NONE });
    this.notifiers.delete(importId);
  }

  /** Quitting: every import process stops, and its copies are gone before Chord is. */
  async quit(): Promise<void> {
    if (this.running) this.running.cancelled = true;
    clearTimeout(this.session?.idle);
    const all = [...this.processes];
    for (const process of all) process.end();
    await Promise.all(all.map((process) => process.closed));
  }

  /**
   * Copies left behind by an import process that never got to clean up (a
   * killed Chord): main calls this a while after launch.
   */
  async sweep(): Promise<void> {
    const base = tmpdir();
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = join(base, name);
      const s = await stat(dir).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
