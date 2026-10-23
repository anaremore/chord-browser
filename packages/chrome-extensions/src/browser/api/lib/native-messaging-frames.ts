// Added by Chord contributors, 2026-10-22: native-messaging framing that handles split and joined
// messages and multi-byte text. See CHORD-CHANGES.md in this package.

/** Chrome caps a single message from a native host at 1 MB. */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024

/** One message for a native host: a 32-bit length in bytes (native byte order is little-endian on every platform Chrome supports), then UTF-8 JSON. */
export function encodeNativeMessage(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json), 'utf8')
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/**
 * Reads a native host's stdout, which may split one message across chunks or
 * put several in one. Feed it chunks; it returns the whole messages so far.
 * Throws on a message bigger than Chrome allows, or one that isn't JSON.
 */
export class NativeMessageReader {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const messages: unknown[] = []
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0)
      if (length > MAX_HOST_MESSAGE_BYTES) throw new Error(`Native message too large (${length} bytes)`)
      if (this.pending.length < 4 + length) break
      messages.push(JSON.parse(this.pending.subarray(4, 4 + length).toString('utf8')))
      this.pending = this.pending.subarray(4 + length)
    }
    return messages
  }
}
