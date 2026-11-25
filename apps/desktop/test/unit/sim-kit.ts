/**
 * Seeded interleaving tests (`*.sim.test.ts`): a module with state that async steps, timers and outside events share
 * (a lease, a queue, a hold) driven by a fake scheduler through hundreds of random orders, its invariants checked after
 * every step. A race a review would need eight rounds to find shows up as a seed that fails, and that seed replays it.
 * The sync simulation (apps/desktop/test/sim, `pnpm test:sim`) is the heavy cousin; these run in `pnpm test`, each
 * file in under 2 s.
 *
 * Writing one (control/user-watch.sim.test.ts is the example):
 * 1. **Fakes for what the module talks to**, each with latencies from the seed's Rng on Vitest's fake timers: an
 *    answer that's late, one that never comes (the module's own timeout must end it), one that fails.
 * 2. **Operations**: every entry point (begin, end, cancel) and every outside event (a detach, a crash, a timer
 *    firing), picked at random by `sim.rng`, with fake time advanced between them (`sim.advance`).
 * 3. **Invariants** after every operation, and stronger ones once everything has settled (`sim.settle`): what must
 *    hold whatever the order (one owner at a time, nothing left on once it's all over, no listener left behind).
 * 4. **Seeds**: `forSeeds(400, …)`. A failure names its seed and the last steps of its trace; `SIM_SEED=123` runs that
 *    one seed alone with its whole trace printed.
 */
import { expect, vi } from 'vitest';

/** A small, fast seeded PRNG (mulberry32): the same seed, the same run. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  /** In [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** A whole number in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** True one time in 1/p on average. */
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  /** A latency in ms: mostly short, sometimes long. */
  latency(max = 200): number {
    return this.chance(0.8) ? this.int(20) : this.int(max);
  }
}

export interface Sim {
  seed: number;
  rng: Rng;
  /** One line per step: what a failing seed prints. */
  trace: string[];
  log(line: string): void;
  /** Fake time forward, running the timers and the promises they settle. */
  advance(ms: number): Promise<void>;
  /** Everything run out: time forward in steps until no timer is left (or `ms` has gone by), promises settled. */
  settle(ms?: number): Promise<void>;
}

/** How many trace lines a failure shows (all of them with SIM_SEED). */
const TRACE_TAIL = 40;

/**
 * Runs `run` once per seed, 1..count (or only SIM_SEED's), on fake timers. A failing seed's error says which seed it
 * was and the end of its trace.
 */
export async function forSeeds(count: number, run: (sim: Sim) => Promise<void>): Promise<void> {
  const only = Number(process.env['SIM_SEED'] ?? '');
  const seeds = only > 0 ? [only] : Array.from({ length: count }, (_, i) => i + 1);
  for (const seed of seeds) {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const trace: string[] = [];
    const sim: Sim = {
      seed,
      rng: new Rng(seed),
      trace,
      log: (line) => void trace.push(line),
      advance: (ms) => vi.advanceTimersByTimeAsync(ms).then(() => undefined),
      settle: async (ms = 120_000) => {
        for (let gone = 0; gone < ms && vi.getTimerCount() > 0; gone += 500) await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(0);
      },
    };
    try {
      await run(sim);
    } catch (error) {
      const tail = only > 0 ? trace : trace.slice(-TRACE_TAIL);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`seed ${seed} (SIM_SEED=${seed} replays it): ${message}\n--- trace${only > 0 ? '' : `, last ${tail.length} of ${trace.length}`} ---\n${tail.join('\n')}`, { cause: error });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    if (only > 0) console.log(trace.join('\n'));
  }
}

/** An invariant: fails with the seed's context when `ok` is false. */
export function invariant(ok: boolean, what: string): void {
  expect(ok, what).toBe(true);
}
