/**
 * Split view (DESIGN.md §7.9, §8.4): which tabs a window shows together, how
 * the frame divides between them, and keeping splits whole as tabs come and
 * go. Pure, so main lays the pages out with exactly the rects the shell draws.
 */
import { generateNKeysBetween } from 'fractional-indexing';
import { SPLIT, type NodeId, type SidebarNode, type SplitDirection, type SplitNode, type State, type TabNode, type WindowId } from './model';
import { children } from './nodes';

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The split a tab is a pane of (or the split itself), if any. */
export function splitOf(state: State, nodeId: NodeId): SplitNode | null {
  const node = state.nodes[nodeId];
  if (node?.kind === 'split') return node;
  const parent = node?.parentId ? state.nodes[node.parentId] : undefined;
  return parent?.kind === 'split' ? parent : null;
}

/** A split's tabs, in pane order. */
export function splitMembers(state: State, splitId: NodeId): TabNode[] {
  const split = state.nodes[splitId];
  if (split?.kind !== 'split') return [];
  return children(state, split.chordId, split.section, split.id).filter((n): n is TabNode => n.kind === 'tab');
}

/**
 * The tabs a window shows: its active tab, or every pane of the split it's
 * in (the active tab is the focused pane). A tab shows in one window at a time.
 */
export function shownTabs(state: State, windowId: WindowId): NodeId[] {
  const win = state.windows[windowId];
  const active = win ? win.activeTab[win.activeChordId] : null;
  if (!active || state.nodes[active]?.kind !== 'tab') return [];
  const split = splitOf(state, active);
  return split ? splitMembers(state, split.id).map((t) => t.id) : [active];
}

/** The tabs that show together with this one: its split's panes, or just itself. */
export function shownWith(state: State, nodeId: NodeId): NodeId[] {
  const split = splitOf(state, nodeId);
  return split ? splitMembers(state, split.id).map((t) => t.id) : [nodeId];
}

/** Equal shares for `n` panes. */
export const equalSizes = (n: number): number[] => Array.from({ length: Math.max(1, n) }, () => 1 / Math.max(1, n));

/** Shares for `n` panes from saved or edited ones: the right length, positive, summing to 1. */
export function normalizeSizes(sizes: readonly number[], n: number): number[] {
  if (sizes.length !== n || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return equalSizes(n);
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => s / total);
}

/**
 * Each pane's rect within the frame, in order. `sizes` share what's left
 * after the gaps between panes; rects are whole pixels, and the last pane
 * ends at the frame's edge.
 */
export function paneRects(frame: PaneRect, direction: SplitDirection, sizes: readonly number[], gap: number = SPLIT.gap): PaneRect[] {
  const n = sizes.length;
  if (n <= 1) return [{ ...frame }];
  const along = direction === 'row' ? frame.width : frame.height;
  const room = Math.max(0, along - gap * (n - 1));
  const shares = normalizeSizes(sizes, n);
  const rects: PaneRect[] = [];
  let used = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    used += shares[i]!;
    const end = i === n - 1 ? room : Math.round(room * used);
    const length = end - start;
    const offset = start + gap * i;
    rects.push(
      direction === 'row'
        ? { x: frame.x + offset, y: frame.y, width: length, height: frame.height }
        : { x: frame.x, y: frame.y + offset, width: frame.width, height: length },
    );
    start = end;
  }
  return rects;
}

/**
 * Dragging the divider after pane `index` by `delta` px: the two panes on
 * either side trade room, neither getting smaller than `min` px (or an even
 * split of what they have, when even that won't fit). Others keep theirs.
 */
export function resizeSizes(sizes: readonly number[], index: number, delta: number, along: number, gap: number = SPLIT.gap, min: number = SPLIT.minPane): number[] {
  const n = sizes.length;
  const shares = normalizeSizes(sizes, n);
  if (index < 0 || index >= n - 1) return shares;
  const room = Math.max(1, along - gap * (n - 1));
  const pair = (shares[index]! + shares[index + 1]!) * room;
  const floor = Math.min(min, pair / 2);
  const first = Math.min(pair - floor, Math.max(floor, shares[index]! * room + delta));
  const out = [...shares];
  out[index] = first / room;
  out[index + 1] = (pair - first) / room;
  return out;
}

/** Whether a frame `along` px long has room for `n` panes of at least the minimum. */
export const fitsPanes = (along: number, n: number, gap: number = SPLIT.gap, min: number = SPLIT.minPane): boolean => along - gap * (n - 1) >= n * min;

/**
 * Keep every split whole after tabs come and go (mutates `state`, which may
 * be an Immer draft):
 * - a split with no tabs left goes;
 * - a split of one dissolves, and its tab takes the split's place;
 * - past four panes, the extra tabs move out just after it;
 * - sizes always match its panes.
 * Returns the tabs whose layout changed, so windows showing them can lay out again.
 */
export function settleSplits(state: State): Set<NodeId> {
  const changed = new Set<NodeId>();
  const nodes = state.nodes as Record<NodeId, SidebarNode>;
  for (const split of Object.values(nodes).filter((n): n is SplitNode => n.kind === 'split')) {
    // A split holds only tabs, of its own chord and section; anything else steps out, just after it.
    const strays = Object.values(nodes).filter((n) => n.parentId === split.id && (n.kind !== 'tab' || n.chordId !== split.chordId || n.section !== split.section));
    stepOut(state, split, strays, changed);
    const members = splitMembers(state, split.id);
    if (members.length === 0) {
      delete nodes[split.id];
      continue;
    }
    if (members.length === 1) {
      const only = members[0]!;
      only.parentId = split.parentId;
      only.rank = split.rank;
      delete nodes[split.id];
      changed.add(only.id);
      continue;
    }
    // Extra panes keep their order, right after the split.
    if (members.length > SPLIT.maxPanes) stepOut(state, split, members.slice(SPLIT.maxPanes), changed);
    const count = Math.min(members.length, SPLIT.maxPanes);
    // Panes changed without saying how (a tab closed): the rest share the frame evenly.
    if (split.sizes.length !== count) {
      split.sizes = equalSizes(count);
      for (const m of members) changed.add(m.id);
    }
  }
  return changed;
}

/** Put nodes just after a split, among its siblings, in the order given. */
function stepOut(state: State, split: SplitNode, nodes: readonly SidebarNode[], changed: Set<NodeId>): void {
  if (nodes.length === 0) return;
  const siblings = children(state, split.chordId, split.section, split.parentId);
  const next = siblings[siblings.findIndex((n) => n.id === split.id) + 1];
  const ranks = generateNKeysBetween(split.rank, next && next.rank > split.rank ? next.rank : null, nodes.length);
  nodes.forEach((node, i) => {
    node.parentId = split.parentId;
    node.rank = ranks[i]!;
    if (node.kind === 'tab' && node.section !== split.section) {
      node.section = split.section;
      node.pinnedUrl = split.section === 'pinned' ? (node.pinnedUrl ?? node.url) : null;
    }
    changed.add(node.id);
  });
}
