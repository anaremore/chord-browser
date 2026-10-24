/**
 * An extension's popup (ARCHITECTURE.md §12): a view on the extension's
 * profile session, floating under its button and sized to its page, as
 * Chrome sizes popups (25×25 to 800×600). Only the popup's own rectangle
 * covers the window, so the rest of Chord stays clickable. It closes on Esc,
 * when focus moves elsewhere in Chord, and when the window's page or layout
 * changes. Focus leaving Chord entirely (to copy a code from another app)
 * keeps it open.
 */
import type { Rect } from '@chord/ipc';
import { radius } from '@chord/tokens';
import { WebContentsView, type Session } from 'electron';
import { toWindowRect, type AppWindow, type FloatingView } from '../window';
import { POPUP_MAX, popupPosition, popupSize } from './geometry';
import { parseSizeMessage, SIZER_SCRIPT, SIZER_WORLD } from './sizer';

export interface ExtensionPopupOptions {
  extensionId: string;
  session: Session;
  url: string;
  /** The button it came from (window coordinates), or null to hang from the frame's top-right. */
  anchor: Rect | null;
  /** Links the popup opens go to tabs. */
  openTab(url: string): void;
  onClosed(reason: 'blur' | 'other'): void;
}

/** How far outside the window a popup waits while it measures itself. */
const OFFSTAGE_GAP = 100;

export class ExtensionPopup implements FloatingView {
  readonly view: WebContentsView;
  readonly extensionId: string;
  private closed = false;
  private shown = false;
  private size = { ...POPUP_MAX };
  private showTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: AppWindow,
    private readonly options: ExtensionPopupOptions,
  ) {
    this.extensionId = options.extensionId;
    this.view = new WebContentsView({
      webPreferences: {
        session: options.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    this.view.setBorderRadius(radius.md);
    // Chrome's popups are white until the page paints its own background.
    this.view.setBackgroundColor('#ffffff');
    // Until the page has reported its size, it lays out at full size just
    // outside the window, where it can't be seen (a hidden view wouldn't lay out).
    this.view.setBounds({ x: -POPUP_MAX.width - OFFSTAGE_GAP, y: 0, ...POPUP_MAX });
    host.showFloating(this);

    const contents = this.view.webContents;
    // The page's size, from the sizer in Chord's own isolated world (see sizer.ts for why).
    contents.on('dom-ready', () => {
      void contents.executeJavaScriptInIsolatedWorld(SIZER_WORLD, [{ code: SIZER_SCRIPT }]).catch(() => undefined);
    });
    contents.on('console-message', (details) => {
      // A size can still arrive after the window has gone (Chord quit with the popup open).
      if (this.closed || this.host.window.isDestroyed()) return;
      if (details.level !== 'debug' || details.frame !== contents.mainFrame) return;
      const reported = parseSizeMessage(details.message);
      if (!reported) return;
      this.size = popupSize(reported, this.host.frameBounds);
      this.show();
    });
    // A page that never reports a size still appears, at full size.
    contents.once('did-finish-load', () => {
      this.showTimer = setTimeout(() => this.show(), 600);
    });
    contents.on('blur', () => {
      // Focus moved within Chord (a click on the sidebar or the page): close. Focus left
      // Chord (another app): stay, so a code can be copied in. Open devtools also keep it.
      // Decided a turn later: a closing window (Chord quitting) blurs its views while it takes
      // them down, and taking the popup out of the window in the middle of that crashes Chromium.
      setImmediate(() => {
        if (this.closed || this.host.window.isDestroyed() || contents.isDestroyed() || contents.isFocused()) return;
        if (this.host.window.isFocused() && !contents.isDevToolsOpened()) this.close('blur');
      });
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    // window.close() from the popup's page.
    contents.on('close' as 'destroyed', () => this.close());
    contents.once('destroyed', () => this.close());
    // Links open as tabs; the popup itself stays on the extension's own pages.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|chrome-extension):/i.test(url)) options.openTab(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`chrome-extension://${options.extensionId}/`)) {
        event.preventDefault();
        if (/^https?:/i.test(url)) options.openTab(url);
      }
    });
    void contents.loadURL(options.url).catch(() => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private place(): void {
    if (this.closed) return;
    const anchor = this.options.anchor && toWindowRect(this.options.anchor);
    const { x, y } = popupPosition(this.size, anchor, this.host.frameBounds);
    this.view.setBounds({ x, y, ...this.size });
  }

  /** Move into place at the measured size (again whenever the page's size changes). */
  private show(): void {
    if (this.closed) return;
    clearTimeout(this.showTimer);
    this.place();
    if (this.shown) return;
    this.shown = true;
    this.view.webContents.focus();
  }

  close(reason: 'blur' | 'other' = 'other'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.showTimer);
    this.host.releaseFloating(this);
    const contents = this.view.webContents;
    if (!contents.isDestroyed()) {
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      contents.close();
    }
    this.options.onClosed(reason);
  }
}
