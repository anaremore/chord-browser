/**
 * Chord's password detector (S17 §4): Chromium's parser (password-parser.ts) with what
 * Chromium gets from Google's servers and Firefox works out locally, restated here:
 *
 * - **the kind of form**: sign-in, sign-up, change, reset or a username-only first step,
 *   from its `autocomplete`, its buttons' and headings' words, its attributes and the page's title;
 * - **vetoes**: a search, code, coupon or newsletter field is never the username, and a
 *   `type=password` field that reads as a security answer, a PIN, a tax id or a card code is
 *   never a password;
 * - **the password's variant** (current or new): the field's own words first, as
 *   DuckDuckGo's matchers read them, then the form's kind, then Chromium's guess;
 * - **the email preferred** as username when Chromium chose the nearest field only for being nearest;
 * - **the username-only form**, the first step of a two-step sign-in (Firefox's rule, restated;
 *   nothing copied, so no MPL file).
 *
 * Measured on DuckDuckGo's corpus in CI (apps/desktop/test/forms, S17 §13 layer 2).
 * Pure functions over field records: no DOM, and nothing sends a value anywhere.
 */
import { htmlUsernamePredictions, isTextInput, parsePasswordForm, passwordFieldValue, type ParseMode, type PasswordField } from './password-parser';
import {
  CARD_CVC_RE,
  DDG_CURRENT_PASSWORD,
  DDG_EMAIL,
  DDG_NEW_PASSWORD,
  DDG_PASSWORD,
  DDG_UNKNOWN,
  DDG_USERNAME,
  ONE_TIME_CODE_RE,
  SOCIAL_SECURITY_RE,
  matchWords,
} from './password-vocabulary';


/** The words around a form, as the agent reads them (each clipped; S17 §4). */
export interface FormWords {
  /** Its buttons' and links' text, in order (at most 40). */
  readonly buttons: readonly string[];
  /** The buttons that submit it (`<button>`, `input[type=submit]`; for fields outside a form, the buttons beside them): the words that say most. */
  readonly submits: readonly string[];
  /** Its headings and legends (for fields outside any form, the page's). */
  readonly headings: readonly string[];
  /** The form's id, name, class and action. Empty for fields outside any form. */
  readonly attrs: string;
  /** The page's title. */
  readonly title: string;
}

/** One form's fields in document order, and its words. Every field outside a `<form>` is one more form, as in Chromium. */
export interface PasswordFormRecord {
  readonly fields: readonly PasswordField[];
  readonly words: FormWords;
}

export type PasswordFormKind = 'sign-in' | 'sign-up' | 'change' | 'reset' | 'username-only' | 'unknown';
export type PasswordFieldRole = 'username' | 'current-password' | 'new-password' | 'confirmation-password';

/** What the detector says about one form. */
export interface PasswordFormClassification {
  readonly kind: PasswordFormKind;
  /** Each field with a role, by key. A field has at most one. */
  readonly roles: ReadonlyMap<number, PasswordFieldRole>;
  readonly username: PasswordField | null;
  /** The current password: what you sign in with. */
  readonly password: PasswordField | null;
  readonly newPassword: PasswordField | null;
  readonly confirmation: PasswordField | null;
}

export interface ClassifyOptions {
  /** Usernames saved for this site, lower case (Chromium's `stored_usernames`). */
  readonly storedUsernames?: ReadonlySet<string>;
}

// ----- Words -----

/** registerForm, sign_in, login-form → separate words, so `\b` matches. */
const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_./?=&#-]+/g, ' ');
/**
 * An id React's `useId` made up, which says nothing about the field: `:r2:` (React 18), `«r2»` (19.0, 19.1) and
 * `_r_2_` (19.2), with `R` where rendered on the server, then a base-32 counter (0-9, a-v). Spaced, `_r_2_` reads as
 * the word `2`. Only that format: a JSF id's segments (`form:retypePassword:input`) are words.
 */
const GENERATED_ID = /:[rR][0-9a-v]+:|«[rR][0-9a-v]+»|_[rR]_[0-9a-v]+_/g;
/** A field's own words: its name, id (less what React generated), label and placeholder. */
const fieldText = (f: PasswordField) => spaced(`${f.name} ${f.id.replace(GENERATED_ID, ' ')} ${f.label} ${f.placeholder}`);

const SIGN_IN = /\b(sign|log)[ -]?(in|on)\b|\blogin\b|\bsignin\b|\banmelden\b|iniciar sesi|connexion|se connecter|\baccedi\b|\bentrar\b|inloggen|logga in/i;
const SIGN_UP = /\bsign[ -]?up\b|\bregist(er|ration|rieren)\b|create (an |your |a free |new |my )?account|\bjoin\b|get started|\bsignup\b|crear cuenta|cr[ée]er un compte|konto erstellen|new account|\benroll/i;
const CHANGE = /change (your |the )?password|update (your |the )?password|current password|old password/i;
const RESET = /reset (your |the )?password|(set|choose|create) (a )?new password|forgot/i;
const NEWSLETTER = /newsletter|subscri|abonn|nieuwsbrief|bolet[ií]n|mailing list/i;
const NEXT = /^\s*(next|continue|weiter|suivant|siguiente|continuar|volgende|avanti)\b/i;
const USERNAMEISH = /user|login|e-?mail|account|ident|member|nick/i;
const STRONG_USERNAME = /^(user(name|id|_?name)?|login(id|name)?|e-?mail|identifier|account(name)?|loginfmt)$/i;
const NOT_USERNAME = /search|captcha|coupon|promo|voucher|\bzip\b|postal|newsletter|subscri|(confirmation|verification|security|access) ?code/i;
/** A password field that's never one: a security answer, a tax or national id (DuckDuckGo's `unknown`, restated). */
const NOT_PASSWORD = /\banswer|secret (question|word)|security (question|word)|\btin\b|tax ?(id|number)|national (id|insurance)|passport|\bssn\b/i;
/** A PIN: the password on some sign-in pages (banks, airlines), and not one beside a real password field, nor one of several. */
const PIN = /\bpin\b|pin ?code/i;
/**
 * Chromium's two-password guess when both are empty: a form whose own words say "confirm" holds a new password and its confirmation.
 * A 2 counts only after a password's word, in the languages the vocabulary reads (`password2`, `pwd_2`, `Passwort 2`,
 * `Kennwort2`, `Contraseña 2`, `Mot de passe 2`): alone it's any counter, as in a React id like `_r_2_`.
 */
const CONFIRM_WORDS =
  /confirm|repeat|re-?type|re-?enter|again|verify|\bconf\b|\b(pass(word|wd|wort)?|pwd?|kennwort|contrase(ñ|n)a|clave|mot de passe|wachtwoord|l(ö|o)senord|senha|parola d'ordine) ?2\b/i;

const isEmailish = (f: PasswordField) => f.type === 'email' || /e-?mail/i.test(`${f.name} ${f.id} ${f.autocomplete} ${f.label}`) || matchWords(DDG_EMAIL, f.label) === 'yes';
const autocompleteTokens = (f: PasswordField) => f.autocomplete.split(/\s+/).filter(Boolean);
const saysUsername = (f: PasswordField) => autocompleteTokens(f).includes('username');

/** A text field that's never a username, unless its `autocomplete` says it is. */
function vetoedAsUsername(f: PasswordField): boolean {
  if (f.type === 'password' || saysUsername(f)) return false;
  if (f.type === 'search') return true;
  const text = fieldText(f);
  return NOT_USERNAME.test(text) || ONE_TIME_CODE_RE.test(`${f.name} ${f.id}`) || matchWords(DDG_UNKNOWN, text) === 'yes';
}

const saysPassword = (f: PasswordField) => autocompleteTokens(f).some((t) => t === 'current-password' || t === 'new-password');

/** A `type=password` field that's never a password, unless its `autocomplete` says it is. */
function vetoedAsPassword(f: PasswordField): boolean {
  if (f.type !== 'password' || saysPassword(f)) return false;
  // One character: a box of a split PIN or code (S17 §4).
  if (f.maxLength === 1) return true;
  const text = fieldText(f);
  const ddg = matchWords(DDG_PASSWORD, text);
  if (NOT_PASSWORD.test(text) || (ddg === 'unknown' && !PIN.test(text) && !/pin/i.test(text))) return true;
  // A card code typed as a password, by its label too (Chromium reads only the id and name).
  return CARD_CVC_RE.test(f.label) || SOCIAL_SECURITY_RE.test(f.label);
}

/** The form's password fields that aren't passwords: those vetoed, and a PIN where another password field remains. */
function passwordVetoes(fields: readonly PasswordField[]): Set<PasswordField> {
  const vetoed = new Set(fields.filter(vetoedAsPassword));
  const pins = fields.filter((f) => f.type === 'password' && !vetoed.has(f) && !saysPassword(f) && PIN.test(fieldText(f)));
  // Beside a real password field, or one of several (gift cards' PINs), a PIN isn't the password.
  if (pins.length > 1 || fields.some((f) => f.type === 'password' && !vetoed.has(f) && !pins.includes(f))) for (const pin of pins) vetoed.add(pin);
  return vetoed;
}

/** The password variant a field says itself, if any: `autocomplete=current-password`, then its words. */
function ownVariant(f: PasswordField): 'current' | 'new' | null {
  const tokens = autocompleteTokens(f);
  // `current-password` is trusted; `new-password` isn't: sign-in forms carry it (pinterest, oppo; M0 §4).
  if (tokens.includes('current-password')) return 'current';
  const text = fieldText(f);
  if (matchWords(DDG_CURRENT_PASSWORD, text) === 'yes') return 'current';
  if (matchWords(DDG_NEW_PASSWORD, text) === 'yes' || CONFIRM_WORDS.test(text) || /create|choose/i.test(text)) return 'new';
  return null;
}

/** The form's kind from its words and fields, before the username-only rule. */
export function formKind(form: PasswordFormRecord): Exclude<PasswordFormKind, 'username-only'> {
  const { words, fields } = form;
  const tokens = fields.flatMap(autocompleteTokens);
  if (tokens.includes('current-password') && tokens.includes('new-password')) return 'change';
  const all = spaced(`${words.buttons.join(' ')} ${words.headings.join(' ')} ${words.attrs} ${words.title}`);
  if (CHANGE.test(all)) return 'change';
  // The nearest words decide: the submit buttons, then every button and link, the headings, the form's attributes, the page's title.
  for (const source of [words.submits.join(' '), words.buttons.join(' '), words.headings.join(' '), words.attrs, words.title].map(spaced)) {
    const up = SIGN_UP.test(source);
    const inn = SIGN_IN.test(source);
    if (up !== inn) return up ? 'sign-up' : 'sign-in';
  }
  const vetoed = passwordVetoes(fields);
  const passwords = fields.filter((f) => f.type === 'password' && !vetoed.has(f));
  const others = fields.filter((f) => isTextInput(f) && f.type !== 'password' && f.visible).length;
  if (RESET.test(all) && others === 0) return 'reset';
  if (tokens.includes('new-password')) return 'sign-up';
  if (tokens.includes('current-password')) return 'sign-in';
  // Many fields besides the password (names, phone, address) make a sign-up form; a sign-in form has one or two.
  if (passwords.length > 0 && others >= 3) return 'sign-up';
  return 'unknown';
}

/** A password field you could type in: not vetoed, and not a read-only or unreachable decoy (`hiddenPassword`). */
const usablePassword = (f: PasswordField, vetoed: ReadonlySet<PasswordField>) => f.type === 'password' && !vetoed.has(f) && (!f.readOnly || f.userTyped || f.autofilled) && (f.visible || f.focusable || f.userTyped);

/** A field you can neither see nor reach, and never typed in or had filled: a template, a decoy, a later step's. */
const hidden = (f: PasswordField) => !f.visible && !f.focusable && !f.userTyped && !f.autofilled;

/** The `autocomplete` tokens that name a credential's role. */
const ROLE_TOKENS: ReadonlySet<string> = new Set(['username', 'current-password', 'new-password']);
/**
 * The fields the parser may give a role, less a hidden one whose `autocomplete` token a shown field also carries (a
 * page with a hidden duplicate of its sign-in fields, the hidden copy first): the shown one takes the role. A hidden
 * field still takes a role no shown field claims (Chromium's "autocomplete mark-up overrides visibility").
 */
function withoutHiddenRivals(fields: readonly PasswordField[]): PasswordField[] {
  const shownTokens = new Set(fields.filter((f) => !hidden(f)).flatMap(autocompleteTokens));
  return fields.filter((f) => !hidden(f) || !autocompleteTokens(f).some((t) => ROLE_TOKENS.has(t) && shownTokens.has(t)));
}

/**
 * A form whose every `type=password` field is hidden, read as having none: a two-step sign-in whose first step carries
 * the next step's password field, hidden. Taken only when that makes it a username-only first step, so main sends it
 * no password; any other form keeps its hidden passwords (a form hidden whole, a modal not yet open, is classed as it
 * will be shown, and a shown placeholder over a hidden real password field stays a sign-in).
 */
function asFirstStep(form: PasswordFormRecord, mode: ParseMode, options: ClassifyOptions): PasswordFormClassification | null {
  const passwords = form.fields.filter((f) => f.type === 'password');
  if (!passwords.length || !passwords.every(hidden)) return null;
  const c = classifyPasswordForm({ ...form, fields: form.fields.filter((f) => f.type !== 'password') }, mode, options);
  return c?.kind === 'username-only' ? c : null;
}

/** Whether the parse's username was only the nearest field: no `autocomplete`, no saved value, and no word saying username. */
const nearestOnly = (f: PasswordField) => !saysUsername(f) && !isEmailish(f) && !USERNAMEISH.test(fieldText(f)) && matchWords(DDG_USERNAME, f.label) !== 'yes';

/**
 * Classify one form for filling or saving: which field is the username, the current
 * password, the new one and its confirmation, and what kind of form it is. Null when it
 * holds no credential at all.
 */
export function classifyPasswordForm(form: PasswordFormRecord, mode: ParseMode, options: ClassifyOptions = {}): PasswordFormClassification | null {
  // Vetoed fields leave the parse altogether, so Chromium's nearest-field rule passes over them.
  const vetoed = passwordVetoes(form.fields);
  const firstStep = asFirstStep(form, mode, options);
  if (firstStep) return firstStep;
  const candidates = withoutHiddenRivals(form.fields).filter((f) => !vetoedAsUsername(f) && !vetoed.has(f));
  let parsed = parsePasswordForm(candidates, mode, { storedUsernames: options.storedUsernames }).form;
  // Chromium's HTML-based username can be an email after the passwords: "Email address" holds one of its technical
  // words, `laddress`. Chord takes the predictions before the first password then. A username field there stays
  // (some sign-up forms ask for it last).
  const first = parsed && (parsed.password ?? parsed.newPassword);
  if (parsed && first && parsed.usernameMethod === 'html' && parsed.username && (parsed.username.type === 'email' || /e-?mail/i.test(`${parsed.username.name} ${parsed.username.id}`)) && candidates.indexOf(parsed.username) > candidates.indexOf(first)) {
    const before = new Set(candidates.slice(0, candidates.indexOf(first)).map((f) => f.key));
    const predictions = htmlUsernamePredictions(candidates).filter((key) => before.has(key));
    parsed = parsePasswordForm(candidates, mode, { storedUsernames: options.storedUsernames, usernamePredictions: predictions }).form;
  }
  // A parse that found its passwords only by relaxing the filters (Chromium's only_for_fallback) offers nothing.
  const p = parsed && !parsed.isFallback ? parsed : null;
  const kind = formKind(form);
  if (p && (p.password || p.newPassword)) {
    let username = p.username;
    // The email, when Chromium's username was only the nearest text field before the password.
    if (username && p.usernameMethod === 'base' && nearestOnly(username)) {
      const firstPassword = (p.password ?? p.newPassword)!;
      const before = candidates.slice(0, candidates.indexOf(firstPassword));
      const email = before.filter((f) => isTextInput(f) && f.type !== 'password' && f.focusable && isEmailish(f) && !(mode === 'saving' && passwordFieldValue(f) === '')).pop();
      if (email) username = email;
    }
    const roles = new Map<number, PasswordFieldRole>();
    let current: PasswordField | null = null;
    let fresh: PasswordField | null = null;
    let confirmation: PasswordField | null = null;
    const passwords = [p.password, p.newPassword, p.confirmation].filter((f): f is PasswordField => f !== null);
    if (passwords.length === 1) {
      // One password: its own words, then the form's kind, then Chromium's role for it.
      const f = passwords[0]!;
      const own = ownVariant(f);
      const variant = own ?? (kind === 'sign-up' || kind === 'reset' ? 'new' : kind === 'sign-in' ? 'current' : p.newPassword ? 'new' : 'current');
      if (variant === 'new') fresh = f;
      else current = f;
    } else if (passwords.length === 2 && !p.confirmation) {
      // Chromium's guess for two passwords that aren't equal (or are empty): current and new, for change forms.
      // A sign-up or reset form's two are a new one and its confirmation.
      const [a, b] = [p.password!, p.newPassword!];
      if (kind === 'change' || ownVariant(a) === 'current') {
        current = a;
        fresh = b;
      } else if (kind === 'sign-in' && !ownVariant(b) && !ownVariant(a)) {
        // Two passwords on a sign-in form with nothing to tell them apart: the first is what you sign in with.
        current = a;
      } else {
        fresh = a;
        confirmation = b;
      }
    } else {
      current = p.password;
      fresh = p.newPassword;
      confirmation = p.confirmation;
    }
    if (username) roles.set(username.key, 'username');
    if (current) roles.set(current.key, 'current-password');
    if (fresh) roles.set(fresh.key, 'new-password');
    if (confirmation) roles.set(confirmation.key, 'confirmation-password');
    const finalKind: PasswordFormKind = kind !== 'unknown' ? kind : current && fresh ? 'change' : current ? 'sign-in' : fresh ? 'sign-up' : kind;
    return { kind: finalKind, roles, username, password: current, newPassword: fresh, confirmation };
  }
  // A username-only form, the first step of a two-step sign-in: no password field at all, exactly one
  // text-like field you can type in that reads as a username or an email, in a form that reads as
  // sign-in, or whose button says Next or Continue beside a field that's plainly a username.
  if (form.fields.some((f) => usablePassword(f, vetoed))) return null;
  const typeable = candidates.filter((f) => isTextInput(f) && f.visible && f.focusable && !f.readOnly);
  if (typeable.length !== 1) return null;
  const f = typeable[0]!;
  if (mode === 'saving' && passwordFieldValue(f) === '') return null;
  const looks = saysUsername(f) || isEmailish(f) || USERNAMEISH.test(fieldText(f)) || matchWords(DDG_USERNAME, f.label) === 'yes' || f.type === 'tel';
  const strong = saysUsername(f) || STRONG_USERNAME.test(f.id) || STRONG_USERNAME.test(f.name) || f.type === 'email' || /user|login|member|account|e-?mail/i.test(`${f.name} ${f.id}`);
  const nextButton = [...form.words.submits, ...form.words.buttons].some((b) => NEXT.test(b) || SIGN_IN.test(b));
  if (!looks || !(kind === 'sign-in' || saysUsername(f) || (strong && nextButton))) return null;
  // A newsletter's email and its button ("Anmelden" is both sign in and subscribe) is no first step.
  if (!saysUsername(f) && NEWSLETTER.test(spaced(`${form.words.headings.join(' ')} ${form.words.attrs} ${form.words.submits.join(' ')} ${fieldText(f)}`))) return null;
  return { kind: 'username-only', roles: new Map([[f.key, 'username']]), username: f, password: null, newPassword: null, confirmation: null };
}

/**
 * The most credential forms the agent reports at once (`passwords:forms`). Each takes at most about
 * 650 bytes as JSON (an id, a kind, three signatures of 20 + 80 + 80 characters), so 20 stay under
 * the channel's 16 KB limit; a page with more has the first 20 checked.
 */
export const PASSWORDS_MAX_FORMS = 20;

/**
 * Whether a button's words say it submits a credential form: sign in, sign up, Next or Continue
 * (S17 §6 step 2). For a `type="button"` that a page's script signs in with, which no `submit` follows.
 */
export const readsAsSubmit = (words: string): boolean => {
  const text = spaced(words);
  return SIGN_IN.test(text) || SIGN_UP.test(text) || NEXT.test(text.trim());
};
