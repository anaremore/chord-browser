import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { compileLists } from './src/main/ad-blocking/compile';
import { FILTER_LISTS, type ListId } from './src/main/ad-blocking/lists';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);

/**
 * EasyList and EasyPrivacy, compiled once per build (ARCHITECTURE.md §9) from
 * the copies in build/ad-blocking (`pnpm lists` refreshes them): Ghostery's
 * engine and the declarativeNetRequest rules land in out/main/ad-blocking, so
 * a fresh install blocks from its first page and parses nothing to start.
 */
function filterLists(): Plugin {
  return {
    name: 'chord-filter-lists',
    generateBundle() {
      const texts = Object.fromEntries(FILTER_LISTS.map((l) => [l.id, readFileSync(resolve(import.meta.dirname, 'build', 'ad-blocking', `${l.id}.txt`), 'utf8')])) as Record<ListId, string>;
      const { engine, rules, info } = compileLists(texts);
      this.emitFile({ type: 'asset', fileName: 'ad-blocking/engine.bin', source: engine });
      for (const list of FILTER_LISTS) this.emitFile({ type: 'asset', fileName: `ad-blocking/rules/${list.id}.json`, source: JSON.stringify(rules[list.id]) });
      this.emitFile({ type: 'asset', fileName: 'ad-blocking/lists.json', source: JSON.stringify(info) });
    },
  };
}

export default defineConfig({
  main: {
    // Google's Safe Browsing API key (ARCHITECTURE.md §14.5), from the environment at build time: the
    // release workflow passes the `release` environment's secret. Without it Safe Browsing is unavailable.
    define: { __CHORD_SAFE_BROWSING_KEY__: JSON.stringify(process.env['CHORD_SAFE_BROWSING_KEY'] ?? '') },
    // Bundle everything (workspace packages are TypeScript sources); only
    // electron and Node built-ins stay external. The entries: main itself,
    // chord-data's utility process (ARCHITECTURE.md §4), the PDF reader
    // Duet starts for each PDF it reads (§11.4; pdf.js stays out of main),
    // Safe Browsing's worker thread (§14.5), ad blocking's (§9; the engine
    // stays out of main), the process that reads other browsers' files
    // for an import (§9), and the worker that cleans reader view's
    // articles (§9).
    plugins: [filterLists()],
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          index: src('main/index.ts'),
          data: src('data/worker.ts'),
          pdf: src('pdf/worker.ts'),
          'safe-browsing': src('main/safe-browsing/worker.ts'),
          'ad-blocking': src('main/ad-blocking/worker.ts'),
          import: src('import/worker.ts'),
          reader: src('main/reader/worker.ts'),
        },
        external: ['node:sqlite'],
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  },
  preload: {
    // Sandboxed preloads can't load other files, so each one is a single
    // self-contained CommonJS bundle.
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: {
          shell: src('preload/shell.ts'),
          overlay: src('preload/overlay.ts'),
          popover: src('preload/popover.ts'),
          preview: src('preload/preview.ts'),
          internal: src('preload/internal.ts'),
          archive: src('preload/archive.ts'),
          mini: src('preload/mini.ts'),
          reader: src('preload/reader.ts'),
          // Every web page's: Chromium's chrome.app, and no passkey autofill dialog (ARCHITECTURE.md §9).
          page: src('preload/page.ts'),
          // The extension library's preload (GPL-3.0, packages/chrome-extensions): extension
          // pages and workers, and every page of a profile that has extensions (ARCHITECTURE.md §12).
          extensions: resolve(import.meta.dirname, '../../packages/chrome-extensions/src/preload.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: src('renderer'),
    // Absolute asset URLs resolve under chord://<surface>/assets/… (see main/protocol.ts).
    base: '/',
    build: {
      // Smaller bundles parse faster at launch (cold-start budget, ARCHITECTURE.md §1).
      // CHORD_NO_MINIFY=1 keeps names readable for profiling (docs/testing/performance.md).
      minify: !process.env['CHORD_NO_MINIFY'],
      rolldownOptions: {
        input: {
          shell: src('renderer/shell/index.html'),
          overlay: src('renderer/overlay/index.html'),
          popover: src('renderer/popover/index.html'),
          preview: src('renderer/preview/index.html'),
          settings: src('renderer/settings/index.html'),
          archive: src('renderer/archive/index.html'),
          mini: src('renderer/mini/index.html'),
          reader: src('renderer/reader/index.html'),
        },
      },
    },
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  },
});
