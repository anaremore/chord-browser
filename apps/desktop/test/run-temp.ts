/**
 * Playwright's global setup: one temp folder per test run, removed when the
 * run ends. Every launch makes a throwaway profile (mkdtemp in tmpdir()) and
 * Chromium writes temp files of its own; left behind, they filled a disk with
 * tens of gigabytes. Pointing TEMP/TMP/TMPDIR at the run's folder gathers all
 * of it: the workers and the Chords they launch inherit the variables. Folders
 * left by runs that were killed are swept when the next run starts.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'chord-test-run-';
/** Longer than any run, so a sweep never takes the folder of a run still going. */
const STALE_MS = 6 * 3_600_000;

export default function globalSetup(): () => void {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still in use, or already gone: the next run tries again.
    }
  }
  const root = mkdtempSync(join(base, PREFIX));
  // os.tmpdir() reads TEMP and TMP on Windows, TMPDIR elsewhere, on every call.
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
