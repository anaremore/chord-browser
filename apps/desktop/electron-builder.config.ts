/**
 * Unsigned preview packaging (ARCHITECTURE.md §15). Each OS and architecture
 * is built natively in CI (.github/workflows/release.yml); locally,
 * `pnpm --filter @chord/desktop package` builds the current OS and arch.
 */
import type { Configuration } from 'electron-builder';

const config: Configuration = {
  // Identity is fixed forever (ARCHITECTURE.md §15.0). The same ID is
  // identity.ts's APP_ID and package.json's desktopName.
  appId: 'com.chordbrowser.Chord',
  productName: 'Chord',
  // The workspace name (@chord/desktop) would otherwise name the per-user
  // install folder: %LOCALAPPDATA%\Programs\@chorddesktop.
  extraMetadata: { name: 'chord' },
  copyright: 'Copyright © Chord contributors',
  directories: { output: 'release', buildResources: 'build' },
  // The bundler inlines every dependency (electron.vite.config.ts), so the
  // app is just the build output; electron-builder would otherwise copy the
  // production node_modules too. package.json is always added.
  files: ['out/**/*', '!**/node_modules/**/*'],
  // PLACEHOLDER icon from scripts/generate-icon.mjs; electron-builder derives .ico, .icns and the Linux sizes.
  icon: 'build/icon.png',
  // Nothing native to rebuild: SQLite is Node's built-in node:sqlite.
  npmRebuild: false,
  // Arch is always in the name, so every build of a version can share one release.
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // The updater (and its manifests) arrives later (ARCHITECTURE.md §14.4).
  publish: null,

  // ARCHITECTURE.md §14.1. Flipped right before signing. electron-builder
  // 26.18 bundles @electron/fuses 1.8, which doesn't know WasmTrapHandlers;
  // it keeps Electron's default (on). Asar integrity is compiled out on Linux,
  // where the fuse is a no-op.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },

  win: {
    target: 'nsis',
  },
  nsis: {
    // One-click, per-user (ARCHITECTURE.md §15.1): no admin prompt.
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-${version}-${os}-${arch}-setup.${ext}',
  },

  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    // Ad-hoc signature: Apple Silicon won't run unsigned code at all. Hardened
    // runtime only matters for notarization, and with an ad-hoc identity its
    // library validation rejects Electron's frameworks, so it's off until
    // Developer ID signing arrives (ARCHITECTURE.md §15.2).
    identity: '-',
    hardenedRuntime: false,
  },

  linux: {
    target: ['AppImage', 'deb'],
    executableName: 'chord',
    // A directory holding only icon.png makes electron-builder render the 16–512 px hicolor sizes;
    // given the file itself, it would install just the 1024 px original.
    icon: 'build',
    // The installed .desktop file is named after desktopName (package.json),
    // which Electron also uses as the Wayland app_id and X11 WM_CLASS.
    syncDesktopName: true,
    category: 'Network;WebBrowser',
    synopsis: 'A calm, colorful browser',
    maintainer: 'Austin Naremore <austin@naremore.com>',
  },
  deb: {
    // Debian package names are lowercase.
    packageName: 'chord',
    packageCategory: 'web',
  },
  toolsets: {
    // The static AppImage runtime (electron-builder calls it beta): the
    // default FUSE 2 runtime needs libfuse2, which Ubuntu 22.04+ doesn't
    // install. Its .desktop entry also leaves out the default --no-sandbox.
    appimage: '1.0.3',
  },
};

export default config;
