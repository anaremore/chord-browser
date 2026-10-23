/**
 * The pictures behind hover previews (DESIGN.md §7.6): one small JPEG per
 * pinned tab in `<userData>/Captures/`, named by the tab's node id. Files,
 * not database blobs (ARCHITECTURE.md §7). JPEG because Electron's
 * nativeImage can't encode WebP. Kept under a size budget: the oldest
 * pictures go first. Plain Node file APIs, so it's unit-tested.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** About 250 pinned tabs' worth at roughly 40 KB each, with room to spare. */
export const CAPTURE_BUDGET_BYTES = 16 * 1024 * 1024;

/** Node ids are UUIDs; anything else is never turned into a path. */
const ID = /^[0-9a-z][0-9a-z-]{0,63}$/i;
const FILE = /^([0-9a-z][0-9a-z-]{0,63})\.jpg$/i;

interface Entry {
  bytes: number;
  at: number;
}

export class CaptureStore {
  private readonly index = new Map<string, Entry>();

  constructor(
    private readonly dir: string,
    private readonly budget = CAPTURE_BUDGET_BYTES,
  ) {}

  /** Index what's on disk, deleting pictures of tabs not in `keep` (closed, archived, unpinned) and stray files. */
  async open(keep: ReadonlySet<string>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const id = FILE.exec(name)?.[1];
      const file = join(this.dir, name);
      if (!id || !keep.has(id)) {
        await rm(file, { force: true }).catch(() => {});
        continue;
      }
      const info = await stat(file).catch(() => null);
      if (info) this.index.set(id, { bytes: info.size, at: info.mtimeMs });
    }
    await this.enforceBudget();
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** The ids with a picture, oldest first. */
  get ids(): string[] {
    return [...this.index.entries()].sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
  }

  get bytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.bytes;
    return total;
  }

  /** Save a tab's newest picture (replacing its last one), then trim to the budget. */
  async put(id: string, jpeg: Buffer, at = Date.now()): Promise<void> {
    if (!ID.test(id) || jpeg.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const file = this.path(id);
    // Written aside, then renamed over: a reader never sees half a picture.
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, jpeg);
      await rename(temp, file);
    } catch {
      await rm(temp, { force: true }).catch(() => {});
      return;
    }
    this.index.set(id, { bytes: jpeg.length, at });
    await this.enforceBudget(id);
  }

  async read(id: string): Promise<Buffer | null> {
    if (!this.index.has(id)) return null;
    return readFile(this.path(id)).catch(() => null);
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    this.index.delete(id);
    await rm(this.path(id), { force: true }).catch(() => {});
  }

  /** Every picture goes (Settings → Privacy → Show page previews, off). */
  async clear(): Promise<void> {
    for (const id of [...this.index.keys()]) await this.remove(id);
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jpg`);
  }

  /** Oldest first until under budget; the picture just taken always stays. */
  private async enforceBudget(newest?: string): Promise<void> {
    let total = this.bytes;
    for (const id of this.ids) {
      if (total <= this.budget) break;
      if (id === newest) continue;
      total -= this.index.get(id)?.bytes ?? 0;
      await this.remove(id);
    }
  }
}
