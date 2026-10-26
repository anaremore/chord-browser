/**
 * Your data's plain files and passphrases (S15 §2–§3). The encrypted envelope
 * needs a crypto library, so its table runs with Node's in
 * packages/data/test/container.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DATA_FORMAT_ABOUT,
  dataHeader,
  MAX_LINE,
  normalizePassphrase,
  PASSPHRASE_WORDS,
  passphraseProblem,
  plainWriter,
  readDataFile,
  recordLine,
  suggestPassphrase,
  type DataCrypto,
  type DataRecord,
} from '../src';

// Core compiles without DOM types; these are globals in Node and every browser.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

/** A plain file never needs crypto: anything that asks fails the test. */
const none = new Proxy({} as DataCrypto, {
  get: () => () => {
    throw new Error('a plain file used crypto');
  },
});
const DEVICE = '9f2c4e1a7b3d5c60';
const header = dataHeader({ app: '0.5.0', device: DEVICE, created: Date.UTC(2026, 10, 30, 14, 3, 11, 204), includes: ['setup', 'today', 'history', 'duet'] });
const records: DataRecord[] = [
  { type: 'chord', id: 'c1', at: [1, 0, DEVICE], set: { name: 'Work' } },
  { type: 'tab', id: 't1', at: [2, 0, DEVICE], set: { url: 'https://a.test/', title: 'Line\nbreak and “quotes”' } },
  { type: 'page', id: 'https://a.test/', set: { title: 'A', visits: [1, 2], typed: 0 } },
];

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function plainFile(rs: readonly DataRecord[] = records): string {
  const writer = plainWriter(header);
  return [writer.head, ...rs.flatMap((r) => writer.add(r)), ...writer.end()].map(text).join('');
}

describe('a plain file', () => {
  it('is a header line, a line per record, and the end, each ending in \\n', () => {
    const lines = plainFile().split('\n');
    expect(lines[0]).toBe(
      `{"chord":"data","format":1,"kind":"export","app":"0.5.0","device":"${DEVICE}","created":"2026-11-30T14:03:11.204Z","includes":["setup","today","history","duet"],"about":"${DATA_FORMAT_ABOUT}"}`,
    );
    expect(lines[1]).toBe(`{"type":"chord","id":"c1","at":[1,0,"${DEVICE}"],"set":{"name":"Work"}}`);
    expect(lines[3]).toBe('{"type":"page","id":"https://a.test/","set":{"title":"A","visits":[1,2],"typed":0}}');
    expect(lines.slice(4)).toEqual(['{"end":3}', '']);
  });

  it('a record’s keys go in one order, and a fact has no stamp', () => {
    expect(recordLine({ set: {}, id: 'x', type: 'icon' } as DataRecord)).toBe('{"type":"icon","id":"x","set":{}}\n');
  });

  it('reads back whole', async () => {
    const read = await readDataFile(utf8.encode(plainFile()), null, none);
    expect(read).toEqual({ header, encrypted: false, records, problem: null });
  });

  it.each<[string, (file: string) => string, string | null, number]>([
    ['whole', (f) => f, null, 3],
    // \r is JSON's whitespace, so a file an editor saved with Windows line endings still reads.
    ['with \\r\\n line endings from an editor', (f) => f.replaceAll('\n', '\r\n'), null, 3],
    ['cut off before its end', (f) => f.split('\n').slice(0, 3).join('\n'), 'cut-short', 2],
    ['cut off mid-line', (f) => f.slice(0, f.indexOf('"page"') + 10), 'damaged', 2],
    ['a line that isn’t JSON', (f) => f.replace('{"type":"tab"', '{"type":tab'), 'damaged', 2],
    ['a line that isn’t a record', (f) => f.replace('{"type":"tab","id":"t1",', '{"kind":"tab","id":"t1",'), 'damaged', 2],
    ['the end counting more than there are', (f) => f.replace('{"end":3}', '{"end":4}'), 'damaged', 3],
    ['something after the end', (f) => `${f}{"type":"chord","id":"c2","set":{}}\n`, 'damaged', 3],
    ['a newer Chord’s record type', (f) => f.replace('{"end":3}', '{"type":"reading-list","id":"r","set":{}}\n{"end":4}'), null, 4],
    // Format 1 grows by additions, the end line too.
    ['an end line with more in it', (f) => f.replace('{"end":3}', '{"end":3,"digest":"…"}'), null, 3],
  ])('%s', async (_what, change, problem, count) => {
    const read = await readDataFile(utf8.encode(change(plainFile())), null, none);
    expect(read.problem).toBe(problem);
    expect(read.records).toHaveLength(count);
  });

  it('leaves out a record longer than a reader takes (32 MB), and counts it, so the file still reads whole', async () => {
    const huge: DataRecord = { type: 'image', id: 'abcdefabcdefabcdefabcdef', set: { data: 'A'.repeat(MAX_LINE) } };
    const writer = plainWriter(header);
    const file = [writer.head, ...[records[0]!, huge, records[1]!].flatMap((r) => writer.add(r)), ...writer.end()].map(text).join('');
    expect(writer.skipped).toBe(1);
    const read = await readDataFile(utf8.encode(file), null, none);
    expect(read.problem).toBeNull();
    expect(read.records).toEqual([records[0], records[1]]);
  });

  it.each<[string, string, string]>([
    ['a newer format', plainFile().replace('"format":1', '"format":2'), 'newer'],
    ['another JSON file', '{"name":"package"}\n', 'not-chord'],
    ['a text file', 'Dear diary\n', 'not-chord'],
    ['nothing', '', 'not-chord'],
  ])('refuses %s', async (_what, file, problem) => {
    const read = await readDataFile(utf8.encode(file), null, none);
    expect(read.problem).toBe(problem);
    expect(read.records).toEqual([]);
  });
});

describe('passphrases', () => {
  it.each<[string, string | null]>([
    ['', 'At least 12 characters.'],
    ['short words', 'At least 12 characters.'],
    ['twelve chars', null],
    ['five words from the list', null],
    // Counted as characters, not bytes or UTF-16 units: 12 emoji are 12.
    ['🎹'.repeat(11), 'At least 12 characters.'],
    ['🎹'.repeat(12), null],
    ['x'.repeat(1025), 'At most 1024 characters.'],
  ])('%j → %j', (passphrase, problem) => {
    expect(passphraseProblem(passphrase)).toBe(problem);
  });

  it('is the same however its accents were typed', () => {
    expect(normalizePassphrase('café au lait')).toBe(normalizePassphrase('café au lait'));
  });

  it('Suggest one: five words from the list, each at random', () => {
    const words = new Set(PASSPHRASE_WORDS);
    const suggestions = Array.from({ length: 20 }, () => suggestPassphrase());
    for (const suggestion of suggestions) {
      const parts = suggestion.split(' ');
      expect(parts).toHaveLength(5);
      expect(parts.every((w) => words.has(w))).toBe(true);
      expect(passphraseProblem(suggestion)).toBeNull();
    }
    expect(new Set(suggestions).size).toBe(20);
  });

  it('draws again past the last whole multiple of the list, so no word is likelier', () => {
    const n = PASSPHRASE_WORDS.length;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    // Values at or past the limit are drawn again; then 0 is the first word, n + 1 the second.
    const values = [limit, 0xffff_ffff, 0, n + 1, 2 * n + 2, 3, 4];
    expect(suggestPassphrase(() => values.shift()!).split(' ')).toEqual([PASSPHRASE_WORDS[0], PASSPHRASE_WORDS[1], PASSPHRASE_WORDS[2], PASSPHRASE_WORDS[3], PASSPHRASE_WORDS[4]]);
  });

  it('the list: over 1,700 words, lowercase, each once', () => {
    expect(PASSPHRASE_WORDS.length).toBeGreaterThan(1700);
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length);
    expect(PASSPHRASE_WORDS.every((w) => /^[a-z]{3,12}$/.test(w))).toBe(true);
  });
});
