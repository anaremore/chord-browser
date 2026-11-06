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
 *
 * Windows code signing (Authenticode) is Chord's own: Azure Artifact Signing
 * (formerly Trusted Signing) with the same account, profile and publisher as
 * Chord.exe (apps/desktop/electron-builder.config.ts, `artifact-signing`;
 * docs/releasing/signing.md). A release build passes its settings in the
 * environment (.github/workflows/player.yml); electron-builder then signs
 * `Chord Player.exe` and every DLL (and any `.node` addon) after afterPack
 * (the fuses) and before package.mjs VMP-signs. Without them, nothing is
 * code-signed.
 *
 * VMP covers only the .exe: castLabs EVS's `sign-pkg` finds `Chord Player.exe`
 * in the folder and signs a SHA-512 of the whole file, Authenticode signature
 * included, into `Chord Player.exe.sig` (castlabs-evs 1.3.2, vmp.py
 * `_detect_pkgs`, core/util.py `hash_pe_wv0`). That's why the .exe must be
 * code-signed first and left alone after; the DLLs aren't part of it, and
 * they're signed in the same pass anyway, before VMP. The Widevine CDM isn't
 * shipped (ECS downloads it into the profile), so it keeps Google's signature.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Configuration, WindowsConfiguration } from 'electron-builder';

const ecs = (JSON.parse(readFileSync(join(import.meta.dirname, 'ecs.json'), 'utf8')) as { version: string }).version;
const production = process.env['CHORD_PLAYER_VMP'] === 'production';
const zip = process.env['CHORD_ECS_ZIP'];
if (!zip) throw new Error('CHORD_ECS_ZIP must name the checked ECS zip (scripts/package.mjs sets it)');

/** Azure Artifact Signing's settings: the first three sign in to Microsoft Entra ID, the rest say what signs. */
const AZURE = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WIN_PUBLISHER_NAME'] as const;

/** Windows code signing when every setting is there, none when none is; a half-configured set stops the build rather than quietly building unsigned. */
function winSigning(env: NodeJS.ProcessEnv): Pick<WindowsConfiguration, 'azureSignOptions' | 'signExts'> {
  const value = (name: string) => env[name]?.trim() || undefined;
  const missing = AZURE.filter((name) => !value(name));
  if (missing.length === AZURE.length) return {};
  if (missing.length > 0) throw new Error(`Code-signing Chord Player needs ${missing.join(', ')} too (docs/releasing/signing.md, Chord Player)`);
  return {
    // The certificate's subject CN, exactly, as Chord's.
    azureSignOptions: { publisherName: value('WIN_PUBLISHER_NAME')!, endpoint: value('AZURE_SIGNING_ENDPOINT')!, codeSigningAccountName: value('AZURE_SIGNING_ACCOUNT')!, certificateProfileName: value('AZURE_SIGNING_PROFILE')! },
    // electron-builder signs .exe files; ECS's DLLs (and any native addon) too, as Chord's are. All of it before VMP signing.
    signExts: ['.dll', '.node'],
  };
}

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
    // It's also the switch for code signing: only production (release) builds are code-signed.
    signAndEditExecutable: production,
    ...(production ? winSigning(process.env) : {}),
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
