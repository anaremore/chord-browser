/**
 * Images in Duet's chats, kept with them: `<userData>/duet/images/<id>.jpg`
 * (or `.png`, `.webp`), and for one you gave Duet (a pasted image, a
 * screenshot) `<id>.thumb.jpg`, what the panel shows. One Codex made has no
 * thumbnail: the panel shows the image itself, from chord://shell/duet-image/
 * (`file`). Deleted with their chat, with the copy Codex saved of one it made.
 * Files, not database rows, as Chord keeps its other pictures (ARCHITECTURE.md §7).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { DuetImage } from '@chord/core';

const ID = /^[0-9a-f]{24}$/;

export const newImageId = (): string => randomBytes(12).toString('hex');

const EXTENSIONS: Record<DuetImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** An image's type and size from its first bytes (PNG, JPEG or WebP), without decoding it; null for anything else. */
export function imageInfo(bytes: Uint8Array): { mime: DuetImage['mime']; width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The first frame header (SOF0–SOF15, not DHT, JPG or DAC) has the size.
    for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    return null;
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * Whether a path Codex reported is one of its own saved images, so deleting
 * it with the chat touches nothing else: an absolute path to a picture file
 * in a `generated_images` folder.
 */
export function isCodexCopy(path: string, platform: NodeJS.Platform = process.platform): boolean {
  // On Windows, a path of this computer's (a drive), not one inside WSL ("/home/…").
  const here = platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) : isAbsolute(path);
  return here && /[\\/]generated_images[\\/]/.test(path) && /\.(png|jpe?g|webp)$/i.test(path) && !/[\\/]\.\.(?:[\\/]|$)/.test(path);
}

export class DuetImages {
  constructor(private readonly dir: string) {}

  /** `thumb`: for an image you gave Duet; one Codex made shows itself. */
  async save(image: DuetImage, bytes: Uint8Array, thumb?: Uint8Array): Promise<void> {
    if (!ID.test(image.id)) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${image.id}.${EXTENSIONS[image.mime]}`), bytes);
    if (thumb) await writeFile(join(this.dir, `${image.id}.thumb.jpg`), thumb);
  }

  /** What the model is sent, or what's copied and saved. */
  async read(image: DuetImage): Promise<Buffer | null> {
    return ID.test(image.id) ? readFile(join(this.dir, `${image.id}.${EXTENSIONS[image.mime]}`)).catch(() => null) : null;
  }

  /** What the panel shows. */
  async thumb(id: string): Promise<Buffer | null> {
    return ID.test(id) ? readFile(join(this.dir, `${id}.thumb.jpg`)).catch(() => null) : null;
  }

  /** The file for `chord://shell/duet-image/<id>.<ext>`, or null for any other name. */
  file(name: string): { path: string; mime: DuetImage['mime'] } | null {
    const match = /^([0-9a-f]{24})\.(jpg|png|webp)$/.exec(name);
    if (!match) return null;
    const mime = (Object.keys(EXTENSIONS) as DuetImage['mime'][]).find((m) => EXTENSIONS[m] === match[2])!;
    return { path: join(this.dir, name), mime };
  }

  /** `localCodex`: Codex runs on this computer (not in WSL), so the copy it saved is a path here. */
  async remove(images: readonly DuetImage[], localCodex = true): Promise<void> {
    await Promise.all(
      images
        .filter((i) => ID.test(i.id))
        .flatMap((i) => [
          rm(join(this.dir, `${i.id}.${EXTENSIONS[i.mime] ?? 'jpg'}`), { force: true }),
          rm(join(this.dir, `${i.id}.thumb.jpg`), { force: true }),
          ...(localCodex && i.codexCopy && isCodexCopy(i.codexCopy) ? [rm(i.codexCopy, { force: true })] : []),
        ]),
    ).catch(() => {});
  }
}
