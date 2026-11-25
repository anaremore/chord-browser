#!/usr/bin/env node
// Which open pull requests touch the same files, and which can't merge as they are: one GraphQL query. For the
// planner before starting a slice or ordering merges, and for a thread before it pushes (AGENTS.md: at most one open
// pull request to main per thread; split hot files between slices, not during them).
//
//   node scripts/dev/pr-collisions.mjs          # files touched by 2 or more open PRs, then CONFLICTING ones
//   node scripts/dev/pr-collisions.mjs --json   # the same, as JSON
//
// The query is QUERY; collisions() and conflicting() are unit-tested in scripts/test/pr-collisions.test.ts.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Every open pull request with its files (up to 100 each) and whether it merges cleanly. */
export const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        isDraft
        headRefName
        mergeable
        files(first: 100) { totalCount nodes { path } }
      }
    }
  }
}`;

/** Files touched by two or more pull requests, the most shared first. */
export function collisions(prs) {
  const by = new Map();
  for (const pr of prs) for (const { path } of pr.files?.nodes ?? []) by.set(path, [...(by.get(path) ?? []), pr.number]);
  return [...by]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([path, numbers]) => ({ path, prs: numbers.sort((a, b) => a - b) }))
    .sort((a, b) => b.prs.length - a.prs.length || a.path.localeCompare(b.path));
}

/** Pull requests GitHub says conflict with their base. */
export const conflicting = (prs) => prs.filter((pr) => pr.mergeable === 'CONFLICTING').map(({ number, title, headRefName }) => ({ number, title, headRefName }));

/** Pull requests with more files than the query reads: their collisions may be missing some. */
export const truncated = (prs) => prs.filter((pr) => (pr.files?.totalCount ?? 0) > (pr.files?.nodes?.length ?? 0)).map((pr) => pr.number);

export function report(prs) {
  const lines = [];
  const shared = collisions(prs);
  lines.push(shared.length ? `Files in 2 or more open pull requests (${shared.length}):` : 'No file is in more than one open pull request.');
  for (const { path, prs: numbers } of shared) lines.push(`  ${path}  ${numbers.map((n) => `#${n}`).join(' ')}`);
  const conflicts = conflicting(prs);
  lines.push(conflicts.length ? `Conflicting with their base (${conflicts.length}):` : 'None conflicts with its base.');
  for (const { number, title, headRefName } of conflicts) lines.push(`  #${number} ${title} (${headRefName})`);
  const cut = truncated(prs);
  if (cut.length) lines.push(`More than 100 files, only the first 100 read: ${cut.map((n) => `#${n}`).join(' ')}`);
  return lines.join('\n');
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout.trim();
}

export function main(argv) {
  const [owner, name] = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).split('/');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
  const prs = data.data.repository.pullRequests.nodes;
  if (argv.includes('--json')) console.log(JSON.stringify({ collisions: collisions(prs), conflicting: conflicting(prs), truncated: truncated(prs) }, null, 2));
  else console.log(report(prs));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
