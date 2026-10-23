import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import config, { macSigning, signingFrom, winSigning } from '../../electron-builder.config';

const build = resolve(import.meta.dirname, '../../build');
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A notarytool key file, as the release workflow writes it. */
function keyFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'chord-signing-'));
  const file = join(dir, 'AuthKey_TEST.p8');
  writeFileSync(file, 'not a real key\n');
  return file;
}

const entitlementsIn = (file: string) => [...readFileSync(file, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);

describe('unsigned builds (no CHORD_SIGNING)', () => {
  it('keep the ad-hoc macOS signature exactly as before', () => {
    expect(macSigning({})).toEqual({ identity: '-', hardenedRuntime: false });
    // Stray credentials don't switch anything on: only the release workflow's CHORD_SIGNING does.
    expect(macSigning({ CSC_LINK: 'x', APPLE_API_KEY: 'x', APPLE_API_KEY_ID: 'x', APPLE_API_ISSUER: 'x' })).toEqual({ identity: '-', hardenedRuntime: false });
    expect(macSigning({ CHORD_SIGNING: 'none' })).toEqual({ identity: '-', hardenedRuntime: false });
  });

  it('sign nothing on Windows and pin no publisher, so their copies keep installing unsigned updates', () => {
    expect(winSigning({})).toEqual({});
    expect(winSigning({ WIN_CSC_LINK: 'x', WIN_PUBLISHER_NAME: 'Someone' })).toEqual({});
  });

  it('are what the packaging config builds when nothing is set', () => {
    expect(signingFrom(process.env)).toBe('none');
    expect(config.mac).toMatchObject({ identity: '-', hardenedRuntime: false });
    expect(config.mac).not.toHaveProperty('entitlements');
    expect(config.mac).not.toHaveProperty('notarize');
    for (const key of ['azureSignOptions', 'signtoolOptions', 'signExts', 'publisherName']) expect(config.win).not.toHaveProperty(key);
    // The Store package is drafted but never built by default.
    expect(config.win?.target).toBe('nsis');
  });

  it("don't pick up the Developer ID entitlements (electron-builder applies build/entitlements.mac*.plist to every build)", () => {
    expect(existsSync(join(build, 'entitlements.mac.plist'))).toBe(false);
    expect(existsSync(join(build, 'entitlements.mac.inherit.plist'))).toBe(false);
  });
});

describe('Developer ID (macOS)', () => {
  const credentials = () => ({ CHORD_SIGNING: 'developer-id', CSC_LINK: 'base64', CSC_KEY_PASSWORD: 'pw', APPLE_API_KEY: keyFile(), APPLE_API_KEY_ID: 'ABC123', APPLE_API_ISSUER: 'issuer' });

  it('signs with the hardened runtime and its entitlements, then notarizes', () => {
    const mac = macSigning(credentials());
    // No identity: electron-builder finds the Developer ID in the keychain it makes from CSC_LINK.
    expect(mac).not.toHaveProperty('identity');
    expect(mac).toMatchObject({ hardenedRuntime: true, notarize: true });
    expect(existsSync(mac.entitlements!)).toBe(true);
    expect(existsSync(mac.entitlementsInherit!)).toBe(true);
  });

  it('accepts an Apple ID for notarization instead of an API key', () => {
    expect(macSigning({ CHORD_SIGNING: 'developer-id', CSC_LINK: 'b', CSC_KEY_PASSWORD: 'p', APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' })).toMatchObject({ notarize: true });
  });

  it('stops the build when anything is missing, rather than shipping it unsigned or unnotarized', () => {
    const full = credentials();
    expect(() => macSigning({ ...full, CSC_LINK: '' })).toThrow(/needs CSC_LINK/);
    expect(() => macSigning({ ...full, CSC_KEY_PASSWORD: undefined })).toThrow(/needs CSC_KEY_PASSWORD/);
    expect(() => macSigning({ ...full, APPLE_API_ISSUER: ' ' })).toThrow(/notarization credentials/);
    // electron-builder 26 gives notarytool the key's path, not the key.
    expect(() => macSigning({ ...full, APPLE_API_KEY: '-----BEGIN PRIVATE KEY-----' })).toThrow(/path of the \.p8/);
  });

  it('asks for only what Chord uses: JIT everywhere; camera, microphone and location on the app', () => {
    expect(entitlementsIn(join(build, 'entitlements.developer-id.plist')).sort()).toEqual(
      ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera', 'com.apple.security.personal-information.location'].sort(),
    );
    expect(entitlementsIn(join(build, 'entitlements.developer-id.inherit.plist'))).toEqual(['com.apple.security.cs.allow-jit']);
  });
});

describe('Windows signing', () => {
  const azure = { CHORD_SIGNING: 'artifact-signing', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/', AZURE_SIGNING_ACCOUNT: 'chord', AZURE_SIGNING_PROFILE: 'chord-public', WIN_PUBLISHER_NAME: 'Chord Contributors' };

  it('Artifact Signing signs the app, its DLLs and the installer, and pins the publisher for updates', () => {
    expect(winSigning(azure)).toEqual({
      azureSignOptions: { publisherName: 'Chord Contributors', endpoint: 'https://eus.codesigning.azure.net/', codeSigningAccountName: 'chord', certificateProfileName: 'chord-public' },
      signExts: ['.dll'],
    });
  });

  it('Artifact Signing needs every setting, including the publisher name it cannot look up', () => {
    expect(() => winSigning({ ...azure, WIN_PUBLISHER_NAME: '' })).toThrow(/needs WIN_PUBLISHER_NAME/);
    expect(() => winSigning({ ...azure, AZURE_CLIENT_SECRET: undefined })).toThrow(/needs AZURE_CLIENT_SECRET/);
  });

  it('a certificate signs SHA-256 only and takes the publisher from the certificate unless told', () => {
    const pfx = { CHORD_SIGNING: 'certificate', WIN_CSC_LINK: 'base64', WIN_CSC_KEY_PASSWORD: 'pw' };
    expect(winSigning(pfx)).toEqual({ signtoolOptions: { signingHashAlgorithms: ['sha256'] }, signExts: ['.dll'] });
    expect(winSigning({ ...pfx, WIN_PUBLISHER_NAME: 'Chord Contributors' }).signtoolOptions).toMatchObject({ publisherName: 'Chord Contributors' });
    expect(() => winSigning({ ...pfx, WIN_CSC_LINK: '' })).toThrow(/needs WIN_CSC_LINK/);
  });

  it('rejects a signing mode it does not know', () => {
    expect(() => signingFrom({ CHORD_SIGNING: 'ev-token' })).toThrow(/expected one of/);
  });
});

describe('signing-mode.mjs (the release workflow step)', () => {
  const script = resolve(import.meta.dirname, '../../scripts/signing-mode.mjs');
  const mac = ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WIN_PUBLISHER_NAME'];
  const pfx = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];

  /** Runs the step with these secrets set; returns its exit code, output and the CHORD_SIGNING it chose. */
  function choose(platform: string, set: readonly string[], extra: Record<string, string> = {}) {
    dir ||= mkdtempSync(join(tmpdir(), 'chord-signing-'));
    const githubEnv = join(dir, `github-env-${Math.random()}`);
    writeFileSync(githubEnv, '');
    const has = Object.fromEntries([...mac, ...azure, ...pfx].map((name) => [`HAS_${name}`, String(set.includes(name))]));
    const run = spawnSync(process.execPath, [script], { env: { ...process.env, ...has, PLATFORM: platform, IS_TAG: 'true', GITHUB_ENV: githubEnv, ...extra }, encoding: 'utf8' });
    const mode = /^CHORD_SIGNING=(.*)$/m.exec(readFileSync(githubEnv, 'utf8'))?.[1] ?? null;
    return { code: run.status, out: run.stdout, mode };
  }

  it('builds unsigned until the secrets exist', () => {
    expect(choose('mac', [])).toMatchObject({ code: 0, mode: 'none' });
    expect(choose('win', [])).toMatchObject({ code: 0, mode: 'none' });
    expect(choose('linux', [...mac, ...azure])).toMatchObject({ code: 0, mode: 'none' });
  });

  it('switches signing on by itself once a whole set is there', () => {
    expect(choose('mac', mac)).toMatchObject({ code: 0, mode: 'developer-id' });
    expect(choose('win', azure)).toMatchObject({ code: 0, mode: 'artifact-signing' });
    expect(choose('win', pfx)).toMatchObject({ code: 0, mode: 'certificate' });
    // A certificate can name its publisher too; that alone isn't half of Artifact Signing.
    expect(choose('win', [...pfx, 'WIN_PUBLISHER_NAME'])).toMatchObject({ code: 0, mode: 'certificate' });
    expect(choose('win', ['WIN_PUBLISHER_NAME'])).toMatchObject({ code: 0, mode: 'none' });
  });

  it('prefers Artifact Signing, and says so when a second set is half there', () => {
    expect(choose('win', [...azure, ...pfx])).toMatchObject({ code: 0, mode: 'artifact-signing' });
    const run = choose('win', [...pfx, 'AZURE_CLIENT_ID']);
    expect(run).toMatchObject({ code: 0, mode: 'certificate' });
    expect(run.out).toContain('::warning');
  });

  it('fails on a half-configured set and names what is missing', () => {
    const run = choose('mac', mac.filter((name) => name !== 'APPLE_API_ISSUER'));
    expect(run).toMatchObject({ code: 1, mode: null });
    expect(run.out).toMatch(/::error.*APPLE_API_ISSUER/);
    expect(choose('win', ['AZURE_CLIENT_SECRET'])).toMatchObject({ code: 1, mode: null });
  });

  it('with CHORD_REQUIRE_SIGNING on, a tag build without secrets fails instead of shipping unsigned', () => {
    expect(choose('win', [], { REQUIRE_SIGNING: 'true' })).toMatchObject({ code: 1, mode: null });
    expect(choose('mac', mac, { REQUIRE_SIGNING: 'true' })).toMatchObject({ code: 0, mode: 'developer-id' });
    // Manual runs from a branch never see the secrets, and Linux has nothing to sign.
    expect(choose('win', [], { REQUIRE_SIGNING: 'true', IS_TAG: 'false' })).toMatchObject({ code: 0, mode: 'none' });
    expect(choose('linux', [], { REQUIRE_SIGNING: 'true' })).toMatchObject({ code: 0, mode: 'none' });
  });
});
