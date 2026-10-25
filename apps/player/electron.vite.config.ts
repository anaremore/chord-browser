import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);
/** The ECS build the player is packaged on (ecs.json), which it reports to Chord in the handshake. */
const ecs = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'ecs.json'), 'utf8')) as { version: string }).version;

/**
 * Chord Player's bundles (ARCHITECTURE.md §9). Only the build: the player
 * runs on castLabs ECS, never on the workspace's stock Electron, so there is
 * no `dev`; scripts/package.mjs puts this output into ECS.
 */
export default defineConfig({
  main: {
    define: { __ECS_VERSION__: JSON.stringify(ecs) },
    // Bundle everything, the shared protocol (TypeScript sources) included; only electron and Node stay external.
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: src('main/index.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    // Sandboxed: one self-contained CommonJS file.
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: { bar: src('preload/bar.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: src('renderer'),
    // Loaded from the asar with loadFile: relative asset URLs.
    base: './',
    build: {
      rolldownOptions: { input: { bar: src('renderer/bar/index.html') } },
    },
  },
});
