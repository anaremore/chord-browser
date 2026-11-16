import { defineConfig } from '@playwright/test';

/**
 * The password detector's corpus suite (test/forms; S17 §13 layer 2): Playwright's own
 * Chromium, headless, no Electron and no window. `pnpm --filter @chord/desktop test:forms`.
 */
export default defineConfig({
  testDir: 'test/forms',
  outputDir: 'test-results/forms-output',
  timeout: 60_000,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: { browserName: 'chromium', headless: true },
});
