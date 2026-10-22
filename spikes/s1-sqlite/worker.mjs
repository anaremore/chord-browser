import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const result = { electron: process.versions.electron, node: process.versions.node, sqlite: null };
try {
  const file = join(process.argv[2] ?? '.', `chord-s1-${process.pid}.db`);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  result.sqlite = db.prepare('select sqlite_version() as v').get().v;
  result.fts5 = db.prepare("select sqlite_compileoption_used('ENABLE_FTS5') as v").get().v === 1;
  result.strict = (() => { try { db.exec('create table t_strict (a integer) strict'); return true; } catch { return false; } })();
  db.exec(`create virtual table search using fts5(title, url, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4')`);
  const insert = db.prepare('insert into search (title, url) values (?, ?)');
  const words = ['chord', 'browser', 'calm', 'colorful', 'playful', 'fast', 'sidebar', 'space', 'tab', 'archive', 'pasta', 'limone', 'paris', 'weekend', 'hike', 'design', 'review', 'notes', 'metrics', 'shader'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = () => words[Math.floor(rnd() * words.length)];
  let t = performance.now();
  db.exec('begin');
  for (let i = 0; i < 50_000; i++) insert.run(`${pick()} ${pick()} ${pick()} ${i}`, `https://example${i % 500}.com/${pick()}/${i}`);
  db.exec('commit');
  result.insert50kMs = +(performance.now() - t).toFixed(1);
  const query = db.prepare(`select rowid, title from search where search match ? order by bm25(search) limit 20`);
  const timings = [];
  for (const q of ['ch*', 'pas*', 'wee* hik*', 'des* rev*', 'sha*', 'par*']) {
    t = performance.now();
    const rows = query.all(q);
    timings.push({ q, rows: rows.length, ms: +(performance.now() - t).toFixed(2) });
  }
  result.queries = timings;
  db.close();
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error?.stack ?? error);
}
process.parentPort.postMessage(result);
