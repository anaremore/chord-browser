import { join } from 'node:path';
import { app } from 'electron';
import { userDataOverride } from './user-data';

/** Fixed forever: data paths, Flatpak and default-browser registration use it (ARCHITECTURE.md §15.0). */
export const APP_ID = 'com.chordbrowser.Chord';

/**
 * Must run before `ready`. Development builds use separate data ("Chord Dev")
 * so working on Chord never touches your real profile.
 */
export function configureAppIdentity(): void {
  const name = app.isPackaged ? 'Chord' : 'Chord Dev';
  app.setName(name);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  // A throwaway profile: `--user-data-dir=<path>` in any build, CHORD_USER_DATA in development.
  // The single-instance lock follows userData, so such a run doesn't hand off to a running Chord.
  const override = userDataOverride(
    app.commandLine.getSwitchValue('user-data-dir'),
    app.isPackaged ? undefined : process.env['CHORD_USER_DATA'],
    process.cwd(),
  );
  if (override) {
    app.setPath('userData', override);
  } else if (process.platform === 'win32') {
    // Browsers keep multi-GB profiles in Local AppData, not Roaming (ARCHITECTURE.md §7).
    const local = process.env['LOCALAPPDATA'] ?? join(app.getPath('appData'), '..', 'Local');
    app.setPath('userData', join(local, name, 'User Data'));
  } else {
    app.setPath('userData', join(app.getPath('appData'), name));
  }
}
