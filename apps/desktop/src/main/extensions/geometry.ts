/** Where an extension's popup goes and how big it is (pure, for tests). */
import type { Rect } from '@chord/ipc';
import { size, space } from '@chord/tokens';

/** Chrome's limits for action popups (chrome/browser/ui/extensions/extension_popup_types.h). */
export const POPUP_MIN = { width: 25, height: 25 };
export const POPUP_MAX = { width: 800, height: 600 };

/** Fit a page's preferred size into Chrome's popup limits and the window, with a margin. */
export function popupSize(preferred: { width: number; height: number }, window: { width: number; height: number }): { width: number; height: number } {
  const margin = space[2] * 2;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.ceil(value)));
  return {
    width: clamp(preferred.width, POPUP_MIN.width, Math.min(POPUP_MAX.width, Math.max(POPUP_MIN.width, window.width - margin))),
    height: clamp(preferred.height, POPUP_MIN.height, Math.min(POPUP_MAX.height, Math.max(POPUP_MIN.height, window.height - margin))),
  };
}

/**
 * Next to its button: under it, or above it when the button is in the
 * window's lower half (the sidebar's shelf). Lined up with the button's right
 * edge when the button is on the window's right half (the title bar), its
 * left edge otherwise, and kept inside the window. With no button, it hangs
 * from the frame's top-right corner.
 */
export function popupPosition(
  popup: { width: number; height: number },
  anchor: Rect | null,
  window: { width: number; height: number; frameTop: number },
): { x: number; y: number } {
  const inset = size.frameInset;
  const maxX = Math.max(inset, window.width - popup.width - inset);
  const maxY = Math.max(inset, window.height - popup.height - inset);
  if (!anchor) return { x: maxX, y: Math.min(maxY, window.frameTop + space[2]) };
  const rightAligned = anchor.x + anchor.width / 2 > window.width / 2;
  const x = rightAligned ? anchor.x + anchor.width - popup.width : anchor.x;
  const above = anchor.y + anchor.height / 2 > window.height / 2;
  const y = above ? anchor.y - space[1] - popup.height : anchor.y + anchor.height + space[1];
  return { x: Math.round(Math.min(maxX, Math.max(inset, x))), y: Math.round(Math.min(maxY, Math.max(inset, y))) };
}
