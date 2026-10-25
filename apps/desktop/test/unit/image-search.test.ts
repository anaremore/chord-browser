import { describe, expect, it } from 'vitest';
import { imageSearchRequest, multipart } from '../../src/main/image-search';

/** The fields of a multipart body, as a server reads them: text values, and files' bytes. */
function parse(body: Buffer, contentType: string): Record<string, { value: Buffer; filename?: string; type?: string }> {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
  const out: Record<string, { value: Buffer; filename?: string; type?: string }> = {};
  const text = body.toString('latin1');
  for (const part of text.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    const value = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
    const name = /name="([^"]+)"/.exec(head!)![1]!;
    out[name] = { value, filename: /filename="([^"]+)"/.exec(head!)?.[1], type: /Content-Type: (.+)/.exec(head!)?.[1] };
  }
  expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  return out;
}

const image = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9]), width: 640, height: 400, originalWidth: 2560, originalHeight: 1600 };

describe('image search', () => {
  it('sends Google Lens the JPEG as encoded_image, with its sizes, as Chrome does', () => {
    const request = imageSearchRequest('google', image);
    expect(request.url).toBe('https://lens.google.com/v3/upload');
    const fields = parse(request.body, request.contentType);
    expect(fields['encoded_image']).toMatchObject({ filename: 'image.jpg', type: 'image/jpeg' });
    // Bytes that look like the form's own line breaks and dashes come through untouched.
    expect([...fields['encoded_image']!.value]).toEqual([...image.bytes]);
    expect(fields['original_width']!.value.toString()).toBe('2560');
    expect(fields['processed_image_dimensions']!.value.toString()).toBe('640,400');
  });

  it('sends Bing the JPEG base64-encoded as imageBin', () => {
    const request = imageSearchRequest('bing', image);
    expect(request.url).toMatch(/^https:\/\/www\.bing\.com\/images\/detail\/search\?iss=sbiupload/);
    const fields = parse(request.body, request.contentType);
    expect(Buffer.from(fields['imageBin']!.value.toString(), 'base64')).toEqual(Buffer.from(image.bytes));
  });

  it('goes to a local server in development builds, never anywhere else', () => {
    expect(imageSearchRequest('google', image, 'http://127.0.0.1:5555')).toMatchObject({ url: 'http://127.0.0.1:5555/google-upload', home: 'http://127.0.0.1:5555/google-home' });
  });

  it('gives each body a boundary of its own', () => {
    expect(multipart([['a', 'b']]).contentType).not.toBe(multipart([['a', 'b']]).contentType);
  });
});
