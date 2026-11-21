/**
 * Peek's card follows the pointer once a frame, and its boxes go to main
 * latest-wins (renderer/shared/latest.ts): one on its way at a time, only the
 * newest waiting, so a slow main never has a queue of old boxes to work through.
 */
import { describe, expect, it } from 'vitest';
import { latestWins } from '../../src/renderer/shared/latest';

function receiver() {
  const got: number[] = [];
  const open: (() => void)[] = [];
  const send = (value: number) => {
    got.push(value);
    return new Promise<void>((done) => open.push(done));
  };
  /** Main answers the oldest send it has. */
  const answer = async () => {
    open.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { got, open, send, answer };
}

describe('latestWins', () => {
  it('sends the first at once, and only the latest of those pushed meanwhile', async () => {
    const r = receiver();
    const mover = latestWins(r.send);
    for (const v of [1, 2, 3, 4, 5]) mover.push(v);
    expect(r.got).toEqual([1]);
    expect(mover.idle).toBe(false);
    await r.answer();
    expect(r.got).toEqual([1, 5]);
    await r.answer();
    expect(r.got).toEqual([1, 5]);
    expect(mover.idle).toBe(true);
  });

  it('never has more than one on its way', async () => {
    const r = receiver();
    const mover = latestWins(r.send);
    for (let frame = 0; frame < 60; frame++) {
      mover.push(frame);
      expect(r.open.length).toBeLessThanOrEqual(1);
      if (frame % 3 === 0) await r.answer();
    }
    while (!mover.idle) await r.answer();
    // The last box pushed is always the last one sent.
    expect(r.got.at(-1)).toBe(59);
    expect(r.got.length).toBeLessThan(60);
  });

  it('a failed send doesn’t stop the next', async () => {
    const got: number[] = [];
    const mover = latestWins((v: number) => {
      got.push(v);
      return Promise.reject(new Error('closed'));
    });
    mover.push(1);
    mover.push(2);
    await new Promise((done) => setTimeout(done, 0));
    expect(got).toEqual([1, 2]);
    expect(mover.idle).toBe(true);
  });
});
