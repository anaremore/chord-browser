import { defineConfig } from '@playwright/test';

/**
 * The sign-in sweep (test/signin-sweep), not a test suite and never run in CI: the sign-in pages
 * of a list of sites, one "test" each, run in the Linux container by scripts/dev/signin-sweep.
 * A few sites at a time (the host script's --workers), each within its own time limit.
 */
export default defineConfig({
  testDir: 'test/signin-sweep',
  outputDir: 'test-results/signin-sweep',
  timeout: 180_000,
  workers: 3,
  retries: 0,
  reporter: 'line',
});
