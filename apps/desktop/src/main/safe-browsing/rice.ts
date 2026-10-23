/**
 * Golomb-Rice delta coding of 32-bit values, as Safe Browsing v5 sends hash
 * prefixes and removal indices (developers.google.com/safe-browsing/reference/Local.Database,
 * "Decoding the List Content"). The values are sorted; the first is sent as is,
 * then each difference is split by the Rice parameter k into a quotient (in
 * unary: q ones, then a zero) and a k-bit remainder. Bits are read from the
 * least significant end of each byte, bytes in order.
 */

/** One RiceDeltaEncoded32Bit message. */
export interface Rice32 {
  firstValue: number;
  riceParameter: number;
  /** How many differences follow `firstValue`: the values are entriesCount + 1. */
  entriesCount: number;
  encodedData: Uint8Array;
}

export class RiceError extends Error {}

/** The values, ascending. Throws RiceError on data that's short, out of range or not increasing. */
export function decodeRice32(rice: Rice32, { strict = false } = {}): Uint32Array {
  const { firstValue, riceParameter: k, entriesCount: count, encodedData: data } = rice;
  if (!Number.isInteger(firstValue) || firstValue < 0 || firstValue > 0xffffffff) throw new RiceError('first value out of range');
  if (!Number.isInteger(count) || count < 0) throw new RiceError('bad entry count');
  const out = new Uint32Array(count + 1);
  out[0] = firstValue;
  if (count === 0) return out;
  if (!Number.isInteger(k) || k < 1 || k > 31) throw new RiceError('bad Rice parameter');
  const totalBits = data.length * 8;
  // Each value takes at least 1 + k bits: a count the data can't hold is refused before reading.
  if (count * (k + 1) > totalBits) throw new RiceError('too few bits for the entry count');
  const scale = 2 ** k;
  let bit = 0;
  let value = firstValue;
  for (let i = 1; i <= count; i++) {
    let quotient = 0;
    for (;;) {
      if (bit >= totalBits) throw new RiceError('ran out of bits');
      const b = (data[bit >> 3]! >> (bit & 7)) & 1;
      bit++;
      if (b === 0) break;
      quotient++;
    }
    if (bit + k > totalBits) throw new RiceError('ran out of bits');
    // The remainder, up to a byte at a time (lists hold millions of values).
    let remainder = 0;
    for (let got = 0; got < k; ) {
      const offset = bit & 7;
      const take = Math.min(8 - offset, k - got);
      remainder += ((data[bit >> 3]! >> offset) & ((1 << take) - 1)) * 2 ** got;
      got += take;
      bit += take;
    }
    const delta = quotient * scale + remainder;
    if (strict && delta === 0) throw new RiceError('values repeat');
    value += delta;
    if (value > 0xffffffff) throw new RiceError('value out of range');
    out[i] = value;
  }
  return out;
}

/** The reverse, for tests and the stand-in server: `values` ascending. */
export function encodeRice32(values: ArrayLike<number>, riceParameter: number): Rice32 {
  if (values.length === 0) return { firstValue: 0, riceParameter, entriesCount: 0, encodedData: new Uint8Array(0) };
  const scale = 2 ** riceParameter;
  let totalBits = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    if (delta < 0) throw new RiceError('values must ascend');
    totalBits += Math.floor(delta / scale) + 1 + riceParameter;
  }
  const data = new Uint8Array(Math.ceil(totalBits / 8));
  let bit = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    const quotient = Math.floor(delta / scale);
    for (let q = 0; q < quotient; q++, bit++) data[bit >> 3]! |= 1 << (bit & 7);
    bit++;
    const remainder = delta % scale;
    for (let j = 0; j < riceParameter; j++, bit++) if (Math.floor(remainder / 2 ** j) % 2) data[bit >> 3]! |= 1 << (bit & 7);
  }
  return { firstValue: values[0]!, riceParameter, entriesCount: values.length - 1, encodedData: data };
}
