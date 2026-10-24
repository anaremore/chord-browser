/**
 * Reader view (ARCHITECTURE.md §9, DESIGN.md §7.11): a page's article in
 * Chord's own typography. Mozilla's Readability finds the article in the
 * page's renderer, in Chord's isolated world, and sends it to main as a
 * small tree (`RawNode`s). The page wrote everything in it, so all of it is
 * untrusted: `sanitizeArticle` keeps what the reader shows, from an
 * allow-list (text, headings, paragraphs, lists, quotes, code, tables,
 * figures, images and links), and drops the rest. What comes out has no
 * element, attribute or address outside that list: nothing in it can run a
 * script, style the reader, submit a form or load anything but the
 * article's own images, which the reader asks main for by number.
 */

// Core compiles without DOM types; URL is a global in Node and every browser.
interface URL {
  protocol: string;
  hostname: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  href: string;
}
declare const URL: new (url: string, base?: URL) => URL;

export type ReaderTheme = 'chord' | 'light' | 'dark' | 'sepia';
export type ReaderWidth = 'narrow' | 'medium' | 'wide';
export type ReaderFont = 'sans' | 'serif';

/** The reader's controls, remembered for every page (Settings keeps them). */
export interface ReaderSettings {
  /** Text size: a step from 0 (smallest) to READER_SIZES − 1. */
  size: number;
  width: ReaderWidth;
  theme: ReaderTheme;
  font: ReaderFont;
}

/** How many text sizes the reader has (tokens' READER_TYPE has one per step). */
export const READER_SIZES = 6;
export const READER_THEMES = ['chord', 'light', 'dark', 'sepia'] as const satisfies readonly ReaderTheme[];
export const READER_WIDTHS = ['narrow', 'medium', 'wide'] as const satisfies readonly ReaderWidth[];
export const READER_FONTS = ['sans', 'serif'] as const satisfies readonly ReaderFont[];

export const DEFAULT_READER: ReaderSettings = { size: 2, width: 'medium', theme: 'chord', font: 'sans' };

/** `current` with the sensible parts of `patch` applied (the reducer and restore both use it). */
export function cleanReaderSettings(current: ReaderSettings, patch: unknown): ReaderSettings {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const one = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
  const size = typeof p['size'] === 'number' && Number.isInteger(p['size']) ? Math.min(READER_SIZES - 1, Math.max(0, p['size'])) : current.size;
  return {
    size,
    width: one(p['width'], READER_WIDTHS, current.width),
    theme: one(p['theme'], READER_THEMES, current.theme),
    font: one(p['font'], READER_FONTS, current.font),
  };
}

/** Only web pages have an article to show. */
export const isReaderUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** What the page's script sends. Untrusted: any shape at all may arrive. */
export type RawNode = string | { tag: string; attrs?: Record<string, string>; children?: RawNode[] };

/** Every element the reader shows. */
export type ReaderTag =
  | 'p'
  | 'div'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'ul'
  | 'ol'
  | 'li'
  | 'dl'
  | 'dt'
  | 'dd'
  | 'blockquote'
  | 'pre'
  | 'figure'
  | 'figcaption'
  | 'table'
  | 'caption'
  | 'thead'
  | 'tbody'
  | 'tfoot'
  | 'tr'
  | 'th'
  | 'td'
  | 'hr'
  | 'br'
  | 'wbr'
  | 'a'
  | 'em'
  | 'strong'
  | 'b'
  | 'i'
  | 'u'
  | 's'
  | 'del'
  | 'ins'
  | 'mark'
  | 'small'
  | 'sub'
  | 'sup'
  | 'code'
  | 'kbd'
  | 'samp'
  | 'var'
  | 'abbr'
  | 'cite'
  | 'q'
  | 'dfn'
  | 'time'
  | 'bdi'
  | 'bdo'
  | 'img';

export interface ReaderElement {
  tag: ReaderTag;
  attrs?: Readonly<Record<string, string>>;
  children?: ReaderNode[];
}

export type ReaderNode = string | ReaderElement;

/** An article, as the reader shows it. */
export interface ReaderArticle {
  title: string;
  /** Who wrote it, as the page says ("By Jane Doe"); empty when it doesn't. */
  byline: string;
  /** The site's own name, or its address's host. */
  site: string;
  lang: string | null;
  dir: 'ltr' | 'rtl' | null;
  /** The page it came from. */
  url: string;
  /** Words in the article, for "8 min read". */
  words: number;
  content: ReaderNode[];
  /** The article's images: an img's `src` is its index here (main fetches them, through the tab's session). */
  images: string[];
}

export const READER_TAGS: ReadonlySet<ReaderTag> = new Set<ReaderTag>([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'br', 'wbr', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'del',
  'ins', 'mark', 'small', 'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time', 'bdi', 'bdo', 'img',
]);

/** Gone with everything inside: code, styles, embedded content, forms and media the reader doesn't play. */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'svg', 'math', 'canvas',
  'video', 'audio', 'source', 'track', 'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'meter',
  'progress', 'dialog', 'head', 'title', 'meta', 'link', 'base', 'slot', 'portal', 'map', 'area', 'colgroup', 'col', 'fencedframe',
]);

/** Elements the reader shows as another: containers as plain blocks, `tt` as code. Anything else unknown gives way to its children. */
const ALIASES: Readonly<Record<string, ReaderTag>> = {
  section: 'div',
  article: 'div',
  main: 'div',
  header: 'div',
  footer: 'div',
  aside: 'div',
  nav: 'div',
  center: 'div',
  details: 'div',
  hgroup: 'div',
  address: 'div',
  fieldset: 'div',
  summary: 'p',
  tt: 'code',
  strike: 's',
};

/** Attributes each element keeps, besides `id`, `dir` and `lang`. */
const ATTRS: Partial<Record<ReaderTag, readonly string[]>> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  abbr: ['title'],
  dfn: ['title'],
  time: ['datetime'],
};
const GLOBAL_ATTRS = ['id', 'dir', 'lang'];

/**
 * The article's ids and in-page links get this in front, so a page can't
 * name an element the reader's own code looks up.
 */
export const READER_ANCHOR_PREFIX = 'r-';

/** How much of a page the reader takes: enough for any article, and a bound on what a hostile page can make main walk. */
const LIMITS = { nodes: 60_000, depth: 48, text: 2_000_000, images: 500, url: 8192 } as const;
/** Less text than this isn't an article. */
const MIN_TEXT = 200;

const CONTROL = /\p{Cc}/gu;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,4}$/;
const ANCHOR = /^[\w:.-]{1,100}$/;
const HEADING = /^h[1-6]$/;

interface Walk {
  page: URL;
  nodes: number;
  text: number;
  images: string[];
  imageIndex: Map<string, number>;
}

/** Where a node sits: the nearest element kept around it, and whether that's inside a link or preformatted text. */
interface Scope {
  parent: ReaderTag | 'root';
  link: boolean;
}

/** One line of text, as an attribute or a field gives it: no control characters, spaces collapsed. */
function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function integer(value: string, min: number, max: number): string | null {
  if (!/^-?\d{1,7}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= min && n <= max ? String(n) : null;
}

function parseHttp(url: string, base?: URL): URL | null {
  if (url.length > LIMITS.url) return null;
  try {
    const parsed = base ? new URL(url, base) : new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function anchor(id: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null;
  }
  return ANCHOR.test(decoded) ? `${READER_ANCHOR_PREFIX}${decoded}` : null;
}

/** A link's address: the web (http and https) or a place in the article; never `javascript:`, `data:` or anything else. */
function safeHref(value: string, page: URL): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('#')) {
    const id = anchor(v.slice(1));
    return id ? `#${id}` : null;
  }
  const url = parseHttp(v, page);
  if (!url) return null;
  // A link to a place in this very page stays in the reader.
  if (url.hash && url.origin === page.origin && url.pathname === page.pathname && url.search === page.search) {
    const id = anchor(url.hash.slice(1));
    return id ? `#${id}` : null;
  }
  return url.href;
}

function cleanAttrs(tag: ReaderTag, attrs: Record<string, string>, walk: Walk): Record<string, string> | null {
  const allowed = ATTRS[tag] ?? [];
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(attrs)) {
    const name = rawName.toLowerCase();
    if (!GLOBAL_ATTRS.includes(name) && !allowed.includes(name)) continue;
    let clean: string | null = null;
    switch (name) {
      case 'href':
        clean = safeHref(value, walk.page);
        break;
      case 'src': {
        // An empty address would be the page itself.
        const url = value.trim() ? parseHttp(value.trim(), walk.page) : null;
        if (!url) break;
        let index = walk.imageIndex.get(url.href);
        if (index === undefined && walk.images.length < LIMITS.images) {
          index = walk.images.push(url.href) - 1;
          walk.imageIndex.set(url.href, index);
        }
        clean = index === undefined ? null : String(index);
        break;
      }
      case 'alt':
        clean = line(value, 1000);
        break;
      case 'title':
        clean = line(value, 300) || null;
        break;
      case 'width':
      case 'height':
        clean = integer(value, 1, 10_000);
        break;
      case 'start':
      case 'value':
        clean = integer(value, -1_000_000, 1_000_000);
        break;
      case 'reversed':
        clean = '';
        break;
      case 'type':
        clean = /^[1aAiI]$/.test(value) ? value : null;
        break;
      case 'colspan':
        clean = integer(value, 1, 100);
        break;
      case 'rowspan':
        clean = integer(value, 1, 1000);
        break;
      case 'scope':
        clean = ['row', 'col', 'rowgroup', 'colgroup'].includes(value) ? value : null;
        break;
      case 'datetime':
        clean = line(value, 64) || null;
        break;
      case 'dir':
        clean = ['ltr', 'rtl', 'auto'].includes(value.toLowerCase()) ? value.toLowerCase() : null;
        break;
      case 'lang':
        clean = LANG.test(value.trim()) ? value.trim() : null;
        break;
      case 'id':
        clean = anchor(value.trim());
        break;
    }
    if (clean !== null) out[name] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** An element's own string attributes (anything else in the bag is ignored). */
function attrsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) if (typeof v === 'string' && name.length <= 32) out[name] = v;
  return out;
}

/** Which elements may stand where: anything misplaced becomes a plain block, as a browser would show it. */
function placed(tag: ReaderTag, parent: Scope['parent']): ReaderTag {
  switch (tag) {
    case 'li':
      return parent === 'ul' || parent === 'ol' ? tag : 'div';
    case 'dt':
    case 'dd':
      return parent === 'dl' ? tag : 'div';
    case 'caption':
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return parent === 'table' ? tag : 'div';
    case 'tr':
      return parent === 'table' || parent === 'thead' || parent === 'tbody' || parent === 'tfoot' ? tag : 'div';
    case 'td':
    case 'th':
      return parent === 'tr' ? tag : 'div';
    case 'figcaption':
      return parent === 'figure' ? tag : 'p';
    default:
      return tag;
  }
}

const isBlank = (node: ReaderNode) => typeof node === 'string' && !node.trim();

/** Text-only content, and whether a link would have anything to name it (its text, or an image's description). */
function textOf(nodes: readonly ReaderNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') out += node;
    else if (node.tag === 'img') out += node.attrs?.['alt'] ? ` ${node.attrs['alt']} ` : '';
    else if (node.children) out += textOf(node.children);
  }
  return out;
}

/**
 * The children a list, a definition list or a table may have: what else is
 * in it goes into an item (a list's, a row's) or, in a table, goes.
 */
function fit(parent: Scope['parent'], nodes: ReaderNode[]): ReaderNode[] {
  const wrap = (keep: readonly ReaderTag[], into: ReaderTag | null) => {
    const out: ReaderNode[] = [];
    let loose: ReaderNode[] = [];
    const flush = () => {
      if (into && loose.some((n) => !isBlank(n))) out.push({ tag: into, children: loose });
      loose = [];
    };
    for (const node of nodes) {
      if (typeof node !== 'string' && keep.includes(node.tag)) {
        flush();
        out.push(node);
      } else loose.push(node);
    }
    flush();
    return out;
  };
  switch (parent) {
    case 'ul':
    case 'ol':
      return wrap(['li'], 'li');
    case 'dl':
      return wrap(['dt', 'dd'], 'dd');
    case 'table':
      return wrap(['caption', 'thead', 'tbody', 'tfoot', 'tr'], null);
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return wrap(['tr'], null);
    case 'tr':
      return wrap(['td', 'th'], 'td');
    default:
      return nodes;
  }
}

/** Neighboring text joins up. */
function merge(nodes: ReaderNode[]): ReaderNode[] {
  const out: ReaderNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (typeof node === 'string' && typeof last === 'string') out[out.length - 1] = last + node;
    else out.push(node);
  }
  return out;
}

/** Elements that are nothing without something inside. */
const NEEDS_CONTENT = new Set<ReaderTag>([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption', 'table',
  'caption', 'thead', 'tbody', 'tfoot', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'code', 'kbd',
  'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time', 'bdi', 'bdo',
]);
const EMPTY = new Set<ReaderTag>(['br', 'hr', 'wbr', 'img']);

function cleanChildren(children: unknown, scope: Scope, depth: number, walk: Walk): ReaderNode[] {
  if (!Array.isArray(children)) return [];
  const out: ReaderNode[] = [];
  for (const child of children) {
    if (walk.nodes >= LIMITS.nodes || walk.text >= LIMITS.text) break;
    out.push(...cleanNode(child, scope, depth, walk));
  }
  return out;
}

function cleanNode(node: unknown, scope: Scope, depth: number, walk: Walk): ReaderNode[] {
  walk.nodes++;
  if (typeof node === 'string') {
    const text = node.replaceAll('\u0000', '').slice(0, LIMITS.text - walk.text);
    walk.text += text.length;
    return text ? [text] : [];
  }
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth >= LIMITS.depth) return [];
  const { tag: rawTag, attrs: rawAttrs, children } = node as { tag?: unknown; attrs?: unknown; children?: unknown };
  if (typeof rawTag !== 'string') return [];
  const name = rawTag.toLowerCase();
  const attrs = attrsOf(rawAttrs);
  // Hidden on the page is hidden here too.
  if (DROP.has(name) || 'hidden' in attrs) return [];
  let tag: ReaderTag | null = READER_TAGS.has(name as ReaderTag) ? (name as ReaderTag) : (ALIASES[name] ?? null);
  // A link inside a link isn't one: its text stays in the outer link.
  if (tag === 'a' && scope.link) tag = null;
  if (tag) tag = placed(tag, scope.parent);
  const inner: Scope = tag ? { parent: tag, link: scope.link || tag === 'a' } : scope;
  const kids = tag && EMPTY.has(tag) ? [] : merge(fit(inner.parent, cleanChildren(children, inner, depth + 1, walk)));
  // Unknown elements give way to what's inside them.
  if (!tag) return kids;
  const kept = cleanAttrs(tag, attrs, walk);
  if (tag === 'img') {
    if (kept?.['src'] === undefined) return [];
    return [{ tag, attrs: { alt: '', ...kept } }];
  }
  if (tag === 'a' && (kept?.['href'] === undefined || !textOf(kids).trim())) return kids;
  if (NEEDS_CONTENT.has(tag) && kids.every(isBlank)) return [];
  if (EMPTY.has(tag)) return [kept ? { tag, attrs: kept } : { tag }];
  return [{ tag, ...(kept ? { attrs: kept } : {}), children: kids }];
}

/**
 * The article's title is the reader's one top heading. Its own headings
 * start a level below and never skip one: the levels it uses, in order,
 * become h2, h3 and so on (h6 at most).
 */
function levelHeadings(content: ReaderNode[]): void {
  const used = new Set<number>();
  const visit = (nodes: readonly ReaderNode[], each: (el: ReaderElement) => void) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      each(node);
      if (node.children) visit(node.children, each);
    }
  };
  visit(content, (el) => {
    if (HEADING.test(el.tag)) used.add(Number(el.tag[1]));
  });
  const levels = [...used].sort((a, b) => a - b);
  visit(content, (el) => {
    if (HEADING.test(el.tag)) el.tag = `h${Math.min(6, 2 + levels.indexOf(Number(el.tag[1])))}` as ReaderTag;
  });
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The article's first heading, when it only says the title again (looking inside the blocks it starts with). */
function dropRepeatedTitle(nodes: ReaderNode[], title: string): ReaderNode[] {
  const index = nodes.findIndex((n) => !isBlank(n));
  const first = nodes[index];
  if (!first || typeof first === 'string') return nodes;
  if (first.tag === 'div' && first.children) return nodes.map((n, i) => (i === index ? { ...first, children: dropRepeatedTitle(first.children!, title) } : n));
  if (HEADING.test(first.tag) && normalized(textOf(first.children ?? [])) === normalized(title)) return nodes.filter((_, i) => i !== index);
  return nodes;
}

/** Words in some text, for reading time. Chinese and Japanese, written without spaces, count about two characters a word. */
export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  const ideographs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return words + Math.round(ideographs / 2);
}

/** "8 min read": at about 230 words a minute, never under one. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}

/**
 * What the page's script found, as the reader may show it, or null when
 * there's no article in it (or it isn't a web page's).
 */
export function sanitizeArticle(raw: unknown, pageUrl: string): ReaderArticle | null {
  const page = parseHttp(pageUrl);
  if (!page || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const walk: Walk = { page, nodes: 0, text: 0, images: [], imageIndex: new Map() };
  const root = Array.isArray(r['content']) ? r['content'] : [r['content']];
  const site = line(r['siteName'], 100) || page.hostname.replace(/^www\./, '');
  const title = line(r['title'], 300) || site;
  let content = merge(cleanChildren(root, { parent: 'root', link: false }, 0, walk));
  content = dropRepeatedTitle(content, title);
  levelHeadings(content);
  const text = textOf(content);
  if (text.replace(/\s+/g, '').length < MIN_TEXT) return null;
  const lang = line(r['lang'], 35);
  const dir = r['dir'] === 'rtl' || r['dir'] === 'ltr' ? r['dir'] : null;
  return {
    title,
    byline: line(r['byline'], 200),
    site,
    lang: LANG.test(lang) ? lang : null,
    dir,
    url: page.href,
    words: countWords(text),
    content,
    images: walk.images,
  };
}
