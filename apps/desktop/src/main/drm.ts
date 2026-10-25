/**
 * The DRM notice (ARCHITECTURE.md §16, D4). Chord's stock Electron has no
 * Widevine, so the top services that need it don't play. On their pages the
 * popover says so. It offers Chord Player first, once it can (installing it
 * if it isn't yet: main/player/), then *Open in…* up to two other browsers on
 * this computer. Services are recognized by address, from the list Chord
 * Player's navigation lock shares (@chord/player-protocol): catching a page's
 * own request for DRM would need a script in every page. Opening the page
 * "externally" isn't enough: with Chord the default browser, it would come
 * straight back.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { servicePlaying } from '@chord/player-protocol';
import type { DrmNotice, OtherBrowserId, PlayerOffer } from '@chord/ipc';

/** The service a page is on, by its address, if it's one that needs Widevine: the pages that play (Spotify's player, not its store). */
export function drmServiceFor(url: string): string | null {
  return servicePlaying(url)?.name ?? null;
}

const NAMES: Record<OtherBrowserId, string> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', brave: 'Brave' };

/** Every one of them plays these services (Brave asks first; Safari through Apple's own DRM). The card offers the first two found. */
const ORDER: OtherBrowserId[] = ['chrome', 'firefox', 'edge', 'safari', 'brave'];

/** Where to look, from the OS. */
export interface LaunchEnv {
  platform: NodeJS.Platform;
  home: string;
  /** Windows: %ProgramFiles%, %ProgramFiles(x86)% and %LOCALAPPDATA% (installs for one user). */
  programRoots: string[];
  /** Linux: the folders in $PATH. */
  path: string[];
  /** Chord in a Flatpak: other apps can't be started from inside it. */
  sandboxed: boolean;
}

/** How to start a browser: the file that shows it's there, then the program and its arguments before the address. */
export interface Launcher {
  id: OtherBrowserId;
  file: string;
  command: string;
  args: string[];
}

const LINUX: Record<OtherBrowserId, { names: string[]; flatpak: string } | null> = {
  chrome: { names: ['google-chrome-stable', 'google-chrome'], flatpak: 'com.google.Chrome' },
  firefox: { names: ['firefox'], flatpak: 'org.mozilla.firefox' },
  edge: { names: ['microsoft-edge-stable', 'microsoft-edge'], flatpak: 'com.microsoft.Edge' },
  safari: null,
  brave: { names: ['brave-browser', 'brave'], flatpak: 'com.brave.Browser' },
};

/** Where a browser may be on this OS, most likely first. */
function candidates(id: OtherBrowserId, env: LaunchEnv): Launcher[] {
  const { join } = env.platform === 'win32' ? win32 : posix;
  const at = (file: string, command = file, args: string[] = []): Launcher => ({ id, file, command, args });
  switch (env.platform) {
    case 'win32': {
      const exe = { chrome: 'Google/Chrome/Application/chrome.exe', firefox: 'Mozilla Firefox/firefox.exe', edge: 'Microsoft/Edge/Application/msedge.exe', safari: null, brave: 'BraveSoftware/Brave-Browser/Application/brave.exe' }[id];
      return exe ? env.programRoots.map((root) => at(join(root, exe))) : [];
    }
    case 'darwin': {
      const app = { chrome: 'Google Chrome.app', firefox: 'Firefox.app', edge: 'Microsoft Edge.app', safari: 'Safari.app', brave: 'Brave Browser.app' }[id];
      return ['/Applications', join(env.home, 'Applications')].map((dir) => at(join(dir, app), '/usr/bin/open', ['-a', join(dir, app)]));
    }
    case 'linux': {
      const linux = LINUX[id];
      if (!linux) return [];
      const exports = ['/var/lib/flatpak/exports/bin', join(env.home, '.local/share/flatpak/exports/bin')];
      return [...linux.names.flatMap((name) => env.path.map((dir) => at(join(dir, name)))), ...exports.map((dir) => at(join(dir, linux.flatpak)))];
    }
    default:
      return [];
  }
}

const runnable = (file: string) => access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false);

/** The other browsers on this computer, in ORDER: each one's first place that's there. */
export async function findBrowsers(env: LaunchEnv, exists: (file: string) => Promise<boolean> = runnable): Promise<Launcher[]> {
  if (env.sandboxed) return [];
  const found = await Promise.all(
    ORDER.map(async (id) => {
      for (const launcher of candidates(id, env)) if (await exists(launcher.file)) return launcher;
      return null;
    }),
  );
  return found.filter((l): l is Launcher => l !== null);
}

/** The env Chord runs in. */
export function launchEnv(env: NodeJS.ProcessEnv, home: string): LaunchEnv {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return {
    platform: process.platform,
    home,
    programRoots: [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter((p): p is string => Boolean(p)),
    path: (env['PATH'] ?? '').split(delimiter).filter(Boolean),
    sandboxed: Boolean(env['FLATPAK_ID']),
  };
}

export interface DrmDeps {
  /** The other browsers on this computer (findBrowsers), looked for once. */
  browsers(): Promise<Launcher[]>;
  /** What the popover would show changed (the browsers were found, or a notice dismissed). */
  changed(): void;
  platform?: NodeJS.Platform;
}

export class DrmNotices {
  /** Services you said "Not now" to, or opened elsewhere, until Chord quits. */
  private readonly dismissed = new Set<string>();
  /** The other browsers, once looked for (the first time a service's page is shown). */
  private browsers: Launcher[] | null = null;
  private finding = false;

  constructor(private readonly deps: DrmDeps) {}

  /**
   * The notice for the page a window shows, if it needs one, with what it
   * offers of Chord Player (`pending` while Chord is still finding out). Null
   * until the other browsers are found and Chord Player is known, so the card
   * arrives whole.
   */
  noticeFor(url: string, player: PlayerOffer | null | 'pending' = null): DrmNotice | null {
    const service = drmServiceFor(url);
    if (!service || this.dismissed.has(service)) return null;
    if (!this.browsers) {
      void this.find();
      return null;
    }
    if (player === 'pending') return null;
    return { service, browsers: this.browsers.slice(0, 2).map((b) => ({ id: b.id, name: NAMES[b.id] })), player, linux: (this.deps.platform ?? process.platform) === 'linux' };
  }

  dismiss(url: string): void {
    const service = drmServiceFor(url);
    if (!service || this.dismissed.has(service)) return;
    this.dismissed.add(service);
    this.deps.changed();
  }

  /** Opens a service's page in one of the browsers the card offered: only a service's page, and only in a browser that's there. */
  open(url: string, browser: OtherBrowserId): void {
    const launcher = this.browsers?.find((b) => b.id === browser);
    if (!launcher || !drmServiceFor(url)) return;
    const child = spawn(launcher.command, [...launcher.args, url], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => console.warn(`[chord] Couldn't open ${NAMES[browser]}:`, error.message));
    child.unref();
    this.dismiss(url);
  }

  private async find(): Promise<void> {
    if (this.finding) return;
    this.finding = true;
    this.browsers = await this.deps.browsers().catch(() => []);
    this.deps.changed();
  }
}
