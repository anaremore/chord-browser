/**
 * The chord swipe's physics (DESIGN.md §6.4), as pure functions: which axis a
 * gesture locks to, how far the panes show for a finger offset, and which
 * chord a released swipe settles on. Offsets are in px; negative reveals the
 * next chord (to the right), positive the previous one.
 */

/** A swipe engages once it has moved this far sideways… */
const ENGAGE_PX = 8;
/** …and clearly more sideways than up or down. */
const AXIS_RATIO = 1.5;
/** Released past half the width, a swipe commits… */
const COMMIT_PROGRESS = 0.5;
/** …or moving toward the neighbor faster than this (px/ms). */
export const COMMIT_SPEED = 0.5;
/** No wheel events for this long ends a gesture where the OS sends no end phase… */
export const IDLE_END_MS = 80;
/**
 * …and as many frames drawn without one. A frame hands the renderer the input that waited for it before anything
 * else, so a busy renderer (whose frames come late) never ends a swipe while its next events are still on their way:
 * 80 ms with no event read is not a lift when no frame came to read one. At 60 frames a second, 80 ms is 5 frames.
 */
export const IDLE_END_FRAMES = 3;
/** A window that draws no frames (hidden) ends a gesture after this long anyway. */
export const IDLE_END_MAX_MS = 1000;
/**
 * A gesture the OS said began (a trackpad's phases, macOS): it ends on the OS's end, never on a pause, however busy
 * the renderer; after this long with no event and no end, it ends anyway (an end that never came).
 */
export const PHASED_END_MAX_MS = 3000;

/** Whether a gesture with no end phase from the OS has ended: `sinceLastMs` since its last event, `frames` drawn since. */
export function gestureIdle(sinceLastMs: number, frames: number): boolean {
  return sinceLastMs >= IDLE_END_MAX_MS || (sinceLastMs >= IDLE_END_MS && frames >= IDLE_END_FRAMES);
}
/** Momentum keeps arriving after a release: a gesture after a gap this long is a new one. */
export const MOMENTUM_GAP_MS = 120;
/**
 * After a fling (the fingers left moving; macOS's phases), its momentum is ignored until the OS says a new gesture
 * began, however long a stalled frame leaves between two of its events, or until this long has gone by.
 */
export const FLING_MOMENTUM_MAX_MS = 3000;

/** The clock, frames and timers a gesture's end is waited with (the renderer's; a test's fakes). */
export interface EndClock {
  now(): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout> | undefined): void;
}

/**
 * When a gesture ends. Where the OS says (`begin`: a trackpad's phases, macOS), on its end, never on a pause, however
 * busy the renderer; after PHASED_END_MAX_MS with no event and no end, at rest. Elsewhere, when the events stop
 * (gestureIdle: IDLE_END_MS and IDLE_END_FRAMES frames with none), at the speed as of the last event (`last`); a window
 * drawing no frames (hidden) ends after IDLE_END_MAX_MS, at rest (`rest`). `ended` is told when, and with which speed.
 */
export class GestureEnd {
  /** The OS said this gesture began: it ends on the OS's end. */
  phased = false;
  private lastAt = 0;
  private frames = 0;
  private frameId = 0;
  private timerId: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clock: EndClock,
    private readonly ended: (at: number, speed: 'last' | 'rest') => void,
  ) {}

  /** The gesture's latest event, at `at`: its end is waited for from here. */
  event(at: number): void {
    this.lastAt = at;
    this.wait();
  }

  /**
   * The OS's begin. A busy renderer can read it after the gesture's first events: it's still this gesture's. With no
   * event after it, the wait still ends (it never sticks to the next gesture, a mouse's).
   */
  begin(): void {
    this.phased = true;
    this.wait();
  }

  /** Not waiting any more (it ended, or was let go): the next gesture starts unphased. */
  stop(): void {
    this.clock.clearTimer(this.timerId);
    this.timerId = undefined;
    this.clock.cancelFrame(this.frameId);
    this.frameId = 0;
    this.phased = false;
  }

  private end(speed: 'last' | 'rest'): void {
    this.stop();
    this.ended(this.clock.now(), speed);
  }

  private wait(): void {
    this.clock.clearTimer(this.timerId);
    this.clock.cancelFrame(this.frameId);
    if (this.phased) {
      this.timerId = this.clock.timer(() => this.end('rest'), PHASED_END_MAX_MS);
      return;
    }
    this.frames = 0;
    const tick = () => {
      this.frames += 1;
      if (gestureIdle(this.clock.now() - this.lastAt, this.frames)) this.end('last');
      else this.frameId = this.clock.frame(tick);
    };
    this.frameId = this.clock.frame(tick);
    this.timerId = this.clock.timer(() => this.end('rest'), IDLE_END_MAX_MS);
  }
}

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
