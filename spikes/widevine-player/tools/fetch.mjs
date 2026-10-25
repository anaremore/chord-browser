// Downloads what the spike runs on into an empty folder, and checks each file
// against the SHA-256 its release publishes (SHASUMS256.txt, and GitHub's own
// asset digest for ECS). Nothing downloaded is executed here.
//
//   node tools/fetch.mjs --dest <new empty folder> [--ecs v44.9.3+wvcus] [--electron v45.0.0] [--koffi 3.3.4]
//     [--cache <folder of zips kept between runs>] [--no-ecs] [--no-electron]
//
// Leaves <dest>/ecs, <dest>/electron (unpacked), <dest>/koffi/node_modules/koffi
// (installed with --ignore-scripts), and <dest>/fetch.json with the sizes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unzip } from './unzip.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const dest = resolve(opt('dest', ''));
const cache = opt('cache', null);
const ECS = opt('ecs', 'v44.9.3+wvcus');
const ELECTRON = opt('electron', 'v45.0.0');
const KOFFI = opt('koffi', '3.3.4');
if (!opt('dest')) throw new Error('--dest <empty folder> is required');
mkdirSync(dest, { recursive: true });
if (readdirSync(dest).length) throw new Error(`${dest} is not empty`);

const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch;

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    total += entry.isDirectory() ? dirSize(path) : statSync(path).size;
  }
  return total;
}

function extract(zip, to) {
  mkdirSync(to, { recursive: true });
  const run = (cmd, argv) => {
    const r = spawnSync(cmd, argv, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${cmd} failed`);
  };
  if (process.platform === 'darwin') run('ditto', ['-x', '-k', zip, to]);
  // Windows' own bsdtar reads zip files; Git Bash's GNU tar, first on a runner's PATH, doesn't.
  else if (process.platform === 'win32') run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', to]);
  else unzip(zip, to);
}

async function release({ repo, tag, asset, to, githubDigest }) {
  const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
  const zip = join(dest, asset);
  const cached = cache && join(cache, asset);
  if (cached && existsSync(cached)) copyFileSync(cached, zip);
  else await download(`${base}/${encodeURIComponent(asset)}`, zip);
  const sums = join(dest, `${asset}.SHASUMS256.txt`);
  await download(`${base}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0];
  const actual = sha256(zip);
  if (!expected || expected !== actual) throw new Error(`${asset}: SHA-256 ${actual} doesn't match SHASUMS256.txt (${expected})`);
  let digest = null;
  if (githubDigest) {
    const api = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { accept: 'application/vnd.github+json' } });
    if (api.ok) digest = (await api.json()).assets.find((a) => a.name === asset)?.digest ?? null;
    if (digest && digest !== `sha256:${actual}`) throw new Error(`${asset}: GitHub digest ${digest} doesn't match`);
  }
  if (cache && !existsSync(cached)) {
    mkdirSync(cache, { recursive: true });
    copyFileSync(zip, cached);
  }
  extract(zip, to);
  return { asset, sha256: actual, githubDigest: digest, zipBytes: statSync(zip).size, unpackedBytes: dirSize(to) };
}

const report = { platform, arch, when: new Date().toISOString() };
if (!args.includes('--no-ecs'))
  report.ecs = await release({ repo: 'castlabs/electron-releases', tag: ECS, asset: `electron-${ECS}-${platform}-${arch}.zip`, to: join(dest, 'ecs'), githubDigest: true });
if (!args.includes('--no-electron'))
  report.electron = await release({ repo: 'electron/electron', tag: ELECTRON, asset: `electron-${ELECTRON}-${platform}-${arch}.zip`, to: join(dest, 'electron'), githubDigest: false });
if (!args.includes('--no-koffi')) {
  const prefix = join(dest, 'koffi');
  // koffi and its prebuilt binary for this platform, as npm would lay them out, without npm
  // (it hung in the container) and without running any install script.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  report.koffi = { version: KOFFI, path: join(prefix, 'node_modules', 'koffi'), packages: [] };
  for (const name of ['koffi', `@koromix/koffi-${platform}-${arch}`]) {
    const meta = await (await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${KOFFI}`)).json();
    const file = join(dest, `${name.replace('/', '__')}-${KOFFI}.tgz`);
    await download(meta.dist.tarball, file);
    const [algorithm, expected] = meta.dist.integrity.split('-');
    const actual = createHash(algorithm).update(readFileSync(file)).digest('base64');
    if (actual !== expected) throw new Error(`${name}: integrity ${actual} doesn't match the registry's ${expected}`);
    const to = join(prefix, 'node_modules', ...name.split('/'));
    mkdirSync(to, { recursive: true });
    const r = spawnSync(tar, ['-xzf', file, '-C', to, '--strip-components=1'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`unpacking ${name} failed`);
    report.koffi.packages.push({ name, integrity: meta.dist.integrity, bytes: statSync(file).size });
  }
}
writeFileSync(join(dest, 'fetch.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
