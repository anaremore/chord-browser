/**
 * Main's side of chord-data (ARCHITECTURE.md §6.2): changes are coalesced per
 * entity and written every 250 ms, flushed on quit (2-second cap). If the
 * utility process dies, the batch it was writing goes back in the queue and a
 * new process takes over, at most three times.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveReason, PersistedState, SavedEffects, State } from '@chord/core';
import {
  opKey,
  opsForState,
  opsFromPatches,
  type ArchiveEntry,
  type ArchivePage,
  type DataRequest,
  type DuetOp,
  type DuetResult,
  type DataResponse,
  type HistoryEvent,
  type NavState,
  type OpenTiming,
  type PathPatch,
  type SearchResult,
  type WriteOp,
} from '@chord/data';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';

const FLUSH_MS = 250;
const CLOSE_TIMEOUT_MS = 2000;
const MAX_RESTARTS = 3;

/** Waits before each further try at opening the database. */
const OPEN_RETRY_WAITS_MS = [250, 1000];

/**
 * SQLite errors that can pass: the disk briefly unavailable or another
 * process holding the file (seen once in CI as "disk I/O error" opening a
 * brand-new profile's database, which left Chord with no window).
 */
const TRANSIENT = /disk I\/O error|database is locked|database is busy|SQLITE_BUSY|SQLITE_IOERR/i;

/** Runs `attempt` until it succeeds, fails for a reason that won't pass, or the waits run out. */
export async function withRetries(
  attempt: () => Promise<DataResponse>,
  waits: readonly number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<DataResponse> {
  let response = await attempt();
  for (const ms of waits) {
    if (response.ok || !TRANSIENT.test(response.error)) break;
    await sleep(ms);
    response = await attempt();
  }
  return response;
}

/** A request before main numbers it. */
type Request = { [T in DataRequest['type']]: Omit<Extract<DataRequest, { type: T }>, 'id'> }[DataRequest['type']];

export class Persistence {
  private child!: UtilityProcess;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(r: DataResponse): void; reject(e: Error): void }>();
  private readonly pending = new Map<string, WriteOp>();
  private inFlight: WriteOp[] = [];
  /** History happenings, written in order with the next batch; never coalesced. */
  private events: HistoryEvent[] = [];
  private inFlightEvents: HistoryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private restarts = 0;
  private closed = false;

  private constructor(private readonly file: string) {}

  /** Start chord-data and read what was saved (null for a brand-new profile). Rows of unused profiles are dropped. */
  /** `timing` and `attempts`: how the open went, for the launch timeline. */
  static async open(
    file: string,
  ): Promise<{ persistence: Persistence; saved: PersistedState | null; navs: Record<string, NavState>; effects: SavedEffects[]; timing: OpenTiming | null; attempts: number }> {
    const persistence = new Persistence(file);
    persistence.spawn();
    // A disk that's busy for a moment gets two more tries before Chord gives up on the profile.
    let attempts = 0;
    const response = await withRetries(() => {
      attempts++;
      return persistence.request({ type: 'open', file, prune: true });
    }, OPEN_RETRY_WAITS_MS);
    if (!response.ok) throw new Error(response.error);
    return { persistence, saved: response.saved ?? null, navs: response.navs ?? {}, effects: response.effects ?? [], timing: response.timing ?? null, attempts };
  }

  private spawn(): void {
    this.child = utilityProcess.fork(join(import.meta.dirname, 'data.js'), [], { serviceName: 'Chord Data' });
    this.child.on('message', (response: DataResponse) => {
      const waiter = this.waiting.get(response.id);
      this.waiting.delete(response.id);
      waiter?.resolve(response);
    });
    this.child.once('exit', (code) => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error(`chord-data exited (${code})`));
      this.waiting.clear();
      if (this.closed) return;
      // Put the interrupted batch back, unless a newer write for the same entity is already queued.
      for (const op of this.inFlight) if (!this.pending.has(opKey(op))) this.pending.set(opKey(op), op);
      this.inFlight = [];
      this.events = [...this.inFlightEvents, ...this.events];
      this.inFlightEvents = [];
      if (this.restarts++ >= MAX_RESTARTS) {
        console.error('chord-data keeps exiting; changes are no longer being saved');
        return;
      }
      this.spawn();
      void this.request({ type: 'open', file: this.file }).then(() => this.schedule());
    });
  }

  private request(request: Request, transfer: MessagePortMain[] = []): Promise<DataResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.postMessage({ ...request, id }, transfer);
    });
  }

  /** Queue the entities a change touched. */
  record(patches: readonly PathPatch[], state: State): void {
    if (this.closed) return;
    for (const op of opsFromPatches(patches, state)) this.pending.set(opKey(op), op);
    if (this.pending.size > 0) this.schedule();
  }

  /** Queue a whole state (a brand-new profile's first save). */
  recordAll(state: State): void {
    for (const op of opsForState(state)) this.pending.set(opKey(op), op);
    this.schedule();
  }

  /** An open tab's back/forward history (never a private window's: the caller checks). */
  nav(nodeId: string, nav: NavState | null): void {
    if (this.closed) return;
    const op: WriteOp = { k: 'nav', id: nodeId, value: nav };
    this.pending.set(opKey(op), op);
    this.schedule();
  }

  /** A site's Effects (never a private window's: the caller checks), or null when the site has none any more. */
  effect(host: string, value: SavedEffects | null): void {
    if (this.closed) return;
    const op: WriteOp = { k: 'effect', id: host, value };
    this.pending.set(opKey(op), op);
    this.schedule();
  }

  /** A visit, a late title, a command bar pick, or a tab going to (or leaving) the archive. */
  history(event: HistoryEvent): void {
    if (this.closed) return;
    this.events.push(event);
    this.schedule();
  }

  /**
   * History, archived tabs and learned picks for what was typed in the command bar.
   * Pending writes go first, so a page visited or a tab archived a moment ago is found.
   */
  async search(query: string, chordId: string | null): Promise<SearchResult> {
    try {
      await this.flush();
      const response = await this.request({ type: 'search', query, chordId, now: Date.now() });
      return response.ok && response.search ? response.search : { history: [], choices: [], archive: [] };
    } catch {
      return { history: [], choices: [], archive: [] };
    }
  }

  /**
   * A port straight to chord-data for one import's history: the import
   * process sends its batches through it (`ImportBatch`, each answered), so
   * the pages never pass through main. Resolves once chord-data listens.
   */
  async importPort(importId: string): Promise<MessagePortMain> {
    const { port1, port2 } = new MessageChannelMain();
    const response = await this.request({ type: 'import.port', importId }, [port1]);
    if (!response.ok) throw new Error(response.error);
    return port2;
  }

  /** Take back what an import added to history (its Undo). */
  async undoImport(importId: string): Promise<void> {
    const response = await this.request({ type: 'import.undo', importId });
    if (!response.ok) throw new Error(response.error);
  }

  /** Duet's threads and messages. Throws if chord-data can't answer, so Duet can say so. */
  async duet(op: DuetOp): Promise<DuetResult> {
    const response = await this.request({ type: 'duet', op });
    if (!response.ok) throw new Error(response.error);
    return response.duet ?? {};
  }

  /** The archive page's entries. Pending writes go first, so a tab archived a moment ago is there. */
  async archiveList(query: string, limit: number): Promise<ArchivePage> {
    try {
      await this.flush();
      const response = await this.request({ type: 'archive.list', query, limit });
      return response.ok && response.archive ? response.archive : { items: [], more: false };
    } catch {
      return { items: [], more: false };
    }
  }

  /** One archive entry with its history, or the newest one archived for `reasons`. */
  async archiveEntry(which: { archiveId: string } | { reasons: ArchiveReason[] }): Promise<ArchiveEntry | null> {
    try {
      await this.flush();
      const response = await this.request('archiveId' in which ? { type: 'archive.get', archiveId: which.archiveId } : { type: 'archive.latest', reasons: which.reasons });
      return response.ok ? (response.entry ?? null) : null;
    } catch {
      return null;
    }
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  /** Write everything queued so far; batches go one at a time, in order. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(async () => {
      if (this.pending.size === 0 && this.events.length === 0) return;
      this.inFlight = [...this.pending.values()];
      this.pending.clear();
      this.inFlightEvents = this.events;
      this.events = [];
      try {
        const response = await this.request({ type: 'write', ops: this.inFlight, events: this.inFlightEvents });
        // A batch the database refuses would fail forever if retried; report it and move on.
        if (!response.ok) console.error('chord-data refused a write:', response.error);
        this.inFlight = [];
        this.inFlightEvents = [];
      } catch {
        // The process died mid-write; the exit handler has requeued the batch.
      }
    });
    return this.chain;
  }

  /** Flush and stop, giving up after two seconds so quitting never hangs. */
  async close(): Promise<void> {
    const done = this.flush().then(() => this.request({ type: 'close' }));
    await Promise.race([done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
    this.closed = true;
    this.child.kill();
  }
}

/**
 * Deletes the sign-ins (cookies, storage, cache) of profiles no chord uses:
 * every `<userData>/Partitions/p-<id>` folder whose profile isn't in `used`.
 * Runs at startup, before any session loads them. Only Chord's own `p-<id>`
 * folders qualify, so nothing else can be deleted through this.
 */
export async function removeUnusedPartitions(userData: string, used: ReadonlySet<string>): Promise<void> {
  const root = join(userData, 'Partitions');
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const id = /^p-([0-9a-f-]{8,64})$/i.exec(name)?.[1];
    if (id && !used.has(id)) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}
