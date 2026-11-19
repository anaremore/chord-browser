/**
 * Knowing you signed in (S17 §6): for one tab's page, from what its passwords agent reports
 * and how the page navigates, whether a form you submitted worked. Pure and synchronous (no
 * Electron), so every path is unit-tested; detector.ts feeds it.
 *
 * A form is held when you typed a password in it (a `candidate`), for at most 5 minutes, in
 * memory only. Then, after a submit signal (the form's `submit`, Enter, its button; without one
 * there's no sign-in, S17 §6 step 2), and the navigation the page started if any:
 * - **it worked** if the page navigated with a response under 400 and, once the new page had
 *   settled, it doesn't show a form with the same password field (Chromium's reappeared-form
 *   check, inline in `OnPasswordFormsRendered`); or, with no navigation, if the password field
 *   went or was hidden while the agent watched (`gone`);
 * - **it failed** if the same form is still there or back (`still`, or reappeared), or the
 *   response was an error. The form stays held in case you correct the password.
 * - **neither** if the navigation never committed (a 204, a download, an aborted one): the form
 *   stays submitted, and its `gone` or `still` decides.
 * A request to the page's own origin seen after the submit (`hint`, the PerformanceObserver;
 * M0 Q7) goes along as a hint. It's never the reason for a success, but an error (400 or more)
 * vetoes one: a sign-in script that got a 401 and showed "wrong password" didn't sign you in,
 * whatever the page does next.
 *
 * **Values.** A candidate sent at a submit signal carries what was typed (`values`: the
 * username and the password to save). They're held here with the form, in memory only, and
 * leave in one place: the `signedIn` that the save card is offered from (`submitted` carries the username alone, for a
 * generated password saved before the submit to take, S17 §6, phase 2). A sign-in that
 * failed drops them (a corrected retry sends its own), and so does everything that forgets
 * the form: a navigation of your own, the page going, passwords turned off there (`reset`).
 * The 5 minutes are a timer of their own, started as values arrive: when it runs, they go from
 * the held form and from the navigation waiting on it, whether or not anything else ever
 * reaches the tracker (a watch that never answers, a message the page's rate limit dropped).
 * A candidate sent as you leave the field never carries any.
 */
import type { PasswordsCandidate, PasswordsFieldSignature, PasswordsForms } from '@chord/ipc';

/** How long a typed form is held (S17 §6, step 1). */
export const HOLD_MS = 5 * 60_000;
/**
 * After a sign-in read from its form going (no navigation), how long a request error for that form still takes it back:
 * the agent's watch (SUBMIT_WATCH_MS), whose hints go on after `gone`. A slow 401 the quiet wait didn't see coming
 * mustn't leave a save card for a password the site refused (review round 3 of #59).
 */
export const LATE_ERROR_MS = 10_000;
/** After the new page stops loading, how long its agent has to report its forms before the check runs. */
export const SETTLE_MS = 1500;

export type SubmitSignal = Exclude<PasswordsCandidate['signal'], 'blur'>;
/** What was typed in a sign-in that was submitted: the username, and the password to save. */
export type CandidateValues = NonNullable<PasswordsCandidate['values']>;
export type ResponseHint = 'response-ok' | 'response-error' | null;

export type SavingOutcome =
  /**
   * `values`: the username submitted, for a generated password saved before it (S17 §6) to take; never the password,
   * which leaves only with a sign-in that worked.
   */
  | { readonly type: 'submitted'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly signal: SubmitSignal; readonly values: { readonly username: string } | null }
  | { readonly type: 'signedIn'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly how: 'navigation' | 'same-document' | 'form-gone'; readonly hint: ResponseHint; readonly values: CandidateValues | null; readonly valuesUntil: number | null;
      /**
       * A sign-in read from its form going (no navigation): until when a late request error can still take it back
       * (`LATE_ERROR_MS`). The assist holds Save and Update until then (S17 §6, phase 3A-2). Null after a navigation.
       */
      readonly lateUntil: number | null }
  | { readonly type: 'failed'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly why: 'error-response' | 'reappeared' | 'still-shown' };

interface Held {
  /** The form as last reported; its `values` are the last submit's, dropped once a sign-in failed. */
  candidate: PasswordsCandidate;
  /** The origin main read from the sender's frame when the candidate came. */
  readonly origin: string;
  readonly at: number;
  /** When this copy's values were typed (their submit came): they, and the save card made from them, last until `HOLD_MS` after. */
  valuesAt: number | null;
  submitted: boolean;
  /** The last request status seen after the submit. */
  status: number | null;
  /** A request after the submit answered 400 or more. Sticky: a later 2xx (a captcha refreshed, error strings fetched) doesn't clear it. */
  error: boolean;
  /** The agent's watch answered while a navigation was under way: applied if that navigation never commits. */
  watched: 'gone' | 'still' | null;
}

type Phase =
  | { readonly t: 'idle' }
  /** A navigation the page started, with a form held. */
  | { readonly t: 'navigating'; readonly held: Held }
  /** The new page loaded with a response under 400; its forms are awaited. */
  | { readonly t: 'settling'; readonly held: Held; forms: PasswordsForms['forms'] | null }
  /** Navigated within the document: the agent's `gone` or `still` decides. */
  | { readonly t: 'same-document'; readonly held: Held };

/**
 * Whether a form on the new page shows the held field again: the same type, id and name. A held
 * field with neither id nor name can't be told apart, so any field of its type counts: cautious,
 * since a wrong "reappeared" only loses an offer to save, and a wrong "gone" makes one for a failed sign-in.
 */
const sameField = (held: PasswordsFieldSignature | null, shown: PasswordsFieldSignature | null) => {
  if (!held || !shown || held.type !== shown.type) return false;
  if (held.id === '' && held.name === '') return true;
  return held.id === shown.id && held.name === shown.name;
};
/** A request error after the submit: no success, whatever follows. */
const vetoed = (held: Held) => held.error;

const hintOf = (status: number | null): ResponseHint => (status === null ? null : status < 400 ? 'response-ok' : 'response-error');
/** The candidate without what was typed. */
const withoutValues = ({ values: _values, ...rest }: PasswordsCandidate): PasswordsCandidate => rest;
/** A failed sign-in: the form stays held for a retry, its values don't. */
const failedHeld = (held: Held) => {
  held.submitted = false;
  held.candidate = withoutValues(held.candidate);
  held.valuesAt = null;
};
/** The sign-in's values, as the save card takes them. */
const valuesOf = (held: Held): CandidateValues | null => held.candidate.values ?? null;

/** The tracker's timer: the real one in main, a fake in tests. */
export interface TrackerTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
const realTimers: TrackerTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class SubmissionTracker {
  private held: Held | null = null;
  private phase: Phase = { t: 'idle' };
  /** The last sign-in read from its form going, while a late request error for it can still take it back. */
  private lately: { readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly until: number } | null = null;
  /**
   * Runs at the earliest deadline of the copies that still hold values (the held form, and the one a navigation waits
   * on, each `HOLD_MS` after its own values came), and is set again for the next. (`#`: never in a JSON dump of the tracker.)
   */
  #valuesTimer: unknown = null;
  readonly #timers: TrackerTimers;

  constructor(
    private readonly now: () => number = Date.now,
    timers: TrackerTimers = realTimers,
  ) {
    this.#timers = timers;
  }

  /** The copies of a form the tracker holds: the held one, and the one a navigation waits on (often the same). */
  private copies(): Held[] {
    const all = [this.held, this.phase.t === 'idle' ? null : this.phase.held].filter((h): h is Held => h !== null);
    return all[0] === all[1] ? all.slice(0, 1) : all;
  }

  /** The timer, at the earliest deadline among the copies that hold values; none when none do. */
  private scheduleValues(): void {
    if (this.#valuesTimer !== null) this.#timers.clearTimeout(this.#valuesTimer);
    this.#valuesTimer = null;
    const deadlines = this.copies().flatMap((h) => (h.candidate.values && h.valuesAt !== null ? [h.valuesAt + HOLD_MS] : []));
    if (deadlines.length === 0) return;
    this.#valuesTimer = this.#timers.setTimeout(() => {
      this.#valuesTimer = null;
      this.expireValues();
    }, Math.max(0, Math.min(...deadlines) - this.now()));
  }

  /** A deadline came: each copy whose values are `HOLD_MS` old loses them, and a form held that long is forgotten. */
  private expireValues(): void {
    const now = this.now();
    for (const held of this.copies()) {
      if (held.valuesAt !== null && now - held.valuesAt >= HOLD_MS) {
        held.candidate = withoutValues(held.candidate);
        held.valuesAt = null;
      }
    }
    const old = (held: Held | null) => !!held && now - held.at >= HOLD_MS;
    if (old(this.held)) this.held = null;
    if (this.phase.t !== 'idle' && old(this.phase.held)) this.phase = { t: 'idle' };
    this.scheduleValues();
  }

  /** The candidate's deadline, handed to the save card with its values: the card doesn't get a fresh 5 minutes. */
  private valuesUntil(held: Held): number | null {
    return held.candidate.values && held.valuesAt !== null ? held.valuesAt + HOLD_MS : null;
  }

  /** What was typed goes from every copy: the held form, and the one a navigation waits on. */
  private dropValues(): void {
    for (const held of this.copies()) {
      if (held.candidate.values) held.candidate = withoutValues(held.candidate);
      held.valuesAt = null;
    }
  }

  /** The held form, if any and not expired. */
  private current(): Held | null {
    if (this.held && this.now() - this.held.at > HOLD_MS) this.held = null;
    return this.held;
  }

  /** The agent's candidate, from a frame whose origin main read. */
  candidate(candidate: PasswordsCandidate, origin: string): SavingOutcome[] {
    if (!candidate.hasPassword) return [];
    const before = this.current();
    const same = before?.candidate.formId === candidate.formId && before.origin === origin;
    // A new candidate for the same form keeps its submit (`blur` then `submit`, or the other way round).
    const already = same && before.submitted;
    const submitted = candidate.signal !== 'blur' || already;
    // A new submit (a corrected retry) starts afresh: the last attempt's 401 isn't this one's.
    const carry = same && (already || candidate.signal === 'blur');
    // Values come only with a submit signal. A blur after one keeps the submit's.
    const values = candidate.signal === 'blur' ? (already ? before?.candidate.values : undefined) : candidate.values;
    // A blur keeps the submit's values, and their deadline; new values count from now.
    const valuesAt = !values ? null : candidate.signal === 'blur' ? (before?.valuesAt ?? this.now()) : this.now();
    this.held = {
      candidate: values ? { ...withoutValues(candidate), values } : withoutValues(candidate),
      origin,
      at: this.now(),
      submitted,
      status: carry ? before.status : null,
      error: carry ? before.error : false,
      watched: same && already ? before.watched : null,
      valuesAt,
    };
    this.scheduleValues();
    // One submit is one `submitted`, however many signals it made. A second submit of the same form
    // while the first is still undecided (within the agent's 10 s watch) emits nothing either: the
    // save card's phase decides what a resubmit means.
    if (candidate.signal === 'blur' || already) return [];
    return [{ type: 'submitted', formId: candidate.formId, kind: candidate.kind, origin, signal: candidate.signal, values: candidate.values ? { username: candidate.values.username } : null }];
  }

  /**
   * A request to the page's own origin answered after a submit. Held: its status rides with the form, and an error
   * vetoes a success. Just signed in by the form going (`lately`): an error takes the sign-in back (`failed`), so its
   * save card goes.
   */
  hint(formId: string, status: number): SavingOutcome[] {
    const held = this.current();
    if (held && held.submitted && held.candidate.formId === formId) {
      held.status = status;
      if (status >= 400) held.error = true;
      return [];
    }
    const late = this.lately;
    if (!late || late.formId !== formId || status < 400) return [];
    this.lately = null;
    if (this.now() > late.until) return [];
    return [{ type: 'failed', formId, kind: late.kind, origin: late.origin, why: 'error-response' }];
  }

  /** The page's credential forms now: from the new document, for the reappeared-form check. */
  forms(report: PasswordsForms): SavingOutcome[] {
    if (this.phase.t === 'settling') this.phase.forms = report.forms;
    return [];
  }

  /**
   * A main-frame navigation started. `byPage`: the page started it (not the address bar, a bookmark, Back).
   * It's the sign-in's answer only after a submit signal: a link you clicked after typing a password isn't one.
   */
  navigationStarted(byPage: boolean): SavingOutcome[] {
    // A new document numbers its forms afresh: a late error from it isn't the last page's sign-in's.
    this.lately = null;
    const held = this.current();
    if (!byPage || !held?.submitted) {
      // You went somewhere yourself, or the page did with nothing submitted: what was held belongs to the page left.
      this.reset();
      return [];
    }
    this.phase = { t: 'navigating', held };
    return [];
  }

  /** The navigation ended without committing a document (a 204, a download, an aborted or failed one): nothing is decided by it. */
  navigationFailed(): SavingOutcome[] {
    if (this.phase.t !== 'navigating') return [];
    const { held } = this.phase;
    this.phase = { t: 'idle' };
    // The agent's watch may have answered while it waited: that answer decides now.
    const watched = held.watched;
    held.watched = null;
    if (watched === 'gone') return this.gone(held.candidate.formId);
    if (watched === 'still') return this.still(held.candidate.formId);
    return [];
  }

  /** The main frame committed a new document, with its HTTP response code (-1 for none, as `did-navigate` gives). */
  navigated(code: number): SavingOutcome[] {
    if (this.phase.t !== 'navigating') return [];
    const { held } = this.phase;
    if (code >= 400) {
      this.phase = { t: 'idle' };
      failedHeld(held);
      return [{ type: 'failed', formId: held.candidate.formId, kind: held.candidate.kind, origin: held.origin, why: 'error-response' }];
    }
    this.phase = { t: 'settling', held, forms: null };
    return [];
  }

  /** The new page stopped loading and its agent had `SETTLE_MS` to report: the reappeared-form check. */
  settled(): SavingOutcome[] {
    if (this.phase.t !== 'settling') return [];
    const { held, forms } = this.phase;
    this.phase = { t: 'idle' };
    const c = held.candidate;
    // The same password field shown again, in a form that isn't a first step: the sign-in didn't take.
    const reappeared = (forms ?? []).some((f) => f.kind !== 'username-only' && (sameField(c.password ?? c.newPassword, f.password) || sameField(c.newPassword ?? c.password, f.newPassword)));
    if (reappeared || vetoed(held)) {
      failedHeld(held);
      return [{ type: 'failed', formId: c.formId, kind: c.kind, origin: held.origin, why: reappeared ? 'reappeared' : 'error-response' }];
    }
    this.held = null;
    return [{ type: 'signedIn', formId: c.formId, kind: c.kind, origin: held.origin, how: 'navigation', hint: hintOf(held.status), values: valuesOf(held), valuesUntil: this.valuesUntil(held), lateUntil: null }];
  }

  /** The main frame navigated within its document (`did-navigate-in-page`): an SPA's route change. */
  navigatedInPage(): SavingOutcome[] {
    const held = this.current();
    if (held?.submitted && this.phase.t === 'idle') this.phase = { t: 'same-document', held };
    return [];
  }

  /** After a submit signal, the agent saw the password field go. */
  gone(formId: string): SavingOutcome[] {
    const held = this.current();
    if (!held || !held.submitted || held.candidate.formId !== formId) return [];
    if (this.phase.t === 'navigating') {
      // The page is navigating: the new page decides, unless the navigation never commits (navigationFailed).
      held.watched = 'gone';
      return [];
    }
    if (this.phase.t === 'settling') return [];
    const how = this.phase.t === 'same-document' ? 'same-document' : 'form-gone';
    this.phase = { t: 'idle' };
    if (vetoed(held)) {
      failedHeld(held);
      return [{ type: 'failed', formId, kind: held.candidate.kind, origin: held.origin, why: 'error-response' }];
    }
    this.held = null;
    const lateUntil = this.now() + LATE_ERROR_MS;
    this.lately = { formId, kind: held.candidate.kind, origin: held.origin, until: lateUntil };
    return [{ type: 'signedIn', formId, kind: held.candidate.kind, origin: held.origin, how, hint: hintOf(held.status), values: valuesOf(held), valuesUntil: this.valuesUntil(held), lateUntil }];
  }

  /** After a submit signal, the form was still shown at the end of the agent's watch. */
  still(formId: string): SavingOutcome[] {
    const held = this.current();
    if (!held || !held.submitted || held.candidate.formId !== formId) return [];
    if (this.phase.t === 'navigating') {
      // The page is navigating: the new page decides, unless the navigation never commits (navigationFailed).
      held.watched = 'still';
      return [];
    }
    if (this.phase.t === 'settling') return [];
    this.phase = { t: 'idle' };
    failedHeld(held);
    return [{ type: 'failed', formId, kind: held.candidate.kind, origin: held.origin, why: 'still-shown' }];
  }

  /** Whether a navigation's settle timer is wanted. */
  get settling(): boolean {
    return this.phase.t === 'settling';
  }

  /** Whether a navigation has started and not yet committed. */
  get navigating(): boolean {
    return this.phase.t === 'navigating';
  }

  /** Forget the form and anything typed: a navigation of your own, the page going, passwords turned off there. */
  reset(): void {
    this.dropValues();
    this.held = null;
    this.lately = null;
    this.phase = { t: 'idle' };
    this.scheduleValues();
  }
}
