/**
 * Stamps for Your data's records (docs/decisions/S15-your-data.md §4): a
 * hybrid logical clock, `[wall ms, counter, device]`, compared in that order.
 * Merging keeps each field's highest stamp. An export, which runs without
 * sync, stamps each record from its row's `updated_at` (`rowStamp`); sync
 * will keep a clock of its own with `nextStamp` and `seenStamp`.
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

/** The counter is a 32-bit count of changes within one millisecond: far more than any computer makes. */
const MAX_COUNTER = 0xffff_ffff;

export function isStamp(value: unknown): value is Stamp {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [ms, counter, device] = value as unknown[];
  return Number.isSafeInteger(ms) && (ms as number) >= 0 && Number.isInteger(counter) && (counter as number) >= 0 && (counter as number) <= MAX_COUNTER && isDeviceId(device);
}

/** Negative when `a` is older: milliseconds first, then the counter, then the device (any fixed order would do). */
export function compareStamps(a: Stamp, b: Stamp): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/**
 * A new stamp for a change made here: the wall clock if it's past the last
 * stamp seen, otherwise the last stamp's milliseconds with the counter one
 * up. So a clock set back never makes a change look older than one it saw.
 */
export function nextStamp(last: Stamp | null, now: number, device: string): Stamp {
  const wall = Math.max(0, Math.floor(now));
  if (!last || wall > last[0]) return [wall, 0, device];
  return [last[0], last[1] + 1, device];
}

/**
 * The clock after reading another computer's stamp: never behind it, so the
 * next change made here wins over it whatever either wall clock says.
 */
export function seenStamp(last: Stamp | null, remote: Stamp, now: number, device: string): Stamp {
  const wall = Math.max(0, Math.floor(now));
  const ms = Math.max(wall, last?.[0] ?? 0, remote[0]);
  if (ms === wall && ms !== (last?.[0] ?? -1) && ms !== remote[0]) return [ms, 0, device];
  const counter = Math.max(last && last[0] === ms ? last[1] : -1, remote[0] === ms ? remote[1] : -1) + 1;
  return [ms, counter, device];
}

/**
 * An export's stamp for a row, from when it was last changed (`updated_at`).
 * 0 is a row from before Chord kept that time: older than anything.
 */
export function rowStamp(updatedAt: number, device: string): Stamp {
  return [Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : 0, 0, device];
}
