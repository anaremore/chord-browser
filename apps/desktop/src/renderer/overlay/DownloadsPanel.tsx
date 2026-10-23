/**
 * The downloads panel (DESIGN.md §7.1, DownloadsPopover): opened from the
 * Downloads button in the sidebar footer (or the minimal bar), anchored to
 * it, newest first. Clicking outside or Escape closes it.
 */
import { describeDownload, downloadsFor, type Download, type DownloadAction, type State } from '@chord/core';
import type { Rect } from '@chord/ipc';
import { File, FolderOpen, Pause, Play, RotateCcw, X } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
import { useEffect, type CSSProperties } from 'react';
import { api } from './api';
import styles from './CommandBar.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const EDGE = 8;

function Row({ download }: { download: Download }) {
  const run = (action: DownloadAction) => void api.downloads.run(download.id, action);
  const active = download.state === 'progressing' || download.state === 'paused';
  const failed = download.state === 'interrupted' || download.state === 'cancelled';
  const progress = download.total > 0 ? Math.min(1, download.received / download.total) : 0;
  return (
    <li className={styles.download} data-state={download.state}>
      <button
        type="button"
        className={styles.downloadMain}
        title={download.path || download.url}
        disabled={download.state !== 'completed'}
        onClick={() => run('open')}
      >
        <File className={styles.resultIcon} {...ICON} aria-hidden />
        <span className={styles.downloadText}>
          <span className={styles.downloadName}>{download.filename}</span>
          <span className={styles.downloadStatus}>{describeDownload(download)}</span>
          {active && (
            <span className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <span className={styles.progressFill} style={{ inlineSize: `${progress * 100}%` }} />
            </span>
          )}
        </span>
      </button>
      <span className={styles.downloadActions}>
        {download.state === 'progressing' && (
          <button type="button" className={styles.smallButton} aria-label={`Pause ${download.filename}`} onClick={() => run('pause')}>
            <Pause {...ICON} />
          </button>
        )}
        {download.state === 'paused' && (
          <button type="button" className={styles.smallButton} aria-label={`Resume ${download.filename}`} onClick={() => run('resume')}>
            <Play {...ICON} />
          </button>
        )}
        {failed && (
          <button type="button" className={styles.smallButton} aria-label={`Try ${download.filename} again`} onClick={() => run('retry')}>
            <RotateCcw {...ICON} />
          </button>
        )}
        {download.state === 'completed' && (
          <button type="button" className={styles.smallButton} aria-label={`Show ${download.filename} in folder`} onClick={() => run('show')}>
            <FolderOpen {...ICON} />
          </button>
        )}
        <button
          type="button"
          className={styles.smallButton}
          aria-label={active ? `Cancel ${download.filename}` : `Remove ${download.filename} from the list`}
          onClick={() => run(active ? 'cancel' : 'remove')}
        >
          <X {...ICON} />
        </button>
      </span>
    </li>
  );
}

export function DownloadsPanel({
  state,
  windowId,
  anchor,
  transition,
  onClose,
}: {
  state: State;
  windowId: string;
  anchor: Rect | null;
  transition: Transition;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A private window lists only its own downloads, and no other window lists them.
  const downloads = downloadsFor(state, windowId).sort((a, b) => b.startedAt - a.startedAt);
  const finished = downloads.some((d) => d.state !== 'progressing' && d.state !== 'paused');
  // Above the footer button in the sidebar; below the button in the minimal bar, kept on screen.
  const below = anchor ? anchor.y < window.innerHeight / 2 : true;
  let style: CSSProperties = { top: EDGE * 6, right: EDGE };
  if (anchor && below) {
    const top = anchor.y + anchor.height + EDGE;
    style = anchor.x > window.innerWidth / 2 ? { top, right: Math.max(EDGE, window.innerWidth - anchor.x - anchor.width) } : { top, left: Math.max(EDGE, anchor.x) };
  } else if (anchor) {
    style = { bottom: window.innerHeight - anchor.y + EDGE, left: Math.max(EDGE, anchor.x) };
  }

  return (
    <motion.div
      className={styles.downloadsPanel}
      style={style}
      initial={{ opacity: 0, y: below ? -4 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      role="dialog"
      aria-label="Downloads"
    >
      <header className={styles.downloadsHeader}>
        <span className={styles.downloadsTitle}>Downloads</span>
        <button type="button" className={styles.smallButton} aria-label="Open Downloads folder" title="Open Downloads folder" onClick={() => void api.downloads.openFolder()}>
          <FolderOpen {...ICON} />
        </button>
      </header>
      {downloads.length === 0 ? (
        <p className={styles.downloadsEmpty}>Nothing downloaded yet.</p>
      ) : (
        <ul className={styles.downloadList}>
          {downloads.map((d) => (
            <Row key={d.id} download={d} />
          ))}
        </ul>
      )}
      {finished && (
        <footer className={styles.downloadsFooter}>
          <button type="button" className={styles.textButton} onClick={() => void api.state.dispatch({ t: 'download.clear', windowId })}>
            Clear finished
          </button>
        </footer>
      )}
    </motion.div>
  );
}
