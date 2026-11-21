/**
 * Peek's card (DESIGN.md §7.9, §8.5): where it goes when you move or resize
 * it. Pure, so main (which places Peek's page) and the overlay (which draws
 * the card and follows the pointer) clamp it with exactly the same numbers.
 * Everything is in UI units: the overlay's CSS pixels, window coordinates.
 */

export interface PeekBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest the card gets by resizing (the area may be smaller still: then it's the area). */
export const PEEK_MIN = { width: 360, height: 240 } as const;

/** An edge or corner of the card, by compass point. */
export type PeekEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** What a press on the card does: move it (its header's empty part), resize it from an edge, or nothing of Peek's own. */
export type PeekGrip = PeekEdge | 'move';

/** How far past the card's edge a press still takes the edge. Inside, only the header is the overlay's (the page covers the rest). */
export const PEEK_GRIP = { outside: 6, inside: 4, corner: 14 } as const;

/** What the press landed on: the header's empty part, one of its controls or its text (they click as before), or around the card. */
export type PeekTarget = 'header' | 'control' | 'outside';

/**
 * The card inside `area` (the window's page area): no smaller than PEEK_MIN
 * unless the area is, no bigger than the area, and wholly within it. Whole
 * pixels, so main and the overlay agree on the edges.
 */
export function clampPeekCard(card: PeekBox, area: PeekBox): PeekBox {
  // The whole pixels inside the area (at some interface sizes its edges fall between pixels).
  const left = Math.ceil(area.x);
  const top = Math.ceil(area.y);
  const right = Math.max(left, Math.floor(area.x + area.width));
  const bottom = Math.max(top, Math.floor(area.y + area.height));
  const width = Math.min(Math.max(Math.round(card.width), PEEK_MIN.width), right - left);
  const height = Math.min(Math.max(Math.round(card.height), PEEK_MIN.height), bottom - top);
  const x = Math.min(Math.max(Math.round(card.x), left), right - width);
  const y = Math.min(Math.max(Math.round(card.y), top), bottom - height);
  return { x, y, width, height };
}

/**
 * The card `start` after the pointer moved by (dx, dy) holding `grip`: moved
 * whole, or resized from an edge or corner with the opposite edges staying
 * put, then clamped to `area`. A resize past the minimum or the area's edge
 * stops there rather than pushing the card along.
 */
export function dragPeekCard(start: PeekBox, grip: PeekGrip, dx: number, dy: number, area: PeekBox): PeekBox {
  if (grip === 'move') return clampPeekCard({ ...start, x: start.x + dx, y: start.y + dy }, area);
  const minW = Math.min(PEEK_MIN.width, area.width);
  const minH = Math.min(PEEK_MIN.height, area.height);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let { x, y, width, height } = start;
  if (grip.includes('e')) width = Math.min(Math.max(start.width + dx, minW), area.x + area.width - start.x);
  if (grip.includes('w')) {
    width = Math.min(Math.max(start.width - dx, minW), right - area.x);
    x = right - width;
  }
  if (grip.includes('s')) height = Math.min(Math.max(start.height + dy, minH), area.y + area.height - start.y);
  if (grip.includes('n')) {
    height = Math.min(Math.max(start.height - dy, minH), bottom - area.y);
    y = bottom - height;
  }
  return clampPeekCard({ x, y, width, height }, area);
}

/**
 * What a press at `point` takes hold of: an edge or corner within PEEK_GRIP
 * of the card's border (outside it, or inside along the header's top), the
 * header's empty part to move it, or nothing (null): the header's buttons and
 * text click as before, and a press anywhere else is the scrim's or the page's.
 */
export function peekGripAt(point: { x: number; y: number }, card: PeekBox, on: PeekTarget): PeekGrip | null {
  if (on === 'control') return null;
  const { outside, inside, corner } = PEEK_GRIP;
  const left = card.x;
  const right = card.x + card.width;
  const top = card.y;
  const bottom = card.y + card.height;
  const within = point.x >= left - outside && point.x <= right + outside && point.y >= top - outside && point.y <= bottom + outside;
  if (!within) return null;
  const inCard = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  // Inside the card, only the header's top edge is the overlay's; the page view covers the rest.
  if (inCard && on === 'header' && point.y - top >= inside) return 'move';
  const n = point.y <= top + (inCard ? inside : 0);
  const s = !inCard && point.y >= bottom;
  const w = !inCard && point.x <= left;
  const e = !inCard && point.x >= right;
  // Near a corner along either edge, it's the corner.
  const nearN = point.y <= top + corner;
  const nearS = point.y >= bottom - corner;
  const nearW = point.x <= left + corner;
  const nearE = point.x >= right - corner;
  if ((n && nearW) || (w && nearN)) return 'nw';
  if ((n && nearE) || (e && nearN)) return 'ne';
  if ((s && nearW) || (w && nearS)) return 'sw';
  if ((s && nearE) || (e && nearS)) return 'se';
  if (n) return 'n';
  if (s) return 's';
  if (w) return 'w';
  if (e) return 'e';
  return null;
}

/** The pointer's look over each grip. */
export const PEEK_CURSOR: Record<PeekGrip, string> = {
  move: 'grab',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};
