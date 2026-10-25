/**
 * What reader view runs in a page (ARCHITECTURE.md §9), always in Chord's
 * own isolated world: it shares the page's DOM but none of its scripts, so
 * the page can't see, call or tamper with any of it. Mozilla's Readability
 * (Apache-2.0, shipped in licenses/) goes in as its source text, as Duet's
 * extractor does: a bundled function's toString() may be renamed or wrapped.
 *
 * - READABLE_SCRIPT asks Readability's `isProbablyReaderable` whether the
 *   page reads as an article. It's cheap: it adds up paragraphs' lengths.
 * - EXTRACT_SCRIPT runs Readability on a copy of the document (the page
 *   itself is never changed) and returns the article as a small tree: tags,
 *   a few attributes and text, with each image's best address picked from
 *   its srcset, as JSON text. It's still the page's word: a worker cleans it
 *   (core's sanitizeArticle) before anything shows it.
 */
import READABILITY from '@mozilla/readability/Readability.js?raw';
import READERABLE from '@mozilla/readability/Readability-readerable.js?raw';

/** Chord's isolated world for reader view (Duet reads in 4400; extension popups' sizer uses 4321). */
export const READER_WORLD = 4410;

/** Only an HTML document can hold an article (not a PDF in its viewer, an image or plain text). */
const HTML_ONLY = String.raw`if (!/^(text\/html|application\/xhtml\+xml)$/.test(document.contentType) || !document.body) return null;`;

export const READABLE_SCRIPT = String.raw`(() => {
  const { isProbablyReaderable, isNodeVisible } = (() => {
${READERABLE}
    return { isProbablyReaderable, isNodeVisible };
  })();
  ${HTML_ONLY}
  // What's on the page counts, not what its styles hide.
  const visible = (node) => (typeof node.checkVisibility !== 'function' || node.checkVisibility()) && isNodeVisible(node);
  return isProbablyReaderable(document, { visibilityChecker: visible });
})()`;

export const EXTRACT_SCRIPT = String.raw`(() => {
  const Readability = (() => {
${READABILITY}
    return Readability;
  })();
  ${HTML_ONLY}
  const MAX_NODES = 60000;
  const MAX_DEPTH = 48;
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio', 'form', 'input', 'button', 'select', 'textarea']);
  const ATTRS = ['href', 'title', 'start', 'reversed', 'type', 'value', 'colspan', 'rowspan', 'scope', 'datetime', 'dir', 'lang', 'id'];
  const base = document.baseURI;
  const web = (value) => {
    try {
      const url = new URL(value, base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };
  // An image's address: from its srcset (and a picture's sources), the widest up to twice a wide
  // reading column, or the narrowest above that; else its src.
  const pick = (img, sets) => {
    const candidates = [];
    for (const set of [img.getAttribute('srcset'), ...sets]) {
      for (const part of (set || '').split(/,\s+/)) {
        const [url, descriptor = '1x'] = part.trim().split(/\s+/);
        if (!url) continue;
        const n = parseFloat(descriptor) || 1;
        candidates.push({ url, width: descriptor.endsWith('w') ? n : n * 800 });
      }
    }
    candidates.sort((a, b) => a.width - b.width);
    const fitting = candidates.filter((c) => c.width <= 1600);
    const chosen = fitting.length > 0 ? fitting[fitting.length - 1] : candidates[0];
    for (const address of [chosen && chosen.url, img.getAttribute('src')]) {
      const url = address ? web(address) : null;
      if (url) return url;
    }
    return null;
  };
  const image = (img, sets) => {
    const src = pick(img, sets);
    if (!src) return null;
    const attrs = { src, alt: img.getAttribute('alt') || '' };
    for (const name of ['title', 'width', 'height']) {
      const value = img.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    return { tag: 'img', attrs };
  };
  let nodes = 0;
  const walk = (node, depth, pre) => {
    if (++nodes > MAX_NODES) return null;
    if (node.nodeType === 3) {
      const text = node.nodeValue || '';
      return pre ? text : text.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1 || depth > MAX_DEPTH) return null;
    const tag = node.localName;
    if (SKIP.has(tag) || node.hasAttribute('hidden')) return null;
    if (tag === 'img') return image(node, []);
    if (tag === 'picture') {
      const img = node.querySelector('img');
      return img ? image(img, Array.from(node.querySelectorAll('source'), (s) => s.getAttribute('srcset'))) : null;
    }
    const attrs = {};
    for (const name of ATTRS) {
      const value = node.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    // Readability made addresses absolute; links to places in the page stay as they are.
    if (attrs.href !== undefined && !attrs.href.startsWith('#')) attrs.href = web(attrs.href) || '';
    const children = [];
    for (const child of node.childNodes) {
      const out = walk(child, depth + 1, pre || tag === 'pre');
      if (out !== null && out !== '') children.push(out);
    }
    return { tag, attrs, children };
  };
  const article = new Readability(document.cloneNode(true), { serializer: (el) => el }).parse();
  if (!article || !article.content) return null;
  // As text: main hands it to the worker that cleans it, without walking it itself.
  return JSON.stringify({
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    lang: article.lang,
    dir: article.dir,
    content: walk(article.content, 0, false),
  });
})()`;
