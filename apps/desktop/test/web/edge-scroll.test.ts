import { describe, expect, it } from 'vitest';
import { edgeSpeed } from '../../src/renderer/shell/edge-scroll';

const list = { top: 100, bottom: 700, left: 0, right: 240 };

describe('edgeSpeed', () => {
  it('scrolls only near an edge, faster the closer, and at full speed past it', () => {
    expect(edgeSpeed(100, 400, list)).toBe(0);
    expect(edgeSpeed(100, 700 - 48, list)).toBe(0);
    expect(edgeSpeed(100, 700 - 24, list)).toBeCloseTo(0.3, 5);
    expect(edgeSpeed(100, 700, list)).toBeCloseTo(1.2, 5);
    expect(edgeSpeed(100, 760, list)).toBeCloseTo(1.2, 5);
    expect(edgeSpeed(100, 100 + 24, list)).toBeCloseTo(-0.3, 5);
    expect(edgeSpeed(100, 40, list)).toBeCloseTo(-1.2, 5);
  });

  it('leaves a list alone when the pointer is beside it (on the page, to split)', () => {
    expect(edgeSpeed(400, 700, list)).toBe(0);
  });

  it('keeps the band to a quarter of a short list', () => {
    const short = { top: 0, bottom: 80, left: 0, right: 240 };
    expect(edgeSpeed(100, 40, short)).toBe(0);
    expect(edgeSpeed(100, 79, short)).toBeGreaterThan(0);
  });
});
