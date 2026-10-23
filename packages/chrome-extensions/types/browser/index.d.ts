import { EventEmitter } from 'node:events';
import { ChromeExtensionImpl } from './impl';
import { License } from './license';
export interface ChromeExtensionOptions extends ChromeExtensionImpl {
    /**
     * License used to distribute electron-chrome-extensions.
     *
     * See LICENSE.md for more details.
     */
    license: License;
    /**
     * Session to add Chrome extension support in.
     * Defaults to `session.defaultSession`.
     */
    session?: Electron.Session;
    /**
     * Path to electron-chrome-extensions module files. Might be needed if
     * JavaScript bundlers like Webpack are used in your build process.
     *
     * @deprecated See "Packaging the preload script" in the readme.
     */
    modulePath?: string;
    /** Chord: where the bundled preload is (the app builds it). */
    preloadPath?: string;
}
/**
 * Provides an implementation of various Chrome extension APIs to a session.
 */
export declare class ElectronChromeExtensions extends EventEmitter {
    /** Retrieve an instance of this class associated with the given session. */
    static fromSession(session: Electron.Session): ElectronChromeExtensions | undefined;
    /**
     * Handles the 'crx://' protocol in the session.
     *
     * This is required to display <browser-action-list> extension icons.
     */
    static handleCRXProtocol(session: Electron.Session): void;
    private ctx;
    private api;
    constructor(opts: ChromeExtensionOptions);
    private listenForExtensions;
    private prependPreload;
    private checkWebContentsArgument;
    /** Add webContents to be tracked as a tab. */
    addTab(tab: Electron.WebContents, window: Electron.BaseWindow): void;
    /** Remove webContents from being tracked as a tab. */
    removeTab(tab: Electron.WebContents): void;
    /** Notify extension system that the active tab has changed. */
    selectTab(tab: Electron.WebContents): void;
    /**
     * Add webContents to be tracked as an extension host which will receive
     * extension events when a chrome-extension:// resource is loaded.
     *
     * This is usually reserved for extension background pages and popups, but
     * can also be used in other special cases.
     *
     * @deprecated Extension hosts are now tracked lazily when they send
     * extension IPCs to the main process.
     */
    addExtensionHost(host: Electron.WebContents): void;
    /**
     * Get collection of menu items managed by the `chrome.contextMenus` API.
     * @see https://developer.chrome.com/extensions/contextMenus
     */
    getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[];
    /**
     * Gets map of special pages to extension override URLs.
     *
     * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides
     */
    getURLOverrides(): Record<string, string>;
    /**
     * Dispatches the 'runtime.onInstalled' event to the given extension.
     * @param extensionId - The ID of the extension to dispatch the event to.
     * @param details - The details of the installation.
     */
    dispatchRuntimeInstalled(extensionId: string, details: chrome.runtime.InstalledDetails): Promise<boolean>;
    /**
     * Chord: every extension action's state (title, badge, popup, per-tab
     * overrides) and the active tab, as the library's own toolbar reads it.
     * 'browser-action-updated' fires when any of it changes.
     */
    getActionState(): {
        activeTabId: number | undefined;
        actions: {
            color?: string | undefined;
            text?: string | undefined;
            title?: string | undefined;
            popup?: string | undefined;
            iconModified?: number | undefined;
            id: string;
            tabs: {
                [key: string]: any;
            };
        }[];
    };
    /** Chord: an action's icon for a tab at a size in pixels. */
    getActionIcon(extensionId: string, tabId: number | undefined, size: number): Electron.NativeImage | undefined;
    /**
     * Chord: click an action on a tab: opens its popup (through
     * `openActionPopup`) or sends `action.onClicked`.
     */
    activateAction(extensionId: string, tab: Electron.WebContents, anchorRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    }): void;
    /** Chord: the extension's own items for its action button's context menu. */
    getActionMenuItems(extensionId: string): Electron.MenuItem[];
    /**
     * Chord: turn on static declarativeNetRequest rulesets from the extension's
     * service worker, as Chrome does at install (Electron skips that step).
     * Resolves once the worker has been sent the request.
     */
    enableStaticRulesets(extensionId: string, rulesetIds: string[]): Promise<boolean>;
    /**
     * Handles the 'crx://' protocol in the session.
     *
     * @deprecated Call `ElectronChromeExtensions.handleCRXProtocol(session)`
     * instead. The CRX protocol is no longer one-to-one with
     * ElectronChromeExtensions instances. Instead, it should now be handled only
     * on the sessions where <browser-action-list> extension icons will be shown.
     */
    handleCRXProtocol(session: Electron.Session): void;
    /**
     * Add extensions to be visible as an extension action button.
     *
     * @deprecated Not needed in Electron >=12.
     */
    addExtension(extension: Electron.Extension): void;
    /**
     * Remove extensions from the list of visible extension action buttons.
     *
     * @deprecated Not needed in Electron >=12.
     */
    removeExtension(extension: Electron.Extension): void;
}
