// electron-builder's afterPack hook for Chord Player (electron-builder.config.ts):
// runs after the app is in place and before code signing.
//
// 1. ECS's leftover default app goes.
// 2. The fuses (ARCHITECTURE.md §14.1's hardening, as Chord's) are flipped
//    here rather than by electron-builder, which flips them after this hook:
//    castLabs' VMP signature must cover the final binary.
// 3. macOS production builds are VMP-signed now, before code signing, the
//    order castLabs requires there. (Windows signs after code signing, in
//    package.mjs.)
//
// Without production signing, Windows and macOS binaries stay as castLabs
// built them (no fuses), so ECS's development signature stays valid. Linux has
// no VMP, so its fuses are always flipped.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { vmpSign } from './evs.mjs';

export const FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
};

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const production = process.env.CHORD_PLAYER_VMP === 'production';
  const resources = platform === 'darwin' ? join(context.appOutDir, 'Chord Player.app', 'Contents', 'Resources') : join(context.appOutDir, 'resources');
  await rm(join(resources, 'default_app.asar'), { force: true });
  if (platform === 'linux' || production) {
    const config = await context.packager.generateFuseConfig(FUSES);
    await context.packager.addElectronFuses(context, config);
    console.log(`[player] Fuses flipped (${platform})`);
  } else {
    console.log(`[player] Fuses left as castLabs built them, so ECS's development VMP signature stays valid (${platform})`);
  }
  if (platform === 'darwin' && production) vmpSign(context.appOutDir);
}
