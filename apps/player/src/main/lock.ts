/**
 * The navigation lock (ARCHITECTURE.md §9, Chord Player; spike S14 §3):
 * Chord Player shows the streaming services' own pages and nothing else.
 *
 * - `will-navigate` and `will-redirect` stop a page before it leaves, and
 *   hand its address to Chord, so the service's page stays as it was.
 * - `setWindowOpenHandler` opens allowed popups (sign-in) as player windows
 *   and hands the rest to Chord.
 * - `will-frame-navigate` blocks frames from elsewhere (ad and tracking
 *   frames, mostly).
 * - The session's request listener is the backstop for any main-frame or
 *   frame request that still gets through. A request cancelled there leaves
 *   an error page, which is why the navigation events come first.
 * - Downloads and other apps' links go to Chord; permissions only for what
 *   playing needs, and only for the services' pages.
 */
import type { LinkReason, Lock } from '@chord/player-protocol';
import type { BrowserWindowConstructorOptions, Session, WebContents } from 'electron';

export interface LockDeps {
  lock: Lock;
  /** Hand an address to Chord to open (http and https only; anything else is dropped). */
  handoff(url: string, why: LinkReason): void;
  /** How an allowed popup (a service's sign-in) opens. */
  popup(): BrowserWindowConstructorOptions;
}

/** What a service's page may have: Widevine, fullscreen, pointer lock and copying (Spotify's Copy link). */
const PERMISSIONS = new Set(['mediaKeySystem', 'fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

export function lockSession(ses: Session, deps: LockDeps): void {
  // Every request passes through here, so this stays a type check and a lookup: microseconds.
  ses.webRequest.onBeforeRequest((details, done) => {
    if (details.resourceType === 'mainFrame') {
      if (deps.lock.page(details.url)) return done({});
      deps.handoff(details.url, 'navigation');
      return done({ cancel: true });
    }
    if (details.resourceType === 'subFrame') return done(deps.lock.frame(details.url) ? {} : { cancel: true });
    done({});
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'openExternal') {
      const external = (details as { externalURL?: string }).externalURL;
      if (external) deps.handoff(external, 'external');
      return callback(false);
    }
    callback(PERMISSIONS.has(permission) && deps.lock.page(details.requestingUrl || contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin, details) => PERMISSIONS.has(permission) && deps.lock.page(details.requestingUrl || origin));
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    deps.handoff(item.getURL(), 'download');
  });
}

/** The lock on one page's WebContents (the service's view, and each sign-in popup). */
export function lockContents(contents: WebContents, deps: LockDeps): void {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => {
    if (deps.lock.page(event.url)) return;
    event.preventDefault();
    deps.handoff(event.url, 'navigation');
  });
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || deps.lock.page(event.url)) return;
    event.preventDefault();
    deps.handoff(event.url, 'redirect');
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || deps.lock.frame(event.url)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (deps.lock.page(url)) return { action: 'allow', overrideBrowserWindowOptions: deps.popup() };
    deps.handoff(url, 'popup');
    return { action: 'deny' };
  });
  // A sign-in popup gets the same lock.
  contents.on('did-create-window', (popup) => lockContents(popup.webContents, deps));
}
