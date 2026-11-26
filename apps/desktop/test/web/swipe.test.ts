import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_SPEED,
  GestureEnd,
  IDLE_END_FRAMES,
  IDLE_END_MAX_MS,
  IDLE_END_MS,
  PHASED_END_MAX_MS,
  VelocityTracker,
  gestureIdle,
  isWheelNotch,
  lockAxis,
  rawOffset,
  rubberBand,
  rubberBandPull,
  settle,
  shownOffset,
} from '../../src/renderer/shell/swipe';

const W = 232;

describe('lockAxis', () => {
  it('waits until the gesture has moved, then locks to the clearer axis', () => {
    expect(lockAxis(5, 1)).toBe('undecided');
    expect(lockAxis(12, 4)).toBe('horizontal');
    expect(lockAxis(-12, 4)).toBe('horizontal');
    // Sideways but not clearly: still the list's.
    expect(lockAxis(12, 10)).toBe('undecided');
    expect(lockAxis(3, 20)).toBe('vertical');
  });
});

describe('rubber band', () => {
  it('follows DESIGN.md §6.4 and never reaches the full width', () => {
    expect(rubberBand(0, W)).toBe(0);
    expect(rubberBand(100, W)).toBeCloseTo((1 - 1 / ((100 * 0.55) / W + 1)) * W, 6);
    expect(rubberBand(-100, W)).toBeCloseTo(-rubberBand(100, W), 6);
    expect(rubberBand(1e6, W)).toBeLessThan(W);
  });

  it('inverts, so a caught pane continues where it is', () => {
    for (const pull of [-400, -40, 25, 300]) expect(rubberBandPull(rubberBand(pull, W), W)).toBeCloseTo(pull, 6);
  });
});

describe('shownOffset', () => {
  it('follows the fingers 1:1 toward a neighbor, up to a full width', () => {
    expect(shownOffset(-80, W, true, true)).toBe(-80);
    expect(shownOffset(80, W, true, true)).toBe(80);
    expect(shownOffset(-900, W, true, true)).toBe(-W);
  });

  it('rubber-bands past the first and last chord', () => {
    expect(shownOffset(80, W, false, true)).toBeCloseTo(rubberBand(80, W), 6);
    expect(shownOffset(-80, W, true, false)).toBeCloseTo(rubberBand(-80, W), 6);
    expect(Math.abs(shownOffset(80, W, false, true))).toBeLessThan(80);
  });

  it('has an inverse for every case', () => {
    for (const [raw, prev, next] of [
      [-80, true, true],
      [80, false, true],
      [-80, true, false],
    ] as const) {
      expect(rawOffset(shownOffset(raw, W, prev, next), W, prev, next)).toBeCloseTo(raw, 6);
    }
  });
});

describe('settle', () => {
  it('commits past half the width, unless flicked back', () => {
    expect(settle(-0.6 * W, 0, W, true, true)).toBe(1);
    expect(settle(0.6 * W, 0, W, true, true)).toBe(-1);
    expect(settle(-0.6 * W, 2 * COMMIT_SPEED, W, true, true)).toBe(0);
  });

  it('commits a fast flick toward the neighbor however short', () => {
    expect(settle(-20, -2 * COMMIT_SPEED, W, true, true)).toBe(1);
    expect(settle(20, 2 * COMMIT_SPEED, W, true, true)).toBe(-1);
  });

  it('springs back from a short, slow swipe', () => {
    expect(settle(-40, -0.1, W, true, true)).toBe(0);
    expect(settle(0, 0, W, true, true)).toBe(0);
  });

  it('never settles past the first or last chord', () => {
    expect(settle(-0.9 * W, -3, W, true, false)).toBe(0);
    expect(settle(0.9 * W, 3, W, false, true)).toBe(0);
  });
});

describe('VelocityTracker', () => {
  it('measures px/ms over the recent window', () => {
    const v = new VelocityTracker(80);
    v.reset(0, 0);
    for (let t = 8; t <= 64; t += 8) v.add(t, -t * 2);
    expect(v.velocity(64)).toBeCloseTo(-2, 6);
  });

  it('reads 0 once the fingers have rested', () => {
    const v = new VelocityTracker(80);
    v.reset(0, 0);
    v.add(10, -20);
    expect(v.velocity(500)).toBe(0);
  });

  it('carries a seeded velocity, as when a settling pane is caught', () => {
    const v = new VelocityTracker(80);
    v.reset(100, -50, -1.5);
    expect(v.velocity(100)).toBeCloseTo(-1.5, 6);
  });
});

describe('isWheelNotch', () => {
  it('tells a mouse notch from a trackpad', () => {
    expect(isWheelNotch(1, 3, false)).toBe(true);
    expect(isWheelNotch(0, 120, true)).toBe(true);
    expect(isWheelNotch(0, 6, true)).toBe(false);
    // A trackpad's later, larger deltas are still the trackpad.
    expect(isWheelNotch(0, 120, false)).toBe(false);
  });
});

describe('gestureIdle: a gesture with no end phase from the OS ends when its events stop', () => {
  it('on a machine keeping up: 80 ms with no event (about five frames at 60 a second)', () => {
    expect(gestureIdle(IDLE_END_MS - 1, 5)).toBe(false);
    expect(gestureIdle(IDLE_END_MS, 5)).toBe(true);
  });

  it('on a busy one, never before a few frames have come with no event: late frames are late input, not a lift (#198)', () => {
    // 80 ms passed but only one frame came to hand over the input waiting for it: the fingers may still be moving.
    expect(gestureIdle(IDLE_END_MS + 3, 1)).toBe(false);
    expect(gestureIdle(500, IDLE_END_FRAMES - 1)).toBe(false);
    expect(gestureIdle(IDLE_END_MS + 3, IDLE_END_FRAMES)).toBe(true);
  });

  it('in a window drawing no frames (hidden), after a second anyway', () => {
    expect(gestureIdle(IDLE_END_MAX_MS - 1, 0)).toBe(false);
    expect(gestureIdle(IDLE_END_MAX_MS, 0)).toBe(true);
  });
});

/**
 * A fake renderer for GestureEnd: a clock that only moves when told, frames drawn when told, timers that fire as the
 * clock passes them (vi's fake timers, with the clock read from them).
 */
function renderer() {
  vi.useFakeTimers();
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const ended: { at: number; speed: 'last' | 'rest' }[] = [];
  const end = new GestureEnd(
    {
      now: () => Date.now(),
      frame: (callback) => {
        frames.set(nextFrame, callback);
        return nextFrame++;
      },
      cancelFrame: (id) => void frames.delete(id),
      timer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (id) => clearTimeout(id),
    },
    (at, speed) => ended.push({ at, speed }),
  );
  /** `ms` pass, a frame drawn every `frameMs` of them (none when 0). */
  const pass = (ms: number, frameMs = 16) => {
    for (let t = 0; t < ms; ) {
      const step = frameMs > 0 ? Math.min(frameMs, ms - t) : ms - t;
      vi.advanceTimersByTime(step);
      t += step;
      if (frameMs > 0 && step === frameMs) {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback();
      }
    }
  };
  return { end, ended, pass, start: Date.now() };
}

describe('GestureEnd: when a swipe ends (#198, and #242’s review)', () => {
  afterEach(() => vi.useRealTimers());

  it('with no phases: when the events stop, IDLE_END_MS and IDLE_END_FRAMES frames with none, at the last event’s speed', () => {
    const { end, ended, pass } = renderer();
    end.event(Date.now());
    pass(IDLE_END_MS - 16);
    expect(ended).toEqual([]);
    pass(32);
    expect(ended).toEqual([expect.objectContaining({ speed: 'last' })]);
  });

  it('with no phases on a busy renderer: 80 ms with no event is no end while fewer than IDLE_END_FRAMES frames came', () => {
    const { end, ended, pass } = renderer();
    end.event(Date.now());
    // One frame every 60 ms: after 120 ms, two frames.
    pass(120, 60);
    expect(ended).toEqual([]);
    pass(60, 60);
    expect(ended).toEqual([expect.objectContaining({ speed: 'last' })]);
  });

  it('with no phases in a window drawing no frames: after IDLE_END_MAX_MS, at rest (SF1: no old speed)', () => {
    const { end, ended, pass } = renderer();
    end.event(Date.now());
    pass(IDLE_END_MAX_MS - 1, 0);
    expect(ended).toEqual([]);
    pass(1, 0);
    expect(ended).toEqual([expect.objectContaining({ speed: 'rest' })]);
  });

  it('phased: never on a pause, however long, until the OS’s end; an end that never comes, after PHASED_END_MAX_MS at rest', () => {
    const { end, ended, pass } = renderer();
    end.begin();
    end.event(Date.now());
    pass(500);
    end.event(Date.now());
    pass(PHASED_END_MAX_MS - 1);
    expect(ended).toEqual([]);
    pass(1);
    expect(ended).toEqual([expect.objectContaining({ speed: 'rest' })]);
    expect(end.phased).toBe(false);
  });

  it('a begin with no event after it never sticks to the next gesture (SF2): it ends anyway, and the next is unphased', () => {
    const { end, ended, pass } = renderer();
    end.begin();
    pass(PHASED_END_MAX_MS);
    expect(ended).toHaveLength(1);
    expect(end.phased).toBe(false);
    end.event(Date.now());
    pass(IDLE_END_MS + 32);
    expect(ended).toHaveLength(2);
  });

  it('stopped (released, a notch, reset): nothing more ends, and the next gesture starts unphased', () => {
    const { end, ended, pass } = renderer();
    end.begin();
    end.event(Date.now());
    end.stop();
    pass(PHASED_END_MAX_MS * 2);
    expect(ended).toEqual([]);
    expect(end.phased).toBe(false);
  });
});
