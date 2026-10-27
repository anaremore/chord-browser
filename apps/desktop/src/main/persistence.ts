/**
 * Main's side of chord-data (ARCHITECTURE.md §6.2): changes are coalesced per
 * entity and written every 250 ms, flushed on quit (2-second cap). If the
 * utility process dies, the batch it was writing goes back in the queue and a
 * new process takes over, at most three times.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveReason, DuetThread, ExportCounts, PersistedState, SavedEffects, State } from '@chord/core';
import {
  opKey,
  opOrigin,
  opsForState,
  opsFromPatches,
  coalesceOps,
  type ArchiveEntry,
  type ArchivePage,
  type DataRequest,
  type DuetOp,
  type DuetResult,
  type DataPush,
  type DataResponse,
  type HistoryEvent,
  type NavState,
  type OpenTiming,
  type Origin,
  type PathPatch,
  type SearchResult,
  type SyncReply,
  type SyncRequest,
  type WriteOp,
  type WriteSeq,
} from '@chord/data';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';

const FLUSH_MS = 250;
/** Entities per write past which a flush goes in several, each a transaction of a few milliseconds. */
const WRITE_CHUNK = 100;
/**
 * Fewer when they're what another computer changed: each also notes the thing
 * in sync's copy, so 100 took up to 9 ms, 50 up to 8, and a search that came in
 * behind one, and behind a merged slice, waited for both. 25 is 2 to 4 ms.
 */
const SYNC_WRITE_CHUNK = 25;
const CLOSE_TIMEOUT_MS = 2000;
/** How long, and past how many entities, persistence remembers when it last wrote a change of yours to each (`waitingHere`). */
const WRITTEN_MS = 5 * 60_000;
const WRITTEN_KEEP = 2000;
const MAX_RESTARTS = 3;

/** Waits before each further try at opening the database. */
const OPEN_RETRY_WAITS_MS = [250, 1000];

/**
 * SQLite errors that can pass: the disk briefly unavailable or another
 * process holding the file (seen once in CI as "disk I/O error" opening a
 * brand-new profile's database, which left Chord with no window).
 */
const TRANSIENT = /disk I\/O error|database is locked|database is busy|SQLITE_BUSY|SQLITE_IOERR/i;

/**
 * A write chord-data refused for a reason that can pass (a full disk, an I/O
 * error, a lock): never dropped. chord-data says which by SQLite's result code
 * (`passing`: FULL, IOERR, BUSY, LOCKED, READONLY); its entities and history
 * go back in the queue, and are sent again later and later, up to
 * WRITE_RETRY_MAX; past WRITE_TROUBLE tries the app says so. One refused for
 * what's in it would fail for ever, and is still dropped (and logged).
 */
const PASSING = /disk I\/O error|database is locked|database is busy|database or disk is full|SQLITE_BUSY|SQLITE_IOERR|SQLITE_FULL/i;
export const refusalPasses = (response: { error?: string; passing?: boolean }): boolean => response.passing ?? PASSING.test(response.error ?? '');
const WRITE_RETRY_MS = 2000;
const WRITE_RETRY_MAX = 5 * 60_000;
const WRITE_TROUBLE = 3;

/**
 * The next batch of a flush: at most `chunk` entities, chords that are kept
 * first (a node's chord is in before it). A chord going takes its node rows
 * with it, so it goes in one transaction with every node's move and deletion
 * waiting (and their back/forward histories), last in it, however many that
 * makes: the open tabs it hands to the next chord have moved before it goes,
 * and a stop between batches can't leave it there, partly emptied.
 */
export function nextBatch(ops: readonly WriteOp[], chunk: number): WriteOp[] {
  const gone = ops.filter((op) => op.k === 'chord' && op.value === null);
  if (ops.length <= chunk && gone.length === 0) return [...ops];
  const kept = ops.filter((op) => op.k === 'chord' && op.value !== null);
  const rest = ops.filter((op) => op.k !== 'chord');
  if (gone.length === 0) return [...kept, ...rest].slice(0, chunk);
  const nodes = rest.filter((op) => op.k === 'node' || op.k === 'nav');
  const others = rest.filter((op) => op.k !== 'node' && op.k !== 'nav');
  return [...kept, ...nodes, ...others.slice(0, Math.max(0, chunk - kept.length - nodes.length - gone.length)), ...gone];
}

/** A write's entity and side, for what's refused (`retained`): yours, or another computer's or tidying's (`#auto`). */
const queueKey = (op: WriteOp): string => (opOrigin(op) === 'user' ? opKey(op) : `${opKey(op)}#auto`);
const yours = (op: WriteOp): boolean => opOrigin(op) === 'user';

/**
 * Writes waiting, in the order they're sent, each entity's in turns (S15 §13).
 * A change of yours is never folded into another computer's or tidying's,
 * nor theirs into yours: each turn holds one side's writes of the entity,
 * folded, and a change from the other side starts a new turn after
 * everything. So yours is stamped against what sync applied before it, and
 * never after what sync applied since (a theme another computer deleted,
 * brought back by yours).
 */
class WriteQueue {
  private slots = new Map<string, WriteOp>();
  private readonly turns = new Map<string, string[]>();
  private n = 0;

  get size(): number {
    return this.slots.size;
  }

  values(): IterableIterator<WriteOp> {
    return this.slots.values();
  }

  /** An entity's turns waiting, oldest first. */
  turnsOf(entity: string): [string, WriteOp][] {
    return (this.turns.get(entity) ?? []).map((slot) => [slot, this.slots.get(slot)!]);
  }

  /** A turn's write, in its place. */
  set(slot: string, op: WriteOp): void {
    this.slots.set(slot, op);
  }

  /** A new turn of its entity, after everything. */
  append(op: WriteOp): void {
    const slot = `${opKey(op)}#${++this.n}`;
    this.slots.set(slot, op);
    this.turns.set(opKey(op), [...(this.turns.get(opKey(op)) ?? []), slot]);
  }

  /** Put back ahead of everything, in their order, each a turn of its own. */
  prepend(ops: readonly WriteOp[]): void {
    const entries = ops.map((op): [string, WriteOp] => [`${opKey(op)}#${++this.n}`, op]);
    this.slots = new Map([...entries, ...this.slots]);
    for (const [slot, op] of [...entries].reverse()) this.turns.set(opKey(op), [slot, ...(this.turns.get(opKey(op)) ?? [])]);
  }

  delete(slot: string): void {
    const op = this.slots.get(slot);
    if (!op) return;
    this.slots.delete(slot);
    const left = (this.turns.get(opKey(op)) ?? []).filter((s) => s !== slot);
    if (left.length > 0) this.turns.set(opKey(op), left);
    else this.turns.delete(opKey(op));
  }

  /** These, taken to be written. */
  take(ops: readonly WriteOp[]): void {
    const taken = new Set(ops);
    for (const [slot, op] of [...this.slots]) if (taken.has(op)) this.delete(slot);
  }
}

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
  /** Writes waiting, in the order they're sent, each entity's in turns, yours and others' apart. */
  private readonly pending = new WriteQueue();
  private inFlight: WriteOp[] = [];
  /** History happenings, written in order with the next batch; never coalesced. */
  private events: HistoryEvent[] = [];
  private inFlightEvents: HistoryEvent[] = [];
  /** The batch being written, answered or not. */
  private inFlightDone: Promise<unknown> = Promise.resolve();
  /** History's happenings sent ahead of the queue for a search (`flushEvents`), until written. */
  private sideEvents: HistoryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private restarts = 0;
  private closed = false;
  /** A refused batch waiting to be sent again (`refusalPasses`), and how many tries in a row have failed. */
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 0;
  private refusals = 0;
  /** Writes refused for now and not written yet, by `queueKey`, with who they're from: sync's are `unsaved`. */
  private readonly retained = new Map<string, Origin>();
  /** When a change of yours to each entity was last written (the last WRITTEN_MS of them): `waitingHere`'s `since`. */
  private readonly writtenAt = new Map<string, { seq: WriteSeq; at: number }>();
  /** History's happenings in the order they happened, so a batch put back never goes ahead of a later one (an `unarchive` before its `archive`). */
  private readonly eventOrder = new WeakMap<HistoryEvent, number>();
  private eventCount = 0;
  private trouble: (failing: boolean) => void = () => undefined;
  /** What chord-data says unasked (sync's changes to apply, and where it stands), and that it started again after a crash. */
  private pushed: (push: DataPush) => void = () => undefined;
  private respawned: () => void = () => undefined;

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
    this.child.on('message', (response: DataResponse | DataPush) => {
      if ('push' in response) return void this.pushed(response);
      const waiter = this.waiting.get(response.id);
      this.waiting.delete(response.id);
      waiter?.resolve(response);
    });
    this.child.once('exit', (code) => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error(`chord-data exited (${code})`));
      this.waiting.clear();
      if (this.closed) return;
      // Put the interrupted batch back, unless a newer write for the same entity is already queued.
      this.requeue(this.inFlight);
      this.inFlight = [];
      this.events = this.inOrder([...this.inFlightEvents, ...this.sideEvents, ...this.events]);
      this.inFlightEvents = [];
      this.sideEvents = [];
      if (this.restarts++ >= MAX_RESTARTS) {
        console.error('chord-data keeps exiting; changes are no longer being saved');
        return;
      }
      this.spawn();
      void this.request({ type: 'open', file: this.file }).then(() => {
        this.schedule();
        this.respawned();
      });
    });
  }

  private request(request: Request, transfer: MessagePortMain[] = []): Promise<DataResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.postMessage({ ...request, id }, transfer);
    });
  }

  /**
   * Queue the entities a change touched, as from `origin` (S15 §13): yours
   * (`user`) are stamped; another computer's applied (`sync`) and this
   * computer's tidying (`tidy`) never are. `before`: the state before the
   * change, so what you took out of a list written whole is known.
   */
  record(patches: readonly PathPatch[], state: State, origin: Origin = 'user', before?: State): void {
    if (this.closed) return;
    for (const op of opsFromPatches(patches, state, before)) this.put(origin === 'user' ? op : { ...op, origin });
    if (this.pending.size > 0) this.schedule();
  }

  private put(op: WriteOp): void {
    const entity = opKey(op);
    if (!yours(op)) {
      // Theirs again: the newer in its place, if theirs is the entity's latest turn; after yours, if yours is.
      const last = this.pending.turnsOf(entity).at(-1);
      if (last && !yours(last[1])) this.pending.set(last[0], op);
      else this.pending.append(op);
      return;
    }
    // When you made it: stamped as of then, however long its write waits.
    op = { ...op, at: Date.now() };
    let last = this.pending.turnsOf(entity).at(-1);
    // Yours takes the place of sync's or tidying's waiting where theirs takes it away: you brought it back, later.
    if (last && !yours(last[1]) && last[1].value === null) {
      this.pending.delete(last[0]);
      this.retained.delete(queueKey(last[1]));
      last = this.pending.turnsOf(entity).at(-1);
    }
    // A change of yours the latest: this one in its place, with what it said (it took the entity out of sync, say). After
    // theirs (a change of what sync applied and hasn't written yet: an edit, or taking it away), a turn of its own:
    // chord-data then knows what you changed of it (a field), and what it was when it went, and doesn't take all of it
    // for yours; and what of yours was before theirs stays before it.
    if (last && yours(last[1])) this.pending.set(last[0], coalesceOps(last[1], op));
    else this.pending.append(op);
  }

  /**
   * A batch back in the queue, ahead of what came since, in its own order; an
   * entity written again meanwhile on the same side first keeps the newer
   * write, with what the one put back said (`coalesceOps`).
   */
  private requeue(ops: readonly WriteOp[]): void {
    const back: WriteOp[] = [];
    for (const op of ops) {
      const first = this.pending.turnsOf(opKey(op))[0];
      if (first && yours(first[1]) === yours(op)) this.pending.set(first[0], coalesceOps(op, first[1]));
      else back.push(op);
    }
    if (back.length > 0) this.pending.prepend(back);
  }

  /** History's happenings in the order they happened. */
  private inOrder(events: HistoryEvent[]): HistoryEvent[] {
    return events.sort((a, b) => (this.eventOrder.get(a) ?? 0) - (this.eventOrder.get(b) ?? 0));
  }

  /**
   * Whether a change of yours to this entity (`node:<id>`, `setting:<key>`…)
   * is waiting to be written, or being written, or was taken after the write
   * `since` (chord-data read what sync is about to apply after it): sync puts
   * off applying another computer's to it until it's written and stamped, and
   * read again (main/sync.ts).
   */
  waitingHere(key: string, since?: WriteSeq): boolean {
    if (this.pending.turnsOf(key).some(([, op]) => yours(op))) return true;
    if (this.inFlight.some((op) => opOrigin(op) === 'user' && opKey(op) === key)) return true;
    // Taken since then: what sync read of it then is older than what chord.db has now.
    const written = this.writtenAt.get(key);
    return since !== undefined && written !== undefined && written.seq.run === since.run && written.seq.n > since.n;
  }

  /** A batch of yours is in: which write it was, by entity, for `waitingHere`'s `since` (the last few minutes' only). */
  private wroteYours(ops: readonly WriteOp[], seq: WriteSeq | undefined): void {
    if (!seq) return;
    const now = Date.now();
    for (const op of ops) if (opOrigin(op) === 'user') this.writtenAt.set(opKey(op), { seq, at: now });
    if (this.writtenAt.size > WRITTEN_KEEP) for (const [key, written] of this.writtenAt) if (now - written.at > WRITTEN_MS) this.writtenAt.delete(key);
  }

  /** Sync's requests to chord-data. Throws if it can't answer. */
  async sync(request: SyncRequest): Promise<SyncReply> {
    const response = await this.request(request);
    if (!response.ok) throw new Error(response.error);
    return response.sync ?? {};
  }

  onPush(listener: (push: DataPush) => void): void {
    this.pushed = listener;
  }

  onRespawn(listener: () => void): void {
    this.respawned = listener;
  }

  /** Queue a whole state (a brand-new profile's first save). */
  recordAll(state: State): void {
    const at = Date.now();
    for (const op of opsForState(state)) this.pending.append({ ...op, at });
    this.schedule();
  }

  /** An open tab's back/forward history (never a private window's: the caller checks). */
  nav(nodeId: string, nav: NavState | null): void {
    if (this.closed) return;
    const op: WriteOp = { k: 'nav', id: nodeId, value: nav };
    this.put(op);
    this.schedule();
  }

  /** A site's Effects (never a private window's: the caller checks), or null when the site has none any more; `fromSync`: another computer's, applied. */
  effect(host: string, value: SavedEffects | null, fromSync = false): void {
    if (this.closed) return;
    this.put({ k: 'effect', id: host, value, ...(fromSync ? { origin: 'sync' as const } : {}) });
    this.schedule();
  }

  /** A visit, a late title, a command bar pick, or a tab going to (or leaving) the archive. */
  history(event: HistoryEvent): void {
    if (this.closed) return;
    this.eventOrder.set(event, ++this.eventCount);
    this.events.push(event);
    this.schedule();
  }

  /**
   * History, archived tabs and learned picks for what was typed in the command bar.
   * History's happenings waiting go first, so a page visited or a tab archived a
   * moment ago is found; the sidebar's own writes needn't, so a big one (a merge
   * from another computer being saved) never holds a search up.
   */
  async search(query: string, chordId: string | null): Promise<SearchResult> {
    try {
      await this.flushEvents();
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

  /** Take back what an import added to history and Duet (its Undo): the chats it took away, for Duet to end their sessions. */
  async undoImport(importId: string): Promise<DuetThread[]> {
    const response = await this.request({ type: 'import.undo', importId });
    if (!response.ok) throw new Error(response.error);
    return response.duet?.removed ?? [];
  }

  /** This computer's id, for an export's header and stamps (made the first time it's asked for). */
  async device(): Promise<string> {
    const response = await this.request({ type: 'device' });
    if (!response.ok || !response.device) throw new Error(response.ok ? 'chord-data: no device id' : response.error);
    return response.device;
  }

  /** What an export would hold, for Settings' card. Pending writes go first, so what was just added counts. */
  async exportCounts(): Promise<ExportCounts> {
    await this.flush();
    const response = await this.request({ type: 'export.counts' });
    if (!response.ok || !response.counts) throw new Error(response.ok ? 'chord-data: no counts' : response.error);
    return response.counts;
  }

  /** Duet's threads and messages. Throws if chord-data can't answer, so Duet can say so. */
  async duet(op: DuetOp): Promise<DuetResult> {
    const response = await this.request({ type: 'duet', op });
    if (!response.ok) throw new Error(response.error);
    return response.duet ?? {};
  }

  /** The archive page's entries. History's happenings waiting go first, so a tab archived a moment ago is there. */
  async archiveList(query: string, limit: number): Promise<ArchivePage> {
    try {
      await this.flushEvents();
      const response = await this.request({ type: 'archive.list', query, limit });
      return response.ok && response.archive ? response.archive : { items: [], more: false };
    } catch {
      return { items: [], more: false };
    }
  }

  /** One archive entry with its history, or the newest one archived for `reasons`. */
  async archiveEntry(which: { archiveId: string } | { reasons: ArchiveReason[] }): Promise<ArchiveEntry | null> {
    try {
      await this.flushEvents();
      const response = await this.request('archiveId' in which ? { type: 'archive.get', archiveId: which.archiveId } : { type: 'archive.latest', reasons: which.reasons });
      return response.ok ? (response.entry ?? null) : null;
    } catch {
      return null;
    }
  }

  private schedule(): void {
    // A refused batch waiting to go again: the next write goes with it then, not sooner.
    if (this.retry !== undefined) return;
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  /**
   * How many of another computer's changes, applied here, chord-data refused
   * for now and are still waiting to be written: what sync applied that isn't
   * in chord.db yet (S15 §13). Your own refused changes aren't counted: they're
   * yours, kept and sent again all the same, and the window says when writes
   * keep failing. Each counts until a write of it lands, is dropped, or is
   * taken over by a change of yours.
   */
  get unsaved(): number {
    let n = 0;
    for (const origin of this.retained.values()) if (origin === 'sync') n++;
    return n;
  }

  /** A batch is in, or was dropped for what's in it: none of it waits any more. */
  private settled(ops: readonly WriteOp[]): void {
    for (const op of ops) this.retained.delete(queueKey(op));
  }

  /** A batch refused for now: back in the queue (unless a newer write of an entity is), and waiting until written. */
  private retain(ops: readonly WriteOp[], events: readonly HistoryEvent[]): void {
    for (const op of ops) if (!this.pending.turnsOf(opKey(op)).some(([, o]) => yours(o) === yours(op))) this.retained.set(queueKey(op), opOrigin(op));
    this.requeue(ops);
    this.events = this.inOrder([...events, ...this.events]);
  }

  /** Writes keep failing (`true`, after WRITE_TROUBLE tries), or they're in again (`false`): the app says so. */
  onTrouble(listener: (failing: boolean) => void): void {
    this.trouble = listener;
  }

  /**
   * History's happenings waiting (visits, picks, the archive's comings and
   * goings), written now on their own, ahead of any sidebar writes still
   * queued: what a search or the archive reads. chord-data takes requests in
   * order, so a write already sent is in before them.
   */
  private flushEvents(): Promise<void> {
    if (this.events.length === 0) return Promise.resolve();
    // History in a batch being written goes first: these wait for it, never ahead of it (were it refused, they'd land
    // before it). Nor do they go while writes are refused: they'd only be refused too, and put back.
    if (this.inFlightEvents.length > 0) return this.inFlightDone.then(() => this.flushEvents());
    if (this.retry !== undefined) return Promise.resolve();
    const events = this.events;
    this.events = [];
    this.sideEvents.push(...events);
    return this.request({ type: 'write', ops: [], events }).then(
      (response) => {
        this.sideEvents = this.sideEvents.filter((e) => !events.includes(e));
        if (!response.ok && refusalPasses(response)) {
          // Refused for now (a full disk): back in the queue, in their place, sent again with the next try.
          this.retain([], events);
          this.refused(response.error);
          return;
        }
        if (!response.ok) console.error('chord-data refused a write:', response.error);
      },
      // The process died mid-write; the exit handler has requeued them.
      () => undefined,
    );
  }

  /**
   * Write everything queued so far; batches go one at a time, in order. A
   * big one (a merge from another computer applied, an import's parts) goes
   * WRITE_CHUNK entities at a time, each its own transaction, chords first:
   * chord-data answers the command bar's searches between them.
   */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(async () => {
      clearTimeout(this.retry);
      this.retry = undefined;
      while (this.pending.size > 0 || this.events.length > 0) {
        const all = [...this.pending.values()];
        const ops = nextBatch(all, all.some((op) => opOrigin(op) !== 'user') ? SYNC_WRITE_CHUNK : WRITE_CHUNK);
        this.pending.take(ops);
        this.inFlight = ops;
        this.inFlightEvents = this.events;
        this.events = [];
        try {
          const sent = this.request({ type: 'write', ops: this.inFlight, events: this.inFlightEvents });
          this.inFlightDone = sent.catch(() => undefined);
          const response = await sent;
          if (!response.ok && refusalPasses(response)) {
            // Refused for now (a full disk): put back, unless a newer write for the same entity is queued, and sent again later.
            this.retain(this.inFlight, this.inFlightEvents);
            this.inFlight = [];
            this.inFlightEvents = [];
            this.refused(response.error);
            return;
          }
          // A batch the database refuses for what's in it would fail for ever if retried; report it and move on.
          if (!response.ok) console.error('chord-data refused a write:', response.error);
          else {
            this.saved();
            this.wroteYours(this.inFlight, response.seq);
          }
          this.settled(this.inFlight);
          this.inFlight = [];
          this.inFlightEvents = [];
        } catch {
          // The process died mid-write; the exit handler has requeued the batch.
          return;
        }
      }
    });
    return this.chain;
  }

  /** A batch refused for now: the queue goes again later and later, and past a few tries the app says so. */
  private refused(error: string | undefined): void {
    this.refusals++;
    console.error(`chord-data couldn’t write (try ${this.refusals}); trying again:`, error);
    this.retryMs = Math.min(WRITE_RETRY_MAX, Math.max(WRITE_RETRY_MS, this.retryMs * 2));
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.flush(), this.retryMs);
    if (this.refusals === WRITE_TROUBLE) this.trouble(true);
  }

  private saved(): void {
    if (this.refusals === 0) return;
    const troubled = this.refusals >= WRITE_TROUBLE;
    this.refusals = 0;
    this.retryMs = 0;
    if (troubled) this.trouble(false);
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
