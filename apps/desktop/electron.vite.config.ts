import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);

export default defineConfig({
  main: {
    // Bundle everything (workspace packages are TypeScript sources); only
    // electron and Node built-ins stay external.
    build: { externalizeDeps: false },
  },
  preload: {
    // Sandboxed preloads can't load other files, so each one is a single
    // self-contained CommonJS bundle.
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: { shell: src('preload/shell.ts'), overlay: src('preload/overlay.ts') },
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
        input: { shell: src('renderer/shell/index.html'), overlay: src('renderer/overlay/index.html') },
      },
    },
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  },
});
