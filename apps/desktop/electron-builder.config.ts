/**
 * Packaging (ARCHITECTURE.md §15). Each OS and architecture is built natively
 * in CI (.github/workflows/release.yml); locally,
 * `pnpm --filter @chord/desktop package` builds the current OS and arch,
 * unsigned.
 *
 * Code signing (ARCHITECTURE.md §15.2, docs/releasing/signing.md) follows
 * CHORD_SIGNING. The release workflow sets it once the signing secrets exist
 * (scripts/signing-mode.mjs):
 * - unset or `none`: unsigned. macOS gets an ad-hoc signature, Windows none.
 * - `developer-id`: macOS. Developer ID and the hardened runtime, then notarized.
 * - `artifact-signing`: Windows, through Azure Artifact Signing (formerly Trusted Signing).
 * - `certificate`: Windows, with a .pfx certificate.
 * A signing mode with credentials missing stops the build instead of quietly
 * building unsigned.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Configuration, MacConfiguration, WindowsConfiguration } from 'electron-builder';

type Env = Readonly<Record<string, string | undefined>>;
export type Signing = 'none' | 'developer-id' | 'artifact-signing' | 'certificate';
const SIGNING_MODES: readonly string[] = ['none', 'developer-id', 'artifact-signing', 'certificate'];

const BUILD = join(import.meta.dirname, 'build');
/** The .rpm's post-install script, run on install and on upgrade. */
const RPM_AFTER_INSTALL = join(BUILD, 'linux', 'rpm-after-install.sh');

const valueOf = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

/** The values of `names`, or an error that lists the missing ones. */
function needed(env: Env, signing: Signing, names: readonly string[]): string[] {
  const missing = names.filter((name) => !valueOf(env, name));
  if (missing.length > 0) throw new Error(`CHORD_SIGNING=${signing} needs ${missing.join(', ')} (docs/releasing/signing.md)`);
  return names.map((name) => valueOf(env, name)!);
}

export function signingFrom(env: Env): Signing {
  const signing = valueOf(env, 'CHORD_SIGNING') ?? 'none';
  if (!SIGNING_MODES.includes(signing)) throw new Error(`CHORD_SIGNING is '${signing}'; expected one of ${SIGNING_MODES.join(', ')}`);
  return signing as Signing;
}

/** How Chord.app is signed. */
export function macSigning(env: Env): Pick<MacConfiguration, 'identity' | 'hardenedRuntime' | 'entitlements' | 'entitlementsInherit' | 'notarize'> {
  if (signingFrom(env) !== 'developer-id') {
    // Ad-hoc signature: Apple Silicon won't run unsigned code at all. Hardened
    // runtime only matters for notarization, and with an ad-hoc identity its
    // library validation rejects Electron's frameworks, so it's off until
    // Developer ID signing arrives (ARCHITECTURE.md §15.2).
    return { identity: '-', hardenedRuntime: false };
  }
  // CSC_LINK is the Developer ID Application certificate and its key (.p12, base64);
  // electron-builder imports it into a throwaway keychain and finds the identity there.
  needed(env, 'developer-id', ['CSC_LINK', 'CSC_KEY_PASSWORD']);
  // Notarization, by electron-builder's notarytool integration. An App Store Connect API key is
  // what electron-builder recommends for CI; an Apple ID works too.
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  if (!apiKey.every((name) => valueOf(env, name)) && !appleId.every((name) => valueOf(env, name))) {
    throw new Error(`CHORD_SIGNING=developer-id needs notarization credentials: ${apiKey.join(', ')} (or ${appleId.join(', ')}) (docs/releasing/signing.md)`);
  }
  // electron-builder 26 hands APPLE_API_KEY to notarytool as is, so it has to be the .p8 file's path.
  const keyFile = valueOf(env, 'APPLE_API_KEY');
  if (keyFile && !existsSync(keyFile)) throw new Error('APPLE_API_KEY must be the path of the .p8 key file');
  return {
    hardenedRuntime: true,
    // Named so ad-hoc builds never pick them up (electron-builder uses build/entitlements.mac.plist if it exists).
    entitlements: join(BUILD, 'entitlements.developer-id.plist'),
    entitlementsInherit: join(BUILD, 'entitlements.developer-id.inherit.plist'),
    notarize: true,
  };
}

/**
 * How Chord.exe, its DLLs, and the installer and uninstaller are signed. A signed
 * build's app-update.yml names its publisher, and electron-updater then installs
 * only updates signed by that publisher (ARCHITECTURE.md §14.4). Unsigned builds
 * name none, so they keep installing unsigned updates.
 */
export function winSigning(env: Env): Pick<WindowsConfiguration, 'azureSignOptions' | 'signtoolOptions' | 'signExts'> {
  // electron-builder signs .exe files; Electron's own signer (@electron/windows-sign) signs DLLs too.
  const signExts = ['.dll'];
  switch (signingFrom(env)) {
    case 'artifact-signing': {
      // The TrustedSigning PowerShell module signs in to Microsoft Entra ID with these.
      needed(env, 'artifact-signing', ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']);
      const [endpoint, codeSigningAccountName, certificateProfileName, publisherName] = needed(env, 'artifact-signing', [
        'AZURE_SIGNING_ENDPOINT',
        'AZURE_SIGNING_ACCOUNT',
        'AZURE_SIGNING_PROFILE',
        // The certificate's subject CN, exactly; it can't be read from the service.
        'WIN_PUBLISHER_NAME',
      ]) as [string, string, string, string];
      return { azureSignOptions: { publisherName, endpoint, codeSigningAccountName, certificateProfileName }, signExts };
    }
    case 'certificate': {
      // WIN_CSC_LINK is the .pfx (base64); electron-builder reads it and WIN_CSC_KEY_PASSWORD itself.
      needed(env, 'certificate', ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']);
      // Without WIN_PUBLISHER_NAME, electron-builder takes the publisher from the certificate's CN.
      const publisherName = valueOf(env, 'WIN_PUBLISHER_NAME');
      // Chord needs Windows 10 or later, so SHA-1 signatures would only add a second pass.
      return { signtoolOptions: { signingHashAlgorithms: ['sha256'], ...(publisherName ? { publisherName } : {}) }, signExts };
    }
    default:
      return {};
  }
}

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
  // Chord's licenses travel with every copy: MIT, plus MPL-2.0 for core/rank.ts (adapted from Crest)
  // and Ghostery's adblocker engine (out/main/ad-blocking.js), GPL-3.0 for the extensions library and
  // EasyList (out/main/ad-blocking), and Apache-2.0 for pdf.js (Duet's PDF reader, out/main/pdf.js) and
  // Readability (reader view's article finder, in out/main/index.js).
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
    ...winSigning(process.env),
  },
  nsis: {
    // One-click, per-user (ARCHITECTURE.md §15.1): no admin prompt.
    oneClick: true,
    perMachine: false,
    artifactName: '${productName}-${version}-${os}-${arch}-setup.${ext}',
    // Registers Chord as a browser Windows can offer as the default.
    include: 'build/installer.nsh',
  },
  // Microsoft Store (MSIX), off by default: win.target builds only the installer above. A Store
  // package is built by hand with `--win appx` (docs/releasing/signing.md, Microsoft Store). The
  // Store signs what it distributes, so this needs no certificate. Store copies update through
  // the Store; update-installer.ts leaves them notify-only, as they have no uninstaller beside them.
  appx: {
    // Partner Center → the app → Product identity. Unset, electron-builder makes a test package.
    identityName: process.env['CHORD_STORE_IDENTITY_NAME'],
    publisher: process.env['CHORD_STORE_PUBLISHER'],
    publisherDisplayName: process.env['CHORD_STORE_PUBLISHER_DISPLAY_NAME'] ?? 'Chord contributors',
    applicationId: 'Chord',
    displayName: 'Chord',
    languages: ['en-US'],
    // The link registration below uses uap3, which needs Windows 10 1607 (10.0.14393) or later.
    minVersion: '10.0.14393.0',
    maxVersionTested: '10.0.26100.0',
    // Web links and .html files, so Windows can offer Chord as the browser (build/installer.nsh does this for the installer).
    customExtensionsPath: 'build/appx-extensions.xml',
  },

  mac: {
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    ...macSigning(process.env),
    // Web links and pages, so macOS lists Chord as a possible default browser.
    extendInfo: {
      CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'], CFBundleTypeRole: 'Viewer' }],
      CFBundleDocumentTypes: [
        { CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.html', 'public.xhtml'] },
      ],
      // What macOS shows when a site you allowed asks for these. Electron's own strings name "this app"
      // and it has none for location, so sites asking where you are would get nothing.
      NSCameraUsageDescription: 'Sites you allow can use your camera, for video calls and the like.',
      NSMicrophoneUsageDescription: 'Sites you allow can use your microphone, for calls and voice notes.',
      NSLocationUsageDescription: 'Sites you allow can see roughly where you are, for maps and local results.',
      NSLocationWhenInUseUsageDescription: 'Sites you allow can see roughly where you are, for maps and local results.',
    },
  },

  linux: {
    target: ['AppImage', 'deb', 'rpm'],
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
  // Fedora, RHEL and derivatives. Same package name as the .deb, so the dnf repository
  // (docs/releasing/linux-repos.md) takes over a copy installed by hand.
  rpm: {
    packageName: 'chord',
    vendor: 'Chord contributors',
    // rpm's Group tag. Fedora no longer uses it; fpm would write "default".
    packageCategory: 'Applications/Internet',
    // electron-builder's list, then what Chord's binary links that the list doesn't bring on a bare
    // Fedora (libgbm, libasound), and libsecret, which the .deb asks for too: Chromium keeps the
    // cookie encryption key with it. Each alternative is Fedora/RHEL's name, then openSUSE's.
    depends: [
      'gtk3',
      'libnotify',
      'nss',
      'libXScrnSaver',
      '(libXtst or libXtst6)',
      'xdg-utils',
      'at-spi2-core',
      '(libuuid or libuuid1)',
      '(mesa-libgbm or libgbm1)',
      '(alsa-lib or libasound2)',
      '(libsecret or libsecret-1-0)',
    ],
    // electron-builder's script with one change; the file says what and why.
    afterInstall: RPM_AFTER_INSTALL,
    fpm: [
      // chrome-sandbox is setuid root in the package itself, as in Google Chrome's rpm: the sandbox
      // then works even where user namespaces are off, and `rpm -V` agrees.
      // The path is electron-builder's install folder, /opt/<productName>.
      '--rpm-attr',
      '4755,root,root:/opt/Chord/chrome-sandbox',
      // The package owns its folders too, so uninstalling leaves no empty ones behind.
      '--directories',
      '/opt/Chord',
      // Without an upgrade script, fpm runs the old package's after-remove script on every
      // upgrade, after the new one's install script, and that deletes /usr/bin/chord. With one,
      // after-remove runs only when Chord is uninstalled.
      '--after-upgrade',
      RPM_AFTER_INSTALL,
      // No /usr/lib/.build-id links: every app on the same Electron release ships the same
      // binaries, so two such packages would claim the same links and refuse to install together.
      '--rpm-rpmbuild-define',
      '_build_id_links none',
    ],
  },
  toolsets: {
    // The static AppImage runtime (electron-builder calls it beta): the
    // default FUSE 2 runtime needs libfuse2, which Ubuntu 22.04+ doesn't
    // install. Its .desktop entry also leaves out the default --no-sandbox.
    appimage: '1.0.3',
  },
};

export default config;
