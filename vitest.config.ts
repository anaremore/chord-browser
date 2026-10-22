import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts', 'apps/*/test/web/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node',
  },
});
