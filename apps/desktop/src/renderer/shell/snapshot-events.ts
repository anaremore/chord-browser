import type { FrameSnapshotEvent, Rect, SnapshotPane } from '@chord/ipc';

/** A page's picture ready to draw: an ImageBitmap from the snapshot worker. */
export interface DrawablePane {
  rect: Rect;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  /** Docked developer tools: `rect` is their frame, the picture under their header. */
  header?: SnapshotPane['header'];
}

/** A snapshot event as the worker passes it on: `show` carries bitmaps instead of pixels. */
export type DrawableSnapshotEvent = Exclude<FrameSnapshotEvent, { phase: 'show' }> | { seq: number; phase: 'show'; panes: DrawablePane[] };
