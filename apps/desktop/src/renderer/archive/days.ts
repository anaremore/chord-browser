/** The archive page's day headings: Today, Yesterday, a weekday this week, then dates. */

const DAY_MS = 86_400_000;

/** Midnight (local time) at the start of the day `at` falls in. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local days between two moments (DST-safe: counts calendar days, not 24-hour spans). */
function daysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY_MS);
}

export function dayLabel(at: number, now: number, locale?: string): string {
  const ago = daysBetween(at, now);
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago < 7) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at);
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' }).format(at);
}

export interface DayGroup<T> {
  key: number;
  label: string;
  items: T[];
}

/** Items (newest first) in groups by the local day they were archived. */
export function groupByDay<T extends { archivedAt: number }>(items: readonly T[], now: number, locale?: string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = startOfDay(item.archivedAt);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(item.archivedAt, now, locale), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
