/**
 * Effects' worker thread (built as out/main/effects.js): the sanitizer
 * (sanitize.ts) runs here, never on main. A 64 KB stylesheet takes about
 * 9 ms to parse and write out again, a typical one under a millisecond
 * (measured 2026-10-25), so main only ever passes strings along
 * (ARCHITECTURE.md §1, rule 1). Main starts it when a stylesheet changes and
 * lets it go after half a minute without work.
 */
import { parentPort } from 'node:worker_threads';
import { compileEffects, sanitizeCss, type Compiled, type EffectsParts, type Sanitized } from './sanitize';

export type EffectsWorkerRequest = { id: number; type: 'compile'; parts: EffectsParts } | { id: number; type: 'patch'; css: string };

export type EffectsWorkerReply = { id: number; ok: true; result: Compiled | Sanitized } | { id: number; ok: false; error: string };

/** One request's answer (exported for the unit tests, which run it without a thread). */
export function handle(request: EffectsWorkerRequest): EffectsWorkerReply {
  try {
    const result = request.type === 'compile' ? compileEffects(request.parts) : sanitizeCss(request.css);
    return { id: request.id, ok: true, result };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

parentPort?.on('message', (request: EffectsWorkerRequest) => parentPort!.postMessage(handle(request)));
