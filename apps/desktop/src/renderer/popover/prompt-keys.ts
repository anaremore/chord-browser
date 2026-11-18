/**
 * When a sign-in box's keyboard may answer it (Popover.tsx `AuthCard`). Its answers wait
 * `durations.promptInputDelay` after it appears (`arm`), so a page can't time the box to appear under
 * a click or a key meant for itself. And Enter must be pressed fresh once that's past: a key held
 * through the delay repeats (`repeat`), and its repeats would otherwise sign in on whatever has the
 * focus then. A press from before the box appeared never reaches it as a fresh one, only its repeats.
 */
export class PromptKeys {
  private armed = false;
  /** The Enter being held went down once the box could take it. */
  private freshEnter = false;

  arm(): void {
    this.armed = true;
  }

  /** Whether the box may be answered now (Sign in, the chooser, Unlock; Cancel and Escape always may). */
  get ready(): boolean {
    return this.armed;
  }

  /** A keydown in the box: false when its default (submitting, pressing the focused button) must not happen. */
  keydown(event: { key: string; repeat: boolean }): boolean {
    if (event.key !== 'Enter') return true;
    if (!event.repeat) this.freshEnter = this.armed;
    return this.armed && this.freshEnter;
  }
}
