/**
 * Chord never changes another browser's files. Browsers keep their databases
 * open (on Windows, locked), so each one is copied into the import's own temp
 * folder, with its write-ahead log, where recent changes wait, and read from
 * there read-only. Main removes the folder when the import process ends,
 * whether it finished or died. Plain files (JSON, plists, session files) are
 * only read.
 */
import { copyFile, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Why a profile couldn't be read: `denied` is macOS asking for Full Disk
 * Access (Safari), `locked` the browser holding a file Chord couldn't copy.
 */
export type ImportProblemKind = 'denied' | 'locked' | 'unreadable' | 'missing';

export class ImportProblem extends Error {
  constructor(readonly problem: ImportProblemKind) {
    super(problem);
  }
}

/** The problem behind a failed read. */
export function problemOf(error: unknown, platform: NodeJS.Platform = process.platform): ImportProblemKind {
  if (error instanceof ImportProblem) return error.problem;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'missing';
  if (platform === 'darwin' && (code === 'EPERM' || code === 'EACCES')) return 'denied';
  if (platform === 'win32' && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) return 'locked';
  return 'unreadable';
}

/** Larger than any bookmarks or session file. */
const MAX_FILE = 256 * 1024 * 1024;

/** A file's bytes, or null when there's no such file. */
export async function readIfThere(file: string): Promise<Buffer | null> {
  try {
    if ((await stat(file)).size > MAX_FILE) throw new ImportProblem('unreadable');
    return await readFile(file);
  } catch (error) {
    if (problemOf(error) === 'missing') return null;
    throw new ImportProblem(problemOf(error));
  }
}

/** Copies made so far, by temp folder and database: an import reads the copy its counts came from. */
const copied = new Map<string, string>();

/**
 * A copy of a SQLite database (and its write-ahead log) in `temp`, opened
 * read-only; null when there's no such database. The same database again
 * opens the copy already made.
 */
export async function openCopy(file: string, temp: string): Promise<DatabaseSync | null> {
  const id = `${temp}\0${file}`;
  let to = copied.get(id);
  if (!to) {
    to = join(temp, `${copied.size + 1}-${basename(file)}`);
    try {
      await copyFile(file, to);
    } catch (error) {
      if (problemOf(error) === 'missing') return null;
      throw new ImportProblem(problemOf(error));
    }
    // No log is fine: the browser had nothing waiting, or isn't running.
    await copyFile(`${file}-wal`, `${to}-wal`).catch(() => undefined);
    copied.set(id, to);
  }
  try {
    return new DatabaseSync(to, { readOnly: true });
  } catch {
    throw new ImportProblem('unreadable');
  }
}

/** A single `COUNT(*) AS n`. */
export function countOf(db: DatabaseSync, sql: string): number {
  try {
    return Number((db.prepare(sql).get() as { n?: unknown } | undefined)?.n ?? 0);
  } catch {
    throw new ImportProblem('unreadable');
  }
}
