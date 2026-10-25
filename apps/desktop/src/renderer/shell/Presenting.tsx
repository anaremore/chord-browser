/**
 * Presenting mode's indicator (DESIGN.md §7.13): while it's on, a card at the
 * bottom of the sidebar (above Now playing) and a chip in the minimal bar say
 * so, and turn it off. Main hides what the mode hides; these only show it.
 */
import type { Presenting } from '@chord/core';
import { durations, space } from '@chord/tokens';
import { Presentation, X } from 'lucide-react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { INSTANT } from '../shared/motion';
import { api } from './api';
import styles from './App.module.css';
import { keepFocusFrom } from './Toasts';

const HIDDEN = 'History, previews and notifications are hidden';

/** Off, as you asked: a share that's still going doesn't turn it back on. */
const turnOff = () => void api.state.dispatch({ t: 'presenting.set', on: false, by: 'you' });

function Card({ keys, enter }: { keys: string; enter: Transition }) {
  const card = useRef<HTMLDivElement>(null);
  // Leaving with the keyboard on Turn off, the card hands it to the sidebar's tabs rather than to nowhere.
  useLayoutEffect(() => {
    const el = card.current;
    return () => keepFocusFrom(el);
  }, []);
  const exit = enter === INSTANT ? INSTANT : { duration: durations.fadeFast / 1000 };
  return (
    <motion.div
      ref={card}
      role="group"
      aria-label="Presenting mode"
      className={styles.presenting}
      initial={{ opacity: 0, y: space[2] }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: space[1], transition: exit }}
      transition={enter}
    >
      <Presentation className={styles.presentingIcon} size={16} strokeWidth={1.75} aria-hidden />
      <div className={styles.presentingText}>
        <span className={styles.presentingTitle}>Presenting</span>
        <span className={`${styles.presentingDetail} ${styles.ellipsis}`} title={HIDDEN}>
          {HIDDEN}
        </span>
      </div>
      <button type="button" className={styles.presentingOff} title={`Turn off presenting mode  ${keys}`.trim()} onClick={turnOff}>
        Turn off
      </button>
    </motion.div>
  );
}

/** The sidebar's card, coming and going with the mode (Animate the sidebar, DESIGN.md §6.8). */
export function PresentingCard({ presenting, keys, enter }: { presenting: Presenting | null; keys: string; enter: Transition }) {
  return <AnimatePresence initial={false}>{presenting && <Card key="presenting" keys={keys} enter={enter} />}</AnimatePresence>;
}

/** The minimal bar's chip: the sidebar (and its card) is folded away. */
export function PresentingChip({ keys }: { keys: string }) {
  return (
    <button
      type="button"
      className={styles.presentingChip}
      aria-label="Turn off presenting mode"
      title={`Presenting: ${HIDDEN.toLowerCase()}. Click to turn it off  ${keys}`.trim()}
      onClick={turnOff}
    >
      <Presentation className={styles.presentingIcon} size={14} strokeWidth={2} aria-hidden />
      Presenting
      <X size={12} strokeWidth={2} aria-hidden />
    </button>
  );
}
