/**
 * Find in page (ARCHITECTURE.md §9) for one window: Chromium's own
 * `findInPage` on the active tab, with the bar in the window's popover. The
 * bar follows the tab it was opened on; switching tabs closes it, as
 * navigation within that tab keeps it open with fresh results.
 */
import type { FindState } from '@chord/ipc';
import type { WebContents } from 'electron';

export class FindInPage {
  private contents: WebContents | null = null;
  private text = '';
  private matches = 0;
  private active = 0;
  /** Bumped each time ⌘F is pressed, so the bar refocuses and selects its text. */
  private focus = 0;
  private readonly onFound = (_event: unknown, result: Electron.Result) => {
    this.matches = result.matches;
    this.active = result.activeMatchOrdinal;
    this.onChange();
  };

  constructor(private readonly onChange: () => void) {}

  get state(): FindState | null {
    return this.contents ? { text: this.text, matches: this.matches, active: this.active, focus: this.focus } : null;
  }

  get target(): WebContents | null {
    return this.contents;
  }

  /** Open (or refocus) the bar for this page. */
  open(contents: WebContents): void {
    if (this.contents !== contents) {
      this.close(false);
      this.contents = contents;
      contents.on('found-in-page', this.onFound);
      // Re-run the search on the new page rather than show stale counts.
      if (this.text) contents.findInPage(this.text, { findNext: true });
    }
    this.focus++;
    this.onChange();
  }

  /** A new search when the text changed; otherwise step to the next or previous match. */
  query(text: string, forward: boolean): void {
    const contents = this.contents;
    if (!contents || contents.isDestroyed()) return;
    const fresh = text !== this.text;
    this.text = text;
    if (!text) {
      contents.stopFindInPage('clearSelection');
      this.matches = 0;
      this.active = 0;
      this.onChange();
      return;
    }
    contents.findInPage(text, { forward, findNext: fresh });
  }

  /** ⌘G / F3 and their Shift versions: step, or open the bar if it isn't. */
  step(contents: WebContents, forward: boolean): void {
    if (this.contents !== contents || !this.text) {
      this.open(contents);
      return;
    }
    this.query(this.text, forward);
  }

  /** Close the bar, keeping the found text selected (as Chrome does), and give the page focus back. */
  close(refocus = true): void {
    const contents = this.contents;
    this.contents = null;
    this.matches = 0;
    this.active = 0;
    if (contents && !contents.isDestroyed()) {
      contents.off('found-in-page', this.onFound);
      contents.stopFindInPage('keepSelection');
      if (refocus) contents.focus();
    }
    this.onChange();
  }
}
