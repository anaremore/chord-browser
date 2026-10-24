/**
 * Chord's mark: the app icon's three notes (build/icon.svg), on the icon's own
 * 1024 grid with its gradients and shadows; each overlaps the one above through
 * a cutout in the color behind the mark, as the icon's do in its plate's color.
 * First run's welcome and Settings → About show it; only first run animates it
 * (DESIGN.md §2).
 */
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { Fragment, useId } from 'react';

const NOTES = [
  { id: 'lilac', from: '#c3a2ff', to: '#9476ec', shadow: '#6a4bc4', x: 408, y: 346, width: 384 },
  { id: 'rose', from: '#ff92c0', to: '#e85aa6', shadow: '#b8357f', x: 320, y: 450, width: 424 },
  { id: 'coral', from: '#ffae78', to: '#ff6f4c', shadow: '#d4502f', x: 232, y: 554, width: 380 },
] as const;
/** A note's height and corner, and its cutout's margin, on that grid. */
const NOTE = { height: 124, rx: 62, cut: 10 } as const;

/**
 * `cutClassName` fills the cutouts with the color behind the mark. With
 * `strike`, the notes strike in from the left one after another, back to
 * front, on that transition.
 */
export function ChordMark({ className, cutClassName, strike }: { className?: string; cutClassName: string; strike?: Transition }) {
  // Gradient and filter ids are the page's: two marks on one page mustn't share them.
  const uid = useId();
  const ref = (name: string) => `${uid}-${name}`;
  const notes = NOTES.map((note, i) => {
    const parts = (
      <>
        {i > 0 && (
          <rect className={cutClassName} x={note.x - NOTE.cut} y={note.y - NOTE.cut} width={note.width + 2 * NOTE.cut} height={NOTE.height + 2 * NOTE.cut} rx={NOTE.rx + NOTE.cut} />
        )}
        <rect x={note.x} y={note.y} width={note.width} height={NOTE.height} rx={NOTE.rx} fill={`url(#${ref(note.id)})`} filter={`url(#${ref(`${note.id}-shadow`)})`} />
        <rect x={note.x} y={note.y} width={note.width} height={NOTE.height} rx={NOTE.rx} fill={`url(#${ref('sheen')})`} />
      </>
    );
    return strike ? (
      <motion.g key={note.id} initial={{ x: -120, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ ...strike, delay: i * 0.06 }}>
        {parts}
      </motion.g>
    ) : (
      <g key={note.id}>{parts}</g>
    );
  });
  return (
    <svg className={className} viewBox="212 336 590 352" aria-hidden>
      <defs>
        {NOTES.map((note) => (
          <Fragment key={note.id}>
            <linearGradient id={ref(note.id)} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={note.from} />
              <stop offset="1" stopColor={note.to} />
            </linearGradient>
            <filter id={ref(`${note.id}-shadow`)} x="-20%" y="-50%" width="140%" height="220%">
              <feDropShadow dx="0" dy="14" stdDeviation="18" floodColor={note.shadow} floodOpacity="0.32" />
            </filter>
          </Fragment>
        ))}
        {/* Light from above: a little brighter on top, a touch deeper below. */}
        <linearGradient id={ref('sheen')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.24" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* Its own presence boundary: a card around it may skip its first animation, and would skip the notes' too. */}
      {strike ? <AnimatePresence>{notes}</AnimatePresence> : notes}
    </svg>
  );
}
