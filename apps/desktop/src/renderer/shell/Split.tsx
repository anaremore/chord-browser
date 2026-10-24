/**
 * Split view in the content frame (DESIGN.md §7.9, §8.4). Main lays the
 * pages out; the shell draws what's around and behind them with the same
 * math (core `paneRects`): each pane's rounded frame, the focus ring in the
 * gap around the focused one, a shared tab's tinted edge, and the dividers in
 * the gaps between them.
 */
import { equalSizes, paneRects, resizeSizes, SPLIT, splitMembers, type LiveTab, type SplitNode, type State, type TabNode } from '@chord/core';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { api } from './api';
import styles from './App.module.css';

export interface Size {
  width: number;
  height: number;
}

/** An element's size, kept current as it changes. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Dividers snap to an even split of the two panes beside them within this many px (the detent). */
const DETENT_PX = 8;
/** Arrow keys move a divider this far; with Shift, further. */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** A divider's new sizes, caught by the detent where the two panes beside it are even. */
function snapSizes(sizes: number[], index: number, room: number): number[] {
  const a = sizes[index]!;
  const b = sizes[index + 1]!;
  if (Math.abs(a - b) * room > DETENT_PX * 2) return sizes;
  const out = [...sizes];
  out[index] = out[index + 1] = (a + b) / 2;
  return out;
}

function Divider({ split, index, sizes, size, rect, onLive }: { split: SplitNode; index: number; sizes: number[]; size: Size; rect: { left: number; top: number; width: number; height: number }; onLive(sizes: number[] | null): void }) {
  const row = split.direction === 'row';
  const along = row ? size.width : size.height;
  const room = along - SPLIT.gap * (sizes.length - 1);
  const commit = (next: number[]) => api.state.dispatch({ t: 'split.resize', splitId: split.id, sizes: next });
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize split panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((sizes[index] ?? 0) * 100)}
      tabIndex={0}
      className={styles.paneDivider}
      data-direction={split.direction}
      data-divider={index}
      style={rect}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.dataset['active'] = '';
        const start = row ? e.clientX : e.clientY;
        let next = sizes;
        let frame = 0;
        const move = (ev: PointerEvent) => {
          next = snapSizes(resizeSizes(sizes, index, (row ? ev.clientX : ev.clientY) - start, along), index, room);
          onLive(next);
          // The pages follow live, once a frame (ARCHITECTURE.md §5: divider drags resize live).
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            void commit(next);
          });
        };
        const end = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', end);
          el.removeEventListener('pointercancel', end);
          delete el.dataset['active'];
          cancelAnimationFrame(frame);
          void commit(next).then(() => onLive(null));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      }}
      // Double-click evens every pane out (DESIGN.md §7.9).
      onDoubleClick={() => void commit(equalSizes(sizes.length))}
      onKeyDown={(e) => {
        const back = row ? 'ArrowLeft' : 'ArrowUp';
        const forward = row ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== forward) return;
        e.preventDefault();
        const step = (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * (e.key === back ? -1 : 1);
        void commit(resizeSizes(sizes, index, step, along));
      }}
    />
  );
}

/**
 * The frames of a split's panes, sized like the pages main lays over them.
 * `pageState` draws what a pane shows when its page can't (an error or a
 * crash). Pressing a pane whose page is hidden focuses it.
 */
export function SplitPanes({
  state,
  windowId,
  split,
  activeId,
  size,
  pageState,
}: {
  state: State;
  windowId: string;
  split: SplitNode;
  activeId: string | null;
  size: Size;
  pageState(tab: TabNode, live: LiveTab | undefined): ReactNode;
}) {
  const panes = splitMembers(state, split.id);
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live && live.length === panes.length ? live : split.sizes;
  if (size.width <= 0 || size.height <= 0 || panes.length < 2) return null;
  const rects = paneRects({ x: 0, y: 0, ...size }, split.direction, sizes);
  const row = split.direction === 'row';
  return (
    <>
      {panes.map((tab, i) => {
        const r = rects[i]!;
        const focused = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={styles.pane}
            data-pane={tab.id}
            data-focused={focused || undefined}
            // A page is sharing this pane's tab: its edge is tinted (ARCHITECTURE.md §9).
            data-shared={state.live[tab.id]?.shared || undefined}
            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
            onPointerDown={() => {
              if (!focused) void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: tab.id });
            }}
          >
            {pageState(tab, state.live[tab.id])}
          </div>
        );
      })}
      {rects.slice(0, -1).map((r, i) => {
        const next = rects[i + 1]!;
        const rect = row
          ? { left: r.x + r.width, top: 0, width: next.x - r.x - r.width, height: size.height }
          : { left: 0, top: r.y + r.height, width: size.width, height: next.y - r.y - r.height };
        return <Divider key={`divider-${i}`} split={split} index={i} sizes={sizes} size={size} rect={rect} onLive={setLive} />;
      })}
    </>
  );
}
