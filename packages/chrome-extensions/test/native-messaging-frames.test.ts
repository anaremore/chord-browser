// Chord's tests for its native-messaging framing (src/browser/api/lib/native-messaging-frames.ts).
import { describe, expect, it } from 'vitest'
import { encodeNativeMessage, MAX_HOST_MESSAGE_BYTES, NativeMessageReader } from '../src/browser/api/lib/native-messaging-frames'

describe('native messaging frames', () => {
  it('sizes messages in bytes, so non-ASCII text survives', () => {
    const frame = encodeNativeMessage({ name: 'Zoë’s vault 🔐' })
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4)
    expect(new NativeMessageReader().push(frame)).toEqual([{ name: 'Zoë’s vault 🔐' }])
  })

  it('reassembles a message split across chunks, and reads several from one chunk', () => {
    const big = { items: Array.from({ length: 2000 }, (_, i) => `item ${i}`) }
    const frame = encodeNativeMessage(big)
    const reader = new NativeMessageReader()
    expect(reader.push(frame.subarray(0, 3))).toEqual([])
    expect(reader.push(frame.subarray(3, 5000))).toEqual([])
    expect(reader.push(frame.subarray(5000))).toEqual([big])
    expect(reader.push(Buffer.concat([encodeNativeMessage(1), encodeNativeMessage({ two: 2 })]))).toEqual([1, { two: 2 }])
  })

  it('refuses a message bigger than Chrome allows', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX_HOST_MESSAGE_BYTES + 1, 0)
    expect(() => new NativeMessageReader().push(header)).toThrow(/too large/)
  })
})
