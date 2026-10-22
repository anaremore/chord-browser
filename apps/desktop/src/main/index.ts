import { restoreState, uuidv7, type Command, type WindowId } from '@chord/core';
import type { RendererCommand } from '@chord/ipc';
import { defaultChordStops, hexToRgb, rgbToOklch } from '@chord/tokens';
import { join } from 'node:path';
import { app, Menu, nativeTheme, session, type Session, type WebContents } from 'electron';
import { Browser } from './browser';
import { configureAppIdentity } from './identity';
import { handle } from './ipc';
import { DownloadManager } from './downloads';
import { PermissionBroker } from './permissions';
import { Persistence } from './persistence';
import { systemInfo } from './platform';
import { handleChordProtocol, registerSchemes } from './protocol';
import { configureUiSession, hardenAllWebContents } from './security';
import { chromiumUserAgent } from './user-agent';

// Before `ready`: privileged schemes, identity (decides userData), sandbox for every renderer.
registerSchemes();
configureAppIdentity();
app.enableSandbox();

// Google is the default search engine (decided 2026-10-22). Tests override the
// first page so CI never depends on the network.
const HOME_URL = (!app.isPackaged && process.env['CHORD_HOME_URL']) || 'https://www.google.com/';

let browser: Browser | undefined;
let persistence: Persistence | undefined;
const permissions = new PermissionBroker();
const downloads = new DownloadManager({
  state: () => browser!.store.state,
  dispatch: (command) => browser!.store.dispatch(command),
  newId: () => uuidv7(),
  defaultSession: () => profileSession('default'),
});
let profileSession: (profileId: string) => Session;

function senderWindow(sender: WebContents) {
  const w = browser?.windowFor(sender);
  if (!w) throw new Error('No window for this sender');
  return w;
}

/** Renderers may only act on their own window, whatever windowId they send. */
function scopeToWindow(command: RendererCommand, windowId: WindowId): Command {
  return 'windowId' in command ? { ...command, windowId } : command;
}

function registerIpc(): void {
  handle('system:info', () => systemInfo());
  handle('state:snapshot', (_request, sender) => ({ windowId: senderWindow(sender).id, state: browser!.store.state }));
  handle('cmd:dispatch', (command, sender) => {
    browser!.store.dispatch(scopeToWindow(command, senderWindow(sender).id));
  });
  handle('nav:command', ({ action }, sender) => {
    const contents = senderWindow(sender).activeTabContents;
    if (!contents) return;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
  });
  handle('overlay:open', ({ mode, anchor }, sender) => {
    const w = senderWindow(sender);
    w.openOverlay(mode, mode === 'edit' ? browser!.activeUrl(w.id) : '', anchor ?? null);
  });
  handle('download:action', ({ id, action }) => downloads.run(id, action));
  handle('downloads:openFolder', () => downloads.openFolder());
  handle('overlay:close', (_request, sender) => senderWindow(sender).closeOverlay());
  handle('layout:anchor', (rect, sender) => senderWindow(sender).setAnchor(rect));
  handle('menu:app', (anchor, sender) => browser!.openAppMenu(sender, anchor));
  handle('menu:tab', ({ nodeId, x, y }, sender) => browser!.openTabMenu(sender, nodeId, { x, y }));
  handle('menu:chord', ({ chordId, x, y }, sender) => browser!.openChordMenu(sender, chordId, { x, y }));
  handle('action:run', ({ action }, sender) => {
    browser!.run(action, sender);
  });
  handle('settings:snapshot', () => browser!.settingsSnapshot());
  handle('settings:set', (settings) => browser!.store.dispatch({ t: 'settings.set', settings }));
  handle('settings:theme', ({ chordId, theme }) => browser!.store.dispatch({ t: 'chord.theme', chordId, theme }));
  handle('settings:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: systemInfo().platform,
    arch: process.arch,
  }));
  handle('settings:openUrl', ({ url }) => browser!.openUrlInLastWindow(url));
  handle('popover:state', (_request, sender) => browser!.popoverState(senderWindow(sender)));
  handle('popover:size', ({ width, height }, sender) => senderWindow(sender).setPopoverSize(width, height));
  handle('find:query', ({ text, forward }, sender) => browser!.findFor(sender)?.query(text, forward));
  handle('find:close', (_request, sender) => browser!.findFor(sender)?.close());
  handle('permission:respond', ({ id, decision }) => permissions.respond(id, decision));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    browser?.focusFirstWindow();
  });

  // macOS keeps running with no windows; the Dock icon brings the last one back.
  app.on('activate', () => {
    if (browser?.windowCount === 0) browser.start();
  });

  // Flush unsaved changes before quitting (capped at 2 s inside close()).
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed || !persistence) return;
    event.preventDefault();
    flushed = true;
    void persistence.close().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    // Development only: force an appearance for design QA captures.
    const forced = process.env['CHORD_APPEARANCE'];
    if (!app.isPackaged && (forced === 'light' || forced === 'dark')) nativeTheme.themeSource = forced;

    // Standard Chromium user agent (decision S2). Development builds can set
    // CHORD_UA=electron to compare against Electron's default.
    if (app.isPackaged || process.env['CHORD_UA'] !== 'electron') {
      app.userAgentFallback = chromiumUserAgent(app.userAgentFallback, app.getName());
    }

    const ui = session.fromPartition('chord-ui');
    configureUiSession(ui);
    handleChordProtocol(ui);
    hardenAllWebContents();

    const profiles = new Map<string, Session>();
    profileSession = (profileId: string) => {
      let ses = profiles.get(profileId);
      if (!ses) {
        ses = session.fromPartition(profileId === 'default' ? 'persist:default' : `persist:p-${profileId}`);
        permissions.attach(ses);
        downloads.attach(ses);
        profiles.set(profileId, ses);
      }
      return ses;
    };

    // Session restore: what chord-data saved, repaired; or a first chord in the OS accent color.
    const opened = await Persistence.open(join(app.getPath('userData'), 'chord.db'));
    persistence = opened.persistence;
    const accent = systemInfo().accentColor;
    const accentRgb = accent ? hexToRgb(accent) : null;
    const initial = restoreState(opened.saved, {
      now: Date.now(),
      newId: () => uuidv7(),
      theme: { stops: defaultChordStops(accentRgb ? rgbToOklch(accentRgb) : null), grain: 0.2, appearance: 'auto' },
      homeUrl: HOME_URL,
    });
    if (!opened.saved || opened.saved.chords.length === 0) persistence.recordAll(initial);

    const store = persistence;
    browser = new Browser({
      initial,
      uiSession: ui,
      profileSession,
      permissions,
      onChange: (change) => store.record(change.patches, change.state),
    });
    Menu.setApplicationMenu(browser.appMenu);
    registerIpc();
    browser.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
