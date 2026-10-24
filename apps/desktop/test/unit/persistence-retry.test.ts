import type { DataResponse } from '@chord/data';
import { describe, expect, it, vi } from 'vitest';
import { withRetries } from '../../src/main/persistence';

const fail = (error: string): DataResponse => ({ id: 1, ok: false, error });
const ok: DataResponse = { id: 1, ok: true };

describe('opening the database again after a passing error', () => {
  it('tries again after a disk I/O error or a lock, and stops when it works', async () => {
    const attempt = vi.fn<() => Promise<DataResponse>>().mockResolvedValueOnce(fail('Error: disk I/O error')).mockResolvedValueOnce(fail('database is locked')).mockResolvedValue(ok);
    const sleep = vi.fn(() => Promise.resolve());
    expect(await withRetries(attempt, [250, 1000], sleep)).toBe(ok);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [1000]]);
  });

  it('gives up after the last wait, and never retries an error that won’t pass', async () => {
    const stuck = vi.fn(() => Promise.resolve(fail('disk I/O error')));
    expect((await withRetries(stuck, [1, 1], () => Promise.resolve())).ok).toBe(false);
    expect(stuck).toHaveBeenCalledTimes(3);

    const corrupt = vi.fn(() => Promise.resolve(fail('file is not a database')));
    expect((await withRetries(corrupt, [1, 1], () => Promise.resolve())).ok).toBe(false);
    expect(corrupt).toHaveBeenCalledTimes(1);
  });
});
