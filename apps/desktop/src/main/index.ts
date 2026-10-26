// First, so launch timing starts before any other module runs (ARCHITECTURE.md §1).
import { launchTimings, markLaunch } from './perf';
import {
  ARCHIVE_AFTER_MS,
  blockingOffSites,
  DEFAULT_SETTINGS,
  BATTERY_SLEEP_AFTER_MS,
  IDLE_CHECK_MS,
  MEMORY_CHECK_MS,
  PRESSURE_SLEEP_AFTER_MS,
  SLEEP_AFTER_MS,
  isPrivateProfile,
  isPrivateWindow,
  privateWindowOf,
  profilePartition,
  proxyFor,
  restoreState,
  uuidv7,
  type Command,
  type WindowId,
} from '@chord/core';
import type { RendererCommand } from '@chord/ipc';
import { defaultChordStops, hexToRgb, rgbToOklch } from '@chord/tokens';
import { hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import { app, BaseWindow, clipboard, nativeTheme, net, powerMonitor, session, shell, webContents, type ContextMenuParams, type Session, type WebContents } from 'electron';
import type { ImportEnv } from '../import/detect';
import { AdBlocking } from './ad-blocking/service';
import { FILTER_LISTS } from './ad-blocking/lists';
import { AfterLaunch } from './after-launch';
import { showDevelopmentDockIcon } from './app-icon';
import { Browser } from './browser';
import { DuetService } from './duet/service';
import { defaultBrowserStatus, makeDefaultBrowser } from './default-browser';
import { Exporter } from './export';
import { APP_ID, configureAppIdentity, inFlatpak } from './identity';
import { ImportGate, Importer } from './import';
import { FileImporter } from './import-file';
import { SyncService } from './sync';
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
import { appBadgeShown, watchAppBadge } from './app-badge';
import { SAFE_BROWSING_KEY } from './safe-browsing/key';
import { listsFile, SafeBrowsing, safeBrowsingEndpoint } from './safe-browsing/service';
import { configureUiSession, hardenAllWebContents } from './security';
import { Suggestions } from './suggestions';
import { UpdateInstaller } from './update-installer';
import { UpdateChecker } from './updates';
import { PasskeyBroker } from './passkeys';
import { proxies } from './proxy';
import { Screenshots } from './screenshots/service';
import { DiskShots } from './screenshots/store';
import { mark, watchLaunch } from './launch-timeline';
import { chromiumUserAgent } from './user-agent';
import { targetFor } from '@chord/player-protocol';
import { readFileSync } from 'node:fs';
import { PlayerInstaller } from './player/installer';
import { playerRoot } from './player/paths';
import { UPDATE_PUBLIC_KEY } from './update-key';
import { RELEASE_DOWNLOADS } from './update-signing';

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
let exporter: Exporter | undefined;
let fileImporter: FileImporter | undefined;
let syncService: SyncService | undefined;
const permissions = new PermissionBroker();
const screenShare = new ScreenShareBroker(systemPickerFor(process.platform, process.getSystemVersion(), process.env, app.commandLine.getSwitchValue('ozone-platform')));
const httpAuth = new AuthBroker();
const passkeys = new PasskeyBroker();
/** Work the first window doesn't need waits until launch is over. */
const afterLaunch = new AfterLaunch();

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
/**
 * Chord Player (ARCHITECTURE.md §9): where it's installed, where its releases
 * come from, and how its manifests are checked (Chord's update key). Release
 * builds read GitHub; development builds only a test server
 * (CHORD_PLAYER_FEED, CHORD_PLAYER_DOWNLOADS and CHORD_PLAYER_PUBLIC_KEY,
 * ignored when packaged), so they never install from the network on their own.
 * Not offered in a Flatpak (it can't start another engine outside its
 * sandbox), on Linux arm64 and Windows arm64 (not built), or on Linux where
 * AppArmor keeps unprivileged user namespaces from an app it doesn't know
 * (Ubuntu 23.10 and later): the player's sandbox couldn't start there.
 */
function playerUsable(): boolean {
  if (inFlatpak) return false;
  if (process.platform !== 'linux') return true;
  try {
    return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() !== '1';
  } catch {
    return true;
  }
}
const devEnv = (name: string) => (app.isPackaged ? undefined : process.env[name] || undefined);
const playerRootDir = playerRoot({ platform: process.platform, home: app.getPath('home'), env: process.env, packaged: app.isPackaged });
let playerFetchSession: Session | null = null;
const playerInstaller = new PlayerInstaller({
  root: playerRootDir,
  target: playerUsable() ? targetFor(process.platform, process.arch) : null,
  feed: app.isPackaged ? 'https://api.github.com/repos/anaremore/chord-browser/releases?per_page=30' : (devEnv('CHORD_PLAYER_FEED') ?? null),
  downloads: app.isPackaged ? RELEASE_DOWNLOADS : (devEnv('CHORD_PLAYER_DOWNLOADS') ?? null),
  publicKey: app.isPackaged ? UPDATE_PUBLIC_KEY : (devEnv('CHORD_PLAYER_PUBLIC_KEY') ?? ''),
  // Its own in-memory session: no cookies sent, nothing kept. Through the proxy for every chord, once it's in place.
  fetch: async (url, init) => {
    playerFetchSession ??= session.fromPartition('chord-player-updates', { cache: false });
    await proxies.ready(playerFetchSession);
    return playerFetchSession.fetch(url, init);
  },
  workerPath: join(import.meta.dirname, 'player-unpack.js'),
  changed: () => browser?.playerChanged(),
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

/** The sign-ins whose own proxy the sender's window's chord uses; null for the proxy for every chord. */
function ownProxyOf(sender: WebContents): string | null {
  const chordId = activeChordOf(sender);
  const chord = chordId ? browser!.store.state.chords[chordId] : undefined;
  return chord?.proxy ? chord.profileId : null;
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
    // An import's toast: its history goes too, and a running import stops first. A Chord file's takes back all it changed.
    if (command.t === 'import.undo') return fileImporter?.owns(command.importId) ? fileImporter.undo(command.importId) : importer!.undo(command.importId);
    // A toast's Undo for Effects: they live in main, not in the store.
    if (command.t === 'effects.undo') return browser!.effects.undo(command.token);
    // A toast's Undo for a form Duet filled: the page puts back what it had (main/duet).
    if (command.t === 'duet.undoFill') return duet?.undoFill(command.token);
    // Sync's toasts: Undo for turning it off or removing a computer, before either happens; a problem's, opening Settings.
    if (command.t === 'sync.undo') return void syncService?.undo(command.token);
    if (command.t === 'sync.open') return browser!.openSettings('data');
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
  // What you type in a chord with its own proxy goes out through that proxy, as its pages do.
  handle('search:suggest', ({ query, engine }, sender) => suggestions.suggest(sender.id, query, engine, ownProxyOf(sender)));
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
  // Effects (DESIGN.md §7.15): the picker's click, the card in the popover, and Settings' list. Each acts on the sender's own window.
  handle('capture:hide', (_request, sender) => browser!.effects.hidePicked(senderWindow(sender).id));
  handle('effects:view', (_request, sender) => browser!.effects.view(senderWindow(sender).id));
  handle('effects:do', (action, sender) => browser!.effects.act(senderWindow(sender), action));
  handle('settings:effects', (change) => browser!.effects.settingsChange(change));
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
  handle('overlay:preconnect', ({ url }, sender) => browser!.preconnect(senderWindow(sender), url));
  handle('layout:anchor', (rect, sender) => senderWindow(sender).setAnchor(rect));
  handle('perf:shell', ({ milestone }, sender) => {
    markLaunch(milestone === 'ready' ? 'shellReady' : 'shellPainted');
    if (milestone !== 'painted') return;
    // The window is up: its command bar, popover and preview may load (or warm up) now.
    mark('shell painted; its command bar, popover and preview load now');
    senderWindow(sender).markShellPainted();
    afterLaunch.shellPainted();
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
  // Developer tools (DESIGN.md §7.16): their header in the shell, and the bar of ones in a window of their own.
  handle('devtools:do', (action, sender) => browser!.devtoolsAction(sender, action));
  handle('devtools:bar', (_request, sender) => browser!.devtools.barFor(sender));
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
  handle('settings:chordProxy', ({ chordId, proxy }) => browser!.setChordProxy(chordId, proxy));
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
  handle('drm:player', ({ action }, sender) => browser!.drmAction(sender, { player: action }));
  handle('player:do', ({ nodeId, action }, sender) => browser!.playerAction(senderWindow(sender), nodeId, action));
  handle('settings:player', () => browser!.player.status());
  handle('settings:removePlayer', () => browser!.player.remove());
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
  // Import from other browsers: first run (the shell) and Settings → Your data (the last normal window). Never a private window.
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
  // Your data: Settings' Export card. The save dialog belongs to the Settings window.
  handle('export:counts', () => exporter!.counts());
  handle('export:run', (request, sender) => exporter!.run(browser!.settingsWindowOf(sender), request, (progress) => send(sender, 'export:progress', progress)));
  handle('export:show', ({ exportId }) => exporter!.show(exportId));
  // Your data: from a Chord file. The open dialog belongs to the Settings window; it lands in the last normal window, never a private one.
  handle('importFile:choose', (_request, sender) => fileImporter!.choose(browser!.settingsWindowOf(sender)));
  handle('importFile:open', ({ fileId, passphrase }) => fileImporter!.open(fileId, passphrase));
  handle('importFile:run', ({ fileId, choices }, sender) => {
    const w = importWindow(sender);
    if (!w || w.isPrivate) return { ok: false, problem: 'missing' };
    return fileImporter!.run(fileId, choices, w.id, (progress) => send(sender, 'importFile:progress', progress));
  });
  handle('importFile:undo', ({ importId }) => fileImporter!.undo(importId));
  // Your data: sync (S15 §8). The folder picker belongs to the Settings window; a folder is named by its id from then on.
  handle('sync:status', () => syncService!.refresh());
  handle('sync:chooseFolder', (_request, sender) => syncService!.chooseFolder(browser!.settingsWindowOf(sender)));
  handle('sync:setup', ({ folderId, passphrase }) => syncService!.setup(folderId, passphrase));
  handle('sync:join', ({ folderId, passphrase }) => syncService!.join(folderId, passphrase));
  handle('sync:choose', ({ mode }) => syncService!.choose(mode));
  handle('sync:unlock', ({ passphrase }) => syncService!.unlock(passphrase));
  handle('sync:passphrase', ({ passphrase }) => syncService!.changePassphrase(passphrase));
  handle('sync:off', () => syncService!.hold('off'));
  handle('sync:remove', ({ device }) => syncService!.hold('remove', device));
  handle('sync:undo', ({ token }) => syncService!.undo(token));
  handle('sync:rename', ({ name }) => syncService!.rename(name));
  handle('sync:pause', ({ paused }) => syncService!.pause(paused));
  handle('sync:relocate', (_request, sender) => syncService!.relocate(browser!.settingsWindowOf(sender)));
  handle('sync:startOver', ({ passphrase }) => syncService!.startOver(passphrase));
  handle('sync:rememberKey', ({ on }) => syncService!.rememberAnyway(on));
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
  // Every session gets its proxy as it's made, before anything can use it, and every page behind one
  // keeps WebRTC to it (proxy.ts). Registered before any session exists: they fire from session.fromPartition on.
  app.on('session-created', (ses) => proxies.created(ses));
  app.on('web-contents-created', (_event, contents) => proxies.contentsCreated(contents));
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
    // An import stops, and its copies of another browser's files go; an export stops, and its unfinished file goes (at most 2 s, like the rest).
    // Sync writes what's waiting to its folder.
    const imports = Promise.race([Promise.all([importer?.quit(), exporter?.quit(), fileImporter?.quit(), syncService?.quit()]).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000))]);
    // Duet first: replies in flight are kept as interrupted, and provider processes end. Ad blocking
    // finishes a change under way (no control page may be open as Electron tears down) and ends its workers.
    // Chord Player quits by itself once Chord's channel closes: nothing to wait for.
    browser?.player.stopUpdates();
    browser?.effects.stop();
    void Promise.all([duet?.quit(), adBlocking.stop()])
      .catch(() => undefined)
      .then(() => imports)
      .then(() => persistence!.close())
      .finally(() => app.quit());
  });

  watchLaunch();
  // Launch is over once a first web page has loaded too (after-launch.ts).
  const watchFirstPage = (_event: unknown, contents: WebContents) => {
    contents.once('did-stop-loading', () => {
      if (!/^https?:/i.test(contents.getURL())) return;
      afterLaunch.pageLoaded();
      app.off('web-contents-created', watchFirstPage);
    });
  };
  app.on('web-contents-created', watchFirstPage);
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
        // Its proxy (its chord's own, or the one for every chord) is set as it's made.
        ses = proxies.make(profileId, () => session.fromPartition(profilePartition(profileId)));
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
        // A site's service worker's app badge goes to its tabs too (counts on tabs): its IPC reaches only its own ServiceWorkerMain.
        ses.registerPreloadScript({ type: 'service-worker', id: 'chord-service-worker', filePath: join(import.meta.dirname, '../preload/service-worker.cjs') });
        const own = ses;
        const listening = new Set<number>();
        own.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
          if (runningStatus === 'stopped') return void listening.delete(versionId);
          const worker = listening.has(versionId) ? undefined : own.serviceWorkers.getWorkerFromVersionID(versionId);
          if (!worker) return;
          listening.add(versionId);
          worker.ipc.on('page:badge', (_event, raw: unknown) => browser?.tabs.setScopeBadge(own, worker.scope, raw));
        });
        const settings = browser?.store.state.settings ?? DEFAULT_SETTINGS;
        applySpellcheck(ses, settings.spellcheck, settings.googleFree);
        profiles.set(profileId, ses);
      }
      return ses;
    };
    /**
     * Developer tools' sessions (DESIGN.md §7.16): Chord's own persistent one,
     * and an in-memory one per private window, so what DevTools fetch for a
     * private page (source maps) never reaches the disk. A chord with its own
     * proxy gets an in-memory one through that proxy, since what they fetch
     * goes to the page's site. Never a profile's own session: DevTools are
     * Chord's, not a site's. They ask for nothing and spell-check nothing.
     */
    const devtoolsSessions = new Map<string, Session>();
    const devtoolsSession = (profileId: string | null) => {
      const partition = profileId ? `chord-devtools-${profileId}` : 'persist:chord-devtools';
      let ses = devtoolsSessions.get(partition);
      if (!ses) {
        ses = proxies.make(profileId, () => session.fromPartition(partition));
        configureUiSession(ses);
        devtoolsSessions.set(partition, ses);
      }
      return ses;
    };
    /** A private window closed: its in-memory session is emptied now, not just at exit. */
    const releaseProfile = (profileId: string) => {
      const ses = profiles.get(profileId);
      if (!isPrivateProfile(profileId)) return;
      const tools = devtoolsSessions.get(`chord-devtools-${profileId}`);
      if (tools) {
        devtoolsSessions.delete(`chord-devtools-${profileId}`);
        proxies.forget(tools);
        void tools
          .clearStorageData()
          .then(() => tools.clearCache())
          .catch(() => {});
      }
      permissions.forgetScope(profileId);
      adBlocking.detach(profileId);
      if (!ses) return;
      profiles.delete(profileId);
      proxies.forget(ses);
      // Its connections (to sites, or a proxy) end with it too.
      void ses
        .closeAllConnections()
        .then(() => ses.clearStorageData())
        .then(() => ses.clearCache())
        .catch(() => {});
    };

    // Session restore: what chord-data saved, repaired; or a first chord in the OS accent color.
    const opened = await Persistence.open(join(app.getPath('userData'), 'chord.db'));
    // Where the time went, if this launch turns out slow (CI once spent 4.5 s here on Windows).
    const t = opened.timing;
    mark(`database open${t ? ` (data process up after ${t.up} ms; opened ${t.open} ms, pruned ${t.prune} ms, read ${t.read} ms)` : ''}${opened.attempts > 1 ? `, ${opened.attempts} tries` : ''}`);
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
        seedForPerformance(initial, {
          tabs: perfTabs,
          visits: perfVisits,
          pages: devNumber('CHORD_PERF_PAGES') ?? perfVisits,
          homeUrl: HOME_URL,
          newId: () => uuidv7(),
          history: (event) => opened.persistence.history(event),
        });
      }
      persistence.recordAll(initial);
    }
    // Proxies (ARCHITECTURE.md §9): the sessions made so far (Chord's UI, Electron's default) get theirs now, before
    // any of them can download a dictionary; every one made from here on gets its own as it's made.
    proxies.created(session.defaultSession);
    proxies.start({ proxyFor: (owner) => proxyFor(browser?.store.state ?? initial, owner), contents: () => webContents.getAllWebContents() });
    setDictionarySource(initial.settings.googleFree);
    const profilesInUse = new Set(Object.values(initial.chords).map((c) => c.profileId));
    // Sign-ins a chord kept separately, once no chord uses them, are deleted once launch is over, with their copies of
    // the blocker extension. No session loads them meanwhile; which profiles are in use is read then, so one made since stays.
    afterLaunch.run(() => {
      const inUse = new Set([...Object.values(browser!.store.state.chords).map((c) => c.profileId), ...profiles.keys()]);
      void removeUnusedPartitions(app.getPath('userData'), inUse);
      void adBlocking.forgetProfiles(inUse);
    });

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
      effects: {
        saved: opened.effects,
        persist: (host, site, fromSync) => persistence?.effect(host, site, fromSync),
        workerPath: join(import.meta.dirname, 'effects.js'),
      },
      history: (event) => store.history(event),
      archive: { entry: (which) => store.archiveEntry(which) },
      idle: {
        checkMs: devNumber('CHORD_IDLE_CHECK_MS') ?? IDLE_CHECK_MS,
        archiveAfterMs: (setting) => (setting === 'never' ? null : (devNumber('CHORD_ARCHIVE_AFTER_MS') ?? ARCHIVE_AFTER_MS[setting])),
        sleepAfterMs: devNumber('CHORD_SLEEP_AFTER_MS') ?? SLEEP_AFTER_MS,
        batterySleepAfterMs: devNumber('CHORD_BATTERY_SLEEP_AFTER_MS') ?? BATTERY_SLEEP_AFTER_MS,
        pressureSleepAfterMs: devNumber('CHORD_PRESSURE_SLEEP_AFTER_MS') ?? PRESSURE_SLEEP_AFTER_MS,
        memoryCheckMs: devNumber('CHORD_MEMORY_CHECK_MS') ?? MEMORY_CHECK_MS,
      },
      // CHORD_MEMORY_LOW=1 (development and tests only) acts as if memory were always low.
      memoryLow: () => (!app.isPackaged && process.env['CHORD_MEMORY_LOW'] === '1') || memoryLow(process.getSystemMemoryInfo(), process.platform),
      // CHORD_ON_BATTERY=1 (development and tests only) acts as if the computer were on battery.
      onBattery: () => (!app.isPackaged && process.env['CHORD_ON_BATTERY'] === '1') || powerMonitor.isOnBatteryPower(),
      // Another computer's changes (sync.apply) are saved marked as sync's: never stamped, never back into this computer's log.
      onChange: (change) => store.record(change.patches, change.state, change.command?.t === 'sync.apply' ? 'sync' : 'here'),
      windowFocused: () => syncService?.focused(),
      // Behind: once no Chord window has the focus a moment later (it went to another app, not to another of Chord's).
      windowBlurred: () => setTimeout(() => (BaseWindow.getFocusedWindow() ? undefined : syncService?.blurred()), 250),
      proxyReady: (ses) => proxies.ready(ses),
      releaseProfile,
      devtoolsSession,
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
      player: {
        installer: playerInstaller,
        host: {
          root: playerRootDir,
          platform: process.platform,
          ...(process.platform === 'win32' ? { appUserModelId: APP_ID } : {}),
          // Tests only (development builds): a local server standing in for a service, with Chord's own host rules.
          ...(devEnv('CHORD_PLAYER_TEST') === '1'
            ? {
                test: {
                  hostResolverRules: app.commandLine.getSwitchValue('host-resolver-rules') || undefined,
                  secureOrigins: (devEnv('CHORD_PLAYER_SECURE_ORIGINS') ?? '').split(',').filter(Boolean),
                },
              }
            : {}),
          verbose: !app.isPackaged,
        },
        // Kept running for the player with every window closed (below): once it's gone, Chord goes too.
        closed: () => {
          if (process.platform !== 'darwin' && browser?.windowCount === 0) app.quit();
        },
      },
      extensions: {
        root: join(app.getPath('userData'), 'Extensions'),
        preloadPath: join(import.meta.dirname, '../preload/extensions.cjs'),
        webStore: new WebStore({
          fetch: async (url, init) => {
            await proxies.ready(session.defaultSession);
            return net.fetch(url, init);
          },
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
    // Chord's icon shows its tabs' counts added up.
    watchAppBadge(browser.store);
    browser.store.subscribe((change) => {
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'colorScheme')) followScheme();
      // Spelling settings (and where dictionaries come from) apply to every profile's session at once,
      // and to Chord's own: its text fields are checked too, so in Google-free mode they mustn't download.
      if (change.patches.some((p) => p.path[0] === 'settings' && (p.path[1] === 'spellcheck' || p.path[1] === 'googleFree'))) {
        for (const ses of [ui, ...profiles.values()]) applySpellcheck(ses, change.state.settings.spellcheck, change.state.settings.googleFree);
      }
      // Safe Browsing starts or stops with its switch, and with Google-free mode (which keeps it off).
      if (change.patches.some((p) => p.path[0] === 'settings' && (p.path[1] === 'safeBrowsing' || p.path[1] === 'googleFree'))) safeBrowsing.sync();
      // Google-free mode closes Chord Player: its CDM comes from Google, and the component updater asks Google again within a minute.
      if (change.state.settings.googleFree && change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'googleFree')) void browser!.player.close();
      // Counts on tabs follow their switch and the sites they're hidden for.
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'tabCounts')) browser!.tabs.refreshCounts();
      // Proxies follow the proxy for every chord, chords' own, and which sign-ins each chord has.
      if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'proxy') || (p.path[0] === 'chords' && (p.path.length <= 2 || p.path[2] === 'proxy' || p.path[2] === 'profileId')))) {
        proxies.sync();
      }
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
    afterLaunch.run(() => void duet!.afterLaunch());
    // Auto picture-in-picture is off by default since 2026-10-25 (it popped videos out unasked): a profile
    // from before gets it switched off once, through the store, so it's saved like any other change.
    if (!browser.store.state.settings.autoPipDefaultOff) browser.store.dispatch({ t: 'settings.set', settings: { autoPip: false, autoPipDefaultOff: true } });
    // Effects' Ask Duet: Duet's own reading rules, one request at a time, nothing kept.
    browser.effects.duet = {
      available: (windowId, url) => duet!.effectsProvider(windowId, url),
      ask: (request) => duet!.oneShot(request),
    };
    serveDuetImages((url) => duet!.serveImage(url));
    // One import at a time, of either kind: the other is told it's busy.
    const importGate = new ImportGate();
    importer = new Importer({
      workerPath: join(import.meta.dirname, 'import.js'),
      env: importEnv,
      state: () => browser!.store.state,
      dispatch: (command) => browser!.store.dispatch(command),
      history: { port: (importId) => store.importPort(importId), undo: (importId) => store.undoImport(importId) },
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
      gate: importGate,
    });
    // Copies of another browser's files an import left when Chord was killed go, once launch is long over.
    setTimeout(() => void importer?.sweep(), 60_000).unref();
    // Your data's export (docs/decisions/S15-your-data.md §7): a process of its own reads the database read-only.
    exporter = new Exporter({
      workerPath: join(import.meta.dirname, 'export.js'),
      database: join(app.getPath('userData'), 'chord.db'),
      images: join(app.getPath('userData'), 'duet', 'images'),
      app: app.getVersion(),
      platform,
      folder: () => app.getPath('documents'),
      data: { flush: () => store.flush(), device: () => store.device(), counts: () => store.exportCounts() },
    });
    // Your data's import from a Chord file (S15 §5, §7): a process of its own reads and checks the file.
    fileImporter = new FileImporter({
      workerPath: join(import.meta.dirname, 'import-file.js'),
      database: join(app.getPath('userData'), 'chord.db'),
      images: join(app.getPath('userData'), 'duet', 'images'),
      platform,
      folder: () => app.getPath('documents'),
      state: () => browser!.store.state,
      dispatch: (command) => browser!.store.dispatch(command),
      data: { flush: () => store.flush(), device: () => store.device(), port: (importId) => store.importPort(importId), undo: (importId) => store.undoImport(importId) },
      effects: { importSites: (importId, sites) => browser!.effects.importSites(importId, sites), undoImport: (importId) => browser!.effects.undoImport(importId) },
      duet: () => duet,
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
      gate: importGate,
    });
    // Your data's sync (S15 §6–§8): chord-data's thread and its worker do the work; main keeps the key and applies what comes in.
    syncService = new SyncService({
      data: { sync: (request) => store.sync(request), flush: () => store.flush(), failures: () => store.writeFailures, waiting: (key) => store.waitingHere(key), onPush: (listener) => store.onPush(listener) },
      state: () => browser!.store.state,
      dispatch: (command) => browser!.store.dispatch(command),
      effects: { syncSites: (sites, gone) => browser!.effects.syncSites(sites, gone) },
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
      lastWindow: () => browser!.lastBrowserWindow()?.id ?? null,
      notify: (view) => browser?.syncChanged(view),
      info: () => ({ name: hostname().slice(0, 100) || 'This computer', os: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux', app: app.getVersion() }),
      platform,
      folder: () => app.getPath('home'),
      // Tests only (development builds): no keyring, on any system, so a relaunch asks for the passphrase again.
      noKeyring: devEnv('CHORD_E2E_NO_KEYRING') === '1',
    });
    store.onRespawn(() => void syncService?.restarted());
    // The key is read once launch is over: safeStorage can ask the OS's keychain, which mustn't hold up the first page.
    afterLaunch.run(() => void syncService!.afterLaunch());
    registerIpc();
    // End-to-end tests only (never when packaged): what extensions add to a page's
    // right-click menu, read without opening a native menu; and launch timing.
    if (dev('CHORD_E2E_HOOKS')) {
      // Right-click menus are read, not shown: their labels, newest last, by page.
      const contextMenus = new Map<number, ObservedItem[]>();
      observeContextMenusForTests((contents, items) => contextMenus.set(contents.id, items));
      (globalThis as Record<string, unknown>)['chordTestHooks'] = {
        launch: () => launchTimings(),
        /** What Chord's icon shows: its tabs' counts added up. */
        appBadge: () => appBadgeShown(),
        /** Why each window's last frame change that wanted pictures happened at once (null: it glided). */
        snapshotFallbacks: () => browser!.snapshotFallbacks(),
        /** Safe Browsing's state, and how long its checks took (ms). */
        safeBrowsing: () => ({ status: safeBrowsing.status(), timings: safeBrowsing.timings() }),
        /** Check addresses as a page's navigation would (for timing it). */
        safeBrowsingCheck: (urls: string[]) => safeBrowsing.check(urls, 'frame'),
        /** Effects: the saved sites, what each page has, and how long applying and checking took (ms). */
        effects: () => browser!.effects.inspect(),
        /** Sync: write what's waiting now (not 3 s after the last change), and look at the folder now (not at the next watch or poll). */
        syncWrite: async () => {
          await store.flush();
          await store.sync({ type: 'sync.flush' });
        },
        syncRead: () => store.sync({ type: 'sync.check' }),
        /** Sync's costs on chord-data's thread: writes with it on and off, the stamping hook, frames, merged slices (ms). */
        syncTimings: async () => (await store.sync({ type: 'sync.timings' })).timings,
        /** Turn sync off at once (Settings holds it for its Undo first). */
        syncOff: () => store.sync({ type: 'sync.off' }),
        /** Pinned folders and tabs, and how many have a name ending in `suffix`: what a sync check waits for, without a state snapshot. */
        pinnedNames: (suffix: string) => {
          const pinned = Object.values(browser!.store.state.nodes).filter((n) => n.section === 'pinned');
          return { count: pinned.length, named: pinned.filter((n) => (n.kind === 'tab' ? n.customTitle : n.kind === 'folder' ? n.title : null)?.endsWith(suffix)).length };
        },
        /** Ad blocking's lists, and what each session has (the extension, the dispatcher). */
        adBlocking: () => ({ status: adBlocking.status(), ...adBlocking.inspect() }),
        /** Check the lists that are due now, as the timer would. */
        adBlockingRefresh: () => adBlocking.refresh(),
        contextMenu: (contentsId: number) => contextMenus.get(contentsId)?.map((item) => item.label) ?? null,
        /** Choose an item in a page's last right-click menu, as clicking it would. */
        chooseContextMenuItem: (contentsId: number, label: string) => contextMenus.get(contentsId)?.find((item) => item.label === label)?.choose(),
        /** Chord Player: where it stands, what the running player says of itself, and its test-only actions. */
        player: () => browser!.player.inspect(),
        playerDebug: () => browser!.player.host.request('debug', {}, 5000),
        playerTest: (body: Record<string, unknown>) => browser!.player.host.request('test', body, 20_000),
        extensionMenuLabels: (contentsId: number, params: Partial<ContextMenuParams>) => {
          const contents = webContents.fromId(contentsId);
          return contents ? browser!.extensions.contextMenuItems(contents, params as ContextMenuParams).map((item) => item.label) : [];
        },
      };
    }
    // Every session's proxy is in place before anything loads in it, extensions' own pages and workers too.
    // (Nothing is pending unless a proxy is set: Electron's sessions already use the system's.)
    const proxied = proxies.settled();
    if (proxied) await proxied;
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
    afterLaunch.opened();
    updates.start();
    browser.player.startUpdates();
  });

  app.on('window-all-closed', () => {
    // Chord Player runs on Chord's channel: Chord stays (without windows) until the player closes too.
    if (process.platform !== 'darwin' && !browser?.player.running) app.quit();
  });
}
