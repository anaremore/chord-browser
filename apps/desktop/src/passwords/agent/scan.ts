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
import { ASSISTANT_FORM_SCAN, ASSISTANT_FORM_SCAN_MS, PASSWORDS_MAX_FORMS, readsAsSubmit, submitWords, type FormWords, type PasswordField, type PasswordFormRecord } from '@chord/core';

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
const documentProto = Document.prototype;
const bodyGetter = getter(documentProto, 'body');
const titleGetter = getter(documentProto, 'title');
const activeGetter = getter(documentProto, 'activeElement');
/** A document's own properties, which named forms, images and embeds can clobber (`<form name="title">`): read through the prototype. */
export const documentBody = (doc: Document): HTMLElement | null => bodyGetter.call(doc) as HTMLElement | null;
export const documentTitle = (doc: Document): string => String(titleGetter.call(doc) ?? '');
export const activeElementOf = (doc: Document): Element | null => activeGetter.call(doc) as Element | null;
const allIn = (el: Element | Document, selector: string): Element[] => [...(el instanceof Document ? documentProto.querySelectorAll.call(el, selector) : elementProto.querySelectorAll.call(el, selector))];
const contains = (outer: Node, inner: Node): boolean => nodeProto.contains.call(outer, inner);
const parentOf = (el: Element): Element | null => parentGetter.call(el) as Element | null;
const tagOf = (el: Element): string => String(tagGetter.call(el));
const textOf = (el: Element): string => String(textGetter.call(el) ?? '');
const childNodesGetter = getter(nodeProto, 'childNodes');
const nodeTypeGetter = getter(nodeProto, 'nodeType');
const previousSiblingGetter = getter(nodeProto, 'previousSibling');
const childrenOf = (n: Node): NodeListOf<ChildNode> => childNodesGetter.call(n) as NodeListOf<ChildNode>;
const nodeTypeOf = (n: Node): number => Number(nodeTypeGetter.call(n));
const previousOf = (n: Node): Node | null => previousSiblingGetter.call(n) as Node | null;
const NO_WORDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG']);
const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a';

const clip = (s: string | null | undefined, n: number): string => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) : t;
};

/** A node's text, never a field's value inside it (a text area's text is its value). Read through the prototypes (clobbering). */
function words(node: Node, max: number): string {
  let out = '';
  const walk = (n: Node) => {
    for (const c of childrenOf(n)) {
      if (out.length > max) return;
      const type = nodeTypeOf(c);
      if (type === Node.TEXT_NODE) out += ` ${c.nodeValue ?? ''}`;
      else if (type === Node.ELEMENT_NODE && !NO_WORDS.has(tagOf(c as Element).toUpperCase())) walk(c);
    }
  };
  walk(node);
  return clip(out, max);
}

/** Text just before a field, as Chromium's `InferLabelFromPrevious` and its neighbours do, roughly. */
function previousText(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    for (let s = previousOf(node); s; s = previousOf(s)) {
      const type = nodeTypeOf(s);
      if (type === Node.ELEMENT_NODE && /^(INPUT|SELECT|TEXTAREA)$/.test(tagOf(s as Element))) return '';
      const t = type === Node.TEXT_NODE ? clip(s.nodeValue, 100) : type === Node.ELEMENT_NODE ? words(s, 100) : '';
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
      for (const l of (root instanceof Document ? allIn(root, 'label[for]') : [...root.querySelectorAll('label[for]')]) as HTMLLabelElement[]) {
        const id = l.htmlFor;
        const list = byFor.get(id);
        if (list) list.push(l);
        else byFor.set(id, [l]);
      }
      byTree.set(root, byFor);
    }
    // A `label[for]` labels the first element with that id, as the browser has it, and only from outside any form or
    // from the field's own: a page whose sign-in and sign-up forms reuse ids (`password` in both) mustn't give the
    // sign-in field the sign-up's "Choose a password".
    const owner = el.id ? (root instanceof Document ? documentProto.getElementById.call(root, el.id) : root.getElementById(el.id)) : null;
    const ownForm = (el as HTMLInputElement).form ?? null;
    const labels = owner === el ? (byFor.get(el.id) ?? []).filter((l) => (l.closest('form') ?? ownForm) === ownForm) : [];
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
        .map((id) => (root instanceof Document ? documentProto.getElementById.call(root, id) : root.getElementById(id)))
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

/** The most characters, and words, a plain element may say to count as a button: a label, not a sentence. */
const PLAIN_WORDS_MAX = 40;
const PLAIN_WORD_COUNT_MAX = 4;
/** Text that's never a button however it reads: headings, labels, paragraphs. */
const NOT_PLAIN = /^(H[1-6]|LABEL|LEGEND|P|LI|TD|TH|OPTION)$/;

/** Something a person is shown they can press: a `tabindex`, an `onclick`, or the pointer cursor. */
const pressable = (el: Element) =>
  elementProto.hasAttribute.call(el, 'tabindex') || elementProto.hasAttribute.call(el, 'onclick') || getComputedStyle(el).cursor === 'pointer';

/**
 * An element with no button's role that a script signs in with (S17 §6 step 2, phase 3): a `div` or a `span`, at or
 * just above the click, that shows it can be pressed and whose own few words read as the form's submit:
 * Next or Continue, sign in on any form but a sign-up, sign up on a sign-up only (a "Sign up" link on a sign-in page
 * isn't its submit). Never a heading, label or paragraph, a question ("New here? Sign up"), a toggle, help or recovery,
 * an element holding a field, or a link or anything in one: on the corpus, links that read "Log in" are another way to
 * sign in far more often than a form's submit (submit-baseline.json).
 */
function plainSubmit(target: Element, kind: string | null): Element | null {
  if (target.closest('a')) return null;
  let el: Element | null = target;
  for (let depth = 0; depth < 3 && el; depth++, el = parentOf(el)) {
    const tag = tagOf(el);
    if (tag === 'BODY' || tag === 'FORM' || tag === 'HTML' || NOT_PLAIN.test(tag)) return null;
    if (allIn(el, 'input, select, textarea, h1, h2, h3, h4, h5, h6, label, p').length) return null;
    const text = words(el, PLAIN_WORDS_MAX + 1);
    if (!text) continue;
    if (text.length > PLAIN_WORDS_MAX || text.split(' ').length > PLAIN_WORD_COUNT_MAX || text.includes('?')) return null;
    if (NOT_SUBMIT.test(`${text} ${attrOf(el, 'aria-label') ?? ''}`) || !pressable(el)) return null;
    const says = submitWords(text);
    const fits = says === 'next' || (says === 'sign-in' && kind !== 'sign-up') || (says === 'sign-up' && kind === 'sign-up');
    return fits ? el : null;
  }
  return null;
}

/** Whether `el` is within `levels` ancestors of `field`: the fields' own neighbourhood, for a formless form. */
function near(field: Element, el: Element, levels: number): boolean {
  let node = parentOf(field);
  for (let depth = 0; depth < levels && node && tagOf(node) !== 'BODY'; depth++, node = parentOf(node)) if (contains(node, el)) return true;
  return false;
}

/**
 * The button a click on `target` submits a credential form with, or null (S17 §6, step 2). In a
 * `<form>`, only its submit buttons count; outside one, any button in the fields' scope. Never a
 * button that reads as a show-password toggle, help or recovery (by its words, `aria-pressed`, or
 * `aria-controls` naming the password field), nor one inside the password field's own wrapper.
 * `anchor` is the form's password field, or its username's for a first step; `kind`, the form's kind.
 *
 * An element with no button's role counts too when its words read as a submit (`plainSubmit`): SPAs sign in with a
 * `div`. Outside a `<form>`, it must be near the fields (within the scope's six levels).
 */
export function submitButtonFor(target: Element, anchor: Element | null, form: HTMLFormElement | null, kind: string | null = null): Element | null {
  const button = target.closest(ANY_BUTTON);
  if (!button) {
    const plain = plainSubmit(target, kind);
    if (!plain || !anchor || contains(plain, anchor)) return null;
    if (!form && !near(anchor, plain, 6)) return null;
    return plain;
  }
  const words = `${buttonText(button)} ${attrOf(button, 'aria-label') ?? ''} ${attrOf(button, 'title') ?? ''}`;
  if (NOT_SUBMIT.test(words) || button.hasAttribute('aria-pressed')) return null;
  // In a <form>: its submit buttons, and a plain button that a script signs in with (React apps, banks):
  // one whose words say sign in, sign up, Next or Continue, or the form's only button.
  if (form && !isSubmit(button) && !readsAsSubmit(words) && allIn(form, ANY_BUTTON).length !== 1) return null;
  if (anchor) {
    if (contains(button, anchor)) return null;
    const controls = (attrOf(button, 'aria-controls') ?? '').split(/\s+/);
    if (anchor.id && controls.includes(anchor.id)) return null;
    // The password field's own wrapper (a box holding only it and its eye): a button there toggles it. A first step's
    // username and its Next often share one.
    const wrapper = controlType(anchor) === 'password' ? parentOf(anchor) : null;
    if (wrapper && tagOf(wrapper) !== 'FORM' && contains(wrapper, button) && allIn(wrapper, 'input, select, textarea').length === 1) return null;
    if (!form) {
      const scope = formlessScope(anchor);
      if (!scope || !contains(scope, button)) return null;
    }
  }
  return button;
}

/**
 * The form a click on `target` submits, or null (S17 §6, step 2): its `<form>`'s, or the formless fields' whose scope
 * holds the button. `anchorOf` gives each form's password field, or its username's for a first step. The agent's
 * click listener and the corpus's measure of false submit signals both use this.
 */
export function submittedBy<T extends { readonly scanned: ScannedForm; readonly classified: { readonly kind: string } | null }>(target: Element, forms: readonly T[], anchorOf: (form: T) => Element | null): T | null {
  const form = target.closest('form');
  const k = form ? forms.find((x) => x.scanned.form === form) : forms.find((x) => x.scanned.form === null);
  if (!k) return null;
  const button = submitButtonFor(target, anchorOf(k), k.scanned.form, k.classified?.kind ?? null);
  if (!button) return null;
  const owner = (button as HTMLButtonElement).form ?? button.closest('form');
  return (owner ? forms.find((x) => x.scanned.form === owner) : forms.find((x) => x.scanned.form === null)) === k ? k : null;
}

/** Any button a person can press to submit: a `<button>`, an input button, or an element with `role=button`. */
const ANY_BUTTON = 'button, input[type=submit], input[type=button], input[type=image], [role=button]';

/** The closest ancestor of `el` (up to 6 levels) that holds a button: a formless form's scope. */
export function formlessScope(el: Element): Element | null {
  let node = parentOf(el);
  for (let depth = 0; depth < 6 && node && tagOf(node) !== 'BODY'; depth++, node = parentOf(node)) {
    if (allIn(node, 'button, input[type=submit], input[type=button], [role=button]').length) return node;
  }
  return null;
}

const NO_WORDS_AT_ALL: FormWords = { buttons: [], submits: [], headings: [], attrs: '', title: '' };

function formWords(doc: Document, form: HTMLFormElement | null, firstPassword: Element | null): FormWords {
  // A form a page has made odd enough to throw (a getter that throws, say) is read without words, not dropped.
  try {
    // A formless form's buttons are those near its password field, else the page's.
    const scope = form ?? (firstPassword && formlessScope(firstPassword)) ?? documentBody(doc);
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
      title: clip(documentTitle(doc), 120),
    };
  } catch {
    return { ...NO_WORDS_AT_ALL, title: clip(documentTitle(doc), 120) };
  }
}

/** Scans `doc`'s main tree (not frames or shadow roots: phase 3) into forms. */
export function scanDocument(doc: Document, options: ScanOptions = {}): ScannedForm[] {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const keys = options.keys ?? new WeakMap<Element, number>();
  const nextKey = options.nextKey ?? { value: 1 };
  const labelOf = labeller();
  const safeLabel = (el: HTMLElement) => {
    try {
      return labelOf(el);
    } catch {
      return clip(el.getAttribute('placeholder'), 100);
    }
  };
  const groups = new Map<HTMLFormElement | null, { fields: PasswordField[]; elements: HTMLElement[] }>();
  let seen = 0;
  const controls = (options.only ?? allIn(doc, 'input, select, textarea')) as Iterable<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
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
      label: safeLabel(el),
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
