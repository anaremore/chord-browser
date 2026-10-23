/**
 * A stand-in for Google's Safe Browsing API v5 (hashLists.batchGet and
 * hashes.search, answering in protobuf as Google does), for E2E tests:
 * development builds point Chord at it with CHORD_SAFE_BROWSING_URL. It
 * records every request, so tests can tell what Chord sent, and when it
 * sent nothing at all.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checksumOf, prefixOf } from '../../src/main/safe-browsing/database';
import { encodeBatchGet, encodeSearch, type HashListUpdate } from '../../src/main/safe-browsing/proto';
import { encodeRice32 } from '../../src/main/safe-browsing/rice';

/** ThreatType numbers, and the list each lives in. */
export const THREAT = { malware: 1, phishing: 2, unwanted: 3 } as const;
const LIST_FOR: Record<number, string> = { 1: 'mw-4b', 2: 'se-4b', 3: 'uws-4b' };

export interface SafeBrowsingRequest {
  path: string;
  params: URLSearchParams;
  headers: IncomingHttpHeaders;
}

export interface FakeSafeBrowsing {
  origin: string;
  requests: SafeBrowsingRequest[];
  /** Put an expression ("host/path") on a list, before Chord downloads the lists. */
  flag(expression: string, threat: number): void;
  close(): Promise<void>;
}

/** A Rice parameter near log2 of the average gap, as the service would pick. */
const riceFor = (count: number) => Math.min(30, Math.max(3, Math.floor(Math.log2(2 ** 32 / Math.max(1, count)))));

/** `noise`: that many random prefixes in the malware list, standing in for the rest of a real one, so lookups run at a real list's size. */
export async function startSafeBrowsingServer({ noise = 0 }: { noise?: number } = {}): Promise<FakeSafeBrowsing> {
  const threats = new Map<string, number>();
  const requests: SafeBrowsingRequest[] = [];
  const noisePrefixes = new Uint32Array(noise);
  const random = randomBytes(noise * 4);
  for (let i = 0; i < noise; i++) noisePrefixes[i] = random.readUInt32BE(i * 4);

  const list = (name: string): HashListUpdate => {
    const values = new Set<number>(name === 'mw-4b' ? noisePrefixes : []);
    for (const [hex, threat] of threats) if (LIST_FOR[threat] === name) values.add(prefixOf(Buffer.from(hex, 'hex')));
    const sorted = Uint32Array.from(values).sort();
    return {
      name,
      version: Buffer.from(`${name}:1`),
      partialUpdate: false,
      additions: sorted.length > 0 ? encodeRice32(sorted, riceFor(sorted.length)) : null,
      otherAdditions: false,
      removals: null,
      minimumWaitMs: 30 * 60_000,
      checksum: checksumOf(sorted),
    };
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    requests.push({ path: url.pathname, params: url.searchParams, headers: req.headers });
    let body: Uint8Array | null = null;
    if (url.pathname === '/v5/hashLists:batchGet') {
      body = encodeBatchGet(url.searchParams.getAll('names').map(list));
    } else if (url.pathname === '/v5/hashes:search') {
      const asked = new Set(url.searchParams.getAll('hashPrefixes').map((p) => Buffer.from(p, 'base64').readUInt32BE(0)));
      const fullHashes = [...threats]
        .map(([hex, threat]) => ({ hash: Buffer.from(hex, 'hex'), threat }))
        .filter(({ hash }) => asked.has(prefixOf(hash)))
        .map(({ hash, threat }) => ({ fullHash: hash, details: [{ threatType: threat, attributes: [] }] }));
      body = encodeSearch({ fullHashes, cacheDurationMs: 300_000 });
    }
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end(Buffer.from(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    flag: (expression, threat) => threats.set(createHash('sha256').update(expression).digest('hex'), threat),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
