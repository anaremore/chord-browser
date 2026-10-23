/**
 * The chord-data utility process (ARCHITECTURE.md §4): owns the SQLite
 * connection so synchronous database work never runs on main. A crash here
 * doesn't take windows down; main buffers writes and starts a new one.
 */
import type { DataRequest, DataResponse } from '@chord/data';
import { ChordDatabase } from '@chord/data/db';

let db: ChordDatabase | null = null;

const reply = (response: DataResponse) => process.parentPort.postMessage(response);

process.parentPort.on('message', (event) => {
  const request = event.data as DataRequest;
  try {
    switch (request.type) {
      case 'open':
        db?.close();
        db = new ChordDatabase(request.file);
        if (request.prune) db.pruneProfiles();
        reply({ id: request.id, ok: true, saved: db.load() });
        break;
      case 'write':
        if (!db) throw new Error('chord-data: write before open');
        db.write(request.ops, Date.now(), request.events);
        reply({ id: request.id, ok: true });
        break;
      case 'search':
        if (!db) throw new Error('chord-data: search before open');
        reply({ id: request.id, ok: true, search: db.search(request.query, request.chordId, request.now) });
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
