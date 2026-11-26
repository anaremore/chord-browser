// Modified by Chord contributors, 2026-10-22: the openActionPopup hook; 2026-11-26: navigateTab, reloadTab and goTab.
// See CHORD-CHANGES.md in this package.
/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties,
  ): Promise<[Electron.WebContents, Electron.BaseWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void

  /**
   * Chord: chrome.tabs.update({ url }), reload, goBack and goForward. When implemented, the library calls these
   * instead of moving the page itself, so the app can hold the load until the tab's session is ready.
   */
  navigateTab?(tab: Electron.WebContents, url: string): void
  reloadTab?(tab: Electron.WebContents, bypassCache: boolean): void
  goTab?(tab: Electron.WebContents, way: 'back' | 'forward'): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BaseWindow>
  removeWindow?(window: Electron.BaseWindow): void

  requestPermissions?(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ): Promise<boolean>

  /**
   * Chord: show an extension action's popup. When implemented, the library
   * calls this instead of opening its own popup window. `anchorRect` is what
   * the caller passed (window-relative), when it knows one.
   */
  openActionPopup?(details: {
    extensionId: string
    tab: Electron.WebContents
    window: Electron.BaseWindow
    url: string
    anchorRect: { x: number; y: number; width: number; height: number }
  }): void
}
