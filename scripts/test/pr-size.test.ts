import { describe, expect, it } from 'vitest';
import { measure, parseNumstat, run, SOFT_CAP, summary } from '../ci/pr-size.mjs';

const numstat = (rows: [number | '-', number | '-', string][]) => rows.map((r) => r.join('\t')).join('\n') + '\n';

describe('a pull request’s size, as review sees it', () => {
  it('reads git’s numstat, binary files as nothing', () => {
    expect(parseNumstat(numstat([[10, 2, 'a.ts'], ['-', '-', 'icon.png'], [0, 5, 'dir/b c.ts']]))).toEqual([
      { path: 'a.ts', added: 10, removed: 2 },
      { path: 'icon.png', added: 0, removed: 0 },
      { path: 'dir/b c.ts', added: 0, removed: 5 },
    ]);
  });

  it.each([
    ['pnpm-lock.yaml', 'a lockfile'],
    ['apps/desktop/test/fixtures/passwords/frame-sign-in.html', 'a fixture'],
    ['docs/decisions/S18-agent-mcp.md', 'docs'],
    ['AGENTS.md', 'docs'],
    ['mocks/m2e.html', 'a mock'],
    ['apps/desktop/build/ad-blocking/easylist.txt', 'a vendored filter list'],
    ['apps/desktop/src/main/browser.ts', null],
    ['apps/desktop/test/e2e/agents.spec.ts', null],
    ['.github/workflows/ci.yml', null],
  ])('%s: %s', (path, why) => {
    const m = measure([{ path, added: 100, removed: 0 }]);
    expect(m.skipped[0]?.why ?? null).toBe(why);
    expect(m.lines).toBe(why ? 0 : 100);
  });

  it(`warns over ${SOFT_CAP}, never fails`, () => {
    const logged: string[] = [];
    const at = run(numstat([[SOFT_CAP, 0, 'a.ts'], [9000, 0, 'pnpm-lock.yaml']]), {}, (l: string) => logged.push(l));
    expect(at.over).toBe(false);
    expect(logged.some((l) => l.startsWith('::warning'))).toBe(false);
    const over = run(numstat([[SOFT_CAP, 1, 'a.ts']]), {}, (l: string) => logged.push(l));
    expect(over).toMatchObject({ over: true, lines: SOFT_CAP + 1 });
    expect(logged.at(-1)).toBe(`::warning title=Large pull request::${SOFT_CAP + 1} changed lines that review reads, over the soft cap of ${SOFT_CAP}. Split it if you can, or say why it's one piece.`);
  });

  it('the summary lists the biggest files only when it’s over', () => {
    expect(summary(measure([{ path: 'a.ts', added: 3, removed: 1 }]))).not.toContain('| File |');
    const big = summary(measure([{ path: 'a.ts', added: 1000, removed: 0 }, { path: 'b.ts', added: 700, removed: 400 }]));
    expect(big).toContain('2,100 changed lines');
    expect(big.indexOf('`b.ts`')).toBeLessThan(big.indexOf('`a.ts`'));
  });
});
