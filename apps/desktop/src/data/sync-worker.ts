/**
 * Sync's worker thread, inside chord-data's process (docs/decisions/S15-your-data.md
 * §7, §13): the folder work (sync-worker-core.ts) on a thread of its own, so a
 * slow cloud folder, scrypt or a big snapshot never touches the thread that
 * answers the command bar's searches; here, with `<folder>/Chord sync` on the
 * disk (NodeFolder), its watch, and chord.db's checkpoints while sync is busy.
 */
import { watch } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort } from 'node:worker_threads';
import { SYNC_FOLDER } from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import { createSyncWorker, type FromWorker, type ToWorker } from './sync-worker-core';
import { abandonFolder, NodeFolder } from './sync-folder';

export type { FromWorker, ToWorker } from './sync-worker-core';

const port = parentPort!;
const send = (message: FromWorker) => port.postMessage(message);

const worker = createSyncWorker({
  send,
  folderOf: (folder) => new NodeFolder(join(folder, SYNC_FOLDER)),
  abandon: abandonFolder,
  reachable: async (folder) => Boolean((await stat(join(folder, SYNC_FOLDER)).catch(() => null))?.isDirectory()),
  watch: (folder, changed, failed) => {
    try {
      const watcher = watch(join(folder, SYNC_FOLDER), { recursive: true }, (_event, name) => changed(typeof name === 'string' ? name : null));
      watcher.on('error', failed);
      return watcher;
    } catch {
      return null;
    }
  },
  writeFile: (path, bytes) => writeFile(path, bytes),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  crypto: nodeCrypto,
  watchInFront: process.platform === 'win32',
});

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

port.on('message', (message: ToWorker) => {
  if (message.t === 'checkpoint') return checkpoint(message.database);
  if (message.t === 'stop') {
    database?.close();
    database = null;
  }
  worker.receive(message);
});

process.on('uncaughtException', (error) => {
  console.error('Sync worker:', error);
  send({ t: 'failed', problem: 'io', for: 'read' });
});
process.on('unhandledRejection', (error) => {
  console.error('Sync worker:', error);
  send({ t: 'failed', problem: 'io', for: 'read' });
});
