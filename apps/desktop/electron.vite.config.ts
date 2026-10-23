import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);

export default defineConfig({
  main: {
    // Bundle everything (workspace packages are TypeScript sources); only
    // electron and Node built-ins stay external. Two entries: main itself,
    // and chord-data's utility process (ARCHITECTURE.md §4).
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: src('main/index.ts'), data: src('data/worker.ts') },
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
          internal: src('preload/internal.ts'),
          archive: src('preload/archive.ts'),
          mini: src('preload/mini.ts'),
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
      minify: true,
      rolldownOptions: {
        input: {
          shell: src('renderer/shell/index.html'),
          overlay: src('renderer/overlay/index.html'),
          popover: src('renderer/popover/index.html'),
          settings: src('renderer/settings/index.html'),
          archive: src('renderer/archive/index.html'),
          mini: src('renderer/mini/index.html'),
        },
      },
    },
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  },
});
