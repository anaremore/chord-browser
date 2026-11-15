// Spike S17 M0: what S17 §4 adds on top of the Chromium port, quickly (throwaway). Chromium
// gets these from Google's servers; Firefox works them out locally, and these are its ideas
// restated (nothing copied, so no MPL file): the kind of form from its words, a username-only
// first step, vetoes for search and code fields, the email field preferred as username, and a
// password field's own words (new, confirm, current).
//
// Written from the bake-off's failure categories on the whole corpus (about a dozen examples
// read), so bakeoff.ts also reports it on each half of the corpus apart.
import { isTextInput, kOneTimePwdRe, parse, type FieldRecord, type Parsed } from './chromium/form-parser.ts';

export interface FormWords {
  attrs: string;
  buttons: string[];
  headings: string[];
  title: string;
}
export type Kind = 'sign-in' | 'sign-up' | 'change' | 'reset' | 'unknown';
export type Role = 'username' | 'current' | 'new' | null;

const SIGN_IN = /\b(sign|log)[ -]?(in|on)\b|\blogin\b|\bsignin\b|anmelden|iniciar sesi|connexion|se connecter|accedi|entrar|inloggen/i;
const SIGN_UP = /\bsign[ -]?up\b|\bregist(er|ration|rieren)\b|create (an |your |a free |new |my )?account|\bjoin\b|get started|\bsignup\b|crear cuenta|cr[ée]er un compte|konto erstellen|new account|\benroll/i;
const CHANGE = /change (your |the )?password|update (your |the )?password|current password|old password/i;
const RESET = /reset (your |the )?password|(set|choose|create) (a )?new password|forgot/i;
const NEXT = /^\s*(next|continue|weiter|suivant|siguiente|continuar)\b/i;
const USERNAMEISH = /user|login|e-?mail|account|ident|member|nick/i;
const STRONG_USERNAME = /^(user(name|id|_?name)?|login(id|name)?|e-?mail|identifier|account(name)?|loginfmt)$/i;
const VETO = /search|captcha|coupon|promo|voucher|zip|postal|newsletter|subscri/i;
const NEW_WORDS = /\bnew\b|create|choose|confirm|repeat|re-?type|re-?enter|again|verify|\bconf|password2|_2\b/i;
const CURRENT_WORDS = /current|\bold\b|existing/i;
const EMAILISH = (f: FieldRecord) => f.type === 'email' || /e-?mail/i.test(`${f.name} ${f.id} ${f.autocomplete}`) || /e-?mail/i.test(f.label);
const text = (f: FieldRecord) => `${f.name} ${f.id} ${f.label} ${f.placeholder}`;
// registerForm, onlyRegister, sign_in → separate words, so \b matches.
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_./?=&-]+/g, ' ');

/** Sign-in or sign-up from the form's words: its buttons first, then its headings, its attributes, the page's title. */
export function kindOf(form: FormWords, parsed: Parsed | null, fields: FieldRecord[]): Kind {
  const all = words(`${form.buttons.join(' ')} ${form.headings.join(' ')} ${form.attrs} ${form.title}`);
  const ac = fields.map((f) => f.autocomplete).join(' ');
  if (/current-password/.test(ac) && /new-password/.test(ac)) return 'change';
  if (CHANGE.test(all)) return 'change';
  for (const source of [form.buttons.join(' '), form.headings.join(' '), form.attrs, form.title].map(words)) {
    const up = SIGN_UP.test(source);
    const inn = SIGN_IN.test(source);
    if (up !== inn) return up ? 'sign-up' : 'sign-in';
  }
  if (RESET.test(all) && !parsed?.username) return 'reset';
  if (/new-password/.test(ac)) return 'sign-up';
  if (/current-password/.test(ac)) return 'sign-in';
  // Many fields besides the password: names, phone, address. A sign-in form has one or two.
  const others = fields.filter((f) => isTextInput(f) && f.type !== 'password' && f.visible).length;
  if (others >= 3) return 'sign-up';
  return 'unknown';
}

/** Roles for one form's fields: the Chromium port, then Chord's additions when `chord` is set. */
export function classify(fields: FieldRecord[], form: FormWords, chord: boolean): { roles: Map<FieldRecord, Role>; kind: Kind } {
  const roles = new Map<FieldRecord, Role>();
  if (!chord) {
    // A parse that found its passwords only by relaxing the filters (Chromium's only_for_fallback) gets no suggestions.
    const p0 = parse(fields);
    const p = p0?.isFallback ? null : p0;
    if (p?.username) roles.set(p.username, 'username');
    if (p?.password) roles.set(p.password, 'current');
    if (p?.newPassword) roles.set(p.newPassword, 'new');
    if (p?.confirmation) roles.set(p.confirmation, 'new');
    return { roles, kind: 'unknown' };
  }
  // Vetoes: a field that reads as search, a code or a newsletter is no username (unless autocomplete says it is).
  const vetoed = (f: FieldRecord) => f.type !== 'password' && f.autocomplete !== 'username' && (f.type === 'search' || VETO.test(text(f)) || kOneTimePwdRe.test(`${f.name} ${f.id}`));
  const candidates = fields.filter((f) => !vetoed(f));
  const p0 = parse(candidates);
  const p = p0?.isFallback ? null : p0;
  const kind = kindOf(form, p, fields);
  if (p) {
    let username = p.username;
    // The email field, when the nearest field before the password was chosen only for being nearest.
    if (username && p.usernameMethod === 'base' && !EMAILISH(username) && !USERNAMEISH.test(text(username))) {
      const before = candidates.slice(0, candidates.indexOf(p.password ?? p.newPassword!));
      const email = before.filter((f) => isTextInput(f) && f.type !== 'password' && f.focusable && EMAILISH(f)).pop();
      if (email) username = email;
    }
    if (username) roles.set(username, 'username');
    const passwords = [p.password, p.newPassword, p.confirmation].filter(Boolean) as FieldRecord[];
    // A password field's own words, then the form's kind, then Chromium's guess.
    const own = (f: FieldRecord): Role => (CURRENT_WORDS.test(text(f)) ? 'current' : NEW_WORDS.test(text(f)) ? 'new' : null);
    if (passwords.length === 1) {
      const f = passwords[0];
      const byKind = kind === 'sign-up' || kind === 'reset' ? 'new' : kind === 'sign-in' ? 'current' : p.newPassword ? 'new' : 'current';
      roles.set(f, own(f) ?? byKind);
    } else if (passwords.length === 2 && !p.confirmation) {
      // Two empty passwords: Chromium guesses current and new, for change forms; a sign-up or reset form's are new and confirm.
      const both: Role[] = kind === 'change' || own(p.password!) === 'current' ? ['current', 'new'] : kind === 'sign-in' && !own(p.newPassword!) ? ['current', 'current'] : ['new', 'new'];
      roles.set(p.password!, both[0]);
      roles.set(p.newPassword!, both[1]);
    } else {
      if (p.password) roles.set(p.password, 'current');
      if (p.newPassword) roles.set(p.newPassword, 'new');
      if (p.confirmation) roles.set(p.confirmation, 'new');
    }
    return { roles, kind };
  }
  // A username-only form, the first step of a two-step sign-in (Firefox's rule, restated): exactly one
  // visible text-like field, which reads as a username or email, in a form that reads as sign-in or
  // whose button says Next or Continue, with a field that's plainly a username.
  const visible = candidates.filter((f) => isTextInput(f) && f.visible && f.focusable && !f.readOnly);
  if (visible.length === 1 && !fields.some((f) => f.type === 'password')) {
    const f = visible[0];
    const acUser = f.autocomplete.split(/\s+/).includes('username');
    const looks = acUser || EMAILISH(f) || USERNAMEISH.test(text(f)) || f.type === 'tel';
    const strong = acUser || STRONG_USERNAME.test(f.id) || STRONG_USERNAME.test(f.name);
    if (looks && (kind === 'sign-in' || acUser || (strong && form.buttons.some((b) => NEXT.test(b) || SIGN_IN.test(b))))) roles.set(f, 'username');
  }
  return { roles, kind };
}
