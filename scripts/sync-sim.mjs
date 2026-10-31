#!/usr/bin/env node
/**
 * The sync simulation (apps/desktop/test/sim) over many seeds, across
 * processes: `pnpm test:sim [--from 1] [--to 2000] [--jobs 8] [--steps 120]`.
 * Each process runs a range of seeds with vitest (vitest.sim.config.ts);
 * a failing seed's whole trace goes to --dump (a folder, made if needed).
 * Exits non-zero if any seed broke an invariant.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** How long a range may take, per seed in it (each takes about a second; some, a few). */
const SEED_MS = 20_000;

/** `--from 1 --to 2000 --jobs 8 --steps 120 --dump dir`, or `--from=1`. */
export function parseArgs(argv) {
  const out = { from: 1, to: 500, jobs: Math.max(1, Math.min(8, availableParallelism() - 2)), steps: 120, dump: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = inline ?? argv[++i];
    if (flag === '--from') out.from = Number(value);
    else if (flag === '--to') out.to = Number(value);
    else if (flag === '--jobs') out.jobs = Number(value);
    else if (flag === '--steps') out.steps = Number(value);
    else if (flag === '--dump') out.dump = value;
    else if (flag === '--') i--;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  for (const key of ['from', 'to', 'jobs', 'steps']) if (!Number.isInteger(out[key]) || out[key] < 1) throw new Error(`--${key} must be a whole number above 0`);
  if (out.to < out.from) throw new Error('--to must be at least --from');
  return out;
}

/** The seeds split into at most `jobs` ranges of about `size`, handed out as processes finish. */
export function ranges(from, to, jobs, size = 25) {
  const out = [];
  const step = Math.max(1, Math.min(size, Math.ceil((to - from + 1) / jobs)));
  for (let start = from; start <= to; start += step) out.push([start, Math.min(to, start + step - 1)]);
  return out;
}

function runRange([from, to], options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.sim.config.ts', '--reporter=verbose', '--silent=false'], {
      cwd: root,
      env: { ...process.env, SIM_FROM: String(from), SIM_TO: String(to), SIM_STEPS: String(options.steps), ...(options.dump ? { SIM_DUMP: options.dump } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    // A seed takes about a second; one that runs on and on (time that never moves on) fails its range, said.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, (to - from + 1) * SEED_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const failed = [...output.matchAll(/^\s*[×✗x] .*seed (\d+)/gmu)].map((m) => Number(m[1]));
      const passed = new Set([...output.matchAll(/^\s*[✓√] .*seed (\d+)/gmu)].map((m) => Number(m[1])));
      if (timedOut) {
        for (let seed = from; seed <= to; seed++) {
          if (passed.has(seed) || failed.includes(seed)) continue;
          failed.push(seed);
          console.log(`seed ${seed}: took too long (or never ran)`);
        }
      }
      const stats = [...output.matchAll(/^seed (\d+) (\{.*\})$/gmu)].map((m) => JSON.parse(m[2]));
      resolve({ from, to, code: timedOut ? 1 : code, failed, stats });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dump) mkdirSync(options.dump, { recursive: true });
  const queue = ranges(options.from, options.to, options.jobs);
  const results = [];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(options.jobs, queue.length) }, async () => {
      for (let range = queue.shift(); range; range = queue.shift()) {
        const result = await runRange(range, options);
        results.push(result);
        process.stdout.write(`seeds ${result.from}-${result.to}: ${result.code === 0 ? 'ok' : `FAILED ${result.failed.join(', ') || `(exit ${result.code})`}`}\n`);
      }
    }),
  );
  const totals = {};
  let seeds = 0;
  for (const r of results) {
    for (const s of r.stats) {
      seeds++;
      for (const [key, n] of Object.entries(s)) totals[key] = (totals[key] ?? 0) + n;
    }
  }
  const failed = results.flatMap((r) => (r.code === 0 ? [] : r.failed.length > 0 ? r.failed : [`${r.from}-${r.to}`]));
  console.log(`\n${seeds} seeds in ${Math.round((Date.now() - started) / 1000)} s, ${failed.length === 0 ? 'every invariant kept' : `${failed.length} failed: ${failed.join(', ')}`}`);
  console.log(`totals ${JSON.stringify(totals)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
