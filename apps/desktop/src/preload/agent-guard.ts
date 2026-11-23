/**
 * The guard while an agent's text or keys go in (S18 M2c; Neon's review of #110), in an agent tab's page preload: its
 * listeners are the window's first (the preload runs before any of the page's scripts), so a capture listener the
 * page puts on the window can't see a key first, move the focus to a password field and stop everything after it.
 *
 * Main (control/page.ts) arms it, through this world (Electron's preload world, 999), right before its last focus
 * check; the element focused then is the one input may reach. A trusted key or insertion bound anywhere else is
 * stopped before the page sees it. Disarming waits for the input's last event (the key's keyup, the text's
 * beforeinput), at most `waitMs`, and says whether anything was stopped (`moved`) or that last event never came
 * here (`lost`: the focus went where this document doesn't see, into a frame). keyup is watched, not stopped: a key
 * may move the focus on purpose (Tab).
 */
type GuardEvent = { type: string; isTrusted: boolean; preventDefault(): void; stopImmediatePropagation(): void };
type Focusable = { shadowRoot?: { activeElement?: Focusable | null } | null };
type GuardWindow = {
  document: { activeElement: Focusable | null };
  addEventListener(type: string, listener: (event: GuardEvent) => void, capture: boolean): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  __chordAgentGuard?: unknown;
};

export const GUARDED_EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput'] as const;

export function installAgentGuard(win: GuardWindow): void {
  let armed: { expected: Focusable | null; until: string; moved: boolean; done: boolean; finished: (() => void) | null; timer: number } | null = null;
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
  win.__chordAgentGuard = {
    arm(until: string): boolean {
      if (armed) win.clearTimeout(armed.timer);
      const guard = { expected: deepFocus(), until: until === 'keyup' ? 'keyup' : 'beforeinput', moved: false, done: false, finished: null, timer: 0 };
      // Never left up for good: main takes it down when the input's in (or the action ends), at the latest after
      // 30 s, longer than an action's worst path between arming and the input (its checks' limits).
      guard.timer = win.setTimeout(() => {
        if (armed === guard) armed = null;
      }, 30_000);
      armed = guard;
      return true;
    },
    disarm(waitMs: number): Promise<{ moved: boolean; lost: boolean } | null> {
      const guard = armed;
      if (!guard) return Promise.resolve(null);
      return new Promise((resolve) => {
        const finish = () => {
          // A task later: the last event's own dispatch is over.
          win.setTimeout(() => {
            if (armed === guard) armed = null;
            win.clearTimeout(guard.timer);
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
 * A frame's guard, in an agent's tab: while main has the guard up (it says so over IPC, to every frame), every
 * trusted key and insertion in this frame is stopped (an agent's text and keys are only ever for an element of the
 * top document; one that reaches a frame went there because the focus moved), and main hears of it.
 */
export function installFrameGuard(win: GuardWindow, onArm: (listener: (up: boolean) => void) => void, stopped: () => void): void {
  let up = false;
  let timer = 0;
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
