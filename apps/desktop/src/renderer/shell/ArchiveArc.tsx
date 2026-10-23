/**
 * The archive arc (DESIGN.md §6.5): an archived row shrinks and fades where it
 * was (Tabs.tsx, today-motion.ts), its favicon flies in an arc to the footer's
 * Archive button, and the button gulps as it lands. Close, archive and pin
 * stay distinct: a closed row drifts left, a pinned one lifts toward Pinned,
 * an archived one goes into the box.
 *
 * Only rows that were on screen fly, at most 6, 12 ms apart (§6.1 rule 7), so
 * a Clear of 200 tabs animates no more than a Clear of 6. A flight is a copy of
 * the row's own icon, drawn over the whole window (outside the sidebar's
 * sliding panes) and moved by the Web Animations API on the compositor: no
 * React, and nothing measured but where it starts and where it lands.
 *
 * With reduced motion (§6.6) nothing flies or gulps: the button's highlight
 * fades in 90 ms instead. With "Animate tab moves" off (§6.8) nothing
 * animates at all; Tabs.tsx doesn't ask.
 */
import { durations, easing, space, springs, springToCss } from '@chord/tokens';
import { Archive } from 'lucide-react';
import { animate, motion, type Transition } from 'motion/react';
import { useEffect, useState } from 'react';
import styles from './App.module.css';

/* ---------- Which rows were archived ---------- */

/** Tabs main said it's archiving, and when: their rows leave for the archive rather than as closed tabs. */
const archived = new Map<string, number>();
/** A mark outlives the patch that removes the row by far; old ones are dropped. */
const MARK_MS = 5000;

export function markArchived(ids: readonly string[]): void {
  const now = performance.now();
  for (const [id, at] of archived) if (now - at > MARK_MS) archived.delete(id);
  for (const id of ids) archived.set(id, now);
}

/** Whether a row that just left went to the archive, forgotten as it's asked: if it comes back (Undo) and is closed later, it's closed. */
export function takeArchived(id: string): boolean {
  const at = archived.get(id);
  archived.delete(id);
  return at !== undefined && performance.now() - at <= MARK_MS;
}

/* ---------- Flights ---------- */

/** At most this many fly at once (DESIGN.md §6.1 rule 7). */
export const MAX_FLIGHTS = 6;
/** The arc's sideways bow: a quarter of the drop, within these bounds. */
const BOW = { min: space[4], max: space[10], share: 0.25 } as const;
/** How far out the bow is, through the flight. */
const BOW_AT = 0.35;
/** The favicon shrinks as it goes in. */
const LANDED_SCALE = 0.5;
/** The button's gulp: 1 → 1.12 → 1 (DESIGN.md §6.5). */
const GULP_SCALE = 1.12;
/** The gulp starts as the first favicon goes in (it fades over the last part of its flight). */
const GULP_AT = 0.7;
/** Down with `bouncy`, so it lands with a little give, over the arc's 280 ms. */
const BOUNCY = springToCss(springs.bouncy).easing;

/** The footer's Archive button, while it's drawn, and the layer flights are drawn in. */
let target: HTMLElement | null = null;
let layer: HTMLElement | null = null;
const flashers = new Set<() => void>();
let gulpCount = 0;
/** Icons asked to fly since the last frame: they take off together, measured in one go. */
let queued: { icon: Element; order: number }[] = [];

const asSpring = (s: (typeof springs)[keyof typeof springs]): Transition => ({ type: 'spring', stiffness: s.stiffness, damping: s.damping, mass: s.mass });

/** Whether there's a button to fly to: none in a private window, or with the sidebar hidden. */
export const canFly = (): boolean => Boolean(target?.checkVisibility({ visibilityProperty: true }));

/**
 * Flies a copy of `icon` (a row's favicon, where it shows) to the Archive
 * button. `order` is its place among the rows archived together: each waits
 * 12 ms more than the one before, and the first one's landing makes the
 * button gulp. Beyond the sixth, nothing flies. It takes off on the next
 * frame, before that frame is drawn, so the rows leaving are drawn first and
 * everything is measured at once.
 */
export function flyToArchive(icon: Element, order: number): void {
  if (order >= MAX_FLIGHTS) return;
  if (queued.length === 0) requestAnimationFrame(takeOff);
  queued.push({ icon, order });
}

function takeOff(): void {
  const flights = queued;
  queued = [];
  if (!target || !layer) return;
  const box = target.getBoundingClientRect();
  if (box.width === 0) return;
  const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  // Measure everything, then draw: one layout for the lot.
  const starts = flights.map((f) => ({ ...f, at: f.icon.isConnected ? f.icon.getBoundingClientRect() : null }));
  for (const { icon, order, at } of starts) {
    if (!at || at.width === 0) continue;
    const from = { x: at.left + at.width / 2, y: at.top + at.height / 2 };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    // Bow away from where it's headed (sideways), so the path is an arc, not a drop.
    const bow = Math.sign(dx || -1) * -1 * Math.min(BOW.max, Math.max(BOW.min, Math.abs(dy) * BOW.share));
    const flight = document.createElement('span');
    flight.className = styles.flight!;
    flight.dataset['flight'] = '';
    flight.style.left = `${from.x}px`;
    flight.style.top = `${from.y}px`;
    flight.append(icon.cloneNode(true));
    layer.append(flight);
    const timing = { duration: durations.archiveArc, delay: order * durations.stagger, fill: 'both' } as const;
    // Sideways out and back in; down with a little give; smaller as it goes in, and gone as it lands.
    flight.animate(
      [
        { transform: 'translateX(0)', easing: easing.standard },
        { transform: `translateX(${bow}px)`, offset: BOW_AT, easing: easing.exit },
        { transform: `translateX(${dx}px)` },
      ],
      { ...timing, composite: 'add' },
    );
    flight.animate({ transform: ['translateY(0)', `translateY(${dy}px)`] }, { ...timing, easing: BOUNCY, composite: 'add' });
    flight.animate({ transform: ['scale(1)', `scale(${LANDED_SCALE})`] }, { ...timing, easing: easing.exit, composite: 'add' });
    const fade = flight.animate([{ opacity: 1 }, { opacity: 1, offset: GULP_AT, easing: easing.exit }, { opacity: 0 }], timing);
    void fade.finished.finally(() => flight.remove());
    if (order === 0) {
      const gulp = ++gulpCount;
      setTimeout(() => gulpCount === gulp && gulpButton(), durations.archiveArc * GULP_AT);
    }
  }
}

/** The button takes the favicons in: up to 1.12 and back, `bouncy`. `will-change` only while it moves. */
function gulpButton(): void {
  const el = target;
  if (!el) return;
  const gulp = gulpCount;
  el.style.willChange = 'transform';
  void animate(el, { scale: GULP_SCALE }, asSpring(springs.press))
    .then(() => (gulp === gulpCount ? animate(el, { scale: 1 }, asSpring(springs.bouncy)) : undefined))
    .then(() => {
      if (gulp === gulpCount) el.style.willChange = '';
    });
}

/** Reduced motion: the destination's highlight fades (DESIGN.md §6.6), and nothing moves. */
export function flashArchive(): void {
  for (const flash of flashers) flash();
}

/** Where favicons fly, over the whole window. */
export function ArchiveFlights() {
  return (
    <div
      ref={(el) => {
        layer = el;
        return () => {
          if (layer === el) layer = null;
        };
      }}
      className={styles.flights}
      aria-hidden
    />
  );
}

/** The footer's Archive button: where archived favicons land. */
export function ArchiveButton({ title, onClick }: { title: string; onClick(): void }) {
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    const onFlash = () => setFlash((n) => n + 1);
    flashers.add(onFlash);
    return () => {
      flashers.delete(onFlash);
    };
  }, []);
  return (
    <button
      ref={(el) => {
        target = el;
        return () => {
          if (target === el) target = null;
        };
      }}
      type="button"
      className={styles.downloadsButton}
      aria-label="Archive"
      title={title}
      onClick={onClick}
      data-archive-button
    >
      {flash > 0 && (
        <motion.span
          key={flash}
          className={styles.archiveFlash}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: durations.fadeFast / 1000, ease: 'easeOut' }}
          onAnimationComplete={() => setFlash(0)}
        />
      )}
      <Archive size={16} strokeWidth={1.75} />
    </button>
  );
}
