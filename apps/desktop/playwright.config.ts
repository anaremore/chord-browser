import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { filesFor } from '../../scripts/ci/e2e-shards.mjs';

// CI's shards (scripts/ci/e2e-shards.mjs): CHORD_E2E_SHARD=<index>/<count> runs that shard's spec files, balanced by
// how long each takes, and CHORD_E2E_SHARD=perf runs perf.spec.ts alone. Unset, every file runs.
// A repro by hand (ci.yml's workflow_dispatch with a platform) names its own: CHORD_E2E_SPEC (spec files,
// space-separated; every file when empty), CHORD_E2E_GREP (a title filter) and CHORD_E2E_REPEAT (runs of each test).
const shard = process.env['CHORD_E2E_SHARD'];
const spec = process.env['CHORD_E2E_SPEC']?.split(/\s+/).filter(Boolean) ?? [];
const grep = process.env['CHORD_E2E_GREP'];
const repeat = Number(process.env['CHORD_E2E_REPEAT']) || 1;
const testDir = join(import.meta.dirname, 'test/e2e');
const exactly = (file: string) => new RegExp(`[\\\\/]${file.replaceAll('.', '\\.')}$`);
const testMatch = spec.length ? spec.map(exactly) : shard ? filesFor(shard, testDir).map(exactly) : undefined;

export default defineConfig({
  testDir: 'test/e2e',
  ...(testMatch ? { testMatch } : {}),
  ...(grep ? { grep: new RegExp(grep) } : {}),
  ...(repeat > 1 ? { repeatEach: repeat } : {}),
  outputDir: 'test-results',
  // One temp folder per run, removed when it ends: profiles never pile up. Spelling dictionaries
  // from a local server, never downloaded from Google during a test (test/dictionaries.ts).
  globalSetup: ['./test/run-temp.ts', './test/dictionaries.ts'],
  timeout: 60_000,
  // CI's shared machines sometimes take more than the default 5 s over a cold app's first page load
  // (its tab still named by its address). A check that passes is no slower; one that fails says so later.
  expect: { timeout: process.env['CI'] ? 10_000 : 5_000 },
  // About one test in each CI run (of some 1,800 across the runners) stalls on a shared machine, never the same one
  // twice, and none reproduce in the Linux container. One retry on CI: Playwright still reports those as flaky,
  // and a real failure, a performance baseline's included, fails both tries.
  retries: process.env['CI'] ? 1 : 0,
  // One app at a time: each test launches its own Electron instance.
  workers: 1,
  // On CI, a JSON report too: scripts/ci/flaky-summary.mjs lists every test that passed only on its retry in the job's
  // summary, so a repeat flake shows before it fails twice in one run. And the step times (test/e2e/step-times-reporter.ts):
  // where each shard's time goes, by kind of step.
  reporter: process.env['CI'] ? [['list'], ['github'], ['json', { outputFile: 'playwright-report/results.json' }], ['./test/e2e/step-times-reporter.ts']] : 'list',
});
