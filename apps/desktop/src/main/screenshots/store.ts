/**
 * The recent screenshots (DESIGN.md §7.12): files in `<userData>/Screenshots/`
 * (`<id>.png`; `<id>.jpg`, the thumbnail; `<id>.ask.jpg`, at most 1,568 px a
 * side, what Duet is sent) and an `index.json`, like hover
 * previews' pictures (captures.ts): files, not database rows. A private
 * window's live in memory only, and go with it. Both keep within
 * SCREENSHOT_HISTORY. Plain Node file APIs, so it's unit-tested.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCREENSHOT_HISTORY, screenshotsToForget, type ScreenshotEntry, type ScreenshotKind } from '@chord/core';

const ID = /^[0-9a-f]{24}$/;
const KINDS: readonly ScreenshotKind[] = ['element', 'area', 'visible', 'page'];

export const newShotId = (): string => randomBytes(12).toString('hex');

export interface ShotStore {
  /** Newest first. */
  list(): Promise<ScreenshotEntry[]>;
  add(entry: ScreenshotEntry, png: Buffer, thumb: Buffer, ask?: Buffer): Promise<void>;
  png(id: string): Promise<Buffer | null>;
  thumb(id: string): Promise<Buffer | null>;
  /** The picture Duet is sent (none for one kept before there was one). */
  ask(id: string): Promise<Buffer | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** What index.json may hold: anything else is dropped as it's read. */
function validEntry(value: unknown): value is ScreenshotEntry {
  const e = value as Partial<ScreenshotEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    ID.test(e.id) &&
    KINDS.includes(e.kind as ScreenshotKind) &&
    [e.createdAt, e.width, e.height, e.bytes].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    typeof e.title === 'string' &&
    typeof e.url === 'string'
  );
}

export class DiskShots implements ShotStore {
  private entries: ScreenshotEntry[] = [];
  /** Reading the index: everything waits for it, so a screenshot taken meanwhile isn't lost when it lands. */
  private opening: Promise<void> | null = null;
  /** Index writes one after another, so an older one never lands last. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly limits: { count: number; bytes: number } = SCREENSHOT_HISTORY,
  ) {}

  /** Read the index (once; every other call waits for it). */
  open(): Promise<void> {
    return (this.opening ??= this.load());
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const text = await readFile(join(this.dir, 'index.json'), 'utf8').catch(() => '[]');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = [];
    }
    this.entries = (Array.isArray(parsed) ? parsed.filter(validEntry) : []).sort((a, b) => b.createdAt - a.createdAt);
  }

  async list(): Promise<ScreenshotEntry[]> {
    await this.open();
    return [...this.entries];
  }

  async add(entry: ScreenshotEntry, png: Buffer, thumb: Buffer, ask?: Buffer): Promise<void> {
    if (!ID.test(entry.id)) return;
    await this.open();
    await writeFile(join(this.dir, `${entry.id}.png`), png);
    await writeFile(join(this.dir, `${entry.id}.jpg`), thumb);
    if (ask) await writeFile(join(this.dir, `${entry.id}.ask.jpg`), ask);
    this.entries = [entry, ...this.entries.filter((e) => e.id !== entry.id)];
    const forget = new Set(screenshotsToForget(this.entries, this.limits));
    this.entries = this.entries.filter((e) => !forget.has(e.id));
    await Promise.all([...forget].map((id) => this.deleteFiles(id)));
    await this.saveIndex();
  }

  async png(id: string): Promise<Buffer | null> {
    await this.open();
    return this.has(id) ? readFile(join(this.dir, `${id}.png`)).catch(() => null) : null;
  }

  async thumb(id: string): Promise<Buffer | null> {
    await this.open();
    return this.has(id) ? readFile(join(this.dir, `${id}.jpg`)).catch(() => null) : null;
  }

  async ask(id: string): Promise<Buffer | null> {
    await this.open();
    return this.has(id) ? readFile(join(this.dir, `${id}.ask.jpg`)).catch(() => null) : null;
  }

  async remove(id: string): Promise<void> {
    await this.open();
    if (!this.has(id)) return;
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.deleteFiles(id);
    await this.saveIndex();
  }

  async clear(): Promise<void> {
    await this.open();
    const ids = this.entries.map((e) => e.id);
    this.entries = [];
    await Promise.all(ids.map((id) => this.deleteFiles(id)));
    await this.saveIndex();
  }

  private has(id: string): boolean {
    return ID.test(id) && this.entries.some((e) => e.id === id);
  }

  private async deleteFiles(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await Promise.all([`${id}.png`, `${id}.jpg`, `${id}.ask.jpg`].map((name) => rm(join(this.dir, name), { force: true }))).catch(() => {});
  }

  private saveIndex(): Promise<void> {
    const text = JSON.stringify(this.entries);
    this.writing = this.writing.then(async () => {
      const temp = join(this.dir, `index.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(temp, text);
      await rename(temp, join(this.dir, 'index.json'));
    }).catch(() => {});
    return this.writing;
  }
}

/** A private window's: in memory, never on disk, gone when the window closes. */
export class MemoryShots implements ShotStore {
  private readonly items = new Map<string, { entry: ScreenshotEntry; png: Buffer; thumb: Buffer; ask?: Buffer }>();

  constructor(private readonly limits: { count: number; bytes: number } = SCREENSHOT_HISTORY) {}

  async list(): Promise<ScreenshotEntry[]> {
    return this.entries();
  }

  async add(entry: ScreenshotEntry, png: Buffer, thumb: Buffer, ask?: Buffer): Promise<void> {
    this.items.set(entry.id, { entry, png, thumb, ...(ask ? { ask } : {}) });
    for (const id of screenshotsToForget(this.entries(), this.limits)) this.items.delete(id);
  }

  private entries(): ScreenshotEntry[] {
    return [...this.items.values()].map((i) => i.entry).sort((a, b) => b.createdAt - a.createdAt);
  }

  async png(id: string): Promise<Buffer | null> {
    return this.items.get(id)?.png ?? null;
  }

  async thumb(id: string): Promise<Buffer | null> {
    return this.items.get(id)?.thumb ?? null;
  }

  async ask(id: string): Promise<Buffer | null> {
    return this.items.get(id)?.ask ?? null;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}
