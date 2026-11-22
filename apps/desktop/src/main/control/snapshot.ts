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
  // The role an element has now, editability first (an editor is a typed field whatever its tag or role).
  const roleNow = (el) => {
    const own = String(el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    return el.isContentEditable ? (TYPED.has(own) ? own : 'textbox') : roleOf(el);
  };
`;

/** `owner`: whose snapshot it is (the agent's gate id), so each keeps its own latest one; `token`: this read's. */
export function snapshotScript(owner: string, token: string): string {
  const args = { owner, token, scan: SNAPSHOT_SCAN, ms: SNAPSHOT_SCAN_MS, maxRefs: SNAPSHOT_MAX_REFS, nameMax: SNAPSHOT_NAME_MAX, owners: SNAPSHOT_OWNERS };
  return String.raw`((args) => {
  ${SNAPSHOT_LIB}
  const started = performance.now();
  const nodes = [];
  const keep = [];
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
  const walk = (parent, depth, keyed, named) => {
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
      if (!role && !keyed && getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')) role = 'generic';
      if (!role) {
        if (el.shadowRoot) walk(el.shadowRoot, depth, keyed, named);
        walk(el, depth, keyed, named);
        continue;
      }
      const acted = ACTED.has(role) || role === 'generic';
      // An acted-on element must be on screen to be acted on (forms' rule: at least a few pixels, not put off the page).
      const actable = acted && (isField(el) ? visibleField(el, typeOf(el)) : shown(el));
      const node = { depth, role, name: nameOf(el, role) };
      if (role === 'heading') node.level = Number(el.getAttribute('aria-level')) || Number((el.localName.match(/^h([1-6])$/) || [])[1]) || 2;
      const states = statesOf(el, role);
      if (states.length) node.states = states;
      if (el.localName === 'select' && !el.multiple) { const o = el.options[el.selectedIndex]; if (o) node.choice = clip(o.label || o.text, args.nameMax); }
      // Described as a field, for core's sensitiveField: inputs, text areas, selects (a card's expiry month), and any
      // other text field (a contenteditable, a role=textbox), whose type is text.
      if (isField(el) || TYPED.has(role)) node.field = { type: isField(el) ? typeOf(el) : 'text', autocomplete: clip(el.getAttribute('autocomplete'), 80).toLowerCase(), name: clip(el.getAttribute('name'), 60), id: clip(el.id, 60), label: labelOf(el), placeholder: clip(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'), 100) };
      if (actable) {
        if (keep.length >= args.maxRefs) cut.refs = true;
        else { node.key = keep.length; keep.push({ ref: new WeakRef(el), role, name: node.name }); }
      }
      nodes.push(node);
      // A frame is listed, never entered; a field's inside is what's typed in it (or its options); an acted-on
      // element's words are its name.
      if (role === 'iframe' || isField(el) || TYPED.has(role)) continue;
      const inside = named || acted || role === 'heading';
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, keyed || acted, inside);
      walk(el, depth + 1, keyed || acted, inside);
    }
  };
  // The walk's start, checked as every element is: a page that's all editor (<body contenteditable>, <html
  // contenteditable>, designMode, the data: notepad) is one typed field, named by its labels alone, never walked.
  const start = document.body || document.documentElement;
  if (document.designMode === 'on' || start.isContentEditable || document.documentElement.isContentEditable) {
    const node = { depth: 0, role: 'textbox', name: nameOf(start, 'textbox') };
    const states = statesOf(start, 'textbox');
    if (states.length) node.states = states;
    node.field = { type: 'text', autocomplete: clip(start.getAttribute('autocomplete'), 80).toLowerCase(), name: clip(start.getAttribute('name'), 60), id: clip(start.id, 60), label: labelOf(start), placeholder: clip(start.getAttribute('aria-placeholder'), 100) };
    if (shown(start)) { node.key = keep.length; keep.push({ ref: new WeakRef(start), role: 'textbox', name: node.name }); }
    nodes.push(node);
  } else walk(start, 0, false, false);
  // Each owner's latest snapshot, its own: another agent's snapshot of this page never takes it away.
  const reads = (globalThis.__chordSnapshots = globalThis.__chordSnapshots || new Map());
  reads.delete(args.owner);
  reads.set(args.owner, { token: args.token, url: location.href, keep });
  while (reads.size > args.owners) reads.delete(reads.keys().next().value);
  return { url: location.href, title: document.title, nodes, cut };
})(${JSON.stringify(args)})`;
}

/** A snapshot of the page for `owner`, or null if it couldn't be taken (gone, hung, or not a page). */
export async function snapshotPage(contents: WebContents, owner: string, token: string): Promise<SnapshotRead | null> {
  if (contents.isDestroyed()) return null;
  return cleanSnapshotRead(await pageCall(contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: snapshotScript(owner, token) }]), null, SNAPSHOT_MS));
}
