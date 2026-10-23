/**
 * The chord swipe's physics (DESIGN.md §6.4), as pure functions: which axis a
 * gesture locks to, how far the panes show for a finger offset, and which
 * chord a released swipe settles on. Offsets are in px; negative reveals the
 * next chord (to the right), positive the previous one.
 */

/** A swipe engages once it has moved this far sideways… */
export const ENGAGE_PX = 8;
/** …and clearly more sideways than up or down. */
export const AXIS_RATIO = 1.5;
/** Released past half the width, a swipe commits… */
export const COMMIT_PROGRESS = 0.5;
/** …or moving toward the neighbor faster than this (px/ms). */
export const COMMIT_SPEED = 0.5;
/** No wheel events for this long ends a gesture where the OS sends no end phase. */
export const IDLE_END_MS = 80;
/** Momentum keeps arriving after a release: a gesture after a gap this long is a new one. */
export const MOMENTUM_GAP_MS = 120;

export type Axis = 'undecided' | 'horizontal' | 'vertical';

/** The axis a gesture locks to, from its accumulated deltas. Vertical stays the list's. */
export function lockAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > ENGAGE_PX && ax > AXIS_RATIO * ay) return 'horizontal';
  if (ay > ENGAGE_PX && ay >= ax) return 'vertical';
  return 'undecided';
}

const BAND = 0.55;

/** The rubber band at the first and last chord: how far a pane shows when pulled `x` px past it. */
export function rubberBand(x: number, width: number): number {
  const shown = (1 - 1 / ((Math.abs(x) * BAND) / width + 1)) * width;
  return Math.sign(x) * shown;
}

/** The inverse of rubberBand: the pull that shows a pane `shown` px past the end. */
export function rubberBandPull(shown: number, width: number): number {
  const s = Math.min(Math.abs(shown), width * 0.999);
  return Math.sign(shown) * (1 / (1 - s / width) - 1) * (width / BAND);
}

/**
 * Where the current pane shows for a finger offset `raw`: 1:1 toward a
 * neighbor (at most a full width), rubber-banded where there's no neighbor.
 */
export function shownOffset(raw: number, width: number, hasPrev: boolean, hasNext: boolean): number {
  if (raw < 0) return hasNext ? Math.max(raw, -width) : rubberBand(raw, width);
  if (raw > 0) return hasPrev ? Math.min(raw, width) : rubberBand(raw, width);
  return 0;
}

/** The finger offset that shows the pane at `shown`, so a caught pane continues where it is. */
export function rawOffset(shown: number, width: number, hasPrev: boolean, hasNext: boolean): number {
  if (shown < 0) return hasNext ? shown : rubberBandPull(shown, width);
  if (shown > 0) return hasPrev ? shown : rubberBandPull(shown, width);
  return 0;
}

/**
 * Which chord a released swipe settles on, relative to the current one: +1
 * (next), −1 (previous) or 0 (springs back). It commits when it's moving
 * toward the neighbor faster than COMMIT_SPEED, or past COMMIT_PROGRESS
 * without being flicked back. `velocity` is the shown offset's, in px/ms.
 */
export function settle(shown: number, velocity: number, width: number, hasPrev: boolean, hasNext: boolean): -1 | 0 | 1 {
  if (shown === 0 && velocity === 0) return 0;
  const toward: -1 | 1 = shown < 0 || (shown === 0 && velocity < 0) ? 1 : -1;
  if ((toward === 1 && !hasNext) || (toward === -1 && !hasPrev)) return 0;
  // Toward the next chord the offset grows more negative, toward the previous more positive.
  const speedToward = -velocity * toward;
  if (speedToward > COMMIT_SPEED) return toward;
  if (Math.abs(shown) / width > COMMIT_PROGRESS && speedToward > -COMMIT_SPEED) return toward;
  return 0;
}

/** Recent samples of an offset over time, for the velocity a release springs with. */
export class VelocityTracker {
  private samples: { t: number; x: number }[] = [];

  constructor(private readonly windowMs = 80) {}

  reset(t: number, x: number, velocity = 0): void {
    // Seeding with a velocity (a caught pane keeps moving) is a sample one ms back.
    this.samples = velocity ? [{ t: t - 1, x: x - velocity }, { t, x }] : [{ t, x }];
  }

  add(t: number, x: number): void {
    this.samples.push({ t, x });
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift();
  }

  /** px/ms over the recent window; 0 if the last sample is stale (the fingers rested before lifting). */
  velocity(now: number): number {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.t === first.t || now - last.t > this.windowMs) return 0;
    return (last.x - first.x) / (last.t - first.t);
  }
}

/**
 * A mouse's tilt wheel or Shift+wheel, rather than a trackpad: line or page
 * deltas, or a big first step. It switches one chord per notch instead of
 * following 1:1.
 */
export function isWheelNotch(deltaMode: number, deltaX: number, firstOfGesture: boolean): boolean {
  return deltaMode !== 0 || (firstOfGesture && Math.abs(deltaX) >= 50);
}
