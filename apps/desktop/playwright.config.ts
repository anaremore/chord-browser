import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results',
  // One temp folder per run, removed when it ends: profiles never pile up.
  globalSetup: './test/run-temp.ts',
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
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
});
