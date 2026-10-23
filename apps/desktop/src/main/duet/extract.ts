/**
 * Reading a page for Duet (ARCHITECTURE.md §11.4). Runs in Chord's own
 * isolated world, so page scripts can't see or tamper with it, and returns
 * the page's visible text as light Markdown. Never included: form-field
 * values (input, textarea, select: passwords, card numbers and one-time codes
 * among them), what the user is typing in a focused editable region, scripts,
 * hidden subtrees, and media. Page text is still untrusted; core's
 * cleanPageText and pageResult take it from here.
 *
 * The extractor is plain JavaScript source rather than a function's
 * toString(): bundling may rename or wrap functions in ways the page can't run.
 */
import type { WebContents } from 'electron';

/** Chord's isolated world for Duet's reads (extension popups' sizer uses 4321). */
export const DUET_WORLD = 4400;

export interface PageRead {
  title: string;
  url: string;
  contentType: string;
  text: string;
  selection: string;
}

export const EXTRACT_SCRIPT = String.raw`(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','SELECT','OPTION','DATALIST','BUTTON','SVG','CANVAS','IFRAME','OBJECT','EMBED','VIDEO','AUDIO','PICTURE','HEAD','LINK','META']);
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|UL|OL|LI|TABLE|THEAD|TBODY|TR|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|H[1-6]|DL|DT|DD|FORM|FIELDSET|BR|HR|DETAILS|SUMMARY)$/;
  const MAX = 400000;
  const out = [];
  let total = 0;
  const focused = document.activeElement;
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    if (el.hidden) return false;
    const r = el.getBoundingClientRect();
    return !(r.right < -500 || r.bottom < -5000);
  };
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (total > MAX) return;
      if (child.nodeType === 3) {
        const t = (child.nodeValue || '').replace(/\s+/g, ' ');
        if (t.trim()) { out.push(t); total += t.length; }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'IMG') {
        const alt = (child.getAttribute('alt') || '').trim().slice(0, 120);
        if (alt) out.push(' ' + alt + ' ');
        continue;
      }
      if (SKIP.has(tag)) continue;
      if (child.isContentEditable && focused && child.contains(focused)) continue;
      if (!visible(child)) continue;
      const block = BLOCK.test(tag);
      if (block) out.push('\n');
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(Number(tag[1])) + ' ');
      if (tag === 'LI') out.push('- ');
      if (child.shadowRoot) walk(child.shadowRoot);
      walk(child);
      if (tag === 'TD' || tag === 'TH') out.push(' | ');
      if (block) out.push('\n');
    }
  };
  walk(document.body || document.documentElement);
  const text = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const inField = focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName);
  const selection = inField ? '' : String(window.getSelection() || '').slice(0, 20000);
  return { title: document.title, url: location.href, contentType: document.contentType, text, selection };
})()`;

export async function readPage(contents: WebContents): Promise<PageRead | null> {
  if (contents.isDestroyed()) return null;
  try {
    const result = (await contents.executeJavaScriptInIsolatedWorld(DUET_WORLD, [{ code: EXTRACT_SCRIPT }])) as PageRead;
    return result && typeof result.text === 'string' ? result : null;
  } catch {
    return null;
  }
}

/** A tab's visible area as a PNG, at most 1280 px wide (tab_screenshot). */
export async function screenshot(contents: WebContents): Promise<{ data: string; mimeType: string } | null> {
  if (contents.isDestroyed()) return null;
  try {
    let image = await contents.capturePage();
    if (image.getSize().width > 1280) image = image.resize({ width: 1280 });
    return { data: image.toPNG().toString('base64'), mimeType: 'image/png' };
  } catch {
    return null;
  }
}
