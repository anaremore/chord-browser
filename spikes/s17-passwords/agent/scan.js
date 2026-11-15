/* global document, HTMLFormElement */
// Spike S17 M0: the agent's scan, as plain source (it's run as `(${source})(options)`
// in a page: the agent's isolated world in Electron, or a Playwright page for the
// bake-off). Turns a document's fields into Chromium-style field records, grouped as
// Chromium groups them: by owning <form>, with every unowned field in one more form.
// It reads; it never writes to the page (no attribute, class, element or style).
//
// options.manual: also return DuckDuckGo's data-manual-scoring label and each field's
// index among the labelled ones (the bake-off only). options.values: include values
// (the corpus has none; the agent never sends one to main).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- run as source, by name
function chordScan(options) {
  const opts = options || {};
  const doc = opts.document || document;
  const clip = (s, n) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) : s;
  };
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  const NO_WORDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const words = (node, max) => {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (out.length > max) return;
        if (c.nodeType === 3) out += ' ' + c.nodeValue;
        else if (c.nodeType === 1 && !NO_WORDS.has(c.tagName)) walk(c);
      }
    };
    walk(node);
    return clip(out, max);
  };
  const byId = (el, id) => {
    const root = el.getRootNode();
    return typeof root.getElementById === 'function' ? root.getElementById(id) : null;
  };
  // Text just before the field, as Chromium's InferLabelFromPrevious and its neighbours do, roughly:
  // the nearest preceding text within a few levels of ancestors.
  const previousText = (el) => {
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      for (let s = node.previousSibling; s; s = s.previousSibling) {
        if (s.nodeType === 1 && (s.tagName === 'INPUT' || s.tagName === 'SELECT' || s.tagName === 'TEXTAREA')) return '';
        const t = s.nodeType === 3 ? clip(s.nodeValue, 100) : s.nodeType === 1 ? words(s, 100) : '';
        if (t) return t;
      }
      node = node.parentElement;
      if (node && (node.tagName === 'FORM' || node.tagName === 'BODY')) break;
    }
    return '';
  };
  const labelOf = (el) => {
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
    const by = clip(ids.map((id) => byId(el, id)).filter(Boolean).map((n) => words(n, 100)).join(' '), 100);
    const labels = el.labels ? [...el.labels].map((l) => words(l, 100)).filter(Boolean).join(' ') : '';
    return clip(labels, 100) || by || clip(el.getAttribute('aria-label'), 100) || previousText(el) || clip(el.getAttribute('placeholder'), 100);
  };
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  // Blink's IsFocusable, roughly: rendered, not visibility:hidden, not disabled or inert.
  const focusable = (el) => !el.disabled && !el.closest('[inert]') && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }));
  const manualList = opts.manual ? [...doc.querySelectorAll('[data-manual-scoring]')] : [];
  const forms = new Map();
  const formWords = (form) => {
    const root = form || doc.body;
    const buttons = [...root.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a')]
      .slice(0, 40)
      .map((b) => clip(b.tagName === 'INPUT' ? b.value : b.textContent, 60))
      .filter(Boolean);
    const headings = [...(form ? root.querySelectorAll('h1, h2, h3, legend') : doc.querySelectorAll('h1, h2, h3, legend'))].slice(0, 10).map((h) => clip(h.textContent, 80));
    return {
      // getAttribute, not form.id: a field named id clobbers the form's own property.
      attrs: form ? clip(['id', 'name', 'class', 'action'].map((k) => form.getAttribute(k) || '').join(' '), 300) : '',
      buttons,
      headings,
      title: clip(doc.title, 120),
    };
  };
  let key = 0;
  const controls = doc.querySelectorAll('input, select, textarea');
  for (const el of controls) {
    if (++key > 2000) break; // ASSISTANT_FORM_SCAN's bound
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    if (SKIP.has(type)) continue;
    const form = el.form instanceof HTMLFormElement ? el.form : null;
    if (!forms.has(form)) forms.set(form, { index: forms.size, words: formWords(form), fields: [] });
    const record = {
      key,
      type,
      id: clip(el.id, 80),
      name: clip(el.getAttribute('name'), 80),
      autocomplete: clip(el.getAttribute('autocomplete'), 80).toLowerCase(),
      label: labelOf(el),
      placeholder: clip(el.getAttribute('placeholder'), 100),
      maxLength: typeof el.maxLength === 'number' ? el.maxLength : -1,
      readOnly: !!el.readOnly,
      focusable: focusable(el),
      visible: visible(el),
      userTyped: false,
      autofilled: false,
      value: opts.values ? String(el.value || '') : '',
    };
    if (opts.manual) {
      record.manual = el.getAttribute('data-manual-scoring');
      record.manualIndex = manualList.indexOf(el);
    }
    forms.get(form).fields.push(record);
  }
  return [...forms.values()];
}
