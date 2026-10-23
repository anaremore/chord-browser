/** Chrome caps a single message from a native host at 1 MB. */
export declare const MAX_HOST_MESSAGE_BYTES: number;
/** One message for a native host: a 32-bit length in bytes (native byte order is little-endian on every platform Chrome supports), then UTF-8 JSON. */
export declare function encodeNativeMessage(json: unknown): Buffer;
/**
 * Reads a native host's stdout, which may split one message across chunks or
 * put several in one. Feed it chunks; it returns the whole messages so far.
 * Throws on a message bigger than Chrome allows, or one that isn't JSON.
 */
export declare class NativeMessageReader {
    private pending;
    push(chunk: Buffer): unknown[];
}
