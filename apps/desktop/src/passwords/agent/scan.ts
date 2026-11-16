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
import { ASSISTANT_FORM_SCAN, ASSISTANT_FORM_SCAN_MS, PASSWORDS_MAX_FORMS, type FormWords, type PasswordField, type PasswordFormRecord } from '@chord/core';

/** The most credential forms the agent reports in one `forms` message (the schema's limit, which keeps it under the message limit). */
export const MAX_REPORTED_FORMS = PASSWORDS_MAX_FORMS;

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
  /** Only these controls, in this order (one form's own fields, for saving): no other field's value is read. */
  readonly only?: readonly Element[];
  /** For tests: a clock. */
  readonly now?: () => number;
}

/** Controls that are never credentials, and never read. */
export const SKIP_TYPES: ReadonlySet<string> = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);

/*
 * A <form>'s own properties can be clobbered by the controls in it: <input name="getAttribute">
 * makes form.getAttribute that input. Everything read from a form goes through the prototypes.
 */
const elementProto = Element.prototype;
const nodeProto = Node.prototype;
const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
const parentGetter = getter(nodeProto, 'parentElement');
const previousGetter = getter(elementProto, 'previousElementSibling');
const tagGetter = getter(elementProto, 'tagName');
const textGetter = getter(nodeProto, 'textContent');
const attrOf = (el: Element, name: string): string | null => elementProto.getAttribute.call(el, name);
const allIn = (el: Element | Document, selector: string): Element[] => [...(el instanceof Document ? el.querySelectorAll(selector) : elementProto.querySelectorAll.call(el, selector))];
const parentOf = (el: Element): Element | null => parentGetter.call(el) as Element | null;
const tagOf = (el: Element): string => String(tagGetter.call(el));
const textOf = (el: Element): string => String(textGetter.call(el) ?? '');
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
    node = parentOf(node);
    if (node && (tagOf(node) === 'FORM' || tagOf(node) === 'BODY')) break;
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
  for (let depth = 0; depth < 3 && node && tagOf(node) !== 'BODY'; depth++, node = parentOf(node)) {
    for (let s = previousGetter.call(node) as Element | null, n = 0; s && n < 8; s = previousGetter.call(s) as Element | null, n++) {
      if (elementProto.matches.call(s, HEADINGS)) return s;
      const inside = allIn(s, HEADINGS);
      if (inside.length) return inside[inside.length - 1]!;
    }
  }
  return null;
}

const buttonText = (b: Element) => clip(tagOf(b) === 'INPUT' ? (b as HTMLInputElement).value : textOf(b), 60);
/** A button that submits its form: `<button>` without a type or of type submit, `input[type=submit|image]`. */
export const isSubmit = (b: Element) => (tagOf(b) === 'BUTTON' ? ((b as HTMLButtonElement).type || 'submit') === 'submit' : tagOf(b) === 'INPUT' && /^(submit|image)$/i.test((b as HTMLInputElement).type));

/** Words on a button that isn't the form's submit: a password's show or hide toggle, help and recovery links, cancel, and signing in with another site. */
const NOT_SUBMIT = /\b(show|hide|reveal|toggle|view|forgot|forgotten|cancel|close|back|help)\b|\beye\b|\bwith (google|apple|facebook|microsoft|github|twitter|x|linkedin)\b/i;

/**
 * The button a click on `target` submits a credential form with, or null (S17 §6, step 2). In a
 * `<form>`, only its submit buttons count; outside one, any button in the fields' scope. Never a
 * button that reads as a show-password toggle, help or recovery (by its words, `aria-pressed`, or
 * `aria-controls` naming the password field), nor one inside the password field's own wrapper.
 */
export function submitButtonFor(target: Element, password: Element | null, inForm: boolean): Element | null {
  const button = target.closest(inForm ? 'button, input[type=submit], input[type=image]' : 'button, input[type=submit], input[type=button], input[type=image], [role=button]');
  if (!button) return null;
  if (inForm && !isSubmit(button)) return null;
  const words = `${buttonText(button)} ${attrOf(button, 'aria-label') ?? ''} ${attrOf(button, 'title') ?? ''}`;
  if (NOT_SUBMIT.test(words) || button.hasAttribute('aria-pressed')) return null;
  if (password) {
    if (button.contains(password)) return null;
    const controls = (attrOf(button, 'aria-controls') ?? '').split(/\s+/);
    if (password.id && controls.includes(password.id)) return null;
    // The field's own wrapper (a box holding only it and its eye): a button there toggles it.
    const wrapper = parentOf(password);
    if (wrapper && tagOf(wrapper) !== 'FORM' && wrapper.contains(button) && allIn(wrapper, 'input, select, textarea').length === 1) return null;
    if (!inForm) {
      const scope = formlessScope(password);
      if (!scope || !scope.contains(button)) return null;
    }
  }
  return button;
}

/** The closest ancestor of `el` (up to 6 levels) that holds a button: a formless form's scope. */
export function formlessScope(el: Element): Element | null {
  let node = el.parentElement;
  for (let depth = 0; depth < 6 && node && node.tagName !== 'BODY'; depth++, node = node.parentElement) {
    if (node.querySelector('button, input[type=submit], input[type=button], [role=button]')) return node;
  }
  return null;
}

const NO_WORDS_AT_ALL: FormWords = { buttons: [], submits: [], headings: [], attrs: '', title: '' };

function formWords(doc: Document, form: HTMLFormElement | null, firstPassword: Element | null): FormWords {
  // A form a page has made odd enough to throw (a getter that throws, say) is read without words, not dropped.
  try {
    // A formless form's buttons are those near its password field, else the page's.
    const scope = form ?? (firstPassword && formlessScope(firstPassword)) ?? doc.body;
    const all = scope ? allIn(scope, BUTTONS).slice(0, 40) : [];
    const buttons = all.map(buttonText).filter(Boolean);
    const submits = (form ? all.filter(isSubmit) : all.filter((b) => tagOf(b) !== 'A')).map(buttonText).filter(Boolean).slice(0, 5);
    const headings = allIn(form ?? doc, HEADINGS)
      .slice(0, 10)
      .map((h) => clip(textOf(h), 80));
    // A form's own title is often just outside it: the nearest heading before it, within a few levels.
    if (form && !headings.length) {
      const before = headingBefore(form);
      if (before) headings.push(clip(textOf(before), 80));
    }
    return {
      buttons,
      submits,
      headings,
      attrs: form ? clip(['id', 'name', 'class', 'action'].map((k) => attrOf(form, k) ?? '').join(' '), 300) : '',
      title: clip(doc.title, 120),
    };
  } catch {
    return { ...NO_WORDS_AT_ALL, title: clip(doc.title, 120) };
  }
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
  const controls = (options.only ?? doc.querySelectorAll('input, select, textarea')) as Iterable<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
  for (const el of controls) {
    if (++seen > ASSISTANT_FORM_SCAN || now() - started > ASSISTANT_FORM_SCAN_MS) break;
    const type = controlType(el);
    if (SKIP_TYPES.has(type)) continue;
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
