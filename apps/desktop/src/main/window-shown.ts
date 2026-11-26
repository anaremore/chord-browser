/**
 * What a Chord window shows now, by its BaseWindow (#115, B2): its panes' pages and its shell, and the page it gives the
 * focus to (its active tab's, else its shell's). AppWindow registers itself (window.ts); the control layer asks it when
 * an action gives the focus back (control/page.ts), so the focus never goes to a page you no longer see, nor stays on a
 * hidden agent's tab. Kept apart from window.ts so control/page.ts needn't import the window module.
 */
import type { WebContents } from 'electron';

export type WindowShown = {
  /** Whether this page is one the window shows now (a pane's, or the shell). */
  seen(page: WebContents): boolean;
  /** The page the window gives the focus to: its active tab's, else its shell's. */
  page(): WebContents | null;
};

/** What a window has on screen now, as its pages (for `shownIn`). */
export type ShownParts<P> = {
  shell: P | null;
  /** Its panes: each page, whether its view is visible, and whether it's one of the panes hidden here. */
  panes: { page: P | null; visible: boolean; hidden: boolean }[];
  /** Pages parked here only (not a pane's). */
  parked: P[];
  overlay: P | null;
  overlayOpen: boolean;
  /** Peek's page while it's on screen, else null. */
  peek: P | null;
  /** The panes' docked DevTools' pages. */
  docked: (P | null)[];
  /** The floating views (the cards, the menu): never a page you see, except as `yours` says. */
  floating: (P | null)[];
  /** The cards' page while you own them (you clicked into them: `cardsOwner === 'you'`), else null. */
  yours: P | null;
};

/**
 * Whether a window shows this page (#322's SF1, after window.ts' shownHere): the shell, a pane on screen and not hidden,
 * the command bar while open, Peek on screen, a docked DevTools; never a page parked here or a floating view (the cards
 * count only while you own them, with `floating: true`). A page closed: never.
 */
export function shownIn<P extends { isDestroyed(): boolean }>(page: P, w: ShownParts<P>, opts: { floating?: boolean } = {}): boolean {
  if (page.isDestroyed()) return false;
  if (w.floating.includes(page)) return Boolean(opts.floating) && page === w.yours;
  if (w.parked.includes(page) && !w.panes.some((p) => p.page === page)) return false;
  if (page === w.shell) return true;
  if (w.panes.some((p) => p.page === page && p.visible && !p.hidden)) return true;
  if (page === w.overlay) return w.overlayOpen;
  if (page === w.peek) return true;
  return w.docked.includes(page);
}

const shownBy = new WeakMap<object, WindowShown>();

export function registerWindowShown(window: object, shown: WindowShown): void {
  shownBy.set(window, shown);
}

/** A window gone (its 'closed'): nothing asks it again (#322's SF1). */
export function unregisterWindowShown(window: object): void {
  shownBy.delete(window);
}

export function windowShown(window: object | null): WindowShown | null {
  return window ? (shownBy.get(window) ?? null) : null;
}
