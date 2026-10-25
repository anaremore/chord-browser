/**
 * Developer tools docked in the frame (DESIGN.md §7.15). Main lays out the
 * page and DevTools' views; the shell draws what's around and behind them
 * with the same math (core `devtoolsLayout`): the page's frame, DevTools'
 * frame with Chord's header (the other side, pop out, close), and the edge
 * between them, which drags live, as split view's dividers do.
 */
import { DEFAULT_DEVTOOLS, DEVTOOLS, devtoolsLayout, devtoolsSize, dragDevtools, type DevtoolsSettings, type DevtoolsSide, type PaneRect } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { AppWindow, PanelBottom, PanelRight, SquareTerminal, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { api } from './api';
import styles from './App.module.css';
import { useKeys } from './keys';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const box = (r: PaneRect): CSSProperties => ({ left: r.x, top: r.y, width: r.width, height: r.height });

/** The size the edge is at: dragged (`live`), or the setting for the docked side. */
export const dockedSize = (settings: DevtoolsSettings, live: number | null): number => live ?? devtoolsSize(settings);

/**
 * The edge between the page and its developer tools: invisible until
 * hovered, then split view's pill; drag it, nudge it with the arrow keys
 * (Shift for more), or double-click it for the default size. The page and
 * DevTools follow once a frame; the size is saved when it's let go.
 */
function DevtoolsEdge({ side, pane, size, rect, onLive }: { side: DevtoolsSide; pane: PaneRect; size: number; rect: PaneRect; onLive(size: number | null): void }) {
  const right = side === 'right';
  const along = right ? pane.width : pane.height;
  const min = right ? DEVTOOLS.minWidth : DEVTOOLS.minHeight;
  const save = (next: number) => api.devtools.act({ do: 'resize', size: next, done: true });
  return (
    <div
      role="separator"
      aria-orientation={right ? 'vertical' : 'horizontal'}
      aria-label="Resize developer tools"
      aria-valuemin={min}
      aria-valuemax={Math.max(min, along - DEVTOOLS.gap - DEVTOOLS.minPage)}
      aria-valuenow={size}
      tabIndex={0}
      className={styles.paneDivider}
      data-direction={right ? 'row' : 'column'}
      data-devtools-edge
      style={box(rect)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.dataset['active'] = '';
        const start = right ? e.clientX : e.clientY;
        let next = size;
        let frame = 0;
        const move = (ev: PointerEvent) => {
          next = dragDevtools(pane, side, size, (right ? ev.clientX : ev.clientY) - start);
          onLive(next);
          // Main moves the views at most once a frame (ARCHITECTURE.md §5: edge drags resize live).
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            void api.devtools.act({ do: 'resize', size: next, done: false });
          });
        };
        const end = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', end);
          el.removeEventListener('pointercancel', end);
          delete el.dataset['active'];
          cancelAnimationFrame(frame);
          void save(next).then(() => onLive(null));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      }}
      onDoubleClick={() => void save(right ? DEFAULT_DEVTOOLS.width : DEFAULT_DEVTOOLS.height)}
      onKeyDown={(e) => {
        const back = right ? 'ArrowLeft' : 'ArrowUp';
        const forward = right ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== forward) return;
        e.preventDefault();
        const step = (e.shiftKey ? DEVTOOLS.bigStep : DEVTOOLS.step) * (e.key === back ? -1 : 1);
        void save(dragDevtools(pane, side, size, step));
      }}
    />
  );
}

/** DevTools' frame: Chord's header above the DevTools view main places under it. */
function DevtoolsCard({ tabId, side, rect, info }: { tabId: string; side: DevtoolsSide; rect: PaneRect; info: SystemInfo }) {
  const { withKeys } = useKeys(info);
  const other: DevtoolsSide = side === 'right' ? 'bottom' : 'right';
  const toggleKeys = info.platform === 'darwin' ? '⌘⇧D' : 'Ctrl+Shift+D';
  const label = other === 'bottom' ? 'Dock to the bottom' : 'Dock to the right';
  return (
    <section className={styles.devtools} data-devtools={tabId} data-region="devtools" aria-label="Developer tools" style={box(rect)}>
      <div className={styles.devtoolsHeader} data-devtools-header={tabId}>
        <SquareTerminal {...ICON} className={styles.devtoolsIcon} aria-hidden />
        <span className={styles.devtoolsTitle}>Developer tools</span>
        <button type="button" className={`${styles.iconButton} ${styles.devtoolsButton}`} aria-label={label} title={label} onClick={() => void api.devtools.act({ do: 'side', side: other })}>
          {other === 'bottom' ? <PanelBottom {...ICON} aria-hidden /> : <PanelRight {...ICON} aria-hidden />}
        </button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.devtoolsButton}`}
          aria-label="Pop out into a window"
          title={`Pop out into a window (${toggleKeys} in DevTools)`}
          onClick={() => void api.devtools.act({ do: 'window', nodeId: tabId })}
        >
          <AppWindow {...ICON} aria-hidden />
        </button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.devtoolsButton}`}
          aria-label="Close developer tools"
          title={withKeys('Close developer tools', 'app.devtools')}
          onClick={() => void api.devtools.act({ do: 'close', nodeId: tabId })}
        >
          <X {...ICON} aria-hidden />
        </button>
      </div>
    </section>
  );
}

/**
 * A pane whose tab has its developer tools docked: the page's frame (what
 * the page can't show, an error or a crash, drawn in it), the edge, and
 * DevTools' frame. In a split, the page's frame carries the focus ring.
 */
export function DockedPane({
  tabId,
  pane,
  settings,
  live,
  onLive,
  info,
  focused,
  shared,
  onPagePointerDown,
  children,
}: {
  tabId: string;
  pane: PaneRect;
  settings: DevtoolsSettings;
  live: number | null;
  onLive(size: number | null): void;
  info: SystemInfo;
  /** In a split: whether this is the focused pane (undefined outside one). */
  focused?: boolean;
  shared: boolean;
  onPagePointerDown?(): void;
  children: ReactNode;
}) {
  if (pane.width <= 0 || pane.height <= 0) return null;
  const d = devtoolsLayout(pane, settings.side, dockedSize(settings, live));
  // What they are in this pane (within its room), which the edge moves from.
  const size = settings.side === 'right' ? d.card.width : d.card.height;
  return (
    <>
      <div className={styles.pane} data-pane={tabId} data-focused={focused || undefined} data-shared={shared || undefined} style={box(d.page)} onPointerDown={onPagePointerDown}>
        {children}
      </div>
      <DevtoolsEdge side={settings.side} pane={pane} size={size} rect={d.edge} onLive={onLive} />
      <DevtoolsCard tabId={tabId} side={settings.side} rect={d.card} info={info} />
    </>
  );
}
