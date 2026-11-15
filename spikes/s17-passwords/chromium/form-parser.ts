// Portions derived from Chromium, BSD-3.
// Copyright 2017 The Chromium Authors. Use of this source code is governed by a BSD-style
// license that can be found in Chromium's LICENSE file
// (https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
//
// A quick transliteration, for spike S17 M0 only (throwaway), of the filling half of
//   components/password_manager/core/browser/form_parsing/form_data_parser.cc  (ParseUsingAutocomplete,
//     ParseUsingBaseHeuristics, GetRelevantPasswords, LocateSpecificPasswords, Sanitize, ResetIfConflict,
//     FindUsernameInHtmlParserResult)
//   components/autofill/content/renderer/html_based_username_detector.cc (FindUsernameFieldInternal)
//   components/password_manager/core/common/password_manager_constants.h (kSocialSecurityRe, kOneTimePwdRe, kHiddenValueRe)
//   components/autofill/core/common/autofill_regex_constants.h (kCardCvcRe)
// at chromium/chromium@4e452b6233bdb0e5cbd67d8837a54cc3e407de91 (main, 2026-11-15).
//
// Left out, as Chord has neither: model predictions, server predictions and overrides, UKM and UMA.
// Saving mode is ported where it's a line or two; the bake-off runs filling mode only.
// Plain TypeScript with erasable syntax only, so Node runs it as it is.
import { kNegativeLatin, kNegativeNonLatin, kTechnicalWords, kUserLatin, kUserNonLatin, kUsernameLatin, kWeakWords } from './vocabulary.mjs';

/** What Chromium's FormFieldData carries for this purpose (S17 §4). */
export interface FieldRecord {
  /** Unique within the page. */
  key: number;
  /** input's type, lower case; 'select', 'textarea' for those. */
  type: string;
  id: string;
  name: string;
  autocomplete: string;
  /** What a person sees: the label, else aria-label, else placeholder (Chromium's FormFieldData::label). */
  label: string;
  placeholder: string;
  maxLength: number;
  readOnly: boolean;
  focusable: boolean;
  visible: boolean;
  userTyped: boolean;
  autofilled: boolean;
  /** Only inside the page; never sent to main. Empty in the corpus. */
  value: string;
}

export type Mode = 'filling' | 'saving';

export interface Parsed {
  username: FieldRecord | null;
  password: FieldRecord | null;
  newPassword: FieldRecord | null;
  confirmation: FieldRecord | null;
  isSingleUsername: boolean;
  isFallback: boolean;
  usernameMethod: 'none' | 'autocomplete' | 'base' | 'html';
}

// ----- Regexes (Chromium's MatchesRegex is case-insensitive, Unicode) -----
const re = (s: string) => new RegExp(s, 'iu');
export const kCardCvcRe = re('verification|card.?identification|security.?code|card.?code|security.?value|security.?number|card.?pin|c-v-v|código de segurança|código de seguridad|karten.?prüfn|(?:cvn|cvv|cvc|csc|cvd|ccv)|\\bcid\\b|cccid');
export const kSocialSecurityRe = re('ssn|social.?security.?(num(ber)?|#)*');
export const kOneTimePwdRe = re(
  'one.?time|(?:\\b|_)(?:otp|otc|totp|sms|2fa|mfa)(?:\\b|_)|(?:otp|otc|totp|sms|2fa|mfa).?(?:code|token|input|val|pin|login|verif|pass|pwd|psw|auth|field)|' +
    '(?:verif(?:y|ication)?|email|phone|text|login|input|txt|user).?(?:otp|otc|totp|sms|2fa|mfa)|sms.?otp|mfa.?otp|verif(?:y|ication)?.?code|(?:\\b|_)vcode|(?:second|two|2).?factor|wfls-token|email_code',
);
const kHiddenValueRe = /^(\W)\1+$/u;

type AutocompleteFlag = 'none' | 'username' | 'current-password' | 'new-password' | 'one-time-code' | 'cc';

function parseAutocomplete(attribute: string): { flag: AutocompleteFlag; webauthn: boolean } {
  const tokens = attribute.trim().split(/\s+/).filter(Boolean);
  let webauthn = false;
  if (tokens.length && tokens[tokens.length - 1].toLowerCase() === 'webauthn') {
    webauthn = true;
    tokens.pop();
  }
  const last = (tokens[tokens.length - 1] ?? '').toLowerCase();
  const flag: AutocompleteFlag =
    last === 'username' ? 'username' : last === 'current-password' ? 'current-password' : last === 'new-password' ? 'new-password' : last === 'one-time-code' ? 'one-time-code' : last.startsWith('cc-') ? 'cc' : 'none';
  return { flag, webauthn };
}

const Interactability = { Unlikely: 0, Possible: 1, Certain: 2 } as const;
type Interactability = (typeof Interactability)[keyof typeof Interactability];

interface Processed {
  field: FieldRecord;
  flag: AutocompleteFlag;
  isPassword: boolean;
  interactability: Interactability;
  webauthn: boolean;
}

// FormFieldData::IsTextInputElement
const TEXT_TYPES = new Set(['text', 'password', 'search', 'tel', 'url', 'email', 'number']);
export const isTextInput = (f: FieldRecord) => TEXT_TYPES.has(f.type);

const isCreditCardField = (p: Processed) => p.flag === 'cc' || kCardCvcRe.test(p.field.name) || kCardCvcRe.test(p.field.id);
export function isNotPasswordField(p: Processed): boolean {
  if (isCreditCardField(p) || p.flag === 'one-time-code' || kSocialSecurityRe.test(p.field.name) || kSocialSecurityRe.test(p.field.id)) return true;
  return kOneTimePwdRe.test(p.field.name) || kOneTimePwdRe.test(p.field.id);
}

const matchesInteractability = (p: Processed, bar: Interactability) => p.interactability >= bar || (bar === Interactability.Certain && p.field.autofilled);
const isProbablyNotUsername = (s: string) => s === '' || (s.length < 3 && /^\d+$/.test(s));

class Significant {
  username: FieldRecord | null = null;
  password: FieldRecord | null = null;
  newPassword: FieldRecord | null = null;
  confirmation: FieldRecord | null = null;
  isFallback = false;
  isSingleUsername = false;
  method: Parsed['usernameMethod'] = 'none';
  hasPasswords() {
    return !!(this.password || this.newPassword);
  }
  has(f: FieldRecord) {
    return f === this.username || f === this.password || f === this.newPassword || f === this.confirmation;
  }
  locateSpecificPasswords(passwords: FieldRecord[]) {
    if (passwords.length === 1) this.password = passwords[0];
    else if (passwords.length === 2) {
      if (passwords[0].value !== '' && passwords[0].value === passwords[1].value) {
        this.newPassword = passwords[0];
        this.confirmation = passwords[1];
      } else {
        this.password = passwords[0];
        this.newPassword = passwords[1];
      }
    } else {
      const [a, b, c] = passwords;
      if (a.value !== '' && a.value === b.value && a.value === c.value) this.password = a;
      else if (b.value === c.value) {
        this.password = a;
        this.newPassword = b;
        this.confirmation = c;
      } else if (a.value === b.value) {
        this.newPassword = a;
        this.confirmation = b;
      } else this.password = a;
    }
  }
  resetIfConflict(): boolean {
    const roles = [this.username, this.password, this.newPassword, this.confirmation].filter(Boolean);
    if (new Set(roles).size !== roles.length) {
      Object.assign(this, new Significant());
      return true;
    }
    return false;
  }
  sanitize() {
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

function parseUsingAutocomplete(fields: Processed[], mode: Mode, r: Significant) {
  let byAutocomplete = false;
  let ignoreNew = false;
  let marked: FieldRecord | null = null;
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
          byAutocomplete = true;
        } else if (!r.confirmation) {
          if (mode === 'saving' && byAutocomplete && r.newPassword.value !== p.field.value) {
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

function isLikelyPassword(p: Processed): boolean {
  if (p.field.readOnly && !(p.field.userTyped || p.field.autofilled)) return false;
  return !isNotPasswordField(p);
}

function getRelevantPasswords(fields: Processed[], mode: Mode, best: Interactability, r: Significant): FieldRecord[] {
  let passwords = fields.filter((p) => p.isPassword);
  if (!passwords.length) return [];
  passwords = passwords.filter((p) => matchesInteractability(p, best));
  if (mode === 'saving') passwords = passwords.filter((p) => p.field.value !== '');
  let filtered = passwords.filter(isLikelyPassword);
  if (r.username && r.username.type === 'password') filtered = filtered.filter((p) => p.field !== r.username);
  if (!filtered.length) {
    filtered = passwords;
    r.isFallback = true;
  }
  return filtered.map((p) => p.field);
}

function findUsernameBase(fields: Processed[], firstPassword: number, stored: Set<string>, mode: Mode, best: Interactability, fallback: boolean): FieldRecord | null {
  let focusable: FieldRecord | null = null;
  let any: FieldRecord | null = null;
  for (let i = firstPassword - 1; i >= 0; i--) {
    const p = fields[i];
    if (p.isPassword) continue; // is_predicted_as_password comes only from server and model predictions
    if (!matchesInteractability(p, best)) continue;
    if (mode === 'saving' && isProbablyNotUsername(p.field.value)) continue;
    if (!fallback && isNotPasswordField(p)) continue;
    any ??= p.field;
    if (!focusable && p.field.focusable) focusable = p.field;
    if (stored.has(p.field.value.toLowerCase())) return p.field;
  }
  return focusable ?? any;
}

function parseUsingBaseHeuristics(fields: Processed[], stored: Set<string>, mode: Mode, r: Significant): Interactability {
  let usernameMax: Interactability = Interactability.Unlikely;
  if (r.hasPasswords() && r.username) return usernameMax;
  let first: number;
  if (!r.hasPasswords()) {
    let passwordMax: Interactability = Interactability.Unlikely;
    for (const p of fields) if (p.isPassword && !isNotPasswordField(p)) passwordMax = Math.max(passwordMax, p.interactability) as Interactability;
    const passwords = getRelevantPasswords(fields, mode, passwordMax, r);
    if (!passwords.length) return usernameMax;
    r.locateSpecificPasswords(passwords);
    if (!r.hasPasswords()) return usernameMax;
    first = fields.findIndex((p) => p.field === passwords[0]);
  } else {
    first = fields.findIndex((p) => p.isPassword && (p.field === r.password || p.field === r.newPassword || p.field === r.confirmation));
  }
  if (r.username) return usernameMax;
  for (let i = 0; i < first; i++) if (!fields[i].isPassword && !isNotPasswordField(fields[i])) usernameMax = Math.max(usernameMax, fields[i].interactability) as Interactability;
  r.username = findUsernameBase(fields, first, stored, mode, usernameMax, r.isFallback);
  return usernameMax;
}

// ----- html_based_username_detector.cc -----
const DELIMITERS = /[$"'?%*@!\\/&^#:+~`;,>|<.[\](){}\-_ 0-9]+/u;
const MIN_WORD = 4;
interface UsernameData {
  field: FieldRecord;
  dev: string;
  devShort: Set<string>;
  user: string;
  userShort: Set<string>;
}
function appendValue(raw: string, into: { value: string; short: Set<string> }) {
  const tokens = raw.toLowerCase().split(DELIMITERS).filter(Boolean);
  if (into.value) into.value += '$';
  for (const t of tokens) {
    if (t.length < MIN_WORD) into.short.add(t);
    into.value += t;
  }
}
function checkDictionary(value: string, short: Set<string>, dictionary: readonly string[]) {
  for (const word of dictionary) {
    if (word.length < MIN_WORD ? short.has(word) : value.includes(word)) return true;
  }
  return false;
}
function containsCategory(d: UsernameData, [latin, nonLatin]: readonly [readonly string[], readonly string[]]) {
  return checkDictionary(d.user, d.userShort, latin) || checkDictionary(d.user, d.userShort, nonLatin) || checkDictionary(d.dev, d.devShort, latin);
}
/** Chromium's username predictions for a form, most reliable first. */
export function htmlUsernamePredictions(fields: FieldRecord[]): FieldRecord[] {
  const data: UsernameData[] = [];
  for (const f of fields) {
    if ((!f.name && !f.id && !f.label) || f.type === 'password') continue;
    const dev = { value: '', short: new Set<string>() };
    // FormFieldData::name() is the name attribute, or the id when there's none.
    appendValue(f.name || f.id, dev);
    appendValue(f.id, dev);
    const user = { value: '', short: new Set<string>() };
    appendValue(f.label, user);
    data.push({ field: f, dev: dev.value, devShort: dev.short, user: user.value, userShort: user.short });
  }
  const negative = [kNegativeLatin, kNegativeNonLatin] as const;
  const possible = data.filter((d) => !containsCategory(d, negative));
  // As Chromium has it: the username category's non-Latin list is kUsernameLatin again.
  const categories = [
    [kUsernameLatin, kUsernameLatin],
    [kUserLatin, kUserNonLatin],
    [kTechnicalWords, []],
    [kWeakWords, []],
  ] as const;
  const out: FieldRecord[] = [];
  for (const c of categories) {
    const found = possible.filter((d) => containsCategory(d, c));
    if (found.length > 0 && found.length <= 2 && !out.includes(found[0].field)) out.push(found[0].field);
  }
  return out;
}

/** FormDataParser::Parse, filling or saving, for one form's fields in document order. */
export function parse(form: FieldRecord[], mode: Mode = 'filling', stored = new Set<string>()): Parsed | null {
  if (form.length > 10_000) return null; // kMaxParseableFields
  const processed: Processed[] = [];
  for (const field of form) {
    if (!isTextInput(field)) continue;
    if (mode === 'saving' && (field.value === '' || kHiddenValueRe.test(field.value))) continue;
    const { flag, webauthn } = parseAutocomplete(field.autocomplete);
    processed.push({
      field,
      flag,
      webauthn,
      isPassword: field.type === 'password',
      interactability: field.userTyped ? Interactability.Certain : field.focusable ? Interactability.Possible : Interactability.Unlikely,
    });
  }
  if (!processed.length) return null;
  const r = new Significant();
  parseUsingAutocomplete(processed, mode, r);
  if (!r.resetIfConflict() && r.username) r.method = 'autocomplete';
  const usernameBefore = !!r.username;
  const usernameMax = parseUsingBaseHeuristics(processed, stored, mode, r);
  if (r.username && r.method === 'none') r.method = 'base';
  if (!usernameBefore) {
    const predictions = htmlUsernamePredictions(form);
    const byContext = predictions.map((f) => processed.find((p) => p.field === f && matchesInteractability(p, usernameMax))).find(Boolean);
    if (byContext && !(mode === 'saving' && byContext.field.value === '')) {
      r.username = byContext.field;
      r.method = 'html';
    }
  }
  r.sanitize();
  if (!r.hasPasswords() && r.method === 'autocomplete') r.isSingleUsername = true;
  if (mode === 'filling' && processed.some((p) => p.webauthn) && r.newPassword) {
    r.password ??= r.newPassword;
    r.newPassword = null;
    r.confirmation = null;
  }
  if (!r.hasPasswords() && !r.isSingleUsername) return null; // AssemblePasswordForm returns nullptr
  return { username: r.username, password: r.password, newPassword: r.newPassword, confirmation: r.confirmation, isSingleUsername: r.isSingleUsername, isFallback: r.isFallback, usernameMethod: r.method };
}
