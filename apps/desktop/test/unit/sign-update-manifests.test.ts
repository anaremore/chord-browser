import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyManifest } from '../../src/main/update-signing';

const script = resolve(import.meta.dirname, '../../scripts/sign-update-manifests.mjs');
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sign-update-manifests.mjs (the release workflow step)', () => {
  it('signs the manifests Chord installs from, in a way Chord verifies', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-sign-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest = 'version: 0.2.0\npath: Chord-0.2.0-win-x64-setup.exe\n';
    writeFileSync(join(dir, 'latest-win-x64.yml'), manifest);
    writeFileSync(join(dir, 'latest-linux.yml'), 'version: 0.2.0\n');
    writeFileSync(join(dir, 'latest-mac.yml'), 'version: 0.2.0\n');
    execFileSync(process.execPath, [script, dir], {
      env: { ...process.env, CHORD_UPDATE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      stdio: 'pipe',
    });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyManifest(manifest, readFileSync(join(dir, 'latest-win-x64.yml.sig'), 'utf8'), publicPem)).toBe(true);
    expect(existsSync(join(dir, 'latest-linux.yml.sig'))).toBe(true);
    // macOS stays notify-only, so its manifest isn't signed.
    expect(existsSync(join(dir, 'latest-mac.yml.sig'))).toBe(false);
  });

  it('refuses to run without the key, or with a key of the wrong kind', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-sign-'));
    writeFileSync(join(dir, 'latest-win-x64.yml'), 'version: 0.2.0\n');
    const run = (key: string) => execFileSync(process.execPath, [script, dir], { env: { ...process.env, CHORD_UPDATE_SIGNING_KEY: key }, stdio: 'pipe' });
    expect(() => run('')).toThrow();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => run(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow();
    expect(existsSync(join(dir, 'latest-win-x64.yml.sig'))).toBe(false);
  });
});
