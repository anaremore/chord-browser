import { describe, expect, it } from 'vitest';
import {
  COMMIT_SPEED,
  VelocityTracker,
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
