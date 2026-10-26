/**
 * The README and chordbrowser.com never name the current version: after a
 * release it would be stale (the README said 0.2.1 once 0.3.0 was out). They
 * say "the latest preview", and the site reads the version from latest.json,
 * which follows each release. Naming the version a change arrived in ("from
 * 0.2.1", "since 0.2.1") stays true, so that's allowed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const VERSION = /\b\d+\.\d+\.\d+\b/g;
/** "from 0.2.1", "since 0.2.1": when something arrived. */
const SINCE = /\b(from|since)\s+$/i;

/** Each version a text names, with the words before it, unless it says when something arrived. */
function stale(text: string): string[] {
  return [...text.matchAll(VERSION)]
    .filter((m) => !SINCE.test(text.slice(Math.max(0, m.index - 12), m.index)))
    .map((m) => text.slice(Math.max(0, m.index - 30), m.index + m[0].length).replace(/\s+/g, ' ').trim());
}

const sitePages = readdirSync(join(root, 'site/public'), { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.html'))
  .map((f) => join('site/public', f));

describe('no version that goes stale after a release', () => {
  it.each(['README.md', ...sitePages])('%s names none', (file) => {
    const found = stale(readFileSync(join(root, file), 'utf8'));
    expect(found, `${file} names a version, which goes stale with the next release: say "the latest preview" (or "from X.Y.Z" for when something arrived)`).toEqual([]);
  });

  it.each([
    ['Chord 0.2.1 is on chordbrowser.com', 1],
    ['The latest preview is on chordbrowser.com', 0],
    ['From 0.2.1, Chord on Windows updates itself', 0],
    ['updates itself since 0.2.1', 0],
    ['Electron 45 and Chromium 156.0.8078.48', 1],
  ])('finds the stale ones in "%s": %i', (text, count) => {
    expect(stale(text)).toHaveLength(count);
  });
});
