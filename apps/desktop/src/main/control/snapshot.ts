/**
 * The page snapshot's script (S18 M2b; core's control-snapshot.ts has the rules it feeds). It runs in Chord's isolated
 * world (4400), as forms and the extractor do, only when an agent asks, so page scripts can neither see nor tamper with
 * it, and nothing runs in a page no agent snapshots.
 *
 * It walks the main frame (open shadow roots too; a frame is listed by its title, never entered) and gives back the
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
import { ASSISTANT_WORLD } from './extract';
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
`;

/**
 * How many snapshots a diff took (after an action, M2g-1) are kept behind an agent's latest, besides its own last one
 * (pinned until its next): its refs, core's ElementRefs, the same.
 */
export const SNAPSHOT_HISTORY = 4;

/**
 * An owner's snapshot by its token, in the page: the latest, or one kept behind it (SNAPSHOT_HISTORY). For act.ts' and
 * deep.ts' scripts: `snapshotFind(owner, token)` there.
 */
export const SNAPSHOT_FIND = String.raw`const snapshotFind = (owner, token) => { let r = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(owner); while (r && r.token !== token) r = r.prev; return r || null; };`;

/** `owner`: whose snapshot it is (the agent's gate id), so each keeps its own latest one; `token`: this read's. */
export function snapshotScript(owner: string, token: string, pinned = true): string {
  const args = { owner, token, pinned, scan: SNAPSHOT_SCAN, ms: SNAPSHOT_SCAN_MS, maxRefs: SNAPSHOT_MAX_REFS, nameMax: SNAPSHOT_NAME_MAX, owners: SNAPSHOT_OWNERS, history: SNAPSHOT_HISTORY };
  return String.raw`((args) => {
  ${SNAPSHOT_LIB}
  const started = performance.now();
  const nodes = [];
  const keep = [];
  // Each element's own id in this document, for this agent (M2g-1): the same element, the same id, from one snapshot to
  // the next; a replaced one gets another. Refs are made from it (core's ElementRefs), so an action's diff can name them.
  // Only while it's the same element as the agent knows it (round 1 of #145, B1): its role, its name and the items it's
  // in. A node the page renamed in place, or moved to another row, gets a new id, so its old ref is never it. A change of
  // state alone (checked, filled) keeps it. At most as many owners as snapshots keep (args.owners).
  const sidsAll = (globalThis.__chordSids = globalThis.__chordSids || new Map());
  let sidsMine = sidsAll.get(args.owner);
  if (!sidsMine) sidsMine = { ids: new WeakMap(), next: 1 };
  sidsAll.delete(args.owner);
  sidsAll.set(args.owner, sidsMine);
  while (sidsAll.size > args.owners) sidsAll.delete(sidsAll.keys().next().value);
  const sidOf = (el, sig) => { let had = sidsMine.ids.get(el); if (!had || had.sig !== sig) { had = { id: sidsMine.next++, sig }; sidsMine.ids.set(el, had); } return had.id; };
  const sigOf = (role, name, items) => JSON.stringify([role, name, items]);
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
    const part = itemOf(el, role);
    const items = up ? up.items : null;
    return { part: [el.localName, el.getAttribute('role') || ''], up, n, items: part ? { part, n, up: items } : items, near: nearHere(el, up) };
  };
  const placeOf = (chain) => {
    const parts = [];
    for (let c = chain; c && parts.length < 64; c = c.up) parts.push(c.part);
    return JSON.stringify(parts);
  };
  const itemsAt = (chain) => {
    const parts = [];
    for (let c = chain && chain.items; c && chain.n - c.n < 64; c = c.up) parts.push(c.part);
    return JSON.stringify(parts);
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
      let role = roleNow(el);
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
      const node = { depth, role, name, sid: sidOf(el, sigOf(role, name, itemsAt(chain))) };
      if (role === 'heading') node.level = Number(el.getAttribute('aria-level')) || Number((el.localName.match(/^h([1-6])$/) || [])[1]) || 2;
      const states = statesOf(el, role);
      // A frame of another site: its contents can't be read from here (#112: said so, never an empty node).
      if (role === 'iframe') {
        let other = false;
        try { other = !el.contentDocument; } catch { other = true; }
        if (other) states.push('other-site');
      }
      if (states.length) node.states = states;
      if (el.localName === 'select' && !el.multiple) { const o = el.options[el.selectedIndex]; if (o) node.choice = clip(o.label || o.text, args.nameMax); }
      // Described as a field, for core's sensitiveField: inputs, text areas, selects (a card's expiry month), and any
      // other text field (a contenteditable, a role=textbox), whose type is text.
      if (isField(el) || TYPED.has(role)) node.field = fieldOf(el);
      if (actable) {
        if (keep.length >= args.maxRefs) cut.refs = true;
        else { node.key = keep.length; keep.push({ ref: new WeakRef(el), role, name: node.name, parts: shapeParts(el, chain ? chain.near : NO_NEAR), chain }); }
      }
      nodes.push(node);
      // A frame is listed, never entered; a field's inside is what's typed in it (or its options); an acted-on
      // element's words are its name.
      if (role === 'iframe' || isField(el) || TYPED.has(role)) continue;
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
  if (document.designMode === 'on' || start.isContentEditable || document.documentElement.isContentEditable) {
    const startName = nameOf(start, 'textbox');
    const node = { depth: 0, role: 'textbox', name: startName, sid: sidOf(start, sigOf('textbox', startName, itemsOf(start))) };
    const states = statesOf(start, 'textbox');
    if (states.length) node.states = states;
    node.field = fieldOf(start);
    if (shown(start)) { node.key = keep.length; keep.push({ ref: new WeakRef(start), role: 'textbox', name: node.name, items: itemsOf(start), path: refPath(start), shape: refShape(start) }); }
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
  const read = { token: args.token, url: location.href, keep, finish: null, finishMs: 0 };
  const finish = () => {
    if (!pending) return;
    pending = false;
    // Another snapshot since (its refs replace these): nothing to keep.
    const began = performance.now();
    let whole = !(cut.refs || cut.elements || cut.time);
    try {
      for (const k of keep) {
        if (!k.chain) continue;
        k.items = itemsAt(k.chain);
        k.path = placeOf(k.chain);
        k.shape = shapeOf(k.parts);
      }
    } catch { whole = false; }
    // Found again only if nothing else here looked like it: its role, name, items, place and shape unique among the
    // snapshot's own, and the snapshot whole (never cut short: what it didn't see could be its twin). Its items stay
    // either way: every step checks them (act.ts).
    const counts = new Map();
    for (const k of keep) { delete k.chain; delete k.parts; k.sig = JSON.stringify([k.role, k.name, k.items, k.path, k.shape]); counts.set(k.sig, (counts.get(k.sig) || 0) + 1); }
    for (const k of keep) {
      if (!whole || counts.get(k.sig) !== 1) { delete k.path; delete k.shape; }
      delete k.sig;
    }
    // (Its cost, for the budgets journey.)
    read.finishMs = performance.now() - began;
  };
  read.finish = finish;
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
export function waitScript(want: WaitFor, ms: number): string {
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
        let role = roleNow(el);
        if (!role && !keyed && pointerGeneric(el)) role = 'generic';
        // One that can be acted on counts only when it's on screen, as the snapshot gives it a ref (S-5).
        if (args.role !== undefined && role === args.role && nameOf(el, role) === args.name && (!(ACTED.has(role) || role === 'generic') || shown(el))) { found = true; return; }
        // A field's inside is what's typed in it: never looked at. A frame's is its fallback, never shown (S-5).
        if (isField(el) || TYPED.has(role) || el.localName === 'iframe' || el.localName === 'frame') continue;
        const inner = keyed || ACTED.has(role) || role === 'generic';
        if (el.shadowRoot) { roots.add(el.shadowRoot); walk(el.shadowRoot, inner); }
        walk(el, inner);
      }
    };
    walk(document.body || document.documentElement, false);
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
export async function snapshotPage(contents: WebContents, owner: string, token: string, pinned = true): Promise<SnapshotRead | null> {
  if (contents.isDestroyed()) return null;
  return cleanSnapshotRead(await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: snapshotScript(owner, token, pinned) }]), null, SNAPSHOT_MS));
}
