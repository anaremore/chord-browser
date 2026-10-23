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
  // License: Chord's source is MIT (one MPL-2.0 file), but a build includes the GPL-3.0-only
  // extensions library, so what we distribute is a GPL-3.0-only combined work (decision D1).
  extraMetadata: { name: 'chord', license: 'GPL-3.0-only' },
  copyright: 'Copyright © Chord contributors',
  directories: { output: 'release', buildResources: 'build' },
  // The bundler inlines every dependency (electron.vite.config.ts), so the
  // app is just the build output; electron-builder would otherwise copy the
  // production node_modules too. package.json is always added.
  files: ['out/**/*', '!**/node_modules/**/*'],
  // Chord's licenses travel with every copy: MIT, plus MPL-2.0 for core/rank.ts (adapted from Crest).
  extraResources: [
    { from: '../../LICENSE', to: 'licenses/LICENSE' },
    { from: '../../LICENSES', to: 'licenses' },
  ],
  // Nothing native to rebuild: SQLite is Node's built-in node:sqlite.
  npmRebuild: false,
  // Arch is always in the name, so every build of a version can share one release.
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Where updates come from (ARCHITECTURE.md §14.4). Builds never publish themselves (the scripts
  // pass --publish never; the release workflow uploads), but this makes electron-builder write
  // each installer's manifest (latest*.yml) and the app's app-update.yml. Chord reads the
  // manifests through its own signature-checking provider (src/main/update-installer.ts).
  publish: { provider: 'github', owner: 'anaremore', repo: 'chord-browser' },

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

  // Icons: each OS gets files rendered for it from the SVG masters in build/
  // (scripts/build-icons.mjs, DESIGN.md §2), so electron-builder converts nothing.
  win: {
    target: 'nsis',
    icon: 'build/icon.ico',
  },
  nsis: {
    // One-click, per-user (ARCHITECTURE.md §15.1): no admin prompt.
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-${version}-${os}-${arch}-setup.${ext}',
    // Registers Chord as a browser Windows can offer as the default.
    include: 'build/installer.nsh',
  },

  mac: {
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    // Ad-hoc signature: Apple Silicon won't run unsigned code at all. Hardened
    // runtime only matters for notarization, and with an ad-hoc identity its
    // library validation rejects Electron's frameworks, so it's off until
    // Developer ID signing arrives (ARCHITECTURE.md §15.2).
    identity: '-',
    hardenedRuntime: false,
    // Web links and pages, so macOS lists Chord as a possible default browser.
    extendInfo: {
      CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'], CFBundleTypeRole: 'Viewer' }],
      CFBundleDocumentTypes: [
        { CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.html', 'public.xhtml'] },
      ],
    },
  },

  linux: {
    target: ['AppImage', 'deb'],
    executableName: 'chord',
    // Every hicolor size, 16–512 px, each installed as is.
    icon: 'build/icons',
    // The installed .desktop file is named after desktopName (package.json),
    // which Electron also uses as the Wayland app_id and X11 WM_CLASS.
    syncDesktopName: true,
    category: 'Network;WebBrowser',
    // The .desktop file's MimeType: web links and pages, so Linux desktops offer Chord as the browser.
    mimeTypes: ['text/html', 'application/xhtml+xml', 'x-scheme-handler/http', 'x-scheme-handler/https'],
    synopsis: 'A calm, colorful browser',
    // Shows in public package metadata. A project address, never a person's: decide the real one before 1.0.
    maintainer: 'Chord contributors <noreply@chordbrowser.com>',
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
