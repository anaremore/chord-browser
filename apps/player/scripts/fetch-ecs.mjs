// The castLabs ECS zip Chord Player is packaged on (ecs.json), checked before
// anything uses it. A download is untrusted until then: it goes into a new
// temp folder of its own, and is kept (in the cache) only once its SHA-256
// matches the hash pinned in ecs.json, castLabs' SHASUMS256.txt and, when
// GitHub answers, the asset digest GitHub computed. Nothing in it runs here.
//
//   node apps/player/scripts/fetch-ecs.mjs [<platform>-<arch>]   prints the checked zip's path
//
// The cache is CHORD_ECS_CACHE, or ~/.cache/chord-ecs.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = import.meta.dirname;
export const ecsJson = join(here, '..', 'ecs.json');

export async function readEcs() {
  return JSON.parse(await readFile(ecsJson, 'utf8'));
}

export const assetName = (version, target) => `electron-v${version}-${target}.zip`;
export const releaseBase = (version) => `https://github.com/castlabs/electron-releases/releases/download/v${encodeURIComponent(version)}`;

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

/** The SHA-256 SHASUMS256.txt lists for `asset`, or null. */
export function listedHash(sums, asset) {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === asset && /^[0-9a-f]{64}$/.test(hash ?? '')) return hash;
  }
  return null;
}

/** GitHub's digest for each asset of an ECS release (`sha256:…`), or an empty map when the API doesn't answer. */
export async function githubDigests(version) {
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  try {
    const response = await fetch(`https://api.github.com/repos/castlabs/electron-releases/releases/tags/v${encodeURIComponent(version)}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return new Map();
    const release = await response.json();
    return new Map((release.assets ?? []).map((a) => [a.name, a.digest ?? null]));
  } catch {
    return new Map();
  }
}

/** The checked zip for `target` (e.g. linux-x64): from the cache if it's there and still matches, else downloaded and checked. */
export async function ecsZip(target, { cache = process.env.CHORD_ECS_CACHE || join(homedir(), '.cache', 'chord-ecs'), log = console.error } = {}) {
  const { version, assets } = await readEcs();
  const expected = assets[target];
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error(`ecs.json pins no ECS zip for ${target}`);
  const asset = assetName(version, target);
  const cached = join(cache, `${expected.slice(0, 16)}-${asset}`);
  if (existsSync(cached)) {
    if ((await sha256(cached)) === expected) return cached;
    await rm(cached, { force: true });
  }
  const dir = await mkdtemp(join(tmpdir(), 'chord-ecs-download-'));
  try {
    const file = join(dir, asset);
    log(`[ecs] Downloading ${asset}`);
    await download(`${releaseBase(version)}/${encodeURIComponent(asset)}`, file);
    const sumsFile = join(dir, 'SHASUMS256.txt');
    await download(`${releaseBase(version)}/SHASUMS256.txt`, sumsFile);
    const listed = listedHash(await readFile(sumsFile, 'utf8'), asset);
    const actual = await sha256(file);
    if (listed !== expected) throw new Error(`${asset}: SHASUMS256.txt says ${listed}, ecs.json pins ${expected}`);
    if (actual !== expected) throw new Error(`${asset}: downloaded SHA-256 ${actual}, ecs.json pins ${expected}`);
    const digest = (await githubDigests(version)).get(asset);
    if (digest && digest !== `sha256:${expected}`) throw new Error(`${asset}: GitHub's digest ${digest} doesn't match`);
    log(`[ecs] ${asset}: SHA-256 matches ecs.json, SHASUMS256.txt${digest ? ' and GitHub’s digest' : ''}`);
    await mkdir(cache, { recursive: true });
    const partial = `${cached}.partial`;
    await copyFile(file, partial);
    await rename(partial, cached);
    return cached;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
  console.log(await ecsZip(target));
}
