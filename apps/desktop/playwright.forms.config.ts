import { defineConfig } from '@playwright/test';

/**
 * The password detector's corpus suite (test/forms; S17 §13 layer 2): Playwright's own
 * Chromium, headless, no Electron and no window. `pnpm --filter @chord/desktop test:forms`.
 *
 * Two projects, run as two CI jobs: `corpus` (DuckDuckGo's corpus, Chord's fixtures, the agent)
 * and `ttw` (Bitwarden's test-the-web, whose build runs a third party's packages, so its job
 * shares no cache a release restores). Locally both run; `--project ttw` picks one.
 */
export default defineConfig({
  testDir: 'test/forms',
  outputDir: 'test-results/forms-output',
  timeout: 60_000,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: { browserName: 'chromium', headless: true },
  projects: [
    { name: 'corpus', testIgnore: /ttw\.spec\.ts$/ },
    { name: 'ttw', testMatch: /ttw\.spec\.ts$/ },
  ],
});
