/**
 * The ThemePicker's color wheel (DESIGN.md §7.7), as pure functions: hue runs
 * clockwise around the ring from the top, chroma outward from the gray
 * center. Colors you pick sit at the swatches' display lightness (PICK_L);
 * the theme generator maps them into each appearance's band.
 */
import type { Oklch } from '@chord/core';
import { SWATCHES, type SwatchId } from '@chord/tokens';

/** The display lightness picked colors are stored at, like the swatches. */
export const PICK_L = 0.72;
/** The most chroma a pick can have: the generator's band caps it here too. */
export const MAX_CHROMA = 0.16;
export const MAX_STOPS = 3;
/** "+" adds a color this far around the wheel from the last one. */
export const ADD_STEP_DEG = 40;
/** A handle dragged this far out (in radii) leaves the wheel: let go there and it's removed. */
export const REMOVE_RADIUS = 1.25;
/** Arrow keys turn the hue this far; Shift+arrows change chroma by this much. */
export const HUE_STEP = 5;
export const CHROMA_STEP = 0.01;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** The color under a point of a `size`-px wheel, and how far out it is (1 = the rim). */
export function pointToColor(x: number, y: number, size: number): { color: Oklch; distance: number } {
  const r = size / 2;
  const dx = x - r;
  const dy = y - r;
  const distance = Math.hypot(dx, dy) / r;
  // 0° at the top, growing clockwise.
  const h = wrap((Math.atan2(dx, -dy) * 180) / Math.PI);
  return { color: { l: PICK_L, c: Math.min(distance, 1) * MAX_CHROMA, h }, distance };
}

/** Where a color sits on a `size`-px wheel. */
export function colorToPoint(color: Pick<Oklch, 'c' | 'h'>, size: number): { x: number; y: number } {
  const r = size / 2;
  const out = (Math.min(Math.max(color.c, 0), MAX_CHROMA) / MAX_CHROMA) * r;
  return { x: r + Math.sin(toRad(color.h)) * out, y: r - Math.cos(toRad(color.h)) * out };
}

/** Which handle a click on the wheel moves: the nearest one. */
export function nearestStop(x: number, y: number, stops: readonly Oklch[], size: number): number {
  let best = 0;
  let bestDistance = Infinity;
  stops.forEach((stop, i) => {
    const p = colorToPoint(stop, size);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/** The color "+" adds: a little way around the wheel from the last one, never gray. */
export function addedStop(stops: readonly Oklch[]): Oklch {
  const last = stops.at(-1) ?? { l: PICK_L, c: 0.12, h: 300 };
  return { l: PICK_L, c: Math.max(last.c, 0.08), h: wrap(last.h + ADD_STEP_DEG) };
}

/** A handle let go `distance` radii out leaves the wheel, unless it's the only color. */
export function removesOnRelease(distance: number, count: number): boolean {
  return distance > REMOVE_RADIUS && count > 1;
}

/** Arrow keys on a handle: ←/↓ and →/↑ turn the hue; with Shift they change chroma. */
export function stepColor(color: Oklch, key: string, shift: boolean): Oklch | null {
  const sign = key === 'ArrowRight' || key === 'ArrowUp' ? 1 : key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 0;
  if (!sign) return null;
  if (shift) return { ...color, l: PICK_L, c: Math.min(MAX_CHROMA, Math.max(0, Math.round((color.c + sign * CHROMA_STEP) * 1000) / 1000)) };
  return { ...color, l: PICK_L, h: wrap(Math.round(color.h + sign * HUE_STEP)) };
}

const titleCase = (id: string) => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const hueGap = (a: number, b: number) => Math.min(wrap(a - b), wrap(b - a));

/** What a screen reader hears for a handle: the nearest swatch, and how vivid it is. */
export function describeColor(color: Pick<Oklch, 'c' | 'h'>): string {
  const t = color.c / MAX_CHROMA;
  if (t < 0.15) return 'Close to Graphite, gray';
  const colored = (Object.keys(SWATCHES) as SwatchId[]).filter((id) => id !== 'graphite');
  const nearest = colored.reduce((a, b) => (hueGap(SWATCHES[b].h, color.h) < hueGap(SWATCHES[a].h, color.h) ? b : a));
  const vividness = t < 0.45 ? 'soft' : t < 0.75 ? 'medium' : 'vivid';
  return `Close to ${titleCase(nearest)}, ${vividness}`;
}

/**
 * "Surprise me": two or three colors that sit well together (neighbors on
 * the wheel, or one across from them), sometimes just one. `random` is
 * Math.random in the app, seeded in tests.
 */
export function surpriseStops(random: () => number): Oklch[] {
  const count = random() < 0.2 ? 1 : random() < 0.6 ? 2 : 3;
  const base = random() * 360;
  const chroma = () => 0.09 + random() * 0.05;
  if (count === 1) return [{ l: PICK_L, c: chroma(), h: wrap(base) }];
  // Analogous most of the time; now and then a split complement for some contrast.
  const spread = random() < 0.75 ? 30 + random() * 30 : 150 + random() * 40;
  return Array.from({ length: count }, (_, i) => ({ l: PICK_L, c: chroma(), h: wrap(base + (spread / (count - 1)) * i) }));
}
