/**
 * Which browsers are on this computer, and their profiles (ARCHITECTURE.md
 * §9, Import). Only names and the presence of files are read here; nothing is
 * opened for writing. Runs in the import utility process, never on main.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { ImportBrowser } from '@chord/core';

/** Where to look. Main fills it from the OS, or, in development builds, from CHORD_IMPORT_ROOT. */
export interface ImportEnv {
  platform: 'win32' | 'darwin' | 'linux';
  home: string;
  /** Windows' %LOCALAPPDATA%: Chromium browsers. */
  localAppData: string;
  /** Windows' %APPDATA%: Firefox. */
  appData: string;
  /** Linux's $XDG_CONFIG_HOME. Inside a Flatpak that's Chord's own, so ~/.config is looked in too. */
  configHome: string;
}

export interface FoundProfile {
  browser: ImportBrowser;
  /** The profile's name in its browser ("Person 1", "default-release"); the browser's name for Safari. */
  name: string;
  /** The profile's folder (Safari: ~/Library/Safari). */
  dir: string;
  /** A Flatpak or Snap copy of the browser (Linux). */
  variant: 'flatpak' | 'snap' | null;
  /** Safari without Full Disk Access: listed, so Chord can say how to grant it, but unreadable. */
  denied: boolean;
}

interface Place {
  path: string;
  variant: FoundProfile['variant'];
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** The folders a Chromium browser keeps its profiles in, on this OS. */
function chromiumPlaces(browser: 'chrome' | 'edge' | 'brave', env: ImportEnv): Place[] {
  const at = (path: string, variant: Place['variant'] = null): Place => ({ path, variant });
  const configs = [...new Set([env.configHome, join(env.home, '.config')])];
  switch (env.platform) {
    case 'win32':
      return [at(join(env.localAppData, { chrome: 'Google/Chrome/User Data', edge: 'Microsoft/Edge/User Data', brave: 'BraveSoftware/Brave-Browser/User Data' }[browser]))];
    case 'darwin':
      return [at(join(env.home, 'Library/Application Support', { chrome: 'Google/Chrome', edge: 'Microsoft Edge', brave: 'BraveSoftware/Brave-Browser' }[browser]))];
    case 'linux': {
      const folder = { chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'BraveSoftware/Brave-Browser' }[browser];
      const flatpak = { chrome: 'com.google.Chrome', edge: 'com.microsoft.Edge', brave: 'com.brave.Browser' }[browser];
      const places = [...configs.map((c) => at(join(c, folder))), at(join(env.home, '.var/app', flatpak, 'config', folder), 'flatpak')];
      if (browser === 'brave') places.push(at(join(env.home, 'snap/brave/current/.config', folder), 'snap'));
      return places;
    }
  }
}

function firefoxPlaces(env: ImportEnv): Place[] {
  const at = (path: string, variant: Place['variant'] = null): Place => ({ path, variant });
  switch (env.platform) {
    case 'win32':
      return [at(join(env.appData, 'Mozilla/Firefox'))];
    case 'darwin':
      return [at(join(env.home, 'Library/Application Support/Firefox'))];
    case 'linux':
      // Newer Firefox keeps new profiles under XDG's config folder; older ones in ~/.mozilla.
      return [
        at(join(env.home, '.mozilla/firefox')),
        ...[...new Set([env.configHome, join(env.home, '.config')])].map((c) => at(join(c, 'mozilla/firefox'))),
        at(join(env.home, '.var/app/org.mozilla.firefox/.mozilla/firefox'), 'flatpak'),
        at(join(env.home, '.var/app/org.mozilla.firefox/config/mozilla/firefox'), 'flatpak'),
        at(join(env.home, 'snap/firefox/common/.mozilla/firefox'), 'snap'),
      ];
  }
}

/** A Chromium browser's profiles, from `Local State` (their names and order); a profile counts if it has bookmarks or history. */
async function chromiumProfiles(browser: 'chrome' | 'edge' | 'brave', place: Place): Promise<FoundProfile[]> {
  let dirs: string[] = [];
  const names = new Map<string, string>();
  try {
    const state = JSON.parse(await readFile(join(place.path, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: unknown }>; profiles_order?: unknown } };
    const cache = state.profile?.info_cache ?? {};
    for (const [dir, info] of Object.entries(cache)) if (typeof info?.name === 'string') names.set(dir, info.name);
    const order = Array.isArray(state.profile?.profiles_order) ? state.profile.profiles_order.filter((d): d is string => typeof d === 'string') : [];
    dirs = [...new Set([...order, ...Object.keys(cache)])];
  } catch {
    // No Local State (or one Chord can't read): the default profile, if it's there.
  }
  if (dirs.length === 0) dirs = ['Default'];
  const found: FoundProfile[] = [];
  for (const dir of dirs) {
    // Only plain folder names: Local State is the other browser's file, not a path to follow.
    if (dir.includes('/') || dir.includes('\\') || dir === '..' || dir === '.') continue;
    const path = join(place.path, dir);
    if (!(await exists(join(path, 'Bookmarks'))) && !(await exists(join(path, 'History')))) continue;
    found.push({ browser, name: names.get(dir) || dir, dir: path, variant: place.variant, denied: false });
  }
  return found;
}

/** profiles.ini's sections, each a map of its keys. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1]!, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
}

/** Firefox's profiles from profiles.ini, the one it opens by default first; a profile counts if it has places.sqlite. */
async function firefoxProfiles(place: Place): Promise<FoundProfile[]> {
  let ini: Map<string, Map<string, string>>;
  try {
    ini = parseIni(await readFile(join(place.path, 'profiles.ini'), 'utf8'));
  } catch {
    return [];
  }
  const installDefaults = new Set([...ini.entries()].filter(([name]) => name.startsWith('Install')).map(([, keys]) => keys.get('Default') ?? ''));
  const profiles: { name: string; path: string; rank: number }[] = [];
  for (const [section, keys] of ini) {
    const relative = keys.get('Path');
    if (!section.startsWith('Profile') || !relative) continue;
    const path = keys.get('IsRelative') === '0' && isAbsolute(relative) ? normalize(relative) : join(place.path, relative);
    const rank = installDefaults.has(relative) ? 0 : keys.get('Default') === '1' ? 1 : 2;
    profiles.push({ name: keys.get('Name') || relative, path, rank });
  }
  const found: FoundProfile[] = [];
  for (const p of profiles.sort((a, b) => a.rank - b.rank)) {
    if (await exists(join(p.path, 'places.sqlite'))) found.push({ browser: 'firefox', name: p.name, dir: p.path, variant: place.variant, denied: false });
  }
  return found;
}

/** Safari (macOS): its folder needs Full Disk Access; without it, reading fails with EPERM. */
async function safariProfile(env: ImportEnv): Promise<FoundProfile[]> {
  const dir = join(env.home, 'Library/Safari');
  try {
    if (!(await stat(dir)).isDirectory()) return [];
    const files = await readdir(dir);
    if (!files.includes('Bookmarks.plist') && !files.includes('History.db')) return [];
    return [{ browser: 'safari', name: 'Safari', dir, variant: null, denied: false }];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? [{ browser: 'safari', name: 'Safari', dir, variant: null, denied: true }] : [];
  }
}

/** Every importable profile on this computer: Chrome, Edge, Brave, Firefox, then Safari. */
export async function detectProfiles(env: ImportEnv): Promise<FoundProfile[]> {
  const found: FoundProfile[] = [];
  const seen = new Set<string>();
  const add = (profiles: FoundProfile[]) => {
    for (const p of profiles) {
      if (seen.has(p.dir)) continue;
      seen.add(p.dir);
      found.push(p);
    }
  };
  for (const browser of ['chrome', 'edge', 'brave'] as const) {
    for (const place of chromiumPlaces(browser, env)) add(await chromiumProfiles(browser, place));
  }
  for (const place of firefoxPlaces(env)) add(await firefoxProfiles(place));
  if (env.platform === 'darwin') add(await safariProfile(env));
  return found;
}
