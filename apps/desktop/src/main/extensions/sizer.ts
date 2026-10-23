/**
 * Measuring an extension popup's page (ARCHITECTURE.md §12). Chrome sizes a
 * popup to its content. Electron's `enablePreferredSizeMode` would report that
 * size, but Electron 45 loses the mode when a view navigates across processes,
 * and an extension page always moves into its extension's process (verified:
 * a view's first same-process page reports its size; after a process swap,
 * nothing). So a small script in an isolated world of Chord's own watches the
 * page and reports its content size with a tagged console.debug, which main
 * reads from `console-message`.
 *
 * A page could log the tag itself, but all it could do is resize its own
 * popup, and main clamps that to Chrome's limits (25×25 to 800×600).
 */

/** Chord's own isolated world for the sizer: below the range Chromium gives extensions (1 << 20 and up), and not Electron's 999. */
export const SIZER_WORLD = 4321;
export const SIZE_TAG = 'chord-popup-size:';

/**
 * Runs in the popup's page, in SIZER_WORLD. Reports the content's natural
 * size (max-content width, and the height at that width), whenever layout
 * changes. Measuring briefly lays the root element out at max-content, which
 * is what Chrome's popup auto-resize does.
 */
export const SIZER_SCRIPT = `(() => {
  if (globalThis.__chordSizer) return;
  globalThis.__chordSizer = true;
  const html = document.documentElement;
  let last = '';
  let queued = false;
  const measure = () => {
    queued = false;
    const style = html.style;
    const width = style.getPropertyValue('width');
    const priority = style.getPropertyPriority('width');
    style.setProperty('width', 'max-content', 'important');
    const box = html.getBoundingClientRect();
    if (width) style.setProperty('width', width, priority);
    else style.removeProperty('width');
    const size = Math.ceil(box.width) + 'x' + Math.ceil(box.height);
    if (size === last) return;
    last = size;
    console.debug(${JSON.stringify(SIZE_TAG)} + size);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(measure);
  };
  new ResizeObserver(schedule).observe(html);
  new MutationObserver((records) => {
    if (records.some((r) => !(r.target === html && r.attributeName === 'style'))) schedule();
  }).observe(html, { subtree: true, childList: true, attributes: true, characterData: true });
  schedule();
})();`;

/** The size in a sizer message, or null if it isn't one. */
export function parseSizeMessage(message: string): { width: number; height: number } | null {
  if (!message.startsWith(SIZE_TAG)) return null;
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(message.slice(SIZE_TAG.length));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}
