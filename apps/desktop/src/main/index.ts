// First, so launch timing starts before any other module runs (ARCHITECTURE.md §1).
import { launchTimings, markLaunch } from './perf';
import {
  ARCHIVE_AFTER_MS,
  blockingOffSites,
  DEFAULT_SETTINGS,
  IDLE_CHECK_MS,
  MEMORY_CHECK_MS,
  PRESSURE_SLEEP_AFTER_MS,
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
import { app, clipboard, nativeTheme, net, session, shell, webContents, type ContextMenuParams, type Session, type WebContents } from 'electron';
import type { ImportEnv } from '../import/detect';
import { AdBlocking } from './ad-blocking/service';
import { FILTER_LISTS } from './ad-blocking/lists';
import { showDevelopmentDockIcon } from './app-icon';
import { Browser } from './browser';
import { DuetService } from './duet/service';
import { defaultBrowserStatus, makeDefaultBrowser } from './default-browser';
import { configureAppIdentity } from './identity';
import { Importer } from './import';
import { handle, send } from './ipc';
import { DownloadManager } from './downloads';
import { WebStore } from './extensions/webstore';
import { observeContextMenusForTests, type ObservedItem } from './context-menu';
import { PermissionBroker } from './permissions';
import { ScreenShareBroker, systemPickerFor } from './screen-share';
import { AuthBroker } from './http-auth';
import { memoryLow } from './memory';
import { applySpellcheck, setDictionarySource } from './spellcheck';
import { openable, urlsFromArgv } from './os-links';
import { seedForPerformance } from './perf-seed';
import { Persistence, removeUnusedPartitions } from './persistence';
import { platform, systemInfo, uiScale } from './platform';
import { handleChordProtocol, registerSchemes, serveDuetImages, serveReaderImages } from './protocol';
import { SAFE_BROWSING_KEY } from './safe-browsing/key';
import { listsFile, SafeBrowsing, safeBrowsingEndpoint } from './safe-browsing/service';
import { configureUiSession, hardenAllWebContents } from './security';
import { Suggestions } from './suggestions';
import { UpdateInstaller } from './update-installer';
import { UpdateChecker } from './updates';
import { PasskeyBroker } from './passkeys';
import { Screenshots } from './screenshots/service';
import { DiskShots } from './screenshots/store';
import { mark, watchLaunch } from './launch-timeline';
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

/** Development and tests only: a positive number from the environment (durations in ms, to archive and sleep in seconds rather than hours; counts, for performance runs). */
function devNumber(name: string): number | null {
  const value = app.isPackaged ? NaN : Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

let browser: Browser | undefined;
let persistence: Persistence | undefined;
let duet: DuetService | undefined;
let importer: Importer | undefined;
const permissions = new PermissionBroker();
const screenShare = new ScreenShareBroker(systemPickerFor(process.platform, process.getSystemVersion(), process.env, app.commandLine.getSwitchValue('ozone-platform')));
const httpAuth = new AuthBroker();
const passkeys = new PasskeyBroker();

/**
 * Safe Browsing (ARCHITECTURE.md §14.5): Google's v5 API in Local List Mode.
 * Release builds carry the API key; development builds can point it at a
 * test server instead (CHORD_SAFE_BROWSING_URL, ignored when packaged), and
 * then send it no key. Without either it's unavailable and never runs.
 */
const safeBrowsing = new SafeBrowsing(
  {
    endpoint: safeBrowsingEndpoint(SAFE_BROWSING_KEY, app.isPackaged ? undefined : process.env['CHORD_SAFE_BROWSING_URL'] || undefined),
    file: listsFile(app.getPath('userData')),
    workerPath: join(import.meta.dirname, 'safe-browsing.js'),
    firstUpdateMs: app.isPackaged ? 15_000 : 500,
  },
  () => {
    const settings = browser?.store.state.settings;
    return Boolean(settings?.safeBrowsing && !settings.googleFree);
  },
);

/**
 * Ad and tracker blocking (ARCHITECTURE.md §9, decision D5): on by default.
 * Release builds refresh the lists from their own host; development builds
 * only from a test server (CHORD_AD_BLOCKING_URL, ignored when packaged), so
 * they never need the network, and otherwise keep the lists they were built with.
 */
const adBlockingServer = app.isPackaged ? undefined : process.env['CHORD_AD_BLOCKING_URL']?.replace(/\/+$/, '') || undefined;
const adBlocking = new AdBlocking(
  {
    bundledDir: join(import.meta.dirname, 'ad-blocking'),
    root: join(app.getPath('userData'), 'Ad Blocking'),
    workerPath: join(import.meta.dirname, 'ad-blocking.js'),
    listUrl: app.isPackaged ? (id) => FILTER_LISTS.find((l) => l.id === id)!.url : adBlockingServer ? (id) => `${adBlockingServer}/${id}.txt` : null,
    firstRefreshMs: app.isPackaged ? 5 * 60_000 : 500,
  },
  {
    enabled: () => browser?.store.state.settings.adBlocking.enabled ?? DEFAULT_SETTINGS.adBlocking.enabled,
    offSites: (profileId) => (browser ? blockingOffSites(browser.store.state, profileId) : []),
  },
);

const downloads = new DownloadManager({
  state: () => browser!.store.state,
  dispatch: (command) => browser!.store.dispatch(command),
  newId: () => uuidv7(),
  defaultSession: () => profileSession('default'),
  // Every download, a private window's too, is checked while Safe Browsing is on (its final address and redirects).
  screen: (urls) => (safeBrowsing.active ? safeBrowsing.check(urls, 'download').then((v) => (v.verdict === 'unsafe' ? v.kind : null)) : null),
  onHeld: (download) => browser?.showHeldDownload(download.privateWindow),
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

/**
 * Where an import looks for other browsers (ARCHITECTURE.md §9): this
 * computer's folders, or in development builds a stand-in home folder of
 * synthetic profiles (CHORD_IMPORT_ROOT, as the tests use; ignored when packaged).
 */
function importEnv(): ImportEnv {
  const root = (!app.isPackaged && process.env['CHORD_IMPORT_ROOT']) || null;
  const home = root ?? app.getPath('home');
  return {
    platform,
    home,
    localAppData: root ? join(root, 'AppData/Local') : process.env['LOCALAPPDATA'] || join(home, 'AppData/Local'),
    appData: root ? join(root, 'AppData/Roaming') : app.getPath('appData'),
    configHome: root ? join(root, '.config') : process.env['XDG_CONFIG_HOME'] || join(home, '.config'),
  };
}

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

/**
 * Presenting mode (ARCHITECTURE.md §9): history, the archive and Duet's chats
 * answer nothing, here where they come from, so a keystroke the command bar
 * sends before it hears the mode is on can't show one either.
 */
const presenting = (): boolean => browser!.store.state.presenting !== null;

/** Renderers may only act on their own window, whatever windowId they send. */
function scopeToWindow(command: RendererCommand, windowId: WindowId): Command {
  return 'windowId' in command ? { ...command, windowId } : command;
}

function registerIpc(): void {
  handle('system:info', () => systemInfo());
  handle('state:snapshot', (_request, sender) => ({ windowId: senderWindow(sender).id, state: browser!.store.state }));
  handle('cmd:dispatch', (command, sender) => {
    const w = senderWindow(sender);
    // An import's toast: its history goes too, and a running import stops first.
    if (command.t === 'import.undo') return importer!.undo(command.importId);
    // Docking and collapsing picture the page first, so its frame can glide (ARCHITECTURE.md §5).
    if (command.t === 'window.sidebar') {
      browser!.setSidebar(w, command.sidebar);
      return w.frameChanged();
    }
    browser!.store.dispatch(scopeToWindow(command, w.id));
  });
  handle('nav:command', ({ action }, sender) => {
    // The page itself, behind its reader view if it has one open.
    const contents = browser!.pageIn(senderWindow(sender));
    if (!contents) return;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
  });
  handle('overlay:open', ({ mode, anchor }, sender) => {
    const w = senderWindow(sender);
    w.openOverlay(mode, mode === 'edit' ? browser!.activeUrl(w.id) : '', anchor ?? null, 'shell');
  });
  handle('download:action', ({ id, action }) => downloads.run(id, action));
  handle('safeBrowsing:status', () => safeBrowsing.status());
  handle('adBlocking:status', () => adBlocking.status());
  // First run's step and the one-time offer, each with the notice on screen.
  handle('safeBrowsing:choose', ({ on }) => browser!.store.dispatch({ t: 'settings.set', settings: { safeBrowsing: on, safeBrowsingAsked: true } }));
  handle('safeBrowsing:back', ({ nodeId }, sender) => browser!.safeBrowsingAction(sender, nodeId, 'back'));
  handle('safeBrowsing:proceed', ({ nodeId }, sender) => browser!.safeBrowsingAction(sender, nodeId, 'proceed'));
  handle('history:search', async ({ query }, sender) => {
    const nothing = { history: [], choices: [], archive: [] };
    if (fromPrivateWindow(sender) || presenting()) return nothing;
    const found = await persistence!.search(query, activeChordOf(sender));
    // Presenting mode may have started while chord-data looked.
    return presenting() ? nothing : found;
  });
  handle('search:image', ({ engine, image, where }, sender) => browser!.searchByImage(senderWindow(sender), engine, image, where));
  handle('search:suggest', ({ query, engine }, sender) => suggestions.suggest(sender.id, query, engine));
  handle('history:choose', ({ text, destination, address }, sender) => {
    const chordId = activeChordOf(sender);
    if (chordId && !fromPrivateWindow(sender)) persistence!.history({ k: 'choice', chordId, text, destination, address: address ?? null, at: Date.now() });
  });
  handle('downloads:openFolder', () => downloads.openFolder());
  handle('overlay:close', ({ seq, dismissed }, sender) => browser!.closeOverlay(sender, seq, dismissed));
  // Screenshots (DESIGN.md §7.12): capture mode in the overlay, and the recent list (each window its own).
  handle('capture:hover', ({ x, y }, sender) => browser!.screenshots.hover(senderWindow(sender), x, y));
  handle('capture:step', ({ to }, sender) => browser!.screenshots.step(senderWindow(sender), to));
  handle('capture:take', (choice, sender) => browser!.screenshots.take(senderWindow(sender), choice));
  handle('capture:scroll', ({ x, y, deltaX, deltaY }, sender) => browser!.screenshots.scroll(senderWindow(sender), x, y, deltaX, deltaY));
  handle('screenshots:list', (_request, sender) => browser!.screenshots.list(senderWindow(sender)));
  handle('screenshots:do', ({ id, do: action }, sender) => browser!.screenshots.act(senderWindow(sender), id, action));
  handle('screenshots:clear', (_request, sender) => browser!.screenshots.clear(senderWindow(sender)));
  handle('focus:move', ({ to }, sender) => senderWindow(sender).focusRegion(to));
  handle('peek:expand', (_request, sender) => browser!.expandPeek(sender));
  // A mini window's bar (DESIGN.md §7.9): each acts on the mini window it's in.
  handle('mini:state', (_request, sender) => {
    const state = browser!.minis.stateFor(sender);
    if (!state) throw new Error('No mini window for this sender');
    return state;
  });
  handle('mini:promote', (_request, sender) => browser!.minis.promote(sender));
  handle('mini:chooseChord', (anchor, sender) => browser!.minis.chooseChord(sender, anchor));
  handle('mini:copyLink', (_request, sender) => browser!.minis.copyLink(sender));
  handle('overlay:ready', (_request, sender) => senderWindow(sender).markOverlayReady());
  handle('layout:anchor', (rect, sender) => senderWindow(sender).setAnchor(rect));
  handle('perf:shell', ({ milestone }, sender) => {
    markLaunch(milestone === 'ready' ? 'shellReady' : 'shellPainted');
    // The window is up: its command bar may warm up for its first opening now.
    if (milestone === 'painted') senderWindow(sender).markShellPainted();
  });
  handle('menu:app', (anchor, sender) => browser!.openAppMenu(sender, anchor));
  handle('menu:tab', ({ nodeId, x, y }, sender) => browser!.openTabMenu(sender, nodeId, { x, y }));
  handle('menu:favorite', ({ favoriteId, x, y }, sender) => browser!.openFavoriteMenu(sender, favoriteId, { x, y }));
  handle('sidebar:moveToChord', ({ nodeId, chordId }, sender) => browser!.moveToChord(senderWindow(sender), nodeId, chordId));
  handle('sidebar:deleteFolder', ({ nodeId }, sender) => browser!.deleteFolder(senderWindow(sender), nodeId));
  handle('layout:peek', ({ open }, sender) => browser!.setPeek(sender, open));
  handle('layout:lift', ({ lifted }, sender) => browser!.setLifted(sender, lifted));
  handle('layout:snapshot', ({ seq, phase }, sender) => senderWindow(sender).ackSnapshot(seq, phase));
  handle('layout:snapshotPort', (_request, sender) => senderWindow(sender).connectSnapshots());
  handle('menu:chord', ({ chordId, x, y }, sender) => browser!.openChordMenu(sender, chordId, { x, y }));
  handle('action:run', async ({ action }, sender) => {
    browser!.run(action, sender);
    // Docking the sidebar waits for the page's picture (ARCHITECTURE.md §5): reply once it has happened.
    await browser!.windowFor(sender)?.frameChanged();
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
  handle('preview:hover', (target, sender) => browser!.previewHover(senderWindow(sender), target));
  handle('preview:size', ({ width, height }, sender) => senderWindow(sender).setPreviewSize(width, height));
  handle('find:query', ({ text, forward }, sender) => browser!.findFor(sender)?.query(text, forward));
  handle('find:close', (_request, sender) => browser!.findFor(sender)?.close());
  handle('permission:respond', ({ id, decision }) => permissions.respond(id, decision));
  handle('duet:view', (_request, sender) => duet!.view(senderWindow(sender).id, true));
  handle('duet:ask', ({ text, image }, sender) => duet!.askAboutImage(senderWindow(sender).id, text, { mime: 'image/jpeg', ...image }));
  handle('duet:do', (action, sender) => duet!.act(senderWindow(sender).id, action));
  handle('duet:search', async ({ query }, sender) => {
    if (fromPrivateWindow(sender) || presenting()) return [];
    const hits = await duet!.search(query);
    return presenting() ? [] : hits;
  });
  handle('duet:openHit', ({ chordId, threadId }, sender) => duet!.openHit(senderWindow(sender).id, chordId, threadId));
  handle('settings:duet', async (request) => {
    if (request.do === 'signIn') {
      await duet!.signIn(request.provider);
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
  handle('media:view', (_request, sender) => browser!.nowPlaying(senderWindow(sender).id));
  handle('media:do', ({ nodeId, action }, sender) => browser!.mediaAction(senderWindow(sender), nodeId, action));
  handle('auth:respond', ({ id, credentials }) => httpAuth.respond(id, credentials));
  handle('passkey:respond', ({ id, credentialId }) => passkeys.respond(id, credentialId));
  handle('drm:open', ({ browser: other }, sender) => browser!.drmAction(sender, { open: other }));
  handle('drm:dismiss', (_request, sender) => browser!.drmAction(sender, 'dismiss'));
  handle('settings:sitePermission', ({ origin, permission, decision }) =>
    browser!.store.dispatch({ t: 'permission.set', origin, permissions: [permission], decision }),
  );
  handle('settings:forgetSite', ({ origin }) => browser!.store.dispatch({ t: 'permission.forget', origin }));
  handle('settings:linkRoute', ({ host, chordId }) => browser!.setLinkRoute(host, chordId));
  // A reader view: only its own tab's article and look; closing it brings the page back.
  handle('reader:page', (_request, sender) => {
    const page = browser!.readers.pageFor(sender);
    if (!page) throw new Error('No reader view for this sender');
    return page;
  });
  handle('reader:look', (_request, sender) => browser!.readerLook(sender));
  handle('reader:ready', (_request, sender) => browser!.readers.ready(sender));
  handle('reader:set', (reader) => browser!.store.dispatch({ t: 'settings.set', settings: { reader } }));
  handle('reader:close', (_request, sender) => browser!.readers.close(sender));
  handle('archive:snapshot', (_request, sender) => browser!.archiveSnapshot(sender));
  handle('archive:list', ({ query, limit }) => persistence!.archiveList(query, limit));
  handle('archive:restore', ({ archiveId }, sender) => browser!.restoreArchived(sender, archiveId));
  handle('archive:remove', ({ archiveId }) => browser!.removeArchived(archiveId));
  // Import from other browsers: first run (the shell) and Settings → Import (the last normal window). Never a private window.
  const importWindow = (sender: WebContents) => browser!.windowFor(sender) ?? browser!.lastBrowserWindow();
  handle('import:sources', (_request, sender) => (importWindow(sender)?.isPrivate === false ? importer!.sources() : []));
  handle('import:preview', ({ key }, sender) => {
    const w = importWindow(sender);
    const chordId = w && !w.isPrivate ? browser!.store.state.windows[w.id]?.activeChordId : undefined;
    return chordId ? importer!.read(key, chordId) : { ok: false, problem: 'missing' };
  });
  handle('import:run', ({ key, choices }, sender) => {
    const w = importWindow(sender);
    if (!w || w.isPrivate) return { ok: false, problem: 'missing' };
    return importer!.run(key, choices, w.id, (progress) => send(sender, 'import:progress', progress));
  });
  handle('import:undo', ({ importId }) => importer!.undo(importId));
  handle('import:openAccess', () => {
    // System Settings → Privacy & Security → Full Disk Access, which Safari's folder needs.
    if (platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  });
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
  // A site or proxy asking for a username and password: Chord's own box over the tab, or cancelled.
  app.on('login', (event, contents, details, info, callback) => {
    if (httpAuth.login(contents, details, info, callback)) event.preventDefault();
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
    // Downloads Safe Browsing held, never kept: their unfinished files go.
    downloads.discardHeld();
    if (flushed || !persistence) return;
    event.preventDefault();
    flushed = true;
    // An import stops, and its copies of another browser's files go (at most 2 s, like the rest).
    const imports = Promise.race([importer?.quit().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000))]);
    // Duet first: replies in flight are kept as interrupted, and provider processes end. Ad blocking
    // finishes a change under way (no control page may be open as Electron tears down) and ends its workers.
    void Promise.all([duet?.quit(), adBlocking.stop()])
      .catch(() => undefined)
      .then(() => imports)
      .then(() => persistence!.close())
      .finally(() => app.quit());
  });

  watchLaunch();
  void app.whenReady().then(async () => {
    mark('app ready');
    markLaunch('ready');
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
        passkeys.attach(ses);
        // A chord's session gets the blocker extension; a private window's, its request dispatcher.
        adBlocking.attach(profileId, ses, priv);
        // Before any page's own scripts: what Electron lacks and every Chromium browser has (preload/page.ts).
        ses.registerPreloadScript({ type: 'frame', id: 'chord-page', filePath: join(import.meta.dirname, '../preload/page.cjs') });
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
      adBlocking.detach(profileId);
      if (!ses) return;
      profiles.delete(profileId);
      void ses
        .clearStorageData()
        .then(() => ses.clearCache())
        .catch(() => {});
    };

    // Session restore: what chord-data saved, repaired; or a first chord in the OS accent color.
    const opened = await Persistence.open(join(app.getPath('userData'), 'chord.db'));
    mark('database open');
    markLaunch('restored');
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
    if (!opened.saved || opened.saved.chords.length === 0) {
      // Development and performance runs only: a full sidebar and a used history to measure against.
      const perfTabs = devNumber('CHORD_PERF_TABS') ?? 0;
      const perfVisits = devNumber('CHORD_PERF_VISITS') ?? 0;
      if (perfTabs || perfVisits) {
        seedForPerformance(initial, { tabs: perfTabs, visits: perfVisits, homeUrl: HOME_URL, newId: () => uuidv7(), history: (event) => opened.persistence.history(event) });
      }
      persistence.recordAll(initial);
    }
    setDictionarySource(initial.settings.googleFree);
    // Sign-ins a chord kept separately, once no chord uses them, are deleted before any session loads them.
    const profilesInUse = new Set(Object.values(initial.chords).map((c) => c.profileId));
    await removeUnusedPartitions(app.getPath('userData'), profilesInUse);
    // Their copies of the blocker extension too (not awaited: nothing loads from those).
    void adBlocking.forgetProfiles(profilesInUse);

    const store = persistence;
    // Development and tests only (ignored when packaged): a stand-in Web Store and its signing key,
    // and unpacked extension folders to load, like Chrome's --load-extension.
    const dev = (name: string) => (app.isPackaged ? undefined : process.env[name] || undefined);
    const publisherKeyHash = dev('CHORD_WEBSTORE_PUBLISHER_KEY_HASH');
    // Recent screenshots on disk, read when first needed (taking one, or the downloads panel's list).
    const shots = new DiskShots(join(app.getPath('userData'), 'Screenshots'));
    const screenshots = new Screenshots({
      uiScale,
      keep: () => browser?.store.state.settings.keepScreenshots ?? true,
      disk: shots,
      saveFile: async (filename, bytes, url, privateWindow) => void (await downloads.addFile(filename, bytes, 'image/png', url, privateWindow)),
      duetReady: (w, url) => Boolean(duet?.canAskAbout(w.id, url)),
      askDuet: (windowId, image) => duet?.attachImage(windowId, image),
    });
    browser = new Browser({
      initial,
      uiSession: ui,
      profileSession,
      permissions,
      screenShare,
      httpAuth,
      passkeys,
      screenshots,
      histories: opened.navs,
      saveHistory: (nodeId, nav) => persistence?.nav(nodeId, nav),
      history: (event) => store.history(event),
      archive: { entry: (which) => store.archiveEntry(which) },
      idle: {
        checkMs: devNumber('CHORD_IDLE_CHECK_MS') ?? IDLE_CHECK_MS,
        archiveAfterMs: (setting) => (setting === 'never' ? null : (devNumber('CHORD_ARCHIVE_AFTER_MS') ?? ARCHIVE_AFTER_MS[setting])),
        sleepAfterMs: devNumber('CHORD_SLEEP_AFTER_MS') ?? SLEEP_AFTER_MS,
        pressureSleepAfterMs: devNumber('CHORD_PRESSURE_SLEEP_AFTER_MS') ?? PRESSURE_SLEEP_AFTER_MS,
        memoryCheckMs: devNumber('CHORD_MEMORY_CHECK_MS') ?? MEMORY_CHECK_MS,
      },
      // CHORD_MEMORY_LOW=1 (development and tests only) acts as if memory were always low.
      memoryLow: () => (!app.isPackaged && process.env['CHORD_MEMORY_LOW'] === '1') || memoryLow(process.getSystemMemoryInfo(), process.platform),
      onChange: (change) => store.record(change.patches, change.state),
      releaseProfile,
      adBlocking: {
        attachPage: (contents) => adBlocking.attachPage(contents),
        profileOf: (contents) => adBlocking.profileOf(contents),
        settled: () => adBlocking.settled(),
      },
      safeBrowsing: {
        enabled: () => safeBrowsing.active,
        check: (urls) => safeBrowsing.check(urls, 'frame'),
        offer: () => {
          const s = browser?.store.state.settings;
          return Boolean(safeBrowsing.available && s && !s.safeBrowsing && !s.safeBrowsingAsked && !s.googleFree);
        },
      },
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
    serveReaderImages((url) => browser!.readers.image(url));
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
      // Safe Browsing starts or stops with its switch, and with Google-free mode (which keeps it off).
      if (change.patches.some((p) => p.path[0] === 'settings' && (p.path[1] === 'safeBrowsing' || p.path[1] === 'googleFree'))) safeBrowsing.sync();
      // Ad blocking follows its switch and the sites it's off for (a private window's own list lives on its chord).
      if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'adBlocking') || (p.path[0] === 'chords' && p.path[2] === 'blockingOff'))) adBlocking.sync();
    });
    safeBrowsing.sync();
    adBlocking.sync();
    // Every chord's session, made now, so each one's blocker extension has loaded before any of its pages loads (below).
    for (const profileId of profilesInUse) if (!isPrivateProfile(profileId)) profileSession(profileId);
    // Before any of Chord's own pages loads (a text field there is what starts a dictionary download).
    applySpellcheck(ui, browser.store.state.settings.spellcheck, browser.store.state.settings.googleFree);
    duet = new DuetService(browser, persistence, app.getPath('userData'), {
      save: async (filename, bytes, mime) => void (await downloads.addFile(filename, bytes, mime, '', null)),
    });
    browser.duet = duet;
    serveDuetImages((url) => duet!.serveImage(url));
    importer = new Importer({
      workerPath: join(import.meta.dirname, 'import.js'),
      env: importEnv,
      state: () => browser!.store.state,
      dispatch: (command) => browser!.store.dispatch(command),
      history: { port: (importId) => store.importPort(importId), undo: (importId) => store.undoImport(importId) },
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
    });
    // Copies of another browser's files an import left when Chord was killed go, once launch is long over.
    setTimeout(() => void importer?.sweep(), 60_000).unref();
    registerIpc();
    // End-to-end tests only (never when packaged): what extensions add to a page's
    // right-click menu, read without opening a native menu; and launch timing.
    if (dev('CHORD_E2E_HOOKS')) {
      // Right-click menus are read, not shown: their labels, newest last, by page.
      const contextMenus = new Map<number, ObservedItem[]>();
      observeContextMenusForTests((contents, items) => contextMenus.set(contents.id, items));
      (globalThis as Record<string, unknown>)['chordTestHooks'] = {
        launch: () => launchTimings(),
        /** Why each window's last frame change that wanted pictures happened at once (null: it glided). */
        snapshotFallbacks: () => browser!.snapshotFallbacks(),
        /** Safe Browsing's state, and how long its checks took (ms). */
        safeBrowsing: () => ({ status: safeBrowsing.status(), timings: safeBrowsing.timings() }),
        /** Check addresses as a page's navigation would (for timing it). */
        safeBrowsingCheck: (urls: string[]) => safeBrowsing.check(urls, 'frame'),
        /** Ad blocking's lists, and what each session has (the extension, the dispatcher). */
        adBlocking: () => ({ status: adBlocking.status(), ...adBlocking.inspect() }),
        /** Check the lists that are due now, as the timer would. */
        adBlockingRefresh: () => adBlocking.refresh(),
        contextMenu: (contentsId: number) => contextMenus.get(contentsId)?.map((item) => item.label) ?? null,
        /** Choose an item in a page's last right-click menu, as clicking it would. */
        chooseContextMenuItem: (contentsId: number, label: string) => contextMenus.get(contentsId)?.find((item) => item.label === label)?.choose(),
        extensionMenuLabels: (contentsId: number, params: Partial<ContextMenuParams>) => {
          const contents = webContents.fromId(contentsId);
          return contents ? browser!.extensions.contextMenuItems(contents, params as ContextMenuParams).map((item) => item.label) : [];
        },
      };
    }
    // Extensions load before any page does, so their content scripts reach restored tabs; Chord's blocker
    // too, so its rules cover their first requests and no page starts loading while it's being added.
    mark('extensions and ad blocking loading');
    await Promise.all([
      browser.extensions.start((dev('CHORD_LOAD_EXTENSION') ?? '').split(delimiter).filter(Boolean)).then(() => mark('extensions loaded')),
      adBlocking.loaded().then(() => mark('ad blocking loaded (or its 3 s cap)')),
    ]);
    // Launched to open a link: just its mini window, quickly; your windows come back when you want them.
    if (pendingUrls.length > 0) browser.openExternalUrls(pendingUrls.splice(0));
    else browser.start();
    mark('windows opened');
    updates.start();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
