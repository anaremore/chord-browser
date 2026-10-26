import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { closestSize, MAX_ICON_SIDE, pixelsFrom, pngFromPixels, type Pixels } from '../src/browser/api/pixels'

/** A square of one RGBA color. */
const square = (side: number, rgba: [number, number, number, number]): Pixels => {
  const data = new Uint8Array(side * side * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width: side, height: side, data }
}

describe('icons an extension draws (action.setIcon imageData)', () => {
  it('makes a PNG of the pixels: its header, and the same pixels back out', () => {
    const pixels = square(3, [200, 40, 60, 128])
    const png = pngFromPixels(pixels)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(3)
    expect(png.readUInt32BE(20)).toBe(3)
    expect([png[24], png[25]]).toEqual([8, 6])
    // IDAT holds each row behind a filter byte of 0, then the row's RGBA as given.
    const idat = png.indexOf('IDAT')
    const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))
    expect(rows.length).toBe(3 * (3 * 4 + 1))
    for (let y = 0; y < 3; y++) {
      expect(rows[y * 13]).toBe(0)
      expect([...rows.subarray(y * 13 + 1, y * 13 + 5)]).toEqual([200, 40, 60, 128])
    }
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND')
  })

  /** As the renderer sends them: the bytes as base64. */
  const sent = (width: number, height: number, bytes: number) => ({ width, height, rgba: Buffer.alloc(bytes, 7).toString('base64') })

  it.each<[string, unknown, boolean]>([
    ['pixels whose sizes add up', sent(16, 16, 16 * 16 * 4), true],
    ['the biggest side allowed', sent(MAX_ICON_SIDE, 1, MAX_ICON_SIDE * 4), true],
    ['a side past it', sent(MAX_ICON_SIDE + 1, 1, (MAX_ICON_SIDE + 1) * 4), false],
    ['too few bytes', sent(2, 2, 15), false],
    ['too many bytes', sent(2, 2, 400), false],
    ['no size', sent(0, 0, 0), false],
    ['a fraction', { width: 1.5, height: 2, rgba: '' }, false],
    ['bytes that aren’t text', { width: 1, height: 1, data: new Uint8Array(4) }, false],
    ['a data URL', 'data:image/png;base64,AAAA', false],
    ['nothing', null, false],
  ])('takes %s as pixels: %s', (_name, value, expected) => {
    const pixels = pixelsFrom(value)
    expect(pixels !== null).toBe(expected)
    if (pixels) expect(pixels.data.length).toBe(pixels.width * pixels.height * 4)
  })

  it.each<[Record<string, string>, number, string | undefined]>([
    [{ 16: 'a', 32: 'b' }, 16, 'a'],
    [{ 16: 'a', 32: 'b' }, 20, 'b'],
    [{ 16: 'a', 32: 'b' }, 64, 'b'],
    [{ 32: 'b', 16: 'a', 19: 'c' }, 18, 'c'],
    [{ 38: 'x' }, 16, 'x'],
    [{}, 16, undefined],
    [{ big: 'z' }, 16, undefined],
  ])('picks from %o for %i px: %s', (set, size, expected) => {
    expect(closestSize(set, size)).toBe(expected)
  })
})
