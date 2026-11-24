/**
 * AGENTS.md is the one page every agent reads first, so it stays short and true: at most 200 lines (it's a card that
 * points into ARCHITECTURE.md and DESIGN.md, not another copy of them), and every file or folder it names exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { namedPaths } from './named-paths';

const root = resolve(import.meta.dirname, '../..');
const MAX_LINES = 200;

describe('AGENTS.md', () => {
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');

  it(`is at most ${MAX_LINES} lines`, () => {
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('names only paths that exist', () => {
    const named = namedPaths(text);
    expect(named.length, 'the scan found no paths at all: has the format changed?').toBeGreaterThan(10);
    expect(named.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });

  it('CLAUDE.md points to it', () => {
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('(AGENTS.md)');
  });

  it.each([
    ['see `packages/ipc/src/index.ts`', ['packages/ipc/src/index.ts']],
    ['[the record](docs/decisions/S18-agent-mcp.md#m2-plan)', ['docs/decisions/S18-agent-mcp.md']],
    ['`docs/releasing/` and `stylelint.config.js`', ['docs/releasing/', 'stylelint.config.js']],
    ['`pnpm test:e2e:linux`, `*.perf.test.ts`, `Z:\\Projects\\x`, `S20-<name>/plan.md`, `isAgentInput(contents)`', []],
  ])('reads the paths in %s', (sample, paths) => {
    expect(namedPaths(sample)).toEqual(paths);
  });
});
