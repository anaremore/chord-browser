/**
 * Effects' sanitizer (main/effects/sanitize.ts): hostile stylesheets, each
 * tokenized again afterwards as Chromium would, and what must survive.
 */
import { EFFECT_PRESETS } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { compileEffects, sanitizeCss, sanitizeSelector, serializeIdent, verify } from '../../src/main/effects/sanitize';
import { EVIL, fetches, HOSTILE } from './fixtures/hostile-css';

describe('sanitizeCss: hostile stylesheets', () => {
  it.each(HOSTILE)('%s', (_what, input, kept) => {
    const { css } = sanitizeCss(input);
    expect(fetches(css)).toEqual([]);
    expect(verify(css)).toBe(true);
    if (kept) expect(css).toContain(kept);
    else expect(css.replace(/\s+/g, '')).not.toMatch(/url|image|@import|expression|binding|behavior/i);
    // Sanitizing what it made changes nothing.
    expect(sanitizeCss(css).css).toBe(css);
  });

  it('says what it left out, and where', () => {
    const { removed } = sanitizeCss(`p { color: red }\n@import "${EVIL}";\nbody {\n  background: url(${EVIL});\n  width: expression(1);\n}`);
    expect(removed).toEqual([
      { what: '@import', line: 2, kind: 'fetch' },
      { what: 'url()', line: 4, kind: 'fetch' },
      { what: 'expression()', line: 5, kind: 'unknown' },
    ]);
  });
});

/** [what it is, the stylesheet, what's written] */
const KEPT: [string, string, string][] = [
  ['a rule', 'p{color:red}', 'p {\n  color: red !important;\n}'],
  ['!important written once', 'p { color: red !important }', 'p {\n  color: red !important;\n}'],
  ['! IMPORTANT, spaced', 'p { color: red ! IMPORTANT }', 'p {\n  color: red !important;\n}'],
  ['a custom property', 'p { --gap: 4px }', 'p {\n  --gap: 4px !important;\n}'],
  ['an escaped class', String.raw`.md\:flex { display: none }`, String.raw`.md\:flex {` + '\n  display: none !important;\n}'],
  ['an id starting with a digit', String.raw`#\31 23 { color: red }`, String.raw`#\31 23 {`],
  ['a media query', '@media (prefers-color-scheme: dark) { body { color: white } }', '@media (prefers-color-scheme: dark) {\n  body {\n    color: white !important;\n  }\n}'],
  ['a container query', '@container (min-width: 400px) { .card { padding: 2rem } }', '@container (min-width: 400px) {'],
  ['@supports selector()', '@supports selector(:has(a)) { a { color: red } }', '@supports selector(:has(a)) {'],
  ['@layer statement', '@layer base, theme;', '@layer base, theme;'],
  ['gradients', 'p { background: linear-gradient(to right, red, rgb(0 0 255 / 50%)) }', 'linear-gradient(to right, red, rgb(0 0 255 / 50%))'],
  ['color-mix', 'p { color: color-mix(in oklch, red 40%, blue) }', 'color-mix(in oklch, red 40%, blue)'],
  ['transforms', 'p { transform: translateX(10px) rotate(3deg) }', 'translateX(10px) rotate(3deg)'],
  ['calc and var', 'p { width: calc(100% - var(--gap, 8px)) }', 'calc(100% - var(--gap, 8px))'],
  ['a plain attr()', 'a::after { content: " (" attr(href) ")" }', 'attr(href)'],
  ['pseudo-classes', 'li:nth-child(2n + 1):not(.x, :hover)::before { content: "•" }', 'li:nth-child(2n + 1):not(.x, :hover)::before {'],
  ['nesting', 'p { color: red; &:hover { color: blue } }', '  &:hover {\n    color: blue !important;\n  }'],
  ['keyframes stay unimportant', '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }', '@keyframes fade {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}'],
  ['a local font', '@font-face { font-family: Mine; src: local("Inter"), local(Inter-Regular); }', 'src: local("Inter"), local(Inter-Regular);'],
  ['attribute selectors', 'a[href^="https:"] { color: green }', 'a[href^="https:"] {'],
  ['HTML comment markers around a rule', '<!-- p { color: red } -->', 'p {\n  color: red !important;\n}'],
  ['an unclosed block', '@media screen { p { color: red', '@media screen {\n  p {\n    color: red !important;\n  }\n}'],
  ['a comment between tokens', 'p { margin: 1px/**/2px }', 'margin: 1px/**/2px !important;'],
];

describe('sanitizeCss: what stays', () => {
  it.each(KEPT)('%s', (_what, input, written) => {
    const { css, removed } = sanitizeCss(input);
    expect(css).toContain(written);
    expect(removed).toEqual([]);
    expect(sanitizeCss(css).css).toBe(css);
  });

  it('keeps every preset whole', () => {
    for (const preset of EFFECT_PRESETS) {
      const { css, removed } = sanitizeCss(preset.css);
      expect(removed, preset.id).toEqual([]);
      expect(css.length, preset.id).toBeGreaterThan(preset.css.length / 2);
    }
  });

  it('leaves declarations alone without `important`', () => {
    expect(sanitizeCss('p { color: red }', { important: false }).css).toBe('p {\n  color: red;\n}');
  });
});

describe('sanitizeSelector', () => {
  it.each([
    ['#sidebar', '#sidebar'],
    ['div.cookie-banner', 'div.cookie-banner'],
    [String.raw`main > div:nth-of-type(2) > .w-1\/2`, String.raw`main > div:nth-of-type(2) > .w-1\/2`],
    ['p { color: red }', null],
    [`a { background: url(${EVIL}) } b`, null],
    [`a url(${EVIL})`, null],
    ['a; @import "x"', null],
    ['a }', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(sanitizeSelector(input)).toBe(expected);
  });
});

describe('compileEffects', () => {
  it('puts presets, then hidden elements, then your CSS, then Duet’s patches, and says what it left out of each', () => {
    const { css, removed, patches, unusable } = compileEffects({
      presets: ['body { max-width: 70ch }'],
      hidden: ['#ad', `a url(${EVIL})`],
      css: `h1 { color: red } body { background: url(${EVIL}) }`,
      // The second as you might edit it: a fetch on its second line.
      duet: ['h1 { color: green }', `p { color: blue }\nbody { background: image-set("${EVIL}" 1x) }`],
    });
    const order = ['max-width: 70ch', '#ad {', 'color: red', 'color: green', 'color: blue'].map((s) => css.indexOf(s));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(css).toContain('#ad {\n  display: none !important;\n}');
    expect(css).toContain('color: blue !important');
    expect(unusable).toEqual([`a url(${EVIL})`]);
    expect(removed.map((r) => r.what)).toEqual(['url()']);
    expect(patches.map((p) => p.map((r) => `${r.what} on line ${r.line}`))).toEqual([[], ['image-set() on line 2']]);
    expect(fetches(css)).toEqual([]);
  });

  it('can’t be broken out of by an unclosed part', () => {
    const { css } = compileEffects({ presets: [], hidden: [], css: '@media screen { p { color: red', duet: [`} } @import "${EVIL}"; q { color: blue }`] });
    expect(fetches(css)).toEqual([]);
    expect(verify(css)).toBe(true);
  });
});

describe('verify', () => {
  it.each([
    [`p { background: url(${EVIL}) }`, false],
    [String.raw`p { background: \75 rl(x) }`, false],
    [`@import "x";`, false],
    ['p { background:image-set("x" 1x) }', false],
    ['p { content: "a\n }', false],
    ['p:not(.a) { color: red }', true],
    ['p { color: rgb(1 2 3) }', true],
    ['p { color: foo(1) }', false],
  ])('%s', (css, ok) => {
    expect(verify(css)).toBe(ok);
  });
});

describe('serializeIdent', () => {
  it.each([
    ['plain', 'plain'],
    ['1st', String.raw`\31 st`],
    ['-1', String.raw`-\31 `],
    ['-', String.raw`\-`],
    ['md:flex', String.raw`md\:flex`],
    ['a b', String.raw`a\ b`],
    ['café', 'café'],
  ])('%s', (value, written) => {
    expect(serializeIdent(value)).toBe(written);
  });
});
