// Spike S11, mode engine-worker: Ghostery's engine in a worker thread; main's
// webRequest listener only forwards each request and answers when this does.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'package.json'));
const { FiltersEngine, Request } = require('@ghostery/adblocker');

const t = performance.now();
const engine = FiltersEngine.deserialize(readFileSync(workerData.engine));
parentPort.postMessage({ ready: true, deserializeMs: performance.now() - t });
parentPort.on('message', ({ id, url, sourceUrl, type }) => {
  const { match } = engine.match(Request.fromRawDetails({ url, sourceUrl, type }));
  parentPort.postMessage({ id, match });
});
