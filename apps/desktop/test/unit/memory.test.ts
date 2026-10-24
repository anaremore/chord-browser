import { describe, expect, it } from 'vitest';
import { availableKb, memoryLow } from '../../src/main/memory';

const GB = 1024 * 1024;

describe('memory', () => {
  it('reads what each OS could hand out without swapping', () => {
    expect(availableKb({ total: 16 * GB, free: 1 * GB, available: 6 * GB }, 'linux')).toBe(6 * GB);
    expect(availableKb({ total: 16 * GB, free: 1 * GB, fileBacked: 3 * GB, purgeable: 1 * GB }, 'darwin')).toBe(5 * GB);
    expect(availableKb({ total: 16 * GB, free: 4 * GB }, 'win32')).toBe(4 * GB);
  });

  it('is low under a tenth of the memory, or under 2 GB on bigger machines', () => {
    expect(memoryLow({ total: 8 * GB, free: 0.7 * GB }, 'win32')).toBe(true);
    expect(memoryLow({ total: 8 * GB, free: 1 * GB }, 'win32')).toBe(false);
    expect(memoryLow({ total: 64 * GB, free: 3 * GB }, 'win32')).toBe(false);
    expect(memoryLow({ total: 64 * GB, free: 1.5 * GB }, 'win32')).toBe(true);
    // macOS's small "free" alone isn't low when its caches can be dropped.
    expect(memoryLow({ total: 16 * GB, free: 0.2 * GB, fileBacked: 4 * GB, purgeable: 0.5 * GB }, 'darwin')).toBe(false);
    expect(memoryLow({ total: 0, free: 0 }, 'linux')).toBe(false);
  });
});
