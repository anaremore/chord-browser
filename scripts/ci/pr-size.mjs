// A pull request's size, as review sees it (Neon's factory audit, item 6; the owner, 2026-11-24): the lines it adds
// and removes, without lockfiles, fixtures, docs and vendored lists. Over SOFT_CAP, a warning on the run and in its
// summary, never a failure: split the slice if you can, or say in the description why it's one piece.
//
// Review rounds grew with size: M2c (+3,694 lines) took 8 rounds and M2d (+4,273) 4 plus a final pass, where slices
// near 1,000 lines took one or two.
//
//   git diff --numstat --no-renames HEAD^1 HEAD | node scripts/ci/pr-size.mjs
//
// Pure parts are unit-tested in scripts/test/pr-size.test.ts.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SOFT_CAP = 1500;

/** What review doesn't read line by line, and why. */
export const NOT_COUNTED = [
  [/(^|\/)pnpm-lock\.yaml$/, 'a lockfile'],
  [/(^|\/)fixtures\//, 'a fixture'],
  [/(^|\/)__snapshots__\//, 'a snapshot'],
  [/\.md$/, 'docs'],
  [/^docs\//, 'docs'],
  [/^mocks\//, 'a mock'],
  [/^apps\/desktop\/build\/ad-blocking\//, 'a vendored filter list'],
];

/** `git diff --numstat` lines: added, removed, path ("-" for binary files, which count as nothing). */
export function parseNumstat(text) {
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3)
    .map(([added, removed, ...path]) => ({ path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }));
}

/** What counts toward the cap, and what doesn't (with why). */
export function measure(files) {
  const counted = [];
  const skipped = [];
  for (const file of files) {
    const why = NOT_COUNTED.find(([pattern]) => pattern.test(file.path))?.[1];
    (why ? skipped : counted).push(why ? { ...file, why } : file);
  }
  const lines = counted.reduce((n, f) => n + f.added + f.removed, 0);
  return { lines, counted, skipped, over: lines > SOFT_CAP };
}

/** The step summary: the total, and the biggest files when it's over. */
export function summary(m) {
  const fmt = (n) => n.toLocaleString('en-US');
  const head = `### Pull request size\n\n${fmt(m.lines)} changed lines that review reads (the soft cap is ${fmt(SOFT_CAP)}; lockfiles, fixtures, docs and vendored lists not counted).`;
  if (!m.over) return `${head}\n`;
  const biggest = [...m.counted].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, 10);
  return [
    head,
    '',
    'Over the soft cap: split the slice if you can (stacked pull requests, or a part behind a flag), or say in the description why it is one piece. Review rounds grow with size.',
    '',
    '| File | + | − |',
    '| --- | --- | --- |',
    ...biggest.map((f) => `| \`${f.path}\` | ${fmt(f.added)} | ${fmt(f.removed)} |`),
    '',
  ].join('\n');
}

export function run(numstat, env = process.env, log = console.log) {
  const m = measure(parseNumstat(numstat));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(m));
  log(summary(m));
  if (m.over) log(`::warning title=Large pull request::${m.lines} changed lines that review reads, over the soft cap of ${SOFT_CAP}. Split it if you can, or say why it's one piece.`);
  return m;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run(readFileSync(0, 'utf8'));
