/**
 * Images you give Duet (a pasted image, a screenshot), kept for their chat:
 * `<userData>/duet/images/<id>.jpg` (or `.png`), sent to the model with the
 * message, and `<id>.thumb.jpg`, shown in the panel. Deleted with their chat.
 * Files, not database rows, as Chord keeps its other pictures (ARCHITECTURE.md §7).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuetImage } from '@chord/core';

const ID = /^[0-9a-f]{24}$/;

export const newImageId = (): string => randomBytes(12).toString('hex');

const extension = (mime: DuetImage['mime']) => (mime === 'image/png' ? 'png' : 'jpg');

export class DuetImages {
  constructor(private readonly dir: string) {}

  async save(image: DuetImage, bytes: Uint8Array, thumb: Uint8Array): Promise<void> {
    if (!ID.test(image.id)) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${image.id}.${extension(image.mime)}`), bytes);
    await writeFile(join(this.dir, `${image.id}.thumb.jpg`), thumb);
  }

  /** What the model is sent. */
  async read(image: DuetImage): Promise<Buffer | null> {
    return ID.test(image.id) ? readFile(join(this.dir, `${image.id}.${extension(image.mime)}`)).catch(() => null) : null;
  }

  /** What the panel shows. */
  async thumb(id: string): Promise<Buffer | null> {
    return ID.test(id) ? readFile(join(this.dir, `${id}.thumb.jpg`)).catch(() => null) : null;
  }

  async remove(images: readonly DuetImage[]): Promise<void> {
    await Promise.all(
      images
        .filter((i) => ID.test(i.id))
        .flatMap((i) => [rm(join(this.dir, `${i.id}.${extension(i.mime)}`), { force: true }), rm(join(this.dir, `${i.id}.thumb.jpg`), { force: true })]),
    ).catch(() => {});
  }
}
