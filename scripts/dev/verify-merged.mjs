#!/usr/bin/env node
// Is a pull request really in main? Before a worktree or branch is deleted (AGENTS.md: "Remove one only after its PR
// shows MERGED"), and before work that builds on it starts. A failed merge once deleted a branch that wasn't in.
//
//   node scripts/dev/verify-merged.mjs 148        # exit 0: merged, and its merge commit is in origin/main
//
// Exit 0 only when GitHub says MERGED and the merge commit is an ancestor of origin/main (fetched first). Anything
// else exits 1 and says why: open, closed without merging, or a merge commit main doesn't have. The decision is
// verdict(), unit-tested in scripts/test/verify-merged.test.ts.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** What to say, from the pull request's state and whether its merge commit is in main. */
export function verdict(pr, inMain) {
  if (!pr) return { ok: false, why: 'GitHub has no such pull request' };
  if (pr.state === 'OPEN') return { ok: false, why: `#${pr.number} is still open` };
  if (pr.state !== 'MERGED') return { ok: false, why: `#${pr.number} was closed without merging` };
  if (!pr.mergeCommit) return { ok: false, why: `#${pr.number} says MERGED but has no merge commit` };
  if (!inMain) return { ok: false, why: `#${pr.number}'s merge commit ${pr.mergeCommit.slice(0, 9)} isn't in origin/main` };
  return { ok: true, why: `#${pr.number} is merged: ${pr.mergeCommit.slice(0, 9)} is in origin/main` };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { code: result.status ?? 1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

export function main(argv) {
  const number = Number(argv[0]);
  if (!Number.isInteger(number) || number < 1) {
    console.error('usage: node scripts/dev/verify-merged.mjs <pull request number>');
    return 2;
  }
  const view = run('gh', ['pr', 'view', String(number), '--json', 'number,state,mergeCommit', '--jq', '{number, state, mergeCommit: .mergeCommit.oid}']);
  const pr = view.code === 0 ? JSON.parse(view.out) : null;
  let inMain = false;
  if (pr?.state === 'MERGED' && pr.mergeCommit) {
    const fetched = run('git', ['fetch', '--quiet', 'origin', 'main']);
    if (fetched.code !== 0) {
      console.error(`git fetch origin main failed: ${fetched.err}`);
      return 1;
    }
    inMain = run('git', ['merge-base', '--is-ancestor', pr.mergeCommit, 'origin/main']).code === 0;
  }
  const { ok, why } = verdict(pr, inMain);
  console.log(why);
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
