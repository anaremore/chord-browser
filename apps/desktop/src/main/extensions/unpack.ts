/**
 * Main's side of the extension unpacker (unpack-worker.ts): one short-lived
 * worker thread per package. The package's memory moves to the worker rather
 * than being copied, so main only starts the thread and waits.
 */
import { Worker } from 'node:worker_threads';
import type { UnpackJob, UnpackReply } from './unpack-worker';

/** Far more than any real package takes; a worker that hangs is ended so the install fails instead of spinning. */
const UNPACK_TIMEOUT_MS = 5 * 60_000;

export const WORKER_STOPPED = 'Chord’s extension installer stopped unexpectedly.';

/**
 * Verify and unpack a CRX3 in a worker. Resolves with the file count;
 * rejects with why it was refused (the verifier's or unpacker's own words),
 * or with WORKER_STOPPED if the thread died. `job.crx` is detached after the
 * call when it owns its memory; don't read it again.
 */
export function unpackInWorker(workerPath: string, job: UnpackJob, timeoutMs = UNPACK_TIMEOUT_MS): Promise<number> {
  const { crx } = job;
  // A Buffer that owns its whole ArrayBuffer is moved; a slice of a shared pool (small Buffers) is copied.
  const owned = crx.byteOffset === 0 && crx.byteLength === crx.buffer.byteLength && crx.buffer instanceof ArrayBuffer;
  const data = owned ? crx : new Uint8Array(crx);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        name: 'Extension installer',
        workerData: { chordExtensionUnpack: { ...job, crx: data } },
        transferList: [data.buffer as ArrayBuffer],
      });
    } catch {
      reject(new Error(WORKER_STOPPED));
      return;
    }
    let settled = false;
    const finish = (reply: UnpackReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (reply.ok) resolve(reply.files);
      else reject(new Error(reply.error));
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Unpacking the extension took too long.' }), timeoutMs);
    worker.once('message', (reply: UnpackReply) => finish(reply));
    worker.once('error', (error) => {
      console.error('[chord] The extension installer’s worker failed:', error);
      finish({ ok: false, error: WORKER_STOPPED });
    });
    worker.once('exit', () => finish({ ok: false, error: WORKER_STOPPED }));
  });
}
