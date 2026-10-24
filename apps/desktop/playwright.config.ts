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
  // One app at a time: each test launches its own Electron instance.
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
});
