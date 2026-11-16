/**
 * Where a scrolling list of equal-height rows is scrolled to (DESIGN.md
 * §6.7), for windowing it (Tabs.tsx, virtual.ts): Today, and Pinned once it
 * reaches its cap. It updates only when the first row on screen, the list's
 * height, whether there's more below, or whether its rows overflow it
 * changes, so scrolling redraws the list once a row, not once a frame.
 *
 * Each list is remembered by `key`, `<chord>:<kind>` (a chord's Pinned or
 * Today), for as long as the shell runs: how far it was scrolled, so
 * switching back to a chord finds it where it was, and how tall it was, so it
 * mounts with the rows it shows.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ListView {
  /** How far the list is scrolled, px. */
  top: number;
  /** How tall it shows, px. */
  height: number;
  /** More of it is below what shows. */
  more: boolean;
  /** Its rows are taller than it is: it's at its cap, and scrolls (Pinned); below it, nothing is clipped. */
  capped: boolean;
}

interface Remembered {
  top: number;
  height: number;
  capped: boolean;
}

/** Each list's last scroll position and height, by key. */
const remembered = new Map<string, Remembered>();
/** The last list of each kind measured (`pinned`, `today`): one seen for the first time is about as tall. */
const lastHeight = new Map<string, number>();

const kindOf = (key: string) => key.slice(key.lastIndexOf(':') + 1);

/** Forgets the lists whose keys `keep` says no to (a deleted chord's). */
export function forgetLists(keep: (key: string) => boolean): void {
  for (const key of remembered.keys()) if (!keep(key)) remembered.delete(key);
}

/** Where `list` is scrolled. Its rows are all one height, so how tall they are is known without laying it out. */
const viewOf = (list: HTMLElement, contentHeight: number): ListView => {
  const top = list.scrollTop;
  const height = list.clientHeight;
  return { top, height, more: top + height < contentHeight - 1, capped: contentHeight > height + 1 };
};

const same = (a: ListView, b: ListView, rowHeight: number) =>
  Math.floor(a.top / rowHeight) === Math.floor(b.top / rowHeight) && a.height === b.height && a.more === b.more && a.capped === b.capped;

/**
 * `rows`: how many rows the list has, mounted or not. `capped`: the list
 * grows with its rows up to a cap and scrolls (and clips) only there
 * (Pinned, through `data-capped`), so its rows reaching or leaving the cap is
 * measured before that frame is painted.
 */
export function useListWindow(rowHeight: number, key: string, rows: number, { capped: hasCap = false }: { capped?: boolean } = {}) {
  const [list, setList] = useState<HTMLElement | null>(null);
  // Until the list is measured, where it was left, as tall as it was (or as the last list of its kind, or the
  // window): if that's short, the rows it leaves out are there before the first frame is drawn (its
  // ResizeObserver reports before paint). Capped as it was; a list not seen before is measured before paint.
  const [view, setView] = useState<ListView>(() => {
    const was = remembered.get(key);
    const height = was?.height || lastHeight.get(kindOf(key)) || window.innerHeight;
    return { top: was?.top ?? 0, height, more: false, capped: was?.capped ?? false };
  });
  const shown = useRef(view);
  shown.current = view;
  /** As of the last scroll or resize: where rows were on screen, still known once they're gone. */
  const last = useRef<ListView>({ top: 0, height: 0, more: false, capped: false });
  const contentHeight = useRef(0);
  contentHeight.current = rows * rowHeight;
  /** Measures the list again (set while it's mounted). */
  const measure = useRef<(() => void) | null>(null);

  const keep = useCallback(
    (now: ListView) => {
      last.current = now;
      if (now.height > 0) {
        lastHeight.set(kindOf(key), now.height);
        remembered.set(key, { top: now.top, height: now.height, capped: now.capped });
      }
    },
    [key],
  );

  const update = useCallback(() => {
    if (!list) return;
    const now = viewOf(list, contentHeight.current);
    keep(now);
    setView((v) => (same(v, now, rowHeight) ? v : now));
  }, [list, rowHeight, keep]);

  useEffect(() => {
    if (!list) return;
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
  }, [list, update]);

  // A list with a cap: when its rows may have reached it or left it (or it's new), measured now, so the frame
  // that shows them scrolls or doesn't (otherwise they'd spill over what's below it for a frame). Not on every
  // change of its rows: only when they cross what it last measured.
  useLayoutEffect(() => {
    if (!hasCap || !list) return;
    const content = rows * rowHeight;
    const height = last.current.height;
    if (height === 0 || (shown.current.capped ? content <= height + 1 : content > height + 1)) update();
  }, [hasCap, list, rows, rowHeight, update]);

  // Rows came or went without the list changing size (it's at its cap): whether there's more below, or whether
  // they still overflow it, may have changed. On the next frame, with the rest of its layout.
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
      // Its rows just reached its cap (a tab pinned at its end): it scrolls from now on, before React says so.
      if (hasCap && contentHeight.current > height + 1) list.setAttribute('data-capped', '');
      let to = list.scrollTop;
      if (top < to) to = top;
      else if (top + rowHeight > to + height) to = top + rowHeight - height;
      if (to === list.scrollTop) return;
      list.scrollTop = to;
      const now = viewOf(list, contentHeight.current);
      keep(now);
      setView(now);
    },
    [list, rowHeight, keep, hasCap],
  );

  return { ref, list, view, last, reveal };
}
