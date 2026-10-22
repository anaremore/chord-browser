import { seedState, uuidv7, type Command, type WindowId } from '@chord/core';
import type { RendererCommand } from '@chord/ipc';
import { defaultChordStops, hexToRgb, rgbToOklch } from '@chord/tokens';
import { app, nativeTheme, session, type Session, type WebContents } from 'electron';
import { Browser } from './browser';
import { configureAppIdentity } from './identity';
import { handle } from './ipc';
import { systemInfo } from './platform';
import { handleChordProtocol, registerSchemes } from './protocol';
import { configureBrowsingSession, configureUiSession, hardenAllWebContents } from './security';
import { chromiumUserAgent } from './user-agent';

// Before `ready`: privileged schemes, identity (decides userData), sandbox for every renderer.
registerSchemes();
configureAppIdentity();
app.enableSandbox();

// Google is the default search engine (decided 2026-10-22). Tests override the
// first page so CI never depends on the network.
const HOME_URL = (!app.isPackaged && process.env['CHORD_HOME_URL']) || 'https://www.google.com/';

let browser: Browser | undefined;

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
  handle('overlay:open', ({ mode }, sender) => {
    const w = senderWindow(sender);
    w.openOverlay(mode, mode === 'edit' ? browser!.activeUrl(w.id) : '');
  });
  handle('overlay:close', (_request, sender) => senderWindow(sender).closeOverlay());
  handle('layout:anchor', (rect, sender) => senderWindow(sender).setAnchor(rect));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    browser?.focusFirstWindow();
  });

  void app.whenReady().then(() => {
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
    const profileSession = (profileId: string) => {
      let ses = profiles.get(profileId);
      if (!ses) {
        ses = session.fromPartition(profileId === 'default' ? 'persist:default' : `persist:p-${profileId}`);
        configureBrowsingSession(ses);
        profiles.set(profileId, ses);
      }
      return ses;
    };

    // Persistence arrives in the next step; until then every launch starts fresh.
    const accent = systemInfo().accentColor;
    const accentRgb = accent ? hexToRgb(accent) : null;
    const initial = seedState({
      now: Date.now(),
      newId: () => uuidv7(),
      theme: { stops: defaultChordStops(accentRgb ? rgbToOklch(accentRgb) : null), grain: 0.35, appearance: 'auto' },
      homeUrl: HOME_URL,
    });

    browser = new Browser({ initial, uiSession: ui, profileSession });
    registerIpc();
    browser.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
