/**
 * Motion tokens (DESIGN.md §6). Springs are physical (mass 1) so they can be
 * interrupted and retargeted with velocity; fades are only for opacity/color.
 */

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

const spring = (stiffness: number, damping: number): Spring => ({ stiffness, damping, mass: 1 });

export const springs = {
  /** Press-down scale, toggles. ζ 0.96, t90 ≈ 95 ms. */
  press: spring(1500, 74),
  /** Active-tab pill glide, chevrons, hover-card reposition. ζ 0.94, t90 ≈ 137 ms. */
  snappy: spring(700, 50),
  /** Command bar, Peek, toasts, Duet panel. ζ 0.86, 0.5% overshoot. */
  overlay: spring(600, 42),
  /** List reflow, reorder, folder expand. ζ 0.90, t90 ≈ 160 ms. */
  smooth: spring(450, 38),
  /** Arrivals: drop settle, pin landing, archive gulp. ζ 0.67, 5.7% overshoot. */
  bouncy: spring(500, 30),
  /** Gesture release; seed with the gesture's velocity. ζ 0.90. */
  release: spring(360, 34),
  /** Theme crossfade, scrims, empty-state art. ζ 0.96, t90 ≈ 230 ms. */
  gentle: spring(260, 31),
  /** Decorative only (logo strike, onboarding flourishes). 18.5% overshoot. */
  playful: spring(220, 14),
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof springs;

export const durations = {
  instant: 0,
  fadeFast: 90,
  fadeBase: 140,
  fadeSlow: 220,
  hoverIntent: 500,
  tooltip: 600,
  springLoad: 600,
  toast: 6000,
  /** One turn of the loading spinner. */
  spin: 900,
} as const;

export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

export interface SpringProfile {
  dampingRatio: number;
  /** Peak overshoot past the target, as a fraction (0.057 = 5.7%). */
  overshoot: number;
  /** Time to reach 90% of the distance, ms. */
  t90: number;
  /** Time after which the value stays within ±0.5% of the target, ms. */
  settle: number;
}

/** Simulate a unit step (0 → 1 from rest) with semi-implicit Euler at 0.5 ms. */
export function simulateSpring(s: Spring, durationMs = 2000, onSample?: (tMs: number, x: number) => void): SpringProfile {
  const dt = 1 / 2000;
  let x = 0;
  let v = 0;
  let max = 0;
  let t90 = NaN;
  let settle = 0;
  for (let t = 0; t < durationMs / 1000; t += dt) {
    onSample?.(t * 1000, x);
    const a = (-s.stiffness * (x - 1) - s.damping * v) / s.mass;
    v += a * dt;
    x += v * dt;
    max = Math.max(max, x);
    if (Number.isNaN(t90) && x >= 0.9) t90 = (t + dt) * 1000;
    if (Math.abs(x - 1) > 0.005) settle = (t + dt) * 1000;
  }
  return {
    dampingRatio: s.damping / (2 * Math.sqrt(s.stiffness * s.mass)),
    overshoot: Math.max(0, max - 1),
    t90,
    settle,
  };
}

/**
 * The spring as a CSS `linear()` easing plus duration, for hover/press
 * transitions that should feel springy without running JavaScript.
 */
export function springToCss(s: Spring, points = 32): { easing: string; durationMs: number } {
  const { settle } = simulateSpring(s);
  const durationMs = Math.ceil(settle / 10) * 10;
  const samples: number[] = [];
  const step = durationMs / (points - 1);
  let next = 0;
  simulateSpring(s, durationMs + 1, (t, x) => {
    if (t >= next && samples.length < points) {
      samples.push(x);
      next += step;
    }
  });
  while (samples.length < points) samples.push(1);
  samples[samples.length - 1] = 1;
  return { easing: `linear(${samples.map((x) => Number(x.toFixed(4))).join(', ')})`, durationMs };
}

/**
 * The spring as progress over time (0 → 1), for motion that CSS can't drive,
 * like native view bounds. Matches `springToCss` so both sides move together.
 */
export function springCurve(s: Spring): { durationMs: number; at(tMs: number): number } {
  const { settle } = simulateSpring(s);
  const durationMs = Math.ceil(settle / 10) * 10;
  const samples: number[] = [];
  simulateSpring(s, durationMs + 1, (t, x) => {
    if (samples.length === Math.floor(t)) samples.push(x);
  });
  return { durationMs, at: (t) => (t >= durationMs ? 1 : t <= 0 ? 0 : (samples[Math.floor(t)] ?? 1)) };
}
