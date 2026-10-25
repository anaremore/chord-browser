/**
 * The frame's snapshot, the shell's half (ARCHITECTURE.md §5). While the
 * content frame changes size (the sidebar docks or collapses, Duet opens or
 * closes), main moves the pages out of sight and the shell, which draws the
 * frame behind them, shows their pictures instead:
 *
 * - `show`: paint each page's picture exactly where the page is, as the
 *   frame's card (its radius and shadow), and tell main once it's on screen;
 * - `move`: glide the pictures to the new pane rects by CSS transform (scale
 *   and position, on the compositor) on the frame's spring, `smooth`, in the
 *   same frame as the shell's own change; tell main when they arrive;
 * - `drop`: the pages are back above the shell: once they've painted, the
 *   pictures go.
 *
 * While pictures show, they are the frame: the real one waits, hidden, at
 * its new size (App.module.css). Pictures live in canvases in this page's
 * memory only, never in a URL or a file.
 */
import type { FrameSnapshotEvent, Rect, SnapshotPane, SNAPSHOT_PORT_MESSAGE } from '@chord/ipc';
import { useEffect, useRef } from 'react';
import { nextFrame } from '../shared/frames';
import { afterNextPaint } from '../shared/perf';
import { api } from './api';
import styles from './App.module.css';
import { bgraToRgba, imageData } from './pixels';
import type { DrawablePane, DrawableSnapshotEvent } from './snapshot-events';

/** The value of `SNAPSHOT_PORT_MESSAGE`, without bundling @chord/ipc's runtime into the shell. */
const PORT_MESSAGE: typeof SNAPSHOT_PORT_MESSAGE = 'chord:frame-port';

/** The transform that takes a picture drawn at `from` to `to` (its origin is its top-left corner). */
export function transformFor(from: Rect, to: Rect): string {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  return `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${sx}, ${sy})`;
}

/**
 * One picture as the frame's card: a canvas; or for docked developer tools,
 * their frame with a copy of their header (DESIGN.md §7.16) and the picture under it.
 */
function card(pane: DrawablePane | SnapshotPane): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.width = pane.width;
  canvas.height = pane.height;
  if ('bitmap' in pane) canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(pane.bitmap);
  else canvas.getContext('2d', { alpha: false })?.putImageData(imageData(bgraToRgba(pane.pixels), pane.width, pane.height), 0, 0);
  const place = { left: `${pane.rect.x}px`, top: `${pane.rect.y}px`, width: `${pane.rect.width}px`, height: `${pane.rect.height}px` };
  if (!pane.header) {
    canvas.className = styles.snapshot!;
    Object.assign(canvas.style, place);
    return canvas;
  }
  const frame = document.createElement('div');
  frame.className = `${styles.snapshot} ${styles.snapshotDevtools}`;
  Object.assign(frame.style, place);
  // The real header is hidden with the frame while pictures show: a copy, inert, goes with the picture.
  const header = document.querySelector(`[data-devtools-header="${CSS.escape(pane.header.tab)}"]`)?.cloneNode(true);
  if (header instanceof HTMLElement) {
    header.removeAttribute('data-devtools-header');
    header.inert = true;
    frame.append(header);
  }
  canvas.className = styles.snapshotPicture!;
  Object.assign(canvas.style, { top: `${pane.header.height}px`, width: '100%', height: `${Math.max(0, pane.rect.height - pane.header.height)}px` });
  frame.append(canvas);
  return frame;
}

interface Showing {
  seq: number;
  canvases: HTMLElement[];
  from: Rect[];
  /** Where each picture was last sent (its transform). */
  to: string[];
  /** Told main the pictures arrived (once per snapshot: retargets move them on). */
  arrived: boolean;
}

function attach(host: HTMLElement): () => void {
  const root = document.documentElement;
  let showing: Showing | null = null;

  const clear = () => {
    showing = null;
    host.replaceChildren();
    delete root.dataset['frameSnapshot'];
  };

  // Usually an ImageBitmap the worker made, handed to the canvas as it is (no draw, no copy); main's pixels as
  // sent until the worker has its port.
  const show = (panes: readonly (DrawablePane | SnapshotPane)[], seq: number) => {
    clear();
    const canvases = panes.map(card);
    host.replaceChildren(...canvases);
    root.dataset['frameSnapshot'] = '';
    const mine: Showing = { seq, canvases, from: panes.map((p) => p.rect), to: canvases.map(() => ''), arrived: false };
    showing = mine;
    // Main moves the pages away only once the pictures are on screen in their place.
    afterNextPaint(() => {
      if (showing === mine) void api.layout.snapshot(mine.seq, 'shown');
    });
  };

  const arrive = (mine: Showing) => {
    if (showing !== mine || mine.arrived) return;
    mine.arrived = true;
    void api.layout.snapshot(mine.seq, 'moved');
  };

  // In the frame the shell's own change renders in (shared/frames.ts), so the pictures and the shell move together.
  const move = (event: Extract<FrameSnapshotEvent, { phase: 'move' }>) =>
    nextFrame(() => {
      const mine = showing;
      if (!mine || mine.seq !== event.seq) return;
      mine.arrived = false;
      let gliding = false;
      mine.canvases.forEach((canvas, i) => {
        const from = mine.from[i];
        const to = event.rects[i];
        if (!from || !to) return;
        const transform = transformFor(from, to);
        if (mine.to[i] === transform) return;
        mine.to[i] = transform;
        canvas.style.transform = transform;
        // Motion off (or reduced) makes the transition instant: nothing to wait for.
        if (parseFloat(getComputedStyle(canvas).transitionDuration) > 0) gliding = true;
      });
      if (!gliding) arrive(mine);
    });

  // They all glide on the same spring from the same frame: the first to arrive speaks for all.
  const onArrived = (e: TransitionEvent) => {
    if (e.propertyName === 'transform' && showing) arrive(showing);
  };
  host.addEventListener('transitionend', onArrived);

  const handle = (event: FrameSnapshotEvent | DrawableSnapshotEvent) => {
    if (event.phase === 'show') show(event.panes, event.seq);
    else if (event.phase === 'move') move(event);
    else {
      // The pages are back above the shell: let them paint, then the pictures go.
      const seq = event.seq;
      afterNextPaint(() =>
        afterNextPaint(() => {
          if (showing?.seq === seq) clear();
        }),
      );
    }
  };

  // Main's port for these events goes to a worker, which turns pictures into bitmaps off this thread.
  const worker = new Worker(new URL('./snapshot-worker.ts', import.meta.url), { type: 'module', name: 'frame-snapshot' });
  worker.onmessage = (e: MessageEvent<DrawableSnapshotEvent>) => handle(e.data);
  const onPort = (e: MessageEvent) => {
    if (e.source === window && e.data === PORT_MESSAGE && e.ports[0]) worker.postMessage(null, [e.ports[0]]);
  };
  window.addEventListener('message', onPort);
  // Until the port arrives, events come the usual way.
  const off = api.layout.onSnapshot(handle);
  void api.layout.connectSnapshots();
  return () => {
    off();
    window.removeEventListener('message', onPort);
    worker.terminate();
    host.removeEventListener('transitionend', onArrived);
    clear();
  };
}

/** Where the frame's pictures go: over the frame, under Duet's panel and anything else above the frame. */
export function FrameSnapshots() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => attach(host.current!), []);
  return <div ref={host} className={styles.snapshots} aria-hidden />;
}
