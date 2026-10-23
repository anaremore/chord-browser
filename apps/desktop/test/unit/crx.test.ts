import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extensionIdFrom, extractZip, idFromKey, verifyCrx3, WEB_STORE_PUBLISHER_KEY_HASH } from '../../src/main/extensions/crx';
import { crx3, extensionIdOf, keyPair, sha256Hex, spki, zip } from '../fixtures/crx';

const developer = keyPair('rsa');
const publisher = keyPair('ec');
const publisherKeyHash = sha256Hex(spki(publisher.publicKey));
const id = extensionIdOf(developer.publicKey);
const archive = zip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Fixture', version: '1.0' }), 'popup.html': '<p>hi</p>' });

describe('verifyCrx3', () => {
  it('accepts a package signed by its developer and the publisher, and returns the archive and developer key', () => {
    const result = verifyCrx3(crx3(archive, developer, [developer, publisher]), id, { publisherKeyHash });
    expect(result.archive.equals(archive)).toBe(true);
    expect(idFromKey(result.publicKey)).toBe(id);
  });

  it('rejects a package changed after signing, by a single byte', () => {
    const crx = crx3(archive, developer, [developer, publisher]);
    crx[crx.length - 40]! ^= 0x01;
    expect(() => verifyCrx3(crx, id, { publisherKeyHash })).toThrow(/signature/i);
  });

  it('rejects a package for another extension', () => {
    expect(() => verifyCrx3(crx3(archive, developer, [developer, publisher]), 'a'.repeat(32), { publisherKeyHash })).toThrow(/not a{32}/);
  });

  it('rejects a package the publisher didn’t sign, and one only someone else signed', () => {
    expect(() => verifyCrx3(crx3(archive, developer, [developer]), id, { publisherKeyHash })).toThrow(/Chrome Web Store/);
    const stranger = keyPair('rsa');
    expect(() => verifyCrx3(crx3(archive, developer, [stranger, publisher]), id, { publisherKeyHash })).toThrow(/developer/);
  });

  it('only trusts the Chrome Web Store’s key unless told otherwise', () => {
    expect(WEB_STORE_PUBLISHER_KEY_HASH).toMatch(/^61f7f2a6/);
    expect(() => verifyCrx3(crx3(archive, developer, [developer, publisher]), id)).toThrow(/Chrome Web Store/);
  });

  it('rejects things that aren’t CRX3', () => {
    expect(() => verifyCrx3(Buffer.from('PK\x03\x04 not a crx'), id)).toThrow(/Not a CRX/);
    const crx2 = crx3(archive, developer, [developer, publisher]);
    crx2.writeUInt32LE(2, 4);
    expect(() => verifyCrx3(crx2, id, { publisherKeyHash })).toThrow(/only CRX3/);
    expect(() => verifyCrx3(crx3(archive, developer, [developer, publisher]).subarray(0, 30), id, { publisherKeyHash })).toThrow();
  });
});

describe('extractZip', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('unpacks files into the folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-zip-'));
    expect(extractZip(zip({ 'manifest.json': '{}', 'js/a.js': 'a()' }), dir)).toBe(2);
    expect(readFileSync(join(dir, 'js', 'a.js'), 'utf8')).toBe('a()');
  });

  it('refuses files that would land outside the folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-zip-'));
    expect(() => extractZip(zip({ '../escaped.txt': 'x' }), join(dir, 'inner'))).toThrow(/outside/);
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false);
    expect(() => extractZip(zip({ 'a\\..\\..\\b.txt': 'x' }), dir)).toThrow(/Bad file name/);
  });

  it('stops at the size limit instead of filling the disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-zip-'));
    const big = zip({ 'zeros.bin': Buffer.alloc(1024 * 1024) });
    expect(() => extractZip(big, dir, { maxFiles: 10, maxBytes: 1000 })).toThrow(/too big/);
    expect(() => extractZip(zip({ a: '1', b: '2' }), dir, { maxFiles: 1, maxBytes: 1000 })).toThrow(/Too many/);
  });
});

describe('extensionIdFrom', () => {
  const store = 'nngceckbapebfimnlniiiahkandclblb';
  it('reads a bare ID or a Chrome Web Store page', () => {
    expect(extensionIdFrom(` ${store} `)).toBe(store);
    expect(extensionIdFrom(`https://chromewebstore.google.com/detail/bitwarden-password-manager/${store}`)).toBe(store);
    expect(extensionIdFrom(`https://chromewebstore.google.com/detail/${store}?hl=en`)).toBe(store);
    expect(extensionIdFrom(`chromewebstore.google.com/detail/x/${store}`)).toBe(store);
    expect(extensionIdFrom(`https://chrome.google.com/webstore/detail/x/${store}`)).toBe(store);
  });

  it('refuses anything else', () => {
    expect(extensionIdFrom('bitwarden')).toBeNull();
    expect(extensionIdFrom(`https://evil.example/detail/x/${store}`)).toBeNull();
    expect(extensionIdFrom(`http://chromewebstore.google.com/detail/x/${store}`)).toBeNull();
    expect(extensionIdFrom(`https://chromewebstore.google.com/category/${store}`)).toBeNull();
    expect(extensionIdFrom('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });
});
