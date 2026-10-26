/**
 * Duet fills forms, in the page (decision D16; ARCHITECTURE.md §11.6). Three
 * scripts, run in Duet's isolated world (4400) only when asked, so page
 * scripts can neither see nor tamper with them and nothing stays behind
 * between fills but this world's own notes:
 *
 * - **Read**: the main frame's fields on screen (open shadow roots too, never
 *   a frame's), described by structure: type, name, autocomplete, label,
 *   placeholder, required, maxlength, choices. Never a value, a checked state,
 *   which option is selected, or a text area's text; a label's words skip any
 *   field inside it. Bounded (core's DUET_FORM_SCAN, DUET_FORM_SCAN_MS), so a
 *   page with 5,000 inputs answers in a moment. Each field is kept by a
 *   WeakRef and its description, under a token main made for this read.
 * - **Fill**: only fields of that read, all checked against their
 *   descriptions before anything is written (one changed, and nothing is),
 *   and each again right before it's written: one an earlier field's events
 *   changed (a country's states, or a field swapped for a password field) is
 *   left as it is and named back to main. The native setter from this world (a framework's
 *   own setter on the element lives in the page's world, so it doesn't see
 *   the change and its next input event counts), then `input` and `change`,
 *   and for checkboxes and radios the `click` React listens for (a plain
 *   Event, so the browser doesn't toggle it back). What was there before
 *   stays here, in the page's renderer, for Undo: it never reaches main.
 *   Each field is outlined in the chord's accent for a moment (the Web
 *   Animations API: no attribute, class or element is added to the page),
 *   and the first is scrolled into view.
 * - **Undo**: puts back each field that still holds what Chord put there.
 *
 * Plain JavaScript source, as Duet's extractor is: bundling may rename or
 * wrap functions in ways a page can't run. Arguments go in as JSON.
 */
import {
  cleanFormPage,
  DUET_FORM_MAX_CONTROLS,
  DUET_FORM_MAX_OPTIONS,
  DUET_FORM_SCAN,
  DUET_FORM_SCAN_MS,
  type FillWrite,
  type FormControl,
} from '@chord/core';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { DUET_WORLD } from './extract';

/** How long a read or a fill may take: a busy page answers within it; a hung one is a refusal, not a turn that never ends. */
const FORM_MS = 5000;

/** What describes a field, shared by the read and the fill (which checks a field is still as it was read). */
const FORM_LIB = String.raw`
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
  const NO_WORDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const byId = (el, id) => { const root = el.getRootNode(); return typeof root.getElementById === 'function' ? root.getElementById(id) : null; };
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // On screen: not hidden by CSS, at least a few pixels, and not put off the page's top or left (scrolled past is fine).
  const shown = (el) => {
    if (el.hidden || el.closest('[inert]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (getComputedStyle(el).position === 'fixed') return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    return r.right + scrollX > 0 && r.bottom + scrollY > 0;
  };
  // A field's labels, as el.labels finds them (label[for] its id, or a label it's the first field in), from one map of
  // each tree's label[for]s. el.labels walks the whole document the first time each field asks: 46 ms for 300 fields
  // on a page of 5,000 (measured 2026-10-25, the Linux container), three times this whole read.
  const forLabels = new Map();
  const LABELABLE = 'input:not([type=hidden]), select, textarea, button, meter, output, progress';
  const labelsOf = (el) => {
    const root = el.getRootNode();
    let byFor = forLabels.get(root);
    if (!byFor) {
      byFor = new Map();
      for (const l of root.querySelectorAll('label[for]')) { const id = l.getAttribute('for'); if (!byFor.has(id)) byFor.set(id, []); byFor.get(id).push(l); }
      forLabels.set(root, byFor);
    }
    const labels = el.id && byFor.has(el.id) ? byFor.get(el.id).filter((l) => byId(l, el.id) === el) : [];
    const around = el.parentElement && el.parentElement.closest('label');
    if (around && !around.hasAttribute('for') && around.querySelector(LABELABLE) === el) labels.push(around);
    return labels;
  };
  // A checkbox or radio styled by its label (the box itself hidden) counts when its label shows.
  const visibleField = (el, type) => shown(el) || ((type === 'checkbox' || type === 'radio') && labelsOf(el).some(shown));
  const typeOf = (el) => (el.localName === 'textarea' ? 'textarea' : String(el.type || '').toLowerCase());
  // A label's words: its text, never a field's value inside it (a text area's text is its value), nor an editor's.
  const words = (node) => {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (out.length > 240) return;
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !NO_WORDS.has(c.tagName) && !c.isContentEditable && !c.hidden && getComputedStyle(c).display !== 'none') walk(c);
      }
    };
    walk(node);
    return clip(out, 120);
  };
  const labelOf = (el) => {
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
    const by = clip(ids.map((id) => byId(el, id)).filter(Boolean).map(words).join(' '), 120);
    if (by) return by;
    const aria = clip(el.getAttribute('aria-label'), 120);
    if (aria) return aria;
    const labels = labelsOf(el).map(words).filter(Boolean);
    if (labels.length) return clip(labels.join(' '), 120);
    return clip(el.getAttribute('title'), 120);
  };
  const enabledOptions = (select) => [...select.options].filter((o) => !o.disabled);
  const describe = (el, type) => {
    const select = el.localName === 'select';
    const options = select ? enabledOptions(el) : null;
    return {
      type,
      name: clip(el.getAttribute('name'), 60),
      id: clip(el.id, 60),
      autocomplete: clip(el.getAttribute('autocomplete'), 80).toLowerCase(),
      label: labelOf(el),
      placeholder: clip(el.getAttribute('placeholder'), 100),
      required: el.required === true,
      visible: visibleField(el, type),
      disabled: el.matches(':disabled'),
      readOnly: el.readOnly === true,
      maxLength: !select && el.maxLength >= 0 ? el.maxLength : null,
      options: options ? (options.length > MAX_OPTIONS ? null : options.map((o) => clip(o.label || o.value, 100))) : null,
    };
  };
  // A radio group as one field: its legend or radiogroup's name, each enabled button on screen by its label.
  const groupLabel = (radio) => {
    const group = radio.closest('[role=radiogroup]');
    if (group) { const l = labelOf(group); if (l) return l; }
    const legend = radio.closest('fieldset') && radio.closest('fieldset').querySelector(':scope > legend');
    return legend ? words(legend) : '';
  };
  const describeGroup = (radios) => ({
    type: 'radio',
    name: clip(radios[0].getAttribute('name'), 60),
    id: '',
    autocomplete: clip(radios[0].getAttribute('autocomplete'), 80).toLowerCase(),
    label: groupLabel(radios[0]) || clip(radios[0].getAttribute('name'), 60),
    placeholder: '',
    required: radios.some((r) => r.required),
    visible: radios.every((r) => visibleField(r, 'radio')),
    disabled: radios.some((r) => r.matches(':disabled')),
    readOnly: false,
    maxLength: null,
    options: radios.length > MAX_OPTIONS ? null : radios.map((r) => clip(labelOf(r) || r.value, 100)),
  });
  // What a field must still be when it's filled: exactly as it was read, its type, buttons and options included,
  // each read from the element as it is now (a field turned into a password field doesn't match).
  const signature = (item) => {
    const els = item.refs.map((r) => r.deref());
    if (els.some((el) => !el || !el.isConnected)) return null;
    return item.radio ? JSON.stringify([describeGroup(els), els.map((el) => describe(el, typeOf(el)))]) : JSON.stringify(describe(els[0], typeOf(els[0])));
  };
`;

/** The read: fields on screen in the main frame, in order, with a radio group where its first button is. */
function readScript(token: string): string {
  const args = { token, scan: DUET_FORM_SCAN, ms: DUET_FORM_SCAN_MS, max: DUET_FORM_MAX_CONTROLS };
  return String.raw`((args) => {
  const MAX_OPTIONS = ${DUET_FORM_MAX_OPTIONS};
  ${FORM_LIB}
  const started = performance.now();
  // The page's fields, then those in open shadow roots (a frame's are never reached).
  const all = [...document.querySelectorAll('input, textarea, select')];
  const roots = [];
  let seen = 0;
  const findRoots = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (++seen > 50000) return;
      if (el.shadowRoot) { roots.push(el.shadowRoot); findRoots(el.shadowRoot); }
    }
  };
  findRoots(document);
  for (const root of roots) all.push(...root.querySelectorAll('input, textarea, select'));
  const forms = [];
  const formIndex = new Map();
  const formLabel = (f) => {
    const aria = clip(f.getAttribute('aria-label'), 80);
    if (aria) return aria;
    const head = f.querySelector('legend, h1, h2, h3, h4');
    return head ? clip(words(head), 80) : clip(f.getAttribute('name') || f.id, 60);
  };
  const formOf = (el) => {
    const f = el.form;
    if (!f) return -1;
    if (!formIndex.has(f)) { formIndex.set(f, forms.length); forms.push(formLabel(f)); }
    return formIndex.get(f);
  };
  const items = new Map();
  const controls = [];
  const groups = new Map();
  let truncated = false;
  let looked = 0;
  for (const el of all) {
    if (++looked > args.scan || controls.length >= args.max || (looked % 50 === 0 && performance.now() - started > args.ms)) { truncated = true; break; }
    const type = typeOf(el);
    if (SKIP_TYPES.has(type) || !visibleField(el, type)) continue;
    if (type === 'radio') {
      if (el.matches(':disabled')) continue;
      const name = el.getAttribute('name');
      const group = name ? formOf(el) + '\u0000' + name : null;
      if (group && groups.has(group)) { groups.get(group).radios.push(el); continue; }
      const entry = { key: controls.length, radios: [el], form: formOf(el) };
      if (group) groups.set(group, entry);
      controls.push(entry);
      continue;
    }
    const description = describe(el, type);
    const key = controls.length;
    items.set(key, { refs: [new WeakRef(el)], radio: false, sig: JSON.stringify(description) });
    controls.push({ key, ...description, form: formOf(el) });
  }
  // Radio groups are described once all their buttons are in.
  for (let i = 0; i < controls.length; i++) {
    const entry = controls[i];
    if (!entry.radios) continue;
    const item = { refs: entry.radios.map((r) => new WeakRef(r)), radio: true, sig: '' };
    item.sig = signature(item);
    items.set(entry.key, item);
    controls[i] = { key: entry.key, ...describeGroup(entry.radios), form: entry.form };
  }
  // A few reads are kept, so an earlier card still fills after Duet reads again.
  const reads = (globalThis.__chordForms = globalThis.__chordForms || new Map());
  reads.set(args.token, { url: location.href.split('#')[0], items });
  while (reads.size > 4) reads.delete(reads.keys().next().value);
  return { url: location.href, forms, controls, truncated };
})(${JSON.stringify(args)})`;
}

/** What a fill does with each field it writes, and how to put it back: values stay in this world. */
const WRITE_LIB = String.raw`
  const proto = (el) => (el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
  const setter = (el, property) => Object.getOwnPropertyDescriptor(proto(el), property).set;
  // What a person's typing or clicking sends: React listens for click on checkboxes and radios, and input on
  // text; Vue and Angular for input and change. A plain Event named click: a MouseEvent would toggle it again.
  const fire = (el, toggled) => {
    if (toggled) el.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // A field's state, as Undo needs it: text, the selected option, checked or not, the radio checked.
  const stateOf = (kind, els) =>
    kind === 'checkbox' ? els[0].checked : kind === 'radio' ? els.findIndex((r) => r.checked) : kind === 'select' ? els[0].selectedIndex : els[0].value;
  const put = (kind, els, value) => {
    const el = els[0];
    if (kind === 'checkbox') {
      if (el.checked === value) return;
      setter(el, 'checked').call(el, value);
      fire(el, true);
    } else if (kind === 'radio') {
      const now = els.findIndex((r) => r.checked);
      if (now === value) return;
      // Back to none checked (-1): the one Chord checked is unchecked.
      const target = value >= 0 ? els[value] : els[now];
      if (!target) return;
      setter(target, 'checked').call(target, value >= 0);
      fire(target, true);
    } else if (kind === 'select') {
      if (el.selectedIndex === value) return;
      setter(el, 'selectedIndex').call(el, value);
      fire(el, false);
    } else {
      if (el.value === value) return;
      setter(el, 'value').call(el, value);
      fire(el, false);
    }
  };
`;

export interface FillHighlight {
  /** The chord's accent, as CSS. */
  color: string;
  ms: number;
  stagger: number;
  easing: string;
}

/**
 * The fill: every field checked before anything is written (one that doesn't match, and nothing is), and each
 * again just before it is. One that stops matching as earlier fields' events run (a country's list of states)
 * is left as it is, never guessed at, and named back to main by its handle.
 */
function fillScript(args: { token: string; writes: FillWrite[]; undo: string; highlight: FillHighlight }): string {
  return String.raw`((args) => {
  const MAX_OPTIONS = ${DUET_FORM_MAX_OPTIONS};
  ${FORM_LIB}
  ${WRITE_LIB}
  const read = globalThis.__chordForms && globalThis.__chordForms.get(args.token);
  if (!read || read.url !== location.href.split('#')[0]) return { ok: false, why: 'navigated' };
  const targets = [];
  let gone = 0;
  for (const w of args.writes) {
    const item = read.items.get(w.key);
    const sig = item ? signature(item) : null;
    if (sig === null) { gone++; continue; }
    if (sig !== item.sig) return { ok: false, why: 'changed' };
    targets.push({ w, item, els: item.refs.map((r) => r.deref()) });
  }
  if (gone) return { ok: false, why: gone === args.writes.length ? 'gone' : 'changed' };
  const done = [];
  const skipped = [];
  for (const t of targets) {
    const kind = t.w.kind;
    const select = kind === 'select' ? enabledOptions(t.els[0])[t.w.choice] : null;
    if (signature(t.item) !== t.item.sig || (kind === 'select' && !select)) { skipped.push(t.w.key); continue; }
    const value = kind === 'checkbox' ? t.w.checked === true : kind === 'radio' ? t.w.choice : kind === 'select' ? select.index : String(t.w.text);
    const before = stateOf(kind, t.els);
    put(kind, t.els, value);
    done.push({ kind, els: t.els, before, after: stateOf(kind, t.els), w: t.w });
  }
  if (done.length === 0) return { ok: false, why: 'changed' };
  // What was there before stays here, for Undo, with what Chord put in: a field you've changed since is left alone.
  const undos = (globalThis.__chordFillUndo = globalThis.__chordFillUndo || new Map());
  undos.set(args.undo, { url: read.url, entries: done.map((d) => ({ kind: d.kind, refs: d.els.map((el) => new WeakRef(el)), before: d.before, after: d.after })) });
  while (undos.size > 10) undos.delete(undos.keys().next().value);
  // Where the values went: each field outlined for a moment (a checkbox or radio by its label if the box is hidden).
  const h = args.highlight;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const marks = done.map((d) => {
    const el = d.w.kind === 'radio' ? d.els[Math.max(0, d.w.choice)] : d.els[0];
    return shown(el) ? el : labelsOf(el).find(shown) || el;
  });
  const ring = (color) => ({ outline: '2px solid ' + color, outlineOffset: '2px' });
  marks.forEach((el, i) => {
    el.animate([ring('transparent'), { ...ring(h.color), offset: 0.1 }, { ...ring(h.color), offset: 0.7 }, ring('transparent')], {
      duration: h.ms,
      delay: reduce ? 0 : Math.min(i, 6) * h.stagger,
      easing: h.easing,
    });
  });
  const first = marks[0];
  if (first) {
    const r = first.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }
  return { ok: true, filled: done.length, skipped };
})(${JSON.stringify(args)})`;
}

/** Undo: each field back as it was, unless it no longer holds what Chord put there (you've changed it since). */
function undoScript(args: { undo: string }): string {
  return String.raw`((args) => {
  ${WRITE_LIB}
  const undos = globalThis.__chordFillUndo;
  const fill = undos && undos.get(args.undo);
  if (!fill || fill.url !== location.href.split('#')[0]) return { ok: false };
  undos.delete(args.undo);
  let restored = 0;
  let kept = 0;
  for (const e of fill.entries.reverse()) {
    const els = e.refs.map((r) => r.deref());
    if (els.some((el) => !el || !el.isConnected) || stateOf(e.kind, els) !== e.after) { kept++; continue; }
    put(e.kind, els, e.before);
    restored++;
  }
  return { ok: true, restored, kept };
})(${JSON.stringify(args)})`;
}

export interface FormPage {
  url: string;
  forms: string[];
  controls: FormControl[];
  truncated: boolean;
}

/** Read the tab's form; null if the page doesn't answer in time or the answer isn't what the script returns. */
export async function readFormPage(contents: WebContents, token: string): Promise<FormPage | null> {
  if (contents.isDestroyed()) return null;
  return cleanFormPage(await pageCall(contents.executeJavaScriptInIsolatedWorld(DUET_WORLD, [{ code: readScript(token) }]), null, FORM_MS));
}

/** What a fill did: how many fields it filled, and the handles of any it left because they changed as it went. */
export type FillOutcome = { ok: true; filled: number; skipped: number[] } | { ok: false; why: 'navigated' | 'gone' | 'changed' | 'no-answer' };

/** Fill the fields of the read `token` names; nothing is written unless every field is still as it was read. */
export async function fillFormPage(contents: WebContents, args: { token: string; writes: FillWrite[]; undo: string; highlight: FillHighlight }): Promise<FillOutcome> {
  if (contents.isDestroyed()) return { ok: false, why: 'navigated' };
  const result = (await pageCall(contents.executeJavaScriptInIsolatedWorld(DUET_WORLD, [{ code: fillScript(args) }]), null, FORM_MS)) as { ok?: unknown; filled?: unknown; skipped?: unknown; why?: unknown } | null;
  if (result?.ok === true && typeof result.filled === 'number') {
    return { ok: true, filled: result.filled, skipped: Array.isArray(result.skipped) ? result.skipped.filter((k): k is number => typeof k === 'number') : [] };
  }
  const why = result?.why;
  return { ok: false, why: why === 'navigated' || why === 'gone' || why === 'changed' ? why : 'no-answer' };
}

/** Undo a fill: how many fields went back, and how many were kept because they'd changed since. Null if the page has moved on. */
export async function undoFillPage(contents: WebContents, undo: string): Promise<{ restored: number; kept: number } | null> {
  if (contents.isDestroyed()) return null;
  const result = (await pageCall(contents.executeJavaScriptInIsolatedWorld(DUET_WORLD, [{ code: undoScript({ undo }) }]), null, FORM_MS)) as { ok?: unknown; restored?: unknown; kept?: unknown } | null;
  return result?.ok === true && typeof result.restored === 'number' && typeof result.kept === 'number' ? { restored: result.restored, kept: result.kept } : null;
}

/** For tests: the scripts as they run. */
export const formScripts = { read: readScript, fill: fillScript, undo: undoScript };
