import type { Download } from './model';

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
