/**
 * Chrome extensions in Chord (ARCHITECTURE.md §12): one ExtensionHost per
 * profile that has extensions, Chord's own verified Web Store installer and
 * updater, the install step Electron skips (runtime.onInstalled and manifest
 * rulesets), the toolbar buttons each window shows, and their popups.
 */
import {
  activeTabId,
  extensionKey,
  isPrivateProfile,
  profileFolderName,
  tabsInOrder,
  openedTab,
  nodeOf,
  uuidv7,
  type Command,
  type InstalledExtension,
  type NodeId,
  type State,
  type WindowId,
} from '@chord/core';
import type { ExtensionAction, ExtensionInfo, ExtensionsBarState, InstallResult, Rect, Toast } from '@chord/ipc';
import { BaseWindow, BrowserWindow, Menu, nativeImage, type ContextMenuParams, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { cp, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { send } from '../ipc';
import type { AppWindow } from '../window';
import { extensionIdFrom } from './crx';
import { ExtensionHost, within, type HostCallbacks } from './host';
import { ExtensionPopup } from './popup';
import { unpackInWorker } from './unpack';
import { isNewerVersion, type WebStore } from './webstore';

/**
 * One extension's update (download, unpack, load, the install step) fails if
 * it takes longer than this, so a step that never settles can't hold every
 * later check. Far beyond a real update: downloading and unpacking each give
 * up at five minutes on their own.
 */
const UPDATE_DEADLINE_MS = 15 * 60_000;
/** Chrome checks for extension updates about every five hours. */
const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;
const FIRST_UPDATE_CHECK_MS = 60 * 1000;
/** The toolbar's icons are 16 px; they're rendered at 2× for sharp HiDPI. */
const ACTION_ICON_PX = 32;
const NEW_TAB_URL = 'about:blank';

export interface ExtensionsDeps {
  state(): State;
  dispatch(command: Command): void;
  profileSession(profileId: string): Session;
  /** What a page's first load waits for in its session (its proxy, its chord's ad-blocking rules; tabs.ts' whenProxied). */
  proxyReady?(session: Session): Promise<void> | null;
  /** Where Web Store extensions are unpacked: <userData>/Extensions. */
  root: string;
  /** The library's preload, as built (out/preload/extensions.cjs). */
  preloadPath: string;
  /** The worker that verifies and unpacks Web Store packages, as built (out/main/extension-unpack.js). */
  unpackWorkerPath: string;
  webStore: WebStore;
  /** SHA-256 of the key every package must also be signed with: the Web Store's, except in tests. */
  publisherKeyHash?: string;
  /** Tests only: how long one extension's update may take (UPDATE_DEADLINE_MS otherwise). */
  updateDeadlineMs?: number;
  windows(): Iterable<AppWindow>;
  windowById(windowId: WindowId): AppWindow | undefined;
  lastWindow(): AppWindow | undefined;
  /** The Chord window a tab belongs to (showing it, or showing its chord). */
  windowOfNode(nodeId: NodeId): WindowId | undefined;
  nodeFor(contents: WebContents): NodeId | undefined;
  /** Tabs that have a page right now. */
  liveTabs(): Iterable<[NodeId, WebContents]>;
  /**
   * An outside agent's tab (S18): never one extensions' chrome.tabs lists or is told is shown (the owner,
   * 2026-11-23). Their content scripts still run there: Electron injects them for the whole profile session, which an
   * agent's tab shares for the chord's sign-ins (a stated limit; Settings → Agents says so).
   */
  agentPage?(contents: WebContents): boolean;
  ensureTab(nodeId: NodeId): WebContents | undefined;
  toast(windowId: WindowId, message: string, action?: Toast['action']): void;
  openSettings(section: string): void;
  /** The installed list changed in a way state doesn't show (loaded or not): Settings refreshes. */
  changed(): void;
}

interface ManifestShape {
  name?: string;
  version?: string;
  description?: string;
  icons?: Record<string, string>;
  options_page?: string;
  options_ui?: { page?: string };
  homepage_url?: string;
  background?: { service_worker?: string };
  declarative_net_request?: { rule_resources?: { id: string; enabled?: boolean }[] };
}

const readManifest = (dir: string): ManifestShape & Record<string, unknown> =>
  // Some manifests start with a byte-order mark, which JSON.parse rejects (\s matches it).
  JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^\s+/, '')) as ManifestShape & Record<string, unknown>;

/** The extension's own icon (not its action's), as a data URL. */
function manifestIcon(dir: string, manifest: ManifestShape, px: number): string | null {
  const icons = Object.entries(manifest.icons ?? {})
    .map(([s, path]) => [Number(s), path] as const)
    .filter(([s]) => Number.isFinite(s))
    .sort((a, b) => a[0] - b[0]);
  const pick = icons.find(([s]) => s >= px) ?? icons.at(-1);
  if (!pick) return null;
  const file = resolve(dir, pick[1].replace(/^\//, ''));
  if (!file.startsWith(resolve(dir) + sep)) return null;
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? null : image.resize({ width: px, height: px, quality: 'best' }).toDataURL();
}

/** Two paths to one folder, on a file system that ignores case (Windows, macOS, some Linux mounts) or not (#319). */
const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * Where an install of `id` at `version` unpacks: `<root>/<profile>/<id>/<version>_<n>`, the profile's folder named
 * one-to-one (core's profileFolderName: `Work` → `_work`, so `Work` and `work` never share one; Chord's own ids as
 * they always were), and `n` the first that's neither on disk nor `taken` (another extension's, a twin's or an old
 * one): an install never writes into, or on failure removes, a folder something else uses (#319).
 */
export function extensionFolder(root: string, profileId: string, id: string, version: string, taken: (path: string) => boolean): string {
  const base = join(root, profileFolderName(profileId), id);
  const clean = version.replace(/[^\d.]/g, '');
  for (let n = 0; ; n++) {
    const path = join(base, `${clean}_${n}`);
    if (!existsSync(path) && !taken(path)) return path;
  }
}

export class Extensions {
  private readonly hosts = new Map<string, ExtensionHost>();
  private readonly popups = new Map<WindowId, ExtensionPopup>();
  /** The button a popup is about to open under (set just before the library asks Chord to show it). */
  private pendingAnchor: { extensionId: string; windowId: WindowId; anchor: Rect } | null = null;
  /** A popup that just closed because its own button was pressed: the click shouldn't reopen it. */
  private lastBlurClose: { windowId: WindowId; extensionId: string; at: number } | null = null;
  private readonly barSent = new Map<WindowId, string>();
  private readonly iconCache = new Map<string, string | null>();
  private readonly installing = new Map<string, Promise<InstallResult>>();
  /**
   * Updates in flight (by extensionKey). Reconcile leaves these alone, and an
   * install of the same extension (removed, then added again) waits for it:
   * both would unpack into the same version's folder.
   */
  private readonly updating = new Map<string, Promise<boolean>>();
  /** The update check running now: a second caller (the timer, Settings) gets the same one. */
  private updateCheck: Promise<number> | null = null;
  private readonly popupWindows = new Set<BrowserWindow>();
  /** Extensions loading again after Undo, and ones that wouldn't load (by extensionKey). */
  private readonly loading = new Set<string>();
  private readonly unloadable = new Set<string>();
  /** Launch's removal of folders nothing uses; installs wait for it. */
  private cleanup: Promise<void> = Promise.resolve();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private syncQueued = false;

  constructor(private readonly deps: ExtensionsDeps) {}

  /* ---------- Hosts ---------- */

  private host(profileId: string, create: boolean): ExtensionHost | undefined {
    const existing = this.hosts.get(profileId);
    if (existing || !create) return existing;
    const host = new ExtensionHost(profileId, this.deps.profileSession(profileId), this.deps.preloadPath, this.callbacks(profileId));
    this.hosts.set(profileId, host);
    // Pages already open in this profile become tabs extensions can see.
    for (const [nodeId, contents] of this.deps.liveTabs()) {
      if (contents.session !== host.session || this.deps.agentPage?.(contents)) continue;
      const w = this.windowForNode(nodeId);
      if (w) host.addTab(contents, w.window);
    }
    for (const w of this.deps.windows()) if (w.activeTabContents?.session === host.session && !this.shownAgentTab(w)) host.selectTab(w.activeTabContents);
    return host;
  }

  private hostForSession(session: Session): ExtensionHost | undefined {
    for (const host of this.hosts.values()) if (host.session === session) return host;
    return undefined;
  }

  private windowForNode(nodeId: NodeId): AppWindow | undefined {
    const windowId = this.deps.windowOfNode(nodeId);
    return windowId ? this.deps.windowById(windowId) : undefined;
  }

  private windowForBase(base: BaseWindow): AppWindow | undefined {
    for (const w of this.deps.windows()) if (w.window === base) return w;
    return undefined;
  }

  private profileOfWindow(w: AppWindow): string {
    const state = this.deps.state();
    const chordId = state.windows[w.id]?.activeChordId;
    return (chordId ? state.chords[chordId]?.profileId : undefined) ?? 'default';
  }

  /** How Chord carries out what extensions ask of tabs and windows, for one profile. */
  private callbacks(profileId: string): HostCallbacks {
    return {
      createTab: async ({ url, active, windowId }) => {
        const base = windowId !== undefined ? BaseWindow.fromId(windowId) : null;
        // Never into a private window, even one named by its id: extensions don't run there.
        const named = base ? this.windowForBase(base) : undefined;
        const w = (named && !named.isPrivate ? named : undefined) || this.deps.lastWindow();
        if (!w) throw new Error('No window to open a tab in');
        const nodeId = uuidv7();
        const before = this.deps.state();
        this.deps.dispatch({ t: 'tab.open', windowId: w.id, url: url ?? NEW_TAB_URL, background: !active, id: nodeId });
        const contents = openedTab(before, this.deps.state(), w.id, nodeId) ? this.deps.ensureTab(nodeId) : undefined;
        if (!contents) throw new Error('The tab could not be opened');
        if (contents.session !== this.host(profileId, false)?.session) throw new Error('The tab opened in another profile');
        return [contents, w.window];
      },
      selectTab: (contents, base) => {
        const nodeId = this.deps.nodeFor(contents);
        const w = this.windowForBase(base);
        if (!nodeId || !w || activeTabId(this.deps.state(), w.id) === nodeId) return;
        this.deps.dispatch({ t: 'tab.activate', windowId: w.id, nodeId });
      },
      closeTab: (contents) => {
        const nodeId = this.deps.nodeFor(contents);
        const windowId = nodeId ? this.deps.windowOfNode(nodeId) : undefined;
        if (nodeId && windowId) this.deps.dispatch({ t: 'tab.close', windowId, nodeId });
      },
      tabFacts: (contents) => {
        const state = this.deps.state();
        const nodeId = this.deps.nodeFor(contents);
        const node = nodeId ? nodeOf(state, nodeId) : undefined;
        if (node?.kind !== 'tab') return undefined;
        return { pinned: node.section === 'pinned', index: tabsInOrder(state, node.chordId).findIndex((t) => t.id === node.id) };
      },
      createWindow: async (details) => {
        const urls = (Array.isArray(details.url) ? details.url : details.url ? [details.url] : []).filter((u) => /^(https?|chrome-extension):/i.test(u));
        if (details.type === 'popup' || details.type === 'panel') return this.openPopupWindow(profileId, urls[0] ?? NEW_TAB_URL, details);
        // Chord opens new windows only from its own UI for now: the pages go to tabs in the last window.
        const w = this.deps.lastWindow();
        if (!w) throw new Error('No window');
        for (const url of urls) this.deps.dispatch({ t: 'tab.open', windowId: w.id, url });
        return w.window;
      },
      closeWindow: (base) => {
        if (base instanceof BrowserWindow && this.popupWindows.has(base)) base.close();
        else this.windowForBase(base)?.window.close();
      },
      openPopup: ({ extensionId, tab, window: base, url }) => {
        const nodeId = this.deps.nodeFor(tab);
        const w = this.windowForBase(base) ?? (nodeId ? this.windowForNode(nodeId) : undefined);
        if (!w) return;
        const pending = this.pendingAnchor;
        this.pendingAnchor = null;
        const anchor = pending && pending.extensionId === extensionId && pending.windowId === w.id ? pending.anchor : null;
        this.popups.get(w.id)?.close();
        const popup = new ExtensionPopup(w, {
          extensionId,
          session: tab.session,
          url,
          anchor,
          proxyReady: this.deps.proxyReady ? (session) => this.deps.proxyReady!(session) : undefined,
          openTab: (link) => this.deps.dispatch({ t: 'tab.open', windowId: w.id, url: link }),
          onClosed: (reason) => {
            if (this.popups.get(w.id) === popup) this.popups.delete(w.id);
            if (reason === 'blur') this.lastBlurClose = { windowId: w.id, extensionId, at: Date.now() };
          },
        });
        this.popups.set(w.id, popup);
      },
      actionsChanged: () => this.sync(),
    };
  }

  /** `windows.create({type: 'popup'})`: a password manager's pop-out, say. A small window on the profile's session. */
  private openPopupWindow(profileId: string, url: string, details: { width?: number; height?: number; focused?: boolean }): BrowserWindow {
    const win = new BrowserWindow({
      width: Math.min(Math.max(details.width ?? 420, 200), 1200),
      height: Math.min(Math.max(details.height ?? 640, 200), 1000),
      autoHideMenuBar: true,
      show: details.focused !== false,
      webPreferences: { session: this.deps.profileSession(profileId), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    this.popupWindows.add(win);
    win.on('closed', () => this.popupWindows.delete(win));
    win.webContents.setWindowOpenHandler(({ url: link }) => {
      const w = this.deps.lastWindow();
      if (w && /^(https?|chrome-extension):/i.test(link)) this.deps.dispatch({ t: 'tab.open', windowId: w.id, url: link });
      return { action: 'deny' };
    });
    // Its session's pages wait until it's ready (#189); so does this one, asked again as each wait ends (#277).
    // A wait that rejects is over (#299): asked again, a source answering that same wait isn't waited on.
    const load = (failed?: Promise<void>): void => {
      if (win.isDestroyed()) return;
      const asked = this.deps.proxyReady?.(win.webContents.session) ?? null;
      const pending = asked === failed ? null : asked;
      if (pending)
        pending.then(
          () => load(),
          () => load(pending),
        );
      else void win.loadURL(url).catch(() => {});
    };
    load();
    return win;
  }

  /* ---------- Tabs and menus (called by Browser) ---------- */

  /** A tab got a page: extensions in its profile see it as a tab. */
  tabCreated(contents: WebContents, nodeId: NodeId): void {
    if (this.deps.agentPage?.(contents)) return;
    const host = this.hostForSession(contents.session);
    const w = this.windowForNode(nodeId);
    if (host && w) host.addTab(contents, w.window);
  }

  /** A window now shows this tab. */
  tabShown(w: AppWindow): void {
    const contents = w.activeTabContents;
    if (contents && !this.shownAgentTab(w)) this.hostForSession(contents.session)?.selectTab(contents);
    this.sync();
  }

  /** The window shows an agent's tab (over its chord): never one extensions are told about. */
  private shownAgentTab(w: AppWindow): boolean {
    const contents = w.activeTabContents;
    return Boolean(contents && this.deps.agentPage?.(contents));
  }

  /** Extensions' items for a right-click on a page. */
  contextMenuItems(contents: WebContents, params: ContextMenuParams): Electron.MenuItem[] {
    return this.hostForSession(contents.session)?.contextMenuItems(contents, params) ?? [];
  }

  /* ---------- Toolbar ---------- */

  /** Recompute every window's buttons soon (coalesced), and send the ones that changed. */
  sync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      for (const w of this.deps.windows()) {
        const state = this.barState(w);
        const json = JSON.stringify(state);
        if (this.barSent.get(w.id) === json) continue;
        this.barSent.set(w.id, json);
        send(w.shell.webContents, 'extensions:state', state);
      }
    });
  }

  /** A window's shell was reloaded: send its buttons again. */
  forget(windowId: WindowId): void {
    this.barSent.delete(windowId);
    this.popups.get(windowId)?.close();
  }

  barState(w: AppWindow): ExtensionsBarState {
    const profileId = this.profileOfWindow(w);
    const host = this.host(profileId, false);
    const state = this.deps.state();
    const tab = w.activeTabContents && !w.activeTabContents.isDestroyed() ? w.activeTabContents : null;
    const actions: ExtensionAction[] = host
      ? host
          .actions(tab)
          .map((a) => {
            const key = `${profileId}/${a.extensionId}/${tab?.id ?? ''}/${a.iconVersion}`;
            if (!this.iconCache.has(key)) this.iconCache.set(key, host.icon(a.extensionId, tab, ACTION_ICON_PX));
            const pinned = state.extensions[extensionKey(profileId, a.extensionId)]?.pinned ?? true;
            return { id: a.extensionId, profileId, pinned, title: a.title, badgeText: a.badgeText, badgeColor: a.badgeColor, icon: this.iconCache.get(key) ?? null };
          })
          .sort((a, b) => a.title.localeCompare(b.title))
      : [];
    const installed = Object.values(state.extensions).filter((e) => e.profileId === profileId).length;
    const activeId = activeTabId(state, w.id);
    const url = activeId ? (nodeOf(state, activeId) as { url?: string } | undefined)?.url : undefined;
    const storeId = url ? extensionIdFrom(url) : null;
    const offer = storeId && !state.extensions[extensionKey(profileId, storeId)] ? { id: storeId } : null;
    const installing = [...this.installing.keys()].find((k) => k.startsWith(`${profileId}:`))?.slice(profileId.length + 1) ?? null;
    return { actions, installed, offer, installing };
  }

  /** A click on an extension's button in this window. */
  activate(w: AppWindow, extensionId: string, anchor: Rect): void {
    const open = this.popups.get(w.id);
    if (open && open.extensionId === extensionId) {
      open.close();
      return;
    }
    const recent = this.lastBlurClose;
    if (recent && recent.windowId === w.id && recent.extensionId === extensionId && Date.now() - recent.at < 400) return;
    const host = this.host(this.profileOfWindow(w), false);
    const tab = w.activeTabContents;
    if (!host || !tab || tab.session !== host.session) return;
    this.pendingAnchor = { extensionId, windowId: w.id, anchor };
    try {
      host.activate(extensionId, tab, anchor);
    } finally {
      this.pendingAnchor = null;
    }
  }

  /** Right-click on an extension's button: its own items, then Options, Unpin, Remove and Settings. */
  menu(w: AppWindow, extensionId: string, at: { x: number; y: number }): void {
    const profileId = this.profileOfWindow(w);
    const host = this.host(profileId, false);
    const ext = host?.get(extensionId);
    const record = this.deps.state().extensions[extensionKey(profileId, extensionId)];
    if (!host || !ext || !record) return;
    const manifest = ext.manifest as ManifestShape;
    const items: (MenuItemConstructorOptions | Electron.MenuItem)[] = [
      {
        label: ext.name,
        click: () => this.deps.dispatch({ t: 'tab.open', windowId: w.id, url: manifest.homepage_url ?? `https://chromewebstore.google.com/detail/${extensionId}` }),
      },
    ];
    const own = host.actionMenuItems(extensionId);
    if (own.length > 0) items.push({ type: 'separator' }, ...own);
    items.push({ type: 'separator' });
    const options = this.optionsUrl(ext);
    if (options) items.push({ label: 'Options', click: () => this.deps.dispatch({ t: 'tab.open', windowId: w.id, url: options }) });
    items.push(
      {
        label: record.pinned ? 'Unpin' : 'Pin',
        click: () => this.deps.dispatch({ t: 'extension.pin', profileId, id: extensionId, pinned: !record.pinned }),
      },
      { label: 'Remove', click: () => this.remove(profileId, extensionId, w.id) },
      { type: 'separator' },
      { label: 'Manage in Settings', click: () => this.deps.openSettings('extensions') },
    );
    w.popupMenu(Menu.buildFromTemplate(items), { x: at.x, y: at.y, width: 0, height: 0 });
  }

  private optionsUrl(ext: Electron.Extension): string | null {
    const manifest = ext.manifest as ManifestShape;
    const page = manifest.options_ui?.page ?? manifest.options_page;
    return page ? `chrome-extension://${ext.id}/${page.replace(/^\//, '')}` : null;
  }

  openOptions(profileId: string, id: string): void {
    const ext = this.host(profileId, false)?.get(id);
    const url = ext ? this.optionsUrl(ext) : null;
    const w = this.deps.lastWindow();
    if (url && w) {
      this.deps.dispatch({ t: 'tab.open', windowId: w.id, url });
      w.window.focus();
    }
  }

  /* ---------- Installed list (Settings) ---------- */

  infos(): ExtensionInfo[] {
    return Object.values(this.deps.state().extensions)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const loaded = this.host(e.profileId, false)?.get(e.id) ?? null;
        let manifest: ManifestShape = {};
        try {
          manifest = (loaded?.manifest as ManifestShape | undefined) ?? readManifest(e.path);
        } catch {
          // A missing folder lists as not loaded.
        }
        const key = `info/${e.profileId}/${e.id}/${e.version}`;
        if (!this.iconCache.has(key)) this.iconCache.set(key, existsSync(e.path) ? manifestIcon(e.path, manifest, ACTION_ICON_PX) : null);
        return {
          id: e.id,
          profileId: e.profileId,
          name: loaded?.name ?? e.name,
          version: e.version,
          source: e.source,
          description: typeof manifest.description === 'string' && !manifest.description.startsWith('__MSG_') ? manifest.description : '',
          icon: this.iconCache.get(key) ?? null,
          hasOptions: Boolean(manifest.options_ui?.page ?? manifest.options_page),
          loaded: Boolean(loaded),
        };
      });
  }

  /* ---------- Install, update, remove ---------- */

  /**
   * Load everything installed (and, in development, folders named in
   * CHORD_LOAD_EXTENSION), before any window opens so content scripts reach
   * restored tabs. Then finish any install step a crash interrupted, and
   * start checking for updates.
   */
  async start(devFolders: readonly string[] = []): Promise<void> {
    // Launch loads everything itself, once: a store change meanwhile (the split moving a record) never has reconcile()
    // load from a folder that's about to change, or a second time (Neon's B1 on #334).
    this.starting = true;
    try {
      await this.startLoading(devFolders);
    } finally {
      this.starting = false;
    }
    for (const e of Object.values(this.deps.state().extensions)) void this.finishInstall(e);
    this.deps.changed();
    this.updateTimer = setTimeout(() => void this.scheduledUpdateCheck().finally(() => this.scheduleUpdates()), FIRST_UPDATE_CHECK_MS);
    this.updateTimer.unref?.();
  }

  /** Launch's part that nothing else may load during: the split, the cleanup's start, and every extension's load. */
  private async startLoading(devFolders: readonly string[]): Promise<void> {
    // Profiles whose ids differ only in case sharing one folder (before #319): each gets its own, before anything loads.
    await this.splitShared();
    // Off the launch path; installs and updates wait for it, so it never sees a folder they're writing.
    this.cleanup = this.removeOrphanFolders().catch((error: unknown) => console.error('Cleaning up old extension folders failed:', error));
    const installed = Object.values(this.deps.state().extensions);
    await Promise.all(
      installed.map(async (e) => {
        if (!existsSync(join(e.path, 'manifest.json'))) {
          console.error(`Extension ${e.name} (${e.id}) is missing its folder: ${e.path}`);
          return;
        }
        try {
          await this.host(e.profileId, true)!.load(e.path);
        } catch (error) {
          console.error(`Extension ${e.name} (${e.id}) didn't load:`, error);
        }
      }),
    );
    for (const folder of devFolders) {
      try {
        await this.loadUnpacked('default', folder);
      } catch (error) {
        console.error(`CHORD_LOAD_EXTENSION: ${folder} didn't load:`, error);
      }
    }
  }

  /** While launch loads everything (start): reconcile waits for it, never loading the same extension beside it. */
  private starting = false;

  private scheduleUpdates(): void {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => void this.scheduledUpdateCheck().finally(() => this.scheduleUpdates()), UPDATE_INTERVAL_MS);
    this.updateTimer.unref?.();
  }

  /** The Web Store is Google's: Google-free mode skips the background checks (installing is still up to you). */
  private async scheduledUpdateCheck(): Promise<void> {
    if (!this.deps.state().settings.googleFree) await this.checkForUpdates();
  }

  stop(): void {
    clearTimeout(this.updateTimer);
    for (const popup of this.popups.values()) popup.close();
  }

  /** A folder loaded as is, for development (Chrome's "Load unpacked"). It's never deleted by Chord. */
  async loadUnpacked(profileId: string, folder: string): Promise<InstalledExtension> {
    const path = resolve(folder);
    const host = this.host(profileId, true)!;
    const ext = await host.load(path);
    const key = extensionKey(profileId, ext.id);
    const previous = this.deps.state().extensions[key];
    const now = Date.now();
    const record: InstalledExtension = {
      id: ext.id,
      profileId,
      name: ext.name,
      version: ext.version,
      source: 'unpacked',
      path,
      notifiedVersion: previous?.path === path ? previous.notifiedVersion : null,
      pinned: previous?.pinned ?? true,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
    this.deps.dispatch({ t: 'extension.record', extension: record });
    return record;
  }

  /**
   * Install from the Chrome Web Store into a profile: check, download,
   * verify (CRX3 signatures, the store's hash), unpack, load, then do the
   * install step. `input` is an ID or a store page's address.
   */
  install(profileId: string, input: string, windowId?: WindowId): Promise<InstallResult> {
    // Electron can't load extensions into a private window's in-memory session, and nothing there is kept.
    if (isPrivateProfile(profileId)) return Promise.resolve({ ok: false, error: 'Extensions can’t be added in a private window.' });
    const id = extensionIdFrom(input);
    if (!id) return Promise.resolve({ ok: false, error: 'That isn’t a Chrome Web Store extension or its ID.' });
    const key = extensionKey(profileId, id);
    const existing = this.deps.state().extensions[key];
    if (existing) return Promise.resolve({ ok: true, name: existing.name });
    const running = this.installing.get(key);
    if (running) return running;
    const updating = this.updating.get(key);
    const task = (updating ? within(updating.catch(() => false), this.deps.updateDeadlineMs ?? UPDATE_DEADLINE_MS) : Promise.resolve())
      .then(() => this.installFromStore(profileId, id))
      .then((record): InstallResult => ({ ok: true, name: record.name }))
      .catch((error: unknown): InstallResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        this.installing.delete(key);
        this.sync();
        this.deps.changed();
        if (windowId) this.deps.toast(windowId, result.ok ? `Added ${result.name}` : `Couldn’t add the extension: ${result.error}`);
        return result;
      });
    this.installing.set(key, task);
    this.sync();
    return task;
  }

  private async installFromStore(profileId: string, id: string): Promise<InstalledExtension> {
    const [info] = await this.deps.webStore.check([{ id }]);
    if (!info || info.status !== 'ok' || !info.version || !info.codebase) {
      throw new Error(info?.status === 'noupdate' || info?.status?.includes('unknown') ? 'The Chrome Web Store doesn’t have it.' : `The Chrome Web Store said “${info?.status ?? 'nothing'}”.`);
    }
    const path = await this.unpackFromStore(profileId, id, info.version, await this.deps.webStore.download(info), info.sha256);
    const host = this.host(profileId, true)!;
    let ext: Electron.Extension;
    try {
      ext = await host.load(path);
    } catch (error) {
      await this.removeFolder(path);
      throw error;
    }
    if (ext.id !== id) {
      host.unload(ext.id);
      await this.removeFolder(path);
      throw new Error('The package’s ID doesn’t match.');
    }
    const now = Date.now();
    const record: InstalledExtension = { id, profileId, name: ext.name, version: ext.version, source: 'store', path, notifiedVersion: null, pinned: true, installedAt: now, updatedAt: now };
    this.deps.dispatch({ t: 'extension.record', extension: record });
    await this.finishInstall(record);
    return record;
  }

  /**
   * Verify a downloaded package and unpack it to <root>/<profile>/<id>/<version>_<n> (extensionFolder), keeping the
   * store's ID.
   * All of it (signatures, inflating, writing, the manifest's key) happens in a worker thread, never on main.
   */
  private async unpackFromStore(profileId: string, id: string, version: string, crx: Buffer, sha256: string | null): Promise<string> {
    await this.cleanup;
    // Another unpack under way (a twin's install, at once) counts as taken too: never the same folder (Neon's N1 on #334).
    const path = extensionFolder(this.deps.root, profileId, id, version, (p) => this.usedBy(p) !== null || [...this.unpacking].some((u) => samePath(u, p)));
    this.unpacking.add(path);
    try {
      await unpackInWorker(this.deps.unpackWorkerPath, {
        crx,
        id,
        version,
        dest: path,
        ...(sha256 ? { sha256 } : {}),
        ...(this.deps.publisherKeyHash ? { publisherKeyHash: this.deps.publisherKeyHash } : {}),
      });
    } catch (error) {
      // The worker removes what it wrote; if it died partway, this does.
      await this.removeFolder(path);
      throw error;
    } finally {
      this.unpacking.delete(path);
    }
    return path;
  }

  /** Folders an unpack is writing now. */
  private readonly unpacking = new Set<string>();

  /**
   * The install step Electron skips: turn on the rulesets the manifest
   * enables (first install only; afterwards they're the extension's own
   * choice), and tell the extension it was installed or updated. Remembered,
   * so it happens once per version even across a crash.
   */
  private async finishInstall(record: InstalledExtension): Promise<void> {
    if (record.notifiedVersion === record.version) return;
    const host = this.host(record.profileId, false);
    const ext = host?.get(record.id);
    if (!host || !ext) return;
    const manifest = ext.manifest as ManifestShape;
    const worker = Boolean(manifest.background?.service_worker);
    if (worker) {
      // Workers start on demand; this one needs to be listening. (Already starting is fine.)
      await host.session.serviceWorkers.startWorkerForScope(`chrome-extension://${record.id}/`).catch(() => undefined);
      if (record.notifiedVersion === null) {
        const enabled = (manifest.declarative_net_request?.rule_resources ?? []).filter((r) => r.enabled).map((r) => r.id);
        await host.enableStaticRulesets(record.id, enabled);
      }
      await host.notifyInstalled(record.id, record.notifiedVersion === null ? { reason: 'install' } : { reason: 'update', previousVersion: record.notifiedVersion });
    }
    // Recorded whether or not the extension was listening: one try per version, not one per launch.
    const current = this.deps.state().extensions[extensionKey(record.profileId, record.id)];
    if (current && current.version === record.version) this.deps.dispatch({ t: 'extension.record', extension: { ...current, notifiedVersion: record.version } });
  }

  /**
   * Ask the Web Store about every store extension and update the ones that are behind. Resolves with how many were updated.
   * One check at a time: a check asked for while one runs (the timer's, or
   * Settings' Check for updates) joins it and gets its result, rather than
   * starting another. A Settings click during a check doesn't ask the store
   * again; that's accepted, as the running check just asked.
   */
  checkForUpdates(): Promise<number> {
    this.updateCheck ??= this.runUpdateCheck().finally(() => {
      this.updateCheck = null;
    });
    return this.updateCheck;
  }

  private async runUpdateCheck(): Promise<number> {
    const store = Object.values(this.deps.state().extensions).filter((e) => e.source === 'store');
    if (store.length === 0) return 0;
    let infos;
    try {
      infos = await this.deps.webStore.check(store.map((e) => ({ id: e.id, version: e.version })));
    } catch (error) {
      console.error('Extension update check failed:', error);
      return 0;
    }
    let updated = 0;
    for (const e of store) {
      const info = infos.find((i) => i.id === e.id);
      if (!info || info.status !== 'ok' || !info.version || !isNewerVersion(info.version, e.version)) continue;
      const key = extensionKey(e.profileId, e.id);
      // Removed (or changed) since the check began, being installed again, or an earlier update of it still running: skip it.
      if (!this.stillCurrent(e) || this.installing.has(key) || this.updating.has(key)) continue;
      const version = info.version;
      const task = this.deps.webStore.download(info).then((crx) => this.updateFromStore(e, version, crx, info.sha256));
      // Tracked until it really settles, even past its deadline, so nothing else unpacks into its folder meanwhile.
      this.updating.set(key, task);
      void task.then(
        () => this.updating.delete(key),
        () => this.updating.delete(key),
      );
      try {
        const done = await within(task, this.deps.updateDeadlineMs ?? UPDATE_DEADLINE_MS);
        if (done === undefined) throw new Error('It took too long, and was given up on.');
        if (done) updated++;
      } catch (error) {
        console.error(`Updating ${e.name} failed:`, error);
      }
    }
    if (updated > 0) {
      this.sync();
      this.deps.changed();
    }
    return updated;
  }

  /** Is `e` still the installed record, as it was when its update began? Removing it, or a newer version, changes that. */
  private stillCurrent(e: InstalledExtension): boolean {
    const now = this.deps.state().extensions[extensionKey(e.profileId, e.id)];
    return now !== undefined && now.version === e.version && now.path === e.path;
  }

  /** Update one extension. False when it was removed partway, so there was nothing to update. */
  private async updateFromStore(e: InstalledExtension, version: string, crx: Buffer, sha256: string | null): Promise<boolean> {
    const path = await this.unpackFromStore(e.profileId, e.id, version, crx, sha256);
    if (!this.stillCurrent(e)) {
      await this.removeFolder(path);
      return false;
    }
    const host = this.host(e.profileId, true)!;
    host.unload(e.id);
    try {
      await host.load(path);
    } catch (error) {
      // Back to the version that worked.
      await this.removeFolder(path);
      if (this.stillCurrent(e)) await host.load(e.path).catch(() => undefined);
      throw error;
    }
    if (!this.stillCurrent(e)) {
      // Removed while the new version loaded: it doesn't stay loaded.
      host.unload(e.id);
      await this.removeFolder(path);
      return false;
    }
    const record: InstalledExtension = { ...e, version, path, updatedAt: Date.now() };
    this.deps.dispatch({ t: 'extension.record', extension: record });
    // The old version's folder, unless another extension uses it too (a twin's, #319).
    if (!samePath(e.path, path) && this.usedBy(e.path, extensionKey(e.profileId, e.id)) === null) await this.removeFolder(e.path);
    await this.finishInstall(record);
    return true;
  }

  /**
   * Take an extension out of a profile, with Undo (undo, not confirmation).
   * Its folder stays until the next launch, so Undo can load it again;
   * unpacked folders are never deleted.
   */
  remove(profileId: string, id: string, windowId?: WindowId): void {
    const record = this.deps.state().extensions[extensionKey(profileId, id)];
    for (const [w, popup] of this.popups) {
      if (popup.extensionId === id) {
        popup.close();
        this.popups.delete(w);
      }
    }
    this.host(profileId, false)?.unload(id);
    this.deps.dispatch({ t: 'extension.forget', profileId, id });
    if (record && windowId) this.deps.toast(windowId, `Removed ${record.name}`, { label: 'Undo', command: { t: 'extension.restore', profileId, id } });
    this.sync();
    this.deps.changed();
  }

  /**
   * Bring the engine in line with state after a change: an extension that's
   * installed again (Undo) loads. One that won't load isn't retried.
   */
  reconcile(): void {
    // Launch is loading everything from where it ends up: it loads each once (Neon's B1 on #334).
    if (this.starting) return;
    for (const e of Object.values(this.deps.state().extensions)) {
      const key = extensionKey(e.profileId, e.id);
      if (this.unloadable.has(key) || this.loading.has(key) || this.installing.has(key) || this.updating.has(key)) continue;
      const host = this.host(e.profileId, true)!;
      if (host.get(e.id)) continue;
      this.loading.add(key);
      void host
        .load(e.path)
        .catch((error: unknown) => {
          this.unloadable.add(key);
          console.error(`Extension ${e.name} (${e.id}) didn't load:`, error);
        })
        .finally(() => {
          this.loading.delete(key);
          this.sync();
          this.deps.changed();
        });
    }
  }

  /** The installed extension whose folder `path` is (compared without case, #319), other than `except`'s; null if none. */
  private usedBy(path: string, except?: string): InstalledExtension | null {
    const state = this.deps.state();
    // One removed but still to Undo counts too: its folder is what Undo loads (Neon's SF3 on #334).
    for (const e of [...Object.values(state.extensions), ...(state.removedExtensions ?? [])]) if (extensionKey(e.profileId, e.id) !== except && samePath(e.path, path)) return e;
    return null;
  }

  /**
   * Store extensions sharing one version folder (the same extension and version in two profiles whose ids differ only
   * in case, installed before #319): the first keeps it, each other gets a copy of its own and its record moves there.
   * A copy that fails leaves it shared, as before; nothing removes a folder another extension uses, so it stays safe.
   */
  private async splitShared(): Promise<void> {
    const seen: InstalledExtension[] = [];
    for (const e of Object.values(this.deps.state().extensions).sort((a, b) => (extensionKey(a.profileId, a.id) < extensionKey(b.profileId, b.id) ? -1 : 1))) {
      const keeper = e.source === 'store' ? seen.find((s) => samePath(s.path, e.path)) : undefined;
      if (!keeper) {
        seen.push(e);
        continue;
      }
      const to = extensionFolder(this.deps.root, e.profileId, e.id, e.version, (p) => this.usedBy(p) !== null);
      try {
        // From its own folder if it's on disk (where case counts, each twin has its own), else from the keeper's (where
        // case is ignored, the same folder): Neon's SF1 on #334.
        const from = existsSync(join(e.path, 'manifest.json')) ? e.path : keeper.path;
        await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        this.deps.dispatch({ t: 'extension.record', extension: { ...e, path: to } });
      } catch (error) {
        await this.removeFolder(to);
        console.error(`Giving ${e.name} (${e.id}) its own folder failed; it shares one this launch:`, error);
      }
    }
  }

  /** Web Store folders no installed extension uses (removed last session, or left by an update): deleted at launch. */
  private async removeOrphanFolders(): Promise<void> {
    // Compared without case: a folder Electron or the file system spells otherwise is still the one in use (#319).
    const used = new Set(Object.values(this.deps.state().extensions).map((e) => resolve(e.path).toLowerCase()));
    const dirs = async (dir: string) => {
      try {
        return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
      } catch {
        return []; // No extensions folder yet.
      }
    };
    for (const profileDir of await dirs(this.deps.root)) {
      for (const idDir of await dirs(profileDir)) {
        for (const versionDir of await dirs(idDir)) if (!used.has(resolve(versionDir).toLowerCase())) await this.removeFolder(versionDir);
        if ((await readdir(idDir).catch(() => ['?'])).length === 0) await this.removeFolder(idDir);
      }
    }
  }

  /**
   * Delete a folder, but only inside Chord's own extensions folder. Never
   * throws: what can't go now (a file Windows holds open) goes at the next
   * launch, and the error that led here is the one worth reporting.
   */
  private async removeFolder(path: string): Promise<void> {
    const rel = relative(resolve(this.deps.root), resolve(path));
    // Never outside Chord's extensions folder: nor on another drive (Windows gives an absolute `relative`: Neon's N3).
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || resolve(path) === resolve(this.deps.root)) return;
    await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => console.error(`Removing ${path} failed:`, error));
  }
}
