/**
 * The downloads panel (DESIGN.md §7.1, DownloadsPopover): opened from the
 * Downloads button in the sidebar footer (or the minimal bar), anchored to
 * it, newest first. Clicking outside or Escape closes it.
 */
import {
  ago,
  describeDownload,
  describeHeldDownload,
  downloadsFor,
  SAFE_BROWSING_ADVISORY,
  THREAT_LEARN_MORE,
  type Download,
  type DownloadAction,
  type State,
  type ThreatKind,
} from '@chord/core';
import type { Rect, ScreenshotItem } from '@chord/ipc';
import { Copy, Download as SaveIcon, File, FolderOpen, Pause, Play, RotateCcw, ShieldAlert, Trash2, X } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { DuetIcon } from '../shared/icons';
import { api } from './api';
import styles from './CommandBar.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const EDGE = 8;

/**
 * A download Safe Browsing suspects (ARCHITECTURE.md §14.5): paused, never
 * opened, until you delete it or keep it. Google's page about the threat and
 * its advisory open as tabs.
 */
function HeldRow({ download, threat, windowId, onClose }: { download: Download; threat: ThreatKind; windowId: string; onClose(): void }) {
  const run = (action: DownloadAction) => void api.downloads.run(download.id, action);
  const open = (url: string) => {
    void api.state.dispatch({ t: 'tab.open', windowId, url });
    onClose();
  };
  const nameId = useId();
  const statusId = useId();
  return (
    <li className={styles.download} data-state="held">
      <span className={styles.held} role="group" aria-labelledby={nameId} aria-describedby={statusId}>
        <ShieldAlert className={styles.heldIcon} {...ICON} aria-hidden />
        <span className={styles.downloadText}>
          <span id={nameId} className={styles.downloadName} title={download.url}>
            {download.filename}
          </span>
          <span id={statusId} className={styles.heldStatus}>
            {describeHeldDownload(threat)}
          </span>
          <span className={styles.heldActions}>
            <button type="button" className={styles.heldDelete} onClick={() => run('discard')}>
              Delete
            </button>
            <button type="button" className={styles.textButton} onClick={() => run('keep')}>
              Keep anyway
            </button>
          </span>
          <span className={styles.heldLinks}>
            <button type="button" className={styles.heldLink} onClick={() => open(THREAT_LEARN_MORE[threat].url)}>
              {THREAT_LEARN_MORE[threat].label}
            </button>
            <button type="button" className={styles.heldLink} onClick={() => open(SAFE_BROWSING_ADVISORY.url)}>
              {SAFE_BROWSING_ADVISORY.label}
            </button>
          </span>
        </span>
      </span>
    </li>
  );
}

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

/** One of the recent screenshots (DESIGN.md §7.12): its picture, its page, when and how big; Copy, Save, Delete. */
/** `onAsk`: it went to Duet's composer, so the panel steps aside for Duet's. */
function ShotRow({ shot, onChange, onAsk }: { shot: ScreenshotItem; onChange(): void; onAsk(): void }) {
  const name = shot.title || shot.url || 'Screenshot';
  const act = (action: 'copy' | 'save' | 'delete' | 'duet') => void api.screenshots.act(shot.id, action).then(() => action === 'delete' && onChange());
  return (
    <li className={styles.download}>
      <div className={styles.downloadMain}>
        {shot.thumb ? <img className={styles.shotThumb} src={shot.thumb} alt="" /> : <span className={styles.shotThumb} />}
        <span className={styles.downloadText}>
          <span className={styles.downloadName}>{name}</span>
          <span className={styles.downloadStatus}>
            {ago(shot.createdAt, Date.now())} · {shot.width} × {shot.height}
          </span>
        </span>
      </div>
      <div className={styles.downloadActions}>
        {/* Only where Duet may see that page, in this window's chord. */}
        {shot.duet && (
          <button
            type="button"
            className={styles.smallButton}
            aria-label={`Ask Duet about the screenshot of ${name}`}
            title="Ask Duet"
            onClick={() => {
              act('duet');
              onAsk();
            }}
          >
            <DuetIcon {...ICON} />
          </button>
        )}
        <button type="button" className={styles.smallButton} aria-label={`Copy screenshot of ${name}`} title="Copy" onClick={() => act('copy')}>
          <Copy {...ICON} />
        </button>
        <button type="button" className={styles.smallButton} aria-label={`Save screenshot of ${name}`} title="Save to Downloads" onClick={() => act('save')}>
          <SaveIcon {...ICON} />
        </button>
        <button type="button" className={styles.smallButton} aria-label={`Delete screenshot of ${name}`} title="Delete" onClick={() => act('delete')}>
          <Trash2 {...ICON} />
        </button>
      </div>
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
  /** `dismissed`: Esc, so the keyboard goes back to the button that opened it. */
  onClose(dismissed?: boolean): void;
}) {
  // Opened, the panel has the keyboard: screen readers hear its name, and Tab goes through it.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The window's recent screenshots (a private window's own), when Chord keeps them.
  const [shots, setShots] = useState<ScreenshotItem[]>([]);
  const loadShots = useCallback(() => void api.screenshots.list().then(setShots, () => setShots([])), []);
  useEffect(loadShots, [loadShots]);

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
      ref={panel}
      className={styles.downloadsPanel}
      style={style}
      initial={{ opacity: 0, y: below ? -4 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      role="dialog"
      aria-modal="true"
      aria-label="Downloads"
      tabIndex={-1}
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
          {downloads.map((d) => (d.threat ? <HeldRow key={d.id} download={d} threat={d.threat} windowId={windowId} onClose={() => onClose()} /> : <Row key={d.id} download={d} />))}
        </ul>
      )}
      {finished && (
        <footer className={styles.downloadsFooter}>
          <button type="button" className={styles.textButton} onClick={() => void api.state.dispatch({ t: 'download.clear', windowId })}>
            Clear finished
          </button>
        </footer>
      )}
      {shots.length > 0 && (
        <section aria-label="Screenshots" className={styles.shots}>
          <header className={styles.downloadsHeader}>
            <span className={styles.downloadsTitle}>Screenshots</span>
            <button type="button" className={styles.textButton} onClick={() => void api.screenshots.clear().then(loadShots)}>
              Clear
            </button>
          </header>
          <ul className={styles.downloadList}>
            {shots.map((shot) => (
              <ShotRow key={shot.id} shot={shot} onChange={loadShots} onAsk={() => onClose()} />
            ))}
          </ul>
        </section>
      )}
    </motion.div>
  );
}
