/**
 * The Pinned tree as the sidebar draws it (DESIGN.md §3.2): one flat list of
 * rows, each with its depth, so it can be dragged like a list. Where a drop
 * lands in the tree comes from the row above, the row below, and how far the
 * pointer moved sideways (one level per indent, the way dnd-kit's own
 * sortable tree works).
 */
import { children, type ChordId, type NodeId, type State } from '@chord/core';

/** One indent level, in px (DESIGN.md §3.2: 12 px per level). */
export const INDENT = 12;
/** Indents stop growing past this depth; the tree can go deeper. */
export const MAX_VISUAL_DEPTH = 4;

export interface FlatRow {
  id: NodeId;
  kind: 'tab' | 'folder';
  depth: number;
  parentId: NodeId | null;
  collapsed: boolean;
}

/**
 * Pinned rows in sidebar order. Children of collapsed folders aren't rows,
 * and neither are the children of `hiding` (a folder being dragged travels
 * closed, as one row).
 */
export function flattenPinned(state: State, chordId: ChordId, hiding: NodeId | null = null): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (parentId: NodeId | null, depth: number) => {
    for (const node of children(state, chordId, 'pinned', parentId)) {
      const collapsed = node.kind === 'folder' && (node.collapsed || node.id === hiding);
      rows.push({ id: node.id, kind: node.kind, depth, parentId, collapsed });
      if (node.kind === 'folder' && !collapsed) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export interface Drop {
  parentId: NodeId | null;
  /** Position among the new parent's children. */
  index: number;
  depth: number;
}

/**
 * Where a row lands when dropped at `toIndex` of `rows` (the list without
 * it), having started at `fromDepth` and moved `offset` levels sideways.
 * It can go as deep as the row above allows (inside an open folder, or level
 * with a tab) and no shallower than the row below, so a folder's children
 * stay together.
 */
export function projectDrop(rows: readonly FlatRow[], toIndex: number, fromDepth: number, offset: number): Drop {
  const at = Math.max(0, Math.min(toIndex, rows.length));
  const above = rows[at - 1];
  const below = rows[at];
  const maxDepth = above ? (above.kind === 'folder' && !above.collapsed ? above.depth + 1 : above.depth) : 0;
  const minDepth = below ? Math.min(below.depth, maxDepth) : 0;
  const depth = Math.max(minDepth, Math.min(maxDepth, fromDepth + offset));

  let parentId: NodeId | null = null;
  if (above && depth > 0) {
    if (depth > above.depth) {
      parentId = above.id;
    } else {
      // Climb from the row above to its ancestor at this depth; the drop shares that ancestor's parent.
      const byId = new Map(rows.map((r) => [r.id, r]));
      let row: FlatRow | undefined = above;
      while (row && row.depth > depth) row = row.parentId ? byId.get(row.parentId) : undefined;
      parentId = row?.parentId ?? null;
    }
  }
  const index = rows.slice(0, at).filter((r) => r.parentId === parentId).length;
  return { parentId, index, depth };
}

/** Droppable ids for chords in the switcher: drop a tab there to move it to that chord. */
export const CHORD_DROP = 'chord:';

/** Levels moved sideways for a pointer offset, in whole indents. */
export const levelsFor = (dx: number) => Math.round(dx / INDENT);
