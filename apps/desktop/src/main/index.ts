import { ARCHIVE_AFTER_MS, IDLE_CHECK_MS, SLEEP_AFTER_MS, profilePartition, restoreState, uuidv7, type Command, type WindowId } from '@chord/core';
import type { RendererCommand } from '@chord/ipc';
import { defaultChordStops, hexToRgb, rgbToOklch } from '@chord/tokens';
import { join } from 'node:path';
import { app, clipboard, Menu, nativeTheme, session, type Session, type WebContents } from 'electron';
import { showDevelopmentDockIcon } from './app-icon';
import { Browser } from './browser';
import { defaultBrowserStatus, makeDefaultBrowser } from './default-browser';
import { configureAppIdentity } from './identity';
import { handle } from './ipc';
import { DownloadManager } from './downloads';
import { PermissionBroker } from './permissions';
import { openable, urlsFromArgv } from './os-links';
import { Persistence, removeUnusedPartitions } from './persistence';
import { systemInfo } from './platform';
import { handleChordProtocol, registerSchemes } from './protocol';
import { configureUiSession, hardenAllWebContents } from './security';
import { Suggestions } from './suggestions';
import { UpdateChecker } from './updates';
import { chromiumUserAgent } from './user-agent';

// Before `ready`: privileged schemes, identity (decides userData), sandbox for every renderer.
registerSchemes();
configureAppIdentity();
app.enableSandbox();

// Google is the default search engine (decided 2026-10-22). Tests override the
// first page so CI never depends on the network.
const HOME_URL = (!app.isPackaged && process.env['CHORD_HOME_URL']) || 'https://www.google.com/';

/** Development and tests only: a duration in ms from the environment, for archiving and sleeping in seconds rather than hours. */
function devMs(name: string): number | null {
  const value = app.isPackaged ? NaN : Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

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
const updates = new UpdateChecker({
  enabled: () => browser?.store.state.settings.checkForUpdates ?? false,
  onAvailable: (release) => browser?.announce(`update:${release.version}`, `${release.name} is out`, { label: 'What’s new', url: release.url }),
});
const suggestions = new Suggestions({
  enabled: () => browser?.store.state.settings.searchSuggestions ?? false,
  engine: () => browser?.store.state.settings.searchEngine ?? 'google',
});

function senderWindow(sender: WebContents) {
  const w = browser?.windowFor(sender);
  if (!w) throw new Error('No window for this sender');
  return w;
}

/** The chord the sender's window shows: command bar searches and picks are per chord. */
function activeChordOf(sender: WebContents): string | null {
  return browser!.store.state.windows[senderWindow(sender).id]?.activeChordId ?? null;
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
  handle('history:search', ({ query }, sender) => persistence!.search(query, activeChordOf(sender)));
  handle('search:suggest', ({ query, engine }, sender) => suggestions.suggest(sender.id, query, engine));
  handle('history:choose', ({ text, destination, address }, sender) => {
    const chordId = activeChordOf(sender);
    if (chordId) persistence!.history({ k: 'choice', chordId, text, destination, address: address ?? null, at: Date.now() });
  });
  handle('downloads:openFolder', () => downloads.openFolder());
  handle('overlay:close', ({ seq }, sender) => senderWindow(sender).closeOverlay(seq));
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
  handle('settings:saveTheme', ({ theme }) => browser!.store.dispatch({ t: 'theme.save', theme }));
  handle('settings:deleteTheme', ({ id }) => browser!.store.dispatch({ t: 'theme.delete', id }));
  handle('settings:copyText', ({ text }) => clipboard.writeText(text));
  handle('settings:chordSignIns', ({ chordId, separate }) => browser!.setSeparateSignIns(chordId, separate));
  handle('settings:defaultBrowser', () => defaultBrowserStatus());
  handle('settings:updateStatus', () => updates.status());
  handle('settings:checkForUpdates', () => updates.checkNow());
  handle('settings:makeDefaultBrowser', async () => {
    await makeDefaultBrowser();
    return defaultBrowserStatus();
  });
  handle('popover:state', (_request, sender) => browser!.popoverState(senderWindow(sender)));
  handle('popover:size', ({ width, height }, sender) => senderWindow(sender).setPopoverSize(width, height));
  handle('find:query', ({ text, forward }, sender) => browser!.findFor(sender)?.query(text, forward));
  handle('find:close', (_request, sender) => browser!.findFor(sender)?.close());
  handle('permission:respond', ({ id, decision }) => permissions.respond(id, decision));
  handle('archive:snapshot', (_request, sender) => browser!.archiveSnapshot(sender));
  handle('archive:list', ({ query, limit }) => persistence!.archiveList(query, limit));
  handle('archive:restore', ({ archiveId }, sender) => browser!.restoreArchived(sender, archiveId));
  handle('archive:remove', ({ archiveId }) => browser!.removeArchived(archiveId));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Links from other apps (Chord as the default browser) can arrive before the window does.
  const pendingUrls = urlsFromArgv(process.argv);
  const openUrls = (urls: string[]) => {
    if (browser) browser.openExternalUrls(urls);
    else pendingUrls.push(...urls);
  };
  app.on('second-instance', (_event, argv) => {
    const urls = urlsFromArgv(argv);
    if (urls.length > 0) openUrls(urls);
    else browser?.focusFirstWindow();
  });
  // macOS hands links and files over as events, from launch onward.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const target = openable(url);
    if (target) openUrls([target]);
  });
  app.on('open-file', (event, path) => {
    event.preventDefault();
    const target = openable(path);
    if (target) openUrls([target]);
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
    showDevelopmentDockIcon();
    // Development only: force an appearance for design QA captures.
    const forced = process.env['CHORD_APPEARANCE'];
    const forcedAppearance = forced === 'light' || forced === 'dark' ? forced : null;
    if (!app.isPackaged && forcedAppearance) nativeTheme.themeSource = forcedAppearance;

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
        ses = session.fromPartition(profilePartition(profileId));
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
    // Sign-ins a chord kept separately, once no chord uses them, are deleted before any session loads them.
    await removeUnusedPartitions(app.getPath('userData'), new Set(Object.values(initial.chords).map((c) => c.profileId)));

    const store = persistence;
    browser = new Browser({
      initial,
      uiSession: ui,
      profileSession,
      permissions,
      history: (event) => store.history(event),
      archive: { entry: (which) => store.archiveEntry(which) },
      idle: {
        checkMs: devMs('CHORD_IDLE_CHECK_MS') ?? IDLE_CHECK_MS,
        archiveAfterMs: (setting) => (setting === 'never' ? null : (devMs('CHORD_ARCHIVE_AFTER_MS') ?? ARCHIVE_AFTER_MS[setting])),
        sleepAfterMs: devMs('CHORD_SLEEP_AFTER_MS') ?? SLEEP_AFTER_MS,
      },
      onChange: (change) => store.record(change.patches, change.state),
    });
    Menu.setApplicationMenu(browser.appMenu);
    // Settings → Appearance → Color scheme is Chromium's own theme source, so web pages'
    // prefers-color-scheme follows it, as in Chrome. Development's CHORD_APPEARANCE wins.
    const followScheme = () => {
      if (app.isPackaged || !forcedAppearance) nativeTheme.themeSource = browser!.store.state.settings.colorScheme;
    };
    followScheme();
    browser.store.subscribe((change) => {
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'colorScheme')) followScheme();
    });
    registerIpc();
    browser.start();
    if (pendingUrls.length > 0) browser.openExternalUrls(pendingUrls.splice(0));
    updates.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
