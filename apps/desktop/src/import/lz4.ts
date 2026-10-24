/**
 * Firefox's session files (`*.jsonlz4`) are "mozLz4": an 8-byte magic, the
 * decompressed size (32-bit little-endian), then one LZ4 block. LZ4's block
 * format is small enough to read here rather than add a dependency:
 * https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
 */

const MOZ_MAGIC = 'mozLz40\0';
/** Larger than any session file; a header claiming more is a damaged or hostile file. */
const MAX_OUTPUT = 256 * 1024 * 1024;

export class Lz4Error extends Error {}

/** One LZ4 block, decompressed into exactly `size` bytes. */
export function decompressBlock(input: Uint8Array, size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0 || size > MAX_OUTPUT) throw new Lz4Error('bad size');
  const out = new Uint8Array(size);
  let ip = 0;
  let op = 0;
  const byte = () => {
    if (ip >= input.length) throw new Lz4Error('truncated');
    return input[ip++]!;
  };
  /** A length that goes on in 255s past its 4 bits. */
  const extend = (length: number) => {
    if (length !== 15) return length;
    for (let b = 255; b === 255; ) {
      b = byte();
      length += b;
    }
    return length;
  };
  while (ip < input.length) {
    const token = byte();
    const literals = extend(token >> 4);
    if (ip + literals > input.length || op + literals > size) throw new Lz4Error('literals overrun');
    out.set(input.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    // The last sequence is only literals.
    if (ip >= input.length) break;
    const offset = byte() | (byte() << 8);
    if (offset === 0 || offset > op) throw new Lz4Error('bad offset');
    const length = extend(token & 15) + 4;
    if (op + length > size) throw new Lz4Error('match overrun');
    // Byte by byte: a match may overlap what it's writing (a run).
    for (let from = op - offset, end = op + length; op < end; ) out[op++] = out[from++]!;
  }
  if (op !== size) throw new Lz4Error('short output');
  return out;
}

/** A mozLz4 file's contents. */
export function decompressMozLz4(file: Uint8Array): Uint8Array {
  if (file.length < 12 || Buffer.from(file.subarray(0, 8)).toString('latin1') !== MOZ_MAGIC) throw new Lz4Error('not mozLz4');
  const size = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(8, true);
  return decompressBlock(file.subarray(12), size);
}
