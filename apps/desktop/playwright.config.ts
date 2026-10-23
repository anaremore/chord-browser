import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results',
  // One temp folder per run, removed when it ends: profiles never pile up.
  globalSetup: './test/run-temp.ts',
  timeout: 60_000,
  // One app at a time: each test launches its own Electron instance.
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
});
