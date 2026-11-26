/**
 * The chord swipe's phases from main (gesture-phases.ts): macOS's alone. Chromium makes up begin and end for any
 * wheel elsewhere (an end 500 ms after the last event, or at once when the shell cancels the scroll), which a shell
 * that waits for the OS's end would follow: a swipe ended mid-way, or late at rest (#242's review, Carbon's B1).
 */
import { describe, expect, it } from 'vitest';
import { GesturePhases } from '../../src/main/gesture-phases';

const swipe = ['gestureScrollBegin', 'mouseWheel', 'gestureScrollUpdate', 'mouseWheel', 'gestureScrollEnd', 'gestureFlingStart'];

describe('the swipe phases main forwards', () => {
  it('on macOS: begin, end and fling, nothing else', () => {
    const phases = new GesturePhases('darwin');
    expect(swipe.map((type) => phases.input(type))).toEqual(['begin', undefined, undefined, undefined, 'end', 'fling']);
  });

  it('on Windows and Linux: none (Chromium’s own are no lift of the fingers)', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const phases = new GesturePhases(platform);
      expect(swipe.map((type) => phases.input(type)).filter(Boolean), platform).toEqual([]);
      expect(phases.blurred(), platform).toBeUndefined();
    }
  });

  it('a window that loses focus mid-gesture is sent its end, once; none once the gesture ended', () => {
    const phases = new GesturePhases('darwin');
    phases.input('gestureScrollBegin');
    expect(phases.blurred()).toBe('end');
    expect(phases.blurred()).toBeUndefined();
    phases.input('gestureScrollBegin');
    phases.input('gestureFlingStart');
    expect(phases.blurred()).toBeUndefined();
  });
});
