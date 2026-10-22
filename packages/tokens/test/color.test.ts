import { describe, expect, it } from 'vitest';
import { circularMeanHue, contrast, cssOklch, oklchToRgb } from '../src';

describe('color', () => {
  it('converts OKLCH white and black', () => {
    const white = oklchToRgb({ l: 1, c: 0, h: 0 });
    expect(white.r).toBeCloseTo(1, 9);
    expect(white.g).toBeCloseTo(1, 9);
    expect(white.b).toBeCloseTo(1, 9);
    const black = oklchToRgb({ l: 0, c: 0, h: 0 });
    expect(black.r + black.g + black.b).toBeCloseTo(0, 6);
  });

  it('matches a known OKLCH → sRGB conversion', () => {
    // oklch(0.628 0.2577 29.23) is sRGB red, #ff0000
    const red = oklchToRgb({ l: 0.62796, c: 0.25768, h: 29.2339 });
    expect(red.r).toBeCloseTo(1, 2);
    expect(red.g).toBeCloseTo(0, 2);
    expect(red.b).toBeCloseTo(0, 2);
  });

  it('computes WCAG contrast', () => {
    const white = oklchToRgb({ l: 1, c: 0, h: 0 });
    const black = oklchToRgb({ l: 0, c: 0, h: 0 });
    expect(contrast(white, black)).toBeCloseTo(21, 1);
    expect(contrast(white, white)).toBeCloseTo(1, 6);
  });

  it('averages hues around the circle', () => {
    expect(circularMeanHue([350, 10])).toBeCloseTo(0, 6);
    expect(circularMeanHue([300, 30])).toBeCloseTo(345, 6);
  });

  it('formats CSS oklch()', () => {
    expect(cssOklch({ l: 0.5, c: 0.1, h: 200 })).toBe('oklch(0.5 0.1 200)');
    expect(cssOklch({ l: 0.5, c: 0.1, h: 200 }, 0.72)).toBe('oklch(0.5 0.1 200 / 0.72)');
  });
});
