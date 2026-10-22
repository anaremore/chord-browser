/** Window placement helpers (pure, so they're unit-testable). */
import type { Bounds } from '@chord/core';

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Enough of the window's top edge to grab and drag it back. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 24;

function overlap(a: Area, b: Area): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Saved bounds as they can be used on today's displays. A window whose top
 * edge is no longer reachable (its monitor was unplugged, the layout
 * changed) is centered on the first display instead, shrunk to fit.
 */
export function placeOnDisplays(bounds: Bounds, workAreas: readonly Area[]): Bounds {
  const titleStrip = { x: bounds.x, y: bounds.y, width: bounds.width, height: GRAB_HEIGHT };
  const reachable = workAreas.some((area) => {
    const o = overlap(titleStrip, area);
    return o.width >= Math.min(GRAB_WIDTH, bounds.width) && o.height >= GRAB_HEIGHT;
  });
  const home = workAreas[0];
  if (reachable || !home) return bounds;
  const width = Math.min(bounds.width, home.width);
  const height = Math.min(bounds.height, home.height);
  return {
    ...bounds,
    x: Math.round(home.x + (home.width - width) / 2),
    y: Math.round(home.y + (home.height - height) / 2),
    width,
    height,
  };
}
