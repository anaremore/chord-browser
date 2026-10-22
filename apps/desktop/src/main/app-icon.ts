/**
 * Chord's icon where the OS takes it from the running app (DESIGN.md §2).
 * Packaged Windows and macOS builds carry it in the .exe and the .app, but a
 * development run is Electron's own binary, which shows Electron's icon; and
 * Linux window managers read the icon from the window itself.
 */
import { app, type BaseWindowConstructorOptions } from 'electron';
import windowsIcon from '../../build/icon.ico?asset';
import png from '../../build/icons/512x512.png?asset';

/** The `icon` option for Chord's windows. */
export function windowIcon(): Pick<BaseWindowConstructorOptions, 'icon'> {
  if (process.platform === 'linux') return { icon: png };
  // Packaged, the window takes the .exe's icon, with every size drawn for its size.
  if (process.platform === 'win32' && !app.isPackaged) return { icon: windowsIcon };
  return {};
}

/** Development only: the Dock would show Electron's icon. A packaged app's comes from its bundle. */
export function showDevelopmentDockIcon(): void {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(png);
}
