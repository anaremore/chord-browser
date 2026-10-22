// Generates the grain tile used under chord tints (DESIGN.md §5.2).
// Soft fractal value-noise (not per-pixel static), low contrast, tiling
// seamlessly. Deterministic, so the asset only changes with this script.
// Usage: node scripts/generate-grain.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
/** Peak deviation from mid-gray, 0–0.5. Low on purpose: grain should feel like paper. */
const AMPLITUDE = 0.16;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/tokens/assets/grain.png');

let seed = 0x5eed;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A periodic lattice of random values, smoothly interpolated (so the tile wraps). */
function valueNoise(period) {
  const lattice = Array.from({ length: period * period }, () => random());
  const at = (x, y) => lattice[((y % period) + period) % period * period + (((x % period) + period) % period)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const scale = period / SIZE;
  return (px, py) => {
    const x = px * scale;
    const y = py * scale;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const sx = smooth(x - x0);
    const sy = smooth(y - y0);
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}

// Octaves from fine to finer: mostly 2–4 px features, a touch of 1 px sparkle.
const octaves = [
  { noise: valueNoise(128), weight: 0.55 },
  { noise: valueNoise(64), weight: 0.3 },
  { noise: valueNoise(256), weight: 0.15 },
];

const raw = Buffer.alloc((SIZE * 2 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 2 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let n = 0;
    for (const o of octaves) n += o.noise(x, y) * o.weight;
    const v = 0.5 + (n - 0.5) * 2 * AMPLITUDE;
    raw[row + 1 + x * 2] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    raw[row + 2 + x * 2] = 255; // alpha
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 4; // grayscale + alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
