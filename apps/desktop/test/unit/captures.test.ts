import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureStore } from '../../src/main/captures';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-captures-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const picture = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill);
const A = '0193f5e2-0000-7000-8000-00000000000a';
const B = '0193f5e2-0000-7000-8000-00000000000b';
const C = '0193f5e2-0000-7000-8000-00000000000c';

describe('CaptureStore', () => {
  it('saves a picture per tab and reads it back, replacing the last one', async () => {
    const store = new CaptureStore(dir);
    await store.open(new Set());
    await store.put(A, picture(10, 1));
    await store.put(A, picture(12, 2));
    expect(store.has(A)).toBe(true);
    expect((await store.read(A))?.equals(picture(12, 2))).toBe(true);
    expect(readdirSync(dir)).toEqual([`${A}.jpg`]);
  });

  it('keeps under its budget by dropping the oldest pictures, never the one just taken', async () => {
    const store = new CaptureStore(dir, 25);
    await store.open(new Set());
    await store.put(A, picture(10), 1);
    await store.put(B, picture(10), 2);
    await store.put(C, picture(10), 3);
    expect(store.ids).toEqual([B, C]);
    expect(store.bytes).toBe(20);
    expect(existsSync(join(dir, `${A}.jpg`))).toBe(false);

    // A picture bigger than the whole budget still stays: it's the newest.
    await store.put(A, picture(40), 4);
    expect(store.ids).toEqual([A]);
  });

  it('on opening, forgets tabs that aren’t pinned any more and stray files', async () => {
    writeFileSync(join(dir, `${A}.jpg`), picture(5));
    writeFileSync(join(dir, `${B}.jpg`), picture(5));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, `${C}.jpg.1234.tmp`), picture(5));
    const store = new CaptureStore(dir);
    await store.open(new Set([A]));
    expect(store.ids).toEqual([A]);
    expect(readdirSync(dir)).toEqual([`${A}.jpg`]);
  });

  it('removes one picture, or all of them', async () => {
    const store = new CaptureStore(dir);
    await store.open(new Set());
    await store.put(A, picture(5));
    await store.put(B, picture(5));
    await store.remove(A);
    expect(store.ids).toEqual([B]);
    await store.clear();
    expect(store.ids).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(await store.read(B)).toBeNull();
  });

  it('never turns an unexpected id into a path', async () => {
    const store = new CaptureStore(dir);
    await store.open(new Set());
    await store.put('../escape', picture(5));
    await store.put('', picture(5));
    expect(store.ids).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
