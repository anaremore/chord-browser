/**
 * An image pasted or dropped into the command bar (DESIGN.md §7.3), made
 * ready to search by: a JPEG at most 1,000 px a side on white (what Chrome
 * sends Google Lens; transparent PNGs don't turn black), and a small preview
 * as a data URL (the overlay's CSP allows `data:` images, not `blob:`). The
 * decoding happens off the page's main thread (createImageBitmap); nothing
 * leaves the overlay until a row is chosen.
 */

/** A pasted image, ready for the image rows. */
export interface PastedImage {
  preview: string;
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

const MAX_SIDE = 1000;
/** Bigger than this isn't a picture someone means to search by. */
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** The first image in a paste or a drop: a copied screenshot, or an image file. */
export function imageIn(data: DataTransfer | null): File | null {
  for (const item of data?.items ?? []) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

/** Ready to search by, or null for something that isn't a picture Chromium can decode. */
export async function prepareImage(blob: Blob): Promise<PastedImage | null> {
  if (!blob.type.startsWith('image/') || blob.size > MAX_INPUT_BYTES) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const { width: originalWidth, height: originalHeight } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(jpeg);
  });
  return { preview, bytes, width, height, originalWidth, originalHeight };
}
