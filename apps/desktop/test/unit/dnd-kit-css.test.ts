import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The names dnd-kit's rules are written with, as its Feedback plugin's constants define them. */
const NAMES: Record<string, string> = {
  ATTRIBUTE: 'data-dnd-dragging',
  PLACEHOLDER_ATTRIBUTE: 'data-dnd-placeholder',
  DROPPING_ATTRIBUTE: 'data-dnd-dropping',
  ATTR_PREFIX: 'data-dnd-',
  CSS_PREFIX: '--dnd-',
};

/** CSS with comments gone and every run of spaces one space, and none beside punctuation. */
const normalize = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,()])\s*/g, '$1')
    .trim();

describe("dnd-kit's rules for a dragged row", () => {
  it('are the installed dnd-kit’s, which it can’t add itself under Chord’s content security policy', () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve('@dnd-kit/dom'), 'utf8');
    const rules = /CSS_RULES = `([\s\S]*?)`/.exec(source)?.[1];
    expect(rules, 'the Feedback plugin’s CSS_RULES in @dnd-kit/dom').toBeDefined();
    const theirs = rules!.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      expect(NAMES, `dnd-kit's ${name}`).toHaveProperty(name);
      return NAMES[name]!;
    });
    const ours = readFileSync(resolve(import.meta.dirname, '../../src/renderer/shell/dnd-kit.css'), 'utf8');
    expect(normalize(ours)).toBe(normalize(theirs));
  });
});
