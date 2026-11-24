/**
 * An outside agent's card body (S18; mocks/agents-s18-m1.html §1): "✳ <title>"
 * with its ×, a note, what it may do, and its buttons. Shared by the agents'
 * cards (the connect card now; M2's site and step cards next), whatever frame
 * holds them.
 */
import { durations } from '@chord/tokens';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './AgentCard.module.css';

export interface AgentCardAction {
  label: string;
  /** link: a quiet word (Deny); quiet: an outlined pill (Allow once); primary: the filled one (Always allow); danger: filled, for paying or deleting. */
  look: 'link' | 'quiet' | 'primary' | 'danger';
  /** Set apart on the left (a step card's Show me). */
  left?: boolean;
  onClick(): void;
}

/**
 * The card's body. Buttons ignore clicks for a moment after it appears, as Chord's prompts over a page do, so
 * a click meant for the page can't answer it.
 */
export function AgentCardBody({ title, note, list, actions, onClose, closeLabel }: { title: string; note?: ReactNode; list?: readonly string[]; actions: readonly AgentCardAction[]; onClose(): void; closeLabel: string }) {
  const shownAt = useRef(Date.now());
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);
  const ready = (run: () => void) => () => {
    if (Date.now() - shownAt.current >= durations.promptInputDelay) run();
  };
  return (
    <>
      <div className={styles.head}>
        <span aria-hidden>✳</span>
        <p className={styles.title}>{title}</p>
        <button type="button" className={styles.close} aria-label={closeLabel} title={closeLabel} onClick={ready(onClose)}>
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {note && <p className={styles.note}>{note}</p>}
      {list && list.length > 0 && (
        <ul className={styles.list}>
          {list.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        {actions.map((a) => (
          <button key={a.label} type="button" className={a.left ? `${styles[a.look]} ${styles.left}` : styles[a.look]} onClick={ready(a.onClick)}>
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}
