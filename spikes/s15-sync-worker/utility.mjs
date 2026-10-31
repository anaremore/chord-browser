// The stand-in for chord-data (see main.mjs): its own thread keeps the
// database and answers a query every 2 ms; a worker thread does sync's work.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const fail = (what) => (error) => {
  process.parentPort.postMessage({ ok: false, error: `${what}: ${String(error?.stack ?? error)}` });
  process.exit(1);
};
process.on('uncaughtException', fail('uncaughtException'));
process.on('unhandledRejection', fail('unhandledRejection'));

const step = (name) => process.parentPort.postMessage({ step: name });
step('loaded');
const dir = process.argv[2];
const file = join(dir, 'chord.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
db.exec('CREATE TABLE IF NOT EXISTS sync_record (type TEXT NOT NULL, id TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY (type, id)) STRICT');
const insert = db.prepare('INSERT OR REPLACE INTO sync_record (type, id, fields) VALUES (?, ?, ?)');
db.exec('BEGIN');
for (let i = 0; i < 2000; i++) insert.run('tab', `t${i}`, JSON.stringify({ title: `Tab ${i}`, url: `https://example.com/${i}` }));
db.exec('COMMIT');
step('database');
const query = db.prepare('SELECT COUNT(*) AS n FROM sync_record WHERE id > ?');

const memory = () => Math.round(process.memoryUsage().rss / 1048576);
const result = { electron: process.versions.electron, node: process.versions.node, rssBefore: memory() };

// chord-data's thread: a query every 2 ms, and how late each tick came.
let worst = 0;
let ticks = 0;
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  worst = Math.max(worst, now - last - 2);
  last = now;
  query.get('t5');
  ticks++;
}, 2);

const started = performance.now();
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { file, dir }, name: 'Sync' });
step('worker made');
worker.on('error', fail('worker error'));
worker.on('exit', (code) => step(`worker exit ${code}`));
worker.once('online', () => {
  result.workerStartMs = Math.round(performance.now() - started);
  result.rssWorkerOn = memory();
});
worker.on('message', (message) => {
  clearInterval(tick);
  Object.assign(result, message);
  result.mainThreadWorstLateMs = Math.round(worst * 10) / 10;
  result.mainThreadTicks = ticks;
  void worker.terminate().then(() => {
    // Give the allocator a moment, then see what turning sync off gives back.
    setTimeout(() => {
      result.rssWorkerOff = memory();
      db.close();
      result.ok = Boolean(message.ok);
      process.parentPort.postMessage(result);
    }, 500);
  });
});
