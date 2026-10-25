/**
 * Duet's chat images (main/duet/images.ts): an image's type and size read
 * from its header (Codex's never decoded in main), the names the panel may
 * load, and which of Codex's paths Chord may delete with a chat.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuetImages, imageInfo, isCodexCopy } from '../../src/main/duet/images';

/** Just enough of each format's header for its size. */
const PNG = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const JPEG = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00]);
const WEBP_VP8X = (w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

describe('imageInfo', () => {
  it.each([
    ['PNG', PNG(1024, 1536), { mime: 'image/png', width: 1024, height: 1536 }],
    ['JPEG (progressive, after an APP0)', JPEG(800, 600), { mime: 'image/jpeg', width: 800, height: 600 }],
    ['WebP (extended)', WEBP_VP8X(1536, 1024), { mime: 'image/webp', width: 1536, height: 1024 }],
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), null],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), null],
    ['nothing', Buffer.alloc(0), null],
  ])('%s', (_name, bytes, info) => {
    expect(imageInfo(bytes)).toEqual(info);
  });
});

describe('isCodexCopy: only a picture in a generated_images folder is deleted with a chat', () => {
  it.each([
    ['/home/me/.codex/generated_images/thr_1/ig_1.png', 'linux', true],
    ['C:\\Users\\me\\.codex\\generated_images\\thr_1\\ig_1.png', 'win32', true],
    // A path inside WSL means nothing on Windows.
    ['/home/me/.codex/generated_images/thr_1/ig_1.png', 'win32', false],
    ['/home/me/.codex/config.toml', 'linux', false],
    ['/home/me/.codex/generated_images/../auth.json', 'linux', false],
    ['/home/me/.codex/generated_images/../../photo.png', 'linux', false],
    ['generated_images/ig_1.png', 'linux', false],
    ['/home/me/Pictures/generated_images.png', 'linux', false],
  ] as const)('%s on %s → %s', (path, platform, allowed) => {
    expect(isCodexCopy(path, platform)).toBe(allowed);
  });
});

describe('DuetImages', () => {
  it('serves only its own names, and deletes an image with Codex’s copy of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chord-duet-images-'));
    const images = new DuetImages(join(dir, 'images'));
    const id = 'a'.repeat(24);
    expect(images.file(`${id}.png`)).toEqual({ path: join(dir, 'images', `${id}.png`), mime: 'image/png' });
    for (const name of [`${id}.gif`, `${id}.thumb.jpg`, `../${id}.png`, `${'g'.repeat(24)}.png`, 'index.json']) expect(images.file(name)).toBeNull();

    const codexCopy = join(dir, 'codex', 'generated_images', 'ig_1.png');
    mkdirSync(join(dir, 'codex', 'generated_images'), { recursive: true });
    writeFileSync(codexCopy, PNG(2, 2));
    const image = { id, mime: 'image/png' as const, width: 2, height: 2, codexCopy };
    await images.save(image, PNG(2, 2));
    expect(existsSync(join(dir, 'images', `${id}.png`))).toBe(true);
    expect(await images.thumb(id)).toBeNull();
    await images.remove([image]);
    expect(existsSync(join(dir, 'images', `${id}.png`))).toBe(false);
    expect(existsSync(codexCopy)).toBe(false);
  });
});
