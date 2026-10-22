/**
 * Baseline hardening (ARCHITECTURE.md §14.1) applied to every WebContents,
 * plus navigation locks for Chord's own UI views.
 */
import { app, type Session, type WebContents } from 'electron';
import { originOf } from './urls';

export function hardenAllWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** Chord UI views may only ever show their own pages. */
export function lockToOrigins(contents: WebContents, origins: readonly string[]): void {
  const allowed = (url: string) => {
    const origin = originOf(url);
    return origin !== null && origins.includes(origin);
  };
  contents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (!allowed(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Chord's own UI needs no permissions at all. */
export function configureUiSession(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}
