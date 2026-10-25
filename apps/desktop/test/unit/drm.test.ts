import { posix, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned: { command: string; args: string[] }[] = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    return { on: () => undefined, unref: () => undefined };
  },
}));

const { DrmNotices, drmServiceFor, findBrowsers } = await import('../../src/main/drm');
type LaunchEnv = Parameters<typeof findBrowsers>[0];

const env = (over: Partial<LaunchEnv>): LaunchEnv => ({ platform: 'linux', home: '/home/me', programRoots: [], path: ['/usr/local/bin', '/usr/bin'], sandboxed: false, ...over });
const only = (files: string[]) => async (file: string) => files.includes(file);

afterEach(() => {
  spawned.length = 0;
});

describe('drmServiceFor', () => {
  it('knows the top services by the addresses that play, subdomains included', () => {
    expect(drmServiceFor('https://www.netflix.com/watch/80100172')).toBe('Netflix');
    expect(drmServiceFor('https://open.spotify.com/album/1')).toBe('Spotify');
    expect(drmServiceFor('https://play.hbomax.com/')).toBe('HBO Max');
    expect(drmServiceFor('https://www.amazon.co.uk/gp/video/detail/B0')).toBe('Prime Video');
    expect(drmServiceFor('https://music.apple.com/us/album/x')).toBe('Apple Music');
  });

  it('leaves the rest alone: a service’s other sites, look-alikes, Amazon’s shop, and anything not on the web', () => {
    expect(drmServiceFor('https://www.spotify.com/us/premium/')).toBeNull();
    expect(drmServiceFor('https://apple.com/music/')).toBeNull();
    expect(drmServiceFor('https://notnetflix.com/')).toBeNull();
    expect(drmServiceFor('https://netflix.com.example.org/')).toBeNull();
    expect(drmServiceFor('https://www.amazon.com/gp/videogames')).toBeNull();
    expect(drmServiceFor('https://www.amazon.com/dp/B0')).toBeNull();
    expect(drmServiceFor('chord://settings/')).toBeNull();
    expect(drmServiceFor('file:///home/me/netflix.com')).toBeNull();
  });
});

describe('findBrowsers', () => {
  it('Windows: each browser’s first install, for everyone or for one user, in order', async () => {
    const roots = ['C:/Program Files', 'C:/Program Files (x86)', 'C:/Users/me/AppData/Local'];
    const found = await findBrowsers(
      env({ platform: 'win32', programRoots: roots }),
      only([win32.join(roots[2]!, 'Google/Chrome/Application/chrome.exe'), win32.join(roots[1]!, 'Microsoft/Edge/Application/msedge.exe')]),
    );
    expect(found.map((b) => [b.id, b.command])).toEqual([
      ['chrome', win32.join(roots[2]!, 'Google/Chrome/Application/chrome.exe')],
      ['edge', win32.join(roots[1]!, 'Microsoft/Edge/Application/msedge.exe')],
    ]);
  });

  it('macOS: apps open with `open -a`, Safari among them', async () => {
    const found = await findBrowsers(env({ platform: 'darwin' }), only(['/Applications/Safari.app', posix.join('/home/me', 'Applications', 'Firefox.app')]));
    expect(found.map((b) => [b.id, b.command, b.args])).toEqual([
      ['firefox', '/usr/bin/open', ['-a', posix.join('/home/me', 'Applications', 'Firefox.app')]],
      ['safari', '/usr/bin/open', ['-a', '/Applications/Safari.app']],
    ]);
  });

  it('Linux: on the PATH or as a Flatpak; none from inside Chord’s own Flatpak', async () => {
    const files = [posix.join('/usr/bin', 'google-chrome-stable'), '/var/lib/flatpak/exports/bin/org.mozilla.firefox'];
    expect((await findBrowsers(env({}), only(files))).map((b) => [b.id, b.command])).toEqual([
      ['chrome', posix.join('/usr/bin', 'google-chrome-stable')],
      ['firefox', '/var/lib/flatpak/exports/bin/org.mozilla.firefox'],
    ]);
    expect(await findBrowsers(env({ sandboxed: true }), only(files))).toEqual([]);
  });
});

describe('DrmNotices', () => {
  const CHROME = { id: 'chrome' as const, file: '/usr/bin/google-chrome', command: '/usr/bin/google-chrome', args: [] };
  const FIREFOX = { id: 'firefox' as const, file: '/usr/bin/firefox', command: '/usr/bin/firefox', args: [] };
  const SAFARI = { id: 'safari' as const, file: '/Applications/Safari.app', command: '/usr/bin/open', args: ['-a', '/Applications/Safari.app'] };
  const setUp = (browsers = [CHROME, FIREFOX, SAFARI]) => {
    const changed = vi.fn();
    const find = vi.fn(async () => browsers);
    const notices = new DrmNotices({ browsers: find, changed, platform: 'win32' });
    return { notices, changed, find };
  };

  it('shows on a service once the other browsers are found, up to two; Not now hides it for that service only', async () => {
    const { notices, changed, find } = setUp();
    expect(notices.noticeFor('https://example.com/')).toBeNull();
    // Not yet looked: nothing until the card can arrive whole.
    expect(notices.noticeFor('https://www.netflix.com/browse')).toBeNull();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(notices.noticeFor('https://www.netflix.com/browse')).toEqual({
      service: 'Netflix',
      browsers: [
        { id: 'chrome', name: 'Chrome' },
        { id: 'firefox', name: 'Firefox' },
      ],
      player: null,
      linux: false,
    });
    // Looked for once.
    notices.noticeFor('https://www.hulu.com/');
    expect(find).toHaveBeenCalledTimes(1);
    notices.dismiss('https://www.netflix.com/title/1');
    expect(notices.noticeFor('https://www.netflix.com/browse')).toBeNull();
    expect(notices.noticeFor('https://www.hulu.com/')).toMatchObject({ service: 'Hulu' });
  });

  it('opens only a service’s page, only in a browser it found, then hides the notice', async () => {
    const { notices, changed } = setUp([CHROME, SAFARI]);
    notices.noticeFor('https://www.netflix.com/');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    notices.open('https://example.com/', 'chrome');
    notices.open('https://www.netflix.com/watch/1', 'edge');
    expect(spawned).toEqual([]);
    notices.open('https://www.netflix.com/watch/1', 'safari');
    expect(spawned).toEqual([{ command: '/usr/bin/open', args: ['-a', '/Applications/Safari.app', 'https://www.netflix.com/watch/1'] }]);
    expect(notices.noticeFor('https://www.netflix.com/')).toBeNull();
  });

  it('with no other browser, the notice says so and offers none', async () => {
    const { notices, changed } = setUp([]);
    notices.noticeFor('https://open.spotify.com/');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(notices.noticeFor('https://open.spotify.com/')).toEqual({ service: 'Spotify', browsers: [], player: null, linux: false });
  });

  it('offers Chord Player once Chord knows what it can offer, and waits for it so the card arrives whole', async () => {
    const { notices, changed } = setUp([CHROME]);
    notices.noticeFor('https://www.netflix.com/');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(notices.noticeFor('https://www.netflix.com/', 'pending')).toBeNull();
    expect(notices.noticeFor('https://www.netflix.com/', { state: 'install', size: 160_000_000, update: false })).toMatchObject({
      service: 'Netflix',
      player: { state: 'install', size: 160_000_000 },
      browsers: [{ id: 'chrome', name: 'Chrome' }],
    });
    expect(notices.noticeFor('https://www.netflix.com/', { state: 'ready' })?.player).toEqual({ state: 'ready' });
  });
});
