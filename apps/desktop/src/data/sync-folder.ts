/**
 * Sync's folder on the disk (core's `SyncFs`), for its worker thread
 * (sync-worker.ts): each new file made under a temp name and renamed into
 * place, appends flushed, reads only of regular files, and no write that
 * resolves outside `Chord sync`, nor any write at all when `Chord sync`
 * itself is a link or a junction.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { SyncFs } from '@chord/core';

/**
 * Set once chord-data has let this worker go (a file call that never returned
 * held it a minute): when that call does return, nothing more is done in the
 * folder, so the worker started in its place is the only one writing.
 */
let abandoned = false;
export const abandonFolder = (): void => {
  abandoned = true;
};

export class Abandoned extends Error {
  constructor() {
    super('Sync let this worker go');
    this.name = 'Abandoned';
  }
}

/** A write the disk took only part of (a full disk): never taken as done. */
export class ShortWrite extends Error {
  constructor(written: number, length: number) {
    super(`Only ${written} of ${length} bytes were written`);
    this.name = 'ShortWrite';
  }
}

/** Every byte of `bytes` through `handle`, or a ShortWrite. */
async function writeAll(handle: { write(buffer: Uint8Array): Promise<{ bytesWritten: number }> }, bytes: Uint8Array): Promise<void> {
  const { bytesWritten } = await handle.write(bytes);
  if (bytesWritten !== bytes.length) throw new ShortWrite(bytesWritten, bytes.length);
}

export class NodeFolder implements SyncFs {
  constructor(readonly root: string) {}

  private full(path: string): string {
    if (abandoned) throw new Abandoned();
    return path ? join(this.root, ...path.split('/')) : this.root;
  }

  async list(path: string): Promise<string[] | null> {
    try {
      return await readdir(this.full(path));
    } catch {
      return null;
    }
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    try {
      const s = await stat(this.full(path));
      return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  async read(path: string, position: number, length: number): Promise<Uint8Array> {
    // Only a file: anything else a folder can hold under a segment's name (a pipe, a device) could wait for ever.
    if (!(await stat(this.full(path)).catch(() => null))?.isFile()) return new Uint8Array(0);
    const handle = await open(this.full(path), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  /**
   * Where a write goes, checked: inside `Chord sync` once links are followed,
   * and never through a link at the file itself. A folder others can write to
   * could hold a link planted to send Chord's writes elsewhere on this disk.
   */
  private async writable(path: string): Promise<string> {
    const target = this.full(path);
    // `Chord sync` itself a link (or, on Windows, a junction): realpath would follow it wherever it points.
    const own = await lstat(this.root);
    if (own.isSymbolicLink() || !own.isDirectory()) throw new Error('Sync won’t write through a link');
    const root = await realpath(this.root);
    const folder = await realpath(dirname(target));
    if (folder !== root && !folder.startsWith(`${root}${sep}`)) throw new Error('Sync won’t write outside its folder');
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error('Sync won’t write through a link');
    return target;
  }

  async create(path: string, bytes: Uint8Array, exclusive = false): Promise<void> {
    const target = await this.writable(path);
    if (exclusive) {
      const handle = await open(target, 'wx');
      try {
        await writeAll(handle, bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    // A temp name no reader takes for a segment (NNNNNN.chordlog only), then renamed: never seen half made.
    const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    const handle = await open(temp, 'w');
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (abandoned) throw new Abandoned();
    await rename(temp, target);
  }

  /** The bytes at the end, flushed; a write the disk took only part of throws (`ShortWrite`), and the caller cuts it back. */
  async append(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(await this.writable(path), 'a');
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async truncate(path: string, size: number): Promise<void> {
    const handle = await open(await this.writable(path), 'r+');
    try {
      await handle.truncate(size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.writable(from);
    await rename(source, await this.writable(to));
  }

  async mkdir(path: string): Promise<void> {
    // `Chord sync` itself is made only where nothing is: a link someone put there is never written through.
    if ((await lstat(this.root).catch(() => null))?.isSymbolicLink()) throw new Error('Sync won’t write through a link');
    await mkdir(this.full(path), { recursive: true });
    if (path) await this.writable(`${path}/.`);
  }

  async remove(path: string): Promise<void> {
    // rm never follows a link it removes, but the folder it's in must be the sync folder's own.
    await rm(await this.writable(path), { recursive: true, force: true, maxRetries: 3 });
  }
}
