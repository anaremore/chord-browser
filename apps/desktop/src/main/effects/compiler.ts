/**
 * Main's side of Effects' worker (worker.ts): one thread, started when a
 * stylesheet changes and let go after half a minute without work, so nothing
 * runs while nobody edits. Requests are answered in order. If the thread dies
 * it starts again for the next request, at most a few times a launch.
 */
import type { EffectsParts } from '@chord/core';
import { Worker } from 'node:worker_threads';
import type { Compiled, Sanitized } from './sanitize';
import type { EffectsWorkerReply, EffectsWorkerRequest } from './worker';

const IDLE_MS = 30_000;
const MAX_STARTS = 5;
/** A request the worker never answers (it never should take more than a few ms) fails after this. */
const REQUEST_MS = 10_000;

type Request = { type: 'compile'; parts: EffectsParts } | { type: 'patch'; css: string };

export class EffectsCompiler {
  private worker: Worker | null = null;
  private starts = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** How long each request took, worker included, in ms (newest last; tests and the docs read it). */
  readonly timings: number[] = [];

  constructor(private readonly workerPath: string) {}

  /** A site's one stylesheet, from what's switched on. */
  compile(parts: EffectsParts): Promise<Compiled> {
    return this.request({ type: 'compile', parts }) as Promise<Compiled>;
  }

  /** One stylesheet on its own (a patch from Duet), as it's kept: nothing that fetches, and no !important added. */
  patch(css: string): Promise<Sanitized> {
    return this.request({ type: 'patch', css }) as Promise<Sanitized>;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    if (this.starts >= MAX_STARTS) throw new Error('Effects’ worker keeps stopping');
    this.starts++;
    const worker = new Worker(this.workerPath, { name: 'Effects' });
    worker.unref();
    worker.on('message', (reply: EffectsWorkerReply) => {
      const waiter = this.waiting.get(reply.id);
      if (!waiter) return;
      this.waiting.delete(reply.id);
      clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply.result);
      else waiter.reject(new Error(reply.error));
      this.rest();
    });
    const gone = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const waiter of this.waiting.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Effects’ worker stopped'));
      }
      this.waiting.clear();
    };
    worker.on('error', gone);
    worker.on('exit', gone);
    this.worker = worker;
    return worker;
  }

  private request(request: Request): Promise<unknown> {
    clearTimeout(this.idle);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.ensure();
      } catch (error) {
        reject(error as Error);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('Effects’ worker didn’t answer'));
        // A worker that hangs is replaced.
        void this.worker?.terminate();
      }, REQUEST_MS);
      timer.unref?.();
      this.waiting.set(id, {
        resolve: (value) => {
          this.timings.push(performance.now() - started);
          if (this.timings.length > 50) this.timings.shift();
          resolve(value);
        },
        reject,
        timer,
      });
      worker.postMessage({ ...request, id } satisfies EffectsWorkerRequest);
    });
  }

  /** Nothing waiting: the thread goes after a while. */
  private rest(): void {
    if (this.waiting.size > 0) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  stop(): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
  }
}
