/**
 * The extensions list (DESIGN.md §3): opened from the puzzle piece in the
 * sidebar's shelf, the minimal bar or the title bar, anchored to it. Every
 * extension with a button is here, pinned or not: a click runs it (its popup
 * opens under the puzzle piece), and the pin decides whether it also gets a
 * button of its own. Clicking outside or Escape closes it.
 */
import type { ExtensionAction, ExtensionsBarState, Rect } from '@chord/ipc';
import { Pin, PinOff, Puzzle, Settings } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from './api';
import styles from './CommandBar.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const EDGE = 8;

const nameOf = (action: ExtensionAction) => action.title.split('\n')[0] || 'Extension';

export function ExtensionsPanel({ anchor, transition, onClose }: { anchor: Rect | null; transition: Transition; onClose(dismissed?: boolean): void }) {
  const [bar, setBar] = useState<ExtensionsBarState | null>(null);
  // Opened, the list has the keyboard: screen readers hear its name, and Tab goes through it.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);
  useEffect(() => {
    let live = true;
    void api.extensions.state().then((state) => live && setBar(state));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Above the button in the sidebar's shelf; below it in a top bar; kept on screen.
  const below = anchor ? anchor.y < window.innerHeight / 2 : true;
  let style: CSSProperties = { top: EDGE * 6, right: EDGE };
  if (anchor && below) {
    const top = anchor.y + anchor.height + EDGE;
    style = anchor.x > window.innerWidth / 2 ? { top, right: Math.max(EDGE, window.innerWidth - anchor.x - anchor.width) } : { top, left: Math.max(EDGE, anchor.x) };
  } else if (anchor) {
    style = { bottom: window.innerHeight - anchor.y + EDGE, left: Math.max(EDGE, anchor.x) };
  }

  const run = (action: ExtensionAction) => {
    onClose();
    if (anchor) void api.extensions.activate(action.id, anchor);
  };
  const setPinned = (action: ExtensionAction, pinned: boolean) =>
    void api.state.dispatch({ t: 'extension.pin', profileId: action.profileId, id: action.id, pinned });

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
      aria-label="Extensions"
      tabIndex={-1}
    >
      <header className={styles.downloadsHeader}>
        <span className={styles.downloadsTitle}>Extensions</span>
        <button
          type="button"
          className={styles.smallButton}
          aria-label="Manage extensions"
          title="Manage extensions"
          onClick={() => {
            onClose();
            void api.extensions.manage();
          }}
        >
          <Settings {...ICON} />
        </button>
      </header>
      {bar && bar.actions.length === 0 ? (
        <p className={styles.downloadsEmpty}>No extensions with a button.</p>
      ) : (
        <ul className={styles.downloadList} aria-label="Extensions">
          {(bar?.actions ?? []).map((action) => (
            <li key={action.id} className={styles.download}>
              <button type="button" className={styles.downloadMain} title={action.title} onClick={() => run(action)}>
                {action.icon ? <img className={styles.resultIcon} src={action.icon} alt="" width={16} height={16} draggable={false} /> : <Puzzle className={styles.resultIcon} {...ICON} aria-hidden />}
                <span className={styles.downloadText}>
                  <span className={styles.downloadName}>{nameOf(action)}</span>
                  {action.badgeText && <span className={styles.downloadStatus}>{action.badgeText}</span>}
                </span>
              </button>
              <span className={styles.downloadActions}>
                <button
                  type="button"
                  className={styles.smallButton}
                  aria-pressed={action.pinned}
                  aria-label={action.pinned ? `Unpin ${nameOf(action)}` : `Pin ${nameOf(action)}`}
                  title={action.pinned ? 'Unpin' : 'Pin'}
                  onClick={() => {
                    setPinned(action, !action.pinned);
                    setBar((b) => b && { ...b, actions: b.actions.map((a) => (a.id === action.id ? { ...a, pinned: !action.pinned } : a)) });
                  }}
                >
                  {action.pinned ? <Pin {...ICON} /> : <PinOff {...ICON} />}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}
