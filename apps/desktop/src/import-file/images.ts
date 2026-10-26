/**
 * A Duet chat's images from a Chord file (docs/decisions/S15-your-data.md §5),
 * written by the import process beside Duet's own (main/duet/images.ts). A
 * file can say anything: an image record must really be the picture it says,
 * and its id must be no file's here. Each file is named to main before it's
 * written, so the import's Undo deletes exactly what it wrote.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DuetImage } from '@chord/core';
import { imageInfo } from '../main/duet/images';

const EXTENSIONS: Record<DuetImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** An image file an import may write, and so its Undo delete: a Duet image id's picture or thumbnail, a name, never a path. */
export const IMAGE_FILE = /^[0-9a-f]{24}\.(jpg|png|webp|thumb\.jpg)$/;

/** Every file an image id can have here: its picture, of any type, and its thumbnail. */
const filesOf = (id: string): string[] => [...Object.values(EXTENSIONS).map((ext) => `${id}.${ext}`), `${id}.thumb.jpg`];

/** What writing an image asks of main, and tells it. */
export interface ImageWriter {
  /** The files about to be written: main keeps them for Undo, then lets the write go on (never, once the import is stopped). */
  writing(files: string[]): Promise<void>;
  /** A file named was there by the time it was written: it isn't the import's. */
  unwritten(files: string[]): void;
}

/**
 * An image kept with Duet's if it's PNG, JPEG or WebP by its bytes, of the
 * type its record names, and no file of its id is here, of any type (its id,
 * checked by `imageFromRecord`, is the files' name); its thumbnail only if
 * that's really a JPEG. Returns the files it wrote: the picture, and the
 * thumbnail apart.
 */
export async function writeImage(record: { image: DuetImage; data: string; thumb: string | null }, dir: string, writer: ImageWriter): Promise<string[]> {
  const bytes = Buffer.from(record.data, 'base64');
  const info = imageInfo(bytes);
  if (!info || info.mime !== record.image.mime) return [];
  const id = record.image.id;
  if (filesOf(id).some((name) => existsSync(join(dir, name)))) return [];
  const thumb = record.thumb ? Buffer.from(record.thumb, 'base64') : null;
  const files: [string, Buffer][] = [[`${id}.${EXTENSIONS[info.mime]}`, bytes]];
  if (thumb && imageInfo(thumb)?.mime === 'image/jpeg') files.push([`${id}.thumb.jpg`, thumb]);
  await writer.writing(files.map(([name]) => name));
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [i, [name, data]] of files.entries()) {
    try {
      // Never over a file: one that's appeared since is someone else's, and so is the rest (a thumbnail without its picture is nothing).
      writeFileSync(join(dir, name), data, { flag: 'wx' });
      written.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      writer.unwritten(files.slice(i).map(([rest]) => rest));
      break;
    }
  }
  return written;
}
