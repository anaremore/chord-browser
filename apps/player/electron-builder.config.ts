/**
 * Packaging Chord Player (ARCHITECTURE.md §15.1, Chord Player) on castLabs
 * ECS instead of the workspace's Electron. scripts/package.mjs runs this with
 * `--dir` after checking ECS's zip (scripts/fetch-ecs.mjs), then zips the
 * folder itself, so the archive Chord unpacks is always in the format Chord
 * reads (@chord/player-protocol's zip.ts).
 *
 * castLabs VMP signing (EVS) runs when CHORD_PLAYER_VMP is `production`, in
 * the order castLabs requires: on macOS before code signing (afterPack, here),
 * on Windows after it (scripts/package.mjs, once electron-builder is done).
 * The fuses are flipped first (scripts/after-pack.mjs), since VMP signs the
 * final binary. Without production signing the binaries stay exactly as
 * castLabs built them on Windows and macOS, so ECS's development signature
 * stays valid: no fuses and no edited .exe resources there. Linux has no VMP.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';

const ecs = (JSON.parse(readFileSync(join(import.meta.dirname, 'ecs.json'), 'utf8')) as { version: string }).version;
const production = process.env['CHORD_PLAYER_VMP'] === 'production';
const zip = process.env['CHORD_ECS_ZIP'];
if (!zip) throw new Error('CHORD_ECS_ZIP must name the checked ECS zip (scripts/package.mjs sets it)');

const config: Configuration = {
  appId: 'com.chordbrowser.Chord.Player',
  productName: 'Chord Player',
  copyright: 'Copyright © Chord contributors',
  extraMetadata: { name: 'chord-player' },
  // ECS, not the workspace's Electron: its version for electron-builder, and the zip scripts/fetch-ecs.mjs checked.
  electronVersion: ecs.replace(/\+.*$/, ''),
  electronDist: zip,
  directories: { output: process.env['CHORD_PLAYER_OUT'] ?? 'release', buildResources: 'build' },
  // Everything is bundled (electron.vite.config.ts): the app is the build output.
  files: ['out/**/*', '!**/node_modules/**/*'],
  // Chord's license, and the Onest typeface's (SIL OFL 1.1), which the bar uses. ECS's zip brings Electron's and Chromium's.
  extraResources: [
    { from: '../../LICENSE', to: 'licenses/LICENSE' },
    { from: '../desktop/src/renderer/assets/fonts/OFL.txt', to: 'licenses/Onest-OFL.txt' },
  ],
  asar: true,
  // On Windows the asar's integrity goes into the .exe as a resource, which would invalidate ECS's development
  // signature; without the fuses (production only) nothing checks it anyway.
  disableAsarIntegrity: !production && process.platform === 'win32',
  npmRebuild: false,
  afterPack: './scripts/after-pack.mjs',
  win: {
    target: 'dir',
    icon: '../desktop/build/icon.ico',
    // Editing the .exe's icon and version invalidates ECS's development signature; production builds are VMP-signed after it.
    signAndEditExecutable: production,
  },
  mac: {
    target: 'dir',
    icon: '../desktop/build/icon.icns',
    category: 'public.app-category.entertainment',
    // Ad-hoc, as Chord until the maintainer's Developer ID exists (ARCHITECTURE.md §15.2): Apple
    // Silicon runs nothing unsigned, and the hardened runtime rejects Electron's frameworks ad hoc.
    identity: '-',
    hardenedRuntime: false,
  },
  linux: {
    target: 'dir',
    executableName: 'chord-player',
    icon: '../desktop/build/icons',
    category: 'AudioVideo',
  },
};

export default config;
