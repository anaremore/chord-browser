/**
 * Chord Player's files (ARCHITECTURE.md §9), off main (performance rule 1):
 * a worker thread installs a downloaded player (hashes the zip, refuses it
 * unless its SHA-512 is the one the signed manifest names, unpacks it beside
 * its final folder and moves it into place only once every file checked out,
 * with @chord/player-protocol's extractZip), and removes versions. Built as
 * out/main/player-unpack.js; started for one job and ended after.
 *
 * The player's folders hold an `app.asar`, which Electron's file functions
 * would open as an archive (and refuse to write or delete): this thread
 * turns that off for itself (`process.noAsar`), which main can't do without
 * affecting how Chord reads its own app.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { extractZip } from '@chord/player-protocol';

(process as unknown as { noAsar: boolean }).noAsar = true;

export interface UnpackJob {
  op: 'unpack';
  zip: string;
  /** The manifest's SHA-512 of the zip, base64. */
  sha512: string;
  /** The version's folder; it must not be in use. */
  dest: string;
  maxBytes: number;
}

/** Folders to delete (versions, or the whole player): what fails (a version still running, on Windows) is left for next time. */
export interface RemoveJob {
  op: 'remove';
  paths: string[];
}

export type UnpackMessage = { t: 'verified' } | { t: 'progress'; percent: number } | { t: 'done'; failed?: string[] } | { t: 'error'; why: 'verify' | 'unpack'; message: string };

const post = (message: UnpackMessage) => parentPort?.postMessage(message);

async function unpack(job: UnpackJob): Promise<void> {
  const hash = createHash('sha512');
  try {
    await pipeline(createReadStream(job.zip), hash);
  } catch (error) {
    return post({ t: 'error', why: 'verify', message: (error as Error).message });
  }
  if (hash.digest('base64') !== job.sha512) return post({ t: 'error', why: 'verify', message: 'The download doesn’t match its signed manifest' });
  post({ t: 'verified' });
  const partial = `${job.dest}.partial-${randomBytes(4).toString('hex')}`;
  let last = -1;
  try {
    await extractZip(job.zip, partial, {
      maxBytes: job.maxBytes,
      onProgress: (done, total) => {
        const percent = total ? Math.floor((done / total) * 100) : 100;
        if (percent !== last) post({ t: 'progress', percent });
        last = percent;
      },
    });
    await rm(job.dest, { recursive: true, force: true });
    await rename(partial, job.dest);
    post({ t: 'done' });
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    post({ t: 'error', why: 'unpack', message: (error as Error).message });
  }
}

async function remove(job: RemoveJob): Promise<void> {
  const failed: string[] = [];
  for (const path of job.paths) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      failed.push(path);
    }
  }
  post({ t: 'done', failed });
}

if (parentPort) {
  const job = workerData as UnpackJob | RemoveJob;
  void (job.op === 'remove' ? remove(job) : unpack(job));
}
