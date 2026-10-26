/**
 * Sync's worker thread, inside chord-data's process (docs/decisions/S15-your-data.md
 * §7, §13): the folder work, so a slow cloud folder, scrypt or a big snapshot
 * never touches the thread that answers the command bar's searches. It reads
 * and writes `<folder>/Chord sync` through core's folder protocol
 * (sync-folder.ts), watches it where the OS allows, and looks every five
 * minutes. It holds the root key only in memory, and never the passphrase
 * past deriving it.
 *
 * chord-data's thread owns the sync tables: it sends what to write, and each
 * batch of records read here waits for its answer (`ack`) before the next is
 * read, so a big log is merged a slice at a time with searches in between. A
 * snapshot comes the same way, a page at a time as this thread asks for it
 * (`pull`), and is written as it comes: neither thread holds it whole.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';
import {
  AnotherWriter,
  appendRecords,
  ownIntact,
  coversOf,
  deviceFolder,
  folderMemory,
  inspectFolder,
  lookAtFolder,
  mayPrune,
  nextGeneration,
  readComputers,
  SegmentsFull,
  setUp,
  SYNC_FOLDER,
  syncFileName,
  unlockNewest,
  writeSnapshot,
  type DataRecord,
  type FolderInspection,
  type FolderLook,
  type FolderMemory,
  type OwnSegment,
  type SegmentCursor,
} from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import { NodeFolder } from './sync-folder';

/** A snapshot to write: chord-data sends its records a page at a time when asked (`pull` → `chunk`), and this computer's `device` records for its first frame. */
interface Snapshot {
  stream: number;
  device: DataRecord[];
}

/** chord-data → the worker. */
export type ToWorker =
  | { t: 'inspect'; folder: string }
  | ({ t: 'setup'; folder: string; generation: number; passphrase: string; device: string; app: string } & { snapshot: Snapshot })
  | { t: 'unlock'; folder: string; passphrase: string }
  | { t: 'start'; folder: string; generation: number; device: string; key: Uint8Array; own: OwnSegment | null; cursors: { device: string; segment: number; cursor: SegmentCursor }[]; app: string; junk: [string, string][] }
  | { t: 'read' }
  /** A step merged (`ok`), so the worker moves its cursor on; or not, and the pass stops there, to read it again later. */
  /** A batch of records (`id`) merged, or not: an answer that comes too late is never taken for the next batch's. */
  | { t: 'ack'; id: number; ok: boolean }
  /** A page of a snapshot; `lost`: chord-data has no such snapshot (it stopped), and nothing is put in place. */
  | { t: 'chunk'; stream: number; records: DataRecord[]; done: boolean; lost?: boolean }
  | { t: 'write'; upto: number; records: DataRecord[]; device: DataRecord[] }
  /** This computer's snapshot: compaction (covering its segments), or under a new id (`as`), which it takes only once the snapshot is there. */
  | { t: 'snapshot'; snapshot: Snapshot; as?: string }
  | { t: 'move'; folder: string; from: number; to: number; device: string; key: Uint8Array; app: string; snapshot: Snapshot }
  /** Whether a folder is this sync's: its generation's file opens with this computer's key (a folder that moved). */
  | { t: 'look'; folder: string; generation: number; key: Uint8Array }
  /** A lost passphrase: the next generation with a new one, without the old key, and this computer's snapshot under it. */
  | { t: 'restart'; folder: string; from: number; passphrase: string; device: string; app: string; snapshot: Snapshot }
  /** A new passphrase, in two steps: the next generation's file (this computer then says so under the old one), then its snapshot there. */
  | { t: 'rekey-file'; passphrase: string }
  | { t: 'rekey-move'; generation: number; key: Uint8Array; snapshot: Snapshot }
  /** A removed computer's folder, gone if everything real in it has been read here and nothing in it is newer than its removal. */
  | { t: 'prune'; device: string; removedAt: number }
  /** An old generation's file, or this computer's folder in one: nothing else. */
  | { t: 'remove'; path: string }
  /** A passive checkpoint of chord.db, on this thread's own connection: chord-data's runs none while sync is busy. */
  | { t: 'checkpoint'; database: string }
  | { t: 'stop' };

/** The worker → chord-data. */
export type FromWorker =
  | { t: 'inspected'; inspection: FolderInspection }
  | { t: 'set-up'; key: Uint8Array; own: OwnSegment }
  | { t: 'unlocked'; key: Uint8Array; generation: number }
  | { t: 'records'; id: number; device: string; segment: number; records: DataRecord[]; cursor: SegmentCursor; refused: number }
  | { t: 'newer'; device: string }
  /** `seen`: when each computer last wrote here; `wrote`: when each says it made its newest segment read (its own clock). */
  /** `junk`: what the reader remembers of junk, when it changed (chord-data keeps it across launches). */
  | {
      t: 'pass-done';
      look: FolderLook;
      seen: Record<string, number>;
      wrote: Record<string, number>;
      tooMany: boolean;
      cluttered: boolean;
      unfinished: boolean;
      /** Computers whose folders hold more than a pass looks through. */
      blocked: string[];
      /** A step wasn't merged (or its answer never came): the pass stopped there. */
      failed?: boolean;
      junk?: [string, string][];
    }
  /** This computer's own segment isn't as it left it: another copy of the profile writes to it. */
  | { t: 'own-changed' }
  | { t: 'pull'; stream: number }
  | { t: 'written'; upto: number; own: OwnSegment; frames: number; bytes: number }
  | { t: 'snapshotted'; own: OwnSegment }
  | { t: 'moved'; own: OwnSegment }
  | { t: 'looked'; look: FolderLook }
  | { t: 'restarted'; key: Uint8Array; generation: number; own: OwnSegment }
  | { t: 'rekey-filed'; key: Uint8Array; generation: number }
  | { t: 'rekeyed'; own: OwnSegment }
  | { t: 'pruned'; device: string }
  /**
   * `copied`: another computer writes under this one's id; `gone`: this computer's segment isn't there (or is shorter)
   * though the folder is; `missing`: the folder isn't there; `full`: its segment numbers reached the top; `io`: the
   * folder couldn't be written.
   */
  | { t: 'failed'; problem: 'wrong' | 'conflict' | 'newer' | 'damaged' | 'missing' | 'copied' | 'gone' | 'full' | 'io'; for: ToWorker['t'] }
  /** The folder changed (a watch fired): chord-data may ask for a read. */
  | { t: 'changed' };

/** Looks this often, whatever the watch says: watching cloud and network folders isn't reliable (S15 §6). */
const POLL_MS = 5 * 60_000;
/** A burst of changes to the folder (a sync app writing a segment in pieces) reads once, after it settles. */
const SETTLE_MS = 1000;
/** A pass that looked into as many segments as it may goes on after this long: never back to back. */
const NEXT_PASS_MS = 2000;
/** How long a pass waits for chord-data to say a step is merged: past that the pass stops, and the step is read again later. */
const ACK_MS = 120_000;

const port = parentPort!;
const send = (message: FromWorker) => port.postMessage(message);
const folderOf = (folder: string) => new NodeFolder(join(folder, SYNC_FOLDER));

interface Running {
  fs: NodeFolder;
  folder: string;
  generation: number;
  device: string;
  key: Uint8Array;
  own: OwnSegment | null;
  cursors: Map<string, SegmentCursor>;
  app: string;
  /** Junk remembered, and where looking for computers not known yet got to: never forgotten while it's needed (core's MAX_JUNK bounds it). */
  memory: FolderMemory;
}

let running: Running | null = null;
let watcher: FSWatcher | null = null;
let poll: ReturnType<typeof setInterval> | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
let reading = false;
let again = false;
let next: ReturnType<typeof setTimeout> | undefined;
/** The batch of records waiting for its answer, and the last batch's number. */
let acked: { id: number; resolve(ok: boolean): void } | null = null;
let batches = 0;
/** One folder operation at a time: a write never interleaves with a snapshot, a read with a new generation. */
let chain: Promise<void> = Promise.resolve();
const serial = (work: () => Promise<void>) => {
  chain = chain.then(work, work);
  return chain;
};

const cursorKey = (device: string, segment: number) => `${device}/${segment}`;

/* ---------- Snapshots, a page at a time ---------- */

type Chunk = { records: DataRecord[]; done: boolean; lost?: boolean };
const pulls = new Map<number, (chunk: Chunk) => void>();

/** A snapshot's records as chord-data reads them, a page per ask. One cut short throws: a part of a snapshot is never put in place. */
async function* pages(stream: number): AsyncGenerator<DataRecord[]> {
  for (;;) {
    const chunk = await new Promise<Chunk>((resolve) => {
      pulls.set(stream, resolve);
      send({ t: 'pull', stream });
    });
    if (chunk.lost) throw new Error('The snapshot was cut short');
    if (chunk.records.length > 0) yield chunk.records;
    if (chunk.done) return;
  }
}

/* ---------- Reading ---------- */

/**
 * Reads every other computer's log from where it got to, each batch answered
 * before the next. When the passphrase changed, this generation's logs are
 * still read first: a computer that changed it says so here before it moves.
 *
 * A step's cursor moves on only when chord-data says it's merged (`ack` ok);
 * one that wasn't, or whose answer doesn't come within ACK_MS, stops the pass
 * there (`failed`), to be read again later: the serial chain is never held
 * for ever. First, this computer's own segment is checked to be as it left it
 * (`ownIntact`): a copy of the profile that stopped writing still finds out.
 */
async function pass(): Promise<void> {
  const r = running;
  if (!r) return;
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  let look: FolderLook = { state: 'missing' };
  const seen: Record<string, number> = {};
  const wrote: Record<string, number> = {};
  const blocked: string[] = [];
  let tooMany = false;
  let cluttered = false;
  let unfinished = false;
  let failed = false;
  try {
    look = await lookAtFolder(r.fs, r.generation, r.key, nodeCrypto);
    if (look.state === 'ok' && r.own && r.own.generation === r.generation && r.own.device === r.device) {
      const intact = await ownIntact(r.fs, r.own, nodeCrypto);
      if (intact === 'other' || intact === 'gone') send({ t: 'own-changed' });
    }
    if (look.state === 'ok' || look.state === 'changed') {
      // The segments of each computer read past their first frame: a computer known to have a real log.
      const known = new Map<string, number[]>();
      for (const [key, cursor] of r.cursors) {
        if (cursor.frame === 0) continue;
        const at = key.lastIndexOf('/');
        const device = key.slice(0, at);
        known.set(device, [...(known.get(device) ?? []), Number(key.slice(at + 1))]);
      }
      for await (const event of readComputers(
        r.fs,
        { generation: r.generation, self: r.device, root: r.key, cursor: (d, s) => r.cursors.get(cursorKey(d, s)) ?? null, known: (d) => known.get(d) ?? [], memory: r.memory },
        nodeCrypto,
      )) {
        if (running !== r) return;
        if (event.kind === 'seen') {
          seen[event.device] = event.at;
          if (event.wrote !== null) wrote[event.device] = event.wrote;
        } else if (event.kind === 'newer') send({ t: 'newer', device: event.device });
        else if (event.kind === 'too-many') tooMany = true;
        else if (event.kind === 'unfinished') unfinished = true;
        else if (event.kind === 'cluttered') cluttered = true;
        else if (event.kind === 'blocked') blocked.push(event.device);
        else {
          const id = ++batches;
          const merged = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              acked = null;
              resolve(false);
            }, ACK_MS);
            acked = {
              id,
              resolve: (ok) => {
                clearTimeout(timer);
                resolve(ok);
              },
            };
            send({ t: 'records', id, device: event.device, segment: event.segment, records: event.records, cursor: event.cursor, refused: event.refused });
          });
          if (!merged) {
            failed = true;
            break;
          }
          r.cursors.set(cursorKey(event.device, event.segment), event.cursor);
        }
      }
    }
  } catch (error) {
    console.error('Sync couldn’t read the folder:', error);
    failed = true;
  } finally {
    reading = false;
  }
  if (running !== r) return;
  const junk = r.memory.dirty ? [...r.memory.junk] : undefined;
  r.memory.dirty = false;
  send({ t: 'pass-done', look, seen, wrote, tooMany, cluttered, unfinished, blocked, ...(failed ? { failed } : {}), ...(junk ? { junk } : {}) });
  // More to look through: the next pass goes on from there, a little later, never straight after. A folder full of
  // junk is looked through at the usual times only; a pass that failed is tried again by chord-data, later and later.
  if (unfinished && !cluttered && !failed) {
    clearTimeout(next);
    next = setTimeout(() => void serial(pass), NEXT_PASS_MS);
  }
  if (again) {
    again = false;
    void serial(pass);
  }
}

function watchFolder(r: Running): void {
  stopWatching();
  const later = () => {
    clearTimeout(settle);
    settle = setTimeout(() => send({ t: 'changed' }), SETTLE_MS);
  };
  try {
    // Recursive where the OS has it; a folder that can't be watched is looked at every five minutes, and when Chord comes to the front.
    watcher = watch(join(r.folder, SYNC_FOLDER), { recursive: true }, (_event, name) => {
      // This computer's own writes aren't news.
      if (typeof name === 'string' && name.replaceAll('\\', '/').startsWith(`${deviceFolder(r.generation, r.device)}/`)) return;
      later();
    });
    watcher.on('error', () => stopWatching());
  } catch {
    watcher = null;
  }
  poll = setInterval(later, POLL_MS);
}

function stopWatching(): void {
  watcher?.close();
  watcher = null;
  clearInterval(poll);
  clearTimeout(settle);
}

const failed = (for_: ToWorker['t'], problem: Extract<FromWorker, { t: 'failed' }>['problem']) => send({ t: 'failed', problem, for: for_ });

/** A snapshot of this computer, written as chord-data's pages come, past its newest segment there. */
const snapshotTo = (fs: NodeFolder, where: { generation: number; device: string }, snapshot: Snapshot, key: Uint8Array, app: string) =>
  writeSnapshot(fs, where, pages(snapshot.stream), key, { app, device: snapshot.device, ...(running?.fs === fs ? { memory: running.memory } : {}) }, nodeCrypto);

async function handle(message: ToWorker): Promise<void> {
  switch (message.t) {
    case 'inspect':
      send({ t: 'inspected', inspection: await inspectFolder(folderOf(message.folder)) });
      return;
    case 'setup': {
      const fs = folderOf(message.folder);
      const made = await setUp(fs, message.generation, message.passphrase, message.device, nodeCrypto);
      if (!made.ok) return failed('setup', made.problem);
      const own = await snapshotTo(fs, { generation: message.generation, device: message.device }, message.snapshot, made.root, message.app);
      send({ t: 'set-up', key: made.root, own });
      return;
    }
    case 'unlock': {
      const opened = await unlockNewest(folderOf(message.folder), message.passphrase, nodeCrypto);
      if (!opened.ok) return failed('unlock', opened.problem);
      send({ t: 'unlocked', key: opened.root, generation: opened.generation });
      return;
    }
    case 'start': {
      running = {
        fs: folderOf(message.folder),
        folder: message.folder,
        generation: message.generation,
        device: message.device,
        key: message.key,
        own: message.own,
        cursors: new Map(message.cursors.map((c) => [cursorKey(c.device, c.segment), c.cursor])),
        app: message.app,
        memory: { ...folderMemory(), junk: new Map(message.junk) },
      };
      watchFolder(running);
      void serial(pass);
      return;
    }
    case 'read':
      void serial(pass);
      return;
    case 'write': {
      const r = running;
      if (!r?.own) return failed('write', 'gone');
      const result = await appendRecords(r.fs, r.own, message.records, r.key, { app: r.app, device: message.device, memory: r.memory }, nodeCrypto);
      if (!result.ok) return failed('write', result.problem);
      r.own = result.own;
      send({ t: 'written', upto: message.upto, own: result.own, frames: result.frames, bytes: result.bytes });
      return;
    }
    case 'snapshot': {
      const r = running;
      if (!r) return failed('snapshot', 'missing');
      if (message.as) {
        // A new id: its first snapshot, and only then is it this computer's. The old one's folder is left as it is.
        const own = await snapshotTo(r.fs, { generation: r.generation, device: message.as }, message.snapshot, r.key, r.app);
        r.device = message.as;
        r.own = own;
        watchFolder(r);
        send({ t: 'snapshotted', own });
        return;
      }
      // Compaction: past its newest segment, covering what it wrote; another writer under this id stops it (`copied`).
      const mine = r.own && r.own.generation === r.generation && r.own.device === r.device ? r.own : null;
      r.own = await writeSnapshot(
        r.fs,
        { generation: r.generation, device: r.device },
        pages(message.snapshot.stream),
        r.key,
        { app: r.app, device: message.snapshot.device, covers: coversOf(mine), memory: r.memory, ...(mine ? { after: mine.segment } : {}) },
        nodeCrypto,
      );
      send({ t: 'snapshotted', own: r.own });
      return;
    }
    case 'look':
      send({ t: 'looked', look: await lookAtFolder(folderOf(message.folder), message.generation, message.key, nodeCrypto) });
      return;
    case 'restart': {
      // Starting over: a new generation in the same folder, under a new passphrase; this computer's snapshot there, its old folder gone.
      const fs = folderOf(message.folder);
      const next = await nextGeneration(fs, message.passphrase, message.device, nodeCrypto);
      const own = await snapshotTo(fs, { generation: next.generation, device: message.device }, message.snapshot, next.root, message.app);
      await fs.remove(deviceFolder(message.from, message.device)).catch(() => undefined);
      send({ t: 'restarted', key: next.root, generation: next.generation, own });
      return;
    }
    case 'move': {
      // The passphrase changed on another computer: this one's snapshot goes under the new generation, with its key, and its old folder goes.
      const fs = folderOf(message.folder);
      const own = await snapshotTo(fs, { generation: message.to, device: message.device }, message.snapshot, message.key, message.app);
      await fs.remove(deviceFolder(message.from, message.device)).catch(() => undefined);
      send({ t: 'moved', own });
      return;
    }
    case 'rekey-file': {
      const r = running;
      if (!r) return failed('rekey-file', 'missing');
      const next = await nextGeneration(r.fs, message.passphrase, r.device, nodeCrypto);
      send({ t: 'rekey-filed', key: next.root, generation: next.generation });
      return;
    }
    case 'rekey-move': {
      // Its old folder stays until the old generation's file goes (30 days): what it said there, that it moved, is read by the others.
      const r = running;
      if (!r) return failed('rekey-move', 'missing');
      r.key.fill(0);
      r.generation = message.generation;
      r.key = message.key;
      r.cursors.clear();
      r.own = await snapshotTo(r.fs, { generation: r.generation, device: r.device }, message.snapshot, r.key, r.app);
      watchFolder(r);
      send({ t: 'rekeyed', own: r.own });
      return;
    }
    case 'prune': {
      const r = running;
      if (!r || message.device === r.device) return;
      const where = { generation: r.generation, device: message.device };
      if (await mayPrune(r.fs, where, message.removedAt, r.key, (segment) => r.cursors.get(cursorKey(message.device, segment)) ?? null, nodeCrypto)) {
        await r.fs.remove(deviceFolder(r.generation, message.device)).catch(() => undefined);
        send({ t: 'pruned', device: message.device });
      }
      return;
    }
    case 'remove': {
      const r = running;
      // Only an old generation's file, or this computer's own folder in one: never anything else.
      const file = /^sync-(\d{1,6})\.json$/.exec(message.path);
      const own = /^(\d{1,6})\/([0-9a-f]{16})$/.exec(message.path);
      if (r && ((file && Number(file[1]) < r.generation && message.path === syncFileName(Number(file[1]))) || (own && Number(own[1]) < r.generation && own[2] === r.device))) {
        await r.fs.remove(message.path).catch(() => undefined);
      }
      return;
    }
    case 'stop':
      stopWatching();
      clearTimeout(next);
      running?.key.fill(0);
      running = null;
      for (const resolve of pulls.values()) resolve({ records: [], done: true, lost: true });
      pulls.clear();
      return;
    case 'ack':
    case 'chunk':
      return;
  }
}

/** chord.db, for checkpoints only: SQLite lets any connection copy the write-ahead log in, and a passive one never waits for the writer. */
let database: DatabaseSync | null = null;

function checkpoint(path: string): void {
  try {
    database ??= new DatabaseSync(path, { timeout: 1000 });
    database.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch (error) {
    console.error('Sync couldn’t checkpoint chord.db:', error);
  }
}

const problemOf = (error: unknown): Extract<FromWorker, { t: 'failed' }>['problem'] => (error instanceof SegmentsFull ? 'full' : error instanceof AnotherWriter ? 'copied' : 'io');

port.on('message', (message: ToWorker) => {
  if (message.t === 'checkpoint') return checkpoint(message.database);
  if (message.t === 'stop') {
    database?.close();
    database = null;
  }
  if (message.t === 'ack') {
    if (acked?.id !== message.id) return;
    const { resolve } = acked;
    acked = null;
    resolve(message.ok);
    return;
  }
  if (message.t === 'chunk') {
    const resolve = pulls.get(message.stream);
    pulls.delete(message.stream);
    resolve?.({ records: message.records, done: message.done, ...(message.lost ? { lost: true } : {}) });
    return;
  }
  if (message.t === 'read' || message.t === 'start' || message.t === 'stop') {
    void handle(message).catch((error: unknown) => {
      console.error('Sync failed:', error);
      failed(message.t, problemOf(error));
    });
    return;
  }
  // Folder work, one at a time.
  void serial(() =>
    handle(message).catch((error: unknown) => {
      console.error('Sync failed:', error);
      failed(message.t, problemOf(error));
    }),
  );
});

process.on('uncaughtException', (error) => {
  console.error('Sync worker:', error);
  failed('read', 'io');
});
process.on('unhandledRejection', (error) => {
  console.error('Sync worker:', error);
  failed('read', 'io');
});
