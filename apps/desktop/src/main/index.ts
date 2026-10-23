import {
  ARCHIVE_AFTER_MS,
  DEFAULT_SETTINGS,
  IDLE_CHECK_MS,
  SLEEP_AFTER_MS,
  isPrivateProfile,
  isPrivateWindow,
  privateWindowOf,
  profilePartition,
  restoreState,
  uuidv7,
  type Command,
  type WindowId,
} from '@chord/core';
import type { RendererCommand } from '@chord/ipc';
import { defaultChordStops, hexToRgb, rgbToOklch } from '@chord/tokens';
import { delimiter, join } from 'node:path';
import { app, clipboard, nativeTheme, net, session, webContents, type ContextMenuParams, type Session, type WebContents } from 'electron';
import { showDevelopmentDockIcon } from './app-icon';
import { Browser } from './browser';
import { openSignIn } from './duet/detect';
import { DuetService } from './duet/service';
import { defaultBrowserStatus, makeDefaultBrowser } from './default-browser';
import { configureAppIdentity } from './identity';
import { handle } from './ipc';
import { DownloadManager } from './downloads';
import { WebStore } from './extensions/webstore';
import { observeContextMenusForTests } from './context-menu';
import { PermissionBroker } from './permissions';
import { ScreenShareBroker } from './screen-share';
import { applySpellcheck, setDictionarySource } from './spellcheck';
import { openable, urlsFromArgv } from './os-links';
import { Persistence, removeUnusedPartitions } from './persistence';
import { platform, systemInfo } from './platform';
import { handleChordProtocol, registerSchemes } from './protocol';
import { configureUiSession, hardenAllWebContents } from './security';
import { Suggestions } from './suggestions';
import { UpdateInstaller } from './update-installer';
import { UpdateChecker } from './updates';
import { chromiumUserAgent } from './user-agent';

// A bug in main must never put up Electron's "JavaScript error" box (a native dialog that
// beeps on Windows). Log it and keep going, as Electron does after that box is closed.
// The E2E suite fails any test whose run logs one of these lines.
process.on('uncaughtException', (error) => console.error('[chord] Uncaught exception in main:', error));
process.on('unhandledRejection', (reason) => console.error('[chord] Unhandled rejection in main:', reason));

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
let duet: DuetService | undefined;
const permissions = new PermissionBroker();
const screenShare = new ScreenShareBroker();
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
  onReady: (release) => browser?.announceUpdateReady(`update:${release.version}`, `${release.name} is ready`),
  installer: new UpdateInstaller(),
});
const suggestions = new Suggestions({
  // Google-free mode never searches with Google (core enforces it); this is the backstop.
  enabled: () => (browser?.store.state.settings.searchSuggestions ?? false) && !(browser?.store.state.settings.googleFree && browser.store.state.settings.searchEngine === 'google'),
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

/** A private window's command bar neither reads history and the archive nor teaches them anything. */
const fromPrivateWindow = (sender: WebContents): boolean => isPrivateWindow(browser!.store.state, senderWindow(sender).id);

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
  handle('history:search', ({ query }, sender) =>
    fromPrivateWindow(sender) ? { history: [], choices: [], archive: [] } : persistence!.search(query, activeChordOf(sender)),
  );
  handle('search:suggest', ({ query, engine }, sender) => suggestions.suggest(sender.id, query, engine));
  handle('history:choose', ({ text, destination, address }, sender) => {
    const chordId = activeChordOf(sender);
    if (chordId && !fromPrivateWindow(sender)) persistence!.history({ k: 'choice', chordId, text, destination, address: address ?? null, at: Date.now() });
  });
  handle('downloads:openFolder', () => downloads.openFolder());
  handle('overlay:close', ({ seq }, sender) => senderWindow(sender).closeOverlay(seq));
  handle('overlay:ready', (_request, sender) => senderWindow(sender).markOverlayReady());
  handle('layout:anchor', (rect, sender) => senderWindow(sender).setAnchor(rect));
  handle('menu:app', (anchor, sender) => browser!.openAppMenu(sender, anchor));
  handle('menu:tab', ({ nodeId, x, y }, sender) => browser!.openTabMenu(sender, nodeId, { x, y }));
  handle('menu:favorite', ({ favoriteId, x, y }, sender) => browser!.openFavoriteMenu(sender, favoriteId, { x, y }));
  handle('sidebar:moveToChord', ({ nodeId, chordId }, sender) => browser!.moveToChord(senderWindow(sender), nodeId, chordId));
  handle('sidebar:deleteFolder', ({ nodeId }, sender) => browser!.deleteFolder(senderWindow(sender), nodeId));
  handle('layout:peek', ({ open }, sender) => browser!.setPeek(sender, open));
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
  handle('settings:recordingShortcut', ({ recording }, sender) => browser!.setRecordingShortcut(sender, recording));
  handle('extensions:state', (_request, sender) => browser!.extensions.barState(senderWindow(sender)));
  handle('extension:activate', ({ id, anchor }, sender) => browser!.extensions.activate(senderWindow(sender), id, anchor));
  handle('extension:menu', ({ id, x, y }, sender) => browser!.extensions.menu(senderWindow(sender), id, { x, y }));
  handle('extensions:manage', () => browser!.openSettings('extensions'));
  handle('extensions:install', ({ input }, sender) => {
    // Into the profile of the chord the caller's window shows (Settings: the last-used window's).
    const w = browser!.windowFor(sender) ?? browser!.lastBrowserWindow();
    const state = browser!.store.state;
    const chordId = w ? state.windows[w.id]?.activeChordId : undefined;
    const profileId = (chordId ? state.chords[chordId]?.profileId : undefined) ?? 'default';
    return browser!.extensions.install(profileId, input, browser!.windowFor(sender) ? w?.id : undefined);
  });
  handle('extensions:remove', ({ profileId, id }) => browser!.extensions.remove(profileId, id));
  handle('extensions:options', ({ profileId, id }) => browser!.extensions.openOptions(profileId, id));
  handle('extensions:update', () => browser!.extensions.checkForUpdates());
  handle('settings:chordSignIns', ({ chordId, separate }) => browser!.setSeparateSignIns(chordId, separate));
  handle('settings:defaultBrowser', () => defaultBrowserStatus());
  handle('settings:updateStatus', () => updates.status());
  handle('settings:checkForUpdates', () => updates.checkNow());
  handle('update:restart', () => updates.restart());
  handle('settings:makeDefaultBrowser', async () => {
    await makeDefaultBrowser();
    return defaultBrowserStatus();
  });
  handle('popover:state', (_request, sender) => browser!.popoverState(senderWindow(sender)));
  handle('popover:size', ({ width, height }, sender) => senderWindow(sender).setPopoverSize(width, height));
  handle('find:query', ({ text, forward }, sender) => browser!.findFor(sender)?.query(text, forward));
  handle('find:close', (_request, sender) => browser!.findFor(sender)?.close());
  handle('permission:respond', ({ id, decision }) => permissions.respond(id, decision));
  handle('duet:view', (_request, sender) => duet!.view(senderWindow(sender).id));
  handle('duet:do', (action, sender) => duet!.act(senderWindow(sender).id, action));
  handle('duet:search', ({ query }, sender) => (fromPrivateWindow(sender) ? [] : duet!.search(query)));
  handle('duet:openHit', ({ chordId, threadId }, sender) => duet!.openHit(senderWindow(sender).id, chordId, threadId));
  handle('settings:duet', async (request) => {
    if (request.do === 'signIn') {
      const status = duet!.providerStatuses.find((s) => s.provider === request.provider) ?? (await duet!.refreshProviders()).find((s) => s.provider === request.provider);
      if (status?.path) openSignIn(request.provider, status.path);
      return duet!.providerStatuses;
    }
    if (request.do === 'clearAll') {
      await duet!.clearAll();
      return duet!.providerStatuses;
    }
    return duet!.refreshProviders();
  });
  handle('share:respond', ({ id, sourceId, audio }) => screenShare.respond(id, sourceId, audio));
  handle('share:stop', ({ nodeId }) => screenShare.stop(nodeId));
  handle('settings:sitePermission', ({ origin, permission, decision }) =>
    browser!.store.dispatch({ t: 'permission.set', origin, permissions: [permission], decision }),
  );
  handle('settings:forgetSite', ({ origin }) => browser!.store.dispatch({ t: 'permission.forget', origin }));
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
    // Every window open now comes back next launch, so their closing isn't forgetting them.
    browser?.prepareToQuit();
    if (flushed || !persistence) return;
    event.preventDefault();
    flushed = true;
    // Duet first: replies in flight are kept as interrupted, and provider processes end.
    void (duet?.quit() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => persistence!.close())
      .finally(() => app.quit());
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

    // No dictionary downloads until the saved settings say whether Google-free mode is on.
    setDictionarySource(true);
    const ui = session.fromPartition('chord-ui');
    configureUiSession(ui);
    handleChordProtocol(ui);
    hardenAllWebContents();

    const profiles = new Map<string, Session>();
    profileSession = (profileId: string) => {
      let ses = profiles.get(profileId);
      if (!ses) {
        ses = session.fromPartition(profilePartition(profileId));
        // A private window's session keeps its answers and downloads to itself.
        const priv = isPrivateProfile(profileId);
        permissions.attach(ses, priv ? profileId : null);
        downloads.attach(ses, priv ? privateWindowOf(profileId) : null);
        screenShare.attach(ses);
        const settings = browser?.store.state.settings ?? DEFAULT_SETTINGS;
        applySpellcheck(ses, settings.spellcheck, settings.googleFree);
        profiles.set(profileId, ses);
      }
      return ses;
    };
    /** A private window closed: its in-memory session is emptied now, not just at exit. */
    const releaseProfile = (profileId: string) => {
      const ses = profiles.get(profileId);
      if (!isPrivateProfile(profileId)) return;
      permissions.forgetScope(profileId);
      if (!ses) return;
      profiles.delete(profileId);
      void ses
        .clearStorageData()
        .then(() => ses.clearCache())
        .catch(() => {});
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
      // Chrome's --no-first-run skips it. Playwright adds that switch to every Electron it drives,
      // so development builds can ask for first run with CHORD_FIRST_RUN=1.
      firstRun: (!app.isPackaged && process.env['CHORD_FIRST_RUN'] === '1') || !app.commandLine.hasSwitch('no-first-run'),
      // Saved shortcut changes this OS keeps for itself are dropped.
      platform,
    });
    if (!opened.saved || opened.saved.chords.length === 0) persistence.recordAll(initial);
    setDictionarySource(initial.settings.googleFree);
    // Sign-ins a chord kept separately, once no chord uses them, are deleted before any session loads them.
    await removeUnusedPartitions(app.getPath('userData'), new Set(Object.values(initial.chords).map((c) => c.profileId)));

    const store = persistence;
    // Development and tests only (ignored when packaged): a stand-in Web Store and its signing key,
    // and unpacked extension folders to load, like Chrome's --load-extension.
    const dev = (name: string) => (app.isPackaged ? undefined : process.env[name] || undefined);
    const publisherKeyHash = dev('CHORD_WEBSTORE_PUBLISHER_KEY_HASH');
    browser = new Browser({
      initial,
      uiSession: ui,
      profileSession,
      permissions,
      screenShare,
      history: (event) => store.history(event),
      archive: { entry: (which) => store.archiveEntry(which) },
      idle: {
        checkMs: devMs('CHORD_IDLE_CHECK_MS') ?? IDLE_CHECK_MS,
        archiveAfterMs: (setting) => (setting === 'never' ? null : (devMs('CHORD_ARCHIVE_AFTER_MS') ?? ARCHIVE_AFTER_MS[setting])),
        sleepAfterMs: devMs('CHORD_SLEEP_AFTER_MS') ?? SLEEP_AFTER_MS,
      },
      onChange: (change) => store.record(change.patches, change.state),
      releaseProfile,
      extensions: {
        root: join(app.getPath('userData'), 'Extensions'),
        preloadPath: join(import.meta.dirname, '../preload/extensions.cjs'),
        webStore: new WebStore({
          fetch: (url, init) => net.fetch(url, init),
          prodversion: process.versions.chrome,
          ...(dev('CHORD_WEBSTORE_UPDATE_URL') ? { updateUrl: dev('CHORD_WEBSTORE_UPDATE_URL')! } : {}),
        }),
        ...(publisherKeyHash ? { publisherKeyHash } : {}),
      },
    });
    browser.applyAppMenu();
    // Settings → Appearance → Color scheme is Chromium's own theme source, so web pages'
    // prefers-color-scheme follows it, as in Chrome. Development's CHORD_APPEARANCE wins.
    const followScheme = () => {
      if (app.isPackaged || !forcedAppearance) nativeTheme.themeSource = browser!.store.state.settings.colorScheme;
    };
    followScheme();
    browser.store.subscribe((change) => {
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'colorScheme')) followScheme();
      // Spelling settings (and where dictionaries come from) apply to every profile's session at once,
      // and to Chord's own: its text fields are checked too, so in Google-free mode they mustn't download.
      if (change.patches.some((p) => p.path[0] === 'settings' && (p.path[1] === 'spellcheck' || p.path[1] === 'googleFree'))) {
        for (const ses of [ui, ...profiles.values()]) applySpellcheck(ses, change.state.settings.spellcheck, change.state.settings.googleFree);
      }
    });
    // Before any of Chord's own pages loads (a text field there is what starts a dictionary download).
    applySpellcheck(ui, browser.store.state.settings.spellcheck, browser.store.state.settings.googleFree);
    duet = new DuetService(browser, persistence, app.getPath('userData'));
    browser.duet = duet;
    registerIpc();
    // End-to-end tests only (never when packaged): what extensions add to a page's
    // right-click menu, read without opening a native menu.
    if (dev('CHORD_E2E_HOOKS')) {
      // Right-click menus are read, not shown: their labels, newest last, by page.
      const contextMenus = new Map<number, string[]>();
      observeContextMenusForTests((contents, labels) => contextMenus.set(contents.id, labels));
      (globalThis as Record<string, unknown>)['chordTestHooks'] = {
        contextMenu: (contentsId: number) => contextMenus.get(contentsId) ?? null,
        extensionMenuLabels: (contentsId: number, params: Partial<ContextMenuParams>) => {
          const contents = webContents.fromId(contentsId);
          return contents ? browser!.extensions.contextMenuItems(contents, params as ContextMenuParams).map((item) => item.label) : [];
        },
      };
    }
    // Extensions load before any page does, so their content scripts reach restored tabs.
    await browser.extensions.start((dev('CHORD_LOAD_EXTENSION') ?? '').split(delimiter).filter(Boolean));
    browser.start();
    if (pendingUrls.length > 0) browser.openExternalUrls(pendingUrls.splice(0));
    updates.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
