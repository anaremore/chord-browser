/**
 * What Effects run in a page, from Chord's own isolated worlds (the page's DOM,
 * none of its scripts), through `pageCall`, and only when you ask. Nothing of
 * these stays in the page: an Effect itself is a stylesheet, never a script.
 *
 * - The outline Duet reads to write a patch: elements' tags, ids, classes,
 *   roles and sizes, and a few headings. Never a form field's value, nor
 *   what's typed in an editor.
 * - A selector for the element you picked to hide: screenshots' picker keeps
 *   it in its own world (`__chordShot`, screenshots/scripts.ts), and this
 *   names it so a stylesheet can find it again on the site's other pages.
 *
 * Plain JavaScript source, as Duet's extractor is: bundling may rename or wrap
 * functions in ways a page can't run.
 */

/** Chord's isolated world for Effects' outline (Duet reads in 4400, reader view in 4410, screenshots and the picker in 4420). */
export const EFFECTS_WORLD = 4430;

/** How long the outline may take: a long page is slow, a hung one never answers. */
export const OUTLINE_MS = 8000;

/** What the outline script answers. */
export interface PageOutline {
  title: string;
  url: string;
  outline: string;
}

export const OUTLINE_SCRIPT = String.raw`(() => {
  const MAX_LINES = 600;
  const MAX_CHARS = 24000;
  const MAX_DEPTH = 14;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','LINK','META','BR','WBR','SOURCE','TRACK','PARAM','OPTION','OPTGROUP','DATALIST']);
  // Shown, but not walked into: their insides are pictures, frames, or what someone types.
  const LEAF = new Set(['svg','canvas','iframe','video','audio','img','picture','object','embed','input','textarea','select','button','math']);
  const lines = [];
  let chars = 0;
  const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => {
    if (el.hidden) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return getComputedStyle(el).display === 'contents';
    }
    return true;
  };
  const describe = (el) => {
    let s = el.localName;
    if (el.id) s += '#' + clip(el.id, 40);
    const classes = [...el.classList];
    for (const c of classes.slice(0, 4)) s += '.' + clip(c, 40);
    if (classes.length > 4) s += '…';
    const role = el.getAttribute('role');
    if (role) s += '[role=' + clip(role, 20) + ']';
    const label = el.getAttribute('aria-label');
    if (label && !el.isContentEditable) s += '[aria-label="' + clip(label, 40) + '"]';
    // A field's kind, never its value.
    if (el.localName === 'input') s += '[type=' + clip(el.getAttribute('type') || 'text', 20) + ']';
    const style = getComputedStyle(el);
    const bits = [];
    if (style.position === 'fixed' || style.position === 'sticky') bits.push(style.position);
    if (style.display === 'flex' || style.display === 'grid' || style.display === 'contents') bits.push(style.display);
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) bits.push(Math.round(r.width) + '×' + Math.round(r.height));
    if (/^h[1-3]$/.test(el.localName) && !el.isContentEditable) bits.push('"' + clip(el.textContent || '', 80) + '"');
    return s + (bits.length ? '  ' + bits.join(' ') : '');
  };
  const signature = (el) => el.localName + '.' + [...el.classList].join('.');
  const push = (depth, text) => {
    if (lines.length >= MAX_LINES || chars > MAX_CHARS) return false;
    const line = '  '.repeat(depth) + text;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  const walk = (el, depth) => {
    if (depth > MAX_DEPTH) return true;
    const kids = [...el.children].filter((c) => !SKIP.has(c.tagName) && visible(c));
    let i = 0;
    while (i < kids.length) {
      const kid = kids[i];
      // A run of siblings that look alike (list items, cards): the first two, then how many more.
      let run = 1;
      while (i + run < kids.length && signature(kids[i + run]) === signature(kid)) run++;
      const shown = run > 3 ? 2 : run;
      for (let k = 0; k < shown; k++) {
        const c = kids[i + k];
        if (!push(depth, describe(c))) return false;
        if (!LEAF.has(c.localName) && !(c.isContentEditable && c.contains(document.activeElement)) && !walk(c, depth + 1)) return false;
      }
      if (run > shown && !push(depth, '… ' + (run - shown) + ' more like this')) return false;
      i += run;
    }
    return true;
  };
  const body = document.body || document.documentElement;
  const page = getComputedStyle(body);
  const root = getComputedStyle(document.documentElement);
  push(0, 'page  text ' + page.color + ' on ' + (page.backgroundColor === 'rgba(0, 0, 0, 0)' ? root.backgroundColor : page.backgroundColor) + ', ' + page.fontSize + ' ' + clip(page.fontFamily, 60) + ', color-scheme ' + root.colorScheme + ', ' + innerWidth + '×' + innerHeight + ' window');
  push(0, describe(body));
  walk(body, 1);
  if (lines.length >= MAX_LINES || chars > MAX_CHARS) lines.push('… (the outline stops here)');
  return { title: document.title, url: location.href, outline: lines.join('\n') };
})()`;

/** What the selector script answers: a selector that finds the picked element again, and how the list names it. */
export interface PickedElement {
  selector: string;
  label: string;
}

/**
 * A selector for the picked element (screenshots' `__chordShot`, in their
 * world): its id if that's unique and looks stable, else the shortest chain of
 * tags, stable-looking classes and `:nth-of-type` up from it that finds it alone.
 * Inside a shadow root, its host (a page's stylesheet can't reach further).
 */
export const SELECTOR_SCRIPT = String.raw`(() => {
  let el = globalThis.__chordShot;
  if (!el || !el.isConnected) return null;
  for (let i = 0; i < 16 && el.getRootNode() instanceof ShadowRoot; i++) el = el.getRootNode().host;
  if (!el || el === document.documentElement || el === document.body || el === document.head) return null;
  const esc = (s) => CSS.escape(s);
  const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch { return 0; } };
  // Generated names (css-1x2y3z, hashed modules, long numbers) change between visits.
  const stable = (name) => name.length > 0 && name.length <= 40 && !/[0-9a-f]{6,}|\d{4,}|^(css|sc|jsx|svelte|emotion|chakra)-/i.test(name) && !/__[A-Za-z0-9_-]{5,}$/.test(name);
  const own = (node) => {
    if (node.id && stable(node.id) && count('#' + esc(node.id)) === 1) return { text: '#' + esc(node.id), unique: true };
    let text = node.localName;
    for (const c of [...node.classList].filter(stable).slice(0, 2)) text += '.' + esc(c);
    const parent = node.parentElement;
    if (parent && [...parent.children].some((s) => s !== node && s.matches(text))) {
      const same = [...parent.children].filter((s) => s.localName === node.localName);
      text += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    return { text, unique: false };
  };
  const label = (node) => (node.localName + (node.id ? '#' + node.id : node.classList[0] ? '.' + node.classList[0] : '')).slice(0, 60);
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 8; depth++) {
    const part = own(node);
    parts.unshift(part.text);
    const selector = parts.join(' > ');
    if (count(selector) === 1 && document.querySelector(selector) === el) return { selector, label: label(el) };
    if (part.unique) break;
    node = node.parentElement;
  }
  const selector = parts.join(' > ');
  return document.querySelector(selector) === el ? { selector, label: label(el) } : null;
})()`;
