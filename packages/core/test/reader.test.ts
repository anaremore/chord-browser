import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READER,
  READER_TAGS,
  apply,
  cleanReaderSettings,
  countWords,
  defaultSettings,
  emptyState,
  readingMinutes,
  restoreState,
  sanitizeArticle,
  type RawNode,
  type ReaderArticle,
  type ReaderNode,
  type State,
} from '../src';

const PAGE = 'https://news.example/2026/10/story?id=7';
const LONG = 'Readers came for the story and stayed for the details, which the page told at length and with care. '.repeat(4);

const el = (tag: string, attrs: Record<string, string> = {}, ...children: RawNode[]): RawNode => ({ tag, attrs, children });
const p = (...children: RawNode[]) => el('p', {}, ...children);

/** An article whose body is `nodes`, after enough plain text to count as one. */
function read(...nodes: RawNode[]): ReaderArticle {
  const article = sanitizeArticle({ title: 'Story', byline: 'By Jo', siteName: 'News', lang: 'en', dir: 'ltr', content: el('div', {}, p(LONG), ...nodes) }, PAGE);
  if (!article) throw new Error('no article');
  return article;
}

/** Every element anywhere in the content. */
function elements(nodes: readonly ReaderNode[]): Exclude<ReaderNode, string>[] {
  return nodes.flatMap((n) => (typeof n === 'string' ? [] : [n, ...elements(n.children ?? [])]));
}
const text = (nodes: readonly ReaderNode[]): string => nodes.map((n) => (typeof n === 'string' ? n : text(n.children ?? []))).join('');
const tags = (article: ReaderArticle) => elements(article.content).map((e) => e.tag);
const all = (article: ReaderArticle) => JSON.stringify(article.content);

describe('sanitizeArticle: what gets through', () => {
  it('keeps text, headings, lists, quotes, code, tables, figures, images and links', () => {
    const article = read(
      el('h2', {}, 'A heading'),
      el('ul', {}, el('li', {}, 'one'), el('li', {}, 'two')),
      el('ol', { start: '3', reversed: '', type: 'i' }, el('li', { value: '5' }, 'three')),
      el('blockquote', {}, p('Quoted ', el('q', {}, 'words'), '.')),
      el('pre', {}, el('code', {}, 'let x = 1;\n  x++;')),
      el('table', {}, el('caption', {}, 'Scores'), el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Team'))), el('tbody', {}, el('tr', {}, el('td', { colspan: '2' }, 'Red')))),
      el('figure', {}, el('img', { src: 'https://cdn.example/a.jpg', alt: 'A cat', width: '640', height: '480' }), el('figcaption', {}, 'The cat')),
      p('Read ', el('a', { href: 'https://other.example/x', title: 'More' }, 'more'), ', ', el('em', {}, 'now'), ' and ', el('strong', {}, 'here'), el('br'), el('abbr', { title: 'HyperText' }, 'HTML')),
      el('dl', {}, el('dt', {}, 'Term'), el('dd', {}, 'Meaning')),
      el('hr'),
    );
    expect(article.title).toBe('Story');
    expect(article.byline).toBe('By Jo');
    expect(article.site).toBe('News');
    expect(article.lang).toBe('en');
    expect(article.dir).toBe('ltr');
    expect(article.url).toBe(PAGE);
    for (const tag of ['h2', 'ul', 'ol', 'li', 'blockquote', 'q', 'pre', 'code', 'table', 'caption', 'thead', 'th', 'tbody', 'td', 'figure', 'img', 'figcaption', 'a', 'em', 'strong', 'br', 'abbr', 'dl', 'dt', 'dd', 'hr']) {
      expect(tags(article)).toContain(tag);
    }
    const img = elements(article.content).find((e) => e.tag === 'img')!;
    expect(img.attrs).toEqual({ src: '0', alt: 'A cat', width: '640', height: '480' });
    expect(article.images).toEqual(['https://cdn.example/a.jpg']);
    const link = elements(article.content).find((e) => e.tag === 'a')!;
    expect(link.attrs).toEqual({ href: 'https://other.example/x', title: 'More' });
    expect(elements(article.content).find((e) => e.tag === 'ol')!.attrs).toEqual({ start: '3', reversed: '', type: 'i' });
    expect(elements(article.content).find((e) => e.tag === 'td')!.attrs).toEqual({ colspan: '2' });
    // Preformatted text keeps its spaces and lines.
    expect(text(elements(article.content).find((e) => e.tag === 'pre')!.children!)).toBe('let x = 1;\n  x++;');
    expect(article.words).toBeGreaterThan(60);
  });

  it('only ever has allowed elements, whatever comes in', () => {
    const article = read(el('custom-thing', {}, el('blink', {}, 'old'), el('marquee', {}, 'moving'), el('span', { style: 'x' }, el('font', { color: 'red' }, 'kept text'))));
    for (const tag of tags(article)) expect(READER_TAGS.has(tag)).toBe(true);
    // Unknown elements give way to their text.
    expect(text(article.content)).toContain('oldmovingkept text');
  });

  it('resolves relative images and links against the page, and numbers each image once', () => {
    const article = read(p(el('img', { src: '/i/1.png' }), el('img', { src: 'https://news.example/i/1.png' }), el('img', { src: '2.png', alt: 'two' }), el('a', { href: '../old' }, 'old')));
    expect(article.images).toEqual(['https://news.example/i/1.png', 'https://news.example/2026/10/2.png']);
    expect(elements(article.content).filter((e) => e.tag === 'img').map((e) => e.attrs!['src'])).toEqual(['0', '0', '1']);
    // An image without a description is decoration to a screen reader.
    expect(elements(article.content).find((e) => e.tag === 'img')!.attrs!['alt']).toBe('');
    expect(elements(article.content).find((e) => e.tag === 'a')!.attrs!['href']).toBe('https://news.example/2026/old');
  });

  it("keeps links to places in the article, under the reader's own prefix", () => {
    const article = read(p(el('a', { href: '#fn1' }, 'note'), el('a', { href: `${PAGE}#sec-2` }, 'section'), el('sup', { id: 'fn1' }, '1'), el('a', { href: 'https://news.example/2026/10/story#x' }, 'other page')));
    const links = elements(article.content).filter((e) => e.tag === 'a').map((e) => e.attrs!['href']);
    expect(links).toEqual(['#r-fn1', '#r-sec-2', 'https://news.example/2026/10/story#x']);
    expect(elements(article.content).find((e) => e.tag === 'sup')!.attrs).toEqual({ id: 'r-fn1' });
  });

  it("makes the title the only top heading: the article's start a level below and never skip one", () => {
    const article = read(el('h1', {}, 'Big'), el('h4', {}, 'Small'), el('h6', {}, 'Tiny'), el('h4', {}, 'Small again'));
    expect(tags(article).filter((t) => /^h\d$/.test(t))).toEqual(['h2', 'h3', 'h4', 'h3']);
  });

  it('drops a first heading that only repeats the title', () => {
    const article = sanitizeArticle({ title: 'Story  Time', content: el('div', {}, el('h1', {}, 'story time'), p(LONG)) }, PAGE)!;
    expect(tags(article)).not.toContain('h2');
    expect(text(article.content)).not.toContain('story time');
  });

  it('puts what a list, a definition list or a table row holds into items, and misplaced items into blocks', () => {
    const article = read(
      el('ul', {}, ' ', el('p', {}, 'loose'), 'text', el('li', {}, 'item')),
      el('dl', {}, el('p', {}, 'loose')),
      el('table', {}, 'stray', el('tr', {}, el('p', {}, 'cell'))),
      el('li', {}, 'orphan'),
      el('td', {}, 'orphan cell'),
    );
    const ul = elements(article.content).find((e) => e.tag === 'ul')!;
    expect(ul.children!.map((c) => (typeof c === 'string' ? 'text' : c.tag))).toEqual(['li', 'li']);
    expect(elements(article.content).find((e) => e.tag === 'dl')!.children!.map((c) => (typeof c === 'string' ? 'text' : c.tag))).toEqual(['dd']);
    const table = elements(article.content).find((e) => e.tag === 'table')!;
    expect(text(table.children!)).not.toContain('stray');
    expect(elements(table.children!).map((e) => e.tag)).toEqual(['tr', 'td', 'p']);
    // Every li is in a list, every td in a row.
    const parents = new Map<string, string>();
    const walk = (nodes: readonly ReaderNode[], parent: string) => {
      for (const n of nodes) {
        if (typeof n === 'string') continue;
        if (n.tag === 'li' || n.tag === 'td') parents.set(`${n.tag}:${text(n.children ?? [])}`, parent);
        walk(n.children ?? [], n.tag);
      }
    };
    walk(article.content, 'root');
    for (const [, parent] of parents) expect(['ul', 'ol', 'tr']).toContain(parent);
  });

  it('drops empty blocks and links with nothing to name them', () => {
    const article = read(el('p', {}, '  '), el('div', {}), el('a', { href: 'https://x.example' }, el('img', { src: 'https://x.example/i.png' })), el('h3', {}, ''));
    expect(tags(article).filter((t) => t === 'a' || t === 'h2')).toEqual([]);
    expect(tags(article)).toContain('img');
    // An image with a description names its link.
    expect(tags(read(el('a', { href: 'https://x.example' }, el('img', { src: 'https://x.example/i.png', alt: 'Home' }))))).toContain('a');
  });

  it("isn't an article without enough text, or off the web", () => {
    expect(sanitizeArticle({ title: 'Short', content: p('Too short.') }, PAGE)).toBeNull();
    expect(sanitizeArticle({ title: 'Story', content: p(LONG) }, 'chord://settings/')).toBeNull();
    expect(sanitizeArticle({ title: 'Story', content: p(LONG) }, 'file:///home/me/a.html')).toBeNull();
    expect(sanitizeArticle(null, PAGE)).toBeNull();
    expect(sanitizeArticle('a string', PAGE)).toBeNull();
    expect(sanitizeArticle([p(LONG)], PAGE)).toBeNull();
    expect(sanitizeArticle({ title: 'Story', content: 42 }, PAGE)).toBeNull();
  });

  it('cleans the details around the article', () => {
    const article = sanitizeArticle({ title: '  A\n\ttitle\u0007 ', byline: 7, siteName: '', lang: 'en"><script>', dir: 'sideways', content: p(LONG) }, 'https://www.site.example/a')!;
    expect(article.title).toBe('A title');
    expect(article.byline).toBe('');
    expect(article.site).toBe('site.example');
    expect(article.lang).toBeNull();
    expect(article.dir).toBeNull();
    expect(sanitizeArticle({ content: p(LONG) }, PAGE)!.title).toBe('news.example');
  });
});

describe('sanitizeArticle: hostile pages', () => {
  it('drops scripts, styles and everything inside them', () => {
    const article = read(
      el('script', {}, 'window.top.marker = 1'),
      el('SCRIPT', { src: 'https://evil.example/x.js' }),
      el('style', {}, 'body { display: none }'),
      el('noscript', {}, '<img src=x onerror=alert(1)>'),
      el('template', {}, p('hidden')),
      el('link', { rel: 'stylesheet', href: 'https://evil.example/x.css' }),
      el('meta', { 'http-equiv': 'refresh', content: '0;url=javascript:alert(1)' }),
      el('base', { href: 'https://evil.example/' }),
    );
    expect(tags(article)).toEqual(['div', 'p']);
    expect(all(article)).not.toMatch(/marker|evil|display|onerror|hidden|refresh/);
  });

  it('drops event handlers, styles, classes and every other attribute off the list', () => {
    const article = read(
      p({ tag: 'span', attrs: { onclick: 'alert(1)' }, children: ['x'] }, el('em', { onmouseover: 'alert(1)', ONCLICK: 'alert(2)', style: 'background: url(javascript:alert(1))', class: 'evil', 'data-x': '1', tabindex: '0', contenteditable: 'true', role: 'button', 'aria-hidden': 'true' }, 'text')),
      el('img', { src: 'https://cdn.example/i.png', onerror: 'alert(1)', onload: 'alert(2)', srcset: 'javascript:alert(1) 1x', style: 'x', loading: 'eager', usemap: '#m' }),
      el('a', { href: 'https://ok.example', target: '_top', ping: 'https://evil.example', download: 'x', onclick: 'alert(1)', rel: 'opener' }, 'link'),
    );
    expect(all(article)).not.toMatch(/alert|style|class|data-x|tabindex|contenteditable|role|aria|srcset|target|ping|download|opener|loading|usemap/i);
    expect(elements(article.content).find((e) => e.tag === 'em')!.attrs).toBeUndefined();
  });

  it('never keeps a javascript:, data:, vbscript:, file: or chord: link, however it is written', () => {
    const hrefs = [
      'javascript:alert(1)',
      '  JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'chord://settings/',
      'chrome://settings',
      'blob:https://news.example/1234',
      'about:blank',
      `https://${'a'.repeat(9000)}.example/`,
      '#',
      '#"><script>',
    ];
    const article = read(...hrefs.map((href, i) => p(el('a', { href }, `link ${i}`))));
    expect(tags(article)).not.toContain('a');
    // Their text stays.
    expect(text(article.content)).toContain('link 0');
    expect(text(article.content)).toContain(`link ${hrefs.length - 1}`);
    // `javascript&colon;` isn't a scheme, so it's a relative path on the site: harmless, and kept as such.
    const odd = sanitizeArticle({ content: el('div', {}, p(LONG), p(el('a', { href: 'javascript&colon;alert(1)' }, 'x'))) }, PAGE)!;
    expect(elements(odd.content).find((e) => e.tag === 'a')!.attrs!['href']).toBe('https://news.example/2026/10/javascript&colon;alert(1)');
  });

  it('never keeps an image from javascript:, data: or anywhere off the web', () => {
    const article = read(
      ...['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'data:image/png;base64,AAAA', 'file:///c:/x.png', 'chord://shell/x.png', 'blob:https://x/1', ''].map((src) => el('img', { src, alt: 'x' })),
    );
    expect(tags(article)).not.toContain('img');
    expect(article.images).toEqual([]);
  });

  it('drops frames, embeds, forms and their fields', () => {
    const article = read(
      el('iframe', { src: 'https://evil.example', srcdoc: '<script>alert(1)</script>' }),
      el('frame', { src: 'x' }),
      el('object', { data: 'x.swf' }, el('param', { name: 'x' })),
      el('embed', { src: 'x.swf' }),
      el('form', { action: 'https://evil.example/steal' }, el('input', { name: 'password', value: 'hunter2' }), el('button', {}, 'Send'), el('select', {}, el('option', {}, 'One')), el('textarea', {}, 'typed')),
      el('input', { type: 'hidden', value: 'secret' }),
      el('video', { src: 'x.mp4' }, el('track', { src: 'x.vtt' })),
      el('audio', { src: 'x.mp3' }),
      el('canvas'),
      el('dialog', { open: '' }, 'modal'),
      el('portal', { src: 'x' }),
    );
    expect(tags(article)).toEqual(['div', 'p']);
    expect(all(article)).not.toMatch(/evil|hunter2|secret|Send|typed|modal|swf|mp4/);
  });

  it('drops SVG and MathML, scripts inside them included', () => {
    const article = read(
      el('svg', { onload: 'alert(1)' }, el('script', {}, 'alert(1)'), el('foreignObject', {}, p('inside')), el('a', { href: 'javascript:alert(1)' }, 'svg link')),
      el('SVG', {}, el('animate', { attributeName: 'href', to: 'javascript:alert(1)' })),
      el('math', {}, el('mi', { href: 'javascript:alert(1)' }, 'x')),
    );
    expect(tags(article)).toEqual(['div', 'p']);
    expect(all(article)).not.toMatch(/alert|inside|svg link/);
  });

  it('drops what the page hid', () => {
    const article = read(el('div', { hidden: '' }, p('Subscribe to read more')), p('shown'));
    expect(text(article.content)).not.toContain('Subscribe');
    expect(text(article.content)).toContain('shown');
  });

  it('only keeps attribute values that make sense', () => {
    const article = read(
      el('ol', { start: '1e9', type: 'disc' }, el('li', { value: 'x' }, 'a')),
      el('table', {}, el('tr', {}, el('td', { colspan: '0', rowspan: '99999' }, 'a'), el('th', { scope: 'everywhere' }, 'b'))),
      el('img', { src: 'https://x.example/i.png', width: '-5', height: '100000', alt: 'a\u0000b\nc' }),
      el('p', { dir: 'sideways', lang: 'not a lang!', id: 'has spaces' }, 'text'),
      el('bdo', { dir: 'rtl' }, 'backwards'),
      el('time', { datetime: '2026-10-24' }, 'today'),
    );
    expect(elements(article.content).find((e) => e.tag === 'ol')!.attrs).toBeUndefined();
    expect(elements(article.content).find((e) => e.tag === 'li')!.attrs).toBeUndefined();
    expect(elements(article.content).find((e) => e.tag === 'td')!.attrs).toBeUndefined();
    expect(elements(article.content).find((e) => e.tag === 'th')!.attrs).toBeUndefined();
    expect(elements(article.content).find((e) => e.tag === 'img')!.attrs).toEqual({ src: '0', alt: 'a b c' });
    expect(elements(article.content).find((e) => e.tag === 'p' && text(e.children!) === 'text')!.attrs).toBeUndefined();
    expect(elements(article.content).find((e) => e.tag === 'bdo')!.attrs).toEqual({ dir: 'rtl' });
    expect(elements(article.content).find((e) => e.tag === 'time')!.attrs).toEqual({ datetime: '2026-10-24' });
  });

  it("doesn't nest links", () => {
    const article = read(p(el('a', { href: 'https://a.example' }, 'outer ', el('a', { href: 'https://b.example' }, 'inner'))));
    const links = elements(article.content).filter((e) => e.tag === 'a');
    expect(links).toHaveLength(1);
    expect(text(links[0]!.children!)).toBe('outer inner');
  });

  it('ignores whatever else a compromised page could send instead of a tree', () => {
    const weird: unknown[] = [
      { tag: 7, children: ['x'] },
      { tag: 'p', attrs: 'onclick=alert(1)', children: 'not an array' },
      { tag: 'p', attrs: { href: { toString: () => 'javascript:alert(1)' } }, children: [LONG] },
      { tag: 'a', attrs: { href: ['javascript:alert(1)'] }, children: ['array href'] },
      { tag: 'p', attrs: { __proto__: { onclick: 'alert(1)' } }, children: ['proto'] },
      [p('nested array')],
      null,
      undefined,
      42,
    ];
    const article = sanitizeArticle({ title: 'x', content: el('div', {}, p(LONG), ...(weird as RawNode[])) }, PAGE)!;
    expect(all(article)).not.toContain('alert');
    expect(tags(article)).not.toContain('a');
  });

  it('bounds how much it walks: deep nesting, cycles and huge pages', () => {
    // Deeper than the limit: the innermost text is left out, the rest stays.
    let deep: RawNode = 'deepest';
    for (let i = 0; i < 200; i++) deep = el('div', {}, deep);
    const nested = read(deep);
    expect(text(nested.content)).not.toContain('deepest');

    // A tree that refers to itself (structured clone can send one).
    const loop: { tag: string; children: unknown[] } = { tag: 'div', children: ['loop '] };
    loop.children.push(loop, loop);
    const started = Date.now();
    const looped = sanitizeArticle({ title: 'x', content: el('div', {}, p(LONG), loop as unknown as RawNode) }, PAGE)!;
    expect(looped).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);

    // A huge page: capped, and quick.
    const huge = el('div', {}, ...Array.from({ length: 100_000 }, (_, i) => p(`Paragraph ${i} `, el('em', {}, 'with emphasis'))));
    const t0 = Date.now();
    const big = sanitizeArticle({ title: 'x', content: huge }, PAGE)!;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(elements(big.content).length).toBeLessThan(60_000);
  });
});

describe('reading time', () => {
  it('counts words, and Chinese and Japanese characters about two to a word', () => {
    expect(countWords('One two, three-four. Don’t stop')).toBe(5);
    expect(countWords('这是一个很长的句子')).toBeGreaterThanOrEqual(4);
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(2300)).toBe(10);
  });
});

describe('reader settings', () => {
  it('take only the steps and choices the reader has', () => {
    expect(cleanReaderSettings(DEFAULT_READER, { size: 4, width: 'wide', theme: 'sepia', font: 'serif' })).toEqual({ size: 4, width: 'wide', theme: 'sepia', font: 'serif' });
    expect(cleanReaderSettings(DEFAULT_READER, { size: 99 }).size).toBe(5);
    expect(cleanReaderSettings(DEFAULT_READER, { size: -1 }).size).toBe(0);
    expect(cleanReaderSettings(DEFAULT_READER, { size: 2.5, width: 'huge', theme: 'neon', font: 'comic' })).toEqual(DEFAULT_READER);
    expect(cleanReaderSettings(DEFAULT_READER, null)).toEqual(DEFAULT_READER);
  });

  it('are remembered through settings.set and a restart', () => {
    const state: State = { ...emptyState(), settings: defaultSettings() };
    const { state: next } = apply(state, { t: 'settings.set', settings: { reader: { size: 5, theme: 'dark' } } }, { now: 1, newId: () => 'x' });
    expect(next.settings.reader).toEqual({ ...DEFAULT_READER, size: 5, theme: 'dark' });
    const { patches } = apply(next, { t: 'settings.set', settings: { reader: { size: 5 } } }, { now: 2, newId: () => 'y' });
    expect(patches).toEqual([]);
    const restored = restoreState(
      { chords: [], nodes: [], windows: [], settings: { reader: { size: 1, width: 'narrow', theme: 'nope' } }, sitePermissions: {}, downloads: [], extensions: [], favorites: [], siteZoom: {} } as never,
      { now: 1, newId: () => 'z', theme: { stops: [{ l: 0.7, c: 0.1, h: 30 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://example.com/', firstRun: false },
    );
    expect(restored.settings.reader).toEqual({ ...DEFAULT_READER, size: 1, width: 'narrow' });
  });
});
