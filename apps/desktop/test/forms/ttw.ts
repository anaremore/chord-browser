/**
 * Bitwarden's test-the-web (bitwarden/test-the-web, GPL-3.0): a site of deliberately tricky
 * forms, for the second suite on the password detector (ttw.spec.ts). **Chord tests against it
 * and never vendors it** (S17 §3, §14): nothing from its repository is in Chord's tree, and the
 * site is built at test time into the same git-ignored cache as DuckDuckGo's corpus
 * (CHORD_FORMS_CACHE, or test/forms/.cache), which CI keeps between runs.
 *
 * Why a pinned build, not the live site: the project isn't hosted anywhere (no GitHub Pages
 * site, no homepage; its README has you build and run it), and a live site would change under
 * the baseline anyway. So it's pinned to one commit and checked as corpus.ts checks DuckDuckGo's:
 * the tarball's SHA-256 (logged only, since GitHub doesn't promise its bytes), and the tree hash
 * of `client/` (and the one API file it imports), which must match. Then `npm ci --ignore-scripts` and `docusaurus build` in a
 * staging folder; only the built site (about 5 MB) is kept, and the 600 MB of `node_modules` is
 * deleted at once.
 *
 * **Never blocks a build:** if the download or the install fails (no network, the registry down),
 * or the build does, `ensureSite` says why and the suite skips. A tree that doesn't match the pin
 * is an error, not a skip: that's the download being wrong, not missing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, treeHash } from './corpus';

/** bitwarden/test-the-web main, 2026-11-16. */
export const SITE_COMMIT = '9f78cc52f29c445f1ba768622dab2a3ae31b694a';
export const SITE_TARBALL_SHA256 = '98c2c439d309a4dfd1ef6205719f391273d5a16a3fa003c90748f6e745930b80';
/** What's unpacked at that commit, `client/` and the one API file it imports: every file's path and SHA-256 (corpus.ts's treeHash). */
export const SITE_TREE_SHA256 = 'cfe1fd07b79554c973b99bfd1338017a6ca242ff4462829617b2fc0f9476304f';
/** The client's build imports the API's route names from this one file. */
const UNPACK = ['client', 'api/constants.ts'];

export const siteDir = join(cacheDir, `ttw-${SITE_COMMIT.slice(0, 12)}`, 'site');
const stamp = join(siteDir, '..', 'built.json');

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export type SiteResult = { ok: true; siteDir: string } | { ok: false; reason: string };

/** Runs a command; on Windows npm and npx are scripts, so through the shell. */
function run(command: string, args: string[], cwd: string, log: (line: string) => void): boolean {
  log(`${command} ${args.join(' ')}`);
  // Without pnpm's npm_config_* settings (node-linker and the like), which npm doesn't know.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
  const r = spawnSync(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return true;
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
  log(`${command} failed (status ${r.status}${r.error ? `, ${r.error.message}` : ''}):\n${tail}`);
  return false;
}

/** The built site, fetched and built once, or why it isn't there. */
export async function ensureSite(log: (line: string) => void = () => {}): Promise<SiteResult> {
  if (existsSync(stamp) && existsSync(join(siteDir, 'index.html'))) {
    const built = JSON.parse(readFileSync(stamp, 'utf8')) as { commit?: string; tree?: string };
    if (built.commit === SITE_COMMIT && built.tree === SITE_TREE_SHA256) {
      log(`test-the-web@${SITE_COMMIT.slice(0, 12)}: built, cached`);
      return { ok: true, siteDir };
    }
  }
  const url = `https://codeload.github.com/bitwarden/test-the-web/tar.gz/${SITE_COMMIT}`;
  log(`fetching ${url}`);
  let body: Buffer;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return { ok: false, reason: `${url}: HTTP ${response.status}` };
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: `${url}: ${(error as Error).message}` };
  }
  const got = sha256(body);
  log(got === SITE_TARBALL_SHA256 ? 'tarball hash matches' : `tarball hash ${got} isn't the pinned one; checking the tree instead`);
  // A fresh, empty folder for the download; only the built site leaves it.
  const staging = join(cacheDir, `ttw-staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, 'ttw.tgz'), body);
    const top = `test-the-web-${SITE_COMMIT}`;
    const tar = spawnSync('tar', ['-xzf', 'ttw.tgz', ...UNPACK.map((p) => `${top}/${p}`)], { cwd: staging, stdio: 'inherit', windowsHide: true });
    if (tar.status !== 0) throw new Error('tar failed');
    const tree = treeHash(join(staging, top));
    if (tree !== SITE_TREE_SHA256) throw new Error(`test-the-web tree hash ${tree} isn't the pinned ${SITE_TREE_SHA256}`);
    const client = join(staging, top, 'client');
    // No install scripts: the build needs none, and a third party's package shouldn't run code at install.
    if (!run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], client, log)) return { ok: false, reason: 'npm ci failed (no network, or the registry is down?)' };
    if (!run('npx', ['--no-install', 'docusaurus', 'build', '--out-dir', 'build'], client, log)) return { ok: false, reason: 'docusaurus build failed' };
    rmSync(join(siteDir, '..'), { recursive: true, force: true });
    mkdirSync(join(siteDir, '..'), { recursive: true });
    renameSync(join(client, 'build'), siteDir);
    writeFileSync(stamp, `${JSON.stringify({ commit: SITE_COMMIT, tree: SITE_TREE_SHA256 })}\n`);
    log(`built into ${siteDir}`);
    return { ok: true, siteDir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
