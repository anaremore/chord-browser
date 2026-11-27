import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { annotations, firstLine, flakyTests, run, summary, testsOf } from '../ci/flaky-summary.mjs';

const ESC = String.fromCharCode(27);
const result = (status: string, message?: string) => ({ status, retry: 0, errors: [], ...(message ? { error: { message } } : {}) });

// Trimmed from a real report (Playwright 1.64's json reporter, 2026-11-24): a file's suite, its specs, a describe's
// suite inside it, and each test's tries.
const report = {
  suites: [
    {
      title: 'flaky.spec.ts',
      file: 'flaky.spec.ts',
      line: 0,
      specs: [
        { title: 'always passes', file: 'flaky.spec.ts', line: 5, tests: [{ status: 'expected', results: [result('passed')] }] },
        {
          title: 'always fails',
          file: 'flaky.spec.ts',
          line: 6,
          tests: [{ status: 'unexpected', results: [result('failed', 'Error: one'), result('failed', 'Error: two')] }],
        },
        { title: 'skipped', file: 'flaky.spec.ts', line: 7, tests: [{ status: 'skipped', results: [result('skipped')] }] },
      ],
      suites: [
        {
          title: 'a group',
          file: 'flaky.spec.ts',
          line: 2,
          specs: [
            {
              title: 'passes on the retry',
              file: 'flaky.spec.ts',
              line: 3,
              tests: [{ status: 'flaky', results: [result('failed', `Error: first try fails\n\n${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived`), result('passed')] }],
            },
          ],
        },
      ],
    },
    {
      title: 'proxies.spec.ts',
      file: 'proxies.spec.ts',
      specs: [{ title: 'SOCKS5 | names', file: 'proxies.spec.ts', line: 383, tests: [{ status: 'flaky', results: [result('timedOut', `${ESC}[31mTest timeout of 60000ms exceeded.${ESC}[39m`), result('passed')] }] }],
    },
  ],
};

describe('flaky E2E tests, from the json report', () => {
  it('walks every test, with describe titles but not the file', () => {
    expect(testsOf(report).map((t) => `${t.file}:${t.line} ${t.title} ${t.status}`)).toEqual([
      'flaky.spec.ts:5 always passes expected',
      'flaky.spec.ts:6 always fails unexpected',
      'flaky.spec.ts:7 skipped skipped',
      'flaky.spec.ts:3 a group › passes on the retry flaky',
      'proxies.spec.ts:383 SOCKS5 | names flaky',
    ]);
  });

  it('finds only those that passed on a retry, with the first try’s error', () => {
    expect(flakyTests(report)).toEqual([
      { where: 'flaky.spec.ts:3', title: 'a group › passes on the retry', error: 'Error: first try fails' },
      { where: 'proxies.spec.ts:383', title: 'SOCKS5 | names', error: 'Test timeout of 60000ms exceeded.' },
    ]);
  });

  it.each([
    [{ message: '\n\n  Error: x\nmore' }, 'Error: x'],
    [{ value: 'thrown' }, 'thrown'],
    [undefined, ''],
    [{ message: 'y'.repeat(300) }, `${'y'.repeat(199)}…`],
  ])('first line of %j', (error, line) => expect(firstLine(error)).toBe(line));

  it('a table for the step summary, its pipes escaped; a line when there are none', () => {
    const text = summary(flakyTests(report), 'Windows arm64 · 3/3');
    expect(text).toContain('### Flaky E2E tests · Windows arm64 · 3/3');
    expect(text).toContain('2 passed only on the retry');
    expect(text).toContain('| `proxies.spec.ts:383` | SOCKS5 \\| names | Test timeout of 60000ms exceeded. |');
    expect(summary([], '')).toBe('### Flaky E2E tests\n\nNone: every test passed on its first try, or failed both.\n');
  });

  it('a warning annotation each, with its title’s colons and commas escaped', () => {
    expect(annotations([{ where: 'a.spec.ts:3', title: 'x, y', error: '' }], 'Linux, X11')).toEqual(['::warning title=Flaky (Linux%2C X11)%3A a.spec.ts%3A3::x, y']);
  });

  it('a failed try’s [diagnostic] lines (#327): kept, shown under the table and in the warning, even though the retry passed', () => {
    const tagged = {
      suites: [
        {
          title: 'agents-acting.spec.ts',
          file: 'agents-acting.spec.ts',
          specs: [
            {
              title: 'acting',
              file: 'agents-acting.spec.ts',
              line: 19,
              tests: [
                {
                  status: 'flaky',
                  results: [
                    result('failed', `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n${ESC}[2m[diagnostic] #327 popover page: {"frames":false}${ESC}[22m\n[diagnostic] #327 windows: []`),
                    result('passed'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [flaky] = flakyTests(tagged);
    expect(flaky).toEqual({
      where: 'agents-acting.spec.ts:19',
      title: 'acting',
      error: 'TimeoutError: locator.click: Timeout 30000ms exceeded.',
      diagnostics: ['[diagnostic] #327 popover page: {"frames":false}', '[diagnostic] #327 windows: []'],
    });
    expect(summary([flaky!], 'Linux')).toContain('`agents-acting.spec.ts:19`:\n\n```\n[diagnostic] #327 popover page: {"frames":false}\n[diagnostic] #327 windows: []\n```');
    expect(annotations([flaky!], '')[0]).toContain('%0A[diagnostic] #327 popover page: {"frames":false}%0A[diagnostic] #327 windows: []');
  });

  it('appends to the step summary; a missing report says so and fails nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chord-flaky-'));
    try {
      const path = join(dir, 'results.json');
      const step = join(dir, 'summary.md');
      writeFileSync(path, JSON.stringify(report));
      writeFileSync(step, '');
      const logged: string[] = [];
      expect(run(path, 'Linux', { GITHUB_STEP_SUMMARY: step }, (l: string) => logged.push(l))).toHaveLength(2);
      expect(readFileSync(step, 'utf8')).toContain('a group › passes on the retry');
      expect(logged.filter((l) => l.startsWith('::warning'))).toHaveLength(2);
      expect(run(join(dir, 'none.json'), 'Linux', {}, (l: string) => logged.push(l))).toEqual([]);
      expect(logged.at(-1)).toMatch(/^No E2E report to read at .*none\.json \(missing\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
