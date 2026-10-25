/**
 * Installing Chord Player (ARCHITECTURE.md §9): the install state machine,
 * what the DRM notice offers in each state, and the installer against a
 * stand-in release (a real zip, a manifest signed with a test key): a
 * signed release installs, and an unsigned or wrongly signed manifest, a
 * manifest from another release, and a corrupted download are each refused,
 * leaving nothing installed. Updates wait their turn beside the running
 * version and replace it only once they've started.
 */
import { manifestFor, manifestName, archiveName, writeZip, type PlayerManifest } from '@chord/player-protocol';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextState, offerFor, type InstallState } from '../../src/main/player/install-state';
import { PlayerInstaller } from '../../src/main/player/installer';

const release = { version: '0.1.0', tag: 'player-v0.1.0' };
const manifest: PlayerManifest = {
  name: 'chord-player',
  version: '0.1.0',
  protocol: 1,
  ecs: '44.9.3+wvcus',
  target: 'linux-x64',
  file: 'chord-player-0.1.0-linux-x64.zip',
  size: 150_000_000,
  unpackedSize: 300_000_000,
  sha512: `${'A'.repeat(86)}==`,
  vmp: 'none',
};
const installed = { version: '0.1.0', protocol: 1, ecs: '44.9.3+wvcus', vmp: 'none' as const };

describe('the install state machine', () => {
  it('goes from unknown to installed, one step at a time', () => {
    let s: InstallState = { s: 'unknown' };
    s = nextState(s, { e: 'check', now: 0 });
    expect(s).toEqual({ s: 'checking', since: 0 });
    s = nextState(s, { e: 'found', release, manifest });
    expect(s.s).toBe('available');
    s = nextState(s, { e: 'install' });
    expect(s).toMatchObject({ s: 'downloading', received: 0 });
    s = nextState(s, { e: 'progress', received: 75_000_000 });
    expect(offerFor(s, { now: 0, opening: false })).toEqual({ state: 'installing', phase: 'downloading', percent: 50 });
    s = nextState(s, { e: 'downloaded' });
    expect(offerFor(s, { now: 0, opening: false })).toEqual({ state: 'installing', phase: 'checking', percent: 100 });
    s = nextState(s, { e: 'verified' });
    s = nextState(s, { e: 'unpacked', percent: 40 });
    expect(offerFor(s, { now: 0, opening: false })).toEqual({ state: 'installing', phase: 'unpacking', percent: 40 });
    s = nextState(s, { e: 'done', installed });
    expect(s).toEqual({ s: 'installed', installed });
    expect(offerFor(s, { now: 0, opening: false })).toEqual({ state: 'ready' });
    expect(offerFor(s, { now: 0, opening: true })).toEqual({ state: 'opening' });
  });

  it('ignores what doesn’t fit: a second Install, late progress, a failure after it’s done', () => {
    const downloading = nextState({ s: 'available', release, manifest, update: false }, { e: 'install' });
    expect(nextState(downloading, { e: 'install' })).toBe(downloading);
    const done: InstallState = { s: 'installed', installed };
    expect(nextState(done, { e: 'progress', received: 1 })).toBe(done);
    expect(nextState(done, { e: 'fail', why: 'download' })).toBe(done);
    expect(nextState(done, { e: 'check', now: 1 })).toBe(done);
    // Progress never claims more than the download's size.
    expect(nextState(downloading, { e: 'progress', received: 9e9 })).toMatchObject({ received: manifest.size });
  });

  it('a failure keeps the release, so Try again downloads it again', () => {
    let s: InstallState = nextState({ s: 'available', release, manifest, update: false }, { e: 'install' });
    s = nextState(s, { e: 'downloaded' });
    s = nextState(s, { e: 'fail', why: 'verify' });
    expect(s).toMatchObject({ s: 'failed', why: 'verify', manifest });
    expect(offerFor(s, { now: 0, opening: false })).toEqual({ state: 'failed', why: 'verify' });
    expect(nextState(s, { e: 'install' })).toMatchObject({ s: 'downloading', received: 0 });
  });

  it('the notice waits briefly for a check, then shows without Chord Player', () => {
    expect(offerFor({ s: 'unknown' }, { now: 0, opening: false })).toBe('pending');
    expect(offerFor({ s: 'checking', since: 1000 }, { now: 2000, opening: false })).toBe('pending');
    expect(offerFor({ s: 'checking', since: 1000 }, { now: 5000, opening: false })).toBeNull();
    expect(offerFor({ s: 'unavailable', why: 'unsigned' }, { now: 0, opening: false })).toBeNull();
    expect(offerFor({ s: 'available', release, manifest, update: true }, { now: 0, opening: false })).toEqual({ state: 'install', size: manifest.size, update: true });
  });

  it('removing it starts over; a version found on disk is installed', () => {
    expect(nextState({ s: 'installed', installed }, { e: 'removed' })).toEqual({ s: 'unknown' });
    expect(nextState({ s: 'unknown' }, { e: 'present', installed })).toEqual({ s: 'installed', installed });
  });
});

/* ---------- The installer, against a stand-in release ---------- */

const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const workerPath = resolve(import.meta.dirname, '../../src/main/player/unpack-worker.ts');

/** A player zip of `version`: a little over a megabyte of incompressible bytes, and an executable. */
async function makeRelease(version: string, { corrupt = false, signedBy = keys.privateKey, protocol = 1 } = {}) {
  const tree = mkdtempSync(join(tmpdir(), 'player-tree-'));
  writeFileSync(join(tree, 'chord-player'), '#!/bin/sh\n', { mode: 0o755 });
  mkdirSync(join(tree, 'resources'));
  writeFileSync(join(tree, 'resources', 'app.asar'), createHash('sha512').update(version).digest().toString('hex').repeat(12_000));
  writeFileSync(join(tree, 'blob.bin'), randomBytes(1_200_000));
  const out = mkdtempSync(join(tmpdir(), 'player-release-'));
  const file = archiveName(version, 'linux-x64');
  const zip = join(out, file);
  const { bytes } = await writeZip(tree, zip);
  const body = readFileSync(zip);
  const sha512 = createHash('sha512').update(body).digest('base64');
  if (corrupt) body[body.length >> 1]! ^= 0xff;
  const text = manifestFor({ version, protocol, ecs: '44.9.3+wvcus', target: 'linux-x64', file, size: body.length, unpackedSize: bytes, sha512, vmp: 'none' });
  return {
    files: {
      [file]: body,
      [manifestName('linux-x64')]: Buffer.from(text),
      [`${manifestName('linux-x64')}.sig`]: Buffer.from(sign(null, Buffer.from(text), signedBy).toString('base64')),
    } as Record<string, Buffer>,
  };
}

/** A fetch serving the GitHub releases list and each release's files. */
function server(releases: Record<string, Record<string, Buffer>>) {
  return async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/releases') return new Response(JSON.stringify(Object.keys(releases).map((tag) => ({ tag_name: tag, draft: false }))), { headers: { 'content-type': 'application/json' } });
    const [, , tag, name] = u.pathname.split('/');
    const body = releases[decodeURIComponent(tag ?? '')]?.[decodeURIComponent(name ?? '')];
    return body ? new Response(new Uint8Array(body)) : new Response('not found', { status: 404 });
  };
}

function installer(fetch: (url: string) => Promise<Response>, options: { root?: string; publicKey?: string } = {}) {
  const changes: string[] = [];
  const root = options.root ?? join(mkdtempSync(join(tmpdir(), 'player-root-')), 'Chord Player');
  const inst = new PlayerInstaller({
    root,
    target: 'linux-x64',
    feed: 'http://test/releases',
    downloads: 'http://test/download/',
    publicKey: options.publicKey ?? publicPem,
    fetch,
    workerPath,
    changed: () => changes.push(inst.state.s),
  });
  return { inst, root, changes };
}

describe('the installer', () => {
  it('installs a signed release: checked, unpacked, and the zip gone', async () => {
    const r = await makeRelease('0.1.0');
    const { inst, root, changes } = installer(server({ 'player-v0.1.0': r.files }));
    await inst.check();
    expect(inst.state).toMatchObject({ s: 'available', manifest: { version: '0.1.0' } });
    await expect(inst.install()).resolves.toBe(true);
    expect(inst.state).toMatchObject({ s: 'installed', installed: { version: '0.1.0', protocol: 1 } });
    expect(changes).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'verifying', 'unpacking', 'installed']));
    expect(existsSync(join(root, '0.1.0', 'chord-player'))).toBe(true);
    expect(readdirSync(join(root, 'Downloads'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).current.version).toBe('0.1.0');
    // A new Chord finds it there.
    const again = installer(server({}), { root });
    await again.inst.load();
    expect(again.inst.installed()?.version).toBe('0.1.0');
  });

  it('refuses a corrupted download: nothing is unpacked, and the notice can try again', async () => {
    const r = await makeRelease('0.1.0', { corrupt: true });
    const { inst, root } = installer(server({ 'player-v0.1.0': r.files }));
    await inst.check();
    await expect(inst.install()).resolves.toBe(false);
    expect(inst.state).toMatchObject({ s: 'failed', why: 'verify' });
    expect(existsSync(join(root, '0.1.0'))).toBe(false);
    expect(readdirSync(root).filter((n) => !['Downloads'].includes(n))).toEqual([]);
  });

  it('offers nothing for a manifest signed with another key, an unsigned build, or another release’s manifest', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const forged = await makeRelease('0.1.0', { signedBy: stranger.privateKey });
    const a = installer(server({ 'player-v0.1.0': forged.files }));
    await a.inst.check();
    expect(a.inst.state).toEqual({ s: 'unavailable', why: 'unsigned' });

    const good = await makeRelease('0.1.0');
    const b = installer(server({ 'player-v0.1.0': good.files }), { publicKey: '' });
    await b.inst.check();
    expect(b.inst.state).toEqual({ s: 'unavailable', why: 'unsigned' });

    // 0.1.0's signed manifest served as release 0.2.0: an old player can't pass for a new one.
    const c = installer(server({ 'player-v0.2.0': good.files }));
    await c.inst.check();
    expect(c.inst.state).toEqual({ s: 'unavailable', why: 'no-release' });

    // A player speaking a protocol this Chord doesn't.
    const future = await makeRelease('0.1.0', { protocol: 99 });
    const d = installer(server({ 'player-v0.1.0': future.files }));
    await d.inst.check();
    expect(d.inst.state).toEqual({ s: 'unavailable', why: 'no-release' });
  });

  it('updates beside the running version, which stays until the new one has started', async () => {
    const v1 = await makeRelease('0.1.0');
    const v2 = await makeRelease('0.2.0');
    const releases: Record<string, Record<string, Buffer>> = { 'player-v0.1.0': v1.files };
    const { inst, root } = installer(server(releases));
    await inst.check();
    await inst.install();
    releases['player-v0.2.0'] = v2.files;
    await inst.checkForUpdate();
    expect(inst.pendingVersion).toBe('0.2.0');
    expect(inst.candidates().map((c) => c.version)).toEqual(['0.2.0', '0.1.0']);
    expect(existsSync(join(root, '0.1.0'))).toBe(true);
    await inst.started('0.2.0');
    expect(inst.installed()?.version).toBe('0.2.0');
    expect(existsSync(join(root, '0.1.0'))).toBe(false);
  });

  it('skips a version that won’t start, and runs the previous one', async () => {
    const v1 = await makeRelease('0.1.0');
    const v2 = await makeRelease('0.2.0');
    const releases: Record<string, Record<string, Buffer>> = { 'player-v0.1.0': v1.files };
    const { inst } = installer(server(releases));
    await inst.check();
    await inst.install();
    releases['player-v0.2.0'] = v2.files;
    await inst.checkForUpdate();
    await inst.failedToStart('0.2.0');
    expect(inst.candidates().map((c) => c.version)).toEqual(['0.1.0']);
    // It isn't downloaded again.
    await inst.checkForUpdate();
    expect(inst.pendingVersion).toBeNull();
  });

  it('removes every version and the profile', async () => {
    const r = await makeRelease('0.1.0');
    const { inst, root } = installer(server({ 'player-v0.1.0': r.files }));
    await inst.check();
    await inst.install();
    mkdirSync(join(root, 'Profile'), { recursive: true });
    await inst.remove();
    expect(existsSync(root)).toBe(false);
    expect(inst.state).toEqual({ s: 'unknown' });
    expect(inst.installed()).toBeNull();
  });
});
