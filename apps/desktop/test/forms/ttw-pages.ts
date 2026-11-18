/**
 * Chord's own expectations for the sign-in pages of Bitwarden's test-the-web (ttw.ts), in Chord's
 * terms, written by looking at each page as built at SITE_COMMIT. Nothing here comes from that
 * project's code or tests: the paths and selectors only say where on the page a field is.
 *
 * Only sign-in pages and their later steps, as phase 1 fills only those. Left out: creating an
 * account, changing or updating a password, payment, identity, search and the scenarios. The
 * sign-in pages phase 1 can't reach are listed with `skip`, so the table names them all.
 *
 * A page is a list of steps, in the one document (a multi-step sign-in shows each in place).
 * Each step:
 * - `actions`: what a person does to get there (open a dialog, press Next), in Playwright's terms;
 * - `kind`: the kind the detector should give the form holding the step's fields;
 * - `username`, `password`: the fields that should be the username and the current password.
 *   Every other field on the page should get no role.
 *
 * And the fill: the suite focuses the field as a person would, takes the agent's `focus` as the
 * menu would, and sends main's fill for a fake account. Both values must land and stay, and no
 * other field may change.
 *
 * A **negative** step (`kind: null`: a one-time code is no password) names the `field` it's
 * about, which must be on the page and scanned, so a blank or broken page can't pass it. It and
 * every other field must get no role, and clicking it must open no menu.
 */
import type { PasswordFormKind } from '@chord/core';

export type Action = { readonly click: string } | { readonly waitFor: string };

interface BaseStep {
  /** What the step is, in a few words: the baseline names it so. */
  readonly name: string;
  readonly actions?: readonly Action[];
}

/** A step with a credential: at least one of the username and the password. */
export interface SignInStep extends BaseStep {
  readonly kind: PasswordFormKind;
  readonly username?: string;
  readonly password?: string;
}

/** A step where nothing should get a role, about the one field that's there. */
export interface NegativeStep extends BaseStep {
  readonly kind: null;
  readonly field: string;
}

export type Step = SignInStep | NegativeStep;

export interface SitePage {
  /** Under /forms/ on the site. */
  readonly path: string;
  /** What's on it, in Chord's words. */
  readonly what: string;
  readonly steps: readonly Step[];
  /** Why the page isn't scored: a later phase's. */
  readonly skip?: string;
}

const NEXT: Action = { click: 'button[type=submit]' };
const SIGN_IN = (username: string, password: string): SignInStep => ({ name: 'sign in', kind: 'sign-in', username, password });

export const PAGES: readonly SitePage[] = [
  { path: 'login/simple', what: 'a labelled username and password in a <form>; the password says autocomplete="password", which is no token', steps: [SIGN_IN('#username', '#password')] },
  { path: 'login/simple-spec', what: 'the same form with the right autocomplete tokens', steps: [SIGN_IN('#username', '#password')] },
  { path: 'login/autocomplete-off', what: 'the same form with autocomplete="off" on both fields', steps: [SIGN_IN('#username', '#password')] },
  { path: 'login/bare-inputs-login', what: 'a labelled username and password with no <form>, sent by a script', steps: [SIGN_IN('#username', '#password')] },
  {
    path: 'login/ambiguous-inputs',
    what: 'two plain text boxes named u and p and a Go button: no form, no label, no password field',
    // Nothing a person could read says sign-in, and a saved password would show as plain text in `p`:
    // Chord should leave it alone.
    steps: [{ name: 'two plain boxes', kind: null, field: 'input[name=p]' }],
  },
  {
    path: 'login/hidden-login',
    what: 'a sign-in in steps (a username, an email, the password) that is added to the page only when you press "Show login"',
    steps: [
      { name: 'username', kind: 'username-only', username: '#username', actions: [{ click: 'text=Show login' }, { waitFor: '#username' }] },
      { name: 'email', kind: 'username-only', username: '#email', actions: [NEXT, { waitFor: '#email' }] },
      { name: 'password', kind: 'sign-in', password: '#password', actions: [NEXT, { waitFor: '#password' }] },
    ],
  },
  {
    path: 'login/aria-modal-focus-trap',
    what: 'a sign-in form in a focus-trapping role=dialog opened by a "Sign in" button',
    steps: [{ ...SIGN_IN('[role=dialog] input:not([type=password])', '[role=dialog] input[type=password]'), name: 'in the modal', actions: [{ click: 'button:has-text("Sign in")' }, { waitFor: '[role=dialog] input[type=password]' }] }],
  },
  {
    path: 'login/top-layer-dialog',
    what: 'a sign-in form in a native <dialog>, opened with showModal',
    steps: [{ ...SIGN_IN('#username', '#password'), name: 'in the dialog', actions: [{ click: '#open-dialog-button' }, { waitFor: '#password' }] }],
  },
  {
    path: 'login/top-layer-popover',
    what: 'a sign-in form in a popover',
    steps: [{ ...SIGN_IN('#username', '#password'), name: 'in the popover', actions: [{ click: '#open-popover-button' }, { waitFor: '#password' }] }],
  },
  {
    path: 'login/input-constraints-login',
    what: 'an email and a password that must be six digits, with a read-only organisation field between them',
    steps: [SIGN_IN('#email', '#password')],
  },
  {
    path: 'login/input-event-trust-login',
    what: 'a sign-in form whose script keeps its own copy of the values and puts it back unless they came from a trusted input event',
    steps: [SIGN_IN('#username', '#password')],
  },
  { path: 'login/login-honeypot', what: 'a sign-in form with hidden decoy code, password and email fields that must stay empty', steps: [SIGN_IN('#username', '#password')] },
  { path: 'login/login-security-questions', what: 'a username, a password and a security answer in one form', steps: [SIGN_IN('#username', '#password')] },
  {
    path: 'subscribe/newsletter-alongside-login',
    what: 'a newsletter form with an email beside a sign-in form that has only a password',
    steps: [{ name: 'password only', kind: 'sign-in', password: '#login-password' }],
  },
  // The second step of a sign-in: a code, which no saved password belongs in.
  { path: 'login/security-code', what: 'one text box for an authenticator code', steps: [{ name: 'code', kind: null, field: '#input-3' }] },
  { path: 'login/security-code-signposted', what: 'one text box for a code, autocomplete="one-time-code"', steps: [{ name: 'code', kind: null, field: '#input-3' }] },
  { path: 'login/security-code-multi-input', what: 'six one-digit boxes for a code', steps: [{ name: 'code', kind: null, field: 'input[name=otp-code-0]' }] },
  { path: 'login/security-code-device', what: 'one type=password box a security key types its code into, with nothing that says password', steps: [{ name: 'code', kind: null, field: '#input-4' }] },
  // Sign-ins in steps, each shown in place of the last.
  {
    path: 'multi-step/email-username-login',
    what: 'a username, then an email, then the password, one a step',
    steps: [
      { name: 'username', kind: 'username-only', username: '#username' },
      { name: 'email', kind: 'username-only', username: '#email', actions: [NEXT, { waitFor: '#email' }] },
      { name: 'password', kind: 'sign-in', password: '#password', actions: [NEXT, { waitFor: '#password' }] },
    ],
  },
  {
    path: 'multi-step/formless-login',
    what: 'a username, then an email, then the password, with no <form>',
    steps: [
      { name: 'username', kind: 'username-only', username: '#username' },
      { name: 'email', kind: 'username-only', username: '#email', actions: [NEXT, { waitFor: '#email' }] },
      { name: 'password', kind: 'sign-in', password: '#password', actions: [NEXT, { waitFor: '#password' }] },
    ],
  },
  {
    path: 'multi-step/login-no-username',
    what: 'an email, then the password',
    steps: [
      { name: 'email', kind: 'username-only', username: '#email' },
      { name: 'password', kind: 'sign-in', password: '#password', actions: [NEXT, { waitFor: '#password' }] },
    ],
  },
  {
    path: 'multi-step/login-animated-password',
    what: 'a username, then the password in a step that fades in, focused while still transparent',
    steps: [
      { name: 'username', kind: 'username-only', username: '#ms-anim-username' },
      { name: 'password', kind: 'sign-in', password: 'input[type=password]', actions: [NEXT, { waitFor: 'input[type=password]' }] },
    ],
  },
  {
    path: 'multi-step/login-security-question',
    what: 'an email, then the password, then a security question',
    steps: [
      { name: 'email', kind: 'username-only', username: '#email' },
      { name: 'password', kind: 'sign-in', password: '#password', actions: [NEXT, { waitFor: '#password' }] },
      // An answer to a question is no password: the step should get no role.
      { name: 'question', kind: null, field: '#security-question', actions: [NEXT, { waitFor: '#security-question' }] },
    ],
  },
  // Not scored: phase 1 reads the main frame's own tree only (S17 §15; scan.ts).
  // Material Web's text fields: each one's <input> in the component's open root, the form in the page's tree (S17 phase 3B).
  {
    path: 'login/shadow-root-inputs',
    what: 'a sign-in form of web components, its fields in open shadow roots',
    steps: [SIGN_IN('#username >>> input', '#password >>> input')],
    skip: 'shadow roots: phase 3B, with the agent’s walk of open roots',
  },
  { path: 'login/shadow-root-inputs-closed', what: 'a sign-in form in an open root whose fields are in closed shadow roots', steps: [], skip: 'closed shadow roots are out of any page script’s reach, the agent’s too (S17 §4)' },
  { path: 'login/iframe-login', what: 'a sign-in form in a frame', steps: [], skip: 'frames: phase 1 is the main frame only' },
  { path: 'login/iframe-sandboxed-login', what: 'a sign-in form in a sandboxed frame', steps: [], skip: 'frames: phase 1 is the main frame only' },
  { path: 'login/nested-iframe-login', what: 'two sign-in forms in frames within frames', steps: [], skip: 'frames: phase 1 is the main frame only' },
  { path: 'multi-step/iframe-formless-login', what: 'a formless sign-in in steps, in a frame', steps: [], skip: 'frames: phase 1 is the main frame only' },
  { path: 'login/basic-auth-login', what: 'HTTP basic authentication', steps: [], skip: 'the browser’s own sign-in prompt, not a form' },
];
