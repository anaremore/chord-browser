/**
 * Color math for the token system: OKLCH ⇄ sRGB, alpha compositing and
 * WCAG 2 contrast. Pure functions with no DOM, so the theme generator can be
 * unit-tested and run identically in main and renderer processes.
 */

export interface Oklch {
  /** Perceptual lightness, 0–1. */
  l: number;
  /** Chroma, ≥ 0 (≈ 0.37 is the most saturated sRGB). */
  c: number;
  /** Hue angle in degrees. */
  h: number;
}

interface Oklab {
  l: number;
  a: number;
  b: number;
}

/** sRGB, gamma-encoded, each channel 0–1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const DEG = Math.PI / 180;

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  return { l, a: c * Math.cos(h * DEG), b: c * Math.sin(h * DEG) };
}

export function oklabToOklch({ l, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : (Math.atan2(b, a) / DEG + 360) % 360;
  return { l, c, h };
}

function gammaEncode(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function gammaDecode(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** OKLCH → gamma-encoded sRGB, clipped to the sRGB gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  const { l, a, b } = oklchToOklab(color);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  return {
    r: clamp01(gammaEncode(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)),
    g: clamp01(gammaEncode(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)),
    b: clamp01(gammaEncode(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)),
  };
}

/** Composite `top` at `alpha` over `bottom`, in gamma-encoded sRGB like browsers do. */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

/** WCAG 2 relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * gammaDecode(r) + 0.7152 * gammaDecode(g) + 0.0722 * gammaDecode(b);
}

/** WCAG 2 contrast ratio between two opaque colors (1–21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Interpolate two colors in OKLab (perceptually even), t in 0–1. */
export function mixOklab(from: Oklch, to: Oklch, t: number): Oklch {
  const a = oklchToOklab(from);
  const b = oklchToOklab(to);
  return oklabToOklch({ l: a.l + (b.l - a.l) * t, a: a.a + (b.a - a.a) * t, b: a.b + (b.b - a.b) * t });
}

/** Mean of hue angles on the circle (so 350° and 10° average to 0°, not 180°). */
export function circularMeanHue(hues: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const h of hues) {
    x += Math.cos(h * DEG);
    y += Math.sin(h * DEG);
  }
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Gamma-encoded sRGB → OKLCH. */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const R = gammaDecode(r);
  const G = gammaDecode(g);
  const B = gammaDecode(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return oklabToOklch({
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  });
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored). */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let digits = m[1]!;
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const n = Number.parseInt(digits.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

/** CSS `oklch()` string. */
export function cssOklch({ l, c, h }: Oklch, alpha?: number): string {
  const base = `${round(l, 4)} ${round(c, 4)} ${round(h, 2)}`;
  return alpha === undefined || alpha >= 1 ? `oklch(${base})` : `oklch(${base} / ${round(alpha, 3)})`;
}
