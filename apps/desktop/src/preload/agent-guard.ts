/**
 * The guard while an agent's text or keys go in (S18 M2c; Neon's review of #110), in an agent tab's page preload: its
 * listeners are the window's first (the preload runs before any of the page's scripts), so a capture listener the
 * page puts on the window can't see a key first, move the focus to a password field and stop everything after it.
 *
 * Main (control/page.ts) arms it, through this world (Electron's preload world, 999), with an event name only main
 * knows; its focus check (act.ts, in Chord's world) then fires that event at the element, and that element is the one
 * input may reach (the review of #117: never what had the focus when it was armed, which the page could have moved
 * there and back). Until then, and once it's another, a trusted key or insertion is stopped before the page sees it. Disarming waits for the input's last event (the key's keyup, the text's
 * beforeinput), at most `waitMs`, and says whether anything was stopped (`moved`) or that last event never came
 * here (`lost`: the focus went where this document doesn't see, into a frame). keyup is watched, not stopped: a key
 * may move the focus on purpose (Tab).
 */
type GuardEvent = { type: string; isTrusted: boolean; preventDefault(): void; stopImmediatePropagation(): void; composedPath?(): unknown[] };
type Focusable = { shadowRoot?: { activeElement?: Focusable | null } | null };
type GuardWindow = {
  document: { activeElement: Focusable | null };
  addEventListener(type: string, listener: (event: GuardEvent) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: GuardEvent) => void, capture: boolean): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  __chordAgentGuard?: unknown;
};

export const GUARDED_EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend'] as const;

/** The name main arms the guard with (page.ts makes it): random, so no page listens for it or fires it. */
export const GUARD_MARK = /^chord-guard-[0-9a-f]{32}$/;

export function installAgentGuard(win: GuardWindow): void {
  let armed: { expected: Focusable | null; mark: string; until: string; moved: boolean; done: boolean; finished: (() => void) | null; timer: number } | null = null;
  /** A guard was up in this document (this preload is the document's): one not up now ran out, or was dropped. */
  let everArmed = false;
  const deepFocus = (): Focusable | null => {
    let f = win.document.activeElement;
    while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement;
    return f;
  };
  const stop = (event: GuardEvent) => {
    const guard = armed;
    if (!guard || !event.isTrusted) return;
    if (event.type === guard.until) {
      guard.done = true;
      guard.finished?.();
    }
    if (event.type === 'keyup' || deepFocus() === guard.expected) return;
    guard.moved = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of GUARDED_EVENTS) win.addEventListener(type, stop, true);
  /**
   * The element Chord's focus check found focused, by the event it fires at it (only Chord's world fires it: it's
   * untrusted, as any script's, but no page knows its name). Its first node on the way, so inside an open shadow root
   * too; a closed one's host, as deepFocus sees it.
   */
  const marked = (event: GuardEvent) => {
    const guard = armed;
    if (!guard || event.type !== guard.mark) return;
    event.stopImmediatePropagation();
    guard.expected = ((event.composedPath?.() ?? [])[0] as Focusable | undefined) ?? null;
  };
  const down = (guard: NonNullable<typeof armed>) => {
    win.clearTimeout(guard.timer);
    win.removeEventListener(guard.mark, marked, true);
    if (armed === guard) armed = null;
  };
  win.__chordAgentGuard = {
    arm(until: string, mark: string): boolean {
      if (!GUARD_MARK.test(mark)) return false;
      if (armed) down(armed);
      // Nothing may take input until Chord's check says which element does.
      const guard = { expected: null, mark, until: until === 'keyup' ? 'keyup' : 'beforeinput', moved: false, done: false, finished: null, timer: 0 };
      win.addEventListener(mark, marked, true);
      // Never left up for good: main takes it down when the input's in (or the action ends), at the latest after
      // 30 s, longer than an action's worst path between arming and the input (its checks' limits).
      guard.timer = win.setTimeout(() => down(guard), 30_000);
      armed = guard;
      everArmed = true;
      return true;
    },
    /** Down at once: the user took the tab (their key or click), and their keys are never stopped. */
    drop(): void {
      if (armed) down(armed);
    },
    disarm(waitMs: number): Promise<{ moved: boolean; lost: boolean } | { expired: true } | null> {
      const guard = armed;
      // None up: in this document, it ran out (or was dropped); null only in another document (the page went).
      if (!guard) return Promise.resolve(everArmed ? { expired: true } : null);
      return new Promise((resolve) => {
        const finish = () => {
          // A task later: the last event's own dispatch is over.
          win.setTimeout(() => {
            down(guard);
            resolve({ moved: guard.moved, lost: !guard.done });
          }, 0);
        };
        if (guard.done) return finish();
        guard.finished = finish;
        win.setTimeout(finish, Math.max(0, Math.min(waitMs, 1000)));
      });
    },
  };
}

/**
 * A frame's guard, in an agent's tab: while main has the guard up (it says so over IPC, to every frame, and to a
 * frame made meanwhile when its preload asks, `upNow`), every
 * trusted key and insertion in this frame is stopped (an agent's text and keys are only ever for an element of the
 * top document; one that reaches a frame went there because the focus moved), and main hears of it.
 */
export function installFrameGuard(win: GuardWindow, onArm: (listener: (up: boolean) => void) => void, stopped: () => void, upNow: boolean): void {
  // A frame made (or gone to another page) while main's guard is up starts with its own up.
  let up = upNow;
  let timer = up ? win.setTimeout(() => (up = false), 30_000) : 0;
  onArm((now) => {
    up = now;
    win.clearTimeout(timer);
    if (now) timer = win.setTimeout(() => (up = false), 30_000);
  });
  const stop = (event: GuardEvent) => {
    if (!up || !event.isTrusted || event.type === 'keyup') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopped();
  };
  for (const type of GUARDED_EVENTS) win.addEventListener(type, stop, true);
}
