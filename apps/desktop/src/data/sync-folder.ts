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
 * folder, so the worker started in its place is the only one writing. Checked
 * right before every call that changes the folder (`live`), not only when an
 * operation starts: one already under way stops at its next.
 */
let abandoned = false;
export const abandonFolder = (): void => {
  abandoned = true;
};
const live = (): void => {
  if (abandoned) throw new Abandoned();
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

  /** A file written whole; one the call couldn't finish (a short write, a flush that failed) is removed in the same call, never left half made. */
  async create(path: string, bytes: Uint8Array, exclusive = false): Promise<void> {
    const target = await this.writable(path);
    // A temp name no reader takes for a segment (NNNNNN.chordlog only), then renamed: never seen half made. The folder's
    // file is made in place (`exclusive`: never over another), and only ever by this call.
    const made = exclusive ? target : `${target}.tmp-${randomBytes(4).toString('hex')}`;
    live();
    const handle = await open(made, exclusive ? 'wx' : 'w');
    try {
      try {
        live();
        await writeAll(handle, bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(made, { force: true }).catch(() => undefined);
      throw error;
    }
    if (exclusive) return;
    live();
    await rename(made, target);
  }

  /** The bytes at the end, flushed; a write the disk took only part of throws (`ShortWrite`), and the caller cuts it back. */
  async append(path: string, bytes: Uint8Array): Promise<void> {
    const target = await this.writable(path);
    live();
    const handle = await open(target, 'a');
    try {
      live();
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async cutBack(path: string, at: number, expect: Uint8Array): Promise<boolean> {
    const target = await this.writable(path);
    live();
    const handle = await open(target, 'r+');
    try {
      // On the open file, just before the cut: exactly its own bytes past `at`, or nothing is cut.
      if ((await handle.stat()).size !== at + expect.length) return false;
      const buffer = Buffer.alloc(expect.length);
      const { bytesRead } = await handle.read(buffer, 0, expect.length, at);
      if (bytesRead !== expect.length || !buffer.equals(Buffer.from(expect.buffer, expect.byteOffset, expect.byteLength))) return false;
      live();
      await handle.truncate(at);
      await handle.sync();
      return true;
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.writable(from);
    const target = await this.writable(to);
    live();
    await rename(source, target);
  }

  async mkdir(path: string): Promise<void> {
    // `Chord sync` itself is made only where nothing is: a link someone put there is never written through.
    if ((await lstat(this.root).catch(() => null))?.isSymbolicLink()) throw new Error('Sync won’t write through a link');
    live();
    await mkdir(this.full(path), { recursive: true });
    if (path) await this.writable(`${path}/.`);
  }

  async remove(path: string): Promise<void> {
    // rm never follows a link it removes, but the folder it's in must be the sync folder's own.
    const target = await this.writable(path);
    live();
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
}
