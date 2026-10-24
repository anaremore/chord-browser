#!/usr/bin/env node
// Runs spike S11 (run.mjs) in the Linux E2E container, on a virtual display,
// so no window ever opens on your desktop. It uses the image and volumes
// scripts/e2e-linux/run.mjs makes (run `pnpm test:e2e:linux` once first if the
// image doesn't exist yet). Results come back to spikes/s11-ad-blocking/results/linux/.
//
//   node spikes/s11-ad-blocking/run-linux.mjs <folder with easylist.txt and easyprivacy.txt> [run.mjs options]
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { containerName, ELECTRON_VOLUME, imageTag, STORE_VOLUME, tarArchive } from '../../scripts/e2e-linux/run.mjs';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const [listsArg, ...rest] = process.argv.slice(2);
if (!listsArg) throw new Error('Usage: node run-linux.mjs <lists folder> [run.mjs options]');
const lists = resolve(listsArg);
const onWindows = process.platform === 'win32';
const docker = (args, options = {}) => (onWindows ? spawnSync('wsl.exe', ['-e', 'docker', ...args], { encoding: 'utf8', windowsHide: true, ...options }) : spawnSync('docker', args, { encoding: 'utf8', ...options }));

const dockerfile = readFileSync(join(root, 'scripts', 'e2e-linux', 'Dockerfile'), 'utf8');
const pnpmVersion = /^pnpm@(.+)$/.exec(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager)[1];
const image = imageTag(dockerfile, pnpmVersion);
if (docker(['image', 'inspect', image]).status !== 0) throw new Error(`No ${image}: run pnpm test:e2e:linux once to build it`);

const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true }).stdout;
const entries = [];
for (const path of new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))) {
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (stat?.isFile()) entries.push({ path, body: readFileSync(join(root, path)), mode: /\.sh$/.test(path) ? 0o755 : 0o644 });
}
for (const name of readdirSync(lists).filter((n) => n.endsWith('.txt'))) entries.push({ path: `spikes/s11-ad-blocking/.cache/lists/${name}`, body: readFileSync(join(lists, name)) });

const name = containerName(root);
const script = [
  'tar -xf - -C /work',
  'cd /work',
  'pnpm install --frozen-lockfile --prefer-offline --store-dir "$HOME/.cache/pnpm-store" --package-import-method copy >/dev/null',
  `xvfb-run -a node spikes/s11-ad-blocking/run.mjs spikes/s11-ad-blocking/.cache/lists ${rest.map((a) => `'${a}'`).join(' ')}`,
].join(' && ');
const args = [
  'run', '--interactive', '--name', name, '--label', 'chord-e2e=run', '--init', '--shm-size', '2g', '--ulimit', 'core=1:1',
  '--user', 'chord', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
  '--volume', `${STORE_VOLUME}:/home/chord/.cache/pnpm-store`, '--volume', `${ELECTRON_VOLUME}:/home/chord/.cache/electron`,
  image, 'bash', '-c', script,
];
const child = onWindows ? spawn('wsl.exe', ['-e', 'docker', ...args], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] }) : spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(tarArchive(entries));
const code = await new Promise((done) => child.on('close', (status) => done(status ?? 1)));

// A lifecycle-only run keeps its own folder, so it doesn't replace a full run's results.
const target = join(here, 'results', rest.includes('--lifecycle-only') ? 'linux-lifecycle' : 'linux');
rmSync(target, { recursive: true, force: true });
mkdirSync(join(here, 'results'), { recursive: true });
const wslTarget = onWindows ? spawnSync('wsl.exe', ['-e', 'wslpath', '-a', target], { encoding: 'utf8', windowsHide: true }).stdout.trim() : target;
docker(['cp', `${name}:/work/spikes/s11-ad-blocking/results`, wslTarget]);
docker(['rm', '--force', name]);
console.log(`[S11] container exit ${code}; results in ${target}`);
process.exitCode = code;
