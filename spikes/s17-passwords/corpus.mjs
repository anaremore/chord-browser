#!/usr/bin/env node
// Spike S17 M0: fetches DuckDuckGo's labelled form corpus (duckduckgo/duckduckgo-autofill,
// Apache-2.0) into spikes/s17-passwords/.cache/ddg/, which git ignores. Nothing of it is
// committed: the snapshots are other sites' markup (S17 §13, §14). Pinned to one commit and
// checked by hash: the tarball's SHA-256 first, and, since GitHub doesn't promise a tarball's
// bytes stay the same, the tree hash of test-forms/ (every file's path and SHA-256, sorted)
// when it differs. Either mismatch with the tree is an error.
//
//   node spikes/s17-passwords/corpus.mjs           fetch (once) and check
//   node spikes/s17-passwords/corpus.mjs --print   print the tree hash of what's there
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** duckduckgo-autofill 19.2.1 (2026-10-12). */
export const DDG_COMMIT = '4d5848619462c863d6bb7553cb090fc74b172be2';
export const DDG_TARBALL_SHA256 = '9c3e0f78efd8cce6844242963e8319c978dc7512377a4ec15516747f88fbfe56';
export const DDG_FORMS_TREE_SHA256 = '5cceaedd7cdf11ec9999565e78bba313fd69e2c1c04bccbafa946acb120630ce';

const here = import.meta.dirname;
export const cacheDir = join(here, '.cache', 'ddg');
/** The extracted repository at the pinned commit. */
export const repoDir = join(cacheDir, `duckduckgo-autofill-${DDG_COMMIT}`);
export const formsDir = join(repoDir, 'test-forms');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function treeHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const lines = files.map((p) => `${relative(dir, p).replaceAll('\\', '/')} ${sha256(readFileSync(p))}`).sort();
  return sha256(lines.join('\n'));
}

export async function ensureCorpus({ quiet = false } = {}) {
  const log = (s) => quiet || console.log(`[corpus] ${s}`);
  if (!existsSync(formsDir)) {
    mkdirSync(cacheDir, { recursive: true });
    const url = `https://codeload.github.com/duckduckgo/duckduckgo-autofill/tar.gz/${DDG_COMMIT}`;
    log(`fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const got = sha256(body);
    log(got === DDG_TARBALL_SHA256 ? 'tarball hash matches' : `tarball hash ${got} differs from the pin; checking the tree instead`);
    // A fresh, empty folder for the download; renamed into place only once unpacked.
    const staging = join(cacheDir, `staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    writeFileSync(join(staging, 'ddg.tgz'), body);
    const tar = spawnSync('tar', ['-xzf', 'ddg.tgz'], { cwd: staging, stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('tar failed');
    renameSync(join(staging, `duckduckgo-autofill-${DDG_COMMIT}`), repoDir);
    rmSync(staging, { recursive: true, force: true });
  }
  const tree = treeHash(formsDir);
  if (DDG_FORMS_TREE_SHA256 !== 'PINNED_BELOW' && tree !== DDG_FORMS_TREE_SHA256) {
    throw new Error(`test-forms tree hash ${tree} isn't the pinned ${DDG_FORMS_TREE_SHA256}: delete ${cacheDir} and fetch again`);
  }
  log(`test-forms ok (${readdirSync(formsDir).length} files, tree ${tree.slice(0, 12)}…)`);
  return { repoDir, formsDir, tree };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { tree } = await ensureCorpus();
  if (process.argv.includes('--print')) console.log(tree);
}
