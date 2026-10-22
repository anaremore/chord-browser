// Generates Chord's PLACEHOLDER app icon: a rounded square in the Dusk
// gradient (Lilac → Coral, DESIGN.md §5.1) with a white ✦. The real mark is
// still to be commissioned (DESIGN.md §2); replace build/icon.png when it is.
// electron-builder derives the .ico, .icns and Linux sizes from this one
// 1024 px PNG. Deterministic, so the asset only changes with this script.
// Usage: node scripts/generate-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, RGBA } from './png.mjs';

const SIZE = 1024;
/** Apple's icon grid: an 824 px body centered on the 1024 px canvas. */
const BODY = 824;
const RADIUS = 186;
/** The star's half-width as a fraction of the body. */
const STAR = 0.3;
/** Superellipse exponent for the star: below 1 the sides curve inward, like ✦. */
const STAR_EXPONENT = 0.58;
/** Samples per axis per pixel, for smooth edges. */
const SS = 4;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/build/icon.png');

// Swatches at display lightness (DESIGN.md §5.1; packages/tokens/src/theme.ts).
const lilac = { l: 0.72, c: 0.12, h: 300 };
const coral = { l: 0.72, c: 0.14, h: 30 };

/** OKLCH → OKLab, so the gradient is mixed in a perceptual space. */
const toLab = ({ l, c, h }) => ({ l, a: c * Math.cos((h * Math.PI) / 180), b: c * Math.sin((h * Math.PI) / 180) });

/** OKLab → linear sRGB (Björn Ottosson's matrices). */
function labToLinear({ l, a, b }) {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => Math.min(1, Math.max(0, v)));
}
const encode = (v) => Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255);

const from = toLab(lilac);
const to = toLab(coral);
// CSS `linear-gradient(160deg, …)`: mostly top → bottom, leaning right.
const angle = (160 * Math.PI) / 180;
const dir = { x: Math.sin(angle), y: -Math.cos(angle) };
const span = Math.abs(dir.x) + Math.abs(dir.y); // the gradient line's length over a unit square

/** Linear-light color of the body at a point in body space (0–1). */
function bodyColor(u, v) {
  const t = Math.min(1, Math.max(0, ((u - 0.5) * dir.x + (v - 0.5) * dir.y) / span + 0.5));
  const base = labToLinear({ l: from.l + (to.l - from.l) * t, a: from.a + (to.a - from.a) * t, b: from.b + (to.b - from.b) * t });
  // A soft glow toward the top left keeps it from reading flat.
  const glow = 0.16 * Math.max(0, 1 - Math.hypot(u - 0.28, v - 0.22) / 0.75) ** 2;
  return base.map((c) => c + (1 - c) * glow);
}

const half = BODY / 2;
const inBody = (x, y) => {
  // Rounded square, centered on the canvas.
  const qx = Math.max(Math.abs(x - SIZE / 2) - (half - RADIUS), 0);
  const qy = Math.max(Math.abs(y - SIZE / 2) - (half - RADIUS), 0);
  return qx * qx + qy * qy <= RADIUS * RADIUS;
};
const starRadius = BODY * STAR;
const inStar = (x, y) => {
  const u = Math.abs(x - SIZE / 2) / starRadius;
  const v = Math.abs(y - SIZE / 2) / starRadius;
  return u ** STAR_EXPONENT + v ** STAR_EXPONENT <= 1;
};

const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(stride * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * stride;
  for (let x = 0; x < SIZE; x++) {
    let body = 0;
    let star = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!inBody(px, py)) continue;
        body++;
        if (inStar(px, py)) star++;
      }
    }
    const i = row + 1 + x * 4;
    if (body === 0) continue; // transparent
    const coverage = body / (SS * SS);
    const starShare = star / body;
    const base = bodyColor((x + 0.5 - (SIZE - BODY) / 2) / BODY, (y + 0.5 - (SIZE - BODY) / 2) / BODY);
    const rgb = base.map((c) => c + (1 - c) * starShare); // white star over the gradient
    raw[i] = encode(rgb[0]);
    raw[i + 1] = encode(rgb[1]);
    raw[i + 2] = encode(rgb[2]);
    raw[i + 3] = Math.round(coverage * 255);
  }
}

// PNG "Sub" filter: smooth gradients compress far better as differences.
for (let y = 0; y < SIZE; y++) {
  const row = y * stride;
  raw[row] = 1;
  // Right to left, so each byte is diffed against its unfiltered left neighbor; the first pixel stays as is.
  for (let x = SIZE * 4; x > 4; x--) raw[row + x] = (raw[row + x] - raw[row + x - 4]) & 0xff;
}

const png = encodePng(SIZE, SIZE, RGBA, raw);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
