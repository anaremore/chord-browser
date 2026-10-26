// Sync's worker, as the spike runs it (see main.mjs): node:sqlite on the same
// file, scrypt at S15's parameters, AES-256-GCM and deflate, a folder watched.
import { createCipheriv, randomBytes, scrypt } from 'node:crypto';
import { watch, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';

const out = { ok: false };
const time = async (name, work) => {
  const at = performance.now();
  try {
    out[name] = await work();
  } catch (error) {
    out[name] = { error: String(error?.stack ?? error) };
  }
  out[`${name}Ms`] = Math.round(performance.now() - at);
};

await time('sqlite', () => {
  // Its own connection, read-only, as the export process reads: the tables stay chord-data's.
  const db = new DatabaseSync(workerData.file, { readOnly: true, timeout: 5000 });
  const n = db.prepare('SELECT COUNT(*) AS n FROM sync_record').get().n;
  db.close();
  return { rows: Number(n) };
});
await time('scrypt', () => new Promise((resolve, reject) => scrypt('correct horse battery staple', randomBytes(32), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve({ bytes: key.length })))));
await time('seal8MiB', () => {
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, randomBytes(12));
  const sealed = Buffer.concat([cipher.update(randomBytes(8 * 1024 * 1024)), cipher.final(), cipher.getAuthTag()]);
  return { bytes: sealed.length };
});
await time('deflate4MiB', () => ({ bytes: deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 'chord sync '), { level: 6 }).length }));
await time('watch', () =>
  new Promise((resolve) => {
    const folder = join(workerData.dir, 'Chord sync');
    mkdirSync(folder, { recursive: true });
    const timeout = setTimeout(() => {
      watcher.close();
      resolve({ fired: false });
    }, 3000);
    const watcher = watch(folder, { recursive: process.platform !== 'linux' }, (event, name) => {
      clearTimeout(timeout);
      watcher.close();
      resolve({ fired: true, event, name });
    });
    setTimeout(() => writeFileSync(join(folder, '000001.chordlog'), 'x'), 50);
  }),
);
out.ok = !out.sqlite?.error && !out.scrypt?.error && !out.seal8MiB?.error && !out.deflate4MiB?.error;
parentPort.postMessage(out);
