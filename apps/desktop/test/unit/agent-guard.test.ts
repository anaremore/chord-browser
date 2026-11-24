import { describe, expect, it } from 'vitest';
import { installAgentGuard } from '../../src/preload/agent-guard';

/** A window with the guard installed: its listeners, its focus, and events sent through it. */
function guardWindow() {
  type Listener = (event: never) => void;
  const listeners = new Map<string, Listener[]>();
  const win = {
    document: { activeElement: null as object | null },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    __chordAgentGuard: undefined as unknown,
  };
  installAgentGuard(win as never);
  const guard = win.__chordAgentGuard as {
    arm(until: string, mark: string): boolean;
    disarm(waitMs: number): Promise<{ moved: boolean; lost: boolean } | { expired: true } | null>;
  };
  /** An event through the window's capture listeners; whether the page would see it. */
  const send = (type: string, target?: object, isTrusted = true) => {
    let stopped = false;
    const event = { type, isTrusted, preventDefault: () => undefined, stopImmediatePropagation: () => void (stopped = true), composedPath: () => (target ? [target] : []) };
    for (const l of listeners.get(type) ?? []) l(event as never);
    return !stopped;
  };
  return { win, guard, send, listeners };
}

const MARK = `chord-guard-${'a1'.repeat(16)}`;

describe('the agent guard (preload/agent-guard.ts)', () => {
  it('takes input only for the element Chord’s focus check marked, and only while it has the focus', async () => {
    const { win, guard, send } = guardWindow();
    const field = {};
    const password = {};
    win.document.activeElement = field;
    expect(guard.arm('keyup', MARK)).toBe(true);
    // Before the check said which element: nothing.
    expect(send('keydown')).toBe(false);
    // Marked (the check fires the mark at it; no page sees it): its keys go.
    expect(send(MARK, field)).toBe(false);
    expect(send('keydown')).toBe(true);
    // The focus elsewhere: stopped.
    win.document.activeElement = password;
    expect(send('keypress')).toBe(false);
    // keyup is never stopped (a key may move the focus on purpose).
    expect(send('keyup')).toBe(true);
    expect(await guard.disarm(0)).toEqual({ moved: true, lost: false });
  });

  it('never takes what had the focus when it went up: the page moved it there and back around the check (the review of #117)', async () => {
    const { win, guard, send } = guardWindow();
    const field = {};
    const password = {};
    // The page put the focus on its password field right before the guard went up, and back on the element for the check.
    win.document.activeElement = password;
    guard.arm('beforeinput', MARK);
    win.document.activeElement = field;
    send(MARK, field);
    // And to the password field again before the text: stopped (the old guard took the password field as the element).
    win.document.activeElement = password;
    expect(send('beforeinput')).toBe(false);
    expect(await guard.disarm(0)).toEqual({ moved: true, lost: false });
  });

  it('a mark that isn’t Chord’s shape arms nothing, and the mark’s listener goes when the guard comes down', async () => {
    const { win, guard, send, listeners } = guardWindow();
    expect(guard.arm('keyup', 'keydown')).toBe(false);
    win.document.activeElement = {};
    guard.arm('keyup', MARK);
    expect(listeners.get(MARK)).toHaveLength(1);
    send(MARK, win.document.activeElement);
    send('keydown');
    send('keyup');
    expect(await guard.disarm(0)).toEqual({ moved: false, lost: false });
    expect(listeners.get(MARK)).toHaveLength(0);
    // Down: the page's keys go, untouched.
    expect(send('keydown')).toBe(true);
  });
});
