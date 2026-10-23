/**
 * Chord as the default browser (ARCHITECTURE.md §15, ROADMAP M1.5). The
 * installer or package registers Chord as a browser the OS can offer; this
 * module reports whether it's the default and asks the OS to make it so.
 *
 * - Windows: no app may make itself the default (UserChoice is protected), so
 *   "Make default" opens Settings → Default apps at Chord's page.
 * - macOS: Launch Services, which shows the system's own confirmation.
 * - Linux: xdg-settings, through Electron and directly.
 * - Flatpak: neither. The sandbox has no view of the system's choice and no
 *   portal changes it, so Settings points to the system's own settings; the
 *   .desktop file's MIME types are what list Chord there.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DefaultBrowserStatus } from '@chord/ipc';
import { app, shell } from 'electron';
import { APP_ID } from './identity';
import { progIdIn } from './os-links';

export type { DefaultBrowserStatus };

const run = promisify(execFile);
/** Flatpak sets FLATPAK_ID inside every sandbox it starts. */
const inFlatpak = process.platform === 'linux' && Boolean(process.env['FLATPAK_ID']);
/** The ProgId the Windows installer registers for web links (build/installer.nsh). */
const WINDOWS_PROG_ID = 'ChordHTML';
const URL_ASSOCIATIONS = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';

async function windowsHttpsProgId(): Promise<string | null> {
  // Newer Windows 11 builds keep the live choice in UserChoiceLatest\ProgId; older ones in UserChoice.
  for (const key of [`${URL_ASSOCIATIONS}\\UserChoiceLatest\\ProgId`, `${URL_ASSOCIATIONS}\\UserChoice`]) {
    try {
      const { stdout } = await run('reg', ['query', key, '/v', 'ProgId'], { windowsHide: true, timeout: 5000 });
      const progId = progIdIn(stdout);
      if (progId) return progId;
    } catch {
      // The key doesn't exist on this Windows build; try the next.
    }
  }
  return null;
}

/** Development builds aren't registered with the OS, so they can't be the default. */
export async function defaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (!app.isPackaged) return 'unavailable';
  if (inFlatpak) return 'system';
  if (process.platform === 'win32') return (await windowsHttpsProgId()) === WINDOWS_PROG_ID ? 'default' : 'not-default';
  return app.isDefaultProtocolClient('https') ? 'default' : 'not-default';
}

export async function makeDefaultBrowser(): Promise<void> {
  if (!app.isPackaged || inFlatpak) return;
  if (process.platform === 'win32') {
    // Matches the RegisteredApplications value the installer writes.
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Chord');
    return;
  }
  app.setAsDefaultProtocolClient('http');
  app.setAsDefaultProtocolClient('https');
  if (process.platform === 'linux') {
    // Also covers text/html for desktops that read the web-browser setting rather than each scheme.
    await run('xdg-settings', ['set', 'default-web-browser', `${APP_ID}.desktop`], { timeout: 5000 }).catch(() => {});
  }
}
