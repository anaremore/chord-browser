import type { PasswordsCandidate, PasswordsForms } from '@chord/ipc';
import { describe, expect, it } from 'vitest';
import { HOLD_MS, SubmissionTracker, type SavingOutcome } from '../../src/main/passwords/saving';

const ORIGIN = 'https://example.com';
const password = { type: 'password', id: 'p', name: 'password' };
const username = { type: 'email', id: 'u', name: 'email' };
const candidate = (over: Partial<PasswordsCandidate> = {}): PasswordsCandidate => ({
  formId: 'f1',
  kind: 'sign-in',
  signal: 'submit',
  username,
  password,
  newPassword: null,
  hasUsername: true,
  hasPassword: true,
  ...over,
});
const formsWith = (forms: PasswordsForms['forms']): PasswordsForms => ({ forms });
const signInForm = { formId: 'f1', kind: 'sign-in' as const, username, password, newPassword: null };

type Step =
  | ['candidate', Partial<PasswordsCandidate>?]
  | ['start', boolean]
  | ['failedLoad']
  | ['navigated', number]
  | ['forms', PasswordsForms]
  | ['settled']
  | ['inPage']
  | ['gone' | 'still', string?]
  | ['hint', number]
  | ['wait', number];

/** Runs a journey and gives what it decided, as `type:detail` strings. */
function run(steps: Step[]): string[] {
  let now = 0;
  const t = new SubmissionTracker(() => now);
  const out: SavingOutcome[] = [];
  for (const step of steps) {
    switch (step[0]) {
      case 'candidate':
        out.push(...t.candidate(candidate(step[1]), ORIGIN));
        break;
      case 'start':
        out.push(...t.navigationStarted(step[1]));
        break;
      case 'failedLoad':
        out.push(...t.navigationFailed());
        break;
      case 'navigated':
        out.push(...t.navigated(step[1]));
        break;
      case 'forms':
        out.push(...t.forms(step[1]));
        break;
      case 'settled':
        out.push(...t.settled());
        break;
      case 'inPage':
        out.push(...t.navigatedInPage());
        break;
      case 'gone':
        out.push(...t.gone(step[1] ?? 'f1'));
        break;
      case 'still':
        out.push(...t.still(step[1] ?? 'f1'));
        break;
      case 'hint':
        t.hint('f1', step[1]);
        break;
      case 'wait':
        now += step[1];
        break;
    }
  }
  return out.map((o) => (o.type === 'submitted' ? `submitted:${o.signal}` : o.type === 'signedIn' ? `signedIn:${o.how}:${o.hint ?? '-'}` : `failed:${o.why}`));
}

describe('knowing you signed in (S17 §6)', () => {
  it.each<[string, Step[], string[]]>([
    ['submit, navigate, a page without the form: signed in', [['candidate'], ['start', true], ['navigated', 200], ['forms', formsWith([])], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['…and its agent never woke (no password field there): signed in', [['candidate'], ['start', true], ['navigated', 302], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['submit, navigate, the same form again: failed', [['candidate'], ['start', true], ['navigated', 200], ['forms', formsWith([signInForm])], ['settled']], ['submitted:submit', 'failed:reappeared']],
    ['the new page shows a different sign-in form (another site\'s step): signed in', [['candidate'], ['start', true], ['navigated', 200], ['forms', formsWith([{ ...signInForm, password: { type: 'password', id: 'otp', name: 'code' } }])], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['the next page is a first step with the same username field: still signed in', [['candidate'], ['start', true], ['navigated', 200], ['forms', formsWith([{ ...signInForm, kind: 'username-only', password: null }])], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['an error response: failed', [['candidate'], ['start', true], ['navigated', 401]], ['submitted:submit', 'failed:error-response']],
    ['typed, no submit signal, then the page navigates (a link you clicked): no sign-in without a submit signal (S17 §6 step 2)', [['candidate', { signal: 'blur' }], ['start', true], ['navigated', 200], ['settled']], []],
    ['…and the form is forgotten with the page it was on', [['candidate', { signal: 'blur' }], ['start', true], ['navigated', 200], ['candidate', { signal: 'submit', formId: 'f1' }], ['gone']], ['submitted:submit', 'signedIn:form-gone:-']],
    ['one submit, several signals (Enter, then the form\'s submit, then a click): one `submitted`', [['candidate', { signal: 'enter' }], ['candidate', { signal: 'submit' }], ['candidate', { signal: 'button' }], ['start', true], ['navigated', 200], ['settled']], ['submitted:enter', 'signedIn:navigation:-']],
    ['a navigation that never commits (a 204, a download, an aborted one), then the form goes: signed in', [['candidate'], ['start', true], ['failedLoad'], ['gone']], ['submitted:submit', 'signedIn:form-gone:-']],
    ['…or the form stays: failed', [['candidate'], ['start', true], ['failedLoad'], ['still']], ['submitted:submit', 'failed:still-shown']],
    ['…or the page then navigates for real', [['candidate'], ['start', true], ['failedLoad'], ['start', true], ['navigated', 200], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['a failed load with nothing under way changes nothing', [['candidate'], ['failedLoad'], ['gone']], ['submitted:submit', 'signedIn:form-gone:-']],
    ['typed, then you go elsewhere yourself: nothing', [['candidate', { signal: 'blur' }], ['start', false], ['navigated', 200], ['settled']], []],
    ['submitted, then you go elsewhere yourself before it navigates: nothing', [['candidate'], ['start', false], ['navigated', 200], ['settled']], ['submitted:submit']],
    ['no navigation, the form goes: signed in', [['candidate', { signal: 'button' }], ['gone']], ['submitted:button', 'signedIn:form-gone:-']],
    ['…with the request the page made: its status as a hint', [['candidate', { signal: 'button' }], ['hint', 200], ['gone']], ['submitted:button', 'signedIn:form-gone:response-ok']],
    ['…and a failing one vetoes the success: a 401, then the form taken away, is no sign-in', [['candidate', { signal: 'button' }], ['hint', 401], ['gone']], ['submitted:button', 'failed:error-response']],
    ['a script\'s sign-in gets a 401 and says "wrong password"; then you follow "Forgot password?": no sign-in', [['candidate', { signal: 'button' }], ['hint', 401], ['start', true], ['navigated', 200], ['settled']], ['submitted:button', 'failed:error-response']],
    ['a 401, then a 200 (a captcha refreshed), then a link clicked: still no sign-in (the error is sticky)', [['candidate', { signal: 'button' }], ['hint', 401], ['hint', 200], ['start', true], ['navigated', 200], ['settled']], ['submitted:button', 'failed:error-response']],
    ['a typo (401, still shown), then a corrected retry by a full-page post: signed in', [['candidate', { signal: 'button' }], ['hint', 401], ['still'], ['candidate', { signal: 'submit' }], ['start', true], ['navigated', 200], ['settled']], ['submitted:button', 'failed:still-shown', 'submitted:submit', 'signedIn:navigation:-']],
    ['…and a retry whose request leaves no hint, the form going: signed in', [['candidate', { signal: 'button' }], ['hint', 401], ['still'], ['candidate', { signal: 'button' }], ['gone']], ['submitted:button', 'failed:still-shown', 'submitted:button', 'signedIn:form-gone:-']],
    ['…and after that, a link clicked within 5 minutes is nothing', [['candidate', { signal: 'button' }], ['hint', 401], ['gone'], ['start', true], ['navigated', 200], ['settled']], ['submitted:button', 'failed:error-response']],
    ['the watch says `still` while a navigation is under way, which then never commits: failed', [['candidate'], ['start', true], ['still'], ['failedLoad']], ['submitted:submit', 'failed:still-shown']],
    ['…and a link clicked later is no sign-in', [['candidate'], ['start', true], ['still'], ['failedLoad'], ['start', true], ['navigated', 200], ['settled']], ['submitted:submit', 'failed:still-shown']],
    ['the watch says `gone` while a navigation is under way, which then never commits: signed in', [['candidate'], ['start', true], ['gone'], ['failedLoad']], ['submitted:submit', 'signedIn:form-gone:-']],
    ['the watch answers while navigating, and the navigation commits: the new page decides', [['candidate'], ['start', true], ['still'], ['navigated', 200], ['forms', formsWith([])], ['settled']], ['submitted:submit', 'signedIn:navigation:-']],
    ['no navigation, the form stays: failed', [['candidate', { signal: 'enter' }], ['still']], ['submitted:enter', 'failed:still-shown']],
    ['an SPA route change, then the form goes', [['candidate'], ['inPage'], ['gone']], ['submitted:submit', 'signedIn:same-document:-']],
    ['a `gone` for another form says nothing', [['candidate'], ['gone', 'f2']], ['submitted:submit']],
    ['a form that vanishes without a submit signal (a closed dialog) is no sign-in', [['candidate', { signal: 'blur' }], ['gone']], []],
    ['no password typed: nothing is held', [['candidate', { hasPassword: false }], ['start', true], ['navigated', 200], ['settled']], []],
    ['held for 5 minutes, then forgotten', [['candidate', { signal: 'blur' }], ['wait', HOLD_MS + 1], ['start', true], ['navigated', 200], ['settled']], []],
    ['failed, corrected, submitted again: signed in the second time', [['candidate'], ['still'], ['candidate'], ['start', true], ['navigated', 200], ['settled']], ['submitted:submit', 'failed:still-shown', 'submitted:submit', 'signedIn:navigation:-']],
    ['blur after submit keeps the submit', [['candidate'], ['candidate', { signal: 'blur' }], ['gone']], ['submitted:submit', 'signedIn:form-gone:-']],
    ['a `gone` while the page navigates waits for the new page', [['candidate'], ['start', true], ['gone'], ['navigated', 200], ['forms', formsWith([signInForm])], ['settled']], ['submitted:submit', 'failed:reappeared']],
    ['a new password field matched by its new-password signature', [['candidate', { kind: 'sign-up', password: null, newPassword: password }], ['start', true], ['navigated', 200], ['forms', formsWith([{ ...signInForm, kind: 'sign-up', password: null, newPassword: password }])], ['settled']], ['submitted:submit', 'failed:reappeared']],
  ])('%s', (_name, steps, expected) => {
    expect(run(steps)).toEqual(expected);
  });

  it('a held field with neither id nor name: any password field shown again counts as reappeared (cautious)', () => {
    const anonymous = { type: 'password', id: '', name: '' };
    expect(run([['candidate', { password: anonymous }], ['start', true], ['navigated', 200], ['forms', formsWith([{ ...signInForm, password: { type: 'password', id: 'x', name: '' } }])], ['settled']])).toEqual(['submitted:submit', 'failed:reappeared']);
    // …but not a first step, which shows no password.
    expect(run([['candidate', { password: anonymous }], ['start', true], ['navigated', 200], ['forms', formsWith([{ ...signInForm, kind: 'username-only', password: null }])], ['settled']])).toEqual(['submitted:submit', 'signedIn:navigation:-']);
  });

  it('carries the origin main read, never one from the page', () => {
    const t = new SubmissionTracker(() => 0);
    t.candidate(candidate(), 'https://real.example');
    t.navigationStarted(true);
    t.navigated(200);
    expect(t.settled()).toEqual([{ type: 'signedIn', formId: 'f1', kind: 'sign-in', origin: 'https://real.example', how: 'navigation', hint: null }]);
  });
});
