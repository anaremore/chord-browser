import { defineConfig } from '@playwright/test';

/** Smoke test for packaged builds (test/packaged); the dev-build E2E suite is playwright.config.ts. */
export default defineConfig({
  testDir: 'test/packaged',
  outputDir: 'test-results/packaged',
  // One temp folder per run, removed when it ends: profiles never pile up.
  globalSetup: './test/run-temp.ts',
  timeout: 120_000,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
});
