import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/migrations';

/**
 * A profile's database as the build at `version` left it, open for a test to
 * add its rows: each migration up to it committed on its own, in WAL, as
 * chord-data runs them. One commit per migration, not per statement, so
 * making one is cheap enough beside the rest of the suite.
 */
export function oldDatabase(file: string, version: number): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF');
  for (let v = 0; v < version; v++) db.exec(`BEGIN; ${MIGRATIONS[v]!}; PRAGMA user_version = ${v + 1}; COMMIT;`);
  // As node:sqlite opens a database.
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
