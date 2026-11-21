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
import { dragPeekCard, clampPeekCard, PEEK_CURSOR, PEEK_GRIP, peekGripAt, type PeekGrip, type PeekTarget } from '@chord/core';
import type { PeekState, Rect, SystemInfo } from '@chord/ipc';
import { Globe, Lock, PanelTopOpen, X } from 'lucide-react';
import { animate, motion, type AnimationPlaybackControls, type Transition } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { latestWins } from '../shared/latest';
import { api } from './api';
import styles from './Peek.module.css';

/** A press on the card's frame: what it landed on, for `peekGripAt`. */
function targetOf(event: { target: EventTarget }): PeekTarget {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('button, [data-peek-label]')) return 'control';
  return target?.closest('[data-peek-header]') ? 'header' : 'outside';
}

interface Gesture {
  grip: PeekGrip;
  start: Rect;
  x: number;
  y: number;
  pointerId: number;
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
  // The card as React draws it: main's box, or where a gesture left it.
  const [box, setBox] = useState(initial.card);
  const [cursor, setCursor] = useState('');
  const [lifted, setLifted] = useState(false);
  const latest = useRef(initial);
  latest.current = peek;
  // The card as it is on screen: during a gesture or a glide home it's drawn straight into the DOM each frame, and
  // React gets the box once it ends (rendering the chrome every frame cost more than the move itself).
  const drawn = useRef(initial.card);
  const frameEl = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** What the last press took hold of: a double-click's target is the frame holding the pointer, not the header. */
  const pressed = useRef<PeekGrip | null>(null);
  const recentering = useRef<AnimationPlaybackControls | null>(null);
  const frame = useRef(0);
  const nextBox = useRef<Rect | null>(null);
  const lastSent = useRef<Rect | null | undefined>(undefined);
  const busy = () => gesture.current !== null || recentering.current !== null;

  /** React's box is what's on screen, once nothing draws over it. */
  const commit = (b: Rect) => {
    drawn.current = b;
    setBox(b);
  };

  /** Draws the card at `b` this frame, without a render. */
  const draw = (b: Rect) => {
    drawn.current = b;
    const f = frameEl.current?.style;
    const c = cardEl.current?.style;
    if (!f || !c) return;
    f.left = `${b.x - G}px`;
    f.top = `${b.y - G}px`;
    f.width = `${b.width + 2 * G}px`;
    f.height = `${b.height + 2 * G}px`;
    c.width = `${b.width}px`;
    c.height = `${b.height}px`;
  };

  // One box a frame goes to main, the latest; the card as main placed it is drawn once nothing newer is on its way.
  const mover = useMemo(
    () =>
      latestWins<Rect | null>(async (card) => {
        const placed = await api.peek.move(card);
        if (placed && lastSent.current === card && !busy()) commit(placed);
      }),
    [],
  );
  const send = (card: Rect | null) => {
    lastSent.current = card;
    mover.push(card);
  };

  useEffect(
    () =>
      api.peek.onState((state) => {
        setPeek(state);
        // A box from main while one of ours is on its way is older than what's drawn: the reply puts it right.
        if (!busy() && mover.idle) commit(state.card);
      }),
    [mover],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      recentering.current?.stop();
    },
    [],
  );

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

  const gripAt = (event: ReactPointerEvent) => peekGripAt({ x: event.clientX, y: event.clientY }, drawn.current, targetOf(event));

  /** The pointer's latest box goes on screen and to main, once a frame. */
  const flush = () => {
    frame.current = 0;
    const next = nextBox.current;
    if (!next) return;
    nextBox.current = null;
    draw(next);
    send(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const grip = gripAt(event);
    pressed.current = grip;
    if (!grip) return;
    event.preventDefault();
    // Pressed on its way home, the card stays where it got to.
    recentering.current?.stop();
    recentering.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { grip, start: drawn.current, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (grip === 'move') setCursor('grabbing');
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) {
      const grip = gripAt(event);
      setCursor(grip ? PEEK_CURSOR[grip] : '');
      return;
    }
    if (event.pointerId !== g.pointerId) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (dx === 0 && dy === 0) return;
    if (g.grip === 'move') setLifted(true);
    nextBox.current = dragPeekCard(g.start, g.grip, dx, dy, latest.current.area);
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    // Where it was let go is where it stays: the last box goes now, not a frame later.
    cancelAnimationFrame(frame.current);
    flush();
    gesture.current = null;
    commit(drawn.current);
    setLifted(false);
    setCursor(PEEK_CURSOR[g.grip]);
  };

  /** Back to the center at the default size: gliding there (`overlay`), or at once with motion off. */
  const recenter = () => {
    const from = drawn.current;
    const { home, area } = latest.current;
    recentering.current?.stop();
    recentering.current = null;
    if (!('type' in enter) || enter.type !== 'spring') {
      commit(home);
      send(null);
      return;
    }
    const at = (k: number) =>
      clampPeekCard(
        { x: from.x + (home.x - from.x) * k, y: from.y + (home.y - from.y) * k, width: from.width + (home.width - from.width) * k, height: from.height + (home.height - from.height) * k },
        area,
      );
    const controls = animate(0, 1, {
      ...enter,
      onUpdate: (k) => {
        if (recentering.current !== controls) return;
        const next = at(k);
        draw(next);
        send(next);
      },
      onComplete: () => {
        if (recentering.current !== controls) return;
        recentering.current = null;
        commit(home);
        send(null);
      },
    });
    recentering.current = controls;
  };

  const onDoubleClick = () => {
    if (pressed.current === 'move') recenter();
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
        onPointerLeave={() => !gesture.current && setCursor('')}
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
            <button type="button" className={styles.action} onClick={() => void api.peek.expand()} title={`Open as tab (${keys.open})`}>
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
