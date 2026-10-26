/**
 * Duet fills forms (decision D16; ARCHITECTURE.md §11.6, DESIGN.md §7.8): the
 * pure parts. What a page's form looks like to Duet (each field's label, kind,
 * name and autocomplete hint, choices, and whether it's required: never what's
 * in it), which fields are never offered (passwords, payment details, one-time
 * codes, ID numbers, hidden fields), and how values map back to the fields
 * Chord read, checked when Duet proposes them and again when you press Fill.
 * The page side, which reads and fills from Chord's isolated world, is
 * main/duet/forms.ts. Everything here is unit-tested.
 */

// Core compiles without DOM types; URL is a global in Node and every browser.
declare const URL: new (url: string) => { origin: string; href: string; hash: string };

/** Fields Duet is offered from one read: a real form has far fewer. */
export const DUET_FORM_MAX_FIELDS = 100;
/** Fields the page script describes (offered and left out together); past it, it stops. */
export const DUET_FORM_MAX_CONTROLS = 300;
/** Controls the page script looks at, and how long it may look, before it stops: a page with 5,000 inputs stays responsive. */
export const DUET_FORM_SCAN = 2000;
export const DUET_FORM_SCAN_MS = 250;
/** Choices listed for one select or radio group. One with more isn't offered (it's not a form field you'd ask Duet for). */
export const DUET_FORM_MAX_OPTIONS = 400;
/** The longest value Chord puts in a one-line field, and in a text area (a field's own maxlength can be less). */
export const DUET_FORM_TEXT_MAX = 500;
export const DUET_FORM_AREA_MAX = 5000;
/** The tool result's size: what read_tab's ranges keep to (Claude saves larger results to a file a browse thread can't open). */
const RESULT_MAX = 40_000;

/** One field as the page script describes it (main/duet/forms.ts): its structure, never what's in it. */
export interface FormControl {
  /** The page script's handle for it in this read. */
  key: number;
  /** An input's own type (text, email, password, checkbox, radio…), `textarea`, or `select-one` / `select-multiple`. */
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  label: string;
  placeholder: string;
  required: boolean;
  /** On screen (a checkbox or radio styled by its label counts when its label is). The script leaves out what isn't; Chord checks again. */
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** The field's own maxlength, when it sets one. */
  maxLength: number | null;
  /** A select's options, or a radio group's buttons, by label; null when there are more than DUET_FORM_MAX_OPTIONS. */
  options: string[] | null;
  /** The form it's in (an index into the read's forms), or -1. */
  form: number;
}

export type DuetFieldKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio';
/** Fields named on the card, so you know to fill them yourself. */
export type DuetFieldSensitive = 'password' | 'payment' | 'code' | 'identity';
/** Why a field is never offered: sensitive, hidden, or not a kind Chord fills (files, ranges, multiple choice lists, locked fields). */
export type DuetFieldLeftOut = DuetFieldSensitive | 'hidden' | 'unsupported';

const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);

/** `autocomplete` tokens that mark a sensitive field (any `cc-…` is payment too). */
const AUTOCOMPLETE: Record<string, DuetFieldSensitive> = {
  'current-password': 'password',
  'new-password': 'password',
  webauthn: 'password',
  'one-time-code': 'code',
  'transaction-amount': 'payment',
  'transaction-currency': 'payment',
};

/**
 * Words in a field's name, id, label or placeholder that mark it, for pages
 * that don't say so with `type` or `autocomplete`. Matched on the words
 * lowercased and split (camelCase, `_`, `-`, `[]`), and joined (`cardnumber`),
 * so ` ?` stands for both. First match wins. Generous on purpose: a field left
 * out is one you type yourself; one filled wrongly isn't.
 */
const WORDS: readonly (readonly [DuetFieldSensitive, RegExp])[] = [
  ['code', /\b(otp|totp|hotp|mfa|2fa|one ?time ?(code|password|passcode|pin)|verification ?code|auth(entication|orization)? ?code|sms ?code)\b/],
  ['password', /\b(password|passwd|pwd|pass|passcode|passphrase|pin)\b/],
  [
    'payment',
    /\b(card ?(number|no|num)|cc ?(number|num|no|exp|expiry|csc|cvv|cvc|name)|credit ?card|debit ?card|card ?holder|name ?on ?card|cvc2?|cvv2?|csc|security ?code|expiry|expiration|exp ?(date|month|year)|iban|sort ?code|routing ?(number|no)|account ?(number|no)|bank ?account|swift ?(code|bic)|bic)\b/,
  ],
  ['identity', /\b(ssn|social ?security|national ?(insurance|id)|tax ?(id|number)|tin|passport ?(number|no)|driver ?s? ?licen[cs]e ?(number|no))\b/],
];

/** A name or label as words: camelCase split, and digits after letters (`user2FA`), punctuation gone, lowercase. "PIN code" (India's postal code) isn't a PIN. */
function words(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bpin ?code\b/g, 'postal code')
    .trim();
}

/** Whether a field is sensitive, and why: by its type, its `autocomplete`, then the words it's named with. */
export function sensitiveField(c: Pick<FormControl, 'type' | 'autocomplete' | 'name' | 'id' | 'label' | 'placeholder'>): DuetFieldSensitive | null {
  if (c.type === 'password') return 'password';
  for (const token of c.autocomplete.toLowerCase().split(/\s+/)) {
    if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
    if (token.startsWith('cc-')) return 'payment';
  }
  const named = [c.name, c.id, c.label, c.placeholder].map(words).join(' | ');
  for (const [why, pattern] of WORDS) if (pattern.test(named)) return why;
  return null;
}

/**
 * Whether Duet may be offered a field, and as what: hidden ones never (a
 * `type=hidden` field, or one not on screen), nor locked ones, nor sensitive
 * ones; then text inputs, text areas, single-choice selects, checkboxes and
 * radio groups. Everything else (files, ranges, colors, multiple-choice
 * lists, a select with too many options) isn't a kind Chord fills.
 */
export function classifyField(c: FormControl): { kind: DuetFieldKind } | { leftOut: DuetFieldLeftOut } {
  if (c.type === 'hidden' || !c.visible) return { leftOut: 'hidden' };
  if (c.disabled || c.readOnly) return { leftOut: 'unsupported' };
  const sensitive = sensitiveField(c);
  if (sensitive) return { leftOut: sensitive };
  if (TEXT_TYPES.has(c.type)) return { kind: 'text' };
  if (c.type === 'textarea') return { kind: 'textarea' };
  if (c.type === 'checkbox') return { kind: 'checkbox' };
  if ((c.type === 'select-one' || c.type === 'radio') && c.options && c.options.length > 0) return { kind: c.type === 'radio' ? 'radio' : 'select' };
  return { leftOut: 'unsupported' };
}

/** A field Duet may fill, as Chord keeps it from a read. */
export interface DuetFormField {
  /** Chord's id for it: unique in the chat, so an id from an earlier read is caught, never taken for another field. */
  id: string;
  /** The page script's handle for it in that read. */
  key: number;
  kind: DuetFieldKind;
  /** An input's type, for text fields (email, tel, date…). */
  type: string;
  label: string;
  name: string;
  autocomplete: string;
  placeholder: string;
  required: boolean;
  maxLength: number | null;
  options: string[];
  form: number;
}

/** A form as Duet read it: the fields it may fill, and the ones you'd see that it may not. */
export interface DuetFormRead {
  url: string;
  forms: string[];
  fields: DuetFormField[];
  /** Sensitive fields on screen: the card names them, so you fill them yourself. */
  leftOut: { label: string; why: DuetFieldSensitive }[];
  /** The page had more than Duet is offered, or took too long to look through. */
  truncated: boolean;
}

const clip = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the page script answered, checked as anything from a page is: each
 * control's strings clipped, its flags booleans, at most DUET_FORM_MAX_CONTROLS.
 */
export function cleanFormPage(raw: unknown): { url: string; forms: string[]; controls: FormControl[]; truncated: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const page = raw as Record<string, unknown>;
  if (typeof page['url'] !== 'string' || !Array.isArray(page['controls'])) return null;
  const forms = Array.isArray(page['forms']) ? page['forms'].slice(0, DUET_FORM_MAX_CONTROLS).map((f) => clip(f, 80)) : [];
  const controls: FormControl[] = [];
  for (const item of page['controls'].slice(0, DUET_FORM_MAX_CONTROLS)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c['key'] !== 'number' || !Number.isInteger(c['key'])) continue;
    const options = Array.isArray(c['options']) && c['options'].length <= DUET_FORM_MAX_OPTIONS ? c['options'].map((o) => clip(o, 100)) : null;
    const maxLength = typeof c['maxLength'] === 'number' && Number.isInteger(c['maxLength']) && c['maxLength'] >= 0 ? c['maxLength'] : null;
    controls.push({
      key: c['key'],
      type: clip(c['type'], 30).toLowerCase(),
      name: clip(c['name'], 60),
      id: clip(c['id'], 60),
      autocomplete: clip(c['autocomplete'], 80).toLowerCase(),
      label: clip(c['label'], 120),
      placeholder: clip(c['placeholder'], 100),
      required: c['required'] === true,
      visible: c['visible'] === true,
      disabled: c['disabled'] !== false,
      readOnly: c['readOnly'] !== false,
      maxLength,
      options,
      form: typeof c['form'] === 'number' && Number.isInteger(c['form']) && c['form'] >= 0 && c['form'] < forms.length ? c['form'] : -1,
    });
  }
  return { url: page['url'], forms, controls, truncated: page['truncated'] === true };
}

const SENSITIVE_NAMES: Record<DuetFieldSensitive, string> = { password: 'Password', payment: 'Card details', code: 'One-time code', identity: 'ID number' };

/** A read's fields: those Duet may fill, numbered from `firstId`, and the sensitive ones on screen, named for the card. */
export function formRead(page: { url: string; forms: string[]; controls: readonly FormControl[]; truncated: boolean }, firstId: number): DuetFormRead {
  const fields: DuetFormField[] = [];
  const leftOut: DuetFormRead['leftOut'] = [];
  let truncated = page.truncated;
  for (const c of page.controls) {
    const verdict = classifyField(c);
    const label = c.label || c.placeholder || c.name || c.id;
    if ('leftOut' in verdict) {
      if (verdict.leftOut !== 'hidden' && verdict.leftOut !== 'unsupported') leftOut.push({ label: label || SENSITIVE_NAMES[verdict.leftOut], why: verdict.leftOut });
      continue;
    }
    if (fields.length >= DUET_FORM_MAX_FIELDS) {
      truncated = true;
      continue;
    }
    fields.push({
      id: `f${firstId + fields.length}`,
      key: c.key,
      kind: verdict.kind,
      type: verdict.kind === 'text' ? c.type : verdict.kind,
      label: label || (verdict.kind === 'text' ? c.type : verdict.kind),
      name: c.name,
      autocomplete: c.autocomplete === 'on' || c.autocomplete === 'off' ? '' : c.autocomplete,
      placeholder: c.placeholder,
      required: c.required,
      maxLength: c.maxLength,
      options: c.options ?? [],
      form: c.form,
    });
  }
  return { url: page.url, forms: page.forms, fields, leftOut, truncated };
}

/** The address without its fragment: a page that only changed its #hash is the same page. */
const pageAddress = (url: string): string => {
  try {
    const u = new URL(url);
    return u.hash ? u.href.slice(0, -u.hash.length) : u.href;
  } catch {
    return url;
  }
};
export const samePage = (a: string, b: string): boolean => pageAddress(a) === pageAddress(b);

/**
 * read_form's result, as page text always is: untrusted JSON with its
 * provenance. Each field with its id, kind, label and hints; the counts of
 * what was left out (never which, or why beyond the kind); at most
 * RESULT_MAX characters, cut at a field, saying so.
 */
export function formResult(read: DuetFormRead, page: { ref: string; retrievedAt: number }): string {
  let origin = '';
  try {
    origin = new URL(read.url).origin;
  } catch {
    // An address that doesn't parse has no origin to give.
  }
  const counts: Partial<Record<DuetFieldSensitive, number>> = {};
  for (const l of read.leftOut) counts[l.why] = (counts[l.why] ?? 0) + 1;
  const many = new Set(read.fields.map((f) => f.form)).size > 1;
  const head = {
    source: 'web_form',
    tab_id: page.ref,
    origin,
    url: read.url,
    retrieved_at: new Date(page.retrievedAt).toISOString(),
    trust: 'untrusted',
    ...(many ? { forms: read.forms.map((label, i) => ({ form: i + 1, label })) } : {}),
  };
  const fields: Record<string, unknown>[] = [];
  let size = JSON.stringify(head).length + 400;
  let cut = false;
  for (const f of read.fields) {
    const entry: Record<string, unknown> = { id: f.id, kind: f.kind, label: f.label };
    if (f.kind === 'text' && f.type !== 'text') entry['type'] = f.type;
    if (f.name) entry['name'] = f.name;
    if (f.autocomplete) entry['autocomplete'] = f.autocomplete;
    if (f.placeholder && f.placeholder !== f.label) entry['placeholder'] = f.placeholder;
    if (f.required) entry['required'] = true;
    if (f.maxLength !== null) entry['max_length'] = f.maxLength;
    if (f.kind === 'select' || f.kind === 'radio') entry['options'] = f.options;
    if (many && f.form >= 0) entry['form'] = f.form + 1;
    size += JSON.stringify(entry).length + 1;
    if (size > RESULT_MAX) {
      cut = true;
      break;
    }
    fields.push(entry);
  }
  const notes = [
    fields.length === 0 ? 'There are no fields Duet can fill on this page.' : '',
    read.leftOut.length ? 'Fields for passwords, payment details, one-time codes and ID numbers are left out: Chord never fills them, so the user fills those themselves.' : '',
    cut || read.truncated ? `This page has more fields than Duet is given at once: these are the first ${fields.length}.` : '',
  ].filter(Boolean);
  return JSON.stringify({ ...head, fields, ...(read.leftOut.length ? { left_out: counts } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) });
}

/** A field on the fill card: what Chord read of it, and the value that goes in (Duet's, then yours). */
export interface DuetFillField {
  id: string;
  kind: DuetFieldKind;
  type: string;
  label: string;
  required: boolean;
  maxLength: number | null;
  options: string[];
  /** Text, one of `options`, or whether a checkbox is checked. */
  value: string | boolean;
}

/** The card, in memory only (Chord never saves the values): its fields, what it left out, and how it ended. */
export interface DuetFillCard {
  status: 'pending' | 'filled' | 'undone' | 'dismissed' | 'expired';
  /** The tab's title and site, as the card names them. */
  title: string;
  site: string;
  fields: DuetFillField[];
  leftOut: { label: string; why: DuetFieldSensitive }[];
  truncated: boolean;
  /** Chord's one sentence about it: why it ended, or (still pending) what to do before Fill can work. */
  note?: string;
  /** Fields filled, once it was. */
  filled?: number;
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/;
/** Values a field of that type takes: anything else the page would turn into an empty field (HTML's value sanitization). */
const FORMATS: Record<string, { test(value: string): boolean; like: string }> = {
  number: { test: (v) => /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v), like: 'a number' },
  date: { test: (v) => DATE.test(v), like: 'a date like 2026-10-25' },
  time: { test: (v) => TIME.test(v), like: 'a time like 14:30' },
  month: { test: (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v), like: 'a month like 2026-10' },
  week: { test: (v) => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(v), like: 'a week like 2026-W43' },
  'datetime-local': { test: (v) => DATE.test(v.slice(0, 10)) && v[10] === 'T' && TIME.test(v.slice(11)), like: 'a date and time like 2026-10-25T14:30' },
};

/**
 * A value for a field, as Chord will put it in: text that fits (one line for
 * inputs, the field's own maxlength, a format the page won't throw away), one
 * of a select's or radio group's choices (by its label, any case), or true or
 * false for a checkbox. The problem says why not, for Duet or for the card.
 */
export function fieldValue(field: Pick<DuetFormField, 'kind' | 'type' | 'maxLength' | 'options'>, value: unknown): { ok: true; value: string | boolean; choice?: number } | { ok: false; problem: string } {
  if (field.kind === 'checkbox') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, problem: 'needs true (checked) or false (not checked)' };
  if (typeof value !== 'string') return { ok: false, problem: field.kind === 'select' || field.kind === 'radio' ? 'needs one of its choices' : 'needs text' };
  if (field.kind === 'select' || field.kind === 'radio') {
    const wanted = value.trim().toLowerCase();
    let choice = field.options.indexOf(value);
    if (choice < 0) choice = field.options.findIndex((o) => o.trim().toLowerCase() === wanted);
    return choice < 0 ? { ok: false, problem: 'isn’t one of its choices' } : { ok: true, value: field.options[choice]!, choice };
  }
  const area = field.kind === 'textarea';
  const text = area ? value.replace(/\r\n?/g, '\n') : value;
  // Control characters hide in text; a one-line field takes no line breaks.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text) || (!area && /[\n\t]/.test(text))) return { ok: false, problem: area ? 'has characters a text field can’t take' : 'needs to be one line' };
  const max = Math.min(area ? DUET_FORM_AREA_MAX : DUET_FORM_TEXT_MAX, field.maxLength ?? Infinity);
  if (text.length > max) return { ok: false, problem: `is longer than the field takes (${max} characters)` };
  const format = FORMATS[field.type];
  if (format && text !== '' && !format.test(text)) return { ok: false, problem: `needs ${format.like}` };
  return { ok: true, value: text };
}

/**
 * propose_fill's values mapped back to the last read: each to a field Chord
 * gave an id (one from an earlier read, or one never given, is refused), at
 * most DUET_FORM_MAX_FIELDS, none twice, each value one the field takes, and
 * the page still at the address it was read at. Every problem comes back at
 * once, so Duet can fix them all.
 */
export function proposedFill(read: DuetFormRead, args: Record<string, unknown>, currentUrl: string): { ok: true; fields: DuetFillField[] } | { ok: false; problems: string[] } {
  if (!samePage(read.url, currentUrl)) return { ok: false, problems: ['The page changed since you read its form: it’s at a different address now. Read the form again.'] };
  const values = args['values'];
  if (!Array.isArray(values) || values.length === 0) return { ok: false, problems: ['Give values as a list of {field, value}, with the field ids from read_form.'] };
  if (values.length > DUET_FORM_MAX_FIELDS) return { ok: false, problems: [`At most ${DUET_FORM_MAX_FIELDS} fields at once.`] };
  const problems: string[] = [];
  const fields: DuetFillField[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const id = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['field'] : undefined;
    if (typeof id !== 'string') {
      problems.push('Each value needs the field id read_form gave (f1, f2…).');
      continue;
    }
    const field = read.fields.find((f) => f.id === id);
    if (!field) {
      problems.push(`${id.slice(0, 20)}: not a field in your last read_form (ids change with each read; use the latest).`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${id}: given twice.`);
      continue;
    }
    seen.add(id);
    const checked = fieldValue(field, (entry as Record<string, unknown>)['value']);
    if (!checked.ok) problems.push(`${id} (${field.label}): ${checked.problem}.`);
    else fields.push({ id, kind: field.kind, type: field.type, label: field.label, required: field.required, maxLength: field.maxLength, options: field.options, value: checked.value });
  }
  return problems.length ? { ok: false, problems } : { ok: true, fields };
}

/** One field to fill, as the page script takes it: its handle, and the text, the choice or whether it's checked. */
export interface FillWrite {
  key: number;
  kind: DuetFieldKind;
  text?: string;
  checked?: boolean;
  choice?: number;
}

/**
 * The card's fields as you left them, checked again when you press Fill
 * (the panel is trusted no more than Duet): only fields on the card, each
 * value one the field takes. The problems name each field by its label.
 */
export function fillWrites(read: DuetFormRead, card: readonly DuetFillField[], edits: readonly { id: string; value: string | boolean }[]): { ok: true; writes: FillWrite[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const writes: FillWrite[] = [];
  const seen = new Set<string>();
  for (const edit of edits.slice(0, DUET_FORM_MAX_FIELDS + 1)) {
    const field = card.some((f) => f.id === edit.id) ? read.fields.find((f) => f.id === edit.id) : undefined;
    if (!field || seen.has(edit.id)) continue;
    seen.add(edit.id);
    const checked = fieldValue(field, edit.value);
    if (!checked.ok) {
      problems.push(`${field.label} ${checked.problem}.`);
      continue;
    }
    if (field.kind === 'checkbox') writes.push({ key: field.key, kind: field.kind, checked: checked.value as boolean });
    else if (field.kind === 'select' || field.kind === 'radio') writes.push({ key: field.key, kind: field.kind, choice: checked.choice! });
    else writes.push({ key: field.key, kind: field.kind, text: checked.value as string });
  }
  return problems.length ? { ok: false, problems } : { ok: true, writes };
}

const LEFT_OUT_KINDS: Record<DuetFieldSensitive, string> = { password: 'passwords', payment: 'payment details', code: 'one-time codes', identity: 'ID numbers' };

const list = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The card's line about what it left out: "Left out: Password and Card number. Chord never fills passwords or payment details." */
export function fillLeftOutNote(leftOut: readonly { label: string; why: DuetFieldSensitive }[]): string {
  if (leftOut.length === 0) return '';
  const labels = leftOut.slice(0, 4).map((l) => l.label);
  if (leftOut.length > 4) labels.push(`${leftOut.length - 4} more`);
  const kinds = [...new Set(leftOut.map((l) => l.why))].map((why) => LEFT_OUT_KINDS[why]);
  return `Left out: ${list(labels)}. Chord never fills ${list(kinds)}, so fill ${leftOut.length === 1 ? 'that' : 'those'} yourself.`;
}

/** The filled card's line about fields that changed as the others went in (a country's states), which Chord left alone. */
export function fillChangedNote(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const them = labels.length === 1 ? 'it' : 'them';
  return `${list(labels)} changed as the other fields went in, so Chord left ${them} alone. Ask Duet again for ${them}.`;
}

/** "4 fields", "1 field". */
export const fieldCount = (n: number): string => `${n} field${n === 1 ? '' : 's'}`;
