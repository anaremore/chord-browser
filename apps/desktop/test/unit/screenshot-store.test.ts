import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScreenshotEntry } from '@chord/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DiskShots, MemoryShots, newShotId } from '../../src/main/screenshots/store';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chord-shots-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const shot = (createdAt: number, bytes = 4): ScreenshotEntry => ({ id: newShotId(), kind: 'area', createdAt, width: 10, height: 10, bytes, title: 'Page', url: 'https://example.com/' });

describe('DiskShots', () => {
  it('keeps the newest within the count, deleting the files of the ones it lets go, and remembers across opening again', async () => {
    const dir = tempDir();
    const store = new DiskShots(dir, { count: 2, bytes: 1000 });
    await store.open();
    const [a, b, c] = [shot(1), shot(2), shot(3)];
    for (const e of [a, b, c]) await store.add(e, Buffer.from('png' + e.id), Buffer.from('jpg'));
    expect((await store.list()).map((e) => e.id)).toEqual([c.id, b.id]);
    expect(existsSync(join(dir, `${a.id}.png`))).toBe(false);
    expect((await store.png(c.id))?.toString()).toBe('png' + c.id);

    const again = new DiskShots(dir, { count: 2, bytes: 1000 });
    await again.open();
    expect((await again.list()).map((e) => e.id)).toEqual([c.id, b.id]);
    await again.remove(b.id);
    expect((await again.list()).map((e) => e.id)).toEqual([c.id]);
    await again.clear();
    expect(await again.list()).toEqual([]);
    expect(readdirSync(dir).filter((f) => !f.startsWith('index'))).toEqual([]);
  });

  it('reads only what an index may hold, and never turns an id into a path it didn’t make', async () => {
    const dir = tempDir();
    const good = shot(5);
    writeFileSync(join(dir, 'index.json'), JSON.stringify([good, { ...good, id: '../../escape' }, { id: 'x' }, 'junk']));
    const store = new DiskShots(dir);
    await store.open();
    expect((await store.list()).map((e) => e.id)).toEqual([good.id]);
    expect(await store.png('../../escape')).toBeNull();
    writeFileSync(join(dir, 'index.json'), '{ not json');
    const broken = new DiskShots(dir);
    await broken.open();
    expect(await broken.list()).toEqual([]);
  });
});

describe('MemoryShots', () => {
  it('holds them in memory only, within the limits', async () => {
    const store = new MemoryShots({ count: 10, bytes: 8 });
    const [a, b, c] = [shot(1, 4), shot(2, 4), shot(3, 4)];
    for (const e of [a, b, c]) await store.add(e, Buffer.from('p'), Buffer.from('t'));
    expect((await store.list()).map((e) => e.id)).toEqual([c.id, b.id]);
    expect(await store.png(a.id)).toBeNull();
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});

describe('DiskShots, taken before its index is read', () => {
  it('keeps a screenshot added while the index is still loading', async () => {
    const dir = tempDir();
    const first = new DiskShots(dir);
    const kept = shot(1);
    await first.add(kept, Buffer.from('p'), Buffer.from('t'));
    // A new launch: one is taken at once, without anyone opening the store first.
    const store = new DiskShots(dir);
    const fresh = shot(2);
    await store.add(fresh, Buffer.from('p'), Buffer.from('t'));
    expect((await store.list()).map((e) => e.id)).toEqual([fresh.id, kept.id]);
  });
});
