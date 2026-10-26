/**
 * The chord-data utility process (ARCHITECTURE.md §4): owns the SQLite
 * connection so synchronous database work never runs on main. A crash here
 * doesn't take windows down; main buffers writes and starts a new one.
 * Sync's tables are chord-data's too, and its worker thread starts here only
 * while sync is on (sync.ts, docs/decisions/S15-your-data.md §7).
 */
import type { DuetThread } from '@chord/core';
import type { DataPush, DataRequest, DataResponse, ImportBatch, ImportBatchReply, SyncRequest } from '@chord/data';
import { ChordDatabase } from '@chord/data/db';
import { SyncController } from './sync';

let db: ChordDatabase | null = null;

const reply = (response: DataResponse) => process.parentPort.postMessage(response);
const sync = new SyncController(
  () => db,
  (message: DataPush) => process.parentPort.postMessage(message),
);

// An error nothing caught ends the process: main starts a new one, and puts back the write it was doing.
const crashed = (what: string) => (error: unknown) => {
  console.error(`chord-data: ${what}:`, error);
  process.exit(1);
};
process.on('uncaughtException', crashed('uncaught exception'));
process.on('unhandledRejection', crashed('unhandled rejection'));

const isSync = (request: DataRequest): request is DataRequest & SyncRequest => request.type.startsWith('sync.');

process.parentPort.on('message', (event) => {
  const request = event.data as DataRequest;
  if (isSync(request)) {
    sync.handle(request).then(
      (answer) => reply({ id: request.id, ok: true, sync: answer }),
      (error: unknown) => reply({ id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
    );
    return;
  }
  try {
    switch (request.type) {
      case 'open': {
        // How long each step took, for the launch timeline when a launch is slow (launch-timeline.ts).
        const up = Math.round(process.uptime() * 1000);
        let at = performance.now();
        const lap = () => {
          const now = performance.now();
          const ms = Math.round(now - at);
          at = now;
          return ms;
        };
        sync.close();
        db?.close();
        db = new ChordDatabase(request.file);
        const open = lap();
        if (request.prune) db.pruneProfiles();
        const prune = lap();
        const saved = db.load();
        const navs = db.loadNavs();
        const effects = db.loadEffects();
        reply({ id: request.id, ok: true, saved, navs, effects, timing: { up, open, prune, read: lap() } });
        break;
      }
      case 'write': {
        if (!db) throw new Error('chord-data: write before open');
        const writing = db;
        const { id, ops, events } = request;
        // On the next turn: a search that came in behind it (the command bar typing while sync applies) is answered first,
        // rather than waiting out the write. Main sends one write at a time and waits for its answer, so they stay in order.
        setImmediate(() => {
          try {
            if (db !== writing) throw new Error('chord-data: closed');
            const at = performance.now();
            const stamping = writing.sync.stamping;
            writing.write(ops, Date.now(), events);
            writing.sync.timed(stamping ? 'write' : 'writeOff', performance.now() - at);
            reply({ id, ok: true });
            // What sync stamped goes to the folder a moment after the last change.
            sync.afterWrite();
          } catch (error) {
            reply({ id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
            // Refused (a full disk): what sync applied isn't in chord.db, and a reconcile finds it again.
            sync.writeRefused();
          }
        });
        break;
      }
      case 'search':
        if (!db) throw new Error('chord-data: search before open');
        reply({ id: request.id, ok: true, search: db.search(request.query, request.chordId, request.now) });
        break;
      case 'archive.list':
        if (!db) throw new Error('chord-data: archive before open');
        reply({ id: request.id, ok: true, archive: db.archiveList(request.query, request.limit) });
        break;
      case 'archive.get':
        if (!db) throw new Error('chord-data: archive before open');
        reply({ id: request.id, ok: true, entry: db.archiveGet(request.archiveId) });
        break;
      case 'archive.latest':
        if (!db) throw new Error('chord-data: archive before open');
        reply({ id: request.id, ok: true, entry: db.archiveLatest(request.reasons) });
        break;
      case 'duet':
        if (!db) throw new Error('chord-data: duet before open');
        reply({ id: request.id, ok: true, duet: db.duet(request.op) });
        break;
      case 'import.port': {
        const port = event.ports[0];
        if (!db || !port) throw new Error('chord-data: import port before open');
        const { importId } = request;
        // Smaller checkpoints while the import writes, until its process closes the port (or goes).
        const writing = db;
        writing.importing(true);
        port.on('close', () => writing.importing(false));
        // The import process's batches of history (and a Chord file's Duet chats), each written in one transaction and answered.
        port.on('message', ({ data }) => {
          try {
            if (!db) throw new Error('chord-data: closed');
            const batch = data as ImportBatch;
            if (batch.duet) {
              const added = db.importDuet(importId, batch.duet.threads, batch.duet.messages);
              port.postMessage({ ok: true, added: added.messages, threads: added.threads } satisfies ImportBatchReply);
            } else port.postMessage({ ok: true, added: db.importHistory(importId, batch.pages ?? []) } satisfies ImportBatchReply);
          } catch (error) {
            port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ImportBatchReply);
          }
        });
        port.start();
        reply({ id: request.id, ok: true });
        break;
      }
      case 'import.undo': {
        if (!db) throw new Error('chord-data: import before open');
        // A slice at a time, each its own transaction, with the command bar's searches (and anything else waiting) in between,
        // and smaller checkpoints meanwhile.
        const undoing = db;
        const removed: DuetThread[] = [];
        undoing.importing(true);
        const step = () => {
          try {
            if (db !== undoing) throw new Error('chord-data: closed');
            const slice = undoing.undoImportSlice(request.importId);
            removed.push(...slice.threads);
            if (!slice.done) return void setImmediate(step);
            undoing.importing(false);
            reply({ id: request.id, ok: true, duet: { removed } });
          } catch (error) {
            if (db === undoing) undoing.importing(false);
            reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        };
        step();
        break;
      }
      case 'device':
        if (!db) throw new Error('chord-data: device before open');
        reply({ id: request.id, ok: true, device: db.device() });
        break;
      case 'export.counts':
        if (!db) throw new Error('chord-data: export before open');
        reply({ id: request.id, ok: true, counts: db.exportCounts() });
        break;
      case 'close':
        sync.close();
        db?.close();
        db = null;
        reply({ id: request.id, ok: true });
        break;
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
});
