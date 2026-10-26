/**
 * Stamps for Your data's records (docs/decisions/S15-your-data.md §4): a
 * hybrid logical clock, `[wall ms, counter, device]`, compared in that order.
 * Merging keeps each field's highest stamp. An export, which runs without
 * sync, stamps each record from its row's `updated_at` (`rowStamp`); sync
 * keeps a clock of its own with `nextStamp` and `seenStamp`.
 *
 * Whether a stamp is one depends only on the stamp, never on the clock of the
 * computer reading it, so every computer takes or refuses the same ones (S15
 * §4, §13). Its parts stay well inside what any reader counts: past the
 * counter's top, the clock steps on a millisecond.
 */

// Core compiles without DOM types; Web Crypto is a global in Node and every browser.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** When, by how many changes within that millisecond, and on which computer. */
export type Stamp = readonly [ms: number, counter: number, device: string];

/** A computer's id: 64 random bits, as 16 hex digits. Made once, kept in chord-data, never exported as data. */
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Changes within one millisecond: far more than any computer makes. Past it, the clock moves on a millisecond. */
export const MAX_COUNTER = 0xffff;
/** The end of the year 9999: no stamp is later, whoever wrote it. */
export const MAX_STAMP_MS = 253_402_300_799_999;
/**
 * How far past this computer's wall clock another computer's stamp may move
 * its clock (`seenStamp`). A stamp further ahead is still taken, but the
 * clock stays near the time; an edit made here still beats the value it
 * replaces, since it's stamped above that value's stamp (`stampAbove`).
 */
export const CLOCK_DRIFT_MS = 60_000;

export function isStamp(value: unknown): value is Stamp {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [ms, counter, device] = value as unknown[];
  return (
    Number.isSafeInteger(ms) && (ms as number) >= 0 && (ms as number) <= MAX_STAMP_MS && Number.isInteger(counter) && (counter as number) >= 0 && (counter as number) <= MAX_COUNTER && isDeviceId(device)
  );
}

/** Negative when `a` is older: milliseconds first, then the counter, then the device (any fixed order would do). */
export function compareStamps(a: Stamp, b: Stamp): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** A millisecond and a counter, the counter carried into the next millisecond past its top; never past MAX_STAMP_MS. */
function step(ms: number, counter: number, device: string): Stamp {
  if (counter <= MAX_COUNTER) return [ms, counter, device];
  return ms < MAX_STAMP_MS ? [ms + 1, 0, device] : [MAX_STAMP_MS, MAX_COUNTER, device];
}

/**
 * A new stamp for a change made here: the wall clock if it's past the last
 * stamp seen, otherwise the last stamp's milliseconds with the counter one
 * up. So a clock set back never makes a change look older than one it saw.
 */
export function nextStamp(last: Stamp | null, now: number, device: string): Stamp {
  const wall = Math.min(MAX_STAMP_MS, Math.max(0, Math.floor(now)));
  if (!last || wall > last[0]) return [wall, 0, device];
  return step(last[0], last[1] + 1, device);
}

/**
 * The stamp just above `stamp`, from `device`: what a change made here gets
 * when the value it replaces has a stamp ahead of this computer's clock (the
 * other computer's clock was wrong), so the change still wins.
 */
export function stampAbove(stamp: Stamp, device: string): Stamp {
  return step(stamp[0], stamp[1] + 1, device);
}

/**
 * The clock after reading another computer's stamp: not behind it, so the
 * next change made here wins over it, but never more than CLOCK_DRIFT_MS past
 * this computer's wall clock. One computer with a wrong clock doesn't carry
 * every other one's clock with it; `stampAbove` covers what's further ahead.
 */
export function seenStamp(last: Stamp | null, remote: Stamp, now: number, device: string): Stamp {
  const wall = Math.min(MAX_STAMP_MS, Math.max(0, Math.floor(now)));
  const bound = Math.min(MAX_STAMP_MS, wall + CLOCK_DRIFT_MS);
  const seen: Stamp = remote[0] > bound ? [bound, 0, remote[2]] : remote;
  const ms = Math.max(wall, last?.[0] ?? 0, seen[0]);
  if (ms === wall && ms !== (last?.[0] ?? -1) && ms !== seen[0]) return [ms, 0, device];
  const counter = Math.max(last && last[0] === ms ? last[1] : -1, seen[0] === ms ? seen[1] : -1) + 1;
  return step(ms, counter, device);
}

/**
 * An export's stamp for a row, from when it was last changed (`updated_at`).
 * 0 is a row from before Chord kept that time: older than anything.
 */
export function rowStamp(updatedAt: number, device: string): Stamp {
  return [Number.isSafeInteger(updatedAt) && updatedAt > 0 ? Math.min(updatedAt, MAX_STAMP_MS) : 0, 0, device];
}
