/**
 * Chord themes (DESIGN.md §5): a user picks 1–3 colors, a grain amount and an
 * appearance; `createChordTheme` turns that into every semantic color the shell
 * needs, with a contrast guarantee for text.
 */
import {
  circularMeanHue,
  contrast,
  cssOklch,
  mixOklab,
  oklchToRgb,
  over,
  type Oklch,
  type Rgb,
} from './color';

export type Appearance = 'light' | 'dark';
export type AppearancePreference = Appearance | 'auto';

/** Curated swatches at display lightness (DESIGN.md §5.1). */
export const SWATCHES = {
  coral: { l: 0.72, c: 0.14, h: 30 },
  tangerine: { l: 0.72, c: 0.15, h: 55 },
  honey: { l: 0.72, c: 0.13, h: 85 },
  moss: { l: 0.72, c: 0.11, h: 130 },
  mint: { l: 0.72, c: 0.1, h: 165 },
  lagoon: { l: 0.72, c: 0.1, h: 200 },
  sky: { l: 0.72, c: 0.11, h: 235 },
  periwinkle: { l: 0.72, c: 0.12, h: 270 },
  lilac: { l: 0.72, c: 0.12, h: 300 },
  orchid: { l: 0.72, c: 0.13, h: 330 },
  rose: { l: 0.72, c: 0.13, h: 5 },
  graphite: { l: 0.72, c: 0.015, h: 260 },
} as const satisfies Record<string, Oklch>;

export type SwatchId = keyof typeof SWATCHES;

export const PRESETS = {
  dusk: ['lilac', 'coral'],
  seaGlass: ['mint', 'sky'],
  citrus: ['honey', 'tangerine'],
  aurora: ['mint', 'periwinkle', 'orchid'],
  ember: ['rose', 'tangerine'],
  fog: ['graphite', 'periwinkle'],
  lagoon: ['lagoon', 'periwinkle'],
  meadow: ['moss', 'honey'],
  bloom: ['rose', 'lilac'],
  harbor: ['graphite', 'lagoon'],
} as const satisfies Record<string, readonly SwatchId[]>;

export type PresetId = keyof typeof PRESETS;

export interface ChordThemeInput {
  /** 1–3 colors; extra stops are ignored. */
  stops: readonly Oklch[];
  /** Grain/noise amount, 0–1. */
  grain: number;
  appearance: AppearancePreference;
}

export interface ThemeContext {
  /** The OS appearance, used when the chord follows the system. */
  systemAppearance: Appearance;
  /** `translucent` when an OS material (vibrancy, Mica) shows through the tint. */
  material: 'translucent' | 'solid';
  /**
   * Settings → Appearance → Contrast, 0–1 (0.5 is the default): how strongly
   * dividers, hover states and secondary text stand apart. Text never drops
   * below 4.5:1 either way.
   */
  contrast?: number;
  /** Settings → Appearance → Window tint, 0–1 (0.5 is the default): how much color covers the window material. */
  glass?: number;
}

/** 0–1 around a 0.5 midpoint: below it moves from `low` to `mid`, above it from `mid` to `high`. */
function around(t: number, low: number, mid: number, high: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x <= 0.5 ? low + (mid - low) * (x / 0.5) : mid + (high - mid) * ((x - 0.5) / 0.5);
}

export interface ChordTheme {
  appearance: Appearance;
  /** Tint stops after mapping into the appearance band and the contrast guard. */
  stops: Oklch[];
  tintAlpha: number;
  /** Lowest text contrast found across the tint, for tests and diagnostics. */
  minContrast: { fg: number; fgMuted: number; accent: number; accentFg: number };
  /** CSS custom properties to set on the element that hosts the chord. */
  vars: Record<`--${string}`, string>;
}

/** Errors and destructive actions: one red per appearance, at ≥ 4.5:1 on every surface. */
export const DANGER: Record<Appearance, Oklch> = {
  light: { l: 0.53, c: 0.19, h: 25 },
  dark: { l: 0.74, c: 0.15, h: 25 },
};

export function presetStops(id: PresetId): Oklch[] {
  return PRESETS[id].map((swatch) => ({ ...SWATCHES[swatch] }));
}

/**
 * Fallback-favicon colors for a site's stable hue (DESIGN.md §7.4): a soft
 * square with whichever of white or near-black reads at ≥ 4.5:1.
 */
export function siteColors(hue: number, appearance: Appearance): { background: string; foreground: string } {
  const bg: Oklch = appearance === 'light' ? { l: 0.7, c: 0.11, h: hue } : { l: 0.55, c: 0.1, h: hue };
  const bgRgb = oklchToRgb(bg);
  const white = oklchToRgb({ l: 1, c: 0, h: 0 });
  const ink: Oklch = { l: 0.2, c: 0.02, h: hue };
  const foreground = contrast(white, bgRgb) >= contrast(oklchToRgb(ink), bgRgb) ? 'oklch(1 0 0)' : cssOklch(ink);
  return { background: cssOklch(bg), foreground };
}

/** Solid window background before any tint paints, and where no OS material exists. */
export const windowBackground: Record<Appearance, Oklch> = {
  light: { l: 0.975, c: 0, h: 0 },
  dark: { l: 0.22, c: 0, h: 0 },
};

/**
 * A new chord's colors: a gradient from the OS accent's hue, so the first
 * chord feels like it belongs on this computer (DESIGN.md §5.1). Falls back to
 * the Dusk preset when there's no usable accent.
 */
export function defaultChordStops(accent: Oklch | null): Oklch[] {
  if (!accent || accent.c < 0.03) return presetStops('dusk');
  // A soft analogous gradient: the accent, drifting 45° around the wheel.
  const c = Math.min(0.14, Math.max(0.1, accent.c));
  return [
    { l: 0.72, c, h: accent.h },
    { l: 0.72, c, h: (accent.h + 45) % 360 },
  ];
}

const TEXT_MIN_CONTRAST = 4.5;
const UI_MIN_CONTRAST = 3;
/** Assumed worst-case OS material behind a translucent tint (DESIGN.md §5.2). */
const WORST_MATERIAL: Record<Appearance, Oklch> = {
  light: { l: 0.9, c: 0, h: 0 },
  dark: { l: 0.28, c: 0, h: 0 },
};

/**
 * A picked color as the tint shows it in one appearance, before the contrast
 * guard: light mode lifts it pale, dark mode sinks it deep. The theme
 * editor's color wheel is drawn with this.
 */
export function mapToBand(stop: Oklch, appearance: Appearance): Oklch {
  const c = Math.min(Math.max(stop.c, 0), 0.16);
  return appearance === 'light'
    ? { l: 0.94 - 0.5 * c, c: 0.7 * c, h: stop.h }
    : { l: 0.26 + 0.4 * c, c: 0.7 * c, h: stop.h };
}

/** Points the eye actually sees across the gradient: each stop plus the midpoints. */
function gradientSamples(stops: readonly Oklch[]): Oklch[] {
  const samples: Oklch[] = [];
  stops.forEach((stop, i) => {
    samples.push(stop);
    const next = stops[i + 1];
    if (next) {
      samples.push(mixOklab(stop, next, 0.25), mixOklab(stop, next, 0.5), mixOklab(stop, next, 0.75));
    }
  });
  return samples;
}

function minContrastAgainst(text: Rgb, stops: readonly Oklch[], alpha: number, backdrop: Rgb): number {
  let min = Infinity;
  for (const sample of gradientSamples(stops)) {
    min = Math.min(min, contrast(text, over(oklchToRgb(sample), alpha, backdrop)));
  }
  return min;
}

export function createChordTheme(input: ChordThemeInput, context: ThemeContext): ChordTheme {
  const appearance = input.appearance === 'auto' ? context.systemAppearance : input.appearance;
  const light = appearance === 'light';
  const userStops = input.stops.slice(0, 3);
  if (userStops.length === 0) throw new Error('A chord theme needs at least one color.');

  const hue = circularMeanHue(userStops.map((s) => s.h));
  const strength = context.contrast ?? 0.5;
  const fg: Oklch = light ? { l: 0.24, c: 0.02, h: hue } : { l: 0.96, c: 0.01, h: hue };
  // More contrast pulls secondary text toward the main text color; less lets it recede.
  const fgMuted: Oklch = light
    ? { l: around(strength, 0.45, 0.42, 0.34), c: 0.02, h: hue }
    : { l: around(strength, 0.75, 0.78, 0.86), c: 0.015, h: hue };
  const fgSubtle: Oklch = light
    ? { l: around(strength, 0.6, 0.56, 0.48), c: 0.015, h: hue }
    : { l: around(strength, 0.6, 0.64, 0.72), c: 0.012, h: hue };
  const base: Oklch = light ? { l: 0.975, c: 0.006, h: hue } : { l: 0.22, c: 0.006, h: hue };
  const surface: Oklch = light ? { l: 0.995, c: 0.003, h: hue } : { l: 0.21, c: 0.006, h: hue };
  const surfaceRaised: Oklch = light ? { l: 1, c: 0, h: hue } : { l: 0.25, c: 0.008, h: hue };

  const tintAlpha = around(context.glass ?? 0.5, light ? 0.45 : 0.55, light ? 0.72 : 0.8, 0.96);
  const backdrop = oklchToRgb(context.material === 'translucent' ? WORST_MATERIAL[appearance] : base);
  const fgRgb = oklchToRgb(fg);
  const mutedRgb = oklchToRgb(fgMuted);

  // Contrast guard: move the tint away from the text, then calm its chroma.
  let stops = userStops.map((s) => mapToBand(s, appearance));
  let fgMin = 0;
  let mutedMin = 0;
  for (let step = 0; step <= 40; step++) {
    fgMin = minContrastAgainst(fgRgb, stops, tintAlpha, backdrop);
    mutedMin = minContrastAgainst(mutedRgb, stops, tintAlpha, backdrop);
    if (fgMin >= TEXT_MIN_CONTRAST && mutedMin >= TEXT_MIN_CONTRAST) break;
    stops = stops.map((s) =>
      step < 15
        ? { ...s, l: light ? Math.min(0.99, s.l + 0.01) : Math.max(0.1, s.l - 0.01) }
        : { ...s, c: s.c * 0.85 },
    );
  }

  // Accent: the most chromatic pick, kept legible against surfaces as a UI color.
  const vivid = userStops.reduce((a, b) => (b.c > a.c ? b : a));
  let accent: Oklch = { l: light ? 0.58 : 0.76, c: Math.min(0.16, vivid.c * 1.2), h: vivid.h };
  const surfaceRgb = oklchToRgb(surface);
  let accentContrast = contrast(oklchToRgb(accent), surfaceRgb);
  for (let i = 0; i < 20 && accentContrast < UI_MIN_CONTRAST; i++) {
    accent = { ...accent, l: light ? accent.l - 0.02 : accent.l + 0.02 };
    accentContrast = contrast(oklchToRgb(accent), surfaceRgb);
  }
  // Text on the accent (primary buttons): white in light themes, a dark ink in the accent's hue in
  // dark ones (the theme's own text color is light there, and light-on-light fails). The accent
  // darkens or lightens until that text reads; either way it moves away from the surface, which
  // only raises its own contrast.
  const white = oklchToRgb({ l: 1, c: 0, h: 0 });
  const ink: Oklch = { l: 0.2, c: Math.min(0.04, accent.c), h: accent.h };
  const inkRgb = oklchToRgb(ink);
  let accentRgb = oklchToRgb(accent);
  for (let i = 0; i < 20 && contrast(light ? white : inkRgb, accentRgb) < TEXT_MIN_CONTRAST; i++) {
    accent = { ...accent, l: light ? accent.l - 0.02 : accent.l + 0.02 };
    accentRgb = oklchToRgb(accent);
  }
  accentContrast = contrast(accentRgb, surfaceRgb);
  const onWhite = contrast(white, accentRgb);
  const onInk = contrast(inkRgb, accentRgb);
  const accentFg = onWhite >= TEXT_MIN_CONTRAST || onWhite >= onInk ? 'oklch(1 0 0)' : cssOklch(ink);
  const accentFgContrast = accentFg === 'oklch(1 0 0)' ? onWhite : onInk;

  const tint = (s: Oklch) => cssOklch(s, tintAlpha);
  const [a, b, c] = stops as [Oklch, Oklch?, Oklch?];
  const tintCss = !b
    ? `linear-gradient(${tint(a)}, ${tint(a)})`
    : !c
      ? `linear-gradient(in oklab 160deg, ${tint(a)}, ${tint(b)})`
      : `radial-gradient(70% 70% at 30% 60%, ${tint(b)}, transparent 70%), linear-gradient(in oklab 160deg, ${tint(a)}, ${tint(c)})`;

  return {
    appearance,
    stops,
    tintAlpha,
    minContrast: { fg: fgMin, fgMuted: mutedMin, accent: accentContrast, accentFg: accentFgContrast },
    vars: {
      '--color-tint': tintCss,
      '--color-base': context.material === 'translucent' ? 'transparent' : cssOklch(base),
      '--color-fg': cssOklch(fg),
      '--color-fg-muted': cssOklch(fgMuted),
      '--color-fg-subtle': cssOklch(fgSubtle),
      '--color-item-hover': cssOklch(fg, around(strength, light ? 0.04 : 0.05, light ? 0.06 : 0.07, light ? 0.1 : 0.12)),
      '--color-item-active-bg': light ? 'oklch(1 0 0 / 0.78)' : `oklch(1 0 0 / ${around(strength, 0.08, 0.1, 0.15).toFixed(3)})`,
      '--color-divider': cssOklch(fg, around(strength, 0.06, 0.1, 0.18)),
      '--color-accent': cssOklch(accent),
      '--color-accent-fg': accentFg,
      '--color-danger': cssOklch(DANGER[appearance]),
      /** Selected rows in lists like the command bar. */
      '--color-selection': cssOklch(accent, light ? 0.14 : 0.22),
      '--color-surface': cssOklch(surface),
      '--color-surface-raised': cssOklch(surfaceRaised),
      '--color-scrim': light ? 'oklch(0 0 0 / 0.18)' : 'oklch(0 0 0 / 0.36)',
      '--grain-opacity': (Math.min(Math.max(input.grain, 0), 1) * (light ? 0.2 : 0.28)).toFixed(3),
    },
  };
}
