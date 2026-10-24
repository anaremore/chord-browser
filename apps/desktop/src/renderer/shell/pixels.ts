/**
 * A captured bitmap's pixels, BGRA (Skia's N32 order on every desktop
 * platform Chromium builds for), as the RGBA an ImageData wants. Converted in
 * place when `bgra` has its memory to itself (as a picture that just arrived
 * over a port does).
 */
export function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const own = bgra.byteOffset === 0 && bgra.buffer.byteLength === bgra.length;
  const out = own ? bgra : new Uint8Array(bgra);
  // Four bytes at a time (little-endian): swap the first and third of each pixel.
  const pixels = new Uint32Array(out.buffer, 0, out.length >>> 2);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    pixels[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
  }
  return out;
}

/** RGBA bytes as an ImageData, sharing their memory. */
export function imageData(rgba: Uint8Array, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height);
}
