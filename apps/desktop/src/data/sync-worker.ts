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
 * read, so a big log is merged a slice at a time with searches in between.
 */
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  appendRecords,
  deviceFolder,
  inspectFolder,
  lookAtFolder,
  nextGeneration,
  readComputers,
  setUp,
  SYNC_FOLDER,
  syncFileName,
  unlockNewest,
  writeSnapshot,
  type DataRecord,
  type FolderInspection,
  type FolderLook,
  type OwnSegment,
  type SegmentCursor,
  type SyncFs,
} from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';

/** chord-data → the worker. */
export type ToWorker =
  | { t: 'inspect'; folder: string }
  | { t: 'setup'; folder: string; generation: number; passphrase: string; device: string; app: string; records: DataRecord[] }
  | { t: 'unlock'; folder: string; passphrase: string }
  | { t: 'start'; folder: string; generation: number; device: string; key: Uint8Array; own: OwnSegment | null; cursors: { device: string; segment: number; cursor: SegmentCursor }[]; app: string }
  | { t: 'read' }
  | { t: 'ack' }
  | { t: 'write'; upto: number; records: DataRecord[]; device: DataRecord[] }
  | { t: 'snapshot'; records: DataRecord[]; generation?: number; key?: Uint8Array }
  | { t: 'rekey'; passphrase: string; records: DataRecord[] }
  | { t: 'remove'; path: string }
  | { t: 'stop' };

/** The worker → chord-data. */
export type FromWorker =
  | { t: 'inspected'; inspection: FolderInspection }
  | { t: 'set-up'; key: Uint8Array; own: OwnSegment }
  | { t: 'unlocked'; key: Uint8Array; generation: number }
  | { t: 'records'; device: string; segment: number; records: DataRecord[]; cursor: SegmentCursor }
  | { t: 'newer'; device: string }
  | { t: 'pass-done'; look: FolderLook; seen: Record<string, number> }
  | { t: 'written'; upto: number; own: OwnSegment; frames: number; bytes: number }
  | { t: 'snapshotted'; own: OwnSegment }
  | { t: 'rekeyed'; key: Uint8Array; generation: number; own: OwnSegment }
  /** `copied`: another computer writes under this one's id; `missing`: this computer's segment has gone; `io`: the folder couldn't be written. */
  | { t: 'failed'; problem: 'wrong' | 'conflict' | 'newer' | 'damaged' | 'missing' | 'copied' | 'io'; for: ToWorker['t'] }
  /** The folder changed (a watch fired): chord-data may ask for a read. */
  | { t: 'changed' };

/** Looks this often, whatever the watch says: watching cloud and network folders isn't reliable (S15 §6). */
const POLL_MS = 5 * 60_000;
/** A burst of changes to the folder (a sync app writing a segment in pieces) reads once, after it settles. */
const SETTLE_MS = 1000;

/** `Chord sync` on the disk: each new file made under a temp name and renamed into place; appends flushed. */
export class NodeFolder implements SyncFs {
  constructor(readonly root: string) {}

  private full(path: string): string {
    return path ? join(this.root, ...path.split('/')) : this.root;
  }

  async list(path: string): Promise<string[] | null> {
    try {
      return await readdir(this.full(path));
    } catch {
      return null;
    }
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const s = await stat(this.full(path));
      return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  async read(path: string, position: number, length: number): Promise<Uint8Array> {
    const handle = await open(this.full(path), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async create(path: string, bytes: Uint8Array, exclusive = false): Promise<void> {
    const target = this.full(path);
    if (exclusive) {
      const handle = await open(target, 'wx');
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    // A temp name no reader takes for a segment (NNNNNN.chordlog only), then renamed: never seen half made.
    const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    const handle = await open(temp, 'w');
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  }

  async append(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(this.full(path), 'a');
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.full(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(this.full(path), { recursive: true, force: true, maxRetries: 3 });
  }
}

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
}

let running: Running | null = null;
let watcher: FSWatcher | null = null;
let poll: ReturnType<typeof setInterval> | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
let reading = false;
let again = false;
let acked: (() => void) | null = null;
/** One folder operation at a time: a write never interleaves with a snapshot, a read with a new generation. */
let chain: Promise<void> = Promise.resolve();
const serial = (work: () => Promise<void>) => {
  chain = chain.then(work, work);
  return chain;
};

const cursorKey = (device: string, segment: number) => `${device}/${segment}`;

/** Reads every other computer's log from where it got to, each batch answered before the next. */
async function pass(): Promise<void> {
  const r = running;
  if (!r) return;
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const look = await lookAtFolder(r.fs, r.generation, r.key, nodeCrypto);
    const seen: Record<string, number> = {};
    if (look.state === 'ok') {
      for await (const event of readComputers(r.fs, { generation: r.generation, self: r.device, root: r.key, cursor: (d, s) => r.cursors.get(cursorKey(d, s)) ?? null }, nodeCrypto)) {
        if (running !== r) return;
        if (event.kind === 'seen') seen[event.device] = event.at;
        else if (event.kind === 'newer') send({ t: 'newer', device: event.device });
        else {
          r.cursors.set(cursorKey(event.device, event.segment), event.cursor);
          await new Promise<void>((resolve) => {
            acked = resolve;
            send({ t: 'records', device: event.device, segment: event.segment, records: event.records, cursor: event.cursor });
          });
        }
      }
    }
    send({ t: 'pass-done', look, seen });
  } catch (error) {
    console.error('Sync couldn’t read the folder:', error);
    send({ t: 'pass-done', look: { state: 'missing' }, seen: {} });
  } finally {
    reading = false;
    if (again && running === r) {
      again = false;
      void serial(pass);
    }
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

async function handle(message: ToWorker): Promise<void> {
  switch (message.t) {
    case 'inspect':
      send({ t: 'inspected', inspection: await inspectFolder(folderOf(message.folder)) });
      return;
    case 'setup': {
      const fs = folderOf(message.folder);
      const made = await setUp(fs, message.generation, message.passphrase, message.device, nodeCrypto);
      if (!made.ok) return failed('setup', made.problem);
      const own = await writeSnapshot(fs, { generation: message.generation, device: message.device }, message.records, made.root, { app: message.app }, nodeCrypto);
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
      if (!r?.own) return failed('write', 'missing');
      const result = await appendRecords(r.fs, r.own, message.records, r.key, { app: r.app, device: message.device }, nodeCrypto);
      if (!result.ok) return failed('write', result.problem);
      r.own = result.own;
      send({ t: 'written', upto: message.upto, own: result.own, frames: result.frames, bytes: result.bytes });
      return;
    }
    case 'snapshot': {
      const r = running;
      if (!r) return failed('snapshot', 'missing');
      // Moving to another generation (the passphrase changed on another computer): the snapshot goes there, under its key.
      if (message.generation !== undefined && message.key) {
        const old = r.generation;
        r.generation = message.generation;
        r.key = message.key;
        r.cursors.clear();
        r.own = await writeSnapshot(r.fs, { generation: r.generation, device: r.device }, message.records, r.key, { app: r.app }, nodeCrypto);
        await r.fs.remove(deviceFolder(old, r.device)).catch(() => undefined);
        watchFolder(r);
      } else r.own = await writeSnapshot(r.fs, { generation: r.generation, device: r.device }, message.records, r.key, { app: r.app }, nodeCrypto);
      send({ t: 'snapshotted', own: r.own });
      return;
    }
    case 'rekey': {
      const r = running;
      if (!r) return failed('rekey', 'missing');
      const next = await nextGeneration(r.fs, message.passphrase, r.device, nodeCrypto);
      const old = r.generation;
      r.generation = next.generation;
      r.key = next.root;
      r.cursors.clear();
      r.own = await writeSnapshot(r.fs, { generation: r.generation, device: r.device }, message.records, r.key, { app: r.app }, nodeCrypto);
      await r.fs.remove(deviceFolder(old, r.device)).catch(() => undefined);
      watchFolder(r);
      send({ t: 'rekeyed', key: r.key, generation: r.generation, own: r.own });
      return;
    }
    case 'remove': {
      const r = running;
      // Only a computer's folder in this generation, or an old generation's file: never anything else.
      if (r && (/^\d{1,6}\/[0-9a-f]{16}$/.test(message.path) || message.path === syncFileName(Number(/^sync-(\d{1,6})\.json$/.exec(message.path)?.[1] ?? -1)))) await r.fs.remove(message.path).catch(() => undefined);
      return;
    }
    case 'stop':
      stopWatching();
      running?.key.fill(0);
      running = null;
      return;
    case 'ack':
      return;
  }
}

port.on('message', (message: ToWorker) => {
  if (message.t === 'ack') {
    const resolve = acked;
    acked = null;
    resolve?.();
    return;
  }
  if (message.t === 'read' || message.t === 'start' || message.t === 'stop') {
    void handle(message).catch((error: unknown) => {
      console.error('Sync failed:', error);
      failed(message.t, 'io');
    });
    return;
  }
  // Folder work, one at a time.
  void serial(() =>
    handle(message).catch((error: unknown) => {
      console.error('Sync failed:', error);
      failed(message.t, 'io');
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
