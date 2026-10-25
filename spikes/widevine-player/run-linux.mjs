#!/usr/bin/env node
// Runs spike S14 (run.mjs) in the Linux E2E container, on a virtual display,
// so no window opens on your desktop. Uses the image scripts/e2e-linux/run.mjs
// builds (run `pnpm test:e2e:linux` once if it doesn't exist). Downloads go to
// the container's /tmp and a cache volume of their own (chord-wv-spike-cache;
// remove it with `docker volume rm chord-wv-spike-cache`). Results come back
// to spikes/widevine-player/results/linux-<display>/.
//
//   node spikes/widevine-player/run-linux.mjs [--wayland] [run.mjs options, e.g. --steps census]
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { containerName, imageTag, tarArchive } from '../../scripts/e2e-linux/run.mjs';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const argv = process.argv.slice(2);
const display = argv.includes('--wayland') ? 'wayland' : 'x11';
const rest = argv.filter((a) => a !== '--wayland');
const onWindows = process.platform === 'win32';
const docker = (a, o = {}) => (onWindows ? spawnSync('wsl.exe', ['-e', 'docker', ...a], { encoding: 'utf8', windowsHide: true, ...o }) : spawnSync('docker', a, { encoding: 'utf8', ...o }));

const dockerfile = readFileSync(join(root, 'scripts', 'e2e-linux', 'Dockerfile'), 'utf8');
const pnpmVersion = /^pnpm@(.+)$/.exec(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager)[1];
const image = imageTag(dockerfile, pnpmVersion);
if (docker(['image', 'inspect', image]).status !== 0) throw new Error(`No ${image}: run pnpm test:e2e:linux once to build it`);

const CACHE = 'chord-wv-spike-cache';
if (docker(['volume', 'inspect', CACHE]).status !== 0) {
  docker(['volume', 'create', CACHE]);
  docker(['run', '--rm', '--user', 'root', '--volume', `${CACHE}:/c`, image, 'chown', '1000:1000', '/c']);
}

const git = (a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true }).stdout;
const entries = [];
for (const path of new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relative(root, here)]).split('\0').filter(Boolean))) {
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (stat?.isFile()) entries.push({ path, body: readFileSync(join(root, path)), mode: 0o644 });
}

const quoted = rest.map((a) => `'${a.replaceAll("'", '')}'`).join(' ');
const script = ['tar -xf - -C /work', `sh /work/spikes/widevine-player/tools/in-container.sh ${display} ${quoted}`].join(' && ');

const name = containerName(root);
const args = [
  'run', '--interactive', '--name', name, '--label', 'chord-e2e=run', '--init', '--shm-size', '2g', '--ulimit', 'core=0:0',
  '--user', 'chord', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
  '--volume', `${CACHE}:/home/chord/.cache/wv-spike`,
  image, 'bash', '-c', script,
];
const child = onWindows ? spawn('wsl.exe', ['-e', 'docker', ...args], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] }) : spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(tarArchive(entries));
const code = await new Promise((done) => child.on('close', (status) => done(status ?? 1)));

const target = join(here, 'results', `linux-${display}${rest.includes('census') ? '-census' : ''}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(join(here, 'results'), { recursive: true });
const wslTarget = onWindows ? spawnSync('wsl.exe', ['-e', 'wslpath', '-a', target], { encoding: 'utf8', windowsHide: true }).stdout.trim() : target;
docker(['cp', `${name}:/work/results`, wslTarget]);
docker(['rm', '--force', name]);
console.log(`[S14] container exit ${code}; results in ${target}`);
process.exitCode = code;
