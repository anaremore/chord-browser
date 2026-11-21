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
    // Each row prints what it measured.
    silent: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
