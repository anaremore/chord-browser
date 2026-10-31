import { defineConfig } from 'vitest/config';

/** The sync simulation (apps/desktop/test/sim): longer than `pnpm test` runs; `pnpm test:sim` runs it. */
export default defineConfig({
  test: {
    include: ['apps/desktop/test/sim/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 900_000,
  },
});
