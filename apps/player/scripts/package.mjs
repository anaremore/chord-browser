// Packages Chord Player for this OS and architecture (ARCHITECTURE.md §15.1,
// Chord Player): builds its bundles, checks castLabs ECS's zip
// (fetch-ecs.mjs), lets electron-builder put the app into ECS, VMP-signs it
// when asked (evs.mjs), then zips the folder and writes the release manifest
// Chord reads (@chord/player-protocol's release.ts). The manifest is signed
// later, by the release workflow, with Chord's update key.
//
//   node apps/player/scripts/package.mjs [--out <folder>] [--skip-build]
//
// CHORD_PLAYER_VMP=production VMP-signs through EVS (CI, with the EVS secrets);
// anything else keeps ECS's development signature on Windows and macOS.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { archiveName, manifestFor, manifestName, PROTOCOL, targetFor, writeZip } from '../../../packages/player-protocol/src/index.ts';
import { vmpSign, vmpVerify } from './evs.mjs';
import { ecsZip, readEcs } from './fetch-ecs.mjs';

const here = import.meta.dirname;
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const out = resolve(opt('out') ?? join(appDir, 'release'));
const production = process.env.CHORD_PLAYER_VMP === 'production';
const log = (message) => console.log(`[player] ${message}`);

const target = targetFor(process.platform, process.arch);
if (!target) {
  console.error(
    process.platform === 'linux' && process.arch === 'arm64'
      ? '[player] Chord Player isn’t built for Linux arm64: S14 found no Widevine CDM there it could test (ARCHITECTURE.md §15.1).'
      : `[player] Chord Player isn’t built for ${process.platform}-${process.arch}.`,
  );
  process.exit(2);
}

function run(command, argv, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(command, argv, { cwd: appDir, env: childEnv, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${result.status ?? result.signal})`);
}

const require = createRequire(import.meta.url);
const binOf = (pkg, name) => {
  const pkgPath = require.resolve(`${pkg}/package.json`);
  const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin[name]);
};

const { version } = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
const ecs = (await readEcs()).version;

// 1. The bundles.
if (!args.includes('--skip-build')) {
  log('Building the bundles');
  run(process.execPath, [binOf('electron-vite', 'electron-vite'), 'build']);
}

// 2. ECS, checked.
const zip = await ecsZip(target);

// 3. The app in ECS, by electron-builder (with the fuses and, on macOS, VMP signing in after-pack.mjs).
const builderOut = join(out, 'builder');
await rm(builderOut, { recursive: true, force: true });
const flag = { 'win32-x64': ['--win', '--x64'], 'darwin-x64': ['--mac', '--x64'], 'darwin-arm64': ['--mac', '--arm64'], 'linux-x64': ['--linux', '--x64'] }[target];
log(`Packaging ${version} on ECS ${ecs} (${target}, VMP: ${production ? 'production' : process.platform === 'linux' ? 'none' : 'development'})`);
run(process.execPath, [binOf('electron-builder', 'electron-builder'), '--config', 'electron-builder.config.ts', '--dir', '--publish', 'never', ...flag], {
  CHORD_ECS_ZIP: zip,
  CHORD_PLAYER_OUT: builderOut,
});
const unpacked = readdirSync(builderOut, { withFileTypes: true }).find((e) => e.isDirectory() && /^(win|linux|mac)/.test(e.name) && e.name !== 'mac-universal');
if (!unpacked) throw new Error(`electron-builder left no app folder in ${builderOut}`);
const appFolder = join(builderOut, unpacked.name);

// 4. Windows: VMP signing after code signing, which electron-builder did (when it has a certificate).
if (process.platform === 'win32') {
  if (production) vmpSign(appFolder);
  else {
    // ECS's development signature is named after electron.exe; the renamed executable needs it beside it under its own name.
    const sig = join(appFolder, 'electron.exe.sig');
    if (existsSync(sig)) renameSync(sig, join(appFolder, 'Chord Player.exe.sig'));
  }
}
if (production && process.platform !== 'linux') vmpVerify(appFolder);

// 5. The zip and its manifest.
await mkdir(out, { recursive: true });
const file = archiveName(version, target);
const archive = join(out, file);
log(`Zipping ${appFolder}`);
const { entries, bytes } = await writeZip(appFolder, archive);
const hash = createHash('sha512');
await pipeline(createReadStream(archive), hash);
const size = statSync(archive).size;
await writeFile(
  join(out, manifestName(target)),
  manifestFor({ version, protocol: PROTOCOL, ecs, target, file, size, unpackedSize: bytes, sha512: hash.digest('base64'), vmp: process.platform === 'linux' ? 'none' : production ? 'production' : 'development' }),
);
await rm(builderOut, { recursive: true, force: true });
log(`${file}: ${(size / 1e6).toFixed(1)} MB, ${entries} files, ${(bytes / 1e6).toFixed(1)} MB unpacked`);
console.log(JSON.stringify({ archive, manifest: join(out, manifestName(target)), size, unpackedSize: bytes }));
