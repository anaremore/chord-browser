/**
 * Unit tests that need files make throwaway folders in tmpdir(). Each test
 * file gets its own temp folder, removed after its last test, so none of them
 * outlive the run (left behind, test folders filled a disk). The folder sits
 * in the real temp folder, kept in CHORD_TEST_REAL_TMP across files.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const PREFIX = 'chord-unit-';
/** Longer than any test file runs, so a sweep never takes a folder still in use. */
const STALE_MS = 3_600_000;

const remove = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // On Windows a stand-in CLI still exiting holds its working folder: a later sweep takes it.
  }
};

const base = (process.env['CHORD_TEST_REAL_TMP'] ??= tmpdir());
for (const name of readdirSync(base)) {
  if (!name.startsWith(PREFIX)) continue;
  const dir = join(base, name);
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) remove(dir);
  } catch {
    // Already gone.
  }
}
const root = mkdtempSync(join(base, PREFIX));
// os.tmpdir() reads TEMP and TMP on Windows, TMPDIR elsewhere, on every call.
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;

afterAll(() => {
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = base;
  remove(root);
});
