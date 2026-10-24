/**
 * Import from other browsers (ARCHITECTURE.md §9), main's side. Finding and
 * reading profiles happens in the import utility process (src/import), one
 * process per step, each with a temp folder of copies removed when it ends.
 * Main decides where things land (core's planImport), adds them to the store
 * in parts so a big import never holds a frame up, and hands history to
 * chord-data a batch at a time, asking for the next batch only once the last
 * is written. One import runs at a time; its Undo (the toast, or Settings)
 * takes back the chords, folders, tabs, favorites and history it added.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countFolders,
  countLinks,
  defaultChoices,
  IMPORT_BROWSER_NAMES,
  importableTabs,
  importGroups,
  planImport,
  sortedChords,
  uuidv7,
  type ChordId,
  type ChordThemeSpec,
  type Command,
  type ImportChoices,
  type ImportedPage,
  type ImportPreview,
  type State,
  type WindowId,
} from '@chord/core';
import type { ImportCounts, ImportPreviewResult, ImportProblem, ImportProgress, ImportRunResult, ImportSource, ImportSummary, Toast } from '@chord/ipc';
import { PRESETS, presetStops, type PresetId } from '@chord/tokens';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { FoundProfile, ImportEnv } from '../import/detect';
import type { ImportReply, ImportRequest } from '../import/worker';

/** Folders and tabs added per store change: a few hundred patch a sidebar within a frame. */
const NODES_PER_STEP = 400;
const SCAN_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 120_000;
const BATCH_TIMEOUT_MS = 60_000;
/** Copies an import process never got to clean up (Chord was killed mid-import) go after a day. */
const STALE_MS = 86_400_000;
const PREFIX = 'chord-import-';
const MAX_PREVIEWS = 3;

export interface ImporterOptions {
  /** The import process's script, as built (out/main/import.js). */
  workerPath: string;
  env(): ImportEnv;
  state(): State;
  dispatch(command: Command): void;
  /** chord-data: a batch of history (resolves with the pages written), and an import's Undo. */
  history: { write(importId: string, pages: ImportedPage[]): Promise<number>; undo(importId: string): Promise<void> };
  toast(windowId: WindowId, toast: Toast): void;
}

/** A profile's handle for renderers: its folder, hashed. */
const keyOf = (profile: FoundProfile) => createHash('sha256').update(profile.dir).digest('hex').slice(0, 16);

const numbers = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${numbers.format(n)} ${n === 1 ? one : many}`;

/** "Chrome", "Chrome · Work" when it has several profiles, "Firefox (Flatpak)". */
function sourcesOf(profiles: FoundProfile[]): ImportSource[] {
  return profiles.map((p) => {
    const several = profiles.filter((o) => o.browser === p.browser).length > 1;
    const variant = p.variant === 'flatpak' ? ' (Flatpak)' : p.variant === 'snap' ? ' (Snap)' : '';
    return { key: keyOf(p), browser: p.browser, label: `${IMPORT_BROWSER_NAMES[p.browser]}${variant}${several ? ` · ${p.name}` : ''}`, denied: p.denied };
  });
}

export function summarize(key: string, preview: ImportPreview, chordId: ChordId): ImportSummary {
  const all = preview.roots.flatMap((r) => r.items);
  return {
    key,
    groups: importGroups(preview),
    bookmarks: countLinks(all),
    folders: countFolders(all),
    tabs: preview.tabs ? importableTabs(preview.tabs).length : null,
    history: preview.history,
    choices: defaultChoices(preview, chordId),
  };
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

/** One run of the import process, with a temp folder for its copies; the folder goes when the process ends, however it ends. */
class ImportProcess {
  private readonly child: UtilityProcess;
  private waiting: ((reply: ImportReply | null) => void) | null = null;
  private exited = false;

  private constructor(path: string, readonly temp: string) {
    this.child = utilityProcess.fork(path, [], { serviceName: 'Chord Import', stdio: 'ignore' });
    this.child.on('message', (reply: ImportReply) => this.settle(reply));
    this.child.once('exit', () => {
      this.exited = true;
      this.settle(null);
      void rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
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

  /** The reply to `request`; null if the process ended, or took too long (it's stopped then). */
  ask(request: ImportRequest, timeoutMs: number): Promise<ImportReply | null> {
    if (this.exited) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(null);
        this.end();
      }, timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.child.postMessage(request);
    });
  }

  end(): void {
    this.child.kill();
  }
}

interface Running {
  importId: string;
  cancelled: boolean;
  finished: Promise<void>;
}

export class Importer {
  /** The profiles the last search found, by key: renderers name one, never a path. */
  private profiles = new Map<string, FoundProfile>();
  /** The profiles read lately, by key, until one is imported (a few at most: switching back and forth needs no new read). */
  private readonly previews = new Map<string, ImportPreview>();
  private running: Running | null = null;
  /** Where each import reports, for Undo's report too. */
  private readonly notifiers = new Map<string, (progress: ImportProgress) => void>();
  private swept = false;

  constructor(private readonly options: ImporterOptions) {}

  private async once(request: (temp: string) => ImportRequest, timeoutMs: number): Promise<ImportReply | null> {
    const process = await ImportProcess.start(this.options.workerPath);
    try {
      return await process.ask(request(process.temp), timeoutMs);
    } finally {
      process.end();
    }
  }

  /** The browsers and profiles on this computer. */
  async sources(): Promise<ImportSource[]> {
    void this.sweep();
    const reply = await this.once(() => ({ type: 'scan', env: this.options.env() }), SCAN_TIMEOUT_MS);
    const profiles = reply?.type === 'profiles' ? reply.profiles : [];
    this.profiles = new Map(profiles.map((p) => [keyOf(p), p]));
    return sourcesOf(profiles);
  }

  /** Read a profile and count what it holds, with each group's mapping to start from (new chords, or `chordId`). */
  async read(key: string, chordId: ChordId): Promise<ImportPreviewResult> {
    const profile = this.profiles.get(key);
    if (!profile) return { ok: false, problem: 'missing' };
    if (profile.denied) return { ok: false, problem: 'denied' };
    const reply = await this.once((temp) => ({ type: 'read', profile, temp }), READ_TIMEOUT_MS);
    if (reply?.type === 'error') return { ok: false, problem: reply.problem };
    if (reply?.type !== 'preview') return { ok: false, problem: 'unreadable' };
    this.previews.delete(key);
    this.previews.set(key, reply.preview);
    for (const old of [...this.previews.keys()].slice(0, -MAX_PREVIEWS)) this.previews.delete(old);
    return { ok: true, summary: summarize(key, reply.preview, chordId) };
  }

  /**
   * Import the profile read last into `windowId`'s chords (never a private
   * window), reporting to `notify`. Returns at once; the import goes on.
   */
  run(key: string, choices: ImportChoices, windowId: WindowId, notify: (progress: ImportProgress) => void): ImportRunResult {
    if (this.running) return { ok: false, problem: 'busy' };
    const profile = this.profiles.get(key);
    const preview = this.previews.get(key);
    const state = this.options.state();
    const win = state.windows[windowId];
    if (!profile || !preview || !win || win.private) return { ok: false, problem: 'missing' };
    this.previews.clear();
    const importId = uuidv7();
    this.notifiers.set(importId, notify);
    const running: Running = { importId, cancelled: false, finished: Promise.resolve() };
    running.finished = this.work(running, profile, preview, choices, windowId)
      .catch((error: unknown) => {
        // What landed stays, with Undo still possible from Settings.
        console.error('Import failed:', error);
        notify({ importId, phase: 'failed', done: 0, total: 0, counts: { bookmarks: 0, folders: 0, chords: 0, favorites: 0, tabs: 0, pages: 0 }, problem: 'unreadable' });
      })
      .finally(() => {
        if (this.running === running) this.running = null;
      });
    this.running = running;
    return { ok: true, importId };
  }

  private async work(running: Running, profile: FoundProfile, preview: ImportPreview, choices: ImportChoices, windowId: WindowId): Promise<void> {
    const { importId } = running;
    const state = this.options.state();
    const fallback = state.windows[windowId]?.activeChordId ?? sortedChords(state)[0]?.id ?? '';
    const plan = planImport(state, preview, choices, { importId, now: Date.now(), newId: () => uuidv7(), themes: themesFor(state), fallbackChordId: fallback });
    const counts: ImportCounts = { ...plan.counts, pages: 0 };
    const total = choices.history ? preview.history : 0;
    const report = (phase: ImportProgress['phase'], problem?: ImportProblem) =>
      this.notifiers.get(importId)?.({ importId, phase, done: counts.pages, total, counts: { ...counts }, ...(problem ? { problem } : {}) });

    report('bookmarks');
    if (plan.chords.length > 0 || plan.favorites.length > 0 || plan.nodes.length > 0) {
      this.options.dispatch({ t: 'import.add', importId, chords: plan.chords, favorites: plan.favorites, nodes: plan.nodes.slice(0, NODES_PER_STEP) });
      for (let at = NODES_PER_STEP; at < plan.nodes.length && !running.cancelled; at += NODES_PER_STEP) {
        // A turn of the event loop between parts: input, IPC and painting go first.
        await new Promise((resolve) => setImmediate(resolve));
        this.options.dispatch({ t: 'import.add', importId, nodes: plan.nodes.slice(at, at + NODES_PER_STEP) });
      }
    }
    let problem: ImportProblem | undefined;
    if (total > 0 && !running.cancelled) {
      report('history');
      problem = await this.history(running, profile, counts, () => report('history'));
    }
    if (running.cancelled) return;
    report(problem ? 'failed' : 'done', problem);
    const browser = IMPORT_BROWSER_NAMES[profile.browser];
    const message = problem ? `${doneMessage(counts, browser)}. Chord couldn’t read all of its history.` : doneMessage(counts, browser);
    const added = counts.tabs + counts.bookmarks + counts.favorites + counts.chords + counts.pages > 0;
    this.options.toast(windowId, { id: `import:${importId}`, message, ...(added ? { action: { label: 'Undo', command: { t: 'import.undo', importId } } } : {}) });
  }

  /** History, a batch at a time: read in the import process, written by chord-data, the next asked for once it's in. */
  private async history(running: Running, profile: FoundProfile, counts: ImportCounts, progress: () => void): Promise<ImportProblem | undefined> {
    const process = await ImportProcess.start(this.options.workerPath);
    try {
      let reply = await process.ask({ type: 'history', profile, temp: process.temp }, BATCH_TIMEOUT_MS);
      while (reply?.type === 'pages') {
        if (running.cancelled) return undefined;
        counts.pages += await this.options.history.write(running.importId, reply.pages);
        progress();
        reply = await process.ask({ type: 'more' }, BATCH_TIMEOUT_MS);
      }
      if (reply?.type === 'error') return reply.problem;
      return reply?.type === 'done' ? undefined : 'unreadable';
    } catch {
      return 'unreadable';
    } finally {
      process.end();
    }
  }

  /** Undo: a running import stops first; then what it added goes, history included. */
  async undo(importId: string): Promise<void> {
    const running = this.running?.importId === importId ? this.running : null;
    if (running) {
      running.cancelled = true;
      await running.finished;
    }
    this.options.dispatch({ t: 'import.undo', importId });
    await this.options.history.undo(importId).catch(() => undefined);
    this.notifiers.get(importId)?.({ importId, phase: 'undone', done: 0, total: 0, counts: { bookmarks: 0, folders: 0, chords: 0, favorites: 0, tabs: 0, pages: 0 } });
    this.notifiers.delete(importId);
  }

  /** Copies left behind by import processes that never finished (Chord was killed): gone after a day. */
  private async sweep(): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    const base = tmpdir();
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = join(base, name);
      const s = await stat(dir).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
