/**
 * The chord-data utility process (ARCHITECTURE.md §4): owns the SQLite
 * connection so synchronous database work never runs on main. A crash here
 * doesn't take windows down; main buffers writes and starts a new one.
 */
import type { DataRequest, DataResponse, ImportBatch, ImportBatchReply } from '@chord/data';
import { ChordDatabase } from '@chord/data/db';

let db: ChordDatabase | null = null;

const reply = (response: DataResponse) => process.parentPort.postMessage(response);

process.parentPort.on('message', (event) => {
  const request = event.data as DataRequest;
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
      case 'write':
        if (!db) throw new Error('chord-data: write before open');
        db.write(request.ops, Date.now(), request.events);
        reply({ id: request.id, ok: true });
        break;
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
        // The import process's batches of history, each written in one transaction and answered.
        port.on('message', ({ data }) => {
          try {
            if (!db) throw new Error('chord-data: closed');
            port.postMessage({ ok: true, added: db.importHistory(importId, (data as ImportBatch).pages) } satisfies ImportBatchReply);
          } catch (error) {
            port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ImportBatchReply);
          }
        });
        port.start();
        reply({ id: request.id, ok: true });
        break;
      }
      case 'import.undo':
        if (!db) throw new Error('chord-data: import before open');
        db.undoImport(request.importId);
        reply({ id: request.id, ok: true });
        break;
      case 'device':
        if (!db) throw new Error('chord-data: device before open');
        reply({ id: request.id, ok: true, device: db.device() });
        break;
      case 'export.counts':
        if (!db) throw new Error('chord-data: export before open');
        reply({ id: request.id, ok: true, counts: db.exportCounts() });
        break;
      case 'close':
        db?.close();
        db = null;
        reply({ id: request.id, ok: true });
        break;
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
});
