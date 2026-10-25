/**
 * Effects' sanitizer (ARCHITECTURE.md §9, decision D13). Every stylesheet an
 * Effect applies, yours, a preset's, a hidden element's or Duet's, comes
 * through here before it's used, in Effects' worker (worker.ts), never on main.
 *
 * It parses with the CSS Syntax spec's own algorithms (`@csstools/css-tokenizer`
 * and `@csstools/css-parser-algorithms`, MIT), the same tokenizing Chromium
 * does, so `\75 rl(x)` is a URL here as it is there. It then writes out only
 * what's allowed, token by token, and keeps nothing it didn't understand:
 *
 * - **Nothing that fetches:** URL tokens, `url()`, `src()`, `image()`,
 *   `image-set()`, `cross-fade()`, `element()` and `paint()`, with or without a
 *   vendor prefix; `@import` and `@namespace`; `@font-face` sources other than
 *   `local()`. A declaration with any of them is left out whole.
 * - **Known functions only** in values (colors, math, gradients, transforms,
 *   filters, shapes, easing, grid, `var()`, `env()`, a plain `attr()`), and
 *   pseudo-classes' own in selectors. A declaration with any other is left out.
 * - **Known at-rules only:** `@media`, `@supports`, `@container`, `@layer`,
 *   `@scope`, `@starting-style`, `@keyframes`, `@font-face`.
 * - **Every declaration in a style rule is made `!important`**, so your
 *   styles win over the page's own whatever their specificity or order (main
 *   inserts the sheet in the author origin, where it can be taken out again).
 *
 * What it writes is checked once more by tokenizing it again (`verify`): no
 * URL token and no fetching function or at-rule anywhere. If that ever fails,
 * nothing is used.
 *
 * Pure: no Electron, no DOM. Unit-tested with many hostile inputs.
 */
import { tokenize, TokenType, type CSSToken } from '@csstools/css-tokenizer';
import {
  isCommentNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseListOfComponentValues,
  type ComponentValue,
  type FunctionNode,
  type SimpleBlockNode,
} from '@csstools/css-parser-algorithms';

/** Bumped whenever what's allowed changes: saved stylesheets made by an older one are made again. */
export const SANITIZER_VERSION = 1;

/** What was left out, for the Effects card: a short name ("url()", "@import") and the line it was on. */
export interface Removal {
  what: string;
  line: number;
  /** `fetch`: it would load a file; `unknown`: Chord doesn't know it, so it can't vouch for it. */
  kind: 'fetch' | 'unknown';
}

export interface Sanitized {
  css: string;
  removed: Removal[];
}

/** Functions that load something, in any context, with or without a vendor prefix. */
const FETCHING_FUNCTIONS = new Set(['url', 'src', 'image', 'image-set', 'cross-fade', 'element', 'paint']);

/** At-rules that load something, or point at something that can. */
const FETCHING_AT_RULES = new Set(['import', 'namespace', 'document']);

/** Functions values may use (vendor prefixes are ignored when matching): none of them loads anything. */
const VALUE_FUNCTIONS = new Set([
  // Math and units
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp',
  'progress', 'calc-size', 'sibling-index', 'sibling-count',
  // Custom properties and conditions
  'var', 'env', 'attr', 'if', 'inherit',
  // Colors
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'contrast-color',
  // Gradients (images that are drawn, not fetched)
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', 'gradient',
  // Transforms
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  // Filters
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  // Easing, grid, shapes, motion paths
  'cubic-bezier', 'steps', 'linear', 'minmax', 'repeat', 'fit-content', 'inset', 'circle', 'ellipse', 'polygon', 'rect', 'xywh', 'path', 'shape', 'ray',
  // Counters, anchors, scroll-driven animations
  'counter', 'counters', 'anchor', 'anchor-size', 'scroll', 'view',
  // @supports, @container
  'selector', 'font-tech', 'font-format', 'style', 'scroll-state',
  // @font-face src, allowed there only
  'local',
]);

/** At-rules allowed, and what's inside each. */
const GROUP_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style']);
const ALLOWED_AT_RULES = new Set([...GROUP_RULES, 'keyframes', 'font-face']);

/** Properties that ran script in old engines: never written, whatever their value. */
const DENIED_PROPERTIES = new Set(['behavior', '-moz-binding', '-ms-behavior']);

const unprefixed = (name: string) => name.toLowerCase().replace(/^-(webkit|moz|ms|o)-/, '');

/* ---------- Writing tokens back out ---------- */

const hex = (code: number) => `\\${code.toString(16)} `;

/** CSSOM's "serialize an identifier" (what CSS.escape does). */
export function serializeIdent(value: string): string {
  let out = '';
  const chars = [...value];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const code = c.codePointAt(0)!;
    if (code === 0) out += '�';
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) out += hex(code);
    else if (i === 0 && code >= 0x30 && code <= 0x39) out += hex(code);
    else if (i === 1 && code >= 0x30 && code <= 0x39 && chars[0] === '-') out += hex(code);
    else if (i === 0 && c === '-' && chars.length === 1) out += '\\-';
    else if (code >= 0x80 || c === '-' || c === '_' || /[0-9A-Za-z]/.test(c)) out += c;
    else out += `\\${c}`;
  }
  return out;
}

/** A name after `#`: like an identifier, but it may start with a digit. */
function serializeName(value: string): string {
  let out = '';
  for (const c of value) {
    const code = c.codePointAt(0)!;
    if (code === 0) out += '�';
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) out += hex(code);
    else if (code >= 0x80 || c === '-' || c === '_' || /[0-9A-Za-z]/.test(c)) out += c;
    else out += `\\${c}`;
  }
  return out;
}

/** CSSOM's "serialize a string". */
export function serializeString(value: string): string {
  let out = '"';
  for (const c of value) {
    const code = c.codePointAt(0)!;
    if (code === 0) out += '�';
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) out += hex(code);
    else if (c === '"' || c === '\\') out += `\\${c}`;
    else out += c;
  }
  return `${out}"`;
}

/**
 * One token as it'll be written: its own text where it has no escapes (so
 * neighbours tokenize exactly as before), else made again from its value.
 * Null for what's never written: URLs, broken strings and URLs, a lone `\`.
 */
function tokenText(t: CSSToken): string | null {
  const raw = t[1];
  const plain = !raw.includes('\\');
  switch (t[0]) {
    case TokenType.Ident:
      return plain ? raw : serializeIdent(t[4].value);
    case TokenType.Function:
      return `${plain ? raw.slice(0, -1) : serializeIdent(t[4].value)}(`;
    case TokenType.AtKeyword:
      return `@${plain ? raw.slice(1) : serializeIdent(t[4].value)}`;
    case TokenType.Hash:
      // An id's hash (`#main`) stays one, so it still selects; a color's may start with a digit.
      return plain ? raw : `#${t[4].type === 'id' ? serializeIdent(t[4].value) : serializeName(t[4].value)}`;
    case TokenType.String:
      return plain && !/[\n\r\f]/.test(raw) ? raw : serializeString(t[4].value);
    case TokenType.Number:
    case TokenType.Percentage:
    case TokenType.Dimension:
    case TokenType.UnicodeRange:
      // An escape in a number's unit is never needed; written again, `1\65 3` could become another number.
      return plain ? raw : null;
    case TokenType.Delim:
      return t[4].value === '\\' ? null : raw;
    case TokenType.Colon:
    case TokenType.Semicolon:
    case TokenType.Comma:
    case TokenType.OpenParen:
    case TokenType.CloseParen:
    case TokenType.OpenSquare:
    case TokenType.CloseSquare:
    case TokenType.OpenCurly:
    case TokenType.CloseCurly:
      return raw;
    case TokenType.Whitespace:
      return ' ';
    default:
      // URL, bad URL, bad string, comments, CDO/CDC, EOF.
      return null;
  }
}

/** Builds a line: whitespace runs become one space; a comment between two tokens stays as an empty one, so they don't run together. */
class Line {
  private parts: string[] = [];
  private lastSpace = true;
  private separate = false;

  space(): void {
    if (!this.lastSpace) this.parts.push(' ');
    this.lastSpace = true;
    this.separate = false;
  }

  comment(): void {
    if (!this.lastSpace) this.separate = true;
  }

  text(text: string): void {
    if (this.separate) this.parts.push('/**/');
    this.separate = false;
    this.parts.push(text);
    this.lastSpace = false;
  }

  toString(): string {
    return this.parts.join('').trim();
  }
}

/* ---------- Checking component values ---------- */

interface Walk {
  /** Selectors and at-rule preludes: a function right after a colon is a pseudo-class's own. */
  pseudo: boolean;
  /** @font-face's src: `local()` is allowed there, and only there. */
  local: boolean;
  /** Selectors: no semicolons or `{}` blocks inside. */
  selector: boolean;
  /** Where the source's lines start, for what's reported. */
  lines: number[];
  removed: Removal[];
}

const lineOf = (lines: readonly number[], offset: number): number => {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const firstOffset = (v: ComponentValue): number => {
  const t = v.tokens()[0];
  return t ? t[2] : 0;
};

const report = (walk: Walk, what: string, kind: Removal['kind'], offset: number) => {
  const line = lineOf(walk.lines, Math.max(0, offset));
  if (!walk.removed.some((r) => r.what === what && r.line === line)) walk.removed.push({ what, line, kind });
};

const isToken = (v: ComponentValue | undefined, type: TokenType): boolean => Boolean(v && isTokenNode(v) && v.value[0] === type);

/** `attr()` as it has always been: a name, and maybe a fallback. Typed `attr()` (`type(<url>)`, units) is left out. */
function plainAttr(fn: FunctionNode): boolean {
  const args = fn.value.filter((v) => !isWhitespaceNode(v) && !isCommentNode(v));
  if (args.length === 0 || !isToken(args[0], TokenType.Ident)) return false;
  return args.length === 1 || isToken(args[1], TokenType.Comma);
}

/**
 * Writes component values onto `line`, or returns false (and reports why) if
 * any of them isn't allowed here. Nothing is written for a refused value: the
 * caller drops the whole declaration, selector or rule.
 */
function writeValues(values: readonly ComponentValue[], walk: Walk, line: Line): boolean {
  let previous: ComponentValue | undefined;
  for (const v of values) {
    if (isWhitespaceNode(v)) {
      line.space();
      continue;
    }
    if (isCommentNode(v)) {
      line.comment();
      continue;
    }
    if (isFunctionNode(v)) {
      const name = unprefixed(v.getName());
      if (FETCHING_FUNCTIONS.has(name)) {
        report(walk, `${name}()`, 'fetch', firstOffset(v));
        return false;
      }
      const pseudo = walk.pseudo && isToken(previous, TokenType.Colon);
      const allowed = pseudo || (VALUE_FUNCTIONS.has(name) && (name !== 'local' || walk.local) && (name !== 'attr' || plainAttr(v)));
      if (!allowed) {
        report(walk, name === 'attr' ? 'attr() with a type' : `${name}()`, 'unknown', firstOffset(v));
        return false;
      }
      const head = tokenText(v.name);
      if (head === null) return false;
      line.text(head);
      if (!writeValues(v.value, walk, line)) return false;
      line.text(')');
      previous = v;
      continue;
    }
    if (isSimpleBlockNode(v)) {
      const open = v.startToken[0];
      if (walk.selector && open === TokenType.OpenCurly) return false;
      line.text(open === TokenType.OpenParen ? '(' : open === TokenType.OpenSquare ? '[' : '{');
      if (!writeValues(v.value, walk, line)) return false;
      line.text(open === TokenType.OpenParen ? ')' : open === TokenType.OpenSquare ? ']' : '}');
      previous = v;
      continue;
    }
    // A single token.
    const t = (v as { value: CSSToken }).value;
    switch (t[0]) {
      case TokenType.URL:
      case TokenType.BadURL:
        report(walk, 'url()', 'fetch', t[2]);
        return false;
      case TokenType.BadString:
        report(walk, 'a string that never ends', 'unknown', t[2]);
        return false;
      case TokenType.CDO:
      case TokenType.CDC:
        line.space();
        continue;
      case TokenType.AtKeyword:
      case TokenType.CloseParen:
      case TokenType.CloseSquare:
      case TokenType.CloseCurly:
      case TokenType.OpenCurly:
        // Out of place in a value or a selector: a sign it was meant to break out of one.
        return false;
      case TokenType.Semicolon:
        if (walk.selector) return false;
        break;
      default:
        break;
    }
    const text = tokenText(t);
    if (text === null) return false;
    line.text(text);
    previous = v;
  }
  return true;
}

/* ---------- Rules ---------- */

interface Declaration {
  type: 'decl';
  name: CSSToken;
  value: ComponentValue[];
  at: number;
}
interface QualifiedRule {
  type: 'rule';
  prelude: ComponentValue[];
  block: SimpleBlockNode;
  at: number;
}
interface AtRule {
  type: 'at';
  name: CSSToken;
  prelude: ComponentValue[];
  block: SimpleBlockNode | null;
  at: number;
}
type Item = Declaration | QualifiedRule | AtRule;

const isCurlyBlock = (v: ComponentValue | undefined): v is SimpleBlockNode => Boolean(v && isSimpleBlockNode(v) && v.startToken[0] === TokenType.OpenCurly);
const skippable = (v: ComponentValue) => isWhitespaceNode(v) || isCommentNode(v);

/** `name :` ahead: a declaration, unless a `{}` block comes before its `;` (then it's a nested rule, `a:hover { }`). */
function colonAfter(values: readonly ComponentValue[], i: number): number {
  let j = i + 1;
  while (j < values.length && skippable(values[j]!)) j++;
  return isToken(values[j], TokenType.Colon) ? j : -1;
}

/**
 * The CSS Syntax spec's rule-level parsing over component values: at-rules,
 * qualified rules and (inside blocks, `nested`) declarations and nested rules.
 */
function parseItems(values: readonly ComponentValue[], nested: boolean): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i]!;
    if (skippable(v) || isToken(v, TokenType.Semicolon) || isToken(v, TokenType.CDO) || isToken(v, TokenType.CDC)) {
      i++;
      continue;
    }
    if (isTokenNode(v) && v.value[0] === TokenType.AtKeyword) {
      const prelude: ComponentValue[] = [];
      let block: SimpleBlockNode | null = null;
      let j = i + 1;
      for (; j < values.length; j++) {
        const w = values[j]!;
        if (isToken(w, TokenType.Semicolon)) {
          j++;
          break;
        }
        if (isCurlyBlock(w)) {
          block = w;
          j++;
          break;
        }
        prelude.push(w);
      }
      items.push({ type: 'at', name: v.value, prelude, block, at: v.value[2] });
      i = j;
      continue;
    }
    if (nested && isTokenNode(v) && v.value[0] === TokenType.Ident) {
      const colon = colonAfter(values, i);
      if (colon > 0) {
        const custom = (v.value[4] as { value: string }).value.startsWith('--');
        let j = colon + 1;
        let block = false;
        for (; j < values.length; j++) {
          const w = values[j]!;
          if (isToken(w, TokenType.Semicolon)) break;
          if (!custom && isCurlyBlock(w)) {
            block = true;
            break;
          }
        }
        if (!block) {
          items.push({ type: 'decl', name: v.value, value: values.slice(colon + 1, j), at: v.value[2] });
          i = j + 1;
          continue;
        }
      }
    }
    // A qualified rule (a style rule, a keyframe), up to its block. Inside a block a `;` first means it was a broken declaration.
    const prelude: ComponentValue[] = [];
    let block: SimpleBlockNode | null = null;
    let j = i;
    for (; j < values.length; j++) {
      const w = values[j]!;
      if (isCurlyBlock(w)) {
        block = w;
        j++;
        break;
      }
      if (nested && isToken(w, TokenType.Semicolon)) {
        j++;
        break;
      }
      prelude.push(w);
    }
    if (block) items.push({ type: 'rule', prelude, block, at: firstOffset(v) });
    i = j;
  }
  return items;
}

/** Where an item sits, which decides what may be inside it. */
type Context = 'top' | 'group' | 'style' | 'keyframes' | 'keyframe' | 'font-face';

interface Options {
  /** Make every declaration in a style rule `!important` (Effects always do). */
  important: boolean;
}

/** A declaration's value without a trailing `!important`, and whether it had one. */
function splitImportant(value: readonly ComponentValue[]): { value: ComponentValue[]; important: boolean } {
  const list = [...value];
  while (list.length && skippable(list.at(-1)!)) list.pop();
  const last = list.at(-1);
  if (last && isTokenNode(last) && last.value[0] === TokenType.Ident && (last.value[4] as { value: string }).value.toLowerCase() === 'important') {
    let k = list.length - 2;
    while (k >= 0 && skippable(list[k]!)) k--;
    const bang = list[k];
    if (bang && isTokenNode(bang) && bang.value[0] === TokenType.Delim && (bang.value[4] as { value: string }).value === '!') {
      return { value: list.slice(0, k), important: true };
    }
  }
  return { value: list, important: false };
}

const indent = (depth: number) => '  '.repeat(depth);

function writeDeclaration(d: Declaration, context: Context, options: Options, walk: Walk, depth: number): string | null {
  const name = (d.name[4] as { value: string }).value;
  const lower = name.startsWith('--') ? name : name.toLowerCase();
  if (DENIED_PROPERTIES.has(lower)) {
    report(walk, lower, 'unknown', d.at);
    return null;
  }
  const head = tokenText(d.name);
  if (head === null) return null;
  const { value, important } = splitImportant(d.value);
  const fontSource = context === 'font-face' && lower === 'src';
  const line = new Line();
  const ok = writeValues(value, { ...walk, pseudo: false, selector: false, local: fontSource }, line);
  if (!ok) {
    if (fontSource) report(walk, '@font-face src', 'fetch', d.at);
    return null;
  }
  const text = line.toString();
  // A font's sources only from this computer: every source a local().
  if (fontSource && !value.filter((v) => !skippable(v) && !isToken(v, TokenType.Comma)).every((v) => isFunctionNode(v) && unprefixed(v.getName()) === 'local')) {
    report(walk, '@font-face src', 'fetch', d.at);
    return null;
  }
  if (!text) return null;
  const bang = (options.important && context === 'style') || important ? ' !important' : '';
  return `${indent(depth)}${head}: ${text}${bang};`;
}

/** A selector list or an at-rule's prelude, written out; null if it can't be. */
function writePrelude(prelude: readonly ComponentValue[], walk: Walk, selector: boolean): string | null {
  const line = new Line();
  return writeValues(prelude, { ...walk, pseudo: true, selector, local: false }, line) ? line.toString() : null;
}

/** A keyframe's selector: `from`, `to`, percentages and commas. */
function keyframeSelector(prelude: readonly ComponentValue[]): string | null {
  const parts: string[] = [];
  for (const v of prelude) {
    if (skippable(v)) continue;
    if (!isTokenNode(v)) return null;
    const t = v.value;
    if (t[0] === TokenType.Percentage || t[0] === TokenType.Comma) parts.push(t[1]);
    else if (t[0] === TokenType.Ident && /^(from|to)$/i.test(t[4].value)) parts.push(t[4].value.toLowerCase());
    else return null;
  }
  const text = parts.join(' ').replace(/ ,/g, ',');
  return text || null;
}

function writeItems(items: readonly Item[], context: Context, options: Options, walk: Walk, depth: number): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = writeItem(item, context, options, walk, depth);
    if (text) out.push(text);
  }
  return out;
}

function block(head: string, body: readonly string[], depth: number): string | null {
  return body.length ? `${indent(depth)}${head} {\n${body.join('\n')}\n${indent(depth)}}` : null;
}

function writeItem(item: Item, context: Context, options: Options, walk: Walk, depth: number): string | null {
  if (item.type === 'decl') {
    // Declarations belong in style rules, keyframes, @font-face, and group rules nested in a style rule.
    if (context === 'top' || context === 'group' || context === 'keyframes') return null;
    return writeDeclaration(item, context, options, walk, depth);
  }
  if (item.type === 'rule') {
    if (context === 'font-face' || context === 'keyframe') return null;
    if (context === 'keyframes') {
      const selector = keyframeSelector(item.prelude);
      return selector ? block(selector, writeItems(parseItems(item.block.value, true), 'keyframe', options, walk, depth + 1), depth) : null;
    }
    const selector = writePrelude(item.prelude, walk, true);
    if (!selector) return null;
    return block(selector, writeItems(parseItems(item.block.value, true), 'style', options, walk, depth + 1), depth);
  }
  const name = (item.name[4] as { value: string }).value.toLowerCase();
  const plain = name === '-webkit-keyframes' ? 'keyframes' : name;
  if (!ALLOWED_AT_RULES.has(plain)) {
    report(walk, `@${name}`, FETCHING_AT_RULES.has(plain) ? 'fetch' : 'unknown', item.at);
    return null;
  }
  if (context === 'keyframes' || context === 'keyframe' || context === 'font-face') return null;
  const head = tokenText(item.name);
  if (head === null) return null;
  if (plain === 'font-face' || plain === 'keyframes') {
    // At the top or in a group rule only, never inside a style rule.
    if (context === 'style') return null;
    if (plain === 'font-face' && item.prelude.some((v) => !skippable(v))) return null;
    if (plain === 'keyframes' && !item.prelude.filter((v) => !skippable(v)).every((v) => isToken(v, TokenType.Ident) || isToken(v, TokenType.String))) return null;
    if (!item.block) return null;
    const prelude = plain === 'keyframes' ? writePrelude(item.prelude, walk, false) : '';
    if (prelude === null) return null;
    const inner = writeItems(parseItems(item.block.value, true), plain === 'font-face' ? 'font-face' : 'keyframes', options, walk, depth + 1);
    return block(prelude ? `${head} ${prelude}` : head, inner, depth);
  }
  // Group rules: @media, @supports, @container, @layer, @scope, @starting-style.
  const prelude = writePrelude(item.prelude, walk, false);
  if (prelude === null) return null;
  const lead = prelude ? `${head} ${prelude}` : head;
  if (!item.block) {
    // Only @layer has a statement form (`@layer base, theme;`).
    return plain === 'layer' && prelude ? `${indent(depth)}${lead};` : null;
  }
  const inner = writeItems(parseItems(item.block.value, true), context === 'style' ? 'style' : 'group', options, walk, depth + 1);
  return block(lead, inner, depth);
}

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
};

/** A stylesheet with only what's allowed in it, and what was left out. */
export function sanitizeCss(input: string, options: Options = { important: true }): Sanitized {
  const removed: Removal[] = [];
  const tokens = tokenize({ css: input });
  const values = parseListOfComponentValues(tokens);
  const walk: Walk = { pseudo: false, local: false, selector: false, lines: lineStarts(input), removed };
  const css = writeItems(parseItems(values, false), 'top', options, walk, 0).join('\n');
  if (!verify(css)) return { css: '', removed: [{ what: 'everything', line: 1, kind: 'fetch' }] };
  return { css, removed };
}

/** A selector from the picker, written out as one; null if it isn't one Chord can vouch for. */
export function sanitizeSelector(selector: string): string | null {
  if (selector.length > 1000) return null;
  const values = parseListOfComponentValues(tokenize({ css: selector }));
  const text = writePrelude(values, { pseudo: true, local: false, selector: true, lines: [0], removed: [] }, true);
  return text && verify(`${text} {}`) ? text : null;
}

/**
 * The last check, on what's about to be used: tokenized again as Chromium
 * would, no URL token, no broken string or URL, no fetching function and only
 * allowed at-rules, anywhere. A function that isn't a known value function
 * must sit right after a colon (a pseudo-class's own): values are always
 * written with a space after their colon, so none can pass that way.
 */
export function verify(css: string): boolean {
  const tokens = tokenize({ css });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t[0]) {
      case TokenType.URL:
      case TokenType.BadURL:
      case TokenType.BadString:
        return false;
      case TokenType.AtKeyword: {
        const name = t[4].value.toLowerCase();
        if (!ALLOWED_AT_RULES.has(name === '-webkit-keyframes' ? 'keyframes' : name)) return false;
        break;
      }
      case TokenType.Function: {
        const name = unprefixed(t[4].value);
        if (FETCHING_FUNCTIONS.has(name)) return false;
        if (!VALUE_FUNCTIONS.has(name) && tokens[i - 1]?.[0] !== TokenType.Colon) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

/** What makes up a site's stylesheet, in the order it's applied: later wins. */
export interface EffectsParts {
  /** The presets' own CSS. */
  presets: readonly string[];
  /** Selectors of elements you hid. */
  hidden: readonly string[];
  css: string;
  /** Duet's patches, oldest first. */
  duet: readonly string[];
}

export interface Compiled {
  css: string;
  /** What was left out of your CSS. */
  removed: Removal[];
  /** Hidden elements whose selector couldn't be used. */
  unusable: string[];
}

/**
 * A site's one stylesheet: each part sanitized on its own (none can leave a
 * block open for the next), then checked once more as a whole.
 */
export function compileEffects(parts: EffectsParts): Compiled {
  const chunks: string[] = [];
  for (const preset of parts.presets) chunks.push(sanitizeCss(preset).css);
  const unusable: string[] = [];
  for (const selector of parts.hidden) {
    const clean = sanitizeSelector(selector);
    if (clean) chunks.push(`${clean} {\n  display: none !important;\n}`);
    else unusable.push(selector);
  }
  const own = sanitizeCss(parts.css);
  chunks.push(own.css);
  for (const patch of parts.duet) chunks.push(sanitizeCss(patch).css);
  const css = chunks.filter(Boolean).join('\n');
  if (!verify(css)) return { css: '', removed: [{ what: 'everything', line: 1, kind: 'fetch' }], unusable };
  return { css, removed: own.removed, unusable };
}
