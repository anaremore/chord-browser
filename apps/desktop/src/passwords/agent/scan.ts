/**
 * The passwords agent's scan (S17 §4): a document's form controls turned into the field
 * records the classifier reads, grouped as Chromium groups them (by owning `<form>`, with
 * every field outside one in one more form). It only reads: no attribute, class, element,
 * style or listener is added to the page.
 *
 * Bounded like the assistant's read (core's ASSISTANT_FORM_SCAN, ASSISTANT_FORM_SCAN_MS):
 * at most 2,000 controls and 250 ms. Values are read only when `values` is set, and
 * they never leave the page's renderer.
 */
import { ASSISTANT_FORM_SCAN, ASSISTANT_FORM_SCAN_MS, type FormWords, type PasswordField, type PasswordFormRecord } from '@chord/core';

/** One form as scanned: its record for the classifier, and each field's element at the same index. */
export interface ScannedForm {
  readonly form: HTMLFormElement | null;
  readonly record: PasswordFormRecord;
  readonly elements: readonly HTMLElement[];
}

export interface ScanOptions {
  /** Read each field's value (saving). Off for filling and the corpus. */
  readonly values?: boolean;
  /** Fields you typed in, and fields Chord filled, since the page loaded. */
  readonly typed?: WeakSet<Element>;
  readonly filled?: WeakSet<Element>;
  /** Keys for elements, kept across scans of one document so a form's fields keep theirs. */
  readonly keys?: WeakMap<Element, number>;
  readonly nextKey?: { value: number };
  /** For tests: a clock. */
  readonly now?: () => number;
}

/** Controls that are never credentials, and never read. */
const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
const NO_WORDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG']);
const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a';

const clip = (s: string | null | undefined, n: number): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) : t;
};

/** A node's text, never a field's value inside it (a text area's text is its value). */
function words(node: Node, max: number): string {
  let out = '';
  const walk = (n: Node) => {
    for (const c of n.childNodes) {
      if (out.length > max) return;
      if (c.nodeType === Node.TEXT_NODE) out += ` ${c.nodeValue ?? ''}`;
      else if (c.nodeType === Node.ELEMENT_NODE && !NO_WORDS.has((c as Element).tagName.toUpperCase())) walk(c);
    }
  };
  walk(node);
  return clip(out, max);
}

/** Text just before a field, as Chromium's `InferLabelFromPrevious` and its neighbours do, roughly. */
function previousText(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    for (let s = node.previousSibling; s; s = s.previousSibling) {
      if (s.nodeType === Node.ELEMENT_NODE && /^(INPUT|SELECT|TEXTAREA)$/.test((s as Element).tagName)) return '';
      const t = s.nodeType === Node.TEXT_NODE ? clip(s.nodeValue, 100) : s.nodeType === Node.ELEMENT_NODE ? words(s, 100) : '';
      if (t) return t;
    }
    node = node.parentElement;
    if (node && (node.tagName === 'FORM' || node.tagName === 'BODY')) break;
  }
  return '';
}

/** On screen: rendered, opaque enough, at least 4 px each way (as the assistant's read and §5's fill check). */
export function isShown(el: Element): boolean {
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4;
}

/** Blink's `IsFocusable`, roughly: rendered, not `visibility: hidden`, not disabled or inert. */
function isFocusable(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  if (el.disabled || el.closest('[inert]')) return false;
  return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true });
}

/** A control's type as the classifier reads it: an input's, lower case, or its tag. */
export function controlType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' ? String((el as HTMLInputElement).type || 'text').toLowerCase() : tag;
}

/**
 * Each tree's `label[for]`s, mapped once: `el.labels` walks the whole document the first time
 * each field asks (the assistant's read measured it three times its whole cost; §11.6).
 */
function labeller(): (el: HTMLElement) => string {
  const byTree = new Map<Node, Map<string, HTMLLabelElement[]>>();
  return (el) => {
    const root = el.getRootNode() as Document | ShadowRoot;
    let byFor = byTree.get(root);
    if (!byFor) {
      byFor = new Map();
      for (const l of root.querySelectorAll<HTMLLabelElement>('label[for]')) {
        const id = l.htmlFor;
        const list = byFor.get(id);
        if (list) list.push(l);
        else byFor.set(id, [l]);
      }
      byTree.set(root, byFor);
    }
    const labels = el.id ? [...(byFor.get(el.id) ?? [])] : [];
    const around = el.parentElement?.closest('label');
    if (around && !around.htmlFor) labels.push(around);
    const byLabels = clip(labels.map((l) => words(l, 100)).filter(Boolean).join(' '), 100);
    if (byLabels) return byLabels;
    const ids = String(el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    const by = clip(
      ids
        .map((id) => ('getElementById' in root ? root.getElementById(id) : null))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => words(n, 100))
        .join(' '),
      100,
    );
    return by || clip(el.getAttribute('aria-label'), 100) || previousText(el) || clip(el.getAttribute('placeholder'), 100);
  };
}

const HEADINGS = 'h1, h2, h3, legend';

/** The nearest heading before `el`: among its previous siblings (or their insides), then its parents', up to 3 levels. */
function headingBefore(el: Element): Element | null {
  let node: Element | null = el;
  for (let depth = 0; depth < 3 && node && node.tagName !== 'BODY'; depth++, node = node.parentElement) {
    for (let s = node.previousElementSibling, n = 0; s && n < 8; s = s.previousElementSibling, n++) {
      if (s.matches(HEADINGS)) return s;
      const inside = s.querySelectorAll(HEADINGS);
      if (inside.length) return inside[inside.length - 1]!;
    }
  }
  return null;
}

const buttonText = (b: Element) => clip(b.tagName === 'INPUT' ? (b as HTMLInputElement).value : b.textContent, 60);
/** A button that submits its form: `<button>` without a type or of type submit, `input[type=submit|image]`. */
const isSubmit = (b: Element) => (b.tagName === 'BUTTON' ? ((b as HTMLButtonElement).type || 'submit') === 'submit' : b.tagName === 'INPUT' && /^(submit|image)$/i.test((b as HTMLInputElement).type));

/** The closest ancestor of `el` (up to 6 levels) that holds a button: a formless form's scope. */
export function formlessScope(el: Element): Element | null {
  let node = el.parentElement;
  for (let depth = 0; depth < 6 && node && node.tagName !== 'BODY'; depth++, node = node.parentElement) {
    if (node.querySelector('button, input[type=submit], input[type=button], [role=button]')) return node;
  }
  return null;
}

function formWords(doc: Document, form: HTMLFormElement | null, firstPassword: Element | null): FormWords {
  // A formless form's buttons are those near its password field, else the page's.
  const scope = form ?? (firstPassword && formlessScope(firstPassword)) ?? doc.body;
  const all = scope ? [...scope.querySelectorAll(BUTTONS)].slice(0, 40) : [];
  const buttons = all.map(buttonText).filter(Boolean);
  const submits = (form ? all.filter(isSubmit) : all.filter((b) => b.tagName !== 'A')).map(buttonText).filter(Boolean).slice(0, 5);
  const headings = [...(form ?? doc).querySelectorAll(HEADINGS)].slice(0, 10).map((h) => clip(h.textContent, 80));
  // A form's own title is often just outside it: the nearest heading before it, within a few levels.
  if (form && !headings.length) {
    const before = headingBefore(form);
    if (before) headings.push(clip(before.textContent, 80));
  }
  return {
    buttons,
    submits,
    headings,
    // getAttribute, not form.id: a field named "id" clobbers the form's own property.
    attrs: form ? clip(['id', 'name', 'class', 'action'].map((k) => form.getAttribute(k) ?? '').join(' '), 300) : '',
    title: clip(doc.title, 120),
  };
}

/** Scans `doc`'s main tree (not frames or shadow roots: phase 3) into forms. */
export function scanDocument(doc: Document, options: ScanOptions = {}): ScannedForm[] {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const keys = options.keys ?? new WeakMap<Element, number>();
  const nextKey = options.nextKey ?? { value: 1 };
  const labelOf = labeller();
  const groups = new Map<HTMLFormElement | null, { fields: PasswordField[]; elements: HTMLElement[] }>();
  let seen = 0;
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
    if (++seen > ASSISTANT_FORM_SCAN || now() - started > ASSISTANT_FORM_SCAN_MS) break;
    const type = controlType(el);
    if (SKIP.has(type)) continue;
    let key = keys.get(el);
    if (key === undefined) {
      key = nextKey.value++;
      keys.set(el, key);
    }
    const form = el.form instanceof HTMLFormElement ? el.form : null;
    let group = groups.get(form);
    if (!group) groups.set(form, (group = { fields: [], elements: [] }));
    group.fields.push({
      key,
      type,
      id: clip(el.id, 80),
      name: clip(el.getAttribute('name'), 80),
      autocomplete: clip(el.getAttribute('autocomplete'), 80).toLowerCase(),
      label: labelOf(el),
      placeholder: clip(el.getAttribute('placeholder'), 100),
      maxLength: 'maxLength' in el && typeof el.maxLength === 'number' ? el.maxLength : -1,
      readOnly: 'readOnly' in el && el.readOnly === true,
      focusable: isFocusable(el),
      visible: isShown(el),
      userTyped: options.typed?.has(el) ?? false,
      autofilled: options.filled?.has(el) ?? false,
      value: options.values ? String(el.value ?? '') : '',
    });
    group.elements.push(el);
  }
  return [...groups].map(([form, { fields, elements }]) => {
    const firstPassword = elements.find((e) => controlType(e) === 'password') ?? null;
    return { form, record: { fields, words: formWords(doc, form, firstPassword) }, elements };
  });
}
