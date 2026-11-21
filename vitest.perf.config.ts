import { defineConfig } from 'vitest/config';

/**
 * The unit perf suite (`pnpm test:perf`, docs/testing/performance.md): tests
 * with a wall-clock budget, named `*.perf.test.ts`. One file at a time, so no
 * other test shares the CPUs or the disk while one is timed. `pnpm test`
 * leaves them out (vitest.config.ts).
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.perf.test.ts', 'apps/*/test/unit/**/*.perf.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // A test measures many runs, and each holds its own budget: a slow runner fails on that budget, with the number
    // it measured, never on vitest's 5 s default for the whole test.
    testTimeout: 120_000,
    // Each row prints what it measured.
    silent: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
