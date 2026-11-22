/** An ImageData's pixels as they arrive from the renderer: RGBA, 8 bits a channel, not premultiplied. */
export interface Pixels {
    width: number;
    height: number;
    data: Uint8Array;
}
/** Larger than any toolbar icon needs: a bigger one from an extension isn't drawn (or allocated). */
export declare const MAX_ICON_SIDE = 512;
/**
 * The pixels the renderer sent (`{ width, height, rgba }`, the bytes as base64), if their sizes add up
 * within MAX_ICON_SIDE; null for anything else an extension sends.
 */
export declare function pixelsFrom(value: unknown): Pixels | null;
/**
 * From a set by size (action.setIcon's `{ 16: …, 32: … }`), the one for
 * `size` pixels: the smallest at least that big, or else the biggest.
 */
export declare function closestSize<T>(set: Record<string, T>, size: number): T | undefined;
/** The pixels as a PNG: RGBA, 8 bits, no filter (what ImageData holds, so nothing is converted). */
export declare function pngFromPixels({ width, height, data }: Pixels): Buffer;
