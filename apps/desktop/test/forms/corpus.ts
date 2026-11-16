/**
 * DuckDuckGo's labelled form corpus (duckduckgo/duckduckgo-autofill, Apache-2.0), fetched
 * for the corpus suite (S17 §13 layer 2; decided 2026-11-15: a hash-checked download,
 * cached, never in the repository or a release). The snapshots are other sites' markup
 * (S17 §14), so only `test-forms/` is unpacked, into a git-ignored cache: CHORD_FORMS_CACHE,
 * or test/forms/.cache. CI keeps that folder between runs (ci.yml, `forms`).
 *
 * Pinned to one commit, and checked twice: the tarball's SHA-256, and, since GitHub doesn't
 * promise a tarball's bytes stay the same, the tree hash of `test-forms/` (every file's path
 * and SHA-256, sorted). The tree must match; a tarball that differs only logs so.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** duckduckgo-autofill 19.2.1 (2026-10-12), as M0's bake-off. */
export const CORPUS_COMMIT = '4d5848619462c863d6bb7553cb090fc74b172be2';
export const CORPUS_TARBALL_SHA256 = '9c3e0f78efd8cce6844242963e8319c978dc7512377a4ec15516747f88fbfe56';
export const CORPUS_TREE_SHA256 = '5cceaedd7cdf11ec9999565e78bba313fd69e2c1c04bccbafa946acb120630ce';

export const cacheDir = resolve(process.env['CHORD_FORMS_CACHE'] ?? join(import.meta.dirname, '.cache'));
export const formsDir = join(cacheDir, `ddg-${CORPUS_COMMIT.slice(0, 12)}`, 'test-forms');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Every file under `dir` by its path and SHA-256, sorted, hashed. */
export function treeHash(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return sha256(
    files
      .map((p) => `${relative(dir, p).replaceAll('\\', '/')} ${sha256(readFileSync(p))}`)
      .sort()
      .join('\n'),
  );
}

/** One file of DuckDuckGo's index (`test-forms/index.json`). */
export interface CorpusEntry {
  readonly html: string;
  readonly title?: string;
  readonly hasExtraWrappers?: boolean;
}

/** The corpus, fetched once and checked every time. */
export async function ensureCorpus(log: (line: string) => void = () => {}): Promise<{ formsDir: string; index: CorpusEntry[] }> {
  if (!existsSync(formsDir)) {
    const url = `https://codeload.github.com/duckduckgo/duckduckgo-autofill/tar.gz/${CORPUS_COMMIT}`;
    log(`fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const got = sha256(body);
    log(got === CORPUS_TARBALL_SHA256 ? 'tarball hash matches' : `tarball hash ${got} isn't the pinned one; checking the tree instead`);
    // A fresh, empty folder for the download, renamed into place once unpacked and checked.
    const staging = join(cacheDir, `staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'ddg.tgz'), body);
    const top = `duckduckgo-autofill-${CORPUS_COMMIT}`;
    const tar = spawnSync('tar', ['-xzf', 'ddg.tgz', `${top}/test-forms`], { cwd: staging, stdio: 'inherit', windowsHide: true });
    if (tar.status !== 0) throw new Error('tar failed');
    const unpacked = join(staging, top, 'test-forms');
    const tree = treeHash(unpacked);
    if (tree !== CORPUS_TREE_SHA256) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`test-forms tree hash ${tree} isn't the pinned ${CORPUS_TREE_SHA256}`);
    }
    mkdirSync(join(formsDir, '..'), { recursive: true });
    renameSync(unpacked, formsDir);
    rmSync(staging, { recursive: true, force: true });
  } else {
    const tree = treeHash(formsDir);
    if (tree !== CORPUS_TREE_SHA256) throw new Error(`${formsDir}: tree hash ${tree} isn't the pinned ${CORPUS_TREE_SHA256}; delete ${cacheDir} to fetch it again`);
  }
  const index = JSON.parse(readFileSync(join(formsDir, 'index.json'), 'utf8')) as CorpusEntry[];
  log(`test-forms ok: ${index.length} files`);
  return { formsDir, index };
}
