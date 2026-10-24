/**
 * Safari's Bookmarks.plist is a binary property list ("bplist00"). The format
 * is small and stable, so it's read here rather than through a dependency.
 * The layout follows CFBinaryPList.c: objects, an offset table, and a 32-byte
 * trailer saying where everything is.
 */

export type PlistValue = null | boolean | number | string | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

export class PlistError extends Error {}

/** Seconds between the Unix epoch and Apple's (2001-01-01). */
const APPLE_EPOCH_S = 978_307_200;
/** Nesting deeper than any bookmarks file; a cycle or a hostile file stops here. */
const MAX_DEPTH = 256;
/** Objects read at most: shared references can't make a small file expand without end. */
const MAX_READS = 4_000_000;

/** A binary plist's top object. Dates come back as Unix milliseconds. */
export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40 || Buffer.from(bytes.subarray(0, 8)).toString('latin1') !== 'bplist00') throw new PlistError('not a binary plist');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6]!;
  const refSize = bytes[trailer + 7]!;
  const count = Number(view.getBigUint64(trailer + 8));
  const top = Number(view.getBigUint64(trailer + 16));
  const tableAt = Number(view.getBigUint64(trailer + 24));
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8 || top >= count || tableAt + count * offsetSize > trailer) throw new PlistError('bad trailer');

  /** An unsigned big-endian integer of `size` bytes. */
  const uint = (at: number, size: number): number => {
    if (at + size > bytes.length) throw new PlistError('out of range');
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i]!;
    return n;
  };
  const offsetOf = (ref: number) => {
    if (ref >= count) throw new PlistError('bad reference');
    return uint(tableAt + ref * offsetSize, offsetSize);
  };

  let reads = 0;
  const read = (ref: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH || ++reads > MAX_READS) throw new PlistError('too deep');
    const at = offsetOf(ref);
    if (at >= trailer) throw new PlistError('bad offset');
    const marker = bytes[at]!;
    const type = marker >> 4;
    const info = marker & 15;
    /** A length: the low 4 bits, or an integer object after the marker when they're all set. */
    const length = (): { n: number; start: number } => {
      if (info !== 15) return { n: info, start: at + 1 };
      const intMarker = bytes[at + 1]!;
      if (intMarker >> 4 !== 1) throw new PlistError('bad length');
      const size = 1 << (intMarker & 15);
      return { n: uint(at + 2, size), start: at + 2 + size };
    };
    switch (type) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) return Number(view.getBigInt64(at + 1));
        if (size > 8) return Number(view.getBigInt64(at + 1 + size - 8));
        return uint(at + 1, size);
      }
      case 0x2:
        return info === 2 ? view.getFloat32(at + 1) : view.getFloat64(at + 1);
      case 0x3:
        return Math.round((view.getFloat64(at + 1) + APPLE_EPOCH_S) * 1000);
      case 0x4: {
        const { n, start } = length();
        if (start + n > trailer) throw new PlistError('out of range');
        return bytes.slice(start, start + n);
      }
      case 0x5: {
        const { n, start } = length();
        if (start + n > trailer) throw new PlistError('out of range');
        return Buffer.from(bytes.subarray(start, start + n)).toString('latin1');
      }
      case 0x6: {
        const { n, start } = length();
        if (start + n * 2 > trailer) throw new PlistError('out of range');
        // UTF-16, big-endian.
        return Buffer.from(bytes.subarray(start, start + n * 2)).swap16().toString('utf16le');
      }
      case 0x8:
        return uint(at + 1, info + 1);
      case 0xa:
      case 0xc: {
        const { n, start } = length();
        const items: PlistValue[] = [];
        for (let i = 0; i < n; i++) items.push(read(uint(start + i * refSize, refSize), depth + 1));
        return items;
      }
      case 0xd: {
        const { n, start } = length();
        const dict: { [key: string]: PlistValue } = {};
        for (let i = 0; i < n; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1);
          if (typeof key !== 'string') throw new PlistError('bad key');
          if (key === '__proto__') continue;
          dict[key] = read(uint(start + (n + i) * refSize, refSize), depth + 1);
        }
        return dict;
      }
      default:
        throw new PlistError(`unknown object ${marker.toString(16)}`);
    }
  };
  return read(top, 0);
}
