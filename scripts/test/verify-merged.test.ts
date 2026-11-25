import { describe, expect, it } from 'vitest';
import { collisions, conflicting, report, truncated } from '../dev/pr-collisions.mjs';
import { verdict } from '../dev/verify-merged.mjs';

describe('verify-merged: in main, or not', () => {
  const merged = { number: 148, state: 'MERGED', mergeCommit: 'abcdef0123456789' };
  it.each([
    [merged, true, true, '#148 is merged: abcdef012 is in origin/main'],
    [merged, false, false, "#148's merge commit abcdef012 isn't in origin/main"],
    [{ ...merged, state: 'OPEN', mergeCommit: null }, false, false, '#148 is still open'],
    [{ ...merged, state: 'CLOSED', mergeCommit: null }, false, false, '#148 was closed without merging'],
    [{ ...merged, mergeCommit: null }, true, false, '#148 says MERGED but has no merge commit'],
    [null, false, false, 'GitHub has no such pull request'],
  ])('%j, in main %s: ok %s', (pr, inMain, ok, why) => {
    expect(verdict(pr, inMain)).toEqual({ ok, why });
  });
});

describe('pr-collisions: shared files and conflicts', () => {
  const pr = (number: number, paths: string[], mergeable = 'MERGEABLE', totalCount = paths.length) => ({
    number,
    title: `PR ${number}`,
    headRefName: `b${number}`,
    isDraft: false,
    mergeable,
    files: { totalCount, nodes: paths.map((path) => ({ path })) },
  });
  const prs = [
    pr(1, ['a.ts', 'b.ts', 'AGENTS.md']),
    pr(2, ['b.ts', 'AGENTS.md']),
    pr(3, ['AGENTS.md', 'c.ts'], 'CONFLICTING'),
    pr(4, ['d.ts'], 'UNKNOWN', 140),
  ];

  it('lists files in two or more, the most shared first', () => {
    expect(collisions(prs)).toEqual([
      { path: 'AGENTS.md', prs: [1, 2, 3] },
      { path: 'b.ts', prs: [1, 2] },
    ]);
    expect(collisions([pr(1, ['a.ts'])])).toEqual([]);
  });

  it('lists the conflicting ones, and those with more files than were read', () => {
    expect(conflicting(prs)).toEqual([{ number: 3, title: 'PR 3', headRefName: 'b3' }]);
    expect(truncated(prs)).toEqual([4]);
  });

  it('says it plainly', () => {
    expect(report(prs)).toBe(
      ['Files in 2 or more open pull requests (2):', '  AGENTS.md  #1 #2 #3', '  b.ts  #1 #2', 'Conflicting with their base (1):', '  #3 PR 3 (b3)', 'More than 100 files, only the first 100 read: #4'].join('\n'),
    );
    expect(report([pr(1, ['a.ts'])])).toBe('No file is in more than one open pull request.\nNone conflicts with its base.');
  });
});
