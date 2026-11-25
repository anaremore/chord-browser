/**
 * `E2E` is the one status main's ruleset requires, so the job that posts it (`e2e`, in ci.yml) must cover every
 * other job of the run: each one in its `needs`, and each one's result read by its verdict. A job left out could
 * fail while `E2E` says success, and a pull request would merge on it (#162 merged with typecheck failing, under the
 * verdict as it was before #153).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ci = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8');

/** Each top-level job's name and its text, from ci.yml's `jobs:` (two-space indented keys). */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const result = new Map<string, string>();
  const starts = [...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)];
  starts.forEach((m, i) => result.set(m[1], body.slice(m.index, starts[i + 1]?.index ?? body.length)));
  return result;
}

describe('the E2E verdict', () => {
  const all = jobs(ci);
  const verdict = all.get('e2e') ?? '';
  const needs = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(verdict)?.[1].split(',').map((s) => s.trim()) ?? [];

  it('is a job of ci.yml, run whatever the jobs it waits for did', () => {
    expect(verdict).not.toBe('');
    expect(verdict).toMatch(/^ {4}if: always\(\)/m);
  });

  it('waits for every other job of the run, the checks job above all', () => {
    expect(needs).toContain('checks');
    expect([...all.keys()].filter((job) => job !== 'e2e' && !needs.includes(job))).toEqual([]);
  });

  it('reads each of their results', () => {
    for (const job of needs) expect(verdict, `needs.${job}.result`).toContain(`needs.${job}.result`);
  });

  it('fails when the checks job fails or is cancelled', () => {
    expect(verdict).toMatch(/"checks:\$CHECKS"/);
    expect(verdict).toMatch(/failure \| cancelled\)/);
  });
});
