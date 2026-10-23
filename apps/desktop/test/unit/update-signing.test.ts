import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { downloadsFor, manifestFor, signatureFile, verifyManifest } from '../../src/main/update-signing';

const MANIFEST = `version: 0.2.0
files:
  - url: Chord-0.2.0-win-x64-setup.exe
    sha512: q1w2e3r4t5y6u7i8o9p0==
    size: 123456
path: Chord-0.2.0-win-x64-setup.exe
sha512: q1w2e3r4t5y6u7i8o9p0==
releaseDate: '2026-11-01T00:00:00.000Z'
`;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** What the release workflow does (scripts/sign-update-manifests.mjs). */
const signed = (manifest: string, privateKey: ReturnType<typeof keyPair>['privateKey']) => sign(null, Buffer.from(manifest), privateKey).toString('base64');

describe('verifyManifest', () => {
  it('accepts a manifest signed by the matching key', () => {
    const { privateKey, publicPem } = keyPair();
    expect(verifyManifest(MANIFEST, signed(MANIFEST, privateKey), publicPem)).toBe(true);
    expect(verifyManifest(Buffer.from(MANIFEST), `${signed(MANIFEST, privateKey)}\n`, publicPem)).toBe(true);
  });

  it('refuses a manifest changed after signing, even by one character', () => {
    const { privateKey, publicPem } = keyPair();
    const signature = signed(MANIFEST, privateKey);
    expect(verifyManifest(MANIFEST.replace('q1w2', 'q1w3'), signature, publicPem)).toBe(false);
    expect(verifyManifest(MANIFEST.replace('0.2.0', '9.9.9'), signature, publicPem)).toBe(false);
  });

  it('refuses a signature from another key', () => {
    const ours = keyPair();
    const theirs = keyPair();
    expect(verifyManifest(MANIFEST, signed(MANIFEST, theirs.privateKey), ours.publicPem)).toBe(false);
  });

  it('refuses everything while no key is configured, and anything malformed', () => {
    const { privateKey, publicPem } = keyPair();
    const signature = signed(MANIFEST, privateKey);
    expect(verifyManifest(MANIFEST, signature, '')).toBe(false);
    expect(verifyManifest(MANIFEST, '', publicPem)).toBe(false);
    expect(verifyManifest(MANIFEST, 'not base64 at all!!', publicPem)).toBe(false);
    expect(verifyManifest(MANIFEST, signature, '-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----')).toBe(false);
  });

  it('only trusts Ed25519 keys', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyManifest(MANIFEST, 'AAAA', pem)).toBe(false);
  });
});

describe('where updates come from', () => {
  it('names one manifest per installable build, and none on macOS', () => {
    expect(manifestFor('win32', 'x64')).toBe('latest-win-x64.yml');
    expect(manifestFor('win32', 'arm64')).toBe('latest-win-arm64.yml');
    expect(manifestFor('linux', 'x64')).toBe('latest-linux.yml');
    expect(manifestFor('linux', 'arm64')).toBe('latest-linux-arm64.yml');
    expect(manifestFor('darwin', 'arm64')).toBeNull();
    expect(manifestFor('win32', 'ia32')).toBeNull();
    expect(signatureFile('latest-linux.yml')).toBe('latest-linux.yml.sig');
  });

  it("downloads from the release's tag folder", () => {
    expect(downloadsFor('v0.2.0')).toBe('https://github.com/anaremore/chord-browser/releases/download/v0.2.0/');
    expect(downloadsFor('v0.2.0', 'http://127.0.0.1:9/download')).toBe('http://127.0.0.1:9/download/v0.2.0/');
  });
});
