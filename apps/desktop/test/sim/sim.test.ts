/**
 * The sync simulation, a range of seeds (`SIM_FROM` to `SIM_TO`): each run
 * must keep every invariant (sim.ts). Not part of `pnpm test`, it's run by
 * `pnpm test:sim` (scripts/sync-sim.mjs), thousands of seeds across processes.
 * A failing seed prints its trace; it then goes into
 * test/unit/sync-sim-seeds.test.ts, which runs in `pnpm test`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./electron')).electron);
const { runSeed } = await import('./sim');

const from = Number(process.env['SIM_FROM'] ?? 1);
const to = Number(process.env['SIM_TO'] ?? from + 4);
const steps = Number(process.env['SIM_STEPS'] ?? 120);

describe('the sync simulation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    // SIM_DEBUG: a loop of timers that never lets time move on says where it is.
    if (process.env['SIM_DEBUG']) {
      for (const name of ['setImmediate', 'setTimeout'] as const) {
        const faked = globalThis[name] as (...args: unknown[]) => unknown;
        let count = 0;
        (globalThis as Record<string, unknown>)[name] = (...args: unknown[]) => {
          if (++count % 200_000 === 0) console.log(`${name} called ${count} times, at ${Date.now()}:`, new Error().stack);
          return faked(...args);
        };
      }
    }
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (let seed = from; seed <= to; seed++) {
    it(`seed ${seed}`, async () => {
      const result = await runSeed({ seed, steps, trace: process.env['SIM_TRACE'] === '1' });
      // SIM_DUMP: a failing seed's whole trace, to a file there.
      const dump = process.env['SIM_DUMP'];
      if (dump && result.violations.length > 0) writeFileSync(join(dump, `seed-${seed}.log`), `${result.trace.join('\n')}\n\n${result.violations.join('\n')}\n`);
      if (result.violations.length > 0) console.log(`seed ${seed}:\n${result.trace.slice(-200).join('\n')}\n${result.violations.join('\n')}`);
      console.log(`seed ${seed} ${JSON.stringify(result.stats)}`);
      expect(result.violations).toEqual([]);
    }, 900_000);
  }
});
