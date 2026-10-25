import { defineConfig } from '@playwright/test';

/**
 * The README's and the website's screenshots (test/shots), not a test suite: run in the Linux
 * container by scripts/dev/shots.mjs. The E2E suite is playwright.config.ts.
 */
export default defineConfig({
  testDir: 'test/shots',
  outputDir: 'test-results',
  // One temp folder per run, removed when it ends: the throwaway profiles go with it.
  globalSetup: './test/run-temp.ts',
  timeout: 4 * 60_000,
  workers: 1,
  reporter: 'list',
});
