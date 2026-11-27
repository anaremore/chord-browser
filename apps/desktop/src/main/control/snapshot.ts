/**
 * The page snapshot's script (S18 M2b; core's control-snapshot.ts has the rules it feeds). It runs in Chord's isolated
 * world (4400), as forms and the extractor do, only when an agent asks, so page scripts can neither see nor tamper with
 * it, and nothing runs in a page no agent snapshots.
 *
 * It walks the main frame (open shadow roots too, and same-origin frames: #210) and gives back the
 * outline as nodes: a role, a name, a depth (only nodes with a role nest), states, and a key on each element an agent
 * can act on. Each keyed element is kept by a WeakRef under the read's token, here in the page's renderer, for M2c's
 * actions to find and check again (with the role and name it had): the latest snapshot of each owner (an agent's gate: an outside agent, a chat), so
 * one agent's snapshot never takes away another's (SNAPSHOT_OWNERS of them at most). An owner that went (an agent
 * disconnecting, a chat closed) leaves its entry until it's the oldest past that bound or the page goes: harmless, as
 * its refs live only in its own scope, which went with it, and the entry holds elements only by WeakRef.
 *
 * - **Roles:** the element's own `role`, else its tag's (and an input's type's) implicit role.
 * - **Names:** `aria-labelledby`, `aria-label`, a field's labels (forms' rules), `alt`, `title`, then its own words
 *   (never a field's value inside it, nor an editor's text), cut to SNAPSHOT_NAME_MAX. A text field of any kind (an
 *   input, a text area, a `role=textbox`, and any editable element whatever its tag or role: editability is decided
 *   first) is named by its labels alone, never its words, which are what's typed in it, and its inside isn't walked;
 *   it's described as a field, so a sensitive one (a card number in a rich editor) gets no ref.
 * - **Left out:** what CSS hides, and `aria-hidden="true"` subtrees, as Playwright leaves them out.
 * - **Acted on (a key):** links, buttons, text fields and areas, contenteditable, checkboxes, radios, selects,
 *   switches, tabs, menu items, options, tree items, `summary`, and anything whose cursor is a pointer with no keyed
 *   ancestor (a site's clickable `div`).
 * - **States, never values:** checked, selected, expanded, pressed, disabled, required; `empty` or `filled` for text;
 *   a select's choice by its label.
 * - **Bounded:** SNAPSHOT_SCAN nodes looked at (elements and text alike) and SNAPSHOT_SCAN_MS of looking,
 *   SNAPSHOT_MAX_REFS keys; a page of millions of text nodes is cut like any other.
 *
 * Plain JavaScript source, as forms' and the extractor's are: bundling may rename or wrap functions in ways a page
 * can't run. Arguments go in as JSON.
 */
import { ASSISTANT_FORM_MAX_OPTIONS, cleanSnapshotRead, SNAPSHOT_MAX_REFS, SNAPSHOT_NAME_MAX, SNAPSHOT_OWNERS, SNAPSHOT_SCAN, SNAPSHOT_SCAN_MS, type SnapshotRead } from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { ASSISTANT_WORLD, TEXT_LIB } from './extract';
import { FORM_LIB } from './forms';

/** How long a snapshot may take to come back: a busy page answers within it, a hung one is a refusal. */
const SNAPSHOT_MS = 5000;

/**
 * What a snapshot and an action (control/act.ts) both need to know of an element: its role (editability first), its
 * name, its states, whether it shows, and forms' labels and visibility. One copy, so an action checks an element
 * exactly as the snapshot described it. Plain JavaScript, as the scripts are.
 */
export const SNAPSHOT_LIB = String.raw`
  const MAX_OPTIONS = ${ASSISTANT_FORM_MAX_OPTIONS};
  const NAME_MAX = ${SNAPSHOT_NAME_MAX};
  ${FORM_LIB}
  // Roles an agent can act on: each gets a key (an element, kept by a WeakRef for M2c).
  const ACTED = new Set(['link', 'button', 'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);
  // Parts of a page read by their container ref (S18 M2g-2, #207: read_tab's ref): read-only, in their own table.
  const CONTAINERS = new Set(['region', 'article', 'main', 'navigation', 'complementary', 'banner', 'contentinfo', 'search', 'form', 'table']);
  // Roles shown for orientation, without a key.
  const SHOWN = new Set(['heading', 'list', 'listitem', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'img', 'figure', 'article', 'group', 'radiogroup', 'tablist', 'tabpanel', 'menu', 'menubar', 'tree', 'toolbar', 'alert', 'status', 'iframe', 'separator', 'progressbar', 'slider']);
  const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'password', 'search', 'number', 'date', 'datetime-local', 'month', 'week', 'time', '']);
  const inputRole = (el) => {
    const type = String(el.type || '').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'search') return 'searchbox';
    if (type === 'file' || type === 'color') return 'button';
    return TEXT_TYPES.has(type) ? 'textbox' : null;
  };
  const landmark = (el, role) => (el.closest('article, aside, main, nav, section') && el.parentElement && el.parentElement.closest('article, aside, main, nav, section') ? null : role);
  const implicitRole = (el) => {
    const tag = el.localName;
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'button': return 'button';
      case 'input': return inputRole(el);
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'summary': return 'button';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return landmark(el, 'banner');
      case 'footer': return landmark(el, 'contentinfo');
      case 'aside': return 'complementary';
      case 'form': return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'form' : null;
      case 'search': return 'search';
      case 'dialog': return 'dialog';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'img': return (el.getAttribute('alt') || '').trim() ? 'img' : null;
      case 'figure': return 'figure';
      case 'article': return 'article';
      // A section with a name is a region (#207), as ARIA maps it and itemRole reads it: decided on the name it computes,
      // never an empty or dangling aria-label or aria-labelledby (round 1 of #260).
      case 'section': return nameOf(el, 'region') ? 'region' : null;
      case 'fieldset': return 'group';
      case 'iframe': case 'frame': return 'iframe';
      case 'hr': return 'separator';
      case 'progress': return 'progressbar';
    }
    return null;
  };
  const roleOf = (el) => {
    const own = String(el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (own === 'none' || own === 'presentation') return null;
    if (own && (ACTED.has(own) || SHOWN.has(own))) return own;
    return implicitRole(el);
  };
  const isField = (el) => el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select';
  // Roles of something typed in: named by labels alone, described as a field, never walked into.
  const TYPED = new Set(['textbox', 'searchbox', 'spinbutton']);
  // A name: what assistive tech would read first, then the element's own words; never a field's value.
  const nameOf = (el, role) => {
    // A text field of any kind: its labels and placeholder only. Its words are what's typed in it.
    if (TYPED.has(role) && !isField(el)) return labelOf(el) || clip(el.getAttribute('aria-placeholder') || el.getAttribute('placeholder'), NAME_MAX);
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
    const by = clip(ids.map((id) => byId(el, id)).filter(Boolean).map(words).join(' '), NAME_MAX);
    if (by) return by;
    const aria = clip(el.getAttribute('aria-label'), NAME_MAX);
    if (aria) return aria;
    if (isField(el)) {
      const type = typeOf(el);
      if (type === 'submit' || type === 'button' || type === 'reset') return clip(el.value || (type === 'submit' ? 'Submit' : ''), NAME_MAX);
      if (type === 'image') return clip(el.getAttribute('alt') || 'Submit', NAME_MAX);
      return labelOf(el) || clip(el.getAttribute('placeholder'), NAME_MAX);
    }
    if (el.localName === 'img') return clip(el.getAttribute('alt'), NAME_MAX);
    if (role === 'iframe') return clip(el.getAttribute('title') || el.getAttribute('name'), NAME_MAX);
    // Containers are named only by what's said of them; acted-on elements and headings by their words too.
    if (ACTED.has(role) || role === 'heading' || role === 'generic') {
      const own = words(el) || clip([...el.querySelectorAll('img[alt]')].slice(0, 3).map((i) => i.getAttribute('alt')).join(' '), NAME_MAX);
      if (own) return clip(own, NAME_MAX);
    }
    return clip(el.getAttribute('title'), NAME_MAX);
  };
  const statesOf = (el, role) => {
    const s = [];
    const aria = (name) => el.getAttribute('aria-' + name);
    if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) { if (el.indeterminate) s.push('mixed'); else if (el.checked) s.push('checked'); }
    else if (aria('checked') === 'true') s.push('checked');
    else if (aria('checked') === 'mixed') s.push('mixed');
    if (aria('selected') === 'true') s.push('selected');
    if (aria('expanded') === 'true' || (el.localName === 'summary' && el.parentElement && el.parentElement.open)) s.push('expanded');
    else if (aria('expanded') === 'false' || (el.localName === 'summary' && el.parentElement && !el.parentElement.open)) s.push('collapsed');
    if (aria('pressed') === 'true') s.push('pressed');
    if (el.matches(':disabled') || aria('disabled') === 'true') s.push('disabled');
    if (el.required === true || aria('required') === 'true') s.push('required');
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') {
      const length = isField(el) ? String(el.value || '').length : (el.textContent || '').trim().length;
      s.push(length ? 'filled' : 'empty');
      if (el.readOnly === true || aria('readonly') === 'true') s.push('readonly');
    }
    return s;
  };
  // Shown at all: hidden by CSS is left out, off screen isn't (a long page's top, a section not yet rendered).
  const visible = (el) => {
    if (el.hidden || el.closest('[inert]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return getComputedStyle(el).display === 'contents';
    return true;
  };
  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'link', 'meta', 'option', 'optgroup', 'datalist', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'br']);
  // A field's description, for core's sensitiveField: an input's type, a text area's, a select's, or text for any other
  // field (an editor). The snapshot gives it with each field, and an action checks it again before text or a key goes in.
  // What opens a file picker: a file input, or a label for one (Neon's review of #110). Agents never choose files: no ref.
  const opensFiles = (el) => (el.localName === 'input' && String(el.type).toLowerCase() === 'file') || (el.localName === 'label' && Boolean(el.control) && String(el.control.type).toLowerCase() === 'file');
  // closest(), across open shadow roots to their hosts (a button in a component, inside a form or a link, is that
  // form's or that link's), as deep.ts walks them. Shared by act.ts' riskOf and refShape.
  const closestDeep = (from, selector) => {
    for (let node = from; node; ) {
      const found = node.closest(selector);
      if (found) return found;
      const root = node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return null;
  };
  // What a click on an element acts on (#112 review 1): a label's control, else a button it's inside, else itself.
  const actTarget = (el) => {
    const label = closestDeep(el, 'label');
    const control = label && label.control && label.control !== el ? label.control : null;
    const inButton = !control && el.localName !== 'button' ? closestDeep(el, 'button') : null;
    return control || inButton || el;
  };
  // A clickable element by its look (the snapshot's own rule): a pointer cursor, not just inherited from its parent.
  const pointerGeneric = (el) => getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
  // Where a kept element is (the owner's bug #2: a ref whose node the page replaced is found again by it): its ancestors'
  // tags and roles, out through open shadow roots to their hosts, up to the root (at most 64), as JSON (a role's words
  // can't pass for another ancestor: the review of #117).
  const refPath = (el) => {
    const parts = [];
    let node = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    while (node && parts.length < 64) {
      parts.push([node.localName, node.getAttribute('role') || '']);
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return JSON.stringify(parts);
  };
  // Where risk lives in it, from what a click acts on (actTarget), as riskOf reads it (the review of #117): the target's
  // tag, type and id (a label's for), its link's address (a, area, across shadow roots), its form's address and method
  // (through the form's prototype: a field named action can't stand in), its own formaction and formmethod where it has
  // them (as resolved: an empty one and a <base> count), what makes a field sensitive (autocomplete, name, id,
  // placeholder), whether it's disabled (aria-disabled too), read-only or an editor, and its words where an aria-label
  // says otherwise. (The items it's in: itemsOf, below.)
  // What a ref's shape reads (refShape, in two halves): shapeParts finds its target, link and form, and its own words
  // where an aria-label names it; shapeOf reads them. The walk takes the parts (near: el's nearest label, button, link
  // and form among its ancestors, out through open shadow roots as closestDeep climbs, so no climb), and the task after
  // the snapshot reads them, from the nodes held even if the page has replaced them since (round 6 of #117: on one CPU
  // a 100 ms redraw came before that task, and no ref of the snapshot could be found again). The same answer as
  // refShape on the same node.
  const shapeParts = (el, near) => {
    const nearest = (key, selector, self) => (self ? el : near ? near[key] : closestDeep(el, selector));
    const label = nearest('label', 'label', el.localName === 'label');
    const control = label && label.control && label.control !== el ? label.control : null;
    const inButton = !control && el.localName !== 'button' ? nearest('button', 'button', false) : null;
    const t = control || inButton || el;
    const link = nearest('a', 'a[href], area[href]', (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href'));
    const form = (t.form !== undefined ? t.form : null) || (t === el ? nearest('form', 'form', el.localName === 'form') : closestDeep(t, 'form'));
    const own = el.getAttribute('aria-label') ? clip(String(el.innerText || ''), NAME_MAX) : '';
    return { el, t, link, form, own };
  };
  const shapeOf = ({ el, t, link, form, own }) => {
    const formGet = (f, prop) => {
      try { return String(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, prop).get.call(f)); } catch { return ''; }
    };
    const has = (a) => typeof t.hasAttribute === 'function' && t.hasAttribute(a);
    return JSON.stringify([
      t.localName, String(t.type || ''), t.id || '', el.localName === 'label' ? String(el.htmlFor || '') : '',
      link ? String(link.href) : '', form ? [formGet(form, 'action'), formGet(form, 'method')] : null,
      has('formaction') ? String(t.formAction) : '', has('formmethod') ? String(t.formMethod) : '',
      t.getAttribute('autocomplete') || '', t.getAttribute('name') || '', t.getAttribute('placeholder') || '',
      Boolean(t.disabled), t.getAttribute('aria-disabled') || '', Boolean(t.readOnly), Boolean(t.isContentEditable), own,
    ]);
  };
  const refShape = (el) => shapeOf(shapeParts(el, null));
  const fieldOf = (el) => ({ type: isField(el) ? typeOf(el) : 'text', autocomplete: clip(el.getAttribute('autocomplete'), 80).toLowerCase(), name: clip(el.getAttribute('name'), 60), id: clip(el.id, 60), label: labelOf(el), placeholder: clip(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'), 100) });
  // The role an element has now, editability first (an editor is a typed field whatever its tag or role).
  const roleNow = (el) => {
    const own = String(el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    return el.isContentEditable ? (TYPED.has(own) ? own : 'textbox') : roleOf(el);
  };
  // The items an element is in (the owner, 2026-11-24; the review of #117): its rows, list items, articles, dialogs, tab
  // panels and regions (a section counts as one), each by its role and its name as the outline names it (what
  // aria-labelledby names, its aria-label, its title: never its text, which a turn timer changes), nearest first; an
  // unnamed one says nothing and is left out. The same control for another item (Table 4, not 3) is another element.
  const ITEMS = new Set(['row', 'listitem', 'article', 'dialog', 'alertdialog', 'tabpanel', 'region']);
  const itemRole = (n, role) => (ITEMS.has(role) ? role : !role && n.localName === 'section' ? 'region' : null);
  const itemOf = (n, role) => {
    const r = itemRole(n, role);
    if (!r) return null;
    const name = nameOf(n, r);
    return name ? [r, name] : null;
  };
  // Climbing, out through open shadow roots to their hosts, at most 64 ancestors (as refPath): act.ts' checks. The
  // snapshot builds the same from its walk (itemsAt).
  // A frame whose contents are read (#210): of the top's own origin, by origins (never only a readable document:
  // document.domain, an opaque top), the top's origin not opaque. Its document, or null.
  const FRAME_DEPTH = 3;
  const frameDoc = (el) => {
    if (window.origin === 'null') return null;
    try {
      const win = el.contentWindow;
      const doc = el.contentDocument;
      return win && doc && win.origin === window.origin ? doc : null;
    } catch { return null; }
  };
  // A frame is a frame by its tag (#320's NSF2), whatever role the page gives it: never walked into (its children are
  // fallback, never rendered), never a ref of its own.
  const isFrameEl = (el) => el.localName === 'iframe' || el.localName === 'frame';
  // A document hidden at its root (#320's NSF3): its html or its body hidden, aria-hidden, inert, or not shown by CSS
  // (display, visibility, opacity). Nothing in it is read. At the top (top true), aria-hidden doesn't count (round 2,
  // Fable's S3): it hides nothing on screen, sites set it there by mistake, and WebKit and Firefox ignore it there.
  const docHidden = (doc, top = false) => {
    for (const n of [doc.documentElement, doc.body]) {
      if (!n) continue;
      if (n.hidden || n.hasAttribute('inert') || (!top && String(n.getAttribute('aria-hidden')).toLowerCase() === 'true') || !visible(n)) return true;
    }
    return false;
  };
  // A document that is an editor (its body or root editable, or designMode on): one typed field, never walked.
  const editorDoc = (doc) => doc.designMode === 'on' || Boolean(doc.body && doc.body.isContentEditable) || Boolean(doc.documentElement && doc.documentElement.isContentEditable);
  const itemsOf = (el) => {
    const parts = [];
    let node = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    for (let i = 0; node && i < 64; i++) {
      const part = itemOf(node, roleNow(node));
      if (part) parts.push(part);
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return JSON.stringify(parts);
  };
  // Which row it's in, when that row has no name (#268): the words of each unnamed item on the way up, nearest first, at
  // most 3, stopping at the first named one (its items say it: itemsOf), within the 64 ancestors itemsOf climbs. An
  // item's words: its first heading that says something, then its text, a picture's alt and a link's aria-label in
  // order, through open shadow roots, from at most 100 nodes that give words or hold them and 240 characters; never a
  // control's (a button, a field, a summary), an editor's (what's typed) or a ticker's (role=timer or progressbar,
  // aria-live, a progress bar or a meter; <time> counts). The nearest item reads all it holds; the items above it never
  // read into a row nested in them (li, tr, role=row or listitem; rounds 3 and 4 of #273). Past 60 characters the rest is kept as a short hash. Read from
  // tags and attributes only (no style or computed role: every unnamed row's, once per snapshot), and the same at every
  // step, so the two always agree. The same control in another unnamed row (ids by position, a row replaced or patched
  // in place) is another element.
  const ROW_LABEL_MAX = 60;
  // Raw words kept, at most (one clip at the end), and the nodes that count toward the look: kept elements and text
  // that isn't only spaces (a pretty-printed row's whitespace never uses it up).
  const ROW_LABEL_RAW = 240;
  const ROW_LABEL_VISIT = 100;
  const ROW_ITEMS = 3;
  const ROW_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'summary', 'progress', 'meter']);
  const ROW_TICKERS = new Set(['timer', 'progressbar']);
  const rowHash = (t) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  };
  // A row nested in an item above the control's nearest (round 2 of #273, N4; narrowed in round 4): a list's rows and a
  // table's are their own, never their container's, so a row going never changes the others' keys. Only rows (li, tr,
  // role=row, role=listitem): a nested section, article or div may hold the row's own words, or ones every row shares
  // beside the control, and is read (round 4: the planner's call, Fable's option 2).
  const ROW_ITEM_TAGS = new Set(['li', 'tr']);
  const ROW_ITEM_ROLES = new Set(['row', 'listitem']);
  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  // An element of a row passed over (and all it holds): null; else its role from its attribute, '' for none (none read
  // for an element with no attributes: most of a row's). No object made per element, the tag's set lookups first
  // (round 3 of #273: the row's share of the snapshot). An editor is passed over where its attribute is (never the
  // computed isContentEditable, which can make the page work out its styles); contenteditable="false" isn't one.
  // outer: an item above the row's nearest, which never reads into a row nested in it (N4: li, tr, role=row or listitem).
  const rowRole = (c, tag, outer) => {
    // A frame's children are its fallback, never rendered (#320's NSF2): no part of a row's words.
    if (SKIP.has(tag) || ROW_CONTROLS.has(tag) || tag === 'iframe' || tag === 'frame') return null;
    if (!c.attributes.length) return outer && ROW_ITEM_TAGS.has(tag) ? null : '';
    const editable = c.getAttribute('contenteditable');
    if (c.hidden || c.hasAttribute('inert') || (editable !== null && editable.toLowerCase() !== 'false') || String(c.getAttribute('aria-hidden')).toLowerCase() === 'true') return null;
    const r = String(c.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    const live = c.getAttribute('aria-live');
    if (ROW_TICKERS.has(r) || (live && live.toLowerCase() !== 'off')) return null;
    if (r && r !== 'link' && r !== 'heading' && ACTED.has(r)) return null;
    if (outer && (r ? ROW_ITEM_ROLES.has(r) : ROW_ITEM_TAGS.has(tag))) return null;
    return r;
  };
  // Its words in order (text, a picture's alt, a link's aria-label, through open shadow roots), under their own budget
  // (counted nodes, raw characters): a heading's, read on its own.
  const rowWords = (root, outer) => {
    const out = [];
    let raw = 0;
    let looked = 0;
    const visit = (n) => {
      for (let c = n.firstChild; c && raw < ROW_LABEL_RAW && looked < ROW_LABEL_VISIT; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const t = c.nodeValue.trim();
          if (!t) continue;
          looked++;
          out.push(t.slice(0, ROW_LABEL_RAW - raw));
          raw += t.length + 1;
          continue;
        }
        if (c.nodeType !== 1) continue;
        const tag = c.localName;
        const r = rowRole(c, tag, outer);
        if (r === null) continue;
        looked++;
        if (tag === 'img') {
          const alt = (c.getAttribute('alt') || '').trim();
          if (alt) { out.push(alt.slice(0, ROW_LABEL_RAW)); raw += alt.length + 1; }
          continue;
        }
        const label = (tag === 'a' || r === 'link') && (c.getAttribute('aria-label') || '').trim();
        if (label) { out.push(label.slice(0, ROW_LABEL_RAW)); raw += label.length + 1; continue; }
        if (c.shadowRoot) visit(c.shadowRoot);
        visit(c);
      }
    };
    if (root.shadowRoot) visit(root.shadowRoot);
    visit(root);
    return out;
  };
  // An item's words, in one look: its first heading that says something first (its words read on their own budget:
  // every row can share a heading, and text before it never uses up what reads it, round 2 of #273), then the rest
  // in order. Once the rest's characters are spent, the look goes on only to find that heading. From its own open
  // shadow root (a web-component row) and its children; past 60 characters, the rest as a short hash (never shown).
  const rowLabel = (item, outer) => {
    const rest = [];
    let heading = null;
    let raw = 0;
    let looked = 0;
    const visit = (n) => {
      for (let c = n.firstChild; c && looked < ROW_LABEL_VISIT; c = c.nextSibling) {
        const full = raw >= ROW_LABEL_RAW;
        if (full && heading) return;
        if (c.nodeType === 3) {
          if (full) continue;
          const t = c.nodeValue.trim();
          if (!t) continue;
          looked++;
          rest.push(t.slice(0, ROW_LABEL_RAW - raw));
          raw += t.length + 1;
          continue;
        }
        if (c.nodeType !== 1) continue;
        const tag = c.localName;
        const r = rowRole(c, tag, outer);
        if (r === null) continue;
        looked++;
        if (heading === null && (r === 'heading' || (!r && HEADING_TAGS.has(tag)))) {
          const own = rowWords(c, outer);
          if (own.length) heading = own;
          continue;
        }
        if (!full) {
          if (tag === 'img') {
            const alt = (c.getAttribute('alt') || '').trim();
            if (alt) { rest.push(alt.slice(0, ROW_LABEL_RAW)); raw += alt.length + 1; }
            continue;
          }
          const label = (tag === 'a' || r === 'link') && (c.getAttribute('aria-label') || '').trim();
          if (label) { rest.push(label.slice(0, ROW_LABEL_RAW)); raw += label.length + 1; continue; }
        }
        if (c.shadowRoot) visit(c.shadowRoot);
        visit(c);
      }
    };
    if (item.shadowRoot) visit(item.shadowRoot);
    visit(item);
    const all = clip((heading ? heading.concat(rest) : rest).join(' '), 2 * ROW_LABEL_RAW);
    return all.length > ROW_LABEL_MAX ? all.slice(0, ROW_LABEL_MAX) + ' #' + rowHash(all) : all;
  };
  // Climbing as itemsOf does (as the walk: rowAt): '' when the nearest item is named, or there is none.
  const rowOf = (el) => {
    const labels = [];
    let node = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    for (let i = 0; node && i < 64 && labels.length < ROW_ITEMS; i++) {
      const role = roleNow(node);
      if (itemRole(node, role)) {
        if (itemOf(node, role)) break;
        labels.push(rowLabel(node, labels.some(Boolean)));
      }
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return labels.length ? JSON.stringify(labels) : '';
  };
  // A row that says nothing at all (#268's review, S5): never found again by it.
  // The nearest item saying nothing is enough (round 3 of #273): an item above it that says something (a count, a total)
  // tells groups apart, never the rows in them.
  const rowSaysNothing = (row) => Boolean(row) && JSON.parse(row)[0] === '';
`;

/**
 * How many snapshots a diff took (after an action, M2g-1) are kept behind an agent's latest, besides its own last one
 * (pinned until its next): its refs, core's ElementRefs, the same.
 */
const SNAPSHOT_HISTORY = 4;

/**
 * An owner's snapshot by its token, in the page: the latest, or one kept behind it (SNAPSHOT_HISTORY). For act.ts' and
 * deep.ts' scripts: `snapshotFind(owner, token)` there.
 */
export const SNAPSHOT_FIND = String.raw`const snapshotFind = (owner, token) => { let r = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(owner); while (r && r.token !== token) r = r.prev; return r || null; };`;

/** `owner`: whose snapshot it is (the agent's gate id), so each keeps its own latest one; `token`: this read's. */
/** `boxes`: the parts it may read by their container refs (#207), kept as its keyed elements are, in their own list. */
/**
 * What the walk leaves out, for a test that measures what each of its parts costs (#166; chordTestHooks.
 * agentSnapshotParts): the shape's parts (`shape`), each element's nearest label, button, link and form (`near`), its
 * item (`items`); or, as before #166, each element's place's part built in the walk (`eagerPart`). A snapshot with a
 * probe is never an agent's: only measured.
 */
export type SnapshotProbe = Partial<Record<'shape' | 'near' | 'items' | 'eagerPart' | 'row', true>>;

function snapshotScript(owner: string, token: string, pinned = true, boxes = false, probe: SnapshotProbe = {}, frameRefs = false): string {
  const args = { owner, token, pinned, boxes, probe, frameRefs, scan: SNAPSHOT_SCAN, ms: SNAPSHOT_SCAN_MS, maxRefs: SNAPSHOT_MAX_REFS, nameMax: SNAPSHOT_NAME_MAX, owners: SNAPSHOT_OWNERS, history: SNAPSHOT_HISTORY };
  return String.raw`((args) => {
  ${SNAPSHOT_LIB}
  ${boxes ? TEXT_LIB : ''}
  const started = performance.now();
  const nodes = [];
  const keep = [];
  // The parts read by their container refs (#207): each by a WeakRef, with the role and name the outline gave it.
  const boxes = [];
  // Each element's own id in this document, for this agent (M2g-1): the same element, the same id, from one snapshot to
  // the next; a replaced one gets another. Refs are made from it (core's ElementRefs), so an action's diff can name them.
  // Only while it's the same element as the agent knows it (round 1 of #145, B1): its role, its name and the items it's
  // in. A node the page renamed in place, or moved to another row, gets a new id, so its old ref is never it. A change of
  // state alone (checked, filled) keeps it. At most as many owners as snapshots keep (args.owners).
  // An owner's ids start above every id given in this document (round 2 of #145): one whose map was let go of (the
  // owners' cap) and comes back never gets an id an earlier element had, so an old ref never names another element.
  const sidsAll = (globalThis.__chordSids = globalThis.__chordSids || new Map());
  let sidsMine = sidsAll.get(args.owner);
  if (!sidsMine) sidsMine = { ids: new WeakMap(), next: globalThis.__chordSidNext || 1 };
  sidsAll.delete(args.owner);
  sidsAll.set(args.owner, sidsMine);
  while (sidsAll.size > args.owners) sidsAll.delete(sidsAll.keys().next().value);
  // Compared field by field, no string built per node (round 2 of #145: Neon measured it at 4 to 6.5 ms on 16k nodes).
  // A kept ref's row too (#268's review): a node patched in place into another unnamed row gets a new id, so a later
  // snapshot (an action's diff, a find) never gives the old ref to the other row's control. And the frames it's in
  // (#210's B6): one moved into another frame gets a new id.
  const sidOf = (el, role, name, items, row = '', frame = '') => {
    let had = sidsMine.ids.get(el);
    if (!had || had.role !== role || had.name !== name || had.items !== items || had.row !== row || had.frame !== frame) {
      had = { id: sidsMine.next++, role, name, items, row, frame };
      sidsMine.ids.set(el, had);
      if (sidsMine.next > (globalThis.__chordSidNext || 1)) globalThis.__chordSidNext = sidsMine.next;
    }
    return had.id;
  };
  const cut = {};
  let looked = 0;
  const stop = () => {
    if (looked > args.scan) { cut.elements = true; return true; }
    if (looked % 100 === 0 && performance.now() - started > args.ms) { cut.time = true; return true; }
    return false;
  };
  let stopped = false;
  // depth: the outline's depth here; keyed: inside an element with a key (a pointer cursor there is its own); named:
  // inside an element its words name (an acted-on one, a heading), whose text is its name already.
  // Each element's ancestors as the walk passes them (a linked list, from the parent up): a kept ref's place (refPath's
  // JSON, the same) is built from it, never by climbing again for each (the review of #117: measured, it cost the
  // snapshot ~4 ms on the typical page).
  // It carries the named items on the way too (itemsOf's, the same), each at its depth: only the nearest 64 ancestors'.
  // And each element's nearest label, button, link and form, itself included, for its children's shapes (refShape).
  const NO_NEAR = { label: null, button: null, a: null, form: null };
  const nearHere = (el, up) => {
    if (args.probe.near) return NO_NEAR;
    const above = up ? up.near : NO_NEAR;
    const tag = el.localName;
    if (tag === 'label') return { ...above, label: el };
    if (tag === 'button') return { ...above, button: el };
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return { ...above, a: el };
    if (tag === 'form') return { ...above, form: el };
    return above;
  };
  const link = (el, up, role) => {
    const n = up ? up.n + 1 : 1;
    const part = args.probe.items ? null : itemOf(el, role);
    const items = up ? up.items : null;
    // Its tag and role as the walk saw them, as strings: never the element, whose role the page can change before the task
    // after the snapshot (round 1 of #270, B1: a twin row's ref then found the other row). The place's pairs are built
    // in that task (placeOf), only for a kept ref's ancestors, never one array per element (#166).
    const at = { tag: el.localName, role: el.getAttribute('role') || '', up, n, items: part ? { part, n, up: items } : items, near: nearHere(el, up) };
    // (As main did before #166, for agentSnapshotParts' comparison: measured only.)
    if (args.probe.eagerPart) at.part = [at.tag, at.role];
    // The nearest item, named or not, and the ones above it (rowAt): the unnamed ones' words are the row a ref is in
    // (#268). Its element is live, so a row's words are read in the walk (rowAt), never in the task after (#270's B1).
    // Left out with the items (agentSnapshotParts), or on its own (probe.row).
    if (!args.probe.items && !args.probe.row) at.item = itemRole(el, role) ? { el, named: Boolean(part), n, up: up ? up.item : null } : up ? up.item : null;
    return at;
  };
  // A kept ref's row (rowOf's, the same), from the walk's chain: each unnamed item's label once per snapshot, within the
  // 64 ancestors rowOf climbs (as itemsAt).
  const rowLabels = [new Map(), new Map()];
  const rowAt = (chain) => {
    if (chain && chain.rowKey !== undefined) return chain.rowKey;
    const labels = [];
    for (let it = chain && chain.item; it && chain.n - it.n < 64 && labels.length < ROW_ITEMS; it = it.up) {
      if (it.named) break;
      // An item above never reads into nested rows once an inner level has found words (round 4 of #273, Carbon: a
      // shared section around the list would read every row again); while none has, it reads all it holds (the row's
      // words may be in a sibling item: words in one nested item, the control in another, round 3).
      const outer = labels.some(Boolean);
      const seen = rowLabels[outer ? 1 : 0];
      if (!seen.has(it.el)) seen.set(it.el, rowLabel(it.el, outer));
      labels.push(seen.get(it.el));
    }
    const key = labels.length ? JSON.stringify(labels) : '';
    if (chain) chain.rowKey = key;
    return key;
  };
  const placeOf = (chain) => {
    const parts = [];
    for (let c = chain; c && parts.length < 64; c = c.up) parts.push([c.tag, c.role]);
    return JSON.stringify(parts);
  };
  // Kept on the chain's node (round 2 of #145): its children all ask for the same items.
  const itemsAt = (chain) => {
    if (chain && chain.itemsKey !== undefined) return chain.itemsKey;
    const parts = [];
    for (let c = chain && chain.items; c && chain.n - c.n < 64; c = c.up) parts.push(c.part);
    const key = JSON.stringify(parts);
    if (chain) chain.itemsKey = key;
    return key;
  };
  // The same-origin frames the walk is in (#210): each one's element, its document then, and its id. Every ref kept in
  // there gets the same list (its frame chain, WeakRefs: checked at every step), and the frames' ids are its frame key.
  const frames = [];
  let frameHere = null;
  const enterFrame = (el, doc, depth, frameSid) => {
    // Its name and the items it's in, too (#320's SF3): a frame retitled, or moved into another item, is another frame.
    frames.push({ el, doc, sid: frameSid, name: nameOf(el, 'iframe'), items: itemsOf(el) });
    const before = frameHere;
    frameHere = { chain: frames.map((f) => ({ frame: new WeakRef(f.el), doc: new WeakRef(f.doc), name: f.name, items: f.items })), key: frames.map((f) => f.sid).join('/') };
    const start = doc.body || doc.documentElement;
    if (start && editorDoc(doc)) {
      // An editor frame (#210's B2): one typed field, named as its frame is, never walked (what's typed never read).
      const name = nameOf(el, 'iframe');
      const node = { depth, role: 'textbox', name, sid: sidOf(start, 'textbox', name, '[]', '', frameHere.key) };
      const states = statesOf(start, 'textbox');
      if (states.length) node.states = states;
      // Labelled by its frame's name, as the snapshot names it (#320's SF2), and by its own label too (round 2, Fable's S1):
      // a "Card number" or "Password" editor frame, or a "Notes" frame whose body is a "Card number" field, is that
      // sensitive field, as at the top.
      const own = fieldOf(start);
      node.field = { ...own, label: [name, own.label].filter(Boolean).join(' ') };
      looked++;
      if (args.frameRefs && shown(start) && keep.length >= args.maxRefs) cut.refs = true;
      else if (args.frameRefs && shown(start)) { node.key = keep.length; keep.push({ ref: new WeakRef(start), role: 'textbox', name, items: '[]', path: refPath(start), shape: refShape(start), frames: frameHere }); }
      nodes.push(node);
    } else if (start) {
      // Its own document's ancestors (#210's B6): a place and items within it, as refPath and itemsOf climb there.
      let inner = null;
      const above = [];
      for (let n = start; n; n = n.parentElement) above.push(n);
      for (const n of above.reverse()) inner = link(n, inner, roleNow(n));
      walk(start, depth, false, false, inner);
    }
    frames.pop();
    frameHere = before;
  };
  const walk = (parent, depth, keyed, named, chain) => {
    for (const child of parent.childNodes) {
      if (stopped) return;
      if (child.nodeType === 3) {
        // Text counts as looked at too: a page of millions of text nodes is cut like any other.
        if (++looked && stop()) { stopped = true; return; }
        if (named) continue;
        const text = (child.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text) nodes.push({ depth, role: 'text', name: clip(text, args.nameMax) });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (++looked && stop()) { stopped = true; return; }
      if (SKIP.has(el.localName) || String(el.getAttribute('aria-hidden')).toLowerCase() === 'true' || !visible(el)) continue;
      // Editability first, whatever the tag or role (a td, an li, an h1, role=none): an editor is a typed field, named by
      // its labels alone, described as a field for sensitiveField, and never walked into (its inside is what's typed).
      let role = isFrameEl(el) ? 'iframe' : roleNow(el);
      // A site's clickable element: a pointer cursor, with nothing keyed around it, and not just inheriting one.
      if (!role && !keyed && pointerGeneric(el)) role = 'generic';
      if (!role) {
        const inner = link(el, chain, role);
        if (el.shadowRoot) walk(el.shadowRoot, depth, keyed, named, inner);
        walk(el, depth, keyed, named, inner);
        continue;
      }
      const acted = ACTED.has(role) || role === 'generic';
      // An acted-on element must be on screen to be acted on (forms' rule: at least a few pixels, not put off the page).
      const actable = acted && !opensFiles(el) && (isField(el) ? visibleField(el, typeOf(el)) : shown(el));
      const name = nameOf(el, role);
      const row = actable ? rowAt(chain) : '';
      const node = { depth, role, name, sid: sidOf(el, role, name, itemsAt(chain), row, frameHere ? frameHere.key : '') };
      if (role === 'heading') node.level = Number(el.getAttribute('aria-level')) || Number((el.localName.match(/^h([1-6])$/) || [])[1]) || 2;
      const states = statesOf(el, role);
      // A frame of another origin: its contents can't be read from here (#112: said so, never an empty node). One of the
      // top's own origin is read (#210), if it's shown and at most FRAME_DEPTH deep; else listed, empty.
      let inFrame = null;
      if (role === 'iframe') {
        inFrame = frameDoc(el);
        if (!inFrame) states.push('other-site');
        // Of the top's origin but not read: said why (#320's N5), never left to look empty.
        else if (!shown(el) || docHidden(inFrame)) { states.push('not-shown'); inFrame = null; }
        else if (frames.length >= FRAME_DEPTH) { states.push('too-deep'); inFrame = null; }
      }
      if (states.length) node.states = states;
      if (el.localName === 'select' && !el.multiple) { const o = el.options[el.selectedIndex]; if (o) node.choice = clip(o.label || o.text, args.nameMax); }
      // Described as a field, for core's sensitiveField: inputs, text areas, selects (a card's expiry month), and any
      // other text field (a contenteditable, a role=textbox), whose type is text.
      if (isField(el) || TYPED.has(role)) node.field = fieldOf(el);
      // Inside a frame, a ref only in an agent's own tab (#210's B3: never in a tab of yours, or one shared).
      if (actable && (!frameHere || args.frameRefs)) {
        if (keep.length >= args.maxRefs) cut.refs = true;
        else { node.key = keep.length; keep.push({ ref: new WeakRef(el), role, name: node.name, row, parts: args.probe.shape ? null : shapeParts(el, chain ? chain.near : NO_NEAR), chain, ...(frameHere ? { frames: frameHere } : {}) }); }
      }
      // A part's ref only where its read would go (round 2 of #260, N1: never one always refused as changed); never in
      // a frame (#210: not in this slice).
      if (args.boxes && !frameHere && CONTAINERS.has(role) && boxes.length < args.maxRefs && !partBlocked(el)) { node.box = boxes.length; boxes.push({ ref: new WeakRef(el), role, name }); }
      nodes.push(node);
      // A same-origin frame shown and not too deep is entered (#210); any other is listed; a field's inside is what's
      // typed in it (or its options); an acted-on element's words are its name.
      if (role === 'iframe') {
        if (inFrame) enterFrame(el, inFrame, depth + 1, node.sid);
        continue;
      }
      if (isField(el) || TYPED.has(role)) continue;
      const inside = named || acted || role === 'heading';
      // (A pointer-cursor element's role, for its items, as itemsOf reads it: none.)
      const inner = link(el, chain, role === 'generic' ? null : role);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, keyed || acted, inside, inner);
      walk(el, depth + 1, keyed || acted, inside, inner);
    }
  };
  // The walk's start, checked as every element is: a page that's all editor (<body contenteditable>, <html
  // contenteditable>, designMode, the data: notepad) is one typed field, named by its labels alone, never walked.
  const start = document.body || document.documentElement;
  if (docHidden(document, true)) {
    // Hidden at its root (#320's NSF3): nothing to read.
  } else if (document.designMode === 'on' || start.isContentEditable || document.documentElement.isContentEditable) {
    const startName = nameOf(start, 'textbox');
    const node = { depth: 0, role: 'textbox', name: startName, sid: sidOf(start, 'textbox', startName, itemsOf(start), shown(start) ? rowOf(start) : '') };
    const states = statesOf(start, 'textbox');
    if (states.length) node.states = states;
    node.field = fieldOf(start);
    if (shown(start)) { node.key = keep.length; keep.push({ ref: new WeakRef(start), role: 'textbox', name: node.name, items: itemsOf(start), row: rowOf(start), path: refPath(start), shape: refShape(start) }); }
    nodes.push(node);
  } else {
    // The start's own ancestors, and itself, as its children's place.
    let chain = null;
    const above = [];
    for (let n = start; n; n = n.parentElement) above.push(n);
    for (const n of above.reverse()) chain = link(n, chain, roleNow(n));
    walk(start, 0, false, false, chain);
  }
  // What finds a ref again and checks it (the review of #117): each ref's items, place and shape, in a task right after
  // the snapshot answers, or first thing by any step that comes before it (act.ts, deep.ts), from what the walk held
  // (its chain, and the shape's parts: shapeParts), never the page as it is then. Taken before answering, it cost the
  // typical page's snapshot about 5 ms (12.8 → 17.9 ms median, interleaved in one page), and arm64 its budget; and a
  // page that redraws before that task can't take it away (round 6). If anything here throws, none is found again.
  let pending = true;
  const reads = (globalThis.__chordSnapshots = globalThis.__chordSnapshots || new Map());
  const read = { token: args.token, url: location.href, keep, boxes, finish: null, finishMs: 0 };
  const finish = () => {
    if (!pending) return;
    pending = false;
    // Another snapshot since (its refs replace these): nothing to keep.
    const began = performance.now();
    let shapesOk = true;
    try {
      for (const k of keep) {
        if (!k.chain) continue;
        k.items = itemsAt(k.chain);
        k.path = placeOf(k.chain);
        // (A probe that left the parts out has none: measured only, never an agent's.)
        k.shape = k.parts ? shapeOf(k.parts) : '';
      }
    } catch { shapesOk = false; }
    const whole = shapesOk && !(cut.refs || cut.elements || cut.time);
    // Found again only if nothing else here looked like it: its role, name, items, place and shape unique among the
    // snapshot's own, and the snapshot whole (never cut short: what it didn't see could be its twin). Its items stay
    // either way: every step checks them (act.ts).
    const counts = new Map();
    for (const k of keep) { delete k.chain; delete k.parts; k.sig = JSON.stringify([k.role, k.name, k.items, k.row, k.path, k.shape, k.frames ? k.frames.key : '']); counts.set(k.sig, (counts.get(k.sig) || 0) + 1); }
    for (const k of keep) {
      // Twins (#211): two or more alike among the snapshot's own, cut short or not. Their place and shape stay, so a
      // look finds whether any is still there (none: changed); an action on one is never taken, and says why.
      const twins = shapesOk && k.path !== undefined && counts.get(k.sig) > 1;
      if (twins) k.twins = true;
      else if (!whole) { delete k.path; delete k.shape; }
      delete k.sig;
    }
    // (Its cost, for the budgets journey.)
    read.finishMs = performance.now() - began;
  };
  read.finish = finish;
  // (Tests only: the one change of the page chordTestHooks.agentBeforeFinish set, made between the answer and the task
  // after it, where a page can change before that task runs (round 1 of #270, B1). Only Chord's world can set it.)
  const beforeFinish = globalThis.__chordBeforeFinish;
  if (typeof beforeFinish === 'function') {
    globalThis.__chordBeforeFinish = null;
    try { beforeFinish(); } catch {}
  }
  setTimeout(finish, 0);
  // Each owner's latest snapshot, its own: another agent's snapshot of this page never takes it away. The ones before it
  // stay behind it, at most SNAPSHOT_HISTORY in all (M2g-1): a ref the agent got from one of them (a diff after an action
  // takes a snapshot too) still names its element there, and one the page replaced is found again from there (#117).
  // The agent's own snapshot (it read it: pinned) stays until its next one; the ones a diff took, the last few.
  read.pinned = args.pinned;
  const before = reads.get(args.owner);
  const kept = [read];
  let pinnedKept = read.pinned;
  let diffs = read.pinned ? 0 : 1;
  for (let r = before && before.url === location.href ? before : null; r; r = r.prev) {
    if (r.pinned ? !pinnedKept : diffs < args.history) {
      kept.push(r);
      if (r.pinned) pinnedKept = true;
      else diffs++;
    }
  }
  kept.forEach((r, i) => { r.prev = kept[i + 1] || null; });
  reads.delete(args.owner);
  reads.set(args.owner, read);
  while (reads.size > args.owners) reads.delete(reads.keys().next().value);
  return { url: location.href, title: document.title, nodes, cut };
})(${JSON.stringify(args)})`;
}

/** What wait_for looks for (M2g-1): a text, or an element by its role and exact name; and whether it's to show or go. */
/** `after`: how long the chunk waits before its first look (the throttle, carried from the chunk before: S-2). */
export type WaitFor = { text?: string; role?: string; name?: string; gone: boolean; after?: number };
/**
 * One chunk's answer: met, and whether its last look was cut short (then it never proves something gone); `ms`, that
 * look's time, and `since`, how long ago it ended (the next chunk's throttle); `looked` false when there was none.
 */
export type WaitAnswer = { met: boolean; cut: boolean; editor?: boolean; ms?: number; since?: number; looked?: boolean };

/**
 * wait_for in the page, for at most `ms` (the caller waits in chunks: tools.ts). It looks as the snapshot does (SNAPSHOT_LIB:
 * only what's shown, open shadow roots, never what's typed in a field, at most SNAPSHOT_SCAN nodes and SNAPSHOT_SCAN_MS),
 * once now, then again as the page changes: at most one look each max(150 ms, 4 × the last look's time), by a timer
 * (Neon's review of M2g-1, B5). A look that was cut short never proves something gone.
 */
function waitScript(want: WaitFor, ms: number): string {
  const args = { ...want, ms, scan: SNAPSHOT_SCAN, scanMs: SNAPSHOT_SCAN_MS };
  return String.raw`new Promise((done) => {
  const args = ${JSON.stringify(args)};
  ${SNAPSHOT_LIB}
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const want = args.text !== undefined ? norm(args.text) : '';
  // A page that is an editor (its body editable, or designMode on: Neon's round 1 of M2g-1, B-3): what shows is what's
  // typed, so its text is never looked at, or a wait would be an oracle on it. Only an element by role and name.
  const editorPage = document.designMode === 'on' || Boolean(document.body && document.body.isContentEditable) || Boolean(document.documentElement && document.documentElement.isContentEditable);
  if (editorPage && args.text !== undefined) return done({ met: false, cut: false, editor: true });
  // A page hidden at its root (#320's NSF3): nothing in it is ever met.
  const pageHidden = () => docHidden(document, true);
  const look = () => {
    const began = performance.now();
    let looked = 0;
    let cut = false;
    let found = false;
    const over = () => {
      if (++looked > args.scan) { cut = true; return true; }
      if (looked % 100 === 0 && performance.now() - began > args.scanMs) { cut = true; return true; }
      return false;
    };
    let depthNow = 0;
    const walk = (parent, keyed) => {
      for (const child of parent.childNodes) {
        if (found || cut) return;
        if (child.nodeType === 3) {
          if (over()) return;
          // Never text in an editor (what's typed), wherever it is.
          if (parent.nodeType === 1 && parent.isContentEditable) continue;
          if (args.text !== undefined && norm(child.nodeValue).includes(want)) found = true;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (over()) return;
        if (SKIP.has(el.localName) || String(el.getAttribute('aria-hidden')).toLowerCase() === 'true' || !visible(el)) continue;
        let role = isFrameEl(el) ? 'iframe' : roleNow(el);
        if (!role && !keyed && pointerGeneric(el)) role = 'generic';
        // One that can be acted on counts only when it's on screen, as the snapshot gives it a ref (S-5).
        // Shown as the snapshot judges it: a field by visibleField (a styled checkbox: its box unseen, its label shown).
        if (args.role !== undefined && role === args.role && nameOf(el, role) === args.name && (!(ACTED.has(role) || role === 'generic') || (isField(el) ? visibleField(el, typeOf(el)) : shown(el)))) { found = true; return; }
        // A same-origin frame (#210): looked in, as the snapshot reads it (shown, at most FRAME_DEPTH deep), and watched
        // (SF1); an editor frame's text never (what's typed). Any other frame's inside is its fallback, never shown (S-5).
        if (role === 'iframe') {
          const doc = depthNow < FRAME_DEPTH && shown(el) ? frameDoc(el) : null;
          if (!doc || docHidden(doc) || !(doc.body || doc.documentElement)) continue;
          // An editor frame (#320's NSF1), as the snapshot gives it: one textbox named as its frame, matched by that line
          // alone; never walked or watched (what's typed, and what's pasted in an island, is never read).
          if (editorDoc(doc)) {
            if (args.role === 'textbox' && nameOf(el, 'iframe') === args.name && shown(doc.body || doc.documentElement)) { found = true; return; }
            continue;
          }
          roots.add(doc);
          depthNow++;
          walk(doc.body || doc.documentElement, false);
          depthNow--;
          continue;
        }
        if (isField(el) || TYPED.has(role)) continue;
        const inner = keyed || ACTED.has(role) || role === 'generic';
        if (el.shadowRoot) { roots.add(el.shadowRoot); walk(el.shadowRoot, inner); }
        walk(el, inner);
      }
    };
    if (!pageHidden()) walk(document.body || document.documentElement, false);
    const ended = performance.now();
    return { found, cut, ms: ended - began, ended };
  };
  const met = (r) => (args.gone ? !r.found && !r.cut : r.found);
  // Open shadow roots a look passed: watched too (N-6), so a change inside a component wakes a look.
  const roots = new Set();
  const observed = new Set();
  const OBSERVE = { subtree: true, childList: true, characterData: true, attributes: true };
  const observeRoots = () => { if (!watch) return; for (const r of roots) if (!observed.has(r)) { observed.add(r); watch.observe(r, OBSERVE); } };
  // The chunk's answer: its last look's, how long it took and how long ago it ended (the next chunk's throttle).
  const answer = (r) => (r ? { met: met(r), cut: r.cut, ms: r.ms, since: performance.now() - r.ended } : { met: false, cut: false, looked: false });
  let last = null;
  let timer = 0;
  let pending = false;
  let watch = null;
  const finish = (r) => { if (watch) watch.disconnect(); clearTimeout(timer); clearTimeout(end); done(answer(r)); };
  const first = () => {
    pending = false;
    last = look();
    if (met(last)) return finish(last);
    watch = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        last = look();
        if (met(last)) return finish(last);
        observeRoots();
      }, Math.max(150, 4 * last.ms));
    });
    watch.observe(document, OBSERVE);
    observeRoots();
  };
  // At most one look per throttle across chunks too (S-2): the chunk before's last look may be too recent.
  // The chunk's end never looks out of turn (SF2): a look still to come is the next chunk's, its throttle carried.
  const end = setTimeout(() => finish(last), args.ms);
  if (args.after > 0 && args.after < args.ms) { pending = true; timer = setTimeout(first, args.after); }
  else if (!(args.after >= args.ms)) first();
})`;
}

export async function waitInPage(contents: WebContents, want: WaitFor, ms: number): Promise<WaitAnswer | null> {
  if (contents.isDestroyed()) return null;
  const answer = await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: waitScript(want, ms) }]), null, ms + 2000);
  if (!answer || typeof answer !== 'object' || typeof (answer as WaitAnswer).met !== 'boolean') return null;
  const a = answer as WaitAnswer;
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 60_000 ? n : 0);
  return { met: a.met, cut: a.cut === true, ms: num(a.ms), since: num(a.since), ...(a.editor === true ? { editor: true } : {}), ...(a.looked === false ? { looked: false } : {}) };
}

/**
 * Whether the page shows anything yet: text, or an image, a canvas, a control, a frame or an element with a role
 * (the owner, 2026-11-24: a new tab's first look came back empty; its page draws itself after it loads). Waits for it
 * at most `waitMs`, as the page changes. True at once on a page that already does.
 */
const SHOWS_SCRIPT = (waitMs: number) => `new Promise((done) => {
  const has = () => { const b = document.body; return Boolean(b && (String(b.innerText || '').trim() || b.querySelector('img, svg, canvas, video, input, button, select, textarea, iframe, [role]'))); };
  if (has()) return done(true);
  let timer = 0;
  const watch = new MutationObserver(() => { if (has()) { watch.disconnect(); clearTimeout(timer); setTimeout(() => done(true), 50); } });
  watch.observe(document, { subtree: true, childList: true, characterData: true });
  timer = setTimeout(() => { watch.disconnect(); done(has()); }, ${Number(waitMs)});
})`;

export async function pageShows(contents: WebContents, waitMs: number): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  return (await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: SHOWS_SCRIPT(waitMs) }]), null, waitMs + 1000)) === true;
}

/** A snapshot of the page for `owner`, or null if it couldn't be taken (gone, hung, or not a page). */
export async function snapshotPage(contents: WebContents, owner: string, token: string, pinned = true, boxes = false, probe: SnapshotProbe = {}, frameRefs = false): Promise<SnapshotRead | null> {
  if (contents.isDestroyed()) return null;
  return cleanSnapshotRead(await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: snapshotScript(owner, token, pinned, boxes, probe, frameRefs) }]), null, SNAPSHOT_MS));
}

/** One part's shown text by its container ref (#207), or why not: changed since the snapshot, or the page an editor. */
export type BoxAnswer = { ok: true; url: string; role: string; name: string; text: string } | { ok: false; why: 'stale' | 'editor' };

/**
 * read_tab by a container ref (S18 M2g-2, #207): the part `owner`'s snapshot `token` kept as `box`, checked again as an
 * action checks its element (still in the page, the same role and name the outline gave it, shown), then its text, by
 * the page read's own walk (extract.ts' TEXT_LIB), strict: never a field's value, an editing host's contents or an ARIA
 * text field's. A page that's all editor (designMode, an editable body) is never read this way (#145's B-3).
 */
function boxTextScript(owner: string, token: string, box: number): string {
  return String.raw`((args) => {
  ${SNAPSHOT_LIB}
  ${TEXT_LIB}
  ${SNAPSHOT_FIND}
  const html = document.documentElement;
  if (document.designMode === 'on' || (document.body && document.body.isContentEditable) || (html && html.isContentEditable)) return { ok: false, why: 'editor' };
  const read = snapshotFind(args.owner, args.token);
  const b = read && read.boxes ? read.boxes[args.box] : null;
  const el = b ? b.ref.deref() : null;
  // Still in this document (never one adopted into a frame).
  if (!el || !el.isConnected || el.ownerDocument !== document) return { ok: false, why: 'stale' };
  // Never more than the page read gives (rule 1): itself and every ancestor, as the snapshot checked them (partBlocked),
  // again now: made inert, hidden, an editor since are refused (rounds 1 and 2 of #260).
  const blocked = partBlocked(el);
  if (blocked) return { ok: false, why: blocked };
  const role = roleNow(el);
  if (role !== b.role || nameOf(el, role) !== b.name) return { ok: false, why: 'stale' };
  return { ok: true, url: location.href, role: b.role, name: b.name, text: readText(el, true) };
})(${JSON.stringify({ owner, token, box })})`;
}

/** How long a part's read may take: as a page's. */
const BOX_MS = 8000;

export async function readBoxPage(contents: WebContents, owner: string, token: string, box: number): Promise<BoxAnswer | null> {
  if (contents.isDestroyed()) return null;
  const a = (await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: boxTextScript(owner, token, box) }]), null, BOX_MS)) as BoxAnswer | null;
  if (!a || typeof a !== 'object') return null;
  if (a.ok === true && typeof a.text === 'string' && typeof a.url === 'string' && typeof a.role === 'string' && typeof a.name === 'string') return { ok: true, url: a.url, role: a.role.slice(0, 40), name: a.name.slice(0, 2000), text: a.text };
  if (a.ok === false && (a.why === 'stale' || a.why === 'editor')) return { ok: false, why: a.why };
  return null;
}
