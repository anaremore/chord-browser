import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/out/**', '**/dist/**', '**/release/**', '**/node_modules/**', '**/coverage/**', '**/test-results/**'] },
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
    files: ['**/scripts/**/*.{js,mjs}', 'spikes/**/*.{js,mjs}', '*.config.{js,ts}', 'apps/*/*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // The domain core and design tokens must stay free of Electron and DOM.
    files: ['packages/core/**/*.ts', 'packages/tokens/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['electron'], patterns: ['electron/*'] }],
    },
  },
]);
