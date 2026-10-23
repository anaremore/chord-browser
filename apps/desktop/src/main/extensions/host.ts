/**
 * The extension layer for one profile (ARCHITECTURE.md §12). This is the seam:
 * the rest of Chord talks to an ExtensionHost, never to the library behind it.
 * Today that's the vendored GPL-3.0 electron-chrome-extensions fork
 * (packages/chrome-extensions, decision D1); a different implementation only
 * has to replace this file.
 */
import { ElectronChromeExtensions } from '@chord/chrome-extensions';
import type { BaseWindow, ContextMenuParams, MenuItem, Session, WebContents } from 'electron';

/** What a tab looks like to `chrome.tabs`, beyond what the library reads from the page itself. */
export interface TabFacts {
  pinned: boolean;
  /** Position among the chord's tabs. */
  index: number;
}

/** What Chord does when an extension asks for tabs and windows. */
export interface HostCallbacks {
  createTab(details: { url?: string; active: boolean; windowId?: number }): Promise<[WebContents, BaseWindow]>;
  /** Show this tab (chrome.tabs.update({active}) and the like). */
  selectTab(contents: WebContents, window: BaseWindow): void;
  /** Close this tab: only ever for an extension's request, never for a page Chord itself is closing. */
  closeTab(contents: WebContents): void;
  tabFacts(contents: WebContents): TabFacts | undefined;
  createWindow(details: { url?: string | string[]; type?: string; width?: number; height?: number; focused?: boolean }): Promise<BaseWindow>;
  closeWindow(window: BaseWindow): void;
  openPopup(details: { extensionId: string; tab: WebContents; window: BaseWindow; url: string }): void;
  /** Action buttons changed: title, badge, icon or popup. */
  actionsChanged(): void;
}

/** An extension's toolbar action, for one tab. */
export interface ActionState {
  extensionId: string;
  title: string;
  badgeText: string;
  /** CSS color, or null for the default. */
  badgeColor: string | null;
  hasPopup: boolean;
  /** Changes whenever the icon does, so icons are re-read only then. */
  iconVersion: number;
}

interface LibraryAction {
  id: string;
  title?: string;
  text?: string;
  color?: string | number[];
  popup?: string;
  iconModified?: number;
  tabs: Record<string, { title?: string; text?: string; color?: string | number[]; popup?: string; iconModified?: number }>;
}

const badgeColor = (color: string | number[] | undefined): string | null => {
  if (typeof color === 'string') return color;
  if (Array.isArray(color) && color.length >= 3) return `rgb(${color.slice(0, 3).join(' ')}${color[3] !== undefined ? ` / ${(color[3] / 255).toFixed(3)}` : ''})`;
  return null;
};

/** How long to wait for a worker to start listening before giving up on telling it something. */
const WORKER_WAIT_MS = 15_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.())]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send something to an extension's worker until it's delivered. A worker that
 * is still starting can't be sent to, so failures retry with backoff; a worker
 * that never listens gives up at the deadline. True once delivered.
 */
async function deliver(send: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const delivered = await within(send(), remaining);
    if (delivered === true) return true;
    if (delivered === undefined) return false;
    await sleep(Math.min(250 * 2 ** attempt, 2000));
  }
}

export class ExtensionHost {
  private readonly lib: ElectronChromeExtensions;

  constructor(
    readonly profileId: string,
    readonly session: Session,
    preloadPath: string,
    callbacks: HostCallbacks,
  ) {
    this.lib = new ElectronChromeExtensions({
      // D1: Chord's builds are distributed under GPL-3.0 with this library inside.
      license: 'GPL-3.0',
      session,
      preloadPath,
      createTab: (details) => callbacks.createTab({ url: details.url, active: details.active !== false, windowId: details.windowId }),
      selectTab: (contents, window) => callbacks.selectTab(contents, window),
      removeTab: (contents) => {
        // The library also calls this when a page is destroyed; only a live tab is the extension asking.
        if (!contents.isDestroyed()) callbacks.closeTab(contents);
      },
      assignTabDetails: (details, contents) => {
        const facts = callbacks.tabFacts(contents);
        if (!facts) return;
        details.pinned = facts.pinned;
        details.index = facts.index;
      },
      createWindow: (details) => callbacks.createWindow(details),
      removeWindow: (window) => {
        if (!window.isDestroyed()) callbacks.closeWindow(window);
      },
      // Optional permissions (`permissions.request`) are refused until Chord can ask you first.
      requestPermissions: async () => false,
      openActionPopup: ({ extensionId, tab, window, url }) => callbacks.openPopup({ extensionId, tab, window, url }),
    });
    this.lib.on('browser-action-updated', () => callbacks.actionsChanged());
  }

  /** Load an unpacked extension folder. */
  async load(path: string): Promise<Electron.Extension> {
    return await this.session.extensions.loadExtension(path, { allowFileAccess: false });
  }

  unload(id: string): void {
    if (this.session.extensions.getExtension(id)) this.session.extensions.removeExtension(id);
  }

  get(id: string): Electron.Extension | null {
    return this.session.extensions.getExtension(id);
  }

  all(): Electron.Extension[] {
    return this.session.extensions.getAllExtensions();
  }

  /** Track a page as a tab in a window, so extensions see it. */
  addTab(contents: WebContents, window: BaseWindow): void {
    if (contents.isDestroyed() || contents.session !== this.session) return;
    this.lib.addTab(contents, window);
  }

  /** This tab is now the one its window shows. */
  selectTab(contents: WebContents): void {
    if (contents.isDestroyed() || contents.session !== this.session) return;
    this.lib.selectTab(contents);
  }

  /** Extensions' items for a right-click on a page. */
  contextMenuItems(contents: WebContents, params: ContextMenuParams): MenuItem[] {
    if (contents.session !== this.session) return [];
    return this.lib.getContextMenuItems(contents, params);
  }

  /** Every extension's action as it applies to a tab (its per-tab title, badge and popup, or the defaults). */
  actions(tab: WebContents | null): ActionState[] {
    const { actions } = this.lib.getActionState() as { actions: LibraryAction[] };
    const tabId = tab && !tab.isDestroyed() ? String(tab.id) : null;
    return actions
      .filter((a) => this.get(a.id))
      .map((a) => {
        const t = (tabId && a.tabs[tabId]) || {};
        return {
          extensionId: a.id,
          title: t.title ?? a.title ?? this.get(a.id)?.name ?? '',
          badgeText: t.text ?? a.text ?? '',
          badgeColor: badgeColor(t.color ?? a.color),
          hasPopup: Boolean(t.popup ?? a.popup),
          iconVersion: t.iconModified ?? a.iconModified ?? 0,
        };
      });
  }

  /** The action's icon as a PNG data URL, at `size` pixels. */
  icon(extensionId: string, tab: WebContents | null, size: number): string | null {
    const image = this.lib.getActionIcon(extensionId, tab && !tab.isDestroyed() ? tab.id : undefined, size);
    return image ? image.resize({ width: size, height: size, quality: 'best' }).toDataURL() : null;
  }

  /** Click an action: its popup opens (through `openPopup`), or the extension hears `action.onClicked`. */
  activate(extensionId: string, tab: WebContents, anchor: { x: number; y: number; width: number; height: number }): void {
    this.lib.activateAction(extensionId, tab, anchor);
  }

  /** The extension's own items for its action button's menu. */
  actionMenuItems(extensionId: string): MenuItem[] {
    return this.lib.getActionMenuItems(extensionId);
  }

  /**
   * Tell an extension it was installed or updated (`runtime.onInstalled`).
   * Resolves true once delivered; false if the extension never listened in
   * time (some don't listen at all).
   */
  async notifyInstalled(id: string, details: { reason: 'install' | 'update'; previousVersion?: string }): Promise<boolean> {
    return await deliver(() => this.lib.dispatchRuntimeInstalled(id, details as chrome.runtime.InstalledDetails));
  }

  /** Turn on the declarativeNetRequest rulesets the manifest enables, as Chrome does at install. */
  async enableStaticRulesets(id: string, rulesetIds: string[]): Promise<boolean> {
    if (rulesetIds.length === 0) return true;
    return await deliver(() => this.lib.enableStaticRulesets(id, rulesetIds));
  }
}
