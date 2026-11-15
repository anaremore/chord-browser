/**
 * Where a scrolling list of equal-height rows is scrolled to (DESIGN.md
 * §6.7), for windowing it (Tabs.tsx, virtual.ts): Today, and Pinned once it
 * reaches its cap. It updates only when the first row on screen, the list's
 * height, or whether there's more below changes, so scrolling redraws the
 * list once a row, not once a frame.
 *
 * Each list is remembered by `key` (a chord's Pinned or Today) for as long as
 * the shell runs: how far it was scrolled, so switching back to a chord finds
 * it where it was, and how tall it was, so it mounts with the rows it shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ListView {
  /** How far the list is scrolled, px. */
  top: number;
  /** How tall it shows, px. */
  height: number;
  /** More of it is below what shows. */
  more: boolean;
}

/** Each list's last scroll position and height, by key. */
const remembered = new Map<string, { top: number; height: number }>();
/** The last list measured: a list seen for the first time is about as tall as one before it. */
let lastHeight = 0;

/** Where `list` is scrolled. Its rows are all one height, so how tall they are is known without laying it out. */
const viewOf = (list: HTMLElement, contentHeight: number): ListView => {
  const top = list.scrollTop;
  const height = list.clientHeight;
  return { top, height, more: top + height < contentHeight - 1 };
};

/** `rows`: how many rows the list has, mounted or not. */
export function useListWindow(rowHeight: number, key: string, rows: number) {
  const [list, setList] = useState<HTMLElement | null>(null);
  // Until the list is measured, where it was left, as tall as it was (or as the last list, or the window): if
  // that's short, the rows it leaves out are there before the first frame is drawn (its ResizeObserver reports
  // before paint).
  const [view, setView] = useState<ListView>(() => {
    const was = remembered.get(key);
    return { top: was?.top ?? 0, height: was?.height || lastHeight || window.innerHeight, more: false };
  });
  /** As of the last scroll or resize: where rows were on screen, still known once they're gone. */
  const last = useRef<ListView>({ top: 0, height: 0, more: false });
  const contentHeight = useRef(0);
  contentHeight.current = rows * rowHeight;
  /** Measures the list again (set while it's mounted). */
  const measure = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!list) return;
    const update = () => {
      const now = viewOf(list, contentHeight.current);
      last.current = now;
      if (now.height > 0) {
        lastHeight = now.height;
        remembered.set(key, { top: now.top, height: now.height });
      }
      setView((v) =>
        Math.floor(v.top / rowHeight) === Math.floor(now.top / rowHeight) && v.height === now.height && v.more === now.more ? v : now,
      );
    };
    // Measured first by the ResizeObserver, as the first frame is laid out: not now, mid-commit.
    list.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(list);
    measure.current = update;
    return () => {
      measure.current = null;
      list.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [list, rowHeight, key]);

  // Rows came or went without the list changing size (it's at its cap): whether there's more below may have changed.
  // On the next frame, with the rest of its layout.
  useEffect(() => {
    const frame = requestAnimationFrame(() => measure.current?.());
    return () => cancelAnimationFrame(frame);
  }, [rows]);

  /**
   * The list's element. Back where it was left: put there as it mounts, before
   * its first frame (the rows it shows there are the ones mounted, so nothing
   * else is laid out for it).
   */
  const ref = useCallback(
    (el: HTMLElement | null) => {
      const top = remembered.get(key)?.top ?? 0;
      if (el && top > 0) el.scrollTop = top;
      setList(el);
    },
    [key],
  );

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
      const now = viewOf(list, contentHeight.current);
      last.current = now;
      remembered.set(key, { top: now.top, height: now.height });
      setView(now);
    },
    [list, rowHeight, key],
  );

  return { ref, list, view, last, reveal };
}
