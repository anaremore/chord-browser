import { describe, expect, it } from 'vitest';
import { RELEASES_PAGE, compareVersions, newerRelease, parseVersion } from '../../src/main/releases';

describe('compareVersions', () => {
  it('orders by SemVer precedence', () => {
    const sorted = ['1.0.0', '0.10.0', '0.2.0', '0.2.0-rc.1', '0.2.0-beta.11', '0.2.0-beta.2', '0.2.0-alpha', '0.1.0'];
    expect([...sorted].sort(compareVersions)).toEqual(['0.1.0', '0.2.0-alpha', '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0-rc.1', '0.2.0', '0.10.0', '1.0.0']);
  });

  it('reads a leading v and ignores build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('newerRelease', () => {
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    name: `Chord ${tag.replace(/^v/, '')}`,
    html_url: `${RELEASES_PAGE}tag/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  });

  it('picks the newest release newer than the running one', () => {
    const reply = [release('v0.2.0'), release('v0.3.0'), release('v0.1.0')];
    expect(newerRelease(reply, '0.1.0')).toEqual({ version: '0.3.0', name: 'Chord 0.3.0', url: `${RELEASES_PAGE}tag/v0.3.0` });
    expect(newerRelease(reply, '0.3.0')).toBeNull();
    expect(newerRelease([], '0.1.0')).toBeNull();
  });

  it('skips drafts, and SemVer pre-releases unless one is running', () => {
    const reply = [release('v0.4.0', { draft: true }), release('v0.3.0-beta.1'), release('v0.2.0')];
    expect(newerRelease(reply, '0.1.0')?.version).toBe('0.2.0');
    expect(newerRelease(reply, '0.2.0')).toBeNull();
    expect(newerRelease(reply, '0.2.1-beta.1')?.version).toBe('0.3.0-beta.1');
  });

  it("counts GitHub's pre-release flag as a release: previews carry it", () => {
    expect(newerRelease([release('v0.2.0', { prerelease: true })], '0.1.0')?.version).toBe('0.2.0');
  });

  it('ignores anything that would open somewhere other than its release page', () => {
    expect(newerRelease([release('v9.0.0', { html_url: 'https://evil.example/' })], '0.1.0')).toBeNull();
    expect(newerRelease([{ tag_name: 'v9.0.0' }], '0.1.0')).toBeNull();
    expect(newerRelease({ message: 'API rate limit exceeded' }, '0.1.0')).toBeNull();
  });

  it('names an unnamed release by its version', () => {
    expect(newerRelease([release('v0.2.0', { name: '' })], '0.1.0')?.name).toBe('Chord 0.2.0');
  });
});
