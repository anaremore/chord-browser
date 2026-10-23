import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/out/**', '**/dist/**', '**/release/**', '**/node_modules/**', '**/coverage/**', '**/test-results/**', '**/.cache/**', '.claude/**', '.qa/**', 'packages/chrome-extensions/src/**', 'packages/chrome-extensions/types/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              importNames: ['remote'],
              message: 'The remote module is not used in Chord.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/scripts/**/*.{js,mjs}', 'spikes/**/*.{js,mjs}', '*.config.{js,ts}', 'apps/*/*.config.ts', 'packages/chrome-extensions/*.mjs', 'apps/*/test/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // On Linux, Playwright launches Electron with --no-sandbox unless told otherwise.
    files: ['apps/*/test/**/*.{ts,mjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='electron'][callee.property.name='launch']:not(:has(Property[key.name='chromiumSandbox'][value.value=true]))",
          message: 'Launch with chromiumSandbox: true. Chord never runs without its sandbox, and on Linux Playwright turns it off unless told.',
        },
      ],
    },
  },
  {
    // The test extension runs in Chrome's extension environment.
    files: ['apps/desktop/test/fixtures/extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    // The domain core and design tokens must stay free of Electron and DOM.
    files: ['packages/core/**/*.ts', 'packages/tokens/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['electron'], patterns: ['electron/*'] }],
    },
  },
]);
