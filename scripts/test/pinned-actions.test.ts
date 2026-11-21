/**
 * Every third-party action in .github/workflows is pinned to a full commit SHA, with its version as a trailing
 * comment (`uses: actions/checkout@<40 hex> # v7.0.1`). A tag can be moved to other code; a SHA can't, and the
 * release job runs with the signing secrets. Local actions (`./…`) and digest-pinned images are fine.
 * Runs in CI's checks job through `pnpm test`, so a new unpinned `uses:` line fails the pull request.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflows = join(root, '.github/workflows');

const USES = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+)*\S*$/;
const LOCAL = /^\.\//;
const DIGEST = /^docker:\/\/\S+@sha256:[0-9a-f]{64}(?:\s+#.*)?$/;

/** The `uses:` lines that aren't pinned, as "line N: <value>". */
export function unpinned(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const m = USES.exec(line);
    if (!m) return [];
    const value = m[1].trim().replace(/^(['"])(.*?)\1/, '$2');
    return LOCAL.test(value) || DIGEST.test(value) || PINNED.test(value) ? [] : [`line ${i + 1}: ${value}`];
  });
}

const files = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f));

describe('third-party actions are pinned to a commit SHA', () => {
  it('finds the workflows', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s pins every action', (file) => {
    expect(
      unpinned(readFileSync(join(workflows, file), 'utf8')),
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
  ])('"%s" has %i unpinned', (line, count) => {
    expect(unpinned(line)).toHaveLength(count);
  });
});
