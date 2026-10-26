/**
 * A Duet chat's images from a Chord file (docs/decisions/S15-your-data.md §5),
 * written by the import process beside Duet's own (main/duet/images.ts). A
 * file can say anything: an image record must really be the picture it says.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DuetImage } from '@chord/core';
import { imageInfo } from '../main/duet/images';

const EXTENSIONS: Record<DuetImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * An image kept with Duet's if it's PNG, JPEG or WebP by its bytes, of the
 * type its record names, and isn't here already (its id, checked by
 * `imageFromRecord`, is the file's name); its thumbnail only if that's really
 * a JPEG. Returns the image when it wrote one, for the import's Undo.
 */
export function writeImage(record: { image: DuetImage; data: string; thumb: string | null }, dir: string): DuetImage | null {
  const bytes = Buffer.from(record.data, 'base64');
  const info = imageInfo(bytes);
  if (!info || info.mime !== record.image.mime) return null;
  const file = join(dir, `${record.image.id}.${EXTENSIONS[info.mime]}`);
  if (existsSync(file)) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, bytes, { flag: 'wx' });
  const thumb = record.thumb ? Buffer.from(record.thumb, 'base64') : null;
  if (thumb && imageInfo(thumb)?.mime === 'image/jpeg') {
    try {
      writeFileSync(join(dir, `${record.image.id}.thumb.jpg`), thumb, { flag: 'wx' });
    } catch {
      // One is there already: it stays.
    }
  }
  return record.image;
}
