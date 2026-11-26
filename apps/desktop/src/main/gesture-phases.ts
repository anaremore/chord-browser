/**
 * The chord swipe's phases (DESIGN.md §6.4): the shell sees only wheel events, which don't say when the fingers lift.
 * On macOS a trackpad's own phases do (AppKit's), and main forwards them as `gesture:phase`. Elsewhere it forwards
 * none: Chromium makes up begin and end there for any wheel (its MouseWheelPhaseHandler: an end 500 ms after the last
 * event, or at once when the page cancels the scroll), which says nothing about fingers, and the shell ends a swipe
 * when its events stop (#242's review, Carbon's B1).
 */
import type { GesturePhase } from '@chord/ipc';

const PHASES: Partial<Record<string, GesturePhase>> = {
  gestureScrollBegin: 'begin',
  gestureScrollEnd: 'end',
  gestureFlingStart: 'fling',
};

/** One window's shell: which phases it's told, and an end of its own when the window loses focus mid-gesture. */
export class GesturePhases {
  private began = false;

  constructor(private readonly platform: NodeJS.Platform) {}

  /** The phase to forward for an input event of the shell's, if any (macOS's alone). */
  input(type: string): GesturePhase | undefined {
    if (this.platform !== 'darwin') return undefined;
    const phase = PHASES[type];
    if (phase) this.began = phase === 'begin';
    return phase;
  }

  /** The window lost focus: the end to send, if a gesture began there and hasn't ended (its end won't come). */
  blurred(): GesturePhase | undefined {
    if (!this.began) return undefined;
    this.began = false;
    return 'end';
  }
}
