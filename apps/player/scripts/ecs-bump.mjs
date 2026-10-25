// Moves Chord Player to castLabs' newest stable ECS build (`+wvcus`), for the
// scheduled workflow that opens a pull request for it (.github/workflows/ecs-bump.yml;
// it never merges one). The list of builds is scripts/dev/ecs-lag.mjs's.
//
// When a newer build is out, this pins it in apps/player/ecs.json: each zip's
// SHA-256 as castLabs' SHASUMS256.txt lists it, which must agree with the
// digest GitHub computed for the asset. Then it bumps the player's version
// (patch within an ECS major, minor for a new major) and writes the pull
// request's text. Nothing is downloaded but SHASUMS256.txt; CI's packaging
// downloads and checks the zips themselves.
//
//   node apps/player/scripts/ecs-bump.mjs [--dry-run]
//
// Writes `bump`, `ecs`, `player` and `branch` to $GITHUB_OUTPUT when set, and the body to <tmp>/ecs-bump.md.
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAYER_TARGETS } from '../../../packages/player-protocol/src/release.ts';
import { ecsStable, version as numbers } from '../../../scripts/dev/ecs-lag.mjs';
import { assetName, ecsJson, listedHash, readEcs, releaseBase } from './fetch-ecs.mjs';

const dry = process.argv.includes('--dry-run');
const output = (key, value) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

const current = await readEcs();
const builds = await ecsStable();
const newest = builds[0];
if (!newest) throw new Error('castLabs lists no stable +wvcus build');
const next = newest.tag.replace(/^v/, '');
const [a, b] = [numbers(current.version), newest.v];
const newer = b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2])));
if (!newer) {
  console.log(`Chord Player is on ECS ${current.version}, castLabs' newest stable build.`);
  output('bump', 'false');
  process.exit(0);
}

// Hashes: SHASUMS256.txt, cross-checked with GitHub's own digests.
const response = await fetch(`${releaseBase(next)}/SHASUMS256.txt`, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`SHASUMS256.txt for ${next}: HTTP ${response.status}`);
const sums = await response.text();
const digests = new Map((newest.release.assets ?? []).map((asset) => [asset.name, asset.digest ?? null]));
const assets = {};
for (const target of PLAYER_TARGETS) {
  const asset = assetName(next, target);
  const listed = listedHash(sums, asset);
  if (!listed) throw new Error(`${next} has no ${asset} in SHASUMS256.txt: castLabs may have dropped ${target}`);
  const digest = digests.get(asset);
  if (digest !== `sha256:${listed}`) throw new Error(`${asset}: SHASUMS256.txt says ${listed}, GitHub's digest is ${digest}`);
  assets[target] = listed;
}

const pkgFile = join(import.meta.dirname, '..', 'package.json');
const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
const [major, minor, patch] = pkg.version.split('-')[0].split('.').map(Number);
const player = b[0] > a[0] ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
const published = newest.at.toISOString().slice(0, 10);
const waited = Math.round((Date.now() - newest.at.getTime()) / 3_600_000);

if (!dry) {
  const pinned = JSON.parse(await readFile(ecsJson, 'utf8'));
  await writeFile(ecsJson, `${JSON.stringify({ ...pinned, version: next, assets }, null, 2)}\n`);
  await writeFile(pkgFile, `${JSON.stringify({ ...pkg, version: player }, null, 2)}\n`);
}
const body = [
  `castLabs published ECS **${next}** on ${published} (${waited} h ago). This moves Chord Player from ${current.version} to it, as Chord Player ${player}.`,
  '',
  '- `apps/player/ecs.json`: the new build, each zip pinned by the SHA-256 in castLabs\' SHASUMS256.txt, which matched GitHub\'s asset digest for every target.',
  `- \`apps/player/package.json\`: ${pkg.version} → ${player}.`,
  '',
  'Before merging (this pull request never merges itself):',
  '- CI is green, Chord Player\'s smoke test included: it packages, VMP-signs and plays a Widevine test stream on Windows, macOS and Linux.',
  b[0] > a[0] ? `- **A new Electron major (${a[0]} → ${b[0]}).** Read Electron's breaking changes for it; the player's own code is small, but check its window, the lock's events and \`components\`.` : '- Same Electron major: a patch-level move.',
  '- Then tag `player-v' + player + '` to build the release (docs/releasing/signing.md, Chord Player).',
  '',
  '_Opened by .github/workflows/ecs-bump.yml (apps/player/scripts/ecs-bump.mjs)._',
].join('\n');
await writeFile(join(process.env.RUNNER_TEMP || tmpdir(), 'ecs-bump.md'), `${body}\n`);
output('bump', 'true');
output('ecs', next);
output('player', player);
output('branch', `ecs/${next.replace('+', '-')}`);
