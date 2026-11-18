/**
 * When a sign-in box's keyboard may answer it (Popover.tsx `AuthCard`). Its answers wait
 * `durations.promptInputDelay` after it appears (`arm`), so a page can't time the box to appear under
 * a click or a key meant for itself. And the keys that press its buttons must be pressed fresh once
 * that's past: Enter (which presses on its keydown, and repeats while held) and Space (which presses
 * on its keyup). A key held through the delay would otherwise press whatever has the focus then (Sign
 * in, once the box is armed and filled). A press from before the box appeared never reaches it as a
 * fresh one, only its repeats and its release. Space typed into a text field is only typing.
 */
const PRESSING = new Set(['Enter', ' ']);

export interface PromptKey {
  key: string;
  repeat: boolean;
  /** It's in a text field (the username or password): Space there types, it presses nothing. */
  field?: boolean;
}

export class PromptKeys {
  private armed = false;
  /** By key: the press being held went down once the box could take it. */
  private readonly fresh = new Map<string, boolean>();

  arm(): void {
    this.armed = true;
  }

  /** Whether the box may be answered now (Sign in, the chooser, Unlock; Cancel and Escape always may). */
  get ready(): boolean {
    return this.armed;
  }

  /** A keydown in the box: false when its default (submitting, pressing the focused button) must not happen. */
  keydown(event: PromptKey): boolean {
    if (!this.guards(event)) return true;
    if (!event.repeat) this.fresh.set(event.key, this.armed);
    return this.armed && this.fresh.get(event.key) === true;
  }

  /** A keyup in the box: false when it must not press anything (Space's release of a press from before). */
  keyup(event: Omit<PromptKey, 'repeat'>): boolean {
    if (!this.guards({ ...event, repeat: false })) return true;
    const fresh = this.armed && this.fresh.get(event.key) === true;
    this.fresh.delete(event.key);
    return fresh;
  }

  private guards(event: PromptKey): boolean {
    return PRESSING.has(event.key) && !(event.key === ' ' && event.field);
  }
}
