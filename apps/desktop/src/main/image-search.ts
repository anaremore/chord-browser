/**
 * Searching by an image pasted into the command bar (DESIGN.md §7.3): the
 * image goes to the engine as Chrome sends it, a form upload of a small JPEG
 * (Chromium's prepopulated engine definitions): to Google Lens as
 * `encoded_image` with its sizes, to Bing's Visual Search base64-encoded as
 * `imageBin`. The tab loads the upload itself, so the results are its first
 * page, and Back doesn't send the image again. Nothing is sent before you
 * choose the row.
 */
import { randomBytes } from 'node:crypto';
import type { ImageSearchEngine } from '@chord/core';

interface Endpoint {
  /** Where the upload goes. */
  url: string;
  /** What the tab is opened on while the upload loads. */
  home: string;
}

const ENDPOINTS: Record<ImageSearchEngine, Endpoint> = {
  google: { url: 'https://lens.google.com/v3/upload', home: 'https://lens.google.com/' },
  bing: { url: 'https://www.bing.com/images/detail/search?iss=sbiupload&FORM=CHROMI#enterInsights', home: 'https://www.bing.com/images' },
};

/** The image, as the command bar made it: a JPEG at most 1,000 px a side, and the original's size. */
export interface SearchImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/** A multipart/form-data body, as a browser's form upload makes one. */
export function multipart(fields: (readonly [name: string, value: string] | readonly [name: string, file: { bytes: Uint8Array; filename: string; type: string }])[]): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----ChordFormBoundary${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of fields) {
    if (typeof value === 'string') {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.type}\r\n\r\n`));
      parts.push(Buffer.from(value.bytes));
      parts.push(Buffer.from('\r\n'));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * What to load for an image search: the engine's upload address and form.
 * `origin` (development builds and tests only) sends it to a local server.
 */
export function imageSearchRequest(engine: ImageSearchEngine, image: SearchImage, origin?: string): { url: string; home: string; body: Buffer; contentType: string } {
  const endpoint = ENDPOINTS[engine];
  const url = origin ? `${origin}/${engine}-upload` : endpoint.url;
  const home = origin ? `${origin}/${engine}-home` : endpoint.home;
  const form =
    engine === 'google'
      ? multipart([
          ['encoded_image', { bytes: image.bytes, filename: 'image.jpg', type: 'image/jpeg' }],
          ['image_url', ''],
          ['sbisrc', 'Chromium'],
          ['original_width', String(image.originalWidth)],
          ['original_height', String(image.originalHeight)],
          ['processed_image_dimensions', `${image.width},${image.height}`],
        ])
      : multipart([['imageBin', Buffer.from(image.bytes).toString('base64')]]);
  return { url, home, ...form };
}
