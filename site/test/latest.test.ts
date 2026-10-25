import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript, run by the site's workflow without a build
import { newest, redirects, summary } from '../tools/latest.mjs';

const asset = (name: string, size = 1) => ({ name, size, browser_download_url: `https://github.com/anaremore/chord-browser/releases/download/x/${name}` });
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  html_url: `https://github.com/anaremore/chord-browser/releases/tag/${tag}`,
  published_at: '2026-10-25T00:00:00Z',
  assets: [asset(`Chord-${tag.slice(1)}-win-x64-setup.exe`, 126e6), asset(`Chord-${tag.slice(1)}-mac-arm64.dmg`, 125e6)],
  ...extra,
});

describe('the newest release the site links to', () => {
  it('is the highest version that is out: not a draft, not the player, and not a later patch to an older line', () => {
    const releases = [
      release('v0.3.0', { draft: true }),
      release('player-v1.0.0'),
      release('v0.1.9'),
      release('v0.2.1'),
      release('v0.2.0'),
      release('v0.10.0', { draft: true }),
    ];
    expect(newest(releases).tag_name).toBe('v0.2.1');
    expect(newest([release('v0.9.0'), release('v0.10.0')]).tag_name).toBe('v0.10.0');
    expect(newest([release('v1.0.0', { draft: true })])).toBeNull();
  });

  it('becomes redirects for each file, and the release page for a file it lacks', () => {
    const conf = redirects(release('v0.2.1'));
    expect(conf).toContain('location = /download/win-x64 { return 302 https://github.com/anaremore/chord-browser/releases/download/x/Chord-0.2.1-win-x64-setup.exe; }');
    expect(conf).toContain('location = /download/deb-amd64 { return 302 https://github.com/anaremore/chord-browser/releases/tag/v0.2.1; }');
    expect(conf).toContain('location ^~ /download/ { return 302 https://github.com/anaremore/chord-browser/releases/tag/v0.2.1; }');
    expect(summary(release('v0.2.1'))).toMatchObject({ version: '0.2.1', files: { 'win-x64': { size: 126e6 }, 'mac-arm64': { size: 125e6 } } });
  });
});
