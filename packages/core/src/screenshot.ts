/**
 * Screenshots (DESIGN.md §7.12): the pure parts. Geometry between Chord's
 * UI units and a page's CSS pixels, the size a capture may have, file
 * names, and which of the recent screenshots to let go. The geometry and the
 * history rule come from Screenboard, the maintainer's Chrome extension.
 */

/** What a screenshot shows: an element (even past the screen), a dragged area, what's on screen, or the whole page. */
export type ScreenshotKind = 'element' | 'area' | 'visible' | 'page';

export interface ShotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One of the recent screenshots (the downloads panel's list). */
export interface ScreenshotEntry {
  id: string;
  kind: ScreenshotKind;
  createdAt: number;
  /** In image pixels. */
  width: number;
  height: number;
  /** What it takes on disk: the PNG, its thumbnail and Duet's copy. */
  bytes: number;
  /** The page it's of. */
  title: string;
  url: string;
}

/** The rectangle two points span, whichever way the drag went. */
export function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): ShotRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

/** The part of `rect` inside `bounds` (empty when they don't meet). */
export function intersectRect(rect: ShotRect, bounds: ShotRect): ShotRect {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Chord's UI units (the overlay's CSS pixels, where the pointer is) to the
 * page's CSS pixels: relative to the pane, times the interface size (to the
 * view's own pixels), over the page's zoom.
 */
export function uiToPage(rect: ShotRect, pane: ShotRect, uiScale: number, zoom: number): ShotRect {
  const k = uiScale / zoom;
  return { x: (rect.x - pane.x) * k, y: (rect.y - pane.y) * k, width: rect.width * k, height: rect.height * k };
}

/** And back: a page rect (as the page reports it, from the top of its viewport) to where it is on screen in UI units. */
export function pageToUi(rect: ShotRect, pane: ShotRect, uiScale: number, zoom: number): ShotRect {
  const k = zoom / uiScale;
  return { x: pane.x + rect.x * k, y: pane.y + rect.y * k, width: rect.width * k, height: rect.height * k };
}

/** Below this, in UI units, a drag is a click. */
export const MIN_AREA = 4;

/**
 * The biggest picture Chromium makes reliably, and the clipboard takes: 16,384 px
 * a side (a GPU texture's usual limit) and 64 megapixels. A capture past
 * either is made smaller to fit, never refused.
 */
export const SCREENSHOT_LIMITS = { side: 16_384, pixels: 64 * 1024 * 1024 } as const;

/**
 * The scale to capture a `width` × `height` (CSS pixels) region at: the
 * screen's own (`deviceScale`), unless that's past the limits, then the most
 * that fits.
 */
export function captureScale(width: number, height: number, deviceScale: number, limits = SCREENSHOT_LIMITS): number {
  if (width <= 0 || height <= 0) return deviceScale;
  const bySide = limits.side / Math.max(width, height);
  const byPixels = Math.sqrt(limits.pixels / (width * height));
  return Math.min(deviceScale, bySide, byPixels);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Screenshot 2026-10-24 at 18.32.10.png", as macOS names them (dots, since Windows forbids colons). */
export function screenshotFilename(date: Date, name = 'Screenshot', extension = 'png'): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${name} ${day} at ${time}.${extension}`;
}

/** How many recent screenshots stay, and how much room they may take. */
export const SCREENSHOT_HISTORY = { count: 50, bytes: 256 * 1024 * 1024 } as const;

/** The recent screenshots to let go: the oldest past the count, or past the room (Screenboard's rule). */
export function screenshotsToForget(entries: readonly Pick<ScreenshotEntry, 'id' | 'createdAt' | 'bytes'>[], limits: { count: number; bytes: number } = SCREENSHOT_HISTORY): string[] {
  const newestFirst = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  let bytes = 0;
  let kept = 0;
  const forget: string[] = [];
  for (const entry of newestFirst) {
    if (kept >= limits.count || bytes + entry.bytes > limits.bytes) {
      forget.push(entry.id);
      continue;
    }
    bytes += entry.bytes;
    kept += 1;
  }
  return forget;
}
