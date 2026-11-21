/**
 * Installing and updating Web Store extensions, off main (ARCHITECTURE.md
 * §12, performance rule 1): a worker thread verifies the CRX3 (signatures,
 * the developer's and the store's keys, the ID asked for, the hash the store
 * announced), unpacks its ZIP
 * within the size and file limits, checks the manifest's version and writes
 * the developer key into it. A large package (a password manager, an ad
 * blocker) takes seconds of RSA, inflate and file writes; none of it runs on
 * the thread that draws windows. Built as out/main/extension-unpack.js;
 * started for one package and ended after.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { extractZip, verifyCrx3, type ExtractLimits } from './crx';

export interface UnpackJob {
  /** The downloaded package (its memory is handed to the worker, not copied). */
  crx: Uint8Array;
  /** SHA-256 (hex) the Web Store's update service announced for the download, when it did. */
  sha256?: string;
  /** The extension ID the package must be for. */
  id: string;
  /** The version the store said it is; the manifest must agree. */
  version: string;
  /** The version's folder: emptied first, and removed again if anything fails. */
  dest: string;
  /** SHA-256 (hex) of the publisher key: the Web Store's unless a test says otherwise. */
  publisherKeyHash?: string;
  /** Tests only: smaller limits than a real package gets. */
  limits?: ExtractLimits;
}

export type UnpackReply = { ok: true; files: number } | { ok: false; error: string };

/** The whole job, also callable in-process (benchmarks); the worker is the only caller in the app. */
export async function unpack(job: UnpackJob): Promise<UnpackReply> {
  const crx = Buffer.from(job.crx.buffer, job.crx.byteOffset, job.crx.byteLength);
  let created = false;
  try {
    if (job.sha256 && createHash('sha256').update(crx).digest('hex') !== job.sha256.toLowerCase()) {
      throw new Error('The download doesn’t match what the Chrome Web Store described');
    }
    const { archive, publicKey } = verifyCrx3(crx, job.id, job.publisherKeyHash ? { publisherKeyHash: job.publisherKeyHash } : {});
    await rm(job.dest, { recursive: true, force: true });
    await mkdir(job.dest, { recursive: true });
    created = true;
    const files = extractZip(archive, job.dest, job.limits);
    const manifestPath = join(job.dest, 'manifest.json');
    // Some manifests start with a byte-order mark, which JSON.parse rejects (\s matches it).
    const text = await readFile(manifestPath, 'utf8').catch(() => {
      throw new Error('The package has no manifest.json.');
    });
    const manifest = JSON.parse(text.replace(/^\s+/, '')) as Record<string, unknown>;
    if (manifest.version !== job.version) throw new Error(`The package is version ${String(manifest.version)}, not ${job.version}.`);
    // With its public key in the manifest, the extension keeps the store's ID wherever it's unpacked.
    manifest.key = publicKey.toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true, files };
  } catch (error) {
    if (created) await rm(job.dest, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort && (workerData as { chordExtensionUnpack?: UnpackJob } | null)?.chordExtensionUnpack) {
  const port = parentPort;
  void unpack((workerData as { chordExtensionUnpack: UnpackJob }).chordExtensionUnpack).then((reply) => port.postMessage(reply));
}
