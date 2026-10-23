/**
 * Peek's chrome (DESIGN.md §7.9, §8.5): a scrim over the window, and a card
 * whose 40 px header shows the site · **Open in Today** ⌘↵ · **Close** Esc.
 * Main puts Peek's page in the card below the header once it has grown in
 * from the click. A click on the scrim closes it, as Esc does.
 */
import type { PeekState, SystemInfo } from '@chord/ipc';
import { Globe, Lock, PanelTopOpen, X } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';
import { api } from './api';
import styles from './Peek.module.css';

export function PeekChrome({
  initial,
  info,
  transition,
  enter,
  onClose,
}: {
  initial: PeekState;
  info: SystemInfo;
  transition: Transition;
  enter: Transition;
  onClose: () => void;
}) {
  const [peek, setPeek] = useState(initial);
  useEffect(() => api.peek.onState(setPeek), []);

  // While the overlay has focus (before the page is in, or after a click on the header): the same keys the page has.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = info.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter' && command) {
        event.preventDefault();
        void api.peek.expand();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info.platform, onClose]);

  const { card, origin } = peek;
  const keys = info.platform === 'darwin' ? { open: '⌘↵', close: 'Esc' } : { open: 'Ctrl+Enter', close: 'Esc' };
  const secure = peek.url.startsWith('https:');
  const SiteIcon = secure ? Lock : Globe;
  // It grows from the click: the transform origin is the click point, inside the card's own box.
  const cardStyle: CSSProperties = {
    left: card.x,
    top: card.y,
    width: card.width,
    height: card.height,
    transformOrigin: origin ? `${origin.x - card.x}px ${origin.y - card.y}px` : 'center',
  };

  return (
    <>
      <motion.div className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={transition} onMouseDown={onClose} data-testid="peek-scrim" />
      <motion.div
        className={styles.card}
        style={cardStyle}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={enter}
        role="dialog"
        aria-label={`Peek: ${peek.host}`}
      >
        <div className={styles.header}>
          <SiteIcon className={styles.siteIcon} size={12} strokeWidth={2} aria-hidden />
          <span className={styles.host}>{peek.host}</span>
          {peek.title && <span className={styles.title}>{peek.title}</span>}
          <span className={styles.flex} />
          <button type="button" className={styles.action} onClick={() => void api.peek.expand()} title={`Open in Today (${keys.open})`}>
            <PanelTopOpen size={14} strokeWidth={1.75} aria-hidden />
            Open in Today
            <kbd className={styles.keycap}>{keys.open}</kbd>
          </button>
          <button type="button" className={styles.action} onClick={onClose} title={`Close (${keys.close})`}>
            <X size={14} strokeWidth={2} aria-hidden />
            <span className="sr-only">Close Peek</span>
            <kbd className={styles.keycap}>{keys.close}</kbd>
          </button>
        </div>
      </motion.div>
    </>
  );
}
