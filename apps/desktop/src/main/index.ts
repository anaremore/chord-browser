// First, so launch timing starts before any other module runs (ARCHITECTURE.md §1).
import { launchTimings, markLaunch } from './perf';
import {
  ARCHIVE_AFTER_MS,
  blockingOffSites,
  DEFAULT_SETTINGS,
  BATTERY_SLEEP_AFTER_MS,
  IDLE_CHECK_MS,
  MEMORY_CHECK_MS,
  AGENTS_RELEASED,
  agentActions,
  PRESSURE_SLEEP_AFTER_MS,
  SLEEP_AFTER_MS,
  isPrivateProfile,
  isPrivateWindow,
  privateWindowOf,
  profilePartition,
  proxyFor,
  restoreState,
  uuidv7,
  nodeList,
  sortedChords,
  type Command,
  type WindowId,
} from '@chord/core';
import type { AntigravityAnswer, RendererCommand } from '@chord/ipc';
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
import { AssistantService } from './assistant/service';
import { watchAgents, type AgentSwitch } from './agents/switch';
import type { AntigravityUndos } from './agents/antigravity';
import type { ConnectCards } from './agents/connect';
import type { SiteCards } from './agents/site-cards';
import type { SetupWhere } from './agents/settings';
import type { AgentInputEvent } from './control/input';
import { pageOf } from './view-page';
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
import { originOf } from '@chord/data';
import { Persistence, removeUnusedPartitions } from './persistence';
import { platform, systemInfo, uiScale } from './platform';
import { handleChordProtocol, registerSchemes, serveAssistantImages, serveReaderImages } from './protocol';
import { appBadgeShown, watchAppBadge } from './app-badge';
import { SAFE_BROWSING_KEY } from './safe-browsing/key';
import { listsFile, SafeBrowsing, safeBrowsingEndpoint } from './safe-browsing/service';
import { configureUiSession, hardenAllWebContents } from './security';
import { Suggestions } from './suggestions';
import { UpdateInstaller } from './update-installer';
import { UpdateChecker } from './updates';
import { PasskeyBroker } from './passkeys';
import { osKeys, testKeys } from './passwords/keys';
import { PasswordService } from './passwords/service';
import { PasswordTransfers } from './passwords/transfer';
import { createPasswordDetector } from './passwords/detector';
import { proxies } from './proxy';
import { pageGate } from './page-gate';
import { Screenshots } from './screenshots/service';
import { DiskShots } from './screenshots/store';
import { mark, watchLaunch } from './launch-timeline';
import { chromiumUserAgent } from './user-agent';
import { targetFor } from '@chord/player-protocol';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { PlayerInstaller } from './player/installer';
import { playerRoot } from './player/paths';
import { UPDATE_PUBLIC_KEY } from './update-key';
import { takeUpdateFailure } from './update-outcome';
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
let assistant: AssistantService | undefined;
/** Outside agents (S18): null in packaged builds, which have none yet. */
let agents: AgentSwitch | null = null;
/** The connect card (S18 M1d), made with the agents' service. */
let connectCards: ConnectCards | null = null;
let siteCards: SiteCards | null = null;
let importer: Importer | undefined;
let exporter: Exporter | undefined;
let fileImporter: FileImporter | undefined;
let passwordTransfers: PasswordTransfers | undefined;
let syncService: SyncService | undefined;
const permissions = new PermissionBroker();
const screenShare = new ScreenShareBroker(systemPickerFor(process.platform, process.getSystemVersion(), process.env, app.commandLine.getSwitchValue('ozone-platform')));
const httpAuth = new AuthBroker();
const passkeys = new PasskeyBroker();
// Chord's own passwords (S17): chord-data holds the vault; this keeps the lock's clock, the kept key and the unlock card.
const passwords = new PasswordService({
  data: (op) => {
    if (!persistence) return Promise.reject(new Error('chord-data isn’t open'));
    return persistence.passwords(op);
  },
  settings: () => browser?.store.state.settings.passwords ?? DEFAULT_SETTINGS.passwords,
  // Tests only (development builds): no keyring, on any system, as Linux's `basic_text`; or a stand-in one, kept in
  // memory for the run, where the runner has none.
  keys:
    !app.isPackaged && process.env['CHORD_E2E_TEST_KEYRING'] === '1'
      ? testKeys()
      : osKeys(process.platform, { noKeyring: !app.isPackaged && process.env['CHORD_E2E_NO_KEYRING'] === '1' }),
  clipboard: { writeText: (text) => clipboard.writeText(text), readText: () => clipboard.readText() },
  changed: () => browser?.passwordsChanged(),
  hide: () => browser?.passwordsHide(),
  locked: () => browser?.passwordAssist.locked(),
  chord: (chordId) => browser?.store.state.chords[chordId] ?? null,
  extensions: () => browser?.store.state.extensions ?? {},
});
/**
 * Chord's password detector (S17): off until the vault turns it on (`passwords.attachDetector`, once the state
 * exists, then `stateChanged` after each change); reads nothing until a page asks.
 */
const passwordDetector = createPasswordDetector({
  preloadPath: join(import.meta.dirname, '../preload/passwords.cjs'),
  agentPath: join(import.meta.dirname, 'passwords/agent.js'),
});
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
/** What a page's first load waits for in its session: its proxy being set, and its chord's ad-blocking rules being on (#189). */
const pageReady = pageGate<Session>([(ses) => proxies.ready(ses), (ses) => adBlocking.pending(ses)]);
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
  // Downloads under their pending names now: a crash's leftovers deleted at the next launch.
  pendingList: join(app.getPath('userData'), 'pending-downloads.json'),
  // Every download, a private window's too, is checked while Safe Browsing is on (its final address and redirects).
  screen: (urls) => (safeBrowsing.active ? safeBrowsing.check(urls, 'download').then((v) => (v.verdict === 'unsafe' ? v.kind : null)) : null),
  onHeld: (download) => browser?.showHeldDownload(download.privateWindow),
  // An outside agent's tab (S18) downloads nothing: refused, and the agent told.
  refuse: (contents, url, filename) => browser?.agentDownload(contents, url, filename) ?? false,
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
 * Presenting mode (ARCHITECTURE.md §9): history, the archive and the assistant's chats
 * answer nothing, here where they come from, so a keystroke the command bar
 * sends before it hears the mode is on can't show one either.
 */
const presenting = (): boolean => browser!.store.state.presenting !== null;

/** Renderers may only act on their own window, whatever windowId they send. */
function scopeToWindow(command: RendererCommand, windowId: WindowId): Command {
  return 'windowId' in command ? { ...command, windowId } : command;
}

/** Where this Chord runs from, for the lines and configs that start its `mcp` (S18). */
function setupWhere(): SetupWhere {
  return { platform: process.platform, packaged: app.isPackaged, exe: app.getPath('exe'), appPath: app.getAppPath(), appImage: process.env['APPIMAGE'], flatpak: inFlatpak ? (process.env['FLATPAK_ID'] ?? null) : null };
}

function registerIpc(): void {
  handle('system:info', () => systemInfo());
  handle('state:snapshot', (_request, sender) => ({ windowId: senderWindow(sender).id, state: browser!.store.state }));
  handle('cmd:dispatch', (command, sender) => {
    const w = senderWindow(sender);
    // An import's toast: its history goes too, and a running import stops first. A Chord file's takes back all it changed.
    if (command.t === 'import.undo') {
      if (passwordTransfers?.owns(command.importId)) return void passwordTransfers.undo(command.importId);
      return fileImporter?.owns(command.importId) ? fileImporter.undo(command.importId) : importer!.undo(command.importId);
    }
    // A toast's Undo for Effects: they live in main, not in the store.
    if (command.t === 'effects.undo') return browser!.effects.undo(command.token);
    // A toast's Undo for a form the assistant filled: the page puts back what it had (main/assistant).
    if (command.t === 'assistant.undoFill') return assistant?.undoFill(command.token);
    // An outside agent's bar and toasts (S18): its gate and chord live in main.
    // The bar's Stop is Ctrl+. / ⌘.: every agent, and every assistant reply.
    if (command.t === 'agents.stopAll') return browser!.stopAll?.();
    if (command.t === 'agents.continue') return agents?.service?.chords?.continue(command.chordId);
    if (command.t === 'agents.keep') return agents?.service?.chords?.keep(command.windowId, command.chordId);
    if (command.t === 'agents.closeAll') return agents?.service?.chords?.closeAll(command.chordId);
    if (command.t === 'agents.undoClose') return agents?.service?.chords?.undoClose(command.token);
    if (command.t === 'agents.unshare') return agents?.service?.shares?.unshare(command.nodeId);
    // An address you typed for an agent's tab: where it goes is yours (a site you keep private makes it a tab of yours),
    // and you take the tab over (S18 M2e-1), as a reload of yours does.
    if (command.t === 'tab.navigate') {
      agents?.service?.chords?.takeOver(command.nodeId, undefined, { url: command.url });
      assistant?.userUsedTab(command.nodeId, 'an address you typed');
    }
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
    // The toolbar's buttons: an agent's tab is yours from here (S18 M2e-1), when one moves it.
    if (action === 'back' && history.canGoBack()) {
      browser!.userNavigates?.(contents, 'back');
      history.goBack();
    } else if (action === 'forward' && history.canGoForward()) {
      browser!.userNavigates?.(contents, 'forward');
      history.goForward();
    } else if (action === 'reload') {
      browser!.userNavigates?.(contents);
      // A page stopped before it ever loaded: its tab's address (round 1 of #282).
      browser!.tabs.reload(contents);
    }
    else if (action === 'stop') {
      // Your Stop is your hand on the page: the assistant's lease there ends (Claude's B2 on #147).
      assistant?.userMovedPage(contents, 'Stop');
      // A page still waiting for its session (its proxy, its rules, #277): that load is dropped too.
      browser!.tabs.stopWaiting(contents);
      contents.stop();
    }
  });
  handle('overlay:open', ({ mode, anchor }, sender) => {
    const w = senderWindow(sender);
    // The sidebar's address bar and buttons: a Peek (one still waiting for the overlay too) goes first, as for ⌘L.
    browser!.peeks.close(w);
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
  handle('peek:move', ({ card }, sender) => senderWindow(sender).movePeek(card));
  // A mini window's bar (DESIGN.md §7.9): each acts on the mini window it's in.
  handle('mini:state', (_request, sender) => {
    const state = browser!.minis.stateFor(sender);
    if (!state) throw new Error('No mini window for this sender');
    return state;
  });
  handle('mini:promote', (_request, sender) => browser!.minis.promote(sender));
  handle('mini:chooseChord', (anchor, sender) => browser!.minis.chooseChord(sender, anchor));
  handle('mini:copyLink', (_request, sender) => browser!.minis.copyLink(sender));
  handle('overlay:ready', (_request, sender) => {
    const w = senderWindow(sender);
    // A Peek that waited for the overlay opens now: the find bar and fill menu of the tab under it follow.
    if (w.markOverlayReady()) browser!.peekShown(w);
  });
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
    agents: !app.isPackaged || AGENTS_RELEASED,
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
  handle('popover:state', (_request, sender) => browser!.popoverStateFor(sender, senderWindow(sender)));
  handle('popover:size', ({ width, height }, sender) => {
    const w = senderWindow(sender);
    // The menu under a field has a view of its own, on the popover's page and API.
    if (sender === w.menuPage) w.setMenuSize(width, height);
    else w.setPopoverSize(width, height);
  });
  handle('preview:hover', (target, sender) => browser!.previewHover(senderWindow(sender), target));
  handle('preview:size', ({ width, height }, sender) => senderWindow(sender).setPreviewSize(width, height));
  handle('find:query', ({ text, forward }, sender) => browser!.findFor(sender)?.query(text, forward));
  handle('find:close', (_request, sender) => browser!.findFor(sender)?.close());
  handle('permission:respond', ({ id, decision }) => permissions.respond(id, decision));
  handle('assistant:view', (_request, sender) => assistant!.view(senderWindow(sender).id, true));
  handle('assistant:ask', ({ text, image }, sender) => assistant!.askAboutImage(senderWindow(sender).id, text, { mime: 'image/jpeg', ...image }));
  handle('assistant:do', (action, sender) => assistant!.act(senderWindow(sender).id, action));
  handle('assistant:search', async ({ query }, sender) => {
    if (fromPrivateWindow(sender) || presenting()) return [];
    const hits = await assistant!.search(query);
    return presenting() ? [] : hits;
  });
  handle('assistant:openHit', ({ chordId, threadId }, sender) => assistant!.openHit(senderWindow(sender).id, chordId, threadId));
  handle('settings:assistant', async (request) => {
    if (request.do === 'signIn') {
      await assistant!.signIn(request.provider);
      return assistant!.providerStatuses;
    }
    if (request.do === 'clearAll') {
      await assistant!.clearAll();
      return assistant!.providerStatuses;
    }
    return assistant!.refreshProviders();
  });
  handle('share:respond', ({ id, sourceId, audio }) => screenShare.respond(id, sourceId, audio));
  handle('share:stop', ({ nodeId }) => screenShare.stop(nodeId));
  handle('tab:reload', ({ nodeId }) => browser!.reloadTab(nodeId));
  handle('media:view', (_request, sender) => browser!.nowPlaying(senderWindow(sender).id));
  handle('player:view', () => browser!.player.frame());
  handle('media:do', ({ nodeId, action }, sender) => browser!.mediaAction(senderWindow(sender), nodeId, action));
  // Only the popover of the window the box's tab is shown in answers it.
  handle('auth:respond', async ({ id, credentials, remember }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'cards');
    if (windowId) await httpAuth.respond(id, credentials, remember, windowId);
  });
  // The connect card (S18 M1d): only the popover of the window it shows in answers it.
  handle('agents:card', ({ id, answer }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'cards');
    if (!windowId || siteCards?.answer(id, answer, windowId) || answer === 'show') return;
    connectCards?.answer(id, answer, windowId);
  });
  // Settings → Agents (S18 M1d): its view, Remove an allowed agent, let a stopped one continue.
  handle('settings:agents', async (request) => {
    const { agentsView, setupLines } = await import('./agents/settings');
    const state = browser!.store.state;
    const service = agents?.service ?? null;
    if (request.do === 'remove') {
      browser!.store.dispatch({ t: 'settings.set', settings: { agentsAllowed: state.settings.agentsAllowed.filter((a) => !(a.name === request.name && a.parent === request.parent)) } });
      service?.disconnect(request.name, request.parent);
    } else if (request.do === 'removeSite') {
      // It asks again there, from its next action on.
      browser!.store.dispatch({
        t: 'settings.set',
        settings: { agentsAllowed: state.settings.agentsAllowed.map((a) => (a.name === request.name && a.parent === request.parent ? { ...a, actSites: (a.actSites ?? []).filter((s) => s !== request.site) } : a)) },
      });
      service?.forgetSite(request.name, request.parent, request.site);
    } else if (request.do === 'continue') service?.continue(request.id);
    const connected = [...(service?.connections ?? [])].map((held) => ({
      id: held.connection.agent.id,
      name: held.connection.name,
      always: held.always,
      stopped: held.connection.agent.isStopped,
      chordId: service?.chords?.chordOf(held.connection.agent) ?? null,
    }));
    return { ...agentsView(browser!.store.state, connected, setupLines(setupWhere())), acting: agentActions({ packaged: app.isPackaged }) };
  });
  // Settings → Agents' *Add to Antigravity* (S18): Chord's own entry in its MCP config, and its Undo (the last few kept).
  let antigravity: AntigravityUndos | null = null;
  handle('settings:antigravity', async (request): Promise<AntigravityAnswer> => {
    const [{ AntigravityUndos }, { mcpArgv }] = await Promise.all([import('./agents/antigravity'), import('./agents/settings')]);
    antigravity ??= new AntigravityUndos();
    return request.do === 'undo' ? antigravity.undo(request.token) : antigravity.add(mcpArgv(setupWhere()));
  });
  handle('auth:unlock', async ({ id }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'cards');
    if (windowId) await httpAuth.unlock(id, windowId);
  });
  handle('passwords:revert', ({ id }, sender) => browser!.revertPasswordUpdate(senderWindow(sender).id, id));
  handle('passkey:respond', ({ id, credentialId }) => passkeys.respond(id, credentialId));
  // Settings → Passwords, and the popover's unlock card (S17 §9).
  handle('passwords:view', () => passwords.view());
  handle('passwords:setup', ({ passphrase }) => passwords.setup(passphrase));
  handle('passwords:unlock', ({ passphrase }) => passwords.unlock(passphrase));
  handle('passwords:lock', () => passwords.lock());
  handle('passwords:keep', ({ on, passphrase }) => passwords.keep(on, passphrase));
  handle('passwords:passphrase', ({ current, next }) => passwords.changePassphrase(current, next));
  handle('passwords:reveal', ({ id, passphrase }) => passwords.reveal(id, passphrase));
  handle('passwords:copy', ({ id, passphrase }) => passwords.copy(id, passphrase));
  handle('passwords:add', (login) => passwords.add(login));
  handle('passwords:edit', ({ id, patch, passphrase }) => passwords.edit(id, patch, passphrase));
  handle('passwords:delete', ({ id }) => passwords.remove(id));
  handle('passwords:undelete', ({ id }) => passwords.undo(id));
  handle('passwords:forgetNever', ({ site }) => passwords.forgetNever(site));
  handle('passwords:startOver', () => passwords.startOver());
  handle('passwords:importChoose', (_request, sender) => (passwordTransfers ? passwordTransfers.choose(browser!.settingsWindowOf(sender)) : { ok: false, problem: 'busy' }));
  handle('passwords:importPreview', ({ stageId }) => passwordTransfers?.preview(stageId) ?? null);
  handle('passwords:importRun', ({ stageId, choices, passphrase }, sender) => {
    const w = importWindow(sender);
    return (
      passwordTransfers?.run(stageId, choices, passphrase, { windowId: w && !w.isPrivate ? w.id : null, notify: (progress) => send(sender, 'passwords:importProgress', progress) }) ?? { ok: false, problem: 'busy' }
    );
  });
  handle('passwords:importDrop', ({ stageId }) => passwordTransfers?.drop(stageId));
  handle('passwords:importUndo', ({ importId }) => passwordTransfers?.undo(importId) ?? { ok: false, problem: 'missing' });
  handle('passwords:count', () => passwordTransfers?.count() ?? 0);
  handle('passwords:exportShow', ({ exportId }) => passwordTransfers?.show(exportId));
  handle('passwords:export', ({ passphrase }, sender) => (passwordTransfers ? passwordTransfers.exportCsv(browser!.settingsWindowOf(sender), passphrase) : { ok: false, problem: 'busy' }));
  // *Change password on the site* (S17 §9): only a sign-in Settings was shown, only https, in a new tab.
  handle('passwords:changeOnSite', async ({ id }) => {
    const url = await passwords.changePasswordUrl(id);
    if (!url) return false;
    browser!.openUrlInLastWindow(url);
    return true;
  });
  handle('passwords:unlockCard', ({ id, passphrase, keep }) => passwords.answerUnlock(id, passphrase, keep));
  // The menu under a field and the save card (S17 §9): each answers only its own window's page, the menu's view or the
  // cards' popover, never the other.
  handle('passwords:menuChoose', ({ id, index }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'menu');
    if (windowId) browser!.passwordAssist.chooseRow(windowId, id, index);
  });
  handle('passwords:saveCard', async ({ id, action, username, passphrase, account }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'cards');
    if (windowId)
      await browser!.passwordAssist.answer(windowId, id, action, {
        ...(username !== undefined ? { username } : {}),
        ...(passphrase !== undefined ? { passphrase } : {}),
        ...(account !== undefined ? { account } : {}),
      });
  });
  handle('passwords:menuRegenerate', ({ id }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'menu');
    if (windowId) void browser!.passwordAssist.regenerate(windowId, id);
  });
  // The key beside the address: the sender's window's own tab's card only.
  handle('passwords:reopenCard', ({ nodeId }, sender) => browser!.passwordAssist.reopen(senderWindow(sender).id, nodeId));
  handle('passwords:saveCardReveal', ({ id }, sender) => {
    const windowId = browser?.popoverWindow(sender, 'cards');
    return windowId ? browser!.passwordAssist.reveal(windowId, id) : null;
  });
  handle('drm:open', ({ browser: other }, sender) => browser!.drmAction(sender, { open: other }));
  handle('drm:dismiss', (_request, sender) => browser!.drmAction(sender, 'dismiss'));
  handle('drm:player', ({ action }, sender) => browser!.drmAction(sender, { player: action }));
  handle('player:do', ({ nodeId, action }, sender) => browser!.playerAction(senderWindow(sender), nodeId, action));
  handle('settings:player', () => browser!.player.status());
  handle('settings:installPlayer', () => browser!.player.install());
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
  // The passwords sentinel's ask for the agent gets an answer anywhere it runs; a tab's page then takes over (attachPage).
  app.on('web-contents-created', (_event, contents) => passwordDetector.attachOther(contents));
  // Which frame each sign-in box's request came from: tracked on every page from its first navigation.
  app.on('web-contents-created', (_event, contents) => httpAuth.attachPage(contents));
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
    // A password copied less than a minute ago leaves the clipboard.
    void passwords.dispose();
    if (flushed || !persistence) return;
    event.preventDefault();
    flushed = true;
    // An import stops, and its copies of another browser's files go; an export stops, and its unfinished file goes (at most 2 s, like the rest).
    // Sync writes what's waiting to its folder.
    const imports = Promise.race([Promise.all([importer?.quit(), exporter?.quit(), fileImporter?.quit(), syncService?.quit()]).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000))]);
    // The assistant first: replies in flight are kept as interrupted, and provider processes end. Ad blocking
    // finishes a change under way (no control page may be open as Electron tears down) and ends its workers.
    // Chord Player quits by itself once Chord's channel closes: nothing to wait for.
    browser?.player.stopUpdates();
    browser?.effects.stop();
    void Promise.all([assistant?.quit(), adBlocking.stop(), agents?.quit()])
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
        // The passwords sentinel, registered only while passwords are on for this chord (S17 §8).
        passwordDetector.attachSession(profileId, ses, priv);
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
          pinned: devNumber('CHORD_PERF_PINNED') ?? 0,
          folders: devNumber('CHORD_PERF_FOLDERS') ?? 0,
          effects: devNumber('CHORD_PERF_EFFECTS') ?? 0,
          homeUrl: HOME_URL,
          newId: () => uuidv7(),
          history: (event) => opened.persistence.history(event),
          effect: (host, value) => opened.persistence.effect(host, value),
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
      assistantReady: (w, url) => Boolean(assistant?.canAskAbout(w.id, url)),
      askAssistant: (windowId, image) => assistant?.attachImage(windowId, image),
    });
    browser = new Browser({
      initial,
      uiSession: ui,
      profileSession,
      permissions,
      screenShare,
      httpAuth,
      passkeys,
      passwords,
      passwordDetector,
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
      // Who each change is from (S15 §13): yours are stamped; another computer's applied, and tidying, never are.
      onChange: (change) => {
        store.record(change.patches, change.state, originOf(change.command), change.before);
        // *Lock after* changed: the clock counts with the new time.
        if (change.before && change.before.settings.passwords.lockAfter !== change.state.settings.passwords.lockAfter) passwords.settingsChanged();
        // The switch, the extension rule or the chords changed: the form detector hears which sign-ins it watches.
        passwords.stateChanged(change.state);
        // The switch or the extension rule may have turned passwords off for a chord: its save cards go.
        if (change.before && (change.before.settings.passwords !== change.state.settings.passwords || change.before.extensions !== change.state.extensions)) browser?.passwordAssist.switched();
      },
      windowFocused: () => syncService?.focused(),
      // Behind: once no Chord window has the focus a moment later (it went to another app, not to another of Chord's).
      windowBlurred: () => setTimeout(() => (BaseWindow.getFocusedWindow() ? undefined : syncService?.blurred()), 250),
      proxyReady: pageReady,
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
        // Windows: the helper that lets the player play in the tab (player/dock.ts), beside the app; a development
        // build has it in out/ (scripts/build-window-owner.mjs). Without it, the player keeps a window of its own.
        dockHelper: (() => {
          if (process.platform !== 'win32' || devEnv('CHORD_PLAYER_NO_DOCK') === '1') return null;
          const helper = app.isPackaged ? join(process.resourcesPath, 'window-owner.exe') : join(app.getAppPath(), 'out/window-owner/window-owner.exe');
          return existsSync(helper) ? helper : null;
        })(),
        // Kept running for the player with every window closed (below): once it's gone, Chord goes too.
        closed: () => {
          if (process.platform !== 'darwin' && browser?.windowCount === 0) app.quit();
        },
      },
      extensions: {
        root: join(app.getPath('userData'), 'Extensions'),
        preloadPath: join(import.meta.dirname, '../preload/extensions.cjs'),
        unpackWorkerPath: join(import.meta.dirname, 'extension-unpack.js'),
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
    // One-time move for profiles from 0.6.x, whose assistant kept its files (panel.json, images, its empty working
    // folder) in userData/duet. A chat's Claude session was keyed by that folder, so it continues with a summary.
    const oldAssistantFolder = join(app.getPath('userData'), 'duet');
    if (existsSync(oldAssistantFolder) && !existsSync(join(app.getPath('userData'), 'assistant'))) {
      try {
        renameSync(oldAssistantFolder, join(app.getPath('userData'), 'assistant'));
      } catch (error) {
        console.error('[chord] Couldn’t move the assistant’s folder:', error);
      }
    }
    assistant = new AssistantService(browser, persistence, app.getPath('userData'), {
      save: async (filename, bytes, mime) => void (await downloads.addFile(filename, bytes, mime, '', null)),
    });
    browser.assistant = assistant;
    // Outside agents (S18): Settings → Agents off (the default), nothing; on, one pipe and one token file, started without
    // waiting for it; the rest (the connect card's code, the gate, the agents' chords) waits for an agent to connect.
    const agentBrowser = browser;
    agents = watchAgents({
      packaged: app.isPackaged,
      store: browser.store,
      devSwitch: devEnv('CHORD_AGENTS'),
      make: async () => {
        const [{ AgentService }, { ConnectCards }, { SiteCards }] = await Promise.all([import('./agents/service'), import('./agents/connect'), import('./agents/site-cards')]);
        // window-owner.exe: beside the app's archive in a packaged build (electron-builder's extraResources: a program
        // can't run from inside the archive), in out/ in a development one (#107).
        const helper = process.platform !== 'win32' ? null : app.isPackaged ? join(process.resourcesPath, 'window-owner.exe') : join(app.getAppPath(), 'out/window-owner/window-owner.exe');
        const waitMs = Number(devEnv('CHORD_AGENT_WAIT_MS')) || undefined;
        // #143's journey: a call's whole deadline (CALL_WAIT_MS), shorter (development builds only).
        const callWaitMs = Number(devEnv('CHORD_AGENT_CALL_WAIT_MS')) || undefined;
        // The window used last (never a private one): where the connect card and an agent's toasts go.
        const lastWindow = () => {
          const w = agentBrowser.lastBrowserWindow();
          return w && !w.isPrivate ? w : null;
        };
        const cards = new ConnectCards({ store: agentBrowser.store, lastWindow: () => lastWindow()?.id ?? null, changed: () => agentBrowser.refreshPopovers() });
        connectCards = cards;
        // The site card (M2c) shows where the connect card does, after it: one card at a time in a window.
        const sites = new SiteCards({ lastWindow: () => lastWindow()?.id ?? null, changed: () => agentBrowser.refreshPopovers() });
        siteCards = sites;
        agentBrowser.agentCardFor = (windowId) => cards.cardFor(windowId) ?? sites.cardFor(windowId);
        agentBrowser.agentWindowClosed = (windowId) => {
          cards.windowClosed(windowId);
          sites.windowClosed(windowId);
        };
        agentBrowser.agentWindowFocused = (windowId) => {
          cards.windowFocused(windowId);
          sites.windowFocused(windowId);
        };
        // Sharing a tab (M1e): the tab menu and the command bar, which offer it only when it can be done. Never in a
        // private window.
        agentBrowser.agentShare = (windowId, nodeId, agentId) => {
          const w = agentBrowser.window(windowId);
          if (w && !w.isPrivate) void agents?.service?.toggleShare(nodeId, agentId);
        };
        agentBrowser.agentShareMenu = (nodeId) => agents?.service?.shareMenu(nodeId) ?? null;
        agentBrowser.agentSharing = () => agents?.service?.sharing ?? false;
        return new AgentService({
          userData: app.getPath('userData'),
          browser: agentBrowser,
          ask: (who, signal) => cards.ask(who, signal),
          askSite: (question, signal) => sites.ask(question, signal),
          askStep: (question, signal) => sites.askStep(question, signal),
          showTab: (windowId, nodeId) => agentBrowser.store.dispatch({ t: 'tab.activate', nodeId, windowId }),
          allowances: { list: () => agentBrowser.store.state.settings.agentsAllowed, set: (agentsAllowed) => agentBrowser.store.dispatch({ t: 'settings.set', settings: { agentsAllowed } }) },
          changed: () => agentBrowser.agentsChanged(),
          helper: helper && existsSync(helper) ? helper : null,
          actions: agentActions({ packaged: app.isPackaged }),
          // E2E only (development builds): the OS can't say who's calling, as in the Flatpak or without ss.
          ...(!app.isPackaged && process.env['CHORD_E2E_NO_PEER'] === '1' ? { peer: async () => ({ pid: null }) } : {}),
          waitMs,
          ...(callWaitMs ? { callWaitMs } : {}),
          dispatch: (command) => agentBrowser.store.dispatch(command),
          neverSites: () => agentBrowser.store.state.settings.assistant.neverSites,
          chords: {
            store: agentBrowser.store,
            neverSites: () => agentBrowser.store.state.settings.assistant.neverSites,
            page: (nodeId) => pageOf(agentBrowser.tabs.get(nodeId)),
            lastWindow: () => {
              const w = lastWindow();
              return w ? { id: w.id, toast: (toast) => w.toast(toast) } : null;
            },
          },
        });
      },
    });
    // Outside agents' tabs (S18): their pages' wiring, and what they held, go to the agents' chords once there are any.
    browser.agentContents = (contents, nodeId) => agents?.service?.chords?.wire(contents, nodeId);
    browser.agentHeld = (nodeId, what, detail, from) => agents?.service?.chords?.note(nodeId, what, detail, from);
    browser.userNavigates = (contents, going) => {
      agents?.service?.chords?.takeOverPage(contents, going);
      assistant?.userMovedPage(contents, going === 'back' ? 'Back' : going === 'forward' ? 'Forward' : typeof going === 'object' ? 'a page you opened' : going === 'stay' ? 'your answer to a warning' : 'a reload');
    };
    browser.userInput = (nodeId, why) => assistant?.userUsedTab(nodeId, why);
    browser.screenChanged = () => assistant?.screenChanged();
    // Ctrl+. / ⌘.: every agent, and every assistant reply, stops.
    browser.stopAll = () => {
      agents?.service?.stopAll();
      void assistant?.stopAll();
    };
    afterLaunch.run(() => void assistant!.afterLaunch());
    // The tabs-with-an-icon index reads every tab, so no navigation waits for it: a slice of buckets a turn, the first
    // on a turn of its own (tens of ms in one pass at 35,000 nodes, a few ms a slice), never right after the task above.
    afterLaunch.run(() => browser!.tabs.warmIcons());
    // A Windows update setup couldn't install (#142): setup put this version back and reopened it to say why.
    afterLaunch.run(() => {
      const failed = takeUpdateFailure(app.getPath('userData'));
      if (failed) browser?.announce('update:failed', failed);
    });
    // Auto picture-in-picture is off by default since 2026-10-25 (it popped videos out unasked): a profile
    // from before gets it switched off once, through the store, so it's saved like any other change.
    if (!browser.store.state.settings.autoPipDefaultOff) browser.store.dispatch({ t: 'settings.set', settings: { autoPip: false, autoPipDefaultOff: true } });
    // Effects asking the assistant: the assistant's own reading rules, one request at a time, nothing kept.
    browser.effects.assistant = {
      available: (windowId, url) => assistant!.effectsProvider(windowId, url),
      ask: (request) => assistant!.oneShot(request),
    };
    serveAssistantImages((url) => assistant!.serveImage(url));
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
    // Passwords in and out (S17 §10): the import process reads a CSV and stages it in chord-data, which alone compares and writes.
    passwordTransfers = new PasswordTransfers({
      workerPath: join(import.meta.dirname, 'import-file.js'),
      data: (op) => store.passwords(op),
      stagePort: (stageId) => store.passwordStagePort(stageId),
      exportPort: () => store.passwordExportPort(),
      vault: passwords,
      gate: importGate,
      folder: () => app.getPath('downloads'),
      onProgress: (listener) => store.onPasswordProgress((push) => listener(push.importId, push.done, push.total)),
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
    });
    // Your data's export (docs/decisions/S15-your-data.md §7): a process of its own reads the database read-only.
    exporter = new Exporter({
      workerPath: join(import.meta.dirname, 'export.js'),
      database: join(app.getPath('userData'), 'chord.db'),
      images: join(app.getPath('userData'), 'assistant', 'images'),
      app: app.getVersion(),
      platform,
      folder: () => app.getPath('documents'),
      data: { flush: () => store.flush(), device: () => store.device(), counts: () => store.exportCounts() },
      passwords: (vaultPassphrase) => passwordTransfers!.exportPort(vaultPassphrase),
      isVaultPassphrase: (passphrase) => passwordTransfers!.isVaultPassphrase(passphrase),
      passwordCount: () => passwordTransfers!.count(),
    });
    // The detector watches the sign-ins the vault's switch and extension rule say (S17 §11), from now on: told at once,
    // and after every change (onChange's stateChanged), only when that changes.
    passwords.attachDetector(passwordDetector, browser.store.state);
    // Your data's import from a Chord file (S15 §5, §7): a process of its own reads and checks the file.
    fileImporter = new FileImporter({
      workerPath: join(import.meta.dirname, 'import-file.js'),
      database: join(app.getPath('userData'), 'chord.db'),
      images: join(app.getPath('userData'), 'assistant', 'images'),
      platform,
      folder: () => app.getPath('documents'),
      state: () => browser!.store.state,
      dispatch: (command) => browser!.store.dispatch(command),
      data: { flush: () => store.flush(), device: () => store.device(), port: (importId) => store.importPort(importId), undo: (importId) => store.undoImport(importId) },
      effects: { importSites: (importId, sites) => browser!.effects.importSites(importId, sites), undoImport: (importId) => browser!.effects.undoImport(importId) },
      assistant: () => assistant,
      toast: (windowId, toast) => browser!.window(windowId)?.toast(toast),
      gate: importGate,
      passwords: passwordTransfers,
    });
    // Your data's sync (S15 §6–§8): chord-data's thread and its worker do the work; main keeps the key and applies what comes in.
    syncService = new SyncService({
      data: { sync: (request) => store.sync(request), flush: () => store.flush(), unsaved: () => store.unsaved, waiting: (key, since) => store.waitingHere(key, since), onPush: (listener) => store.onPush(listener) },
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
    store.onRespawn(() => {
      void syncService?.restarted();
      // The vault's key went with chord-data: locked until it's opened again.
      passwords.restarted();
    });
    // Writes chord-data keeps refusing (a full disk): they wait, are sent again later and later, and the window says so.
    store.onTrouble((failing) => {
      const windowId = browser?.lastBrowserWindow()?.id;
      if (!windowId) return;
      browser!.window(windowId)?.toast({
        id: 'save:failing',
        message: failing ? 'Chord can’t save your changes right now. Is the disk full? It keeps trying.' : 'Chord saved your changes again.',
      });
    });
    // The key is read once launch is over: safeStorage can ask the OS's keychain, which mustn't hold up the first page.
    afterLaunch.run(() => void syncService!.afterLaunch());
    registerIpc();
    // End-to-end tests only (never when packaged): what extensions add to a page's
    // right-click menu, read without opening a native menu; and launch timing.
    if (dev('CHORD_E2E_HOOKS')) {
      // #199: HTTP sign-in's trace (each box, and the navigations it answers), read with httpAuth() below.
      httpAuth.traceForTests();
      // Right-click menus are read, not shown: their labels, newest last, by page.
      const contextMenus = new Map<number, ObservedItem[]>();
      observeContextMenusForTests((contents, items) => contextMenus.set(contents.id, items));
      // The password detector's events, as plain data (the page's contents by id), oldest first. A sign-in's values
      // aren't kept here: only whether it had them, so a test can't leak them by printing what it read.
      const passwordEvents: Record<string, unknown>[] = [];
      for (const type of ['focus', 'blur', 'submitted', 'signedIn', 'failed'] as const) {
        passwordDetector.events.on(type, (event: { contents: Electron.WebContents; frame?: unknown; values?: unknown }) => {
          const { contents, frame: _frame, values, ...rest } = event;
          // `at`: when main heard it, for a test that misses one (#253).
          passwordEvents.push({ type, at: Date.now(), contentsId: contents.id, ...rest, ...(type === 'signedIn' ? { hasValues: Boolean(values) } : {}) });
        });
      }
      (globalThis as Record<string, unknown>)['chordTestHooks'] = {
        /** Passwords (S17): turn detection on or off, as the vault's switch will; and what it has reported. */
        passwordsEnabled: (on: boolean, profileIds?: string[]) => passwordDetector.setEnabled(on, profileIds),
        passwordEvents: () => passwordEvents.slice(),
        /** A trackpad's gesture phase to each window's shell, as macOS sends with a two-finger swipe (#198). */
        gesturePhase: (phase: 'begin' | 'end' | 'fling') => browser!.gesturePhaseForTests(phase),
        /** A chord deleted from elsewhere (another window, the store), as the shell may not (#250: a swipe's neighbor). */
        deleteChord: (chordId: string) => browser!.store.dispatch({ t: 'chord.delete', chordId }),
        /** HTTP sign-in boxes (S17 §10): the ones waiting, and what became of the last answers (#199). No secrets. */
        httpAuth: () => httpAuth.forTests(),
        /** The vault's state and how many sign-ins it holds (no usernames, no passwords): what a test can say was saved. */
        passwordsCount: async () => {
          const view = await passwords.view();
          return { state: view.state, count: view.count };
        },
        /**
         * An extension recorded as installed in the first chord's sign-ins, by store id, with no files (it never loads):
         * a known password manager's stands in for one (S17 §11), whose real package no test can sign. Its chord's name.
         */
        recordExtensionForTests: (id: string, name: string) => {
          const chord = sortedChords(browser!.store.state)[0]!;
          const now = Date.now();
          const extension = { id, profileId: chord.profileId, name, version: '1.0.0', source: 'unpacked' as const, path: join(app.getPath('userData'), 'no-such-extension'), notifiedVersion: '1.0.0', pinned: false, installedAt: now, updatedAt: now };
          browser!.store.dispatch({ t: 'extension.record', extension });
          return chord.name;
        },
        clearPasswordEvents: () => void (passwordEvents.length = 0),
        /** Each window's popover focus events (#200): when, against the card's showing, a click in it and an ask. */
        cardFocus: () => browser!.allWindows.map((w) => w.cardFocusForTests()),
        launch: () => launchTimings(),
        /** Outside agents (S18): whether the endpoint is served, its connections, and the DACL helper's exit code (Windows). */
        agents: async () => {
          await agents?.settled();
          const service = agents?.service;
          return { serving: service?.serving?.path ?? null, connections: service?.connections.size ?? 0, restricted: (await service?.restricted) ?? null };
        },
        /** Stop for every agent, as Ctrl+. will (M1c). */
        agentsStopAll: () => agents?.service?.stopAll(),
        /**
         * S18 M2a's spike: input sent for the agent to its tab at `url` (and `text` inserted), inside one of its calls so the
         * tab is parked and painting, as an action's will be; and what Chord's own listeners took each event for: the
         * agent's, yours, or one that came after the send had returned (none should). `unchecked` sends what Chord never
         * would (a shortcut), to show its shortcuts stop it a second time; otherwise such an event is `refused`.
         */
        agentInputSpike: async (url: string, events: AgentInputEvent[], text?: string, unchecked = false) => {
          const { sendAgentInput, isAgentInput, AgentInputRefused } = await import('./control/input');
          const [nodeId, contents] = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url) ?? [];
          const held = [...(agents?.service?.connections ?? [])][0];
          if (!nodeId || !contents || !held) return null;
          const seen = { agent: 0, yours: 0, after: 0, late: [] as string[] };
          let inside = false;
          const count = (_event: unknown, input: { type: string }) => {
            if (!inside) {
              seen.after++;
              seen.late.push(input.type);
            } else if (isAgentInput(contents)) seen.agent++;
            else seen.yours++;
          };
          const names = ['before-input-event', 'before-mouse-event', 'input-event'] as const;
          for (const name of names) contents.on(name as 'input-event', count);
          const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
          let shown = false;
          let refused = false;
          try {
            await held.connection.agent.call(
              nodeId,
              async () => {
                await wait(300);
                shown = Object.values(browser!.store.state.windows).some((w) => w.agentTab === nodeId);
                inside = true;
                try {
                  sendAgentInput(contents, events, unchecked);
                  if (text) await contents.insertText(text);
                } catch (error) {
                  if (!(error instanceof AgentInputRefused)) throw error;
                  refused = true;
                }
                inside = false;
                await wait(300);
              },
              () => undefined,
            );
          } finally {
            for (const name of names) contents.off(name as 'input-event', count);
          }
          return { ...seen, paused: held.connection.agent.state(nodeId).paused, shown, refused };
        },
        /**
         * S18 M2b's budgets: how long the snapshot script takes in the tab at `url`, round trip from main (the renderer's
         * work and the answer's way back), `runs` times; and what the last one found. Beside each, a plain walk of the
         * same page (`walk`: every element's visibility and computed style read), the same round trip in the same world,
         * so a slow runner slows both: their ratio is a measure a shared CI runner can hold where milliseconds can't
         * (#166).
         */
        agentSnapshotTimes: async (url: string, runs: number) => {
          const [{ snapshotPage }, { ASSISTANT_WORLD }] = await Promise.all([import('./control/snapshot'), import('./control/extract')]);
          const contents = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url)?.[1];
          if (!contents) return null;
          const times: number[] = [];
          const after: number[] = [];
          const walk: number[] = [];
          // The same kind of work the snapshot does for each element (control/snapshot.ts: checkVisibility, computed
          // style), and nothing of its own logic, 8 times over: under a CPU quota a task much shorter than the snapshot
          // is rarely throttled while the snapshot is, so a baseline must cost about what the snapshot costs to scale with it.
          const WALK = `(() => { let n = 0; for (let round = 0; round < 8; round++) for (const el of document.body.querySelectorAll('*')) { if (el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) n++; const style = getComputedStyle(el); n += style.cursor.length + style.display.length; } return n; })()`;
          let last: Awaited<ReturnType<typeof snapshotPage>> = null;
          for (let i = 0; i < runs; i++) {
            const started = performance.now();
            // As an outside agent's snapshot is (#207): its parts kept, each checked by partBlocked.
            last = await snapshotPage(contents, 'timing', `timing${i}`, true, true);
            times.push(performance.now() - started);
            // A moment between snapshots, as an agent's are (seconds apart): the refs' items, place and shape are taken
            // in the task right after each (snapshot.ts), timed on its own.
            await new Promise((done) => setTimeout(done, 30));
            // Its task run by now, as it always is by an agent's next call (seconds later): on a slow runner its timer
            // can still be pending after 30 ms, and the next snapshot timed would wait behind it (#154's macOS x64 run).
            const ms = await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: `(() => { const r = globalThis.__chordSnapshots.get('timing'); if (r && r.finish) r.finish(); return r ? r.finishMs : -1; })()` }]);
            after.push(Number(ms));
            // The baseline, in turn with the snapshot (so load that comes and goes falls on both).
            const walked = performance.now();
            await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: WALK }]);
            walk.push(performance.now() - walked);
          }
          return { times, after, walk, nodes: last?.nodes.length ?? 0, keys: last?.nodes.filter((n) => n.key !== undefined).length ?? 0, cut: last?.cut ?? null };
        },
        /**
         * Round 1 of #270 (B1): one change of the page at `url`, `code` run in Chord's world by the next snapshot there,
         * between its answer and the task after it, where the page can change before that task: a test's way to land
         * in that gap every time. Once, then gone.
         */
        agentBeforeFinish: async (url: string, code: string) => {
          const { ASSISTANT_WORLD } = await import('./control/extract');
          const contents = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url)?.[1];
          if (!contents) return false;
          await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: `globalThis.__chordBeforeFinish = () => { ${code} }; true` }]);
          return true;
        },
        /**
         * #166: what each part of the snapshot's walk costs on the page at `url`: the snapshot as an agent's, and with one
         * part left out at a time (snapshot.ts' SnapshotProbe), all in turn, `runs` rounds, so load that comes and goes
         * falls on each. Milliseconds, round trip from main, by variant. Measured only: no agent's snapshot leaves one out.
         */
        agentSnapshotParts: async (url: string, runs: number) => {
          const [{ snapshotPage }, { ASSISTANT_WORLD }] = await Promise.all([import('./control/snapshot'), import('./control/extract')]);
          const contents = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url)?.[1];
          if (!contents) return null;
          const variants = { full: {}, eagerPart: { eagerPart: true }, shape: { shape: true }, near: { near: true }, items: { items: true } } as const;
          const times: Record<string, number[]> = {};
          // An owner per variant, so no variant's ids (sidOf's cache) are another's (round 1 of #270, SF1); all of them
          // let go of afterwards, as no agent's.
          const owners = Object.keys(variants).map((name) => `parts-${name}`);
          for (let i = 0; i < runs; i++) {
            for (const [name, probe] of Object.entries(variants)) {
              const owner = `parts-${name}`;
              const started = performance.now();
              await snapshotPage(contents, owner, `parts${i}${name}`, true, true, probe);
              (times[name] ??= []).push(performance.now() - started);
              // Its task after the snapshot run before the next is timed (as agentSnapshotTimes does).
              await new Promise((done) => setTimeout(done, 20));
              await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: `(() => { const r = globalThis.__chordSnapshots.get(${JSON.stringify(owner)}); if (r && r.finish) r.finish(); return 0; })()` }]);
            }
          }
          await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [{ code: `(() => { for (const o of ${JSON.stringify(owners)}) { globalThis.__chordSnapshots && globalThis.__chordSnapshots.delete(o); globalThis.__chordSids && globalThis.__chordSids.delete(o); } return 0; })()` }]);
          return times;
        },
        /**
         * S18 M2c's budget: an action's own work in the page before its input is sent (the element checked, scrolled to
         * and hit-tested: the `point` step), round trip from main, `runs` times, on the middle element of a snapshot.
         */
        /**
         * The send hold's cost (control/sends.ts): the agent's tab at `url` loaded again `runs` times with the Fetch domain
         * off in its page and on (every request then passes through the hold), in turns. Milliseconds to the load's end.
         */
        agentWatchTimes: async (url: string, runs: number) => {
          const { sendsOn } = await import('./control/sends');
          const contents = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url)?.[1];
          if (!contents) return null;
          // A fresh address each time (nothing cached, no reload's own work).
          let n = 0;
          const load = () =>
            new Promise<number>((done) => {
              const started = performance.now();
              contents.once('did-stop-loading', () => done(performance.now() - started));
              void contents.loadURL(`${url}?run=${++n}`).catch(() => undefined);
            });
          const off: number[] = [];
          const on: number[] = [];
          for (let i = 0; i < runs; i++) {
            await contents.debugger.sendCommand('Fetch.disable').catch(() => undefined);
            off.push(await load());
            if (!(await sendsOn(contents))) return { off, on, failed: 'no hold' };
            on.push(await load());
          }
          return { off, on };
        },
        /** M2g-1: where actions' time went since the last read (control/phases.ts), cleared. */
        agentPhaseTimes: async () => (await import('./control/phases')).takePhases(),
        /** The owner's token goal: each tool result's size since the last read (control/phases.ts), cleared. */
        agentResultSizes: async () => (await import('./control/phases')).takeResults(),
        agentActTimes: async (url: string, runs: number) => {
          const [{ snapshotPage }, { actOnPage }, { openDeep }] = await Promise.all([import('./control/snapshot'), import('./control/act'), import('./control/deep')]);
          const contents = [...browser!.tabs.entries()].find(([, c]) => c.getURL() === url)?.[1];
          if (!contents) return null;
          const read = await snapshotPage(contents, 'timing', 'timing-act');
          const keys = read?.nodes.flatMap((n) => (n.key === undefined ? [] : [n.key])) ?? [];
          const key = keys[Math.floor(keys.length / 2)];
          if (key === undefined) return null;
          const times: number[] = [];
          // Neon's review of #110: the debugger's session for a press or typing (attach, find Chord's world, the hit
          // test, the closed-root check, let go), on the same element.
          const deep: number[] = [];
          for (let i = 0; i < runs; i++) {
            const started = performance.now();
            const answer = await actOnPage(contents, 'timing', 'timing-act', key, { op: 'point', highlight: false });
            times.push(performance.now() - started);
            if (!answer.ok) return { times, deep, failed: answer.why };
            const opened = performance.now();
            const session = await openDeep(contents, 'timing', 'timing-act', key);
            if (!session) return { times, deep, failed: 'no session' };
            const scroll = (await contents.executeJavaScript('[scrollX, scrollY]')) as [number, number];
            const hit = await session.hit(answer.x! + scroll[0], answer.y! + scroll[1]);
            const open = await session.open();
            await session.close();
            deep.push(performance.now() - opened);
            if (!hit.ok || !open.ok) return { times, deep, failed: `deep: ${JSON.stringify(hit.ok ? open : hit)}` };
          }
          // The owner's bug #2: the same element replaced by a copy of itself each time (a page that redraws), then the
          // step that finds it again (act.ts). Whether it was found, and how long the step took.
          const { ASSISTANT_WORLD } = await import('./control/extract');
          const refind: number[] = [];
          let refound = 0;
          for (let i = 0; i < runs; i++) {
            await contents.executeJavaScriptInIsolatedWorld(ASSISTANT_WORLD, [
              { code: `(() => { const e = globalThis.__chordSnapshots.get('timing').keep[${key}].ref.deref(); if (e) e.replaceWith(e.cloneNode(true)); })()` },
            ]);
            const started = performance.now();
            const answer = await actOnPage(contents, 'timing', 'timing-act', key, { op: 'point', highlight: false });
            refind.push(performance.now() - started);
            if (answer.ok && answer.refound) refound++;
          }
          return { times, deep, refind, refound };
        },
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
        /** An idle reconcile now, `local` checked against the rows first, answered once it's done. */
        syncDrift: () => store.sync({ type: 'sync.reconcile', idle: true, wait: true }),
        /** Sync's costs on chord-data's thread: writes with it on and off, the stamping hook, frames, merged slices (ms). */
        syncTimings: async () => (await store.sync({ type: 'sync.timings' })).timings,
        /** Turn sync off at once (Settings holds it for its Undo first). */
        syncOff: () => store.sync({ type: 'sync.off' }),
        /** The unlock card in the last window's popover, as the menu under a field will ask for it: true once the vault is open. */
        passwordsAskUnlock: () => {
          const w = browser!.lastBrowserWindow();
          return w ? passwords.askUnlock(w.id) : Promise.resolve(false);
        },
        /** Pinned folders and tabs, and how many have a name ending in `suffix`: what a sync check waits for, without a state snapshot. */
        pinnedNames: (suffix: string) => {
          const pinned = nodeList(browser!.store.state).filter((n) => n.section === 'pinned');
          return { count: pinned.length, named: pinned.filter((n) => (n.kind === 'tab' ? n.customTitle : n.kind === 'folder' ? n.title : null)?.endsWith(suffix)).length };
        },
        /**
         * A chord with all its pinned tabs: deleted (`delete`), its Undo (`restore`), or a second one made first so it can
         * go (`spare`); answered once chord-data has written it (perf.spec.ts times keystrokes around it).
         */
        chordForTests: async (what: 'spare' | 'delete' | 'restore') => {
          const state = browser!.store.state;
          const windowId = Object.keys(state.windows)[0]!;
          const busiest = Object.values(state.chords).sort((a, b) => nodeList(state).filter((n) => n.chordId === b.id).length - nodeList(state).filter((n) => n.chordId === a.id).length)[0];
          if (what === 'spare') browser!.store.dispatch({ t: 'chord.create', windowId, name: 'Spare', icon: 'S', theme: state.chords[Object.keys(state.chords)[0]!]!.theme });
          else if (what === 'delete' && busiest) browser!.store.dispatch({ t: 'chord.delete', chordId: busiest.id });
          else if (what === 'restore' && state.deletedChords[0]) browser!.store.dispatch({ t: 'chord.restore', windowId, chordId: state.deletedChords[0].chord.id });
          await store.flush();
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
