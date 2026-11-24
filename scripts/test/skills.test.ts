/**
 * The repo's skills (.claude/skills/<name>/SKILL.md) are procedures that point into the docs (AGENTS.md holds the
 * rules). Each one is found by its name and description, stays short enough to read whole, and names only paths that
 * exist, so a moved script or runbook breaks this test, not the next agent's run.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { namedPaths } from './named-paths';

const root = resolve(import.meta.dirname, '../..');
const SKILLS = join(root, '.claude/skills');
const MAX_LINES = 120;

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** The frontmatter's `key: value` lines, between the first two `---` lines. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replaceAll('\r\n', '\n'))?.[1] ?? '';
  return Object.fromEntries(block.split('\n').flatMap((line) => {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    return m ? [[m[1]!, m[2]!.trim()]] : [];
  }));
}

describe('the repo’s skills', () => {
  it('are there', () => {
    expect(skills).toEqual(expect.arrayContaining(['chord-e2e-linux', 'chord-preview', 'chord-release']));
  });

  it.each(skills)('%s: named as its folder, described, short, and every path it names exists', (name) => {
    const path = join(SKILLS, name, 'SKILL.md');
    expect(existsSync(path), `${name} has no SKILL.md`).toBe(true);
    const text = readFileSync(path, 'utf8');
    const meta = frontmatter(text);
    expect(meta['name']).toBe(name);
    expect(meta['description']?.length ?? 0, 'a description says when to use it').toBeGreaterThan(40);
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(MAX_LINES);
    const named = namedPaths(text);
    expect(named.filter((p) => !existsSync(join(root, p))), `${name} names paths that don't exist`).toEqual([]);
  });

  it('reads the frontmatter', () => {
    expect(frontmatter('---\nname: x\ndescription: Does y: z.\n---\n# X\nname: not this\n')).toEqual({ name: 'x', description: 'Does y: z.' });
  });
});
