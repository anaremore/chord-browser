import { describe, expect, it } from 'vitest';
import { archiveName, compareVersions, executableIn, manifestFor, manifestName, parseManifest, pickPlayerRelease, targetFor } from '../src/release.ts';

const fields = {
  version: '0.1.0',
  protocol: 1,
  ecs: '44.9.3+wvcus',
  target: 'linux-x64' as const,
  file: 'chord-player-0.1.0-linux-x64.zip',
  size: 130_000_000,
  unpackedSize: 300_000_000,
  sha512: `${'A'.repeat(86)}==`,
  vmp: 'none' as const,
};

describe('player releases', () => {
  it('names what each target ships, and only the targets it’s built for', () => {
    expect(targetFor('win32', 'x64')).toBe('win32-x64');
    expect(targetFor('darwin', 'arm64')).toBe('darwin-arm64');
    expect(targetFor('linux', 'arm64')).toBeNull();
    expect(targetFor('win32', 'arm64')).toBeNull();
    expect(manifestName('darwin-x64')).toBe('chord-player-darwin-x64.json');
    expect(archiveName('0.2.0', 'win32-x64')).toBe('chord-player-0.2.0-win32-x64.zip');
    expect(executableIn('darwin')).toBe('Chord Player.app/Contents/MacOS/Chord Player');
  });

  it('reads back a manifest it wrote', () => {
    expect(parseManifest(manifestFor(fields), { target: 'linux-x64', version: '0.1.0' })).toEqual({ name: 'chord-player', ...fields });
  });

  it('refuses a manifest for another target or release, or one that claims odd things', () => {
    const text = manifestFor(fields);
    expect(parseManifest(text, { target: 'win32-x64' })).toBeNull();
    // An older signed manifest served for a newer release.
    expect(parseManifest(text, { target: 'linux-x64', version: '0.2.0' })).toBeNull();
    const odd = [
      { file: '../../evil.zip' },
      { file: 'chord-player-0.1.0-linux-x64.exe' },
      { size: 10 },
      { size: 5 * 1024 ** 3 },
      { unpackedSize: 10 },
      { sha512: 'abc' },
      { ecs: '45.0.0' },
      { vmp: 'trust me' },
      { protocol: 0 },
      { version: 'latest' },
    ];
    for (const change of odd) expect(parseManifest(manifestFor({ ...fields, ...change } as typeof fields), { target: 'linux-x64' }), JSON.stringify(change)).toBeNull();
    expect(parseManifest('not json', { target: 'linux-x64' })).toBeNull();
    expect(parseManifest(text.replace('"chord-player"', '"chord"'), { target: 'linux-x64' })).toBeNull();
  });

  it('picks the newest published player release, never Chord’s own or a draft', () => {
    const reply = [
      { tag_name: 'v0.9.0', draft: false },
      { tag_name: 'player-v0.1.0', draft: false },
      { tag_name: 'player-v0.3.0', draft: true },
      { tag_name: 'player-v0.2.0', draft: false },
      { tag_name: 'player-v0.2.1-beta.1', draft: false },
      { tag_name: 'player-vlatest', draft: false },
    ];
    expect(pickPlayerRelease(reply)).toEqual({ version: '0.2.0', tag: 'player-v0.2.0' });
    expect(pickPlayerRelease(reply, '0.2.0-beta.3')).toEqual({ version: '0.2.1-beta.1', tag: 'player-v0.2.1-beta.1' });
    expect(pickPlayerRelease({ message: 'rate limited' })).toBeNull();
  });

  it('compares versions by SemVer', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
