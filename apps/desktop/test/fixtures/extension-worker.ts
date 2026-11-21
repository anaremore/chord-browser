/**
 * The extension installer's worker (src/main/extensions/unpack-worker.ts),
 * bundled into one file the way electron.vite.config.ts builds it, so tests
 * run packages through the real thread.
 */
import { join, resolve } from 'node:path';
import { build } from 'rolldown';

export async function buildUnpackWorker(dir: string): Promise<string> {
  const file = join(dir, 'extension-unpack.mjs');
  await build({
    input: resolve(import.meta.dirname, '../../src/main/extensions/unpack-worker.ts'),
    platform: 'node',
    write: true,
    logLevel: 'silent',
    output: { file, format: 'esm' },
  });
  return file;
}
