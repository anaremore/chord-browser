/**
 * Chord's own layer of the password detector (S17 §4, §13 layer 1): the kinds of form, the
 * vetoes, the password's variant and the username-only first step, as a table; then
 * properties over random forms. Chromium's own cases for the parser underneath are in
 * password-parser.test.ts, and real sites' forms in apps/desktop/test/forms.
 */
import { describe, expect, it } from 'vitest';
import { classifyPasswordForm, type FormWords, type PasswordField, type PasswordFieldRole, type PasswordFormKind, type PasswordFormRecord } from '../src/index';

let nextKey = 1;
/** A field as the agent's scan reports it; `f('password', { name: 'pw' })`. */
const f = (type: string, over: Partial<PasswordField> = {}): PasswordField => ({
  key: nextKey++,
  type,
  id: '',
  name: '',
  autocomplete: '',
  label: '',
  placeholder: '',
  maxLength: -1,
  readOnly: false,
  focusable: true,
  visible: true,
  userTyped: false,
  autofilled: false,
  value: '',
  ...over,
});
const words = (over: Partial<FormWords> = {}): FormWords => ({ buttons: [], submits: [], headings: [], attrs: '', title: '', ...over });
const form = (fields: PasswordField[], w: Partial<FormWords> = {}): PasswordFormRecord => ({ fields, words: words(w) });

/** Roles by each field's name (or id), and the kind. */
function classify(record: PasswordFormRecord, mode: 'filling' | 'saving' = 'filling'): { kind: PasswordFormKind | null; roles: Record<string, PasswordFieldRole> } {
  const c = classifyPasswordForm(record, mode);
  const roles: Record<string, PasswordFieldRole> = {};
  for (const field of record.fields) {
    const role = c?.roles.get(field.key);
    if (role) roles[field.name || field.id] = role;
  }
  return { kind: c?.kind ?? null, roles };
}

const user = (name = 'username', over: Partial<PasswordField> = {}) => f('text', { name, label: 'Username', ...over });
const pw = (name = 'password', over: Partial<PasswordField> = {}) => f('password', { name, label: 'Password', ...over });

describe('kinds of form', () => {
  it.each<[string, PasswordFormRecord, PasswordFormKind | null, Record<string, PasswordFieldRole>]>([
    ['sign-in, by its button', form([user(), pw()], { submits: ['Sign in'] }), 'sign-in', { username: 'username', password: 'current-password' }],
    ['sign-in, by its heading', form([user(), pw()], { headings: ['Log in to your account'] }), 'sign-in', { username: 'username', password: 'current-password' }],
    ['sign-in in German', form([user(), pw()], { submits: ['Anmelden'] }), 'sign-in', { username: 'username', password: 'current-password' }],
    ['sign-in with nothing to say so: one password is the current one', form([user(), pw()]), 'sign-in', { username: 'username', password: 'current-password' }],
    ['sign-up, by its button', form([user(), pw()], { submits: ['Create account'] }), 'sign-up', { username: 'username', password: 'new-password' }],
    ['sign-up: the submit button wins over a "Sign in" link beside it', form([user(), pw()], { submits: ['Sign up'], buttons: ['Already have an account? Sign in', 'Sign up'] }), 'sign-up', { username: 'username', password: 'new-password' }],
    ['sign-up, by its many fields', form([f('text', { name: 'first' }), f('text', { name: 'last' }), f('tel', { name: 'phone' }), f('email', { name: 'email' }), pw()]), 'sign-up', { email: 'username', password: 'new-password' }],
    ['sign-up with a confirmation', form([user(), pw('pw1'), pw('pw2', { label: 'Confirm password' })], { submits: ['Register'] }), 'sign-up', { username: 'username', pw1: 'new-password', pw2: 'confirmation-password' }],
    ['change, by autocomplete', form([pw('old', { autocomplete: 'current-password' }), pw('new', { autocomplete: 'new-password' })]), 'change', { old: 'current-password', new: 'new-password' }],
    ['change, by its heading', form([pw('a'), pw('b'), pw('c')], { headings: ['Change your password'] }), 'change', { a: 'current-password', b: 'new-password', c: 'confirmation-password' }],
    ['change, two fields, by the first one\'s words', form([pw('a', { label: 'Current password' }), pw('b', { label: 'New password' })]), 'change', { a: 'current-password', b: 'new-password' }],
    ['reset: two new passwords, no username', form([pw('a', { label: 'New password' }), pw('b', { label: 'Repeat it' })], { headings: ['Reset your password'] }), 'reset', { a: 'new-password', b: 'confirmation-password' }],
    ['a password field\'s own words beat the form\'s: "Create a password" on a page that says Sign in', form([user(), pw('p', { label: 'Create a password' })], { buttons: ['Sign in'] }), 'sign-in', { username: 'username', p: 'new-password' }],
    ['autocomplete=current-password is trusted over the page\'s words', form([user(), pw('p', { autocomplete: 'current-password' })], { buttons: ['Sign up'] }), 'sign-up', { username: 'username', p: 'current-password' }],
    ['autocomplete=new-password on a sign-in form is not (sites get it wrong)', form([user(), pw('p', { autocomplete: 'new-password' })], { submits: ['Log in'] }), 'sign-in', { username: 'username', p: 'current-password' }],
  ])('%s', (_name, record, kind, roles) => {
    expect(classify(record)).toEqual({ kind, roles });
  });
});

/** A futures broker's sign-in as the agent scanned it: MUI fields with React 19.2's `useId` ids. */
const brokerSignIn = (ids: [string, string]) =>
  form(
    [
      f('text', { id: ids[0], name: 'username', label: 'Email', placeholder: 'Enter your Email' }),
      f('password', { id: ids[1], name: 'password', label: 'Password', placeholder: 'Enter your Password' }),
    ],
    { buttons: ['Forgot your password?', 'Log In'], submits: ['Log In'], headings: ['\u200b', '\u200b'], title: 'Example - User Dashboard' },
  );

describe('ids a framework generated say nothing', () => {
  it.each<[string, [string, string]]>([
    ['React 19.2', ['_r_0_', '_r_2_']],
    ['React 19.2, rendered on the server', ['_R_0_', '_R_2_']],
    ['React 18', [':r0:', ':r2:']],
    ['React 19.0 and 19.1', ['«r0»', '«r2»']],
    ['in a longer id (Radix)', ['radix-:r0:', 'radix-:r2:']],
  ])('%s: the only password on a sign-in is the current one, not a new one for its 2', (_name, ids) => {
    expect(classify(brokerSignIn(ids))).toEqual({ kind: 'sign-in', roles: { username: 'username', password: 'current-password' } });
  });

  it.each<[string, PasswordFormRecord, Record<string, PasswordFieldRole>]>([
    ['a 2 after a password’s word is still a confirmation', form([user(), pw('password'), pw('password2', { label: '' })], { submits: ['Sign up'] }), { username: 'username', password: 'new-password', password2: 'confirmation-password' }],
    ['pwd_2 too', form([user(), pw('pwd_1', { label: '' }), pw('pwd_2', { label: '' })], { submits: ['Register'] }), { username: 'username', pwd_1: 'new-password', pwd_2: 'confirmation-password' }],
    ['a 2 alone is a counter: field_2 on a sign-in is its password', form([user(), pw('field_2', { label: '' })], { submits: ['Log in'] }), { username: 'username', field_2: 'current-password' }],
  ])('%s', (_name, record, roles) => {
    expect(classify(record).roles).toEqual(roles);
  });

  // The second of two password fields, by its own words alone: a 2 after a password's word is a confirmation's.
  it.each<[string, Partial<PasswordField>]>([
    ['pass 2', { name: 'pass 2' }],
    ['pw2', { name: 'pw2' }],
    ['passwd2', { name: 'passwd2' }],
    ['confirm-password-2', { name: 'confirm-password-2' }],
    ['Passwort 2', { label: 'Passwort 2' }],
    ['Kennwort2', { name: 'Kennwort2' }],
    ['Contraseña 2', { label: 'Contraseña 2' }],
    ['Mot de passe 2', { label: 'Mot de passe 2' }],
  ])('%s is a confirmation', (_name, over) => {
    const record = form([user(), pw('first', { label: '' }), pw('second', { label: '', ...over })], { submits: ['Register'] });
    expect(classify(record).roles).toEqual({ username: 'username', first: 'new-password', [over.name ?? 'second']: 'confirmation-password' });
  });

  it.each<[string, string, PasswordFieldRole]>([
    // JSF's colon ids name the field: the words stay (its "retype" makes it a new password's).
    ['a JSF id keeps its words', 'form:retypePassword:input', 'new-password'],
    ['a React id says nothing', 'form:r2:', 'current-password'],
  ])('%s', (_name, id, role) => {
    const record = form([user(), f('password', { id, label: '' })], { submits: ['Log in'] });
    expect(classify(record).roles[id]).toBe(role);
  });
});

/** A field you can neither see nor reach (`display: none`, a later step's, a template's). */
const HIDDEN = { visible: false, focusable: false } as const;

describe('hidden fields don’t take roles meant for visible ones', () => {
  it.each<[string, PasswordFormRecord, PasswordFormKind | null, Record<string, PasswordFieldRole>]>([
    [
      'a hidden duplicate of the sign-in fields, first: the shown pair takes the roles',
      form([
        f('email', { id: 'u-hidden', autocomplete: 'username', label: 'Email or phone', ...HIDDEN }),
        f('password', { id: 'p-hidden', autocomplete: 'current-password', label: 'Password', ...HIDDEN }),
        f('email', { id: 'u', autocomplete: 'username webauthn', label: 'Email or phone' }),
        f('password', { id: 'p', autocomplete: 'current-password', label: 'Password' }),
      ]),
      'sign-in',
      { u: 'username', p: 'current-password' },
    ],
    [
      'the same without autocomplete: the shown pair, by reach',
      form([f('email', { id: 'u-hidden', label: 'Email', ...HIDDEN }), f('password', { id: 'p-hidden', label: 'Password', ...HIDDEN }), f('email', { id: 'u', label: 'Email' }), f('password', { id: 'p', label: 'Password' })], { submits: ['Sign in'] }),
      'sign-in',
      { u: 'username', p: 'current-password' },
    ],
    [
      'a hidden field keeps a role no shown field claims (autocomplete over visibility, as Chromium)',
      form([f('text', { id: 'u-hidden', autocomplete: 'username', ...HIDDEN }), f('text', { id: 'other' }), f('password', { id: 'p', label: 'Password' })]),
      'sign-in',
      { 'u-hidden': 'username', p: 'current-password' },
    ],
    [
      'a hidden password beside a shown one: the shown one, as before',
      form([user(), f('password', { id: 'p-hidden', ...HIDDEN }), f('password', { id: 'p', label: 'Password' })], { submits: ['Log in'] }),
      'sign-in',
      { username: 'username', p: 'current-password' },
    ],
    [
      'a form hidden whole (a later "set a password" step): classed as it will be shown',
      form([f('password', { id: 'new', autocomplete: 'new-password', label: 'New password', ...HIDDEN }), f('password', { id: 'confirm', autocomplete: 'new-password', label: 'Confirm new password', ...HIDDEN })], { submits: ['Save password'] }),
      'sign-up',
      { new: 'new-password', confirm: 'confirmation-password' },
    ],
    [
      'a shown placeholder over a hidden real password field: still a sign-in (no first step to make of it)',
      form([user(), f('text', { id: 'pw-placeholder' }), f('password', { id: 'real', label: '', ...HIDDEN })]),
      'sign-in',
      { username: 'username', real: 'current-password' },
    ],
    [
      'the same form shown: a new password and its confirmation',
      form([f('password', { id: 'new', autocomplete: 'new-password', label: 'New password' }), f('password', { id: 'confirm', autocomplete: 'new-password', label: 'Confirm new password' })], { submits: ['Save password'] }),
      'sign-up',
      { new: 'new-password', confirm: 'confirmation-password' },
    ],
    [
      'hidden honeypot and code fields beside a sign-in get no role',
      form([user(), pw(), f('text', { name: 'hp_field', ...HIDDEN }), f('text', { id: 'code', label: 'Code', autocomplete: 'off', ...HIDDEN })], { submits: ['Log in'] }),
      'sign-in',
      { username: 'username', password: 'current-password' },
    ],
  ])('%s', (_name, record, kind, roles) => {
    expect(classify(record)).toEqual({ kind, roles });
  });
});

describe('vetoes', () => {
  it.each<[string, PasswordFormRecord, Record<string, PasswordFieldRole>]>([
    ['a search field before the password is passed over', form([user(), f('search', { name: 'q' }), pw()]), { username: 'username', password: 'current-password' }],
    ['a text field that reads as search', form([user(), f('text', { name: 'site-search', placeholder: 'Search the site' }), pw()]), { username: 'username', password: 'current-password' }],
    ['a coupon field', form([user(), f('text', { name: 'coupon', label: 'Promo code' }), pw()]), { username: 'username', password: 'current-password' }],
    ['a captcha', form([user(), f('text', { name: 'captcha', label: 'Type the characters' }), pw()]), { username: 'username', password: 'current-password' }],
    ['a one-time code (Chromium\'s kOneTimePwdRe)', form([user(), f('text', { name: 'otp_code' }), pw()]), { username: 'username', password: 'current-password' }],
    ['a confirmation code', form([user(), f('text', { name: 'email_confirmation_code' }), pw()]), { username: 'username', password: 'current-password' }],
    ['…but autocomplete=username always wins', form([f('search', { name: 'q', autocomplete: 'username' }), pw()]), { q: 'username', password: 'current-password' }],
    ['a security answer typed as a password', form([user(), pw(), pw('secAnswer', { label: 'Your answer' })], { submits: ['Register'] }), { username: 'username', password: 'new-password' }],
    ['a tax id typed as a password', form([pw('TIN', { label: 'TIN' })]), {}],
    ['a card code typed as a password, by its label', form([f('text', { name: 'card', autocomplete: 'cc-number' }), pw('code', { label: 'CVC' })]), {}],
    ['one-character boxes of a split PIN', form(Array.from({ length: 6 }, (_, i) => pw(`d${i}`, { maxLength: 1, label: '' }))), {}],
    ['a PIN is the password where it\'s the only one (banks, airlines)', form([user('member', { label: 'Member number' }), pw('memberPin', { label: 'PIN' })]), { member: 'username', memberPin: 'current-password' }],
    ['a PIN beside a password isn\'t', form([user(), pw(), pw('pin', { label: 'Security PIN' })]), { username: 'username', password: 'current-password' }],
    ['several PINs (gift cards) aren\'t passwords', form([f('text', { name: 'card0' }), pw('pin0', { label: 'PIN' }), f('text', { name: 'card1' }), pw('pin1', { label: 'PIN' })]), {}],
  ])('%s', (_name, record, roles) => {
    expect(classify(record).roles).toEqual(roles);
  });
});

describe('the username', () => {
  it.each<[string, PasswordFormRecord, Record<string, PasswordFieldRole>]>([
    ['the email, when the nearest field was chosen only for being nearest', form([f('email', { name: 'email', label: 'Email' }), f('text', { name: 'nickname_x', label: 'Display' }), pw()]), { email: 'username', password: 'current-password' }],
    ['a field that says username stays, email or not', form([f('email', { name: 'email', label: 'Email' }), user(), pw()]), { username: 'username', password: 'current-password' }],
    ['an email after the passwords is passed over for the username before them', form([f('text', { name: 'login', label: 'Login:' }), pw('haslo'), pw('haslo2', { label: 'Confirm Password:' }), f('text', { name: 'email', label: 'Email Address:' })], { submits: ['Complete Registration'] }), { login: 'username', haslo: 'new-password', haslo2: 'confirmation-password' }],
    ['a username asked for after the passwords stays', form([f('email', { name: 'email', label: 'Email' }), pw('pass', { label: 'Pick a Password' }), pw('re', { label: 'Enter Your Password Again' }), f('text', { id: 'username', name: 'user', label: 'Pick a Username' })], { submits: ['Sign up'] }), { user: 'username', pass: 'new-password', re: 'confirmation-password' }],
    ['a decoy before the real field: one you can\'t reach isn\'t chosen', form([f('text', { name: 'fake', focusable: false, visible: false }), user(), pw()]), { username: 'username', password: 'current-password' }],
  ])('%s', (_name, record, roles) => {
    expect(classify(record).roles).toEqual(roles);
  });
});

describe('the username-only first step', () => {
  it.each<[string, PasswordFormRecord, boolean]>([
    ['an email and Next', form([f('email', { name: 'identifier', label: 'Email or phone' })], { submits: ['Next'] }), true],
    ['autocomplete=username alone', form([f('text', { name: 'x', autocomplete: 'username' })]), true],
    ['a form that reads as sign-in', form([f('text', { name: 'login_id', label: 'User ID' })], { headings: ['Sign in'] }), true],
    ['a newsletter\'s email and "Anmelden" (sign in, and subscribe)', form([f('email', { name: 'email', label: 'E-Mail-Adresse' })], { submits: ['Anmelden'], headings: ['Abonnieren Sie unseren Newsletter'] }), false],
    ['a newsletter email and Subscribe',form([f('email', { name: 'newsletter', placeholder: 'Your email' })], { submits: ['Subscribe'] }), false],
    ['an email and Continue on a page that says nothing else', form([f('email', { name: 'email' })], { submits: ['Continue'] }), true],
    ['a search box', form([f('search', { name: 'q' })], { submits: ['Go'] }), false],
    ['two text fields', form([f('email', { name: 'email' }), f('text', { name: 'name' })], { submits: ['Next'] }), false],
    ['a confirmation code and Continue', form([f('text', { name: 'email_confirmation_code', label: 'Code' })], { submits: ['Continue'] }), false],
    ['a read-only decoy password beside it doesn\'t stop it', form([f('email', { name: 'email', autocomplete: 'username' }), pw('hiddenPassword', { readOnly: true })], { submits: ['Continue'] }), true],
    ['a real password beside it makes it a sign-in form instead', form([f('email', { name: 'email', autocomplete: 'username' }), pw()], { submits: ['Continue'] }), false],
    ['a hidden password field beside it (a later step’s) doesn’t stop it', form([f('email', { name: 'email', autocomplete: 'username' }), pw('password', HIDDEN)], { submits: ['Next'], title: 'Sign in' }), true],
    ['nor one kept focusable but out of sight (transparent)', form([f('email', { name: 'login', autocomplete: 'username webauthn' }), pw('passwd', { label: '', visible: false, focusable: true })], { submits: ['Next'], title: 'Sign in to your account' }), true],
    ['a one-step sign-in whose real password field is transparent under a custom-drawn one, with its label and a Sign in button: still a sign-in', form([f('email', { name: 'email', autocomplete: 'username' }), pw('password', { label: 'Password', visible: false, focusable: true })], { submits: ['Sign in'] }), false],
    ['…the same with no words on its button but a label: still a sign-in', form([f('email', { name: 'email', autocomplete: 'username' }), pw('password', { label: 'Password', visible: false, focusable: true })]), false],
    ['a transparent password with no label or name a person reads, beside an email: a first step', form([f('email', { name: 'email', autocomplete: 'username' }), pw('passwd', { label: '', visible: false, focusable: true })], { headings: ['Sign in'] }), true],
    ['…and once it shows, the form is a sign-in', form([f('email', { name: 'login', autocomplete: 'username webauthn' }), pw('passwd', { label: '' })], { submits: ['Next'], title: 'Sign in to your account' }), false],
    ['nor two hidden ones', form([f('email', { name: 'email' }), pw('a', HIDDEN), pw('b', HIDDEN)], { submits: ['Next'] }), true],
    ['"Log in or sign up" over one email field, its Continue outside the form', form([f('text', { id: 'email', name: 'email', label: 'Email address' })], { headings: ['Log in or sign up'] }), true],
    ['…but not a field that only might be one, under the same heading', form([f('text', { name: 'q', label: 'Your city' })], { headings: ['Log in or sign up'] }), false],
    ['a sign-up heading alone over an email field', form([f('email', { name: 'email', label: 'Email address' })], { headings: ['Sign up for our deals'] }), false],
    ['a hidden password you typed in is a password', form([f('email', { name: 'email', autocomplete: 'username' }), pw('p', { ...HIDDEN, userTyped: true })], { submits: ['Next'] }), false],
  ])('%s', (_name, record, onlyUsername) => {
    expect(classifyPasswordForm(record, 'filling')?.kind === 'username-only').toBe(onlyUsername);
  });
});

describe('saving', () => {
  it('takes what you typed: the username with a value, the password', () => {
    const record = form([f('email', { name: 'email', value: 'ada@example.com', userTyped: true }), pw('password', { value: 'hunter2!', userTyped: true })], { submits: ['Sign in'] });
    expect(classify(record, 'saving')).toEqual({ kind: 'sign-in', roles: { email: 'username', password: 'current-password' } });
  });

  it('a password of one character (a split PIN box) is never offered for saving', () => {
    expect(classifyPasswordForm(form([user('u', { value: 'ada' }), pw('p', { value: '7' })]), 'saving')).toBeNull();
  });

  it('a value the site masked (••••) is no password', () => {
    expect(classifyPasswordForm(form([user('u', { value: 'ada' }), pw('p', { value: '••••••' })]), 'saving')).toBeNull();
  });

  it('a sign-up\'s two equal values are a new password and its confirmation', () => {
    const record = form([user('u', { value: 'ada' }), pw('a', { value: 's3cret-pass' }), pw('b', { value: 's3cret-pass' })]);
    expect(classify(record, 'saving').roles).toEqual({ u: 'username', a: 'new-password', b: 'confirmation-password' });
  });
});

// ----- Properties over random forms -----

/** A small seeded generator (mulberry32), so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TYPES = ['text', 'text', 'email', 'password', 'password', 'search', 'tel', 'number', 'url', 'select', 'textarea'];
const NAMES = ['username', 'user', 'email', 'login', 'password', 'pass', 'pw2', 'confirm', 'current', 'new_password', 'otp', 'code', 'cvc', 'pin', 'q', 'first', 'last', 'phone', 'zip', 'answer', 'ssn', '', 'x'];
const LABELS = ['', 'Username', 'Email', 'Password', 'Confirm password', 'New password', 'Current password', 'Search', 'PIN', 'Your answer', 'Code', 'Nom d’utilisateur', 'Пароль'];
const AUTOCOMPLETE = ['', '', '', 'username', 'current-password', 'new-password', 'one-time-code', 'cc-csc', 'off', 'email', 'section-a username webauthn', 'webauthn'];
const BUTTONS = ['Sign in', 'Log in', 'Sign up', 'Create account', 'Next', 'Continue', 'Save', 'Search', ''];
const VALUES = ['', '', 'ada', 'ada@example.com', 'hunter2', 'hunter2', '7', '••••', '12'];

function randomForm(seed: number): PasswordFormRecord {
  const r = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const count = 1 + Math.floor(r() * 9);
  const fields = Array.from({ length: count }, () =>
    f(pick(TYPES), {
      name: pick(NAMES),
      id: r() < 0.5 ? pick(NAMES) : '',
      label: pick(LABELS),
      placeholder: r() < 0.3 ? pick(LABELS) : '',
      autocomplete: pick(AUTOCOMPLETE),
      maxLength: r() < 0.1 ? 1 : -1,
      readOnly: r() < 0.1,
      focusable: r() < 0.85,
      visible: r() < 0.85,
      userTyped: r() < 0.3,
      autofilled: r() < 0.05,
      value: pick(VALUES),
    }),
  );
  return form(fields, { submits: [pick(BUTTONS)], buttons: [pick(BUTTONS), pick(BUTTONS)], headings: r() < 0.3 ? [pick(BUTTONS)] : [] });
}

const SEEDS = Array.from({ length: 1500 }, (_, i) => i + 1);
// The confirmation is left out: in saving mode Chromium takes it from any text field with the new password's value
// (FindConfirmationPasswordField), since a "show" toggle can make it type=text.
const PASSWORD_ROLES = new Set<PasswordFieldRole>(['current-password', 'new-password']);

describe('properties', () => {
  it('never throws, never gives one field two roles, and keeps current and new passwords on password fields', () => {
    for (const seed of SEEDS) {
      const record = randomForm(seed);
      for (const mode of ['filling', 'saving'] as const) {
        const c = classifyPasswordForm(record, mode);
        if (!c) continue;
        const named = [c.username, c.password, c.newPassword, c.confirmation].filter((x) => x !== null);
        expect(new Set(named).size, `seed ${seed} ${mode}`).toBe(named.length);
        expect(c.roles.size, `seed ${seed} ${mode}`).toBe(named.length);
        for (const field of record.fields) {
          const role = c.roles.get(field.key);
          if (role && PASSWORD_ROLES.has(role)) expect(field.type, `seed ${seed} ${mode}`).toBe('password');
          if (role === 'username') expect(field.type, `seed ${seed} ${mode}`).not.toBe('password');
          // Saving never takes an empty field.
          if (role && mode === 'saving') expect(field.value, `seed ${seed}`).not.toBe('');
        }
        if (c.confirmation) expect(c.newPassword, `seed ${seed} ${mode}`).not.toBeNull();
      }
    }
  });

  it('is stable when unrelated fields (checkboxes, buttons, a country list) are added anywhere', () => {
    for (const seed of SEEDS.slice(0, 500)) {
      const record = randomForm(seed);
      const before = classify(record);
      const r = rng(seed * 7919);
      const fields = [...record.fields];
      for (const extra of [f('checkbox', { name: 'remember' }), f('select', { name: 'country' }), f('submit', { name: 'go' }), f('hidden', { name: 'csrf' })]) {
        fields.splice(Math.floor(r() * (fields.length + 1)), 0, extra);
      }
      expect(classify({ ...record, fields }), `seed ${seed}`).toEqual(before);
    }
  });

  it('gives the same roles whatever the keys are', () => {
    for (const seed of SEEDS.slice(0, 300)) {
      const record = randomForm(seed);
      const rekeyed = { ...record, fields: record.fields.map((x, i) => ({ ...x, key: 100_000 - i })) };
      expect(classify(rekeyed), `seed ${seed}`).toEqual(classify(record));
    }
  });
});
