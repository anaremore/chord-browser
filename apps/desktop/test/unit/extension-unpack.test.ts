/**
 * Web Store packages are verified and unpacked in a worker thread
 * (main/extensions/unpack-worker.ts), never on main. Every case here runs
 * through that worker, bundled as the app builds it, the way installs and
 * updates do. Main's blocking during a large install is held in
 * extension-unpack.perf.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idFromKey, type ExtractLimits } from '../../src/main/extensions/crx';
import { unpackInWorker, WORKER_STOPPED } from '../../src/main/extensions/unpack';
import { crx3, extensionIdOf, keyPair, sha256Hex, spki, zip } from '../fixtures/crx';
import { buildUnpackWorker } from '../fixtures/extension-worker';

const developer = keyPair('rsa');
const ecDeveloper = keyPair('ec');
const publisher = keyPair('ec');
const stranger = keyPair('rsa');
const publisherKeyHash = sha256Hex(spki(publisher.publicKey));
const id = extensionIdOf(developer.publicKey);
const manifest = (version = '1.0', extra: Record<string, unknown> = {}) => JSON.stringify({ manifest_version: 3, name: 'Fixture', version, ...extra });
const archive = zip({ 'manifest.json': manifest(), 'popup.html': '<p>hi</p>', 'js/a.js': 'a()' });

let dir: string;
let workerPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chord-ext-unpack-'));
  workerPath = await buildUnpackWorker(dir);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

let n = 0;
const dest = () => join(dir, 'Extensions', 'default', id, `case-${n++}`);

interface Case {
  name: string;
  crx: () => Buffer;
  expectedId?: string;
  version?: string;
  limits?: ExtractLimits;
  /** The hash the store announced: the package's own unless a case says otherwise. */
  sha256?: (crx: Buffer) => string | undefined;
  /** The error, or null when it's accepted. */
  error: RegExp | null;
}

const signed = (files: Record<string, string | Buffer>, dev = developer, signers = [dev, publisher]) => crx3(zip(files), dev, signers);

const cases: Case[] = [
  { name: 'a package signed by its developer (RSA) and the publisher', crx: () => crx3(archive, developer, [developer, publisher]), error: null },
  {
    name: 'a package signed by an ECDSA developer key',
    crx: () => crx3(archive, ecDeveloper, [ecDeveloper, publisher]),
    expectedId: extensionIdOf(ecDeveloper.publicKey),
    error: null,
  },
  {
    name: 'a manifest that starts with a byte-order mark',
    crx: () => signed({ 'manifest.json': `\uFEFF${manifest()}` }),
    error: null,
  },
  {
    name: 'a bad signature (one byte changed after signing)',
    crx: () => {
      const crx = crx3(archive, developer, [developer, publisher]);
      crx[crx.length - 40]! ^= 0x01;
      return crx;
    },
    error: /signature/i,
  },
  { name: 'a download that doesn’t match the hash the store announced', crx: () => crx3(archive, developer, [developer, publisher]), sha256: () => sha256Hex('something else'), error: /doesn’t match what the Chrome Web Store described/ },
  { name: 'the announced hash in capitals (as the store sends it)', crx: () => crx3(archive, developer, [developer, publisher]), sha256: (crx) => sha256Hex(crx).toUpperCase(), error: null },
  { name: 'no announced hash (the signatures still hold)', crx: () => crx3(archive, developer, [developer, publisher]), sha256: () => undefined, error: null },
  { name: 'the wrong ID', crx: () => crx3(archive, developer, [developer, publisher]), expectedId: 'a'.repeat(32), error: /not a{32}/ },
  { name: 'no publisher signature', crx: () => crx3(archive, developer, [developer]), error: /Chrome Web Store/ },
  { name: 'no developer signature', crx: () => crx3(archive, developer, [stranger, publisher]), error: /developer/ },
  { name: 'not a CRX', crx: () => Buffer.from('PK\x03\x04 not a crx'), error: /Not a CRX/ },
  { name: 'another version than the store said', crx: () => crx3(archive, developer, [developer, publisher]), version: '2.0', error: /version 1\.0, not 2\.0/ },
  {
    name: 'too big unpacked',
    crx: () => signed({ 'manifest.json': manifest(), 'zeros.bin': Buffer.alloc(1024 * 1024) }),
    limits: { maxFiles: 10, maxBytes: 100_000 },
    error: /too big/,
  },
  {
    name: 'too many entries',
    crx: () => signed({ 'manifest.json': manifest(), a: '1', b: '2' }),
    limits: { maxFiles: 2, maxBytes: 1_000_000 },
    error: /Too many/,
  },
  { name: 'a zip-slip path (../)', crx: () => signed({ 'manifest.json': manifest(), '../../escaped.txt': 'x' }), error: /outside/ },
  { name: 'a zip-slip path (backslashes)', crx: () => signed({ 'manifest.json': manifest(), 'a\\..\\..\\b.txt': 'x' }), error: /Bad file name/ },
  { name: 'no manifest', crx: () => signed({ 'popup.html': '<p>hi</p>' }), error: /no manifest\.json/ },
];

describe('unpacking a Web Store package in the worker', () => {
  it.each(cases)('$name', async ({ crx: make, expectedId = id, version = '1.0', limits, sha256 = (c) => sha256Hex(c), error }) => {
    const folder = dest();
    const crx = make();
    const announced = sha256(crx);
    const run = unpackInWorker(workerPath, { crx, id: expectedId, version, dest: folder, publisherKeyHash, ...(announced ? { sha256: announced } : {}), ...(limits ? { limits } : {}) });
    if (error) {
      await expect(run).rejects.toThrow(error);
      // Nothing is left behind: not the folder, and nothing beside it.
      expect(existsSync(folder)).toBe(false);
      expect(existsSync(join(dir, 'Extensions', 'escaped.txt'))).toBe(false);
      expect(existsSync(join(dir, 'Extensions', 'default', 'escaped.txt'))).toBe(false);
      return;
    }
    expect(await run).toBeGreaterThan(0);
    const written = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { key: string; version: string };
    expect(written.version).toBe(version);
    // The developer key is in the manifest, so the store's ID holds wherever it's unpacked.
    expect(idFromKey(Buffer.from(written.key, 'base64'))).toBe(expectedId);
  });

  it('only trusts the Chrome Web Store’s key unless told otherwise', async () => {
    const folder = dest();
    await expect(unpackInWorker(workerPath, { crx: crx3(archive, developer, [developer, publisher]), id, version: '1.0', dest: folder })).rejects.toThrow(/Chrome Web Store/);
    expect(existsSync(folder)).toBe(false);
  });

  it('replaces what an earlier, interrupted unpack left in the folder', async () => {
    const folder = dest();
    await unpackInWorker(workerPath, { crx: crx3(zip({ 'manifest.json': manifest(), 'old.js': 'x' }), developer, [developer, publisher]), id, version: '1.0', dest: folder, publisherKeyHash });
    await unpackInWorker(workerPath, { crx: crx3(archive, developer, [developer, publisher]), id, version: '1.0', dest: folder, publisherKeyHash });
    expect(readdirSync(folder).sort()).toEqual(['js', 'manifest.json', 'popup.html']);
  });

  it('moves the download’s memory to the worker instead of copying it', async () => {
    const crx = crx3(archive, developer, [developer, publisher]);
    const owned = new Uint8Array(new ArrayBuffer(crx.length));
    owned.set(crx);
    const run = unpackInWorker(workerPath, { crx: owned, id, version: '1.0', dest: dest(), publisherKeyHash });
    expect(owned.byteLength).toBe(0); // detached: main no longer holds it
    await run;
  });

  it('fails with a clear error when the worker dies, throws or hangs, and never leaves the thread running', async () => {
    const crx = () => crx3(archive, developer, [developer, publisher]);
    const exits = join(dir, 'exits.mjs');
    const throws = join(dir, 'throws.mjs');
    const hangs = join(dir, 'hangs.mjs');
    writeFileSync(exits, 'process.exit(3);\n');
    writeFileSync(throws, "throw new Error('boom');\n");
    writeFileSync(hangs, 'setInterval(() => {}, 1000);\n');
    await expect(unpackInWorker(exits, { crx: crx(), id, version: '1.0', dest: dest() })).rejects.toThrow(WORKER_STOPPED);
    await expect(unpackInWorker(throws, { crx: crx(), id, version: '1.0', dest: dest() })).rejects.toThrow(WORKER_STOPPED);
    await expect(unpackInWorker(join(dir, 'missing.mjs'), { crx: crx(), id, version: '1.0', dest: dest() })).rejects.toThrow(WORKER_STOPPED);
    await expect(unpackInWorker(hangs, { crx: crx(), id, version: '1.0', dest: dest() }, 300)).rejects.toThrow(/took too long/);
  });
});
