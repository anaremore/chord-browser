/**
 * Installing a downloaded Chord Player (ARCHITECTURE.md §9), off main
 * (performance rule 1): a worker thread hashes the zip, refuses it unless its
 * SHA-512 is the one the signed manifest names, then unpacks it beside its
 * final folder and moves it into place only once every file checked out
 * (@chord/player-protocol's extractZip). Built as out/main/player-unpack.js;
 * started for one zip and ended after.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { extractZip } from '@chord/player-protocol';

export interface UnpackJob {
  zip: string;
  /** The manifest's SHA-512 of the zip, base64. */
  sha512: string;
  /** The version's folder; it must not be in use. */
  dest: string;
  maxBytes: number;
}

export type UnpackMessage = { t: 'verified' } | { t: 'progress'; percent: number } | { t: 'done' } | { t: 'error'; why: 'verify' | 'unpack'; message: string };

const post = (message: UnpackMessage) => parentPort?.postMessage(message);

async function run(job: UnpackJob): Promise<void> {
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

if (parentPort) void run(workerData as UnpackJob);
