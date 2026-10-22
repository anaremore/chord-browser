import { app, nativeTheme, session } from 'electron';
import { configureAppIdentity } from './identity';
import { handle } from './ipc';
import { systemInfo } from './platform';
import { handleChordProtocol, registerSchemes } from './protocol';
import { configureBrowsingSession, configureUiSession, hardenAllWebContents } from './security';
import { ChordWindow } from './window';

// Before `ready`: privileged schemes, identity (decides userData), sandbox for every renderer.
registerSchemes();
configureAppIdentity();
app.enableSandbox();

const windows = new Set<ChordWindow>();

function windowForShell(contentsId: number): ChordWindow | undefined {
  for (const w of windows) if (w.shell.webContents.id === contentsId) return w;
  return undefined;
}

function openWindow(): ChordWindow {
  const w = new ChordWindow({
    uiSession: session.fromPartition('chord-ui'),
    browsingSession: session.fromPartition('persist:default'),
  });
  windows.add(w);
  w.window.on('closed', () => windows.delete(w));
  return w;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [first] = windows;
    if (first) {
      if (first.window.isMinimized()) first.window.restore();
      first.window.focus();
    }
  });

  void app.whenReady().then(() => {
    // Development only: force an appearance for design QA captures.
    const forced = process.env['CHORD_APPEARANCE'];
    if (!app.isPackaged && (forced === 'light' || forced === 'dark')) nativeTheme.themeSource = forced;

    const ui = session.fromPartition('chord-ui');
    configureUiSession(ui);
    handleChordProtocol(ui);
    configureBrowsingSession(session.fromPartition('persist:default'));
    hardenAllWebContents();

    handle('system:info', () => systemInfo());
    handle('tab:current', (_request, sender) => {
      const w = windowForShell(sender.id);
      if (!w) throw new Error('No window for this shell');
      return w.tabState();
    });
    handle('nav:command', ({ action }, sender) => {
      windowForShell(sender.id)?.navigate(action);
    });

    openWindow();
  });

  app.on('activate', () => {
    if (windows.size === 0) openWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
