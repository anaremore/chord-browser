import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { compileLists } from './src/main/ad-blocking/compile';
import { FILTER_LISTS, type ListId } from './src/main/ad-blocking/lists';
import { bundleAgent } from './src/passwords/build';

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

/**
 * The passwords agent (S17 §4), built into one script in out/main/passwords/agent.js: main
 * reads it the first time a page's sentinel asks, and runs nothing of it itself.
 */
function passwordsAgent(): Plugin {
  return {
    name: 'chord-passwords-agent',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'passwords/agent.js', source: await bundleAgent({ entry: src('passwords/agent/index.ts'), minify: !process.env['CHORD_NO_MINIFY'] }) });
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
    // The assistant starts for each PDF it reads (§11.4; pdf.js stays out of main),
    // Safe Browsing's worker thread (§14.5), ad blocking's (§9; the engine
    // stays out of main), the process that reads other browsers' files
    // for an import (§9), the worker that cleans reader view's
    // articles (§9), the one that installs Chord Player (§9), Effects'
    // sanitizer (§9), the process that writes an export of your data, and the
    // one that reads a Chord file for an import (docs/decisions/S15-your-data.md §7).
    plugins: [filterLists(), passwordsAgent()],
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          // Main's entry: a few lines that choose between `chord mcp` (S18's relay for outside agents) and the
          // browser, which is `app` (main/index.ts), loaded only when it's the browser.
          index: src('main/entry.ts'),
          app: src('main/index.ts'),
          data: src('data/worker.ts'),
          pdf: src('pdf/worker.ts'),
          'safe-browsing': src('main/safe-browsing/worker.ts'),
          'ad-blocking': src('main/ad-blocking/worker.ts'),
          // Installing Chord Player: hashing and unpacking its zip (ARCHITECTURE.md §9).
          'player-unpack': src('main/player/unpack-worker.ts'),
          // Web Store extensions: verifying and unpacking a package, off main (ARCHITECTURE.md §12).
          'extension-unpack': src('main/extensions/unpack-worker.ts'),
          import: src('import/worker.ts'),
          reader: src('main/reader/worker.ts'),
          // Effects' sanitizer: every stylesheet an Effect applies is checked there, never on main (§9).
          effects: src('main/effects/worker.ts'),
          // Your data's export: reads chord.db read-only and writes the file, so main never holds the data.
          export: src('export/worker.ts'),
          // Your data's import from a Chord file: reads and checks the file, so nothing of it is parsed on main.
          'import-file': src('import-file/worker.ts'),
          // Sync's worker thread, inside chord-data's process: the folder work, off the thread that answers searches.
          sync: src('data/sync-worker.ts'),
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
          devtools: src('preload/devtools.ts'),
          // Every web page's: Chromium's chrome.app, and no passkey autofill dialog (ARCHITECTURE.md §9).
          page: src('preload/page.ts'),
          // The passwords sentinel: registered on chords' sessions only while passwords are on (S17 §8).
          passwords: src('preload/passwords.ts'),
          // Every web page's service worker's: its app badge goes to its tabs, not Chord's icon (ARCHITECTURE.md §9).
          'service-worker': src('preload/service-worker.ts'),
          // The extension library's preload (GPL-3.0, packages/chrome-extensions): extension
          // pages and workers, and every page of a profile that has extensions (ARCHITECTURE.md §12).
          extensions: resolve(import.meta.dirname, '../../packages/chrome-extensions/src/preload.ts'),
        },
        // No JSDoc in what runs in every page: the sentinel's 4 KB budget is for code (review of 3B). Legal comments
        // (`@license`, `@preserve`, `/*!`) and annotations (`@__PURE__`) are kept, should a preload carry any.
        output: { format: 'cjs', entryFileNames: '[name].cjs', comments: { legal: true, annotation: true, jsdoc: false } },
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
          devtools: src('renderer/devtools/index.html'),
        },
      },
    },
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  },
});
