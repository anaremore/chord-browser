/**
 * Your data's stamps (S15 §4): the hybrid logical clock, and an export's
 * stamps from rows. A change made after seeing another wins over it, whatever
 * either computer's wall clock says.
 */
import { describe, expect, it } from 'vitest';
import { compareStamps, isDeviceId, isStamp, newDeviceId, nextStamp, rowStamp, seenStamp, type Stamp } from '../src';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

describe('a new stamp here', () => {
  it.each<[string, Stamp | null, number, Stamp]>([
    ['the first takes the wall clock', null, 1000, [1000, 0, A]],
    ['the clock moved on: the wall clock, counter back to 0', [1000, 3, A], 1001, [1001, 0, A]],
    ['the same millisecond: the counter goes up', [1000, 3, A], 1000, [1000, 4, A]],
    ['the clock went back: the last stamp’s time, counter up', [5000, 0, A], 1000, [5000, 1, A]],
    ['after another computer’s stamp from the future: still after it', [9000, 2, B], 1000, [9000, 3, A]],
    ['a fraction of a millisecond is dropped', null, 1000.9, [1000, 0, A]],
  ])('%s', (_what, last, now, expected) => {
    expect(nextStamp(last, now, A)).toEqual(expected);
  });
});

describe('reading another computer’s stamp', () => {
  it.each<[string, Stamp | null, Stamp, number, Stamp]>([
    ['behind the wall clock: nothing to catch up', [1000, 0, A], [900, 5, B], 2000, [2000, 0, A]],
    ['ahead of everything: the clock moves up to it', [1000, 0, A], [5000, 7, B], 2000, [5000, 8, A]],
    ['equal to the last stamp: past both counters', [5000, 2, A], [5000, 7, B], 2000, [5000, 8, A]],
    ['the last stamp is ahead: its counter goes up', [5000, 9, A], [4000, 1, B], 2000, [5000, 10, A]],
    ['the wall clock equals it: past its counter', null, [2000, 4, B], 2000, [2000, 5, A]],
    ['nothing seen before, it’s behind', null, [900, 4, B], 2000, [2000, 0, A]],
  ])('%s', (_what, last, remote, now, expected) => {
    expect(seenStamp(last, remote, now, A)).toEqual(expected);
  });

  it('so a change made after seeing a stamp from a clock an hour ahead still wins over it', () => {
    const fast: Stamp = [1000 + 3_600_000, 0, B];
    const seen = seenStamp(nextStamp(null, 1000, A), fast, 1500, A);
    const change = nextStamp(seen, 1600, A);
    expect(compareStamps(change, fast)).toBeGreaterThan(0);
  });
});

describe('comparing', () => {
  it.each<[Stamp, Stamp, -1 | 0 | 1]>([
    [[1, 0, A], [2, 0, A], -1],
    [[2, 0, A], [1, 9, A], 1],
    [[2, 1, A], [2, 2, A], -1],
    [[2, 2, A], [2, 2, B], -1],
    [[2, 2, B], [2, 2, A], 1],
    [[2, 2, A], [2, 2, A], 0],
  ])('%j against %j: %d', (a, b, sign) => {
    expect(Math.sign(compareStamps(a, b))).toBe(sign);
  });
});

describe('an export’s stamps', () => {
  it.each<[number, Stamp]>([
    [1764511391204, [1764511391204, 0, A]],
    // A row from before Chord kept the time it changed: older than anything.
    [0, [0, 0, A]],
    [-5, [0, 0, A]],
    [Number.NaN, [0, 0, A]],
  ])('updated_at %d → %j', (updatedAt, stamp) => {
    expect(rowStamp(updatedAt, A)).toEqual(stamp);
  });
});

describe('what a stamp is', () => {
  it.each<[unknown, boolean]>([
    [[1764511391204, 0, A], true],
    [[0, 0, A], true],
    [[1, 1, 'ABCDEFABCDEFABCD'], false],
    [[1, 1, 'aaaa'], false],
    [[-1, 0, A], false],
    [[1.5, 0, A], false],
    [[1, -1, A], false],
    [[1, 0], false],
    ['1,0,a', false],
    [null, false],
  ])('%j: %s', (value, ok) => {
    expect(isStamp(value)).toBe(ok);
  });

  it('a new device id is 64 random bits, as hex', () => {
    const ids = new Set(Array.from({ length: 50 }, newDeviceId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isDeviceId(id)).toBe(true);
  });
});
