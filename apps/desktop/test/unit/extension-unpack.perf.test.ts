/**
 * The unit perf suite's row for extensions (docs/testing/performance.md):
 * installing a large extension blocks main ≤ 50 ms, through the installer's
 * worker as the app builds it. Runs alone, in `pnpm test:perf`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unpackInWorker } from '../../src/main/extensions/unpack';
import { unpack } from '../../src/main/extensions/unpack-worker';
import { crx3, extensionIdOf, keyPair, sha256Hex, spki, zip } from '../fixtures/crx';
import { buildUnpackWorker } from '../fixtures/extension-worker';

const developer = keyPair('rsa');
const publisher = keyPair('ec');
const publisherKeyHash = sha256Hex(spki(publisher.publicKey));
const id = extensionIdOf(developer.publicKey);
const manifest = (version: string) => JSON.stringify({ manifest_version: 3, name: 'Fixture', version });

let dir: string;
let workerPath: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chord-ext-perf-'));
  workerPath = await buildUnpackWorker(dir);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

let n = 0;
const dest = () => join(dir, 'Extensions', 'default', id, `run-${n++}`);

/**
 * How long main is held while `job` runs: a setImmediate loop spins on main
 * (timers tick only every 15 ms on Windows), and its longest gap is the
 * longest stretch main couldn't answer anything.
 */
async function mainBlocking<T>(job: () => Promise<T>): Promise<{ result: T; longest: number; total: number }> {
  let spinning = true;
  let longest = 0;
  let last = performance.now();
  const spin = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (spinning) setImmediate(spin);
  };
  setImmediate(spin);
  const started = performance.now();
  try {
    return { result: await job(), longest, total: performance.now() - started };
  } finally {
    spinning = false;
  }
}

/** About 20 MB unpacked in 400 files: half script text, half incompressible bytes, as a large real bundle is. */
function largePackage(version: string): Buffer {
  const files: Record<string, Buffer> = { 'manifest.json': Buffer.from(manifest(version)) };
  for (let i = 0; i < 400; i++) {
    const size = 50_000;
    const buf = Buffer.alloc(size);
    if (i % 2) for (let j = 0; j < size; j += 4) buf.writeUInt32LE((Math.imul(i * 7919 + j, 2654435761) ^ (j << 7)) >>> 0, j);
    else buf.write(`function f${i}(x) { return x * ${i}; }
`.repeat(size / 40));
    files[`js/chunk-${i}.js`] = buf;
  }
  return crx3(zip(files), developer, [developer, publisher]);
}

/**
 * Budget (docs/testing/performance.md): installing a large extension blocks
 * main ≤ 50 ms. Verifying and unpacking the package on main itself, as
 * before, is measured alongside for the report: it held main for the whole
 * job.
 */
describe('main-thread budget', () => {
  it('installing a large package blocks main ≤ 50 ms', async () => {
    const first = largePackage('3.1.4');
    const onMain = await mainBlocking(() => unpack({ crx: first, sha256: sha256Hex(first), id, version: '3.1.4', dest: dest(), publisherKeyHash }));
    expect(onMain.result).toEqual({ ok: true, files: 401 });
    const crx = largePackage('3.1.5');
    const size = crx.length;
    const sha256 = sha256Hex(crx);
    const inWorker = await mainBlocking(() => unpackInWorker(workerPath, { crx, sha256, id, version: '3.1.5', dest: dest(), publisherKeyHash }));
    expect(inWorker.result).toBe(401);
    const ms = (n: number) => `${n.toFixed(1)} ms`;
    console.log(
      `[extension-unpack] ${(size / 1e6).toFixed(1)} MB package. On main: ${ms(onMain.total)}, main held ${ms(onMain.longest)}. ` +
        `In the worker: ${ms(inWorker.total)}, main held ${ms(inWorker.longest)}.`,
    );
    // Generous for a slow runner, and still far below what the job takes on main.
    expect(inWorker.longest).toBeLessThanOrEqual(50);
  });
});
