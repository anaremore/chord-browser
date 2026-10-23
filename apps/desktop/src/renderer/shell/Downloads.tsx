/**
 * The Downloads button (DESIGN.md §3.2 footer, §3.3 minimal bar): a ring
 * fills while files download, and a dot marks a finished download you
 * haven't looked at. It opens the downloads panel anchored to itself.
 */
import type { Download } from '@chord/core';
import { ArrowDownToLine } from 'lucide-react';
import type { MouseEvent } from 'react';
import { api } from './api';
import styles from './App.module.css';

const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export interface DownloadsSummary {
  active: number;
  /** 0–1 across active downloads of known size; null when no size is known. */
  progress: number | null;
  /** A download finished since the panel was last opened. */
  unseen: boolean;
}

/** `list`: the downloads this window shows (a private window lists only its own). */
export function summarizeDownloads(list: readonly Download[], seenAt: number): DownloadsSummary {
  const active = list.filter((d) => d.state === 'progressing' || d.state === 'paused');
  const sized = active.filter((d) => d.total > 0);
  const total = sized.reduce((sum, d) => sum + d.total, 0);
  return {
    active: active.length,
    progress: total > 0 ? sized.reduce((sum, d) => sum + d.received, 0) / total : null,
    unseen: list.some((d) => d.state === 'completed' && (d.endedAt ?? 0) > seenAt),
  };
}

export function DownloadsButton({ summary, onOpen }: { summary: DownloadsSummary; onOpen(): void }) {
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void api.overlay.open('downloads', { x: r.x, y: r.y, width: r.width, height: r.height });
    onOpen();
  };
  const label = summary.active > 0 ? `Downloads, ${summary.active} in progress` : summary.unseen ? 'Downloads, new' : 'Downloads';
  return (
    <button type="button" className={styles.downloadsButton} aria-label={label} title={label} onClick={open}>
      {summary.active > 0 && (
        <svg className={styles.downloadsRing} viewBox="0 0 28 28" aria-hidden>
          <circle className={styles.ringTrack} cx="14" cy="14" r={RING_RADIUS} />
          <circle
            className={styles.ringFill}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={summary.progress === null ? RING_LENGTH * 0.75 : RING_LENGTH * (1 - summary.progress)}
            data-indeterminate={summary.progress === null || undefined}
          />
        </svg>
      )}
      <ArrowDownToLine size={16} strokeWidth={1.75} />
      {summary.unseen && summary.active === 0 && <span className={styles.downloadsDot} aria-hidden />}
    </button>
  );
}
