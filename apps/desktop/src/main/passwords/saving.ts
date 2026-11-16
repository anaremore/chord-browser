/**
 * Knowing you signed in (S17 §6): for one tab's page, from what its passwords agent reports
 * and how the page navigates, whether a form you submitted worked. Pure and synchronous (no
 * Electron), so every path is unit-tested; detector.ts feeds it.
 *
 * A form is held when you typed a password in it (a `candidate`), for at most 5 minutes, in
 * memory only. Then, after a submit signal or a navigation the page started:
 * - **it worked** if the page navigated with a response under 400 and, once the new page had
 *   settled, it doesn't show a form with the same password field (Chromium's reappeared-form
 *   check, inline in `OnPasswordFormsRendered`); or, with no navigation, if the password field
 *   went or was hidden while the agent watched (`gone`);
 * - **it failed** if the same form is still there or back (`still`, or reappeared), or the
 *   response was an error. The form stays held in case you correct the password.
 * A request to the page's own origin seen after the submit (`hint`, the PerformanceObserver;
 * M0 Q7) goes along as a hint, never as the decision.
 *
 * It never holds a field's value: candidates carry none (packages/ipc, passwords.ts).
 */
import type { PasswordsCandidate, PasswordsFieldSignature, PasswordsForms } from '@chord/ipc';

/** How long a typed form is held (S17 §6, step 1). */
export const HOLD_MS = 5 * 60_000;
/** After the new page stops loading, how long its agent has to report its forms before the check runs. */
export const SETTLE_MS = 1500;

export type SubmitSignal = PasswordsCandidate['signal'] | 'navigation';
export type ResponseHint = 'response-ok' | 'response-error' | null;

export type SavingOutcome =
  | { readonly type: 'submitted'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly signal: SubmitSignal }
  | { readonly type: 'signedIn'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly how: 'navigation' | 'same-document' | 'form-gone'; readonly hint: ResponseHint }
  | { readonly type: 'failed'; readonly formId: string; readonly kind: PasswordsCandidate['kind']; readonly origin: string; readonly why: 'error-response' | 'reappeared' | 'still-shown' };

interface Held {
  readonly candidate: PasswordsCandidate;
  /** The origin main read from the sender's frame when the candidate came. */
  readonly origin: string;
  readonly at: number;
  submitted: boolean;
  /** The last request status seen after the submit. */
  status: number | null;
}

type Phase =
  | { readonly t: 'idle' }
  /** A navigation the page started, with a form held. */
  | { readonly t: 'navigating'; readonly held: Held }
  /** The new page loaded with a response under 400; its forms are awaited. */
  | { readonly t: 'settling'; readonly held: Held; forms: PasswordsForms['forms'] | null }
  /** Navigated within the document: the agent's `gone` or `still` decides. */
  | { readonly t: 'same-document'; readonly held: Held };

const sameField = (a: PasswordsFieldSignature | null, b: PasswordsFieldSignature | null) => !!a && !!b && a.type === b.type && a.id === b.id && a.name === b.name && (a.id !== '' || a.name !== '');

const hintOf = (status: number | null): ResponseHint => (status === null ? null : status < 400 ? 'response-ok' : 'response-error');

export class SubmissionTracker {
  private held: Held | null = null;
  private phase: Phase = { t: 'idle' };

  constructor(private readonly now: () => number = Date.now) {}

  /** The held form, if any and not expired. */
  private current(): Held | null {
    if (this.held && this.now() - this.held.at > HOLD_MS) this.held = null;
    return this.held;
  }

  /** The agent's candidate, from a frame whose origin main read. */
  candidate(candidate: PasswordsCandidate, origin: string): SavingOutcome[] {
    if (!candidate.hasPassword) return [];
    const before = this.current();
    // A new candidate for the same form keeps its submit (`blur` then `submit`, or the other way round).
    const submitted = candidate.signal !== 'blur' || (before?.candidate.formId === candidate.formId && before.origin === origin && before.submitted);
    this.held = { candidate, origin, at: this.now(), submitted, status: before?.candidate.formId === candidate.formId ? before.status : null };
    return candidate.signal === 'blur' ? [] : [{ type: 'submitted', formId: candidate.formId, kind: candidate.kind, origin, signal: candidate.signal }];
  }

  hint(formId: string, status: number): void {
    const held = this.current();
    if (held && held.submitted && held.candidate.formId === formId) held.status = status;
  }

  /** The page's credential forms now: from the new document, for the reappeared-form check. */
  forms(report: PasswordsForms): SavingOutcome[] {
    if (this.phase.t === 'settling') this.phase.forms = report.forms;
    return [];
  }

  /** A main-frame navigation started. `byPage`: the page started it (not the address bar, a bookmark, Back). */
  navigationStarted(byPage: boolean): SavingOutcome[] {
    const held = this.current();
    if (!held || !byPage) {
      // You went somewhere yourself: whatever was held belongs to the page you left.
      if (!byPage) this.reset();
      return [];
    }
    const out: SavingOutcome[] = held.submitted ? [] : [{ type: 'submitted', formId: held.candidate.formId, kind: held.candidate.kind, origin: held.origin, signal: 'navigation' }];
    held.submitted = true;
    this.phase = { t: 'navigating', held };
    return out;
  }

  /** The main frame committed a new document, with its HTTP response code (-1 for none, as `did-navigate` gives). */
  navigated(code: number): SavingOutcome[] {
    if (this.phase.t !== 'navigating') return [];
    const { held } = this.phase;
    if (code >= 400) {
      this.phase = { t: 'idle' };
      held.submitted = false;
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
    const reappeared = (forms ?? []).some((f) => f.kind !== 'username-only' && (sameField(f.password, c.password ?? c.newPassword) || sameField(f.newPassword, c.newPassword ?? c.password)));
    if (reappeared) {
      held.submitted = false;
      return [{ type: 'failed', formId: c.formId, kind: c.kind, origin: held.origin, why: 'reappeared' }];
    }
    this.held = null;
    return [{ type: 'signedIn', formId: c.formId, kind: c.kind, origin: held.origin, how: 'navigation', hint: hintOf(held.status) }];
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
    if (!held || !held.submitted || held.candidate.formId !== formId || this.phase.t === 'navigating' || this.phase.t === 'settling') return [];
    const how = this.phase.t === 'same-document' ? 'same-document' : 'form-gone';
    this.phase = { t: 'idle' };
    this.held = null;
    return [{ type: 'signedIn', formId, kind: held.candidate.kind, origin: held.origin, how, hint: hintOf(held.status) }];
  }

  /** After a submit signal, the form was still shown at the end of the agent's watch. */
  still(formId: string): SavingOutcome[] {
    const held = this.current();
    if (!held || !held.submitted || held.candidate.formId !== formId || this.phase.t === 'navigating' || this.phase.t === 'settling') return [];
    this.phase = { t: 'idle' };
    held.submitted = false;
    return [{ type: 'failed', formId, kind: held.candidate.kind, origin: held.origin, why: 'still-shown' }];
  }

  /** Whether a navigation's settle timer is wanted. */
  get settling(): boolean {
    return this.phase.t === 'settling';
  }

  reset(): void {
    this.held = null;
    this.phase = { t: 'idle' };
  }
}
