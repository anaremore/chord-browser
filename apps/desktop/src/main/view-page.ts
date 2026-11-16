/**
 * A view's page, read safely (ARCHITECTURE.md §5). Once a `WebContentsView`'s
 * page is destroyed (its renderer gone, the app quitting, `close()`), the
 * view's `webContents` is undefined on macOS, though Electron's types say
 * otherwise: `view.webContents.isDestroyed()` then throws. Main reads a
 * view's page only through `pageOf`, or keeps the page it made.
 */
import type { WebContents } from 'electron';

/** A page that's still there. */
export const live = (contents: WebContents | null | undefined): contents is WebContents => Boolean(contents && !contents.isDestroyed());

/** The view's page while it has one; undefined once it's destroyed (or for no view at all). */
export function pageOf(view: { readonly webContents: WebContents } | null | undefined): WebContents | undefined {
  const contents = view?.webContents as WebContents | undefined;
  return live(contents) ? contents : undefined;
}
