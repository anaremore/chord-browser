/**
 * Page zoom per site (ARCHITECTURE.md §9). Chromium already shares a zoom
 * level between a session's tabs on the same host; Chord remembers it across
 * launches (`site_zoom`, migration 8) and applies it when a tab arrives at the
 * host, as Chrome does. Ctrl/⌘ + wheel zooms too: Electron only reports that
 * gesture (`zoom-changed`), it doesn't zoom by itself.
 */
import { zoomStep, type Command, type State } from '@chord/core';
import type { WebContents } from 'electron';

/** The host a zoom level belongs to, for web pages only. */
export function zoomHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.host : null;
  } catch {
    return null;
  }
}

export interface SiteZoomDeps {
  state(): State;
  dispatch(command: Command): void;
  /** A private window's tab uses the zoom you saved for a site, but never saves one. */
  isPrivate(contents: WebContents): boolean;
}

export class SiteZoom {
  constructor(private readonly deps: SiteZoomDeps) {}

  /** Wire a tab's page: its remembered zoom on arrival, and the wheel. */
  attach(contents: WebContents): void {
    contents.on('did-navigate', (_event, url) => this.apply(contents, url));
    contents.on('zoom-changed', (_event, direction) => this.step(contents, direction === 'in' ? 1 : -1));
  }

  /** Zoom in or out a step (⌘+ / ⌘−, or the wheel), and remember it for the site. */
  step(contents: WebContents, direction: 1 | -1): void {
    if (contents.isDestroyed()) return;
    contents.setZoomFactor(zoomStep(contents.getZoomFactor(), direction));
    this.remember(contents);
  }

  /** Back to 100% (⌘0); the site forgets its zoom. */
  reset(contents: WebContents): void {
    if (contents.isDestroyed()) return;
    contents.setZoomFactor(1);
    this.remember(contents);
  }

  private remember(contents: WebContents): void {
    const host = zoomHost(contents.getURL());
    if (!host || this.deps.isPrivate(contents)) return;
    this.deps.dispatch({ t: 'zoom.set', host, factor: contents.getZoomFactor() });
  }

  private apply(contents: WebContents, url: string): void {
    const host = zoomHost(url);
    if (!host || contents.isDestroyed()) return;
    const saved = this.deps.state().siteZoom[host];
    // A private window's own zooming isn't saved, so only a saved zoom overrides what it chose.
    if (saved === undefined && this.deps.isPrivate(contents)) return;
    const factor = saved ?? 1;
    if (Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor);
  }
}
