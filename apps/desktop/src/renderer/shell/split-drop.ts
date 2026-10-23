/**
 * Where a tab dragged from the sidebar onto the page lands in a split
 * (DESIGN.md §8.4). With one page shown, the frame's nearest edge decides:
 * left or right puts the tab beside it, top or bottom above or below. With a
 * split shown, the half of the pane under the pointer (along the split)
 * decides, and a pane dragged within its own split moves there.
 */
import { paneRects, splitMembers, splitOf, SPLIT, type Command, type NodeId, type PaneRect, type State, type WindowId } from '@chord/core';

/** The droppable over the page. */
export const SPLIT_DROP = 'split-drop';

export interface SplitDrop {
  /** The highlighted part of the frame, relative to it. */
  rect: PaneRect;
  command: Extract<Command, { t: 'split.add' }>;
}

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/** Null when the tab can't go there: another chord, the page itself, a full split, or where it already is. */
export function splitDropFor(state: State, windowId: WindowId, nodeId: NodeId, point: Point, size: Size): SplitDrop | null {
  const win = state.windows[windowId];
  const activeId = win ? win.activeTab[win.activeChordId] : null;
  const dragged = state.nodes[nodeId];
  if (!win || !activeId || dragged?.kind !== 'tab' || dragged.chordId !== win.activeChordId) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  const frame = { x: 0, y: 0, ...size };
  const split = splitOf(state, activeId);

  if (!split) {
    if (nodeId === activeId) return null;
    const fx = point.x / size.width;
    const fy = point.y / size.height;
    const edges = [
      { edge: 'left', d: fx },
      { edge: 'right', d: 1 - fx },
      { edge: 'top', d: fy },
      { edge: 'bottom', d: 1 - fy },
    ] as const;
    const { edge } = edges.reduce((a, b) => (b.d < a.d ? b : a));
    const direction = edge === 'left' || edge === 'right' ? 'row' : 'column';
    const first = edge === 'left' || edge === 'top';
    const [a, b] = paneRects(frame, direction, [0.5, 0.5]);
    return { rect: first ? a! : b!, command: { t: 'split.add', windowId, withId: activeId, nodeId, index: first ? 0 : 1, direction } };
  }

  const panes = splitMembers(state, split.id).map((t) => t.id);
  const from = panes.indexOf(nodeId);
  if (from < 0 && panes.length >= SPLIT.maxPanes) return null;
  const rects = paneRects(frame, split.direction, split.sizes);
  const along = split.direction === 'row' ? 'x' : 'y';
  const extent = split.direction === 'row' ? 'width' : 'height';
  const hovered = rects.findIndex((r) => point[along] < r[along] + r[extent]);
  const at = hovered < 0 ? rects.length - 1 : hovered;
  const pane = rects[at]!;
  const after = point[along] > pane[along] + pane[extent] / 2;
  // Its place among all the panes, then among the others (a pane moving within the split isn't counted twice).
  const slot = at + (after ? 1 : 0);
  if (from >= 0 && (slot === from || slot === from + 1)) return null;
  const index = from >= 0 && slot > from ? slot - 1 : slot;
  const half = Math.floor(pane[extent] / 2);
  const rect = { ...pane, [extent]: half, ...(after ? { [along]: pane[along] + pane[extent] - half } : {}) };
  // Beside another pane: split.add needs a tab other than the one moving.
  const withId = panes.find((id) => id !== nodeId)!;
  return { rect, command: { t: 'split.add', windowId, withId, nodeId, index } };
}
