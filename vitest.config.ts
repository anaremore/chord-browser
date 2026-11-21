import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts', 'apps/*/test/web/**/*.test.ts', 'scripts/test/**/*.test.ts', 'site/test/**/*.test.ts'],
    // Timed tests run alone in the perf suite (vitest.perf.config.ts, `pnpm test:perf`), not beside every other file.
    exclude: ['**/node_modules/**', '**/*.perf.test.ts'],
    environment: 'node',
    // Each test file's temp folders go when it finishes.
    setupFiles: ['./vitest.setup.ts'],
  },
});
