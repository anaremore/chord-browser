/*
 * Portions derived from Chromium, BSD-3-Clause.
 * Copyright 2018 The Chromium Authors. Use of this source code is governed by a BSD-style
 * license that can be found in Chromium's LICENSE file
 * (https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 */

/**
 * Chromium's password form parser, transliterated (S17 §3, §4), at
 * chromium/chromium@4e452b6233bdb0e5cbd67d8837a54cc3e407de91 (main, 2026-11-15):
 *
 * - `components/password_manager/core/browser/form_parsing/form_data_parser.cc`:
 *   `ProcessFields`, `ParseUsingAutocomplete`, `ParseUsingBaseHeuristics` with
 *   `GetRelevantPasswords`, `LocateSpecificPasswords` and `FindUsernameFieldBaseHeuristics`,
 *   `FindUsernameInHtmlParserResult`, `FindConfirmationPasswordField`, `ResetIfConflict`,
 *   `Sanitize`, and `ParseAndReturnParsingResult`'s order of stages;
 * - `components/autofill/content/renderer/html_based_username_detector.cc`:
 *   `FindUsernameFieldInternal`, as `htmlUsernamePredictions`.
 *
 * Left out, since Chord has none of them: model predictions, server predictions and
 * overrides, UKM and UMA, `GetSignonRealm` (main works out origins, S17 §5) and the URL
 * check. Chord's own additions (the form's kind, vetoes, the password's variant, the
 * username-only form) are in password-forms.ts, on top of this. The test cases that
 * exercise this file are Chromium's own, in core/test/password-parser.test.ts.
 *
 * Pure functions over field records: no DOM. It runs inside the page, in the passwords
 * agent's isolated world, where a field's value is read; nothing here sends one anywhere.
 */
import {
  CARD_CVC_RE,
  HIDDEN_VALUE_RE,
  MINIMUM_PASSWORD_LENGTH,
  ONE_TIME_CODE_RE,
  PASSWORD_NAME_RE,
  SOCIAL_SECURITY_RE,
  kNegativeLatin,
  kNegativeNonLatin,
  kTechnicalWords,
  kUserLatin,
  kUserNonLatin,
  kUsernameLatin,
  kWeakWords,
} from './password-vocabulary';

/** What Chromium's `FormFieldData` carries for parsing (S17 §4): one form control, as the agent read it. */
export interface PasswordField {
  /** Unique within the document: Chromium's renderer id. */
  readonly key: number;
  /** An input's type, lower case; `select` or `textarea` for those. */
  readonly type: string;
  /** The `id` attribute. */
  readonly id: string;
  /** The `name` attribute. */
  readonly name: string;
  /** The `autocomplete` attribute, lower case. */
  readonly autocomplete: string;
  /** What a person reads as its label (Chromium's `FormFieldData::label`): its label, aria label, nearby text or placeholder. */
  readonly label: string;
  readonly placeholder: string;
  /** The `maxlength`, or -1 for none. */
  readonly maxLength: number;
  readonly readOnly: boolean;
  /** Blink's `IsFocusable`: rendered, not `visibility: hidden`, not disabled or inert. */
  readonly focusable: boolean;
  /** On screen: `checkVisibility` with opacity, at least 4 px each way. */
  readonly visible: boolean;
  /** You typed in it since the page loaded (Chromium's `kUserTyped`). */
  readonly userTyped: boolean;
  /** Chord filled it (Chromium's `kAutofilled`). */
  readonly autofilled: boolean;
  /** The value, **only inside the page**. Empty where it isn't read (the corpus, any record sent to main). */
  readonly value: string;
  /** What you typed when it differs from `value` (Chromium's `user_input`; a page that rewrites the value). Usually empty. */
  readonly userInput?: string;
}

/** Filling: which field is which, before you type. Saving: what you just submitted (only fields with values count). */
export type ParseMode = 'filling' | 'saving';

/** How the username was found, as Chromium's `UsernameDetectionMethod` (the server's and the model's left out). */
export type UsernameMethod = 'none' | 'base' | 'html' | 'autocomplete';

/** Chromium's `ReadonlyPasswordFields`: how many password fields were passed over for being read-only. */
export type ReadonlyStatus = 'no-heuristics' | 'none-ignored' | 'some-ignored' | 'all-ignored';

/** A distinct non-empty value seen in the form, and the first field that held it (Chromium's `AlternativeElement`). */
export interface AlternativeValue {
  readonly value: string;
  readonly key: number;
  readonly name: string;
}

/** What Chromium's `PasswordForm` and `FormParsingResult` say, by field. */
export interface ParsedPasswordForm {
  readonly username: PasswordField | null;
  readonly password: PasswordField | null;
  readonly newPassword: PasswordField | null;
  readonly confirmation: PasswordField | null;
  /** Found only by relaxing the filters (`only_for_fallback`): offer nothing from it by yourself. */
  readonly isFallback: boolean;
  /** A username with no password (`is_single_username`), found by `autocomplete=username`. */
  readonly isSingleUsername: boolean;
  /** A field's `autocomplete` ends in `webauthn` (filling only). */
  readonly acceptsWebauthn: boolean;
  /** The new password was found by `autocomplete` and its maxlength allows a generated one (filling only). */
  readonly isNewPasswordReliable: boolean;
  readonly usernameMethod: UsernameMethod;
  readonly alternativePasswords: readonly AlternativeValue[];
  readonly alternativeUsernames: readonly AlternativeValue[];
  /** Fields that look like a password field, where generating one could be offered by hand. */
  readonly manualGeneration: readonly number[];
}

/** The parse, and how read-only fields fared (Chromium keeps that on the parser; it's set even with no form). */
export interface PasswordParse {
  readonly form: ParsedPasswordForm | null;
  readonly readonlyStatus: ReadonlyStatus;
}

export interface ParseOptions {
  /** Usernames saved for this site, lower case: a field holding one wins as the username. */
  readonly storedUsernames?: ReadonlySet<string>;
  /** The HTML-based username predictions by key, most reliable first (Chromium computes them in the renderer). Defaults to `htmlUsernamePredictions`. */
  readonly usernamePredictions?: readonly number[];
}

/** `kMaxParseableFields`. */
export const MAX_PARSEABLE_FIELDS = 10_000;

type AutocompleteFlag = 'none' | 'username' | 'current-password' | 'new-password' | 'one-time-code' | 'cc';

/** `ParseAutocomplete`: only the last token counts, after a trailing `webauthn`. */
export function parseAutocomplete(attribute: string): { flag: AutocompleteFlag; webauthn: boolean } {
  const tokens = attribute.split(/[\t\n\f\r ]+/).filter(Boolean);
  let webauthn = false;
  if (tokens.length && tokens[tokens.length - 1]!.toLowerCase() === 'webauthn') {
    webauthn = true;
    tokens.pop();
  }
  const last = tokens[tokens.length - 1];
  if (last === undefined) return { flag: 'none', webauthn };
  const lower = last.toLowerCase();
  const flag: AutocompleteFlag =
    lower === 'username'
      ? 'username'
      : lower === 'current-password'
        ? 'current-password'
        : lower === 'new-password'
          ? 'new-password'
          : lower === 'one-time-code'
            ? 'one-time-code'
            : // Case-sensitive in Chromium.
              last.startsWith('cc-')
              ? 'cc'
              : 'none';
  return { flag, webauthn };
}

/** `Interactability`: typed in (certain) > focusable (possible) > neither (unlikely). */
const UNLIKELY = 0;
const POSSIBLE = 1;
const CERTAIN = 2;
type Interactability = typeof UNLIKELY | typeof POSSIBLE | typeof CERTAIN;

interface Processed {
  readonly field: PasswordField;
  readonly flag: AutocompleteFlag;
  readonly isPassword: boolean;
  readonly webauthn: boolean;
  readonly interactability: Interactability;
}

/** `FormFieldData::IsTextInputElement`. */
const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'password', 'search', 'tel', 'url', 'email', 'number']);
export const isTextInput = (field: PasswordField): boolean => TEXT_TYPES.has(field.type);

/** `GetFieldValue`: what you typed if the page changed it, else the value. */
export const passwordFieldValue = (field: PasswordField): string => field.userInput || field.value;

const isCreditCardField = (p: Processed) => p.flag === 'cc' || CARD_CVC_RE.test(p.field.name) || CARD_CVC_RE.test(p.field.id);

/** `IsNotPasswordField`: a card code, a one-time code or a national id, by `autocomplete`, id or name. */
function isNotPasswordField(p: Processed): boolean {
  if (isCreditCardField(p) || p.flag === 'one-time-code' || SOCIAL_SECURITY_RE.test(p.field.name) || SOCIAL_SECURITY_RE.test(p.field.id)) return true;
  return ONE_TIME_CODE_RE.test(p.field.name) || ONE_TIME_CODE_RE.test(p.field.id);
}

/** `MatchesInteractability`: a field Chord filled counts as typed in. */
const matchesInteractability = (p: Processed, bar: Interactability) => p.interactability >= bar || (bar === CERTAIN && p.field.autofilled);

/** `IsProbablyNotUsername`: empty, or one or two digits. */
const isProbablyNotUsername = (s: string) => s === '' || (s.length < 3 && /^[0-9]+$/.test(s));

/** `SignificantFields`. */
class Significant {
  username: PasswordField | null = null;
  password: PasswordField | null = null;
  newPassword: PasswordField | null = null;
  confirmation: PasswordField | null = null;
  isFallback = false;
  isSingleUsername = false;
  acceptsWebauthn = false;
  method: UsernameMethod = 'none';
  readonly manualGeneration: number[] = [];

  hasPasswords(): boolean {
    return this.password !== null || this.newPassword !== null;
  }
  has(field: PasswordField): boolean {
    return field === this.username || field === this.password || field === this.newPassword || field === this.confirmation;
  }
  recordMethod(method: UsernameMethod): void {
    if (this.method === 'none' && this.username) this.method = method;
  }
  locateSpecificPasswords(passwords: readonly PasswordField[]): void {
    const [a, b, c] = passwords as [PasswordField, PasswordField | undefined, PasswordField | undefined];
    if (!b) {
      this.password = a;
    } else if (!c) {
      // Two identical non-empty passwords are a new one and its confirmation; otherwise (empty ones included) current and new.
      if (a.value !== '' && a.value === b.value) {
        this.newPassword = a;
        this.confirmation = b;
      } else {
        this.password = a;
        this.newPassword = b;
      }
    } else if (a.value !== '' && a.value === b.value && a.value === c.value) {
      this.password = a;
    } else if (b.value === c.value) {
      this.password = a;
      this.newPassword = b;
      this.confirmation = c;
    } else if (a.value === b.value) {
      this.newPassword = a;
      this.confirmation = b;
    } else {
      this.password = a;
    }
  }
  /** `ResetIfConflict`: one field in two roles throws the stage away. */
  resetIfConflict(): boolean {
    const roles = [this.username, this.password, this.newPassword, this.confirmation].filter((f) => f !== null);
    if (new Set(roles).size === roles.length) return false;
    this.username = this.password = this.newPassword = this.confirmation = null;
    this.isFallback = this.isSingleUsername = this.acceptsWebauthn = false;
    this.method = 'none';
    this.manualGeneration.length = 0;
    return true;
  }
  /** `Sanitize`: a last resort for a field left in two roles. */
  sanitize(): void {
    if (this.confirmation && (this.confirmation === this.newPassword || this.confirmation === this.password)) this.confirmation = null;
    if (this.password && this.password === this.newPassword) {
      if (this.confirmation) this.password = null;
      else this.newPassword = null;
    }
    if (!this.username) return;
    if (this.username.type === 'password' && (this.username === this.password || this.username === this.newPassword || this.username === this.confirmation)) this.username = null;
    else if (this.username === this.password) this.password = null;
    else if (this.username === this.newPassword) this.newPassword = null;
    else if (this.username === this.confirmation) this.confirmation = null;
  }
}

function parseUsingAutocomplete(fields: readonly Processed[], mode: ParseMode, r: Significant): void {
  let newByAutocomplete = false;
  let ignoreNew = false;
  let marked: PasswordField | null = null;
  let usernames = 0;
  for (const p of fields) {
    if (r.has(p.field)) continue;
    switch (p.flag) {
      case 'username':
        if (p.isPassword || r.username) continue;
        usernames++;
        marked = p.field;
        break;
      case 'current-password':
        if (!p.isPassword || r.password) continue;
        r.password = p.field;
        break;
      case 'new-password':
        if (!p.isPassword || ignoreNew) continue;
        if (!r.newPassword) {
          r.newPassword = p.field;
          newByAutocomplete = true;
        } else if (!r.confirmation) {
          // Two new-password fields with different values when saving: the attribute is wrong.
          if (mode === 'saving' && newByAutocomplete && passwordFieldValue(r.newPassword) !== passwordFieldValue(p.field)) {
            ignoreNew = true;
            r.newPassword = null;
            continue;
          }
          r.confirmation = p.field;
        }
        break;
      default:
        break;
    }
  }
  if (!r.username && usernames === 1) r.username = marked;
}

/** `IsLikelyPassword`; counts a read-only field passed over. */
function isLikelyPassword(p: Processed, counts: { readonly: number }): boolean {
  if (p.field.readOnly && !(p.field.userTyped || p.field.autofilled)) {
    counts.readonly++;
    return false;
  }
  return !isNotPasswordField(p);
}

function getRelevantPasswords(fields: readonly Processed[], mode: ParseMode, best: Interactability, r: Significant, status: { value: ReadonlyStatus }): PasswordField[] {
  let passwords = fields.filter((p) => p.isPassword);
  if (!passwords.length) return [];
  const all = passwords.length;
  const counts = { readonly: 0 };
  passwords = passwords.filter((p) => matchesInteractability(p, best));
  if (mode === 'saving') passwords = passwords.filter((p) => passwordFieldValue(p.field) !== '');
  let filtered = passwords.filter((p) => isLikelyPassword(p, counts));
  const username = r.username;
  if (username && username.type === 'password') filtered = filtered.filter((p) => p.field.key !== username.key);
  status.value = counts.readonly === 0 ? 'none-ignored' : counts.readonly < all ? 'some-ignored' : 'all-ignored';
  if (!filtered.length) {
    filtered = passwords;
    r.isFallback = true;
  }
  return filtered.map((p) => p.field);
}

function findUsernameBase(fields: readonly Processed[], firstPassword: number, stored: ReadonlySet<string>, mode: ParseMode, best: Interactability, fallback: boolean): PasswordField | null {
  let focusable: PasswordField | null = null;
  let any: PasswordField | null = null;
  for (let i = firstPassword - 1; i >= 0; i--) {
    const p = fields[i]!;
    // Chromium also skips a field predicted as a password, which only server and model predictions make.
    if (p.isPassword) continue;
    if (!matchesInteractability(p, best)) continue;
    if (mode === 'saving' && isProbablyNotUsername(passwordFieldValue(p.field))) continue;
    if (!fallback && isNotPasswordField(p)) continue;
    any ??= p.field;
    if (!focusable && p.field.focusable) focusable = p.field;
    if (stored.has(p.field.value.toLowerCase())) return p.field;
  }
  return focusable ?? any;
}

/** `ParseUsingBaseHeuristics`. Returns the best interactability among text fields before the passwords (`username_max`). */
function parseUsingBaseHeuristics(fields: readonly Processed[], stored: ReadonlySet<string>, mode: ParseMode, r: Significant, status: { value: ReadonlyStatus }): Interactability {
  let usernameMax: Interactability = UNLIKELY;
  if (r.hasPasswords() && r.username) return usernameMax;
  let first: number;
  if (!r.hasPasswords()) {
    let passwordMax: Interactability = UNLIKELY;
    for (const p of fields) if (p.isPassword && !isNotPasswordField(p) && p.interactability > passwordMax) passwordMax = p.interactability;
    const passwords = getRelevantPasswords(fields, mode, passwordMax, r, status);
    if (!passwords.length) return usernameMax;
    r.locateSpecificPasswords(passwords);
    if (!r.hasPasswords()) return usernameMax;
    first = fields.findIndex((p) => p.field === passwords[0]);
  } else {
    first = fields.findIndex((p) => p.isPassword && (p.field === r.password || p.field === r.newPassword || p.field === r.confirmation));
  }
  // Chromium CHECKs this: autocomplete only ever picks password fields as passwords.
  if (first < 0 || r.username) return usernameMax;
  for (let i = 0; i < first; i++) {
    const p = fields[i]!;
    if (!p.isPassword && !isNotPasswordField(p) && p.interactability > usernameMax) usernameMax = p.interactability;
  }
  r.username = findUsernameBase(fields, first, stored, mode, usernameMax, r.isFallback);
  return usernameMax;
}

/** `FindConfirmationPasswordField`: the next field after the new password with the same value and reach. */
function findConfirmation(fields: readonly Processed[], newPassword: PasswordField): PasswordField | null {
  const at = fields.findIndex((p) => p.field === newPassword);
  if (at < 0) return null;
  const np = fields[at]!;
  for (let i = at + 1; i < fields.length; i++) {
    const p = fields[i]!;
    if (matchesInteractability(p, np.interactability) && passwordFieldValue(np.field) === passwordFieldValue(p.field)) return p.field;
  }
  return null;
}

// ----- html_based_username_detector.cc -----

const DELIMITERS = /[$"'?%*@!\\/&^#:+~`;,>|<.[\](){}\-_ 0-9\t\n\v\f\r]+/u;
const MIN_WORD = 4;

interface Tokens {
  value: string;
  readonly short: Set<string>;
}

/** `AppendValueAndShortTokens`: words joined, `$` between sources; words under 4 letters kept apart. */
function appendTokens(raw: string, into: Tokens): void {
  const words = raw.toLowerCase().split(DELIMITERS).filter(Boolean);
  if (into.value) into.value += '$';
  for (const w of words) {
    if (w.length < MIN_WORD) into.short.add(w);
    into.value += w;
  }
}

const inDictionary = (t: Tokens, dictionary: readonly string[]) => dictionary.some((word) => (word.length < MIN_WORD ? t.short.has(word) : t.value.includes(word)));

interface UsernameData {
  readonly key: number;
  readonly developer: Tokens;
  readonly user: Tokens;
}
type Category = readonly [latin: readonly string[], nonLatin: readonly string[]];
const inCategory = (d: UsernameData, [latin, nonLatin]: Category) => inDictionary(d.user, latin) || inDictionary(d.user, nonLatin) || inDictionary(d.developer, latin);

const NEGATIVE: Category = [kNegativeLatin, kNegativeNonLatin];
// As Chromium has it: the username category's non-Latin list is kUsernameLatin again.
const POSITIVE: readonly Category[] = [
  [kUsernameLatin, kUsernameLatin],
  [kUserLatin, kUserNonLatin],
  [kTechnicalWords, []],
  [kWeakWords, []],
];

/**
 * `FindUsernameFieldInternal`: the form's username candidates by their words, most reliable
 * first. A category that matches more than two fields says nothing.
 */
export function htmlUsernamePredictions(fields: readonly PasswordField[]): number[] {
  const data: UsernameData[] = [];
  for (const f of fields) {
    if ((!f.name && !f.id && !f.label) || f.type === 'password') continue;
    const developer: Tokens = { value: '', short: new Set() };
    // FormFieldData::name() is the name attribute, or the id when there's none.
    appendTokens(f.name || f.id, developer);
    appendTokens(f.id, developer);
    const user: Tokens = { value: '', short: new Set() };
    appendTokens(f.label, user);
    data.push({ key: f.key, developer, user });
  }
  const possible = data.filter((d) => !inCategory(d, NEGATIVE));
  const out: number[] = [];
  for (const category of POSITIVE) {
    const found = possible.filter((d) => inCategory(d, category));
    if (found.length > 0 && found.length <= 2 && !out.includes(found[0]!.key)) out.push(found[0]!.key);
  }
  return out;
}

const NO_FORM: PasswordParse = { form: null, readonlyStatus: 'no-heuristics' };

/** `FormDataParser::ParseAndReturnParsingResult`, for one form's fields in document order. */
export function parsePasswordForm(fields: readonly PasswordField[], mode: ParseMode, options: ParseOptions = {}): PasswordParse {
  if (fields.length > MAX_PARSEABLE_FIELDS) return NO_FORM;
  const status: { value: ReadonlyStatus } = { value: 'no-heuristics' };
  const alternativePasswords: AlternativeValue[] = [];
  const alternativeUsernames: AlternativeValue[] = [];
  const seenPasswords = new Set<string>();
  const seenUsernames = new Set<string>();
  const processed: Processed[] = [];
  for (const field of fields) {
    if (!isTextInput(field)) continue;
    const value = passwordFieldValue(field);
    if (mode === 'saving' && (value === '' || HIDDEN_VALUE_RE.test(value))) continue;
    const isPassword = field.type === 'password';
    if (value !== '') {
      const seen = isPassword ? seenPasswords : seenUsernames;
      if (!seen.has(value)) {
        seen.add(value);
        (isPassword ? alternativePasswords : alternativeUsernames).push({ value, key: field.key, name: field.name || field.id });
      }
    }
    const { flag, webauthn } = parseAutocomplete(field.autocomplete);
    processed.push({ field, flag, webauthn, isPassword, interactability: field.userTyped ? CERTAIN : field.focusable ? POSSIBLE : UNLIKELY });
  }
  if (!processed.length) return NO_FORM;

  const r = new Significant();
  for (const p of processed) if (p.isPassword || PASSWORD_NAME_RE.test(p.field.name) || PASSWORD_NAME_RE.test(p.field.id)) r.manualGeneration.push(p.field.key);

  // (3) autocomplete.
  parseUsingAutocomplete(processed, mode, r);
  if (!r.resetIfConflict()) r.recordMethod('autocomplete');
  const usernameBefore = r.username !== null;
  const newPasswordBefore = r.newPassword !== null;

  // (4) base heuristics, then the HTML username detector.
  if (!r.isSingleUsername) {
    const usernameMax = parseUsingBaseHeuristics(processed, options.storedUsernames ?? new Set(), mode, r, status);
    r.recordMethod('base');
    if (!usernameBefore) {
      const predictions = options.usernamePredictions ?? htmlUsernamePredictions(fields);
      let byContext: PasswordField | null = null;
      for (const key of predictions) {
        const hit = processed.find((p) => p.field.key === key && matchesInteractability(p, usernameMax));
        if (hit) {
          byContext = hit.field;
          break;
        }
      }
      if (byContext && !(mode === 'saving' && byContext.value === '')) {
        r.username = byContext;
        if (r.method === 'none' || r.method === 'base') r.method = 'html';
      }
    }
    if (mode === 'saving' && r.newPassword && !r.confirmation) r.confirmation = findConfirmation(processed, r.newPassword);
  }

  r.sanitize();
  if (!r.hasPasswords() && r.method === 'autocomplete') r.isSingleUsername = true;
  if (mode === 'filling' && processed.some((p) => p.webauthn)) r.acceptsWebauthn = true;
  // No generated password on a form that takes passkeys (crbug.com/373648911).
  if (r.acceptsWebauthn) {
    r.password = r.newPassword && !r.password ? r.newPassword : r.password;
    r.newPassword = null;
    r.confirmation = null;
  }
  const isNewPasswordReliable = mode === 'filling' && r.newPassword !== null && r.newPassword.maxLength >= MINIMUM_PASSWORD_LENGTH && newPasswordBefore;
  // A one-character password is a split PIN or code box: never offered for saving by itself.
  const tooShort = (f: PasswordField | null) => f !== null && passwordFieldValue(f).length <= 1;
  if (mode === 'saving' && ((!r.newPassword && tooShort(r.password)) || tooShort(r.newPassword))) r.isFallback = true;

  // AssemblePasswordForm.
  if (!r.hasPasswords() && !r.isSingleUsername && !r.acceptsWebauthn) return { form: null, readonlyStatus: status.value };
  return {
    form: {
      username: r.username,
      password: r.password,
      newPassword: r.newPassword,
      confirmation: r.confirmation,
      isFallback: r.isFallback,
      isSingleUsername: r.isSingleUsername,
      acceptsWebauthn: r.acceptsWebauthn,
      isNewPasswordReliable,
      usernameMethod: r.method,
      alternativePasswords,
      alternativeUsernames,
      manualGeneration: r.manualGeneration,
    },
    readonlyStatus: status.value,
  };
}
