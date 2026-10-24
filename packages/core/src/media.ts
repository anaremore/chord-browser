/**
 * Now playing (DESIGN.md §7.10, ARCHITECTURE.md §9): media playing in tabs,
 * for the sidebar's card. Main reads what a page plays (main/media.ts); these
 * are the choices that don't need a page.
 */
import { chordsFor } from './select';
import { shownTabs } from './split';
import type { NodeId, State, WindowId } from './model';

/** An image a page offers for what it plays (the Media Session's `MediaImage`). */
export interface MediaImage {
  src: string;
  sizes: string;
  type: string;
}

/** Image types the card shows. Not SVG: an image Chord fetches stays a plain picture. */
const ARTWORK_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/;

/** Whether Chord may fetch and show this type of image (`type` without parameters, lowercase). */
export const isArtworkType = (type: string): boolean => ARTWORK_TYPES.test(type);

/** The longest side an image says it has (`"96x96 128x128"` gives 128); 0 when it doesn't say (`any`, nothing). */
export function imageSide(sizes: string): number {
  let side = 0;
  for (const m of sizes.matchAll(/(\d{1,5})[xX](\d{1,5})/g)) side = Math.max(side, Number(m[1]), Number(m[2]));
  return side;
}

/**
 * The artwork to show at `side` device pixels: the smallest image at least
 * that big, else the biggest smaller one, else the first that gives no size.
 * Only web addresses and image data count; an image whose type is given must
 * be one the card shows.
 */
export function pickArtwork(images: readonly MediaImage[], side: number): MediaImage | null {
  const usable = images.filter(
    (i) => (/^https?:/i.test(i.src) || /^data:image\//i.test(i.src)) && (!i.type || isArtworkType(i.type.toLowerCase())),
  );
  const sized = usable.map((image) => ({ image, side: imageSide(image.sizes) }));
  const big = sized.filter((s) => s.side >= side).sort((a, b) => a.side - b.side)[0];
  const small = sized.filter((s) => s.side > 0 && s.side < side).sort((a, b) => b.side - a.side)[0];
  return (big ?? small ?? sized.find((s) => s.side === 0))?.image ?? null;
}

/**
 * Of the tabs playing (newest first), those a window may show in its card:
 * tabs in the chords it lists, so a normal window never shows a private
 * window's, and a private window shows only its own.
 */
export function mediaVisibleTo<T extends { nodeId: NodeId }>(state: State, windowId: WindowId, playing: readonly T[]): T[] {
  const chords = new Set(chordsFor(state, windowId).map((c) => c.id));
  return playing.filter((p) => {
    const node = state.nodes[p.nodeId];
    return node?.kind === 'tab' && chords.has(node.chordId);
  });
}

/** What the card offers: the window's media, less the tabs it shows right now (their own controls are on screen). */
export function cardMedia<T extends { nodeId: NodeId }>(state: State, windowId: WindowId, playing: readonly T[]): T[] {
  const shown = new Set(shownTabs(state, windowId));
  return mediaVisibleTo(state, windowId, playing).filter((p) => !shown.has(p.nodeId));
}
