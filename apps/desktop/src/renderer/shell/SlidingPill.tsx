/**
 * The highlight that glides to the active row: the active tab's in the
 * sidebar, the current chord's in the switcher (DESIGN.md §6.5, `snappy`).
 *
 * Motion's shared-layout pills did this by measuring the sidebar right after
 * React changed it, which forced a layout in the middle of every switch
 * (about 3 ms of each tab or chord switch with 200 tabs; ROADMAP, P0
 * Performance). This pill reads geometry only where the browser has just
 * laid out anyway: in a ResizeObserver's first call, after layout and before
 * paint. It reads its own row and the row the highlight was last on (which
 * stays in the page), and slides from there on the compositor (the Web
 * Animations API), across lists too (Pinned to Today), wherever scrolling or
 * a reorder has moved the rows since. With nothing to slide from (the first
 * pill, a closed tab's row, a row scrolled out of Today's window), it just
 * appears.
 */
import { springs, springToCss } from '@chord/tokens';
import { useLayoutEffect, useRef } from 'react';

const SNAPPY = springToCss(springs.snappy);

/** Each group's last row with the highlight: it outlives the pill, which goes with being active (held weakly: a closed tab's row can go). */
const lastRow = new Map<string, WeakRef<Element>>();

/** `group`: pills that slide to one another (one chord's tabs; the switcher). `glide`: motion is on for it. */
export function SlidingPill({ group, className, glide }: { group: string; className: string | undefined; glide: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current;
    const row = pill?.parentElement;
    if (!pill || !row) return;
    const from = lastRow.get(group)?.deref();
    lastRow.set(group, new WeakRef(row));
    if (!glide || !from || from === row || !from.isConnected) return;
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      // Both read after this frame's layout, so nothing is laid out again.
      const was = from.getBoundingClientRect();
      const now = row.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      pill.animate({ transform: [`translate(${dx}px, ${dy}px)`, 'translate(0, 0)'] }, { duration: SNAPPY.durationMs, easing: SNAPPY.easing });
    });
    observer.observe(pill);
    return () => observer.disconnect();
  }, [group, glide]);
  return <span ref={ref} className={className} data-pill aria-hidden />;
}
