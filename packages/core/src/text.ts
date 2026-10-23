import type { Download } from './model';
import { validTheme } from './restore';

/** Sizes the way file managers show them: "980 KB", "12.3 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One line under a download's name: progress and time left, or how it ended. */
export function describeDownload(d: Download): string {
  const size = d.total > 0 ? formatBytes(d.total) : '';
  switch (d.state) {
    case 'completed':
      return size ? `Done · ${size}` : 'Done';
    case 'cancelled':
      return 'Canceled';
    case 'interrupted':
      return 'Failed';
    case 'paused':
      return d.total > 0 ? `Paused · ${formatBytes(d.received)} of ${size}` : `Paused · ${formatBytes(d.received)}`;
    case 'progressing': {
      if (d.total <= 0) return formatBytes(d.received);
      const progress = `${formatBytes(d.received)} of ${size}`;
      if (d.speed <= 0) return progress;
      const seconds = Math.ceil((d.total - d.received) / d.speed);
      const left = seconds < 60 ? `${seconds} s left` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min left` : `${Math.ceil(seconds / 3600)} h left`;
      return `${progress} · ${left}`;
    }
  }
}

/**
 * The first character a person would see: an emoji with its skin tone,
 * joiners or variation selector counts as one. Letters are capitalized, so a
 * chord icon typed as "w" shows as "W".
 */
export function firstGrapheme(text: string): string {
  const first = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())][0]?.segment ?? '';
  return /^\p{L}$/u.test(first) ? first.toLocaleUpperCase() : first;
}

/**
 * A theme as text to share: plain JSON, readable in a chat message.
 * `{"chordTheme":1,"name":"Dusk","stops":[{"l":0.72,"c":0.12,"h":300}],"grain":0.2}`
 */
export function themeCode(theme: { name: string; stops: readonly { l: number; c: number; h: number }[]; grain: number }): string {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return JSON.stringify({ chordTheme: 1, name: theme.name, stops: theme.stops.map((s) => ({ l: round(s.l), c: round(s.c), h: round(s.h) })), grain: round(theme.grain) });
}

/** The theme in a pasted code (surrounding text is ignored), or null if there isn't a valid one. */
export function parseThemeCode(text: string): { name: string; stops: { l: number; c: number; h: number }[]; grain: number } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as { chordTheme?: unknown; name?: unknown; stops?: unknown; grain?: unknown };
    if (data.chordTheme !== 1) return null;
    const theme = validTheme({ id: 'imported', name: typeof data.name === 'string' ? data.name : 'Imported', stops: data.stops, grain: data.grain });
    return theme ? { name: theme.name, stops: theme.stops, grain: theme.grain } : null;
  } catch {
    return null;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a tab was last opened, for its hover preview (DESIGN.md §7.6): "Opened 2 h ago". */
export function openedAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'Opened just now';
  if (elapsed < HOUR) return `Opened ${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `Opened ${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return 'Opened yesterday';
  if (elapsed < 30 * DAY) return `Opened ${Math.floor(elapsed / DAY)} days ago`;
  return 'Opened over a month ago';
}
