import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedPage } from '@chord/core';
import { detectProfiles, parseIni, type FoundProfile, type ImportEnv } from '../../src/import/detect';
import { ImportProblem, openCopy, problemOf } from '../../src/import/files';
import { pagesOf } from '../../src/import/history';
import { openHistory, readProfile } from '../../src/import/read';
import { browserRoots, makeBrowserFixtures, makeChrome, makeFirefox, makeSafari, type FixturePlatform } from '../fixtures/browsers';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 24, 12);

let home: string;
let temp: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chord-import-home-'));
  temp = mkdtempSync(join(tmpdir(), 'chord-import-copies-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

const envFor = (platform: FixturePlatform): ImportEnv => ({
  platform,
  home,
  localAppData: join(home, 'AppData/Local'),
  appData: join(home, 'AppData/Roaming'),
  configHome: join(home, '.config'),
});

/** Every page a profile's history holds, read the way an import does. */
async function allPages(profile: FoundProfile): Promise<ImportedPage[]> {
  const history = await openHistory(profile, temp);
  const pages: ImportedPage[] = [];
  for (let next = history.batches.next(); !next.done; next = history.batches.next()) pages.push(...next.value);
  history.close();
  return pages;
}

/** A fingerprint of every file under a folder: what it holds and when it last changed. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else out[path] = `${createHash('sha256').update(readFileSync(path)).digest('hex')}:${s.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

describe('finding browsers', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('finds Chrome’s and Firefox’s profiles (and Safari on macOS) where %s keeps them', async (platform) => {
    makeBrowserFixtures(home, platform, { now });
    const found = await detectProfiles(envFor(platform));
    expect(found.map((p) => [p.browser, p.name])).toEqual([
      ['chrome', 'Alex'],
      ['chrome', 'Work'],
      // The install's default profile; the other one has no data.
      ['firefox', 'default-release'],
      ...(platform === 'darwin' ? [['safari', 'Safari']] : []),
    ]);
  });

  it('finds Flatpak and Snap copies on Linux, and Firefox’s newer XDG folder', async () => {
    makeFirefox(join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'), { now });
    makeChrome(join(home, 'snap/brave/current/.config/BraveSoftware/Brave-Browser'), { now });
    makeFirefox(join(home, '.config/mozilla/firefox'), { now });
    const found = await detectProfiles(envFor('linux'));
    expect(found.map((p) => [p.browser, p.variant])).toEqual([
      ['brave', 'snap'],
      ['brave', 'snap'],
      ['firefox', null],
      ['firefox', 'flatpak'],
    ]);
  });

  it('finds nothing in an empty home, and never follows a profile name out of its folder', async () => {
    expect(await detectProfiles(envFor('linux'))).toEqual([]);
    const root = browserRoots(home, 'linux').chrome;
    makeChrome(root, { now });
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
    state.profile.info_cache['../../escape'] = { name: 'Escape' };
    mkdirSync(join(home, 'escape'), { recursive: true });
    copyFileSync(join(root, 'Default', 'Bookmarks'), join(home, 'escape', 'Bookmarks'));
    writeFileSync(join(root, 'Local State'), JSON.stringify(state));
    expect((await detectProfiles(envFor('linux'))).map((p) => p.name)).toEqual(['Alex', 'Work']);
  });

  it('reads profiles.ini sections, comments and Windows line endings', () => {
    const ini = parseIni('; comment\r\n[Profile0]\r\nName=default\r\nPath=Profiles/x.default\r\n\r\n[General]\r\nVersion=2\r\n');
    expect(ini.get('Profile0')?.get('Path')).toBe('Profiles/x.default');
    expect(ini.get('General')?.get('Version')).toBe('2');
  });

  it('says Full Disk Access on macOS, a lock on Windows, and missing for a file that isn’t there', () => {
    const error = (code: string) => Object.assign(new Error(code), { code });
    expect(problemOf(error('EPERM'), 'darwin')).toBe('denied');
    expect(problemOf(error('EBUSY'), 'win32')).toBe('locked');
    expect(problemOf(error('ENOENT'), 'linux')).toBe('missing');
    expect(problemOf(error('EIO'), 'linux')).toBe('unreadable');
  });
});

describe('Chromium', () => {
  it('reads bookmarks with each root’s name, history in batches, and no open tabs', async () => {
    const dir = makeChrome(join(home, 'chrome'), { now });
    const profile: FoundProfile = { browser: 'edge', name: 'Alex', dir, variant: null, denied: false };
    const preview = await readProfile(profile, temp);
    expect(preview.roots.map((r) => [r.kind, r.title, r.items.length])).toEqual([
      ['bar', 'Favorites bar', 4],
      ['other', 'Other favorites', 1],
      ['other', 'Mobile favorites', 0],
    ]);
    const recipes = preview.roots[0]!.items[1]!;
    expect(recipes).toEqual({
      kind: 'folder',
      title: 'Recipes',
      items: [
        { kind: 'link', title: 'Apple pie', url: 'https://recipes.test/pie' },
        { kind: 'folder', title: 'Soups', items: [{ kind: 'link', title: 'Tomato soup', url: 'https://recipes.test/soup' }] },
      ],
    });
    expect(preview.tabs).toBeNull();
    // Frames inside pages, hidden rows and browser pages aren't history.
    expect(preview.history).toBe(2);
    const pages = await allPages(profile);
    expect(pages).toEqual([
      { url: 'https://recipes.test/pie', title: 'Apple pie recipe', visits: [now - 3 * DAY, now - DAY], typed: [now - DAY] },
      { url: 'https://news.test/', title: 'Morning news', visits: [now - 2 * DAY], typed: [now - 2 * DAY] },
    ]);
  });

  it('streams a big history a batch at a time', async () => {
    const dir = makeChrome(join(home, 'chrome'), { now, extraPages: 3000 });
    const profile: FoundProfile = { browser: 'chrome', name: 'Alex', dir, variant: null, denied: false };
    expect((await readProfile(profile, temp)).history).toBe(3002);
    const history = await openHistory(profile, temp);
    const sizes: number[] = [];
    let visits = 0;
    for (let next = history.batches.next(); !next.done; next = history.batches.next()) {
      sizes.push(next.value.length);
      visits += next.value.reduce((n, p) => n + p.visits.length, 0);
    }
    history.close();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3002);
    expect(visits).toBe(3 + 9000);
  });
});

describe('Firefox', () => {
  it('reads bookmarks by Places’ roots (no tags), history without embeds, and open tabs (never a private window’s)', async () => {
    const dir = makeFirefox(join(home, 'firefox'), { now });
    const profile: FoundProfile = { browser: 'firefox', name: 'default-release', dir, variant: null, denied: false };
    const preview = await readProfile(profile, temp);
    expect(preview.roots).toEqual([
      {
        kind: 'bar',
        title: 'Bookmarks Toolbar',
        items: [
          { kind: 'link', title: 'Firefox News', url: 'https://news.test/ff' },
          { kind: 'folder', title: 'Reading', items: [{ kind: 'link', title: 'Long read', url: 'https://longread.test/a' }] },
        ],
      },
      { kind: 'other', title: 'Bookmarks Menu', items: [{ kind: 'folder', title: 'Mozilla Firefox', items: [{ kind: 'link', title: 'Get Help', url: 'https://support.mozilla.test/' }] }] },
      { kind: 'other', title: 'Other Bookmarks', items: [{ kind: 'link', title: 'Later', url: 'https://later.test/' }] },
      { kind: 'other', title: 'Mobile Bookmarks', items: [] },
    ]);
    expect(preview.tabs).toEqual([
      { url: 'https://open.test/two', title: 'Two' },
      { url: 'about:newtab', title: 'New Tab' },
      { url: 'https://open.test/three', title: 'Three' },
    ]);
    expect(preview.history).toBe(2);
    expect(await allPages(profile)).toEqual([
      { url: 'https://news.test/ff', title: 'Firefox news', visits: [now - 2 * DAY, now - DAY], typed: [now - DAY] },
      { url: 'https://longread.test/a', title: 'A long read', visits: [now - 5 * DAY], typed: [] },
    ]);
  });

  it('reads recent changes still waiting in the write-ahead log of a database the browser has open', async () => {
    const dir = makeFirefox(join(home, 'firefox'), { now });
    // Firefox running: places.sqlite in WAL mode, with a bookmark nobody has checkpointed yet.
    const live = new DatabaseSync(join(dir, 'places.sqlite'));
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    live.exec(`INSERT INTO moz_places (id, url, title, visit_count, hidden) VALUES (99, 'https://fresh.test/', 'Fresh', 0, 0)`);
    live.exec(`INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (99, 1, 99, 5, 1, 'Fresh', 'bm99')`);
    try {
      const before = fingerprint(dir);
      const preview = await readProfile({ browser: 'firefox', name: 'x', dir, variant: null, denied: false }, temp);
      expect(preview.roots[2]!.items.map((i) => i.title)).toEqual(['Later', 'Fresh']);
      // The browser's own files are exactly as they were.
      expect(fingerprint(dir)).toEqual(before);
    } finally {
      live.close();
    }
  });

  it('falls back to the session file Firefox writes on quitting, and takes a damaged one as no tabs', async () => {
    const dir = makeFirefox(join(home, 'firefox'), { now });
    renameSync(join(dir, 'sessionstore-backups', 'recovery.jsonlz4'), join(dir, 'sessionstore.jsonlz4'));
    const profile: FoundProfile = { browser: 'firefox', name: 'x', dir, variant: null, denied: false };
    expect((await readProfile(profile, temp)).tabs).toHaveLength(3);
    writeFileSync(join(dir, 'sessionstore.jsonlz4'), 'mozLz40\0garbage');
    expect((await readProfile(profile, temp)).tabs).toEqual([]);
  });
});

describe('Safari', () => {
  it('reads Favorites, the menu, the Reading List and folders at the top from the binary plist, and History.db', async () => {
    const dir = makeSafari(join(home, 'Library/Safari'), { now });
    const profile: FoundProfile = { browser: 'safari', name: 'Safari', dir, variant: null, denied: false };
    const preview = await readProfile(profile, temp);
    expect(preview.roots.map((r) => [r.kind, r.title])).toEqual([
      ['bar', 'Favorites'],
      ['other', 'Bookmarks Menu'],
      ['other', 'Reading List'],
      ['other', 'Bookmarks'],
    ]);
    expect(preview.roots[0]!.items[1]).toEqual({ kind: 'folder', title: 'Café ☕', items: [{ kind: 'link', title: 'Espresso', url: 'https://coffee.test/espresso' }] });
    expect(preview.roots[3]!.items).toEqual([{ kind: 'folder', title: 'Trips', items: [{ kind: 'link', title: 'Lisbon', url: 'https://travel.test/lisbon' }] }]);
    expect(preview.tabs).toBeNull();
    const pages = await allPages(profile);
    // The newest visit's title wins; Apple's epoch converts to Unix time.
    expect(pages.map((p) => [p.url, p.title, p.visits])).toEqual([
      ['https://apple.test/', 'Apple', [now - 2 * DAY, now - DAY]],
      ['https://coffee.test/espresso', 'Espresso', [now - 3 * DAY]],
    ]);
  });

  it('says it needs Full Disk Access rather than reading', async () => {
    await expect(readProfile({ browser: 'safari', name: 'Safari', dir: join(home, 'nope'), variant: null, denied: true }, temp)).rejects.toThrow(ImportProblem);
  });
});

describe('copies', () => {
  it('reads a copy of each database, never the browser’s own files', async () => {
    const { chrome, firefox } = makeBrowserFixtures(home, 'linux', { now });
    const before = fingerprint(home);
    await readProfile({ browser: 'chrome', name: 'Alex', dir: chrome, variant: null, denied: false }, temp);
    await allPages({ browser: 'firefox', name: 'x', dir: firefox, variant: null, denied: false });
    expect(fingerprint(home)).toEqual(before);
    expect(readdirSync(temp).some((name) => name.endsWith('History'))).toBe(true);
    expect(await openCopy(join(home, 'missing.sqlite'), temp)).toBeNull();
  });

  it('groups visit rows into pages, batching by pages and by visits', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: Math.floor(i / 2), url: `https://p${Math.floor(i / 2)}.test/`, title: 'T', at: now - i, typed: i % 2 }));
    const batches = [...pagesOf(rows, 250)];
    expect(batches.map((b) => b.length)).toEqual([250, 250, 100]);
    expect(batches[0]![0]).toEqual({ url: 'https://p0.test/', title: 'T', visits: [now, now - 1], typed: [now - 1] });
  });
});
