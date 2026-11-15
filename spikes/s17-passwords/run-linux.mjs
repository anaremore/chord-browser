#!/usr/bin/env node
// Runs one of spike S17 M0's jobs in the Linux E2E container, so nothing opens a window on
// your desktop and nobody's code but Chord's runs outside a container. Uses the image and
// volumes scripts/e2e-linux/run.mjs makes (run `pnpm test:e2e:linux` once if the image
// doesn't exist). Results come back to spikes/s17-passwords/results/ (git-ignored).
//
//   node spikes/s17-passwords/run-linux.mjs corpus            the bake-off's field records (Playwright's Chromium, headless)
//   node spikes/s17-passwords/run-linux.mjs ddg               DuckDuckGo's classifier on its corpus (their Jest harness)
//   node spikes/s17-passwords/run-linux.mjs probes [args]     questions 1-3, 5-7 in Electron (Xvfb with openbox)
//   ... --wayland                                             probes on headless Weston instead
//   ... --cpus 4                                              only 4 CPUs, as CI's runners and perf baselines
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { containerName, ELECTRON_VOLUME, imageTag, STORE_VOLUME, tarArchive } from '../../scripts/e2e-linux/run.mjs';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const argv = process.argv.slice(2);
const job = argv.shift();
if (!['corpus', 'ddg', 'probes'].includes(job)) throw new Error('Usage: node run-linux.mjs corpus|ddg|probes [args]');
const take = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const [, value] = argv.splice(i, flag === '--cpus' ? 2 : 1);
  return value ?? true;
};
const wayland = take('--wayland');
const cpus = take('--cpus');
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

// Playwright's Chromium is kept in the Electron download's volume, in a folder of its own, so it's
// downloaded once (`rm -rf ~/.cache/electron/s17-ms-playwright` in a container removes it).
const BROWSERS = 'PLAYWRIGHT_BROWSERS_PATH=/home/chord/.cache/electron/s17-ms-playwright';
const install = 'pnpm install --frozen-lockfile --prefer-offline --store-dir "$HOME/.cache/pnpm-store" --package-import-method copy >/dev/null';
const quoted = argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
const x11 = (cmd) => `xvfb-run -a -s "-screen 0 1600x1000x24" sh -c 'ready="$(mktemp -u)"; openbox --startup "touch $ready" & for i in $(seq 1 100); do [ -e "$ready" ] && break; sleep 0.1; done; ${cmd}'`;
const westonRun = (cmd) =>
  `export XDG_RUNTIME_DIR="$(mktemp -d)"; chmod 700 "$XDG_RUNTIME_DIR"; weston --backend=headless --socket=wayland-chord --idle-time=0 & for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/wayland-chord" ] && break; sleep 0.1; done; unset DISPLAY; export WAYLAND_DISPLAY=wayland-chord XDG_SESSION_TYPE=wayland; ${cmd}`;
const commands = {
  corpus: [install, `${BROWSERS} node node_modules/playwright-core/cli.js install chromium-headless-shell`, `${BROWSERS} node spikes/s17-passwords/corpus-extract.mjs ${quoted}`],
  ddg: [`node spikes/s17-passwords/ddg-run.mjs ${quoted}`],
  probes: [install, (wayland ? westonRun : x11)(`node spikes/s17-passwords/probes/run.mjs ${wayland ? '--wayland ' : ''}${quoted}`)],
};
const name = containerName(root);
const args = [
  'run', '--interactive', '--name', name, '--label', 'chord-e2e=run', '--init', '--shm-size', '2g', '--ulimit', 'core=1:1',
  ...(cpus ? ['--cpuset-cpus', `0-${Number(cpus) - 1}`] : []),
  '--user', 'chord', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
  '--volume', `${STORE_VOLUME}:/home/chord/.cache/pnpm-store`, '--volume', `${ELECTRON_VOLUME}:/home/chord/.cache/electron`,
  image, 'bash', '-c', ['set -e', 'tar -xf - -C /work', 'cd /work', ...commands[job]].join(' && '),
];
console.log(`[S17] ${job} in ${name}${cpus ? `, ${cpus} CPUs` : ''}${wayland ? ', Wayland' : ''}`);
const child = onWindows ? spawn('wsl.exe', ['-e', 'docker', ...args], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] }) : spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(tarArchive(entries));
const code = await new Promise((done) => child.on('close', (status) => done(status ?? 1)));

const label = `${job}${wayland ? '-wayland' : ''}${cpus ? `-${cpus}cpu` : ''}`;
const target = join(here, 'results', label);
const staging = `${target}.copy`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(here, 'results'), { recursive: true });
const wslPath = (p) => (onWindows ? spawnSync('wsl.exe', ['-e', 'wslpath', '-a', p.replaceAll('\\', '/')], { encoding: 'utf8', windowsHide: true }).stdout.trim() : p);
const copied = docker(['cp', `${name}:/work/spikes/s17-passwords/results`, wslPath(staging)]).status === 0;
docker(['rm', '--force', name]);
if (copied) {
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}
console.log(`[S17] container exit ${code}; ${copied ? `results in ${target}` : 'no results'}`);
process.exitCode = code;
