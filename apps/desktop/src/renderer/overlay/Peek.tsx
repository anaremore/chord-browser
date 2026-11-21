/**
 * Peek's chrome (DESIGN.md §7.9, §8.5): a scrim over the window, and a card
 * whose 40 px header shows the site · **Open as tab** ⌘↵ · **Close** Esc.
 * Main puts Peek's page in the card below the header once it has grown in
 * from the click. A click on the scrim closes it, as Esc does.
 *
 * The card moves by its header's empty part and resizes from any edge or
 * corner, inside the window's page area; a double-click on the header puts it
 * back. The card follows the pointer here, once a frame, and main places the
 * page under it from the boxes sent (`peek:move`, latest wins).
 */
import { PEEK_CURSOR, PEEK_GRIP, peekGripAt, type PeekGrip, type PeekTarget } from '@chord/core';
import type { PeekState, SystemInfo } from '@chord/ipc';
import { Globe, Lock, PanelTopOpen, X } from 'lucide-react';
import { animate, motion, type Transition } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from './api';
import { CardMotion } from './peek-motion';
import styles from './Peek.module.css';

/** A press on the card's frame: what it landed on, for `peekGripAt`. */
function targetOf(event: { target: EventTarget }): PeekTarget {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('button, [data-peek-label]')) return 'control';
  return target?.closest('[data-peek-header]') ? 'header' : 'outside';
}

const G = PEEK_GRIP.outside;

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
  /** The card's entrance, and its way back to the center (`overlay`; instant with motion off). */
  enter: Transition;
  onClose: () => void;
}) {
  const [peek, setPeek] = useState(initial);
  // The card as React draws it: main's box, or where a gesture or glide left it.
  const [box, setBox] = useState(initial.card);
  const [cursor, setCursor] = useState('');
  const [lifted, setLifted] = useState(false);
  const latest = useRef(initial);
  latest.current = peek;
  const spring = useRef(enter);
  spring.current = enter;
  const frameEl = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  /** What the last press took hold of: a double-click's target is the frame holding the pointer, not the header. */
  const pressed = useRef<PeekGrip | null>(null);

  // While the card moves it's drawn straight into the DOM each frame, and React gets the box once it ends
  // (rendering the chrome every frame cost more than the move itself).
  const card = useMemo(
    () =>
      new CardMotion(initial.card, {
        draw: (b) => {
          const f = frameEl.current?.style;
          const c = cardEl.current?.style;
          if (!f || !c) return;
          f.left = `${b.x - G}px`;
          f.top = `${b.y - G}px`;
          f.width = `${b.width + 2 * G}px`;
          f.height = `${b.height + 2 * G}px`;
          c.width = `${b.width}px`;
          c.height = `${b.height}px`;
        },
        commit: setBox,
        move: (card) => api.peek.move(card),
        frame: (run) => requestAnimationFrame(run),
        cancelFrame: (id) => cancelAnimationFrame(id),
        // On Peek's spring as it is when the glide starts; none with motion off.
        glide: (onUpdate, onComplete) => {
          const t = spring.current;
          return 'type' in t && t.type === 'spring' ? animate(0, 1, { ...t, onUpdate, onComplete }) : null;
        },
      }),
    [initial.card],
  );

  useEffect(
    () =>
      api.peek.onState((state) => {
        setPeek(state);
        card.fromMain(state.card);
      }),
    [card],
  );
  // Closed: a box still waiting is never sent, and nothing more moves.
  useEffect(() => () => card.stop(), [card]);

  /** Open as tab: the card stops where it is first, so the page grows from there without a late box moving it. */
  const openAsTab = () => {
    card.stop();
    setLifted(false);
    void api.peek.expand();
  };

  // While the overlay has focus (before the page is in, or after a click on the header): the same keys the page has.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = info.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter' && command) {
        event.preventDefault();
        openAsTab();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const gripAt = (event: ReactPointerEvent) => peekGripAt({ x: event.clientX, y: event.clientY }, card.box, targetOf(event));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const grip = gripAt(event);
    pressed.current = grip;
    if (!grip) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    card.press(grip, event.clientX, event.clientY, event.pointerId);
    if (grip === 'move') setCursor('grabbing');
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const holding = card.grip;
    if (!holding) {
      const grip = gripAt(event);
      setCursor(grip ? PEEK_CURSOR[grip] : '');
      return;
    }
    if (card.drag(event.pointerId, event.clientX, event.clientY, latest.current.area) && holding === 'move') setLifted(true);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = card.release(event.pointerId);
    if (!grip) return;
    setLifted(false);
    setCursor(PEEK_CURSOR[grip]);
  };

  const onDoubleClick = () => {
    if (pressed.current === 'move') card.goHome(latest.current.home, latest.current.area);
  };

  const { origin } = peek;
  const keys = info.platform === 'darwin' ? { open: '⌘↵', close: 'Esc' } : { open: 'Ctrl+Enter', close: 'Esc' };
  const secure = peek.url.startsWith('https:');
  const SiteIcon = secure ? Lock : Globe;
  // The grips: a band just outside the card's edges (the page covers the card itself, below the header).
  const frameStyle: CSSProperties = {
    left: box.x - G,
    top: box.y - G,
    width: box.width + 2 * G,
    height: box.height + 2 * G,
    ...(cursor ? { cursor } : {}),
  };
  // It grows from the click: the transform origin is the click point, inside the card's own box.
  const cardStyle: CSSProperties = {
    left: G,
    top: G,
    width: box.width,
    height: box.height,
    transformOrigin: origin ? `${origin.x - box.x}px ${origin.y - box.y}px` : 'center',
  };

  return (
    <>
      <motion.div className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={transition} onMouseDown={onClose} data-testid="peek-scrim" />
      <div
        ref={frameEl}
        className={styles.frame}
        style={frameStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onPointerLeave={() => !card.grip && setCursor('')}
        onDoubleClick={onDoubleClick}
        data-testid="peek-frame"
      >
        <motion.div
          ref={cardEl}
          className={styles.card}
          style={cardStyle}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={enter}
          role="dialog"
          aria-label={`Peek: ${peek.host}`}
          data-lifted={lifted || undefined}
        >
          <div className={styles.header} data-peek-header>
            <SiteIcon className={styles.siteIcon} size={12} strokeWidth={2} aria-hidden data-peek-label />
            <span className={styles.host} data-peek-label>
              {peek.host}
            </span>
            {peek.title && (
              <span className={styles.title} data-peek-label>
                {peek.title}
              </span>
            )}
            <span className={styles.flex} title="Drag to move" />
            <button type="button" className={styles.action} onClick={openAsTab} title={`Open as tab (${keys.open})`}>
              <PanelTopOpen size={14} strokeWidth={1.75} aria-hidden />
              Open as tab
              <kbd className={styles.keycap}>{keys.open}</kbd>
            </button>
            <button type="button" className={styles.action} onClick={onClose} title={`Close (${keys.close})`}>
              <X size={14} strokeWidth={2} aria-hidden />
              <span className="sr-only">Close Peek</span>
              <kbd className={styles.keycap}>{keys.close}</kbd>
            </button>
          </div>
        </motion.div>
      </div>
    </>
  );
}
