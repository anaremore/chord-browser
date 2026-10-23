import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay } from '../../src/renderer/archive/days';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('archive days', () => {
  const now = at(2026, 10, 22, 9);

  it('names recent days in words', () => {
    expect(dayLabel(at(2026, 10, 22, 1), now, 'en-US')).toBe('Today');
    expect(dayLabel(at(2026, 10, 21, 23), now, 'en-US')).toBe('Yesterday');
    expect(dayLabel(at(2026, 10, 19), now, 'en-US')).toBe('Monday');
    expect(dayLabel(at(2026, 10, 1), now, 'en-US')).toBe('October 1');
    expect(dayLabel(at(2025, 12, 31), now, 'en-US')).toBe('December 31, 2025');
  });

  it('groups newest-first entries by local day', () => {
    const items = [at(2026, 10, 22, 8), at(2026, 10, 22, 1), at(2026, 10, 21, 22), at(2026, 10, 19)].map((archivedAt) => ({ archivedAt }));
    const groups = groupByDay(items, now, 'en-US');
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Monday', 1],
    ]);
  });
});
