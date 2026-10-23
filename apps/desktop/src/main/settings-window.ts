/**
 * The Settings window (⌘, / Ctrl+,): one at a time, Chord's own UI in a
 * single view. A window rather than a tab keeps this privileged page out of
 * browsing sessions entirely, and matches each OS's preferences convention.
 */
import type { SettingsSnapshot } from '@chord/ipc';
import { BaseWindow, nativeTheme, type Session, type WebContentsView } from 'electron';
import { send } from './ipc';
import { applyMaterial, platform, systemInfo, titleBarOverlay, windowChromeOptions } from './platform';
import { createUiView } from './window';

const WIDTH = 860;
const HEIGHT = 620;

export class SettingsWindow {
  readonly window: BaseWindow;
  readonly view: WebContentsView;

  constructor(uiSession: Session, parentBounds: Electron.Rectangle | undefined, section: string | undefined, onClosed: () => void) {
    // Centered over the browser window it was opened from.
    const position = parentBounds
      ? { x: Math.round(parentBounds.x + (parentBounds.width - WIDTH) / 2), y: Math.round(parentBounds.y + (parentBounds.height - HEIGHT) / 2) }
      : {};
    this.window = new BaseWindow({
      ...position,
      width: WIDTH,
      height: HEIGHT,
      minWidth: 640,
      minHeight: 440,
      title: 'Chord Settings',
      show: false,
      ...windowChromeOptions(),
    });
    this.view = createUiView(uiSession, 'settings', section);
    this.window.contentView.addChildView(this.view);
    const layout = () => {
      const { width, height } = this.window.getContentBounds();
      this.view.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    this.window.on('resize', layout);

    const onTheme = () => {
      if (platform !== 'darwin') this.window.setTitleBarOverlay?.(titleBarOverlay());
      applyMaterial(this.window);
      send(this.view.webContents, 'system:changed', systemInfo());
    };
    nativeTheme.on('updated', onTheme);
    this.window.on('closed', () => {
      nativeTheme.off('updated', onTheme);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
      onClosed();
    });
    this.view.webContents.once('did-finish-load', () => {
      // It may have been closed before it finished loading.
      if (this.window.isDestroyed()) return;
      this.window.show();
      this.view.webContents.focus();
    });
  }

  /** Bring it forward, optionally at a section (`shortcuts`, `motion`…). */
  show(section?: string): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
    this.view.webContents.focus();
    if (section) send(this.view.webContents, 'settings:section', section);
  }

  update(snapshot: SettingsSnapshot): void {
    send(this.view.webContents, 'settings:changed', snapshot);
  }
}
