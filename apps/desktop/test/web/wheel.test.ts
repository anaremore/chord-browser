import { describe, expect, it } from 'vitest';
import {
  ADD_STEP_DEG,
  MAX_CHROMA,
  PICK_L,
  addedStop,
  colorToPoint,
  describeColor,
  nearestStop,
  pointToColor,
  removesOnRelease,
  stepColor,
  surpriseStops,
} from '../../src/renderer/settings/wheel';

const SIZE = 240;

describe('color wheel geometry', () => {
  it('puts hue 0 at the top, growing clockwise, and chroma outward', () => {
    expect(colorToPoint({ h: 0, c: MAX_CHROMA }, SIZE)).toEqual({ x: 120, y: 0 });
    const right = colorToPoint({ h: 90, c: MAX_CHROMA }, SIZE);
    expect(right.x).toBeCloseTo(240, 6);
    expect(right.y).toBeCloseTo(120, 6);
    expect(colorToPoint({ h: 200, c: 0 }, SIZE)).toEqual({ x: 120, y: 120 });
  });

  it('turns a point back into the same color', () => {
    for (const color of [
      { h: 30, c: 0.14 },
      { h: 271, c: 0.05 },
      { h: 359, c: 0.16 },
    ]) {
      const p = colorToPoint(color, SIZE);
      const back = pointToColor(p.x, p.y, SIZE).color;
      expect(back.h).toBeCloseTo(color.h, 6);
      expect(back.c).toBeCloseTo(color.c, 6);
      expect(back.l).toBe(PICK_L);
    }
  });

  it('caps chroma at the rim and reports how far out a point is', () => {
    const outside = pointToColor(120, -60, SIZE);
    expect(outside.color.c).toBe(MAX_CHROMA);
    expect(outside.distance).toBeCloseTo(1.5, 6);
  });
});

describe('handles', () => {
  const stops = [
    { l: PICK_L, c: 0.12, h: 0 },
    { l: PICK_L, c: 0.12, h: 180 },
  ];

  it('a click moves the nearest handle', () => {
    expect(nearestStop(120, 10, stops, SIZE)).toBe(0);
    expect(nearestStop(120, 230, stops, SIZE)).toBe(1);
  });

  it('"+" adds a color a little way around from the last, never gray', () => {
    expect(addedStop(stops)).toEqual({ l: PICK_L, c: 0.12, h: 180 + ADD_STEP_DEG });
    expect(addedStop([{ l: PICK_L, c: 0.01, h: 350 }])).toEqual({ l: PICK_L, c: 0.08, h: 30 });
  });

  it('a handle let go off the wheel is removed, unless it is the only one', () => {
    expect(removesOnRelease(1.4, 2)).toBe(true);
    expect(removesOnRelease(1.1, 2)).toBe(false);
    expect(removesOnRelease(1.4, 1)).toBe(false);
  });

  it('arrow keys turn the hue; Shift+arrows change chroma, within bounds', () => {
    const c = { l: PICK_L, c: 0.155, h: 358 };
    expect(stepColor(c, 'ArrowRight', false)!.h).toBe(3);
    expect(stepColor(c, 'ArrowLeft', false)!.h).toBe(353);
    expect(stepColor(c, 'ArrowUp', true)!.c).toBe(MAX_CHROMA);
    expect(stepColor(c, 'ArrowDown', true)!.c).toBeCloseTo(0.145, 6);
    expect(stepColor(c, 'PageUp', false)!.h).toBe(28);
    expect(stepColor(c, 'PageDown', false)!.h).toBe(328);
    expect(stepColor(c, 'Enter', false)).toBeNull();
  });
});

describe('describeColor', () => {
  it('names the nearest swatch and how vivid it is', () => {
    expect(describeColor({ h: 30, c: 0.14 })).toBe('Close to Coral, vivid');
    expect(describeColor({ h: 235, c: 0.09 })).toBe('Close to Sky, medium');
    expect(describeColor({ h: 300, c: 0.05 })).toBe('Close to Lilac, soft');
    expect(describeColor({ h: 120, c: 0.005 })).toBe('Close to Graphite, gray');
  });
});

describe('surpriseStops', () => {
  it('makes one to three pickable colors', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 200; i++) {
      const stops = surpriseStops(random);
      expect(stops.length).toBeGreaterThanOrEqual(1);
      expect(stops.length).toBeLessThanOrEqual(3);
      for (const s of stops) {
        expect(s.l).toBe(PICK_L);
        expect(s.c).toBeGreaterThan(0.08);
        expect(s.c).toBeLessThanOrEqual(MAX_CHROMA);
        expect(s.h).toBeGreaterThanOrEqual(0);
        expect(s.h).toBeLessThan(360);
      }
    }
  });
});
