import type { PasswordsCandidate, PasswordsForms } from '@chord/ipc';
import { describe, expect, it } from 'vitest';
import { HOLD_MS, LATE_ERROR_MS, LATE_NAV_CAP_MS, SubmissionTracker, type SavingOutcome } from '../../src/main/passwords/saving';

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
  | ['hint', number, string?]
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
        out.push(...t.hint(step[2] ?? 'f1', step[1]));
        break;
      case 'wait':
        now += step[1];
        break;
    }
  }
  return out.map((o) => (o.type === 'submitted' ? `submitted:${o.signal}` : o.type === 'signedIn' ? `signedIn:${o.how}:${o.hint ?? '-'}` : o.type === 'lateJudged' ? 'lateJudged' : `failed:${o.why}`));
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
    // Review round 3 of #59: a late error takes a sign-in read from its form going back.
    ['the form went (signed in), then a slow 401 for it: taken back', [['candidate', { signal: 'button' }], ['gone'], ['wait', 2000], ['hint', 401]], ['submitted:button', 'signedIn:form-gone:-', 'failed:error-response']],
    ['…a 200 after it: nothing', [['candidate', { signal: 'button' }], ['gone'], ['hint', 200]], ['submitted:button', 'signedIn:form-gone:-']],
    ['…a 401 for another form: nothing', [['candidate', { signal: 'button' }], ['gone'], ['hint', 401, 'f2']], ['submitted:button', 'signedIn:form-gone:-']],
    ['…a 401 after LATE_ERROR_MS: nothing', [['candidate', { signal: 'button' }], ['gone'], ['wait', LATE_ERROR_MS + 1], ['hint', 401]], ['submitted:button', 'signedIn:form-gone:-']],
    ['…only once: a second 401 says nothing more', [['candidate', { signal: 'button' }], ['gone'], ['hint', 401], ['hint', 403]], ['submitted:button', 'signedIn:form-gone:-', 'failed:error-response']],
    ['…a navigation since (a new document numbers its forms afresh): nothing', [['candidate', { signal: 'button' }], ['gone'], ['start', true], ['hint', 401]], ['submitted:button', 'signedIn:form-gone:-']],
    ['…a sign-in read from a navigation is never taken back by a hint', [['candidate'], ['start', true], ['navigated', 200], ['settled'], ['hint', 401]], ['submitted:submit', 'signedIn:navigation:-']],
    // Review round 1 of #62: a navigation the page made during the late window is judged.
    ['…the page then navigates to the same sign-in form: taken back', [['candidate', { signal: 'button' }], ['gone'], ['start', true], ['navigated', 200], ['forms', formsWith([signInForm])], ['settled']], ['submitted:button', 'signedIn:form-gone:-', 'failed:reappeared']],
    ['…the page then navigates to a dashboard: judged, nothing taken back', [['candidate', { signal: 'button' }], ['gone'], ['start', true], ['navigated', 200], ['forms', formsWith([])], ['settled']], ['submitted:button', 'signedIn:form-gone:-', 'lateJudged']],
    ['…the page then navigates to an error page: taken back', [['candidate', { signal: 'button' }], ['gone'], ['start', true], ['navigated', 401]], ['submitted:button', 'signedIn:form-gone:-', 'failed:error-response']],
    ['…the page’s navigation never commits: judged (the page is as it was)', [['candidate', { signal: 'button' }], ['gone'], ['start', true], ['failedLoad']], ['submitted:button', 'signedIn:form-gone:-', 'lateJudged']],
    ['…a navigation of your own: forgotten, never judged', [['candidate', { signal: 'button' }], ['gone'], ['start', false], ['navigated', 200], ['forms', formsWith([signInForm])], ['settled']], ['submitted:button', 'signedIn:form-gone:-']],
    ['…a navigation after the window closed: not judged', [['candidate', { signal: 'button' }], ['gone'], ['wait', LATE_ERROR_MS + 1], ['start', true], ['navigated', 200], ['forms', formsWith([signInForm])], ['settled']], ['submitted:button', 'signedIn:form-gone:-']],
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
    expect(t.settled()).toEqual([{ type: 'signedIn', formId: 'f1', kind: 'sign-in', origin: 'https://real.example', how: 'navigation', hint: null, values: null, valuesUntil: null, lateUntil: null }]);
  });
});

describe('what was typed (values): held for the save card, never longer', () => {
  const typed = { username: 'ada@example.com', password: 'correct horse' };
  const signedInValues = (outcomes: SavingOutcome[]) => outcomes.find((o) => o.type === 'signedIn') as Extract<SavingOutcome, { type: 'signedIn' }> | undefined;

  it.each<[string, (t: SubmissionTracker, clock: { now: number }) => SavingOutcome[], { username: string; password: string } | null | 'no sign-in']>([
    ['a submit with values, then the form goes: the sign-in carries them', (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.gone('f1')], typed],
    ['…through a navigation and the reappeared-form check', (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.navigationStarted(true), ...t.navigated(200), ...t.settled()], typed],
    ['a blur after the submit keeps the submit’s values', (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.candidate(candidate({ signal: 'blur' }), ORIGIN), ...t.gone('f1')], typed],
    ['a blur’s values (forged past the schema) are never held', (t) => [...t.candidate(candidate({ signal: 'blur', values: typed }), ORIGIN), ...t.candidate(candidate({ signal: 'button' }), ORIGIN), ...t.gone('f1')], null],
    ['a submit without values: a sign-in, nothing to save', (t) => [...t.candidate(candidate(), ORIGIN), ...t.gone('f1')], null],
    [
      'a second submit (a corrected password) carries its own',
      (t) => [...t.candidate(candidate({ values: { ...typed, password: 'wrong' } }), ORIGIN), ...t.still('f1'), ...t.candidate(candidate({ values: typed }), ORIGIN), ...t.gone('f1')],
      typed,
    ],
    [
      'a failed sign-in drops them: the form stays held, the next signal brings none, so nothing is saved',
      (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.still('f1'), ...t.candidate(candidate({ signal: 'blur' }), ORIGIN), ...t.candidate(candidate({ signal: 'enter' }), ORIGIN), ...t.gone('f1')],
      null,
    ],
    ['…as does an error response', (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.navigationStarted(true), ...t.navigated(401), ...t.candidate(candidate({ signal: 'blur' }), ORIGIN), ...t.gone('f1')], 'no sign-in'],
    ['a navigation of your own forgets them', (t) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...t.navigationStarted(false), ...t.gone('f1')], 'no sign-in'],
    ['…and so do 5 minutes', (t, clock) => [...t.candidate(candidate({ values: typed }), ORIGIN), ...((clock.now += HOLD_MS + 1), []), ...t.gone('f1')], 'no sign-in'],
  ])('%s', (_name, journey, expected) => {
    const clock = { now: 0 };
    const t = new SubmissionTracker(() => clock.now);
    const signedIn = signedInValues(journey(t, clock));
    if (expected === 'no sign-in') expect(signedIn).toBeUndefined();
    else expect(signedIn?.values ?? null).toEqual(expected);
  });

  it('once the sign-in is reported, nothing of it is left: a late `gone` decides nothing', () => {
    const t = new SubmissionTracker(() => 0);
    expect(signedInValues([...t.candidate(candidate({ values: typed }), ORIGIN), ...t.gone('f1')])?.values).toEqual(typed);
    expect(t.gone('f1')).toEqual([]);
    expect(JSON.stringify(t)).not.toContain(typed.password);
  });

  it('a failed sign-in keeps the form, without what was typed', () => {
    const t = new SubmissionTracker(() => 0);
    t.candidate(candidate({ values: typed }), ORIGIN);
    t.still('f1');
    expect(JSON.stringify(t)).not.toContain(typed.password);
    expect(JSON.stringify(t)).not.toContain(typed.username);
  });
});

describe('the 5 minutes run by themselves (no later call needed)', () => {
  const typed = { username: 'ada@example.com', password: 'correct horse' };
  /** A clock and timers moved by hand. */
  function clocked() {
    const clock = { now: 0 };
    const timers = new Map<number, { at: number; run: () => void }>();
    let next = 1;
    const tracker = new SubmissionTracker(() => clock.now, {
      setTimeout: (run, ms) => (timers.set(next, { at: clock.now + ms, run }), next++),
      clearTimeout: (id) => void timers.delete(id as number),
    });
    const advance = (ms: number) => {
      clock.now += ms;
      for (const [id, t] of [...timers]) if (t.at <= clock.now && timers.delete(id)) t.run();
    };
    return { tracker, advance, pending: () => timers.size };
  }
  const leaks = (t: SubmissionTracker) => /ada@example\.com|correct horse/.test(JSON.stringify(t));

  it.each<[string, (t: SubmissionTracker) => void]>([
    ['held, nothing else happening', () => {}],
    ['a navigation the page started that never ends (navigating)', (t) => t.navigationStarted(true)],
    ['an SPA route change whose watch never answers (same-document)', (t) => t.navigatedInPage()],
    ['a new page whose forms never come (settling)', (t) => (t.navigationStarted(true), t.navigated(200))],
  ])('%s: the values go at HOLD_MS', (_name, then) => {
    const { tracker, advance } = clocked();
    tracker.candidate(candidate({ values: typed }), ORIGIN);
    then(tracker);
    advance(HOLD_MS - 1);
    expect(leaks(tracker)).toBe(true);
    advance(1);
    expect(leaks(tracker)).toBe(false);
    // And nothing waits on the forgotten form: a late answer decides nothing.
    expect([...tracker.gone('f1'), ...tracker.settled()]).toEqual([]);
  });

  it('a newer submit’s values count their own 5 minutes, and the older ones go with them', () => {
    const { tracker, advance } = clocked();
    tracker.candidate(candidate({ values: { ...typed, password: 'first try' } }), ORIGIN);
    advance(HOLD_MS - 10);
    tracker.candidate(candidate({ values: typed }), ORIGIN);
    advance(20);
    expect(leaks(tracker)).toBe(true);
    expect(JSON.stringify(tracker)).not.toContain('first try');
    advance(HOLD_MS);
    expect(leaks(tracker)).toBe(false);
  });

  it('reset (passwords off there, the page gone) drops them at once, from the navigation waiting too, and stops the timer', () => {
    const { tracker, pending } = clocked();
    tracker.candidate(candidate({ values: typed }), ORIGIN);
    tracker.navigationStarted(true);
    expect(pending()).toBe(1);
    tracker.reset();
    expect(leaks(tracker)).toBe(false);
    expect(pending()).toBe(0);
  });
});

describe('the candidate’s deadline goes with its values to the save card', () => {
  it('it’s HOLD_MS after the values were typed, not after the sign-in was decided', () => {
    let now = 1000;
    const t = new SubmissionTracker(() => now, { setTimeout: () => 0, clearTimeout: () => {} });
    t.candidate(candidate({ values: { username: 'ada', password: 'pw' } }), ORIGIN);
    now = 9000;
    t.candidate(candidate({ signal: 'blur' }), ORIGIN);
    now = 20_000;
    const signedIn = t.gone('f1').find((o) => o.type === 'signedIn') as Extract<SavingOutcome, { type: 'signedIn' }>;
    expect(signedIn.valuesUntil).toBe(1000 + HOLD_MS);
  });

  it('none without values', () => {
    const t = new SubmissionTracker(() => 0, { setTimeout: () => 0, clearTimeout: () => {} });
    t.candidate(candidate(), ORIGIN);
    expect((t.gone('f1')[0] as Extract<SavingOutcome, { type: 'signedIn' }>).valuesUntil).toBeNull();
  });
});

describe('a deadline per held copy (security review, round 2)', () => {
  function clocked() {
    const clock = { now: 0 };
    const timers = new Map<number, { at: number; run: () => void }>();
    let next = 1;
    const tracker = new SubmissionTracker(() => clock.now, {
      setTimeout: (run, ms) => (timers.set(next, { at: clock.now + ms, run }), next++),
      clearTimeout: (id) => void timers.delete(id as number),
    });
    const advance = (ms: number) => {
      const until = clock.now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock.now = due[1].at;
        due[1].run();
      }
      clock.now = until;
    };
    return { tracker, advance, clock };
  }
  const A = { username: 'ada@example.com', password: 'form-a-secret' };
  const B = { username: 'bob@example.com', password: 'form-b-secret' };

  it('form A submitted at t0, its navigation pending; the old page submits form B at t0+4m: A’s values still go at t0+5m', () => {
    const { tracker, advance } = clocked();
    tracker.candidate(candidate({ formId: 'f1', values: A }), ORIGIN);
    tracker.navigationStarted(true);
    advance(4 * 60_000);
    tracker.candidate(candidate({ formId: 'f2', values: B }), ORIGIN);
    const dump = () => JSON.stringify(tracker);
    expect(dump()).toContain('form-a-secret');
    advance(60_000);
    // A's 5 minutes are its own: gone at t0+5m, with B's still held (until t0+9m).
    expect(dump()).not.toContain('form-a-secret');
    expect(dump()).toContain('form-b-secret');
    advance(4 * 60_000 - 1);
    expect(dump()).toContain('form-b-secret');
    advance(1);
    expect(dump()).not.toContain('form-b-secret');
  });

  it('…and if A’s navigation decides it before then, its card’s deadline is A’s, not B’s', () => {
    const { tracker, advance } = clocked();
    tracker.candidate(candidate({ formId: 'f1', values: A }), ORIGIN);
    tracker.navigationStarted(true);
    advance(4 * 60_000);
    tracker.candidate(candidate({ formId: 'f2', values: B }), ORIGIN);
    tracker.navigated(200);
    const signedIn = tracker.settled().find((o) => o.type === 'signedIn') as Extract<SavingOutcome, { type: 'signedIn' }>;
    expect(signedIn.values).toEqual(A);
    expect(signedIn.valuesUntil).toBe(HOLD_MS);
  });
});


describe('a late window’s navigation, judged (review round 2 of #62)', () => {
  /** A form-gone sign-in, then a navigation the page made: the tracker judging it. */
  function judgingTracker() {
    let now = 0;
    const t = new SubmissionTracker(() => now);
    t.candidate(candidate({ signal: 'button' }), ORIGIN);
    t.gone('f1');
    t.navigationStarted(true);
    return { t, advance: (ms: number) => void (now += ms) };
  }

  it('is judging from the navigation until its new page settles', () => {
    const { t } = judgingTracker();
    expect(t.judging).toBe(true);
    t.navigated(200);
    expect(t.judging).toBe(true);
    t.forms(formsWith([]));
    expect(t.settled()).toEqual([{ type: 'lateJudged', formId: 'f1', origin: ORIGIN }]);
    expect(t.judging).toBe(false);
  });

  it('a second navigation the page makes before the first settles: still judging, the same sign-in, then judged on its page', () => {
    const { t } = judgingTracker();
    t.navigated(200);
    t.navigationStarted(true);
    expect(t.judging).toBe(true);
    t.navigated(200);
    t.forms(formsWith([signInForm]));
    expect(t.settled()).toEqual([{ type: 'failed', formId: 'f1', kind: 'sign-in', origin: ORIGIN, why: 'reappeared' }]);
  });

  it('…a navigation of your own in between: no longer judged, and nothing comes of it', () => {
    const { t } = judgingTracker();
    t.navigationStarted(false);
    expect(t.judging).toBe(false);
    t.navigated(200);
    t.forms(formsWith([signInForm]));
    expect(t.settled()).toEqual([]);
  });

  it('passwords turned off and on there while it’s judged (reset): no stale judgment after', () => {
    const { t } = judgingTracker();
    t.navigated(200);
    t.reset();
    expect(t.judging).toBe(false);
    t.forms(formsWith([signInForm]));
    expect(t.settled()).toEqual([]);
  });

  it('past its cap (LATE_NAV_CAP_MS after the window): it ends with no outcome', () => {
    const { t, advance } = judgingTracker();
    t.navigated(200);
    advance(LATE_ERROR_MS + LATE_NAV_CAP_MS + 1);
    expect(t.judging).toBe(false);
    t.forms(formsWith([signInForm]));
    expect(t.settled()).toEqual([]);
  });
});
