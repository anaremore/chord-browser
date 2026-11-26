/**
 * Every third-party action in .github/workflows, and in any composite action under .github/actions, is pinned to a
 * full commit SHA, with its version as a trailing comment (`uses: actions/checkout@<40 hex> # v7.0.1`). A tag can be
 * moved to other code; a SHA can't, and the release job runs with the signing secrets. Local actions (`./…`) and
 * digest-pinned images are fine. Runs in CI's checks job through `pnpm test`, so a new unpinned `uses:` fails the pull
 * request: block style, flow style (`- { uses: x/y@v1 }`) or with a quoted key (`'uses': …`) (#87).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflows = join(root, '.github/workflows');
const actions = join(root, '.github/actions');

// A `uses` key at a line's start (after any `- `), or after a flow mapping's `{` or `,`; quoted or not.
const USES = /(?:^\s*(?:-\s+)?|[{,]\s*)(['"]?)uses\1\s*:\s*/g;
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+)*\S*$/;
const LOCAL = /^\.\//;
const DIGEST = /^docker:\/\/\S+@sha256:[0-9a-f]{64}(?:\s+#.*)?$/;

/** The `uses:` values that aren't pinned, as "line N: <value>". Comment lines never count. */
export function unpinned(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (/^\s*#/.test(line)) return [];
    const found: string[] = [];
    for (const m of line.matchAll(USES)) {
      const rest = line.slice(m.index + m[0].length);
      const flow = /[{,]/.test(m[0]);
      // In a flow mapping the value ends at the next `,` or `}`; its version comment is the line's own, after it.
      let value = flow ? (rest.split(/[,}]/)[0] ?? '') : rest;
      if (flow) {
        const comment = /#.*$/.exec(rest.slice(value.length));
        if (comment) value = `${value.trim()} ${comment[0]}`;
      }
      value = value.trim().replace(/^(['"])(.*?)\1/, '$2');
      if (!(LOCAL.test(value) || DIGEST.test(value) || PINNED.test(value))) found.push(`line ${i + 1}: ${value}`);
    }
    return found;
  });
}

/** Every workflow, and every composite action's action.yml under .github/actions (none yet: so later ones are covered). */
const files = [
  ...readdirSync(workflows)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(workflows, f)),
  ...(existsSync(actions) ? (readdirSync(actions, { recursive: true }) as string[]).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f)).map((f) => join(actions, f)) : []),
].map((f) => relative(root, f));

describe('third-party actions are pinned to a commit SHA', () => {
  it('finds the workflows', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s pins every action', (file) => {
    expect(
      unpinned(readFileSync(join(root, file), 'utf8')),
      `${file}: pin each action to its full commit SHA with the version as a comment, e.g. uses: actions/checkout@<sha> # v7.0.1 (gh api repos/<owner>/<repo>/git/ref/tags/<tag>, dereferencing annotated tags)`,
    ).toEqual([]);
  });

  it.each([
    ['      - uses: actions/checkout@v7', 1],
    ['      - uses: actions/checkout@main', 1],
    ['        uses: actions/cache/restore@v6', 1],
    ['      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 1], // no version comment
    ['      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 0],
    ['        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0', 0],
    ["      - uses: 'actions/checkout@v7'", 1],
    ['      - uses: ./.github/actions/setup', 0],
    ['      - uses: docker://alpine:3', 1],
    [`      - uses: docker://alpine@sha256:${'a'.repeat(64)}`, 0],
    ['  # code, so this job is kept apart from anything a release uses:', 0],
    // Flow style and quoted keys (#87).
    ['      - { uses: actions/checkout@v7 }', 1],
    ['      - { name: Check out, uses: actions/checkout@v7 }', 1],
    ['      - { uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 } # v7.0.1', 0],
    ["      - 'uses': actions/checkout@v7", 1],
    ['      - "uses": actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 0],
    ['      - { uses: ./.github/actions/setup }', 0],
    ['      # - uses: actions/checkout@v7', 0],
  ])('"%s" has %i unpinned', (line, count) => {
    expect(unpinned(line)).toHaveLength(count);
  });
});
