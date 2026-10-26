/**
 * Your data's encrypted files (S15 §3; core's data-file.ts) with Node's
 * crypto, as the export process uses it: the right and a wrong passphrase,
 * and every way a file can be changed, cut or misread.
 */
import { describe, expect, it } from 'vitest';
import { dataHeader, encryptedWriter, plainWriter, readDataFile, SCRYPT, type DataRecord, type DataFileWriter, type ScryptParams } from '@chord/core';
import { nodeCrypto } from '../src/crypto';

const DEVICE = '9f2c4e1a7b3d5c60';
const PASSPHRASE = 'harbor tulip velvet orbit lemon';
/** Fast keys for the table; S15's own parameters get a test of their own. */
const QUICK: ScryptParams = { N: 2 ** 10, r: 8, p: 1 };
const header = dataHeader({ app: '0.5.0', device: DEVICE, created: Date.UTC(2026, 10, 30), includes: ['setup', 'history'] });
/** Enough to fill several frames (about 256 KB of lines each). */
const records: DataRecord[] = Array.from({ length: 3000 }, (_, i) => ({
  type: 'page',
  id: `https://news.test/story/${i}`,
  set: { title: `Story ${i}: ${'a long and varied headline '.repeat(1 + (i % 7))}`, visits: Array.from({ length: 1 + (i % 9) }, (_, v) => 1_700_000_000_000 + i * 1000 + v), typed: i % 3 },
}));

const write = (writer: DataFileWriter, rs: readonly DataRecord[] = records): Uint8Array => Buffer.concat([writer.head, ...rs.flatMap((r) => writer.add(r)), ...writer.end()]);
const encrypted = async (params = QUICK, rs: readonly DataRecord[] = records) => write(await encryptedWriter(header, PASSPHRASE, nodeCrypto, params), rs);

/** An encrypted file's readable lines, and its frames (each with its 4-byte length). */
function parts(file: Uint8Array): { head: Uint8Array; frames: Uint8Array[] } {
  const headerEnd = file.indexOf(0x0a, file.indexOf(0x0a) + 1) + 1;
  const frames: Uint8Array[] = [];
  for (let at = headerEnd; at < file.length; ) {
    const length = Buffer.from(file.buffer, file.byteOffset + at, 4).readUInt32BE(0);
    frames.push(file.subarray(at, at + 4 + length));
    at += 4 + length;
  }
  return { head: file.subarray(0, headerEnd), frames };
}
const join = (head: Uint8Array, frames: readonly Uint8Array[]) => Buffer.concat([head, ...frames]);
/** How many records the first `n` frames hold: the file cut short after them reads just those. */
async function before(file: Uint8Array, n: number): Promise<number> {
  const { head, frames } = parts(file);
  const read = await readDataFile(join(head, frames.slice(0, n)), PASSPHRASE, nodeCrypto);
  return n < frames.length ? read.records.length : records.length;
}
const frameCount = (file: Uint8Array) => parts(file).frames.length;

describe('an encrypted file', () => {
  it('reads with its passphrase exactly as the plain file does', async () => {
    const file = await encrypted();
    const plain = write(plainWriter(header));
    const read = await readDataFile(file, PASSPHRASE, nodeCrypto);
    expect(read.problem).toBeNull();
    expect(read.encrypted).toBe(true);
    expect(read.header).toEqual(header);
    expect(read.records).toEqual(records);
    expect(read.records).toEqual((await readDataFile(plain, null, nodeCrypto)).records);
    expect(parts(file).frames.length).toBeGreaterThan(2);
  });

  it('starts with two lines a person can read, and holds nothing else in the clear', async () => {
    const file = await encrypted();
    const [first, second] = Buffer.from(file).toString('latin1').split('\n');
    expect(first).toBe('chord-encrypted 1');
    const sealed = JSON.parse(second!) as Record<string, unknown>;
    expect(sealed).toMatchObject({ ...header, kdf: { name: 'scrypt', N: QUICK.N, r: 8, p: 1 } });
    expect(Object.keys(sealed)).toEqual([...Object.keys(header), 'kdf', 'salt', 'check']);
    expect(Buffer.from(file).includes('news.test')).toBe(false);
    expect(Buffer.from(file).includes(PASSPHRASE)).toBe(false);
  });

  it('is deflated: smaller than the plain file', async () => {
    expect((await encrypted()).length).toBeLessThan(write(plainWriter(header)).length / 2);
  });

  it('uses a new salt and nonce every time', async () => {
    const [a, b] = [await encrypted(), await encrypted()];
    const header = (file: Uint8Array) => JSON.parse(Buffer.from(file).toString('latin1').split('\n')[1]!) as { salt: string; kdf: { salt: string }; check: string };
    expect(header(a).salt).not.toBe(header(b).salt);
    expect(header(a).kdf.salt).not.toBe(header(b).kdf.salt);
    const nonces = [...parts(a).frames, ...parts(b).frames].map((f) => Buffer.from(f.subarray(4, 16)).toString('hex'));
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('opens however the passphrase’s accents were typed', async () => {
    const file = write(await encryptedWriter(header, 'café au lait, s’il vous plaît', nodeCrypto, QUICK));
    expect((await readDataFile(file, 'café au lait, s’il vous plaît', nodeCrypto)).problem).toBeNull();
  });

  it('with S15’s own key derivation (scrypt N=2^17): 128 MiB, which Node’s default limit would refuse', async () => {
    const file = await encrypted(SCRYPT, records.slice(0, 3));
    const read = await readDataFile(file, PASSPHRASE, nodeCrypto);
    expect(read.records).toEqual(records.slice(0, 3));
    expect(JSON.parse(Buffer.from(file).toString('latin1').split('\n')[1]!).kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 });
  }, 20_000);
});

describe('what goes wrong', () => {
  /** Each case changes a good file; `readable` is how many records still come out. */
  it.each<[string, (file: Uint8Array) => Uint8Array, string | null, (file: Uint8Array) => Promise<number>]>([
    ['nothing', (f) => f, null, async () => records.length],
    [
      'a byte flipped in the header',
      (f) => Buffer.from(Buffer.from(f).toString('latin1').replace('"created":"2026-11-30', '"created":"2026-11-31'), 'latin1'),
      'damaged',
      async () => 0,
    ],
    [
      'a byte flipped in a frame',
      (f) => {
        const { head, frames } = parts(f);
        const bad = Buffer.from(frames[1]!);
        bad[40]! ^= 0x01;
        return join(head, [frames[0]!, bad, ...frames.slice(2)]);
      },
      'damaged',
      // The frames around it still read: each is sealed on its own, a whole line each.
      async (f) => (await before(f, 1)) + records.length - (await before(f, 2)),
    ],
    [
      'two frames swapped',
      (f) => {
        const { head, frames } = parts(f);
        return join(head, [frames[1]!, frames[0]!, ...frames.slice(2)]);
      },
      'damaged',
      async (f) => records.length - (await before(f, 2)),
    ],
    [
      'a frame dropped from the middle',
      (f) => {
        const { head, frames } = parts(f);
        return join(head, [frames[0]!, ...frames.slice(2)]);
      },
      'damaged',
      // Every frame after it now sits at the wrong index.
      (f) => before(f, 1),
    ],
    [
      'the last frame missing',
      (f) => {
        const { head, frames } = parts(f);
        return join(head, frames.slice(0, -1));
      },
      'cut-short',
      (f) => before(f, frameCount(f) - 1),
    ],
    ['cut off in the middle of the last frame', (f) => f.subarray(0, f.length - 100), 'cut-short', (f) => before(f, frameCount(f) - 1)],
    [
      'cut off inside the last frame’s length',
      (f) => {
        const { head, frames } = parts(f);
        return join(head, [...frames.slice(0, -1), frames.at(-1)!.subarray(0, 2)]);
      },
      'cut-short',
      (f) => before(f, frameCount(f) - 1),
    ],
    ['two stray bytes after the last frame', (f) => Buffer.concat([f, Buffer.from([0, 0])]), 'damaged', async () => records.length],
    ['a frame after the last one', (f) => Buffer.concat([f, parts(f).frames[0]!]), 'damaged', async () => records.length],
    [
      'a frame’s length made enormous',
      (f) => {
        const { head, frames } = parts(f);
        const bad = Buffer.from(frames[1]!);
        bad.writeUInt32BE(0x7fff_ffff, 0);
        return join(head, [frames[0]!, bad, ...frames.slice(2)]);
      },
      'damaged',
      (f) => before(f, 1),
    ],
  ])('%s', async (_what, change, problem, readable) => {
    const good = await encrypted();
    const read = await readDataFile(change(good), PASSPHRASE, nodeCrypto);
    expect(read.problem).toBe(problem);
    expect(read.records).toHaveLength(await readable(good));
    // What's read is the file's own records, in its order, never anything else.
    const ids = new Set(records.map((r) => r.id));
    expect(read.records.every((r) => ids.has(r.id))).toBe(true);
  });

  it('a wrong passphrase, told apart from damage before any data is read', async () => {
    const read = await readDataFile(await encrypted(), 'harbor tulip velvet orbit lime', nodeCrypto);
    expect(read).toMatchObject({ problem: 'wrong-passphrase', records: [], encrypted: true, header });
  });

  it('no passphrase: the header says what it is, and nothing else is read', async () => {
    const read = await readDataFile(await encrypted(), null, nodeCrypto);
    expect(read).toMatchObject({ problem: 'needs-passphrase', records: [], encrypted: true, header });
  });

  it.each<[string, (head: string) => string]>([
    ['a newer format', (h) => h.replace('"format":1', '"format":2')],
    ['a newer envelope', (h) => h.replace('chord-encrypted 1', 'chord-encrypted 2')],
    ['an unknown key derivation', (h) => h.replace('"name":"scrypt"', '"name":"argon2id"')],
    ['a key derivation costlier than Chord allows', (h) => h.replace(`"N":${QUICK.N}`, `"N":${2 ** 22}`)],
    // scrypt itself needs N < 2^(16·r): Node would throw on these.
    ['a key derivation scrypt won’t run', (h) => h.replace(`"N":${QUICK.N},"r":8`, `"N":${2 ** 16},"r":1`)],
  ])('refuses %s as a newer Chord’s', async (_what, change) => {
    const file = await encrypted();
    const { head, frames } = parts(file);
    const read = await readDataFile(join(Buffer.from(change(Buffer.from(head).toString('latin1')), 'latin1'), frames), PASSPHRASE, nodeCrypto);
    expect(read.problem).toBe('newer');
    expect(read.records).toEqual([]);
  });

  it.each<[string, (head: string) => string, string]>([
    ['a header that isn’t JSON', (h) => h.replace('{"chord"', '{chord'), 'damaged'],
    ['a key check cut short', (h) => h.replace(/"check":"([^"]{8})[^"]*"/, '"check":"$1"'), 'damaged'],
    ['a key check changed', (h) => h.replace(/"check":"(.)/, (_m, c: string) => `"check":"${c === 'A' ? 'B' : 'A'}`), 'wrong-passphrase'],
  ])('%s', async (_what, change, problem) => {
    const { head, frames } = parts(await encrypted());
    const read = await readDataFile(join(Buffer.from(change(Buffer.from(head).toString('latin1')), 'latin1'), frames), PASSPHRASE, nodeCrypto);
    expect(read.problem).toBe(problem);
  });
});
