// Chord, 2026-10-25: action icons an extension draws (action.setIcon's imageData). A Manifest V3 extension
// draws them in its service worker, which has no canvas to turn them into a data URL there, so the renderer
// sends the pixels (as base64, `{ width, height, rgba }`) and main makes a PNG of them here. No Electron
// imports, so it's unit-testable.
import { crc32, deflateSync } from 'node:zlib'

/** An ImageData's pixels as they arrive from the renderer: RGBA, 8 bits a channel, not premultiplied. */
export interface Pixels {
  width: number
  height: number
  data: Uint8Array
}

/** Larger than any toolbar icon needs: a bigger one from an extension isn't drawn (or allocated). */
export const MAX_ICON_SIDE = 512

/**
 * The pixels the renderer sent (`{ width, height, rgba }`, the bytes as base64), if their sizes add up
 * within MAX_ICON_SIDE; null for anything else an extension sends.
 */
export function pixelsFrom(value: unknown): Pixels | null {
  if (!value || typeof value !== 'object') return null
  const { width, height, rgba } = value as { width?: unknown; height?: unknown; rgba?: unknown }
  if (!Number.isInteger(width) || !Number.isInteger(height) || typeof rgba !== 'string') return null
  const w = width as number
  const h = height as number
  if (w <= 0 || h <= 0 || w > MAX_ICON_SIDE || h > MAX_ICON_SIDE || rgba.length > Math.ceil((w * h * 4) / 3) * 4 + 4) return null
  const data = new Uint8Array(Buffer.from(rgba, 'base64'))
  return data.length === w * h * 4 ? { width: w, height: h, data } : null
}

/**
 * From a set by size (action.setIcon's `{ 16: …, 32: … }`), the one for
 * `size` pixels: the smallest at least that big, or else the biggest.
 */
export function closestSize<T>(set: Record<string, T>, size: number): T | undefined {
  const sizes = Object.keys(set)
    .map(Number)
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b)
  if (sizes.length === 0) return undefined
  return set[String(sizes.find((s) => s >= size) ?? sizes.at(-1)!)]
}

/** The pixels as a PNG: RGBA, 8 bits, no filter (what ImageData holds, so nothing is converted). */
export function pngFromPixels({ width, height, data }: Pixels): Buffer {
  const stride = width * 4
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per channel
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
