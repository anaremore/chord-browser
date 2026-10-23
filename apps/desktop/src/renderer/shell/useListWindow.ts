/**
 * Where a scrolling list of equal-height rows is scrolled to (DESIGN.md
 * §6.7), for windowing it (Tabs.tsx, virtual.ts). It updates only when the
 * first row on screen or the list's height changes, so scrolling redraws the
 * list once a row, not once a frame.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ListView {
  /** How far the list is scrolled, px. */
  top: number;
  /** How tall it shows, px. */
  height: number;
}

/** The last list measured: a chord's list mounting is about as tall as the one before it. */
let lastHeight = 0;

export function useListWindow(rowHeight: number) {
  const [list, setList] = useState<HTMLElement | null>(null);
  // Until the list is measured, as tall as the last one was, or the window: if that's short, the rows it leaves
  // out are there before the first frame is drawn (its ResizeObserver reports before paint).
  const [view, setView] = useState<ListView>(() => ({ top: 0, height: lastHeight || window.innerHeight }));
  /** As of the last scroll or resize: where rows were on screen, still known once they're gone. */
  const last = useRef<ListView>({ top: 0, height: 0 });

  useEffect(() => {
    if (!list) return;
    const update = () => {
      const top = list.scrollTop;
      const height = list.clientHeight;
      last.current = { top, height };
      if (height > 0) lastHeight = height;
      setView((v) => (Math.floor(v.top / rowHeight) === Math.floor(top / rowHeight) && v.height === height ? v : { top, height }));
    };
    // Measured first by the ResizeObserver, as the first frame is laid out: not now, mid-commit.
    list.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [list, rowHeight]);

  /** Scrolls just enough to show row `index` (not at all if it shows), and windows the list there at once. */
  const reveal = useCallback(
    (index: number) => {
      if (!list) return;
      const top = index * rowHeight;
      const height = list.clientHeight;
      let to = list.scrollTop;
      if (top < to) to = top;
      else if (top + rowHeight > to + height) to = top + rowHeight - height;
      if (to === list.scrollTop) return;
      list.scrollTop = to;
      const now = list.scrollTop;
      last.current = { top: now, height };
      setView({ top: now, height });
    },
    [list, rowHeight],
  );

  return { ref: setList, list, view, last, reveal };
}
