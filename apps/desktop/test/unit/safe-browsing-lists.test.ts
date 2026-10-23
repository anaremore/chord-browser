/**
 * Safe Browsing's lists and checks (Local List Mode): Rice-delta decoding
 * (Google's worked example), protobuf and JSON answers, full and partial
 * updates with checksums, prefix matching, the full-hash cache and its
 * expiry, what's valid in an answer, and errors coming out SAFE.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksumOf, prefixOf, SafeBrowsingDatabase } from '../../src/main/safe-browsing/database';
import { batchGetFromJson, decodeBatchGet, decodeSearch, encodeBatchGet, encodeSearch, parseDuration, searchFromJson, type HashListUpdate, type SearchAnswer } from '../../src/main/safe-browsing/proto';
import type { CheckResult, DueResult, UpdateResult } from '../../src/main/safe-browsing/protocol';
import { decodeRice32, encodeRice32, RiceError } from '../../src/main/safe-browsing/rice';
import { urlExpressions } from '../../src/main/safe-browsing/url';
import { handle, saved } from '../../src/main/safe-browsing/worker';

const sha = (text: string) => createHash('sha256').update(text).digest();
const prefix = (expression: string) => prefixOf(sha(expression));
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const fullList = (name: string, prefixes: number[], extra: Partial<HashListUpdate> = {}): HashListUpdate => {
  const values = sorted(prefixes);
  return {
    name,
    version: Buffer.from(`${name}-v1`),
    partialUpdate: false,
    additions: values.length > 0 ? encodeRice32(values, 20) : null,
    otherAdditions: false,
    removals: null,
    minimumWaitMs: 30 * 60_000,
    checksum: checksumOf(Uint32Array.from(values)),
    ...extra,
  };
};
const MALWARE = 1;
const SOCIAL_ENGINEERING = 2;
const UNWANTED_SOFTWARE = 3;
const PHA = 4;
const answer = (hashes: { expression: string; threatType: number; attributes?: number[] }[], cacheDurationMs: number | null = 300_000): SearchAnswer => ({
  cacheDurationMs,
  fullHashes: hashes.map((h) => ({ fullHash: sha(h.expression), details: [{ threatType: h.threatType, attributes: h.attributes ?? [] }] })),
});

describe('Rice-delta decoding', () => {
  // developers.google.com/safe-browsing/reference/Local.Database, "Decoding Hashes and Hash Prefixes".
  const example = { firstValue: 489866504, riceParameter: 30, entriesCount: 2, encodedData: Buffer.from('t\x00\xd2\x97\x1b\xedIt\x00', 'latin1') };

  it('decodes Google’s worked example to its three prefixes', () => {
    expect([...decodeRice32(example)]).toEqual([0x1d32c508, 0x291bc542, 0xf7a502e5]);
    // …which are the prefixes of a.example.com/, b.example.com/ and y.example.com/.
    expect(sorted([prefix('a.example.com/'), prefix('b.example.com/'), prefix('y.example.com/')])).toEqual([0x1d32c508, 0x291bc542, 0xf7a502e5]);
  });

  it('encodes them back to exactly Google’s bytes', () => {
    const encoded = encodeRice32([0x1d32c508, 0x291bc542, 0xf7a502e5], 30);
    expect(Buffer.from(encoded.encodedData).toString('latin1')).toBe('t\x00\xd2\x97\x1b\xedIt\x00');
    expect(encoded.firstValue).toBe(489866504);
    expect(encoded.entriesCount).toBe(2);
  });

  it('round-trips random sorted prefixes, and dense removal indices, across Rice parameters', () => {
    const values = sorted(Array.from({ length: 5000 }, () => randomBytes(4).readUInt32BE()));
    for (const k of [12, 18, 20, 25, 30]) expect([...decodeRice32(encodeRice32(values, k))]).toEqual(values);
    const indices = sorted(Array.from({ length: 2000 }, () => Math.floor(Math.random() * 40_000)));
    for (const k of [3, 4, 5]) expect([...decodeRice32(encodeRice32(indices, k), { strict: true })]).toEqual(indices);
  });

  it('decodes a single value with no data', () => {
    expect([...decodeRice32({ firstValue: 7, riceParameter: 0, entriesCount: 0, encodedData: new Uint8Array(0) })]).toEqual([7]);
  });

  it('refuses data that’s short, or a count it can’t hold', () => {
    expect(() => decodeRice32({ ...example, encodedData: example.encodedData.subarray(0, 4) })).toThrow(RiceError);
    expect(() => decodeRice32({ ...example, entriesCount: 1_000_000 })).toThrow(RiceError);
    expect(() => decodeRice32({ ...example, firstValue: 2 ** 32 })).toThrow(RiceError);
  });

  it('refuses values past 32 bits', () => {
    expect(() => decodeRice32(encodeRice32([0xfffffff0, 0xfffffff0 + 0x20], 4))).toThrow(RiceError);
  });
});

describe('the service’s answers', () => {
  it('round-trips a batchGet answer through protobuf', () => {
    const lists = [fullList('se-4b', [1, 5, 9]), { ...fullList('mw-4b', [3]), partialUpdate: true, removals: encodeRice32([0, 2], 5), minimumWaitMs: 1500 }];
    const decoded = decodeBatchGet(encodeBatchGet(lists));
    expect(decoded.map((l) => l.name)).toEqual(['se-4b', 'mw-4b']);
    expect([...decodeRice32(decoded[0]!.additions!)]).toEqual([1, 5, 9]);
    expect(decoded[1]!.partialUpdate).toBe(true);
    expect([...decodeRice32(decoded[1]!.removals!)]).toEqual([0, 2]);
    expect(decoded[1]!.minimumWaitMs).toBe(1500);
    expect(Buffer.from(decoded[0]!.checksum!)).toEqual(Buffer.from(lists[0]!.checksum!));
  });

  it('round-trips a search answer, packed attributes and all', () => {
    const original = answer([{ expression: 'evil.test/', threatType: MALWARE, attributes: [2] }], 300_500);
    const decoded = decodeSearch(encodeSearch(original));
    expect(decoded.cacheDurationMs).toBe(300_500);
    expect(Buffer.from(decoded.fullHashes[0]!.fullHash)).toEqual(sha('evil.test/'));
    expect(decoded.fullHashes[0]!.details).toEqual([{ threatType: MALWARE, attributes: [2] }]);
  });

  it('reads the JSON form too', () => {
    const lists = batchGetFromJson({
      hashLists: [
        {
          name: 'se-4b',
          version: Buffer.from('v9').toString('base64'),
          additionsFourBytes: { firstValue: 489866504, riceParameter: 30, entriesCount: 2, encodedData: Buffer.from('t\x00\xd2\x97\x1b\xedIt\x00', 'latin1').toString('base64') },
          minimumWaitDuration: '1800s',
        },
      ],
    });
    expect([...decodeRice32(lists[0]!.additions!)]).toEqual([0x1d32c508, 0x291bc542, 0xf7a502e5]);
    expect(lists[0]!.minimumWaitMs).toBe(1_800_000);
    const search = searchFromJson({ fullHashes: [{ fullHash: sha('x.test/').toString('base64'), fullHashDetails: [{ threatType: 'SOCIAL_ENGINEERING', attributes: ['FRAME_ONLY'] }] }], cacheDuration: '3.5s' });
    expect(search.cacheDurationMs).toBe(3500);
    expect(search.fullHashes[0]!.details).toEqual([{ threatType: SOCIAL_ENGINEERING, attributes: [2] }]);
    expect(parseDuration('300s')).toBe(300_000);
    expect(parseDuration('soon')).toBeNull();
  });

  it('refuses a truncated message', () => {
    const body = encodeBatchGet([fullList('se-4b', [1, 2, 3])]);
    expect(() => decodeBatchGet(body.subarray(0, body.length - 3))).toThrow();
  });
});

describe('list updates', () => {
  it('takes a full list, and checks it against the service’s checksum', () => {
    const db = new SafeBrowsingDatabase();
    expect(db.apply([fullList('se-4b', [10, 20, 30])], 0)).toEqual([]);
    expect(db.entries).toBe(3);
    expect(db.has(20)).toBe(true);
    expect(db.has(21)).toBe(false);
  });

  it('drops a list whose checksum doesn’t match, so the next update is a full one', () => {
    const db = new SafeBrowsingDatabase();
    db.apply([fullList('se-4b', [10, 20, 30])], 0);
    const failed = db.apply([fullList('se-4b', [10, 20, 31], { checksum: checksumOf(Uint32Array.from([10, 20, 30])) })], 0);
    expect(failed).toEqual(['se-4b']);
    expect(db.entries).toBe(0);
    // No version: the next request asks for the whole list.
    expect(db.due(Number.MAX_SAFE_INTEGER).find((l) => l.name === 'se-4b')!.version).toBeNull();
  });

  it('applies a partial update: removals by index first, then additions', () => {
    const db = new SafeBrowsingDatabase();
    db.apply([fullList('mw-4b', [10, 20, 30, 40])], 0);
    const after = [15, 20, 40, 50];
    const failed = db.apply(
      [
        {
          name: 'mw-4b',
          version: Buffer.from('mw-v2'),
          partialUpdate: true,
          removals: encodeRice32([0, 2], 4),
          additions: encodeRice32([15, 50], 4),
          otherAdditions: false,
          minimumWaitMs: 60_000,
          checksum: checksumOf(Uint32Array.from(after)),
        },
      ],
      0,
    );
    expect(failed).toEqual([]);
    expect(after.every((p) => db.has(p))).toBe(true);
    expect([10, 30].some((p) => db.has(p))).toBe(false);
    expect(Buffer.from(db.due(Number.MAX_SAFE_INTEGER).find((l) => l.name === 'mw-4b')!.version!).toString()).toBe('mw-v2');
  });

  it('refuses a partial update for a list it doesn’t have, or a removal past the end', () => {
    const db = new SafeBrowsingDatabase();
    expect(db.apply([{ ...fullList('uws-4b', [1]), partialUpdate: true }], 0)).toEqual(['uws-4b']);
    db.apply([fullList('uws-4b', [1, 2])], 0);
    expect(db.apply([{ ...fullList('uws-4b', [1, 2]), partialUpdate: true, additions: null, removals: encodeRice32([5], 3), checksum: null }], 0)).toEqual(['uws-4b']);
  });

  it('ignores lists it didn’t ask for, and refuses other prefix lengths', () => {
    const db = new SafeBrowsingDatabase();
    expect(db.apply([fullList('pha-4b', [1])], 0)).toEqual([]);
    expect(db.entries).toBe(0);
    expect(db.apply([{ ...fullList('se-4b', [1]), otherAdditions: true }], 0)).toEqual(['se-4b']);
  });

  it('waits each list’s minimum wait before asking for it again', () => {
    const db = new SafeBrowsingDatabase();
    expect(db.due(0).map((l) => l.name)).toEqual(['se-4b', 'mw-4b', 'uws-4b']);
    db.apply([fullList('se-4b', [1], { minimumWaitMs: 60_000 }), fullList('mw-4b', [2], { minimumWaitMs: 0 })], 1000);
    expect(db.due(1000).map((l) => l.name)).toEqual(['mw-4b', 'uws-4b']);
    expect(db.due(61_000).map((l) => l.name)).toEqual(['se-4b', 'mw-4b', 'uws-4b']);
    expect(db.nextUpdateAt()).toBe(0);
    db.deferAll(500_000);
    expect(db.due(499_999)).toEqual([]);
    expect(db.nextUpdateAt()).toBe(500_000);
  });

  it('saves the lists and reads them back; a damaged list is left out', () => {
    const db = new SafeBrowsingDatabase();
    db.apply([fullList('se-4b', [10, 20, 30]), fullList('mw-4b', [7])], 0);
    const file = db.serialize(1234);
    const back = SafeBrowsingDatabase.parse(file);
    expect(back.entries).toBe(4);
    expect(back.savedAt).toBe(1234);
    expect(back.has(20) && back.has(7)).toBe(true);
    // Flip one prefix byte: that list no longer matches its checksum.
    const damaged = Buffer.from(file);
    damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 0xff, damaged.length - 1);
    const partly = SafeBrowsingDatabase.parse(damaged);
    expect(partly.has(20)).toBe(true);
    expect(partly.has(7)).toBe(false);
    expect(SafeBrowsingDatabase.parse(Buffer.from('not a list')).entries).toBe(0);
  });
});

describe('checking an address', () => {
  const evil = 'http://evil.example/login.html';
  const listed = (expressions: string[]) => {
    const db = new SafeBrowsingDatabase();
    db.apply([fullList('se-4b', expressions.map(prefix)), fullList('mw-4b', [prefix('noise.test/')])], 0);
    return db;
  };

  it('is safe without asking when no prefix is on a list', () => {
    expect(listed(['evil.example/login.html']).check(['https://fine.example/'], 'frame', 0)).toEqual({ verdict: 'safe' });
  });

  it('asks about the listed prefix only, never the address', () => {
    const step = listed(['evil.example/login.html']).check([evil], 'frame', 0);
    expect(step).toEqual({ verdict: 'search', prefixes: [prefix('evil.example/login.html')] });
  });

  it('finds a prefix for any of the address’s expressions (a whole host listed)', () => {
    const step = listed(['evil.example/']).check(['https://www.evil.example/a/b?c=d'], 'frame', 0);
    expect(step).toEqual({ verdict: 'search', prefixes: [prefix('evil.example/')] });
  });

  it('is unsafe only on a full-hash match from an unexpired answer', () => {
    const db = listed(['evil.example/login.html']);
    const asked = [prefix('evil.example/login.html')];
    expect(db.remember(asked, answer([{ expression: 'evil.example/login.html', threatType: SOCIAL_ENGINEERING }], 300_000), 1000)).toBe(true);
    expect(db.check([evil], 'frame', 2000)).toEqual({ verdict: 'unsafe', kind: 'phishing', url: evil });
    // Its path without the query is one of a longer address's expressions.
    expect(db.check(['http://evil.example/login.html?next=1'], 'frame', 2000)).toMatchObject({ verdict: 'unsafe', kind: 'phishing' });
  });

  it('is safe, from the cache and without asking again, when only the prefix matches', () => {
    const db = listed(['evil.example/login.html']);
    const listedHash = sha('evil.example/login.html');
    // Another full hash under the same 4-byte prefix: a different site.
    const other = Buffer.concat([listedHash.subarray(0, 4), randomBytes(28)]);
    db.remember([prefixOf(listedHash)], { cacheDurationMs: 300_000, fullHashes: [{ fullHash: other, details: [{ threatType: MALWARE, attributes: [] }] }] }, 0);
    expect(db.check([evil], 'frame', 1)).toEqual({ verdict: 'safe' });
  });

  it('caches an answer with no full hashes too, and asks again once it expires', () => {
    const db = listed(['evil.example/login.html']);
    const asked = [prefix('evil.example/login.html')];
    db.remember(asked, answer([], 60_000), 0);
    expect(db.check([evil], 'frame', 59_000)).toEqual({ verdict: 'safe' });
    expect(db.cacheSize).toBe(1);
    // Expired: the entry goes and the prefix is asked about again.
    expect(db.check([evil], 'frame', 60_001)).toEqual({ verdict: 'search', prefixes: asked });
    expect(db.cacheSize).toBe(0);
  });

  it('a threat expires with its answer, and is asked about again', () => {
    const db = listed(['evil.example/login.html']);
    const asked = [prefix('evil.example/login.html')];
    db.remember(asked, answer([{ expression: 'evil.example/login.html', threatType: MALWARE }], 1000), 0);
    expect(db.check([evil], 'frame', 1000)).toMatchObject({ verdict: 'unsafe', kind: 'malware' });
    expect(db.check([evil], 'frame', 1001)).toEqual({ verdict: 'search', prefixes: asked });
  });

  it('uses only valid details, for what they’re for', () => {
    const at = (details: { threatType: number; attributes?: number[] }[], purpose: 'frame' | 'download' = 'frame') => {
      const db = listed(['evil.example/login.html']);
      db.remember([prefix('evil.example/login.html')], { cacheDurationMs: 60_000, fullHashes: [{ fullHash: sha('evil.example/login.html'), details: details.map((d) => ({ threatType: d.threatType, attributes: d.attributes ?? [] })) }] }, 0);
      return db.check([evil], purpose, 1);
    };
    // CANARY isn't for enforcement; an unknown type or attribute voids its detail; PHA is Android's.
    expect(at([{ threatType: MALWARE, attributes: [1] }])).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: 9 }])).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: MALWARE, attributes: [7] }])).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: 0 }])).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: PHA }])).toEqual({ verdict: 'safe' });
    // FRAME_ONLY: pages and frames, not downloads. Downloads are checked for malware and unwanted software.
    expect(at([{ threatType: MALWARE, attributes: [2] }])).toMatchObject({ verdict: 'unsafe', kind: 'malware' });
    expect(at([{ threatType: MALWARE, attributes: [2] }], 'download')).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: SOCIAL_ENGINEERING }], 'download')).toEqual({ verdict: 'safe' });
    expect(at([{ threatType: UNWANTED_SOFTWARE }], 'download')).toMatchObject({ verdict: 'unsafe', kind: 'unwanted' });
    // The worst wins.
    expect(at([{ threatType: UNWANTED_SOFTWARE }, { threatType: MALWARE }])).toMatchObject({ kind: 'malware' });
  });

  it('caches nothing from an answer without an expiry (an error: safe)', () => {
    const db = listed(['evil.example/login.html']);
    expect(db.remember([prefix('evil.example/login.html')], answer([{ expression: 'evil.example/login.html', threatType: MALWARE }], null), 0)).toBe(false);
    expect(db.cacheSize).toBe(0);
  });

  it('hashes the redirects and frames it’s given, each on its own', () => {
    const db = listed(['evil.example/login.html']);
    expect(db.check(['https://fine.example/', evil], 'download', 0)).toMatchObject({ verdict: 'search' });
    expect(urlExpressions(evil)).toContain('evil.example/login.html');
  });
});

describe('the worker’s answers', () => {
  it('opens, updates, saves, checks, and comes out SAFE on any error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chord-sb-'));
    const file = join(dir, 'lists.bin');
    await handle({ type: 'open', file });
    expect(((await handle({ type: 'due', now: 0 })) as DueResult).lists.map((l) => l.version)).toEqual([null, null, null]);

    const lists = [fullList('se-4b', [prefix('evil.example/login.html')]), fullList('mw-4b', [prefix('malware.example/')]), fullList('uws-4b', [])];
    const updated = (await handle({ type: 'update', body: encodeBatchGet(lists), json: false, now: 0 })) as UpdateResult;
    expect(updated).toMatchObject({ failed: [], entries: 2, nextUpdateAt: 30 * 60_000 });
    await saved();
    expect(SafeBrowsingDatabase.parse(readFileSync(file)).entries).toBe(2);

    const urls = ['http://evil.example/login.html'];
    const step = (await handle({ type: 'check', urls, purpose: 'frame', now: 1 })) as CheckResult;
    expect(step.verdict).toBe('search');
    expect(step.took).toBeGreaterThanOrEqual(0);
    const prefixes = step.verdict === 'search' ? step.prefixes : [];

    // Network or HTTP error, garbage, or no expiry: SAFE.
    expect(await handle({ type: 'searched', prefixes, body: null, json: false, urls, purpose: 'frame', now: 2 })).toEqual({ verdict: 'safe' });
    expect(await handle({ type: 'searched', prefixes, body: Uint8Array.from([0xff, 0xff]), json: false, urls, purpose: 'frame', now: 2 })).toEqual({ verdict: 'safe' });
    expect(await handle({ type: 'searched', prefixes, body: encodeSearch(answer([{ expression: 'evil.example/login.html', threatType: 2 }], null)), json: false, urls, purpose: 'frame', now: 2 })).toEqual({ verdict: 'safe' });
    // A real answer: unsafe, and then straight from the cache.
    expect(await handle({ type: 'searched', prefixes, body: encodeSearch(answer([{ expression: 'evil.example/login.html', threatType: 2 }])), json: false, urls, purpose: 'frame', now: 3 })).toEqual({ verdict: 'unsafe', kind: 'phishing', url: urls[0] });
    expect(await handle({ type: 'check', urls, purpose: 'frame', now: 4 })).toMatchObject({ verdict: 'unsafe', kind: 'phishing' });
    // Turned off: the cache, which came from browsing, goes.
    await handle({ type: 'forget' });
    expect(await handle({ type: 'check', urls, purpose: 'frame', now: 5 })).toMatchObject({ verdict: 'search' });

    // A garbled update is an error, and the lists stay as they were.
    await expect(handle({ type: 'update', body: Uint8Array.from([0x0a, 0xff]), json: false, now: 6 })).rejects.toThrow();
    expect(((await handle({ type: 'update', body: encodeBatchGet([]), json: false, now: 7 })) as UpdateResult).entries).toBe(2);

    // A damaged file reads as no lists at all (a full update follows).
    writeFileSync(file, 'garbage');
    await handle({ type: 'open', file });
    expect(((await handle({ type: 'due', now: 0 })) as DueResult).lists).toHaveLength(3);
    expect(await handle({ type: 'check', urls, purpose: 'frame', now: 8 })).toMatchObject({ verdict: 'safe' });
  });
});
