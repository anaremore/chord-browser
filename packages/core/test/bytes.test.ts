import { describe, expect, it } from 'vitest';
import { sameBytes } from '../src';

describe('sameBytes: the one of it (#291)', () => {
  it('the same bytes, and only those, of the same length', () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([]), new Uint8Array([]))).toBe(true);
    expect(sameBytes(new Uint8Array([9, 1, 2]).subarray(1), new Uint8Array([1, 2]))).toBe(true);
  });
});
