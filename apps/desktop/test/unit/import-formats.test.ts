import { describe, expect, it } from 'vitest';
import { decompressBlock, decompressMozLz4, Lz4Error } from '../../src/import/lz4';
import { parseBinaryPlist, PlistError } from '../../src/import/plist';
import { binaryPlist, compressLz4Block, mozLz4 } from '../fixtures/browsers';

describe('LZ4 blocks', () => {
  it('reads literals, back-references and overlapping runs', () => {
    // "abc" as literals, then a 9-byte match 3 back (a run that overlaps itself), then "xyz" as the last literals.
    const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x30, 0x78, 0x79, 0x7a]);
    expect(Buffer.from(decompressBlock(block, 15)).toString()).toBe('abcabcabcabcxyz');
  });

  it('reads long lengths, and what a real compressor writes', () => {
    const text = `${'chord '.repeat(400)}${Array.from({ length: 300 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')}`;
    const data = Buffer.from(text);
    const block = compressLz4Block(data);
    expect(block.length).toBeLessThan(data.length / 2);
    expect(Buffer.from(decompressBlock(block, data.length)).toString()).toBe(text);
    expect(Buffer.from(decompressMozLz4(mozLz4(text))).toString()).toBe(text);
  });

  it('refuses damaged or hostile input instead of reading past it', () => {
    expect(() => decompressBlock(Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x09, 0x00, 0x30]), 12)).toThrow(Lz4Error); // offset before the start
    expect(() => decompressBlock(Uint8Array.from([0xf0]), 20)).toThrow(Lz4Error); // a length that never ends
    expect(() => decompressBlock(Uint8Array.from([0x30, 0x61, 0x62, 0x63]), 2)).toThrow(Lz4Error); // more than it says
    expect(() => decompressBlock(Uint8Array.from([0x10, 0x61]), 4)).toThrow(Lz4Error); // less than it says
    expect(() => decompressMozLz4(Buffer.from('mozLz40\0\xff\xff\xff\xff', 'latin1'))).toThrow(Lz4Error);
    expect(() => decompressMozLz4(Buffer.from('{"windows":[]}'))).toThrow(Lz4Error);
  });
});

describe('binary plists', () => {
  it('reads dictionaries, arrays, ASCII and UTF-16 strings, numbers and booleans', () => {
    const value = { Title: 'BookmarksBar', Children: [{ URLString: 'https://a.test/', title: 'Café ☕ Señor' }], Count: 70_000, Big: 2 ** 40, Yes: true, No: false };
    expect(parseBinaryPlist(binaryPlist(value))).toEqual(value);
  });

  it('reads long arrays and strings, whose lengths follow the marker', () => {
    const value = { Items: Array.from({ length: 300 }, (_, i) => `https://site${i}.test/${'x'.repeat(i % 20)}`) };
    expect(parseBinaryPlist(binaryPlist(value))).toEqual(value);
  });

  it('refuses what isn’t a binary plist, a damaged one, and references in circles', () => {
    expect(() => parseBinaryPlist(Buffer.from('<?xml version="1.0"?><plist></plist>'.padEnd(64)))).toThrow(PlistError);
    const good = Buffer.from(binaryPlist({ a: ['b'] }));
    const cut = good.subarray(0, good.length - 8);
    expect(() => parseBinaryPlist(cut)).toThrow(PlistError);
    // An array whose only member is itself.
    const loop = Buffer.concat([Buffer.from('bplist00', 'latin1'), Buffer.from([0xa1, 0x00, 0x00]), Buffer.alloc(0)]);
    const table = Buffer.from([0, 0, 0, 8]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 4;
    trailer[7] = 2;
    trailer.writeBigUInt64BE(1n, 8);
    trailer.writeBigUInt64BE(0n, 16);
    trailer.writeBigUInt64BE(BigInt(loop.length), 24);
    expect(() => parseBinaryPlist(Buffer.concat([loop, table, trailer]))).toThrow(PlistError);
  });

  it('never lets a key named __proto__ reach an object’s prototype', () => {
    const parsed = parseBinaryPlist(binaryPlist({ __proto__x: 'ok', nested: { a: 'b' } })) as Record<string, unknown>;
    expect(parsed['__proto__x']).toBe('ok');
    const sneaky = Buffer.from(binaryPlist({ AAAAAAAAA: { polluted: true } }));
    sneaky.write('__proto__', sneaky.indexOf('AAAAAAAAA'), 'latin1');
    const value = parseBinaryPlist(sneaky) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
