import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageCall } from '../../src/main/page-call';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pageCall', () => {
  it('gives the page’s answer when it comes in time', async () => {
    await expect(pageCall(Promise.resolve(7), 0)).resolves.toBe(7);
  });

  it('gives the fallback when the call fails', async () => {
    await expect(pageCall(Promise.reject(new Error('gone')), 'fallback')).resolves.toBe('fallback');
  });

  it('gives the fallback when a hung page never answers, and doesn’t wait longer than asked', async () => {
    let settled = false;
    const call = pageCall(new Promise<number>(() => {}), -1, 500).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toBe(-1);
  });
});
