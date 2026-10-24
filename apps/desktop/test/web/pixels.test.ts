import { describe, expect, it } from 'vitest';
import { bgraToRgba } from '../../src/renderer/shell/pixels';

describe('frame snapshot pixels', () => {
  it('turns BGRA into RGBA, pixel by pixel, in place when the bytes are its own', () => {
    const own = new Uint8Array([1, 2, 3, 4, 10, 20, 30, 40]);
    expect(bgraToRgba(own)).toBe(own);
    expect([...own]).toEqual([3, 2, 1, 4, 30, 20, 10, 40]);
    // A view into a bigger buffer is copied, not changed.
    const big = new Uint8Array([9, 9, 9, 9, 1, 2, 3, 4]);
    expect([...bgraToRgba(big.subarray(4))]).toEqual([3, 2, 1, 4]);
    expect([...big.subarray(4)]).toEqual([1, 2, 3, 4]);
  });
});
