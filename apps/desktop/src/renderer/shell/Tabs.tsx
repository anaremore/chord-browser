/**
 * The sidebar's tabs (DESIGN.md §3.2, §6.5, §7.2): Favorites shared by every
 * chord, pinned tabs and nestable folders above the Today divider, Today
 * below. Everything drags: within a list rows make room live, dragging
 * sideways in Pinned moves a row in or out of folders, dropping on the other
 * list pins or unpins, on the Favorites row adds a favorite, and on a chord
 * in the switcher moves the tab there. Every move is committed to main once,
 * on drop.
 *
 * Within a list, dnd-kit reorders rows live. Across lists it doesn't: moving
 * a DOM node into another <ul> behind React's back leaves React (and the exit
 * animation) with a node that's no longer where it put it. Instead the row it
 * would land next to shows where, and on drop React moves it.
 *
 * Today is the exception: its rows make room through React, in the order a
 * drag has them so far, because above 150 rows the list is windowed
 * (DESIGN.md §6.7, virtual.ts) and dnd-kit only knows the rows that are
 * mounted.
 *
 * Rows aren't Motion components (it costs about as much to mount as the rest
 * of a row): both lists animate their rows themselves, from their indices
 * (today-motion.ts). A row that leaves its list for good (closed, archived,
 * pinned) animates out in its own element, put back where it was; rows that
 * merely scroll out of Today's window just go.
 *
 * Split view (DESIGN.md §8.4): a split is one row; opened, its tabs show
 * under it. A tab dropped on the page goes beside it in a split, and a split's
 * tab dragged out to the sidebar leaves the split.
 */
import {
  children,
  isInternalUrl,
  sortedFavorites,
  splitMembers,
  tabForFavorite,
  uuidv7,
  type ChordId,
  type Favorite,
  type FolderNode,
  type LiveTab,
  type SidebarNode,
  type SplitNode,
  type State,
  type TabNode,
} from '@chord/core';
import { CollisionPriority } from '@dnd-kit/abstract';
import { Accessibility, AutoScroller, KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDraggable, useDragDropMonitor, useDroppable } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { SystemInfo } from '@chord/ipc';
import { size, type Appearance } from '@chord/tokens';
import { Archive, ChevronRight, Folder, FolderOpen, PictureInPicture, Plus, ScreenShare, Undo2, Volume2, VolumeX, X } from 'lucide-react';
import { motion, PresenceContext } from 'motion/react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  startTransition,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useRoving } from '../shared/a11y';
import { Favicon } from '../shared/Favicon';
import { DuetIcon } from '../shared/icons';
import type { MotionMode, SpringFor } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { announce } from './announce';
import { api } from './api';
import styles from './App.module.css';
import { canFly, flashArchive, flyToArchive, MAX_FLIGHTS, takeArchived } from './ArchiveArc';
import { enter, leave, slideFrom, type Leaving } from './today-motion';
import { DuetReadTabs } from './duet-context';
import { EdgeScroller } from './edge-scroll';
import { useKeys } from './keys';
import { SPLIT_DROP, splitDropFor, type SplitDrop } from './split-drop';
import { CHORD_DROP, flattenPinned, levelsFor, MAX_VISUAL_DEPTH, projectDrop, type Drop, type FlatRow } from './tree';
import { useListWindow } from './useListWindow';
import { grow, inOrder, inSpan, moveId, OVERSCAN, pieces, rowChanges, slotsInOrder, visibleSpan, WINDOW_ABOVE, type Placed, type RowChanges } from './virtual';

const PINNED_ZONE = 'pinned-zone';
const FAVORITES_ZONE = 'favorites-zone';
const FAVORITE = 'fav:';
/** Today's rows (tabs and splits), top to bottom. */
const todayIds = (state: State, chordId: ChordId) =>
  children(state, chordId, 'today', null)
    .filter((n) => n.kind !== 'folder')
    .map((n) => n.id);
/** What each kind of row takes as a drop (constant, so dnd-kit sees the same options every render). */
const ROW_ACCEPTS = ['tab', 'folder', 'split'];
const FRAME_ACCEPTS = ['tab'];
const FAVORITE_ACCEPTS = ['favorite', 'tab'];
/** Hovering a closed folder this long while dragging opens it (DESIGN.md §6.5). */
const SPRING_LOAD_MS = 600;

type Section = 'pinned' | 'today';

/* ---------- Drag state, shared by every list in the sidebar ---------- */

interface DragState {
  /**
   * What's being dragged: a tab, a folder, a split, or a favorite. `member`:
   * a split's tab dragged from under its split's row (not one of the list's rows).
   */
  active: { id: string; type: 'tab' | 'folder' | 'split' | 'favorite'; member: boolean } | null;
  /** Where a row dragged within Pinned would land, so it can show at that depth. */
  projected: Drop | null;
  /**
   * Today's rows in the order a drag has them so far (they make room as it
   * goes), kept after the drop until main has made the move.
   */
  order: TodayOrder | null;
}

interface TodayOrder {
  chordId: string;
  ids: readonly string[];
}

const DragContext = createContext<DragState>({ active: null, projected: null, order: null });
const useDrag = () => useContext(DragContext);

/**
 * One drag-and-drop space for the whole sidebar, so a tab can go from its
 * list to Favorites, to another chord in the switcher, or onto the page
 * beside the tab shown there (`frame`: where the page's drop zones go).
 * While a tab is dragged the shell is lifted over the page (`onLift`).
 */
export function SidebarDnd({
  state,
  chordId,
  windowId,
  frame,
  onLift,
  children: content,
}: {
  state: State;
  chordId: ChordId;
  windowId: string;
  frame: HTMLElement | null;
  onLift(lifted: boolean): void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<DragState>({ active: null, projected: null, order: null });
  const springTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Handlers read the latest state, not the one from when the drag began.
  const latest = useRef({ state, chordId, drag, windowId });
  latest.current = { state, chordId, drag, windowId };

  const clearSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current.timer);
    springTimer.current = null;
  };
  /** A closed folder right above the dragged row opens after a moment. */
  const springLoad = (folderId: string | null) => {
    if (springTimer.current?.id === folderId) return;
    clearSpring();
    if (!folderId) return;
    springTimer.current = {
      id: folderId,
      timer: setTimeout(() => {
        springTimer.current = null;
        void api.state.dispatch({ t: 'folder.toggle', nodeId: folderId, collapsed: false });
      }, SPRING_LOAD_MS),
    };
  };

  /** The Pinned rows as drawn while dragging (a dragged folder travels closed). */
  const pinnedRows = () => {
    const { state: s, chordId: c, drag: d } = latest.current;
    return flattenPinned(s, c, d.active?.type === 'folder' ? d.active.id : null);
  };

  /** Where a row dragged within Pinned lands, from its live index and how far it moved sideways. */
  const projectWithin = (sourceId: string, index: number, dx: number): Drop | null => {
    const rows = pinnedRows();
    const from = rows.find((r) => r.id === sourceId);
    if (!from) return null;
    const without = rows.filter((r) => r.id !== sourceId);
    return projectDrop(without, index, from.depth, levelsFor(dx));
  };

  return (
    <DragContext.Provider value={drag}>
      <DragDropProvider
        // The rows are a tree with keyboard moves of its own (treeKeys below), so dnd-kit's own
        // screen-reader layer (a "draggable" role description, a pressed state on rows) stays out.
        // Today scrolls at its edges with EdgeScroller, which reads no layout as the pointer moves.
        plugins={(defaults) => [...defaults.filter((plugin) => plugin !== Accessibility && plugin !== AutoScroller), EdgeScroller]}
        sensors={(defaults) => [
          // The keyboard moves rows its own way (treeKeys below), so dnd-kit's keyboard sensor stays out.
          ...defaults.filter((sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor),
          // A few pixels of travel before a drag starts, so clicks stay clicks.
          PointerSensor.configure({ activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 4 })] }),
        ]}
        onDragStart={(event) => {
          const source = event.operation.source;
          if (!source) return;
          const type = source.type === 'folder' || source.type === 'favorite' || source.type === 'split' ? source.type : 'tab';
          setDrag({ active: { id: String(source.id), type, member: type === 'tab' && !isSortable(source) }, projected: null, order: null });
          // A tab can be dropped on the page, so the shell goes over it to show where.
          if (type === 'tab') onLift(true);
        }}
        onDragMove={(event) => {
          const { source, position } = event.operation;
          if (!isSortable(source) || source.group !== 'pinned') return;
          const projected = projectWithin(String(source.id), source.index, position.current.x - position.initial.x);
          const before = latest.current.drag.projected;
          if (projected && (projected.depth !== before?.depth || projected.parentId !== before?.parentId || projected.index !== before?.index)) {
            setDrag((d) => ({ ...d, projected }));
          }
          // A closed folder just above the row: spring it open.
          const rows = pinnedRows().filter((r) => r.id !== String(source.id));
          const above = rows[source.index - 1];
          springLoad(above?.kind === 'folder' && above.collapsed ? above.id : null);
        }}
        onDragOver={(event, manager) => {
          // Live reordering stays within a list (see the note at the top).
          const { source, target } = event.operation;
          if (isSortable(source) && isSortable(target) && source.group !== target.group) event.preventDefault();
          // Within Today, React makes room: the dragged row moves to where the row under it is.
          if (isSortable(source) && isSortable(target) && source.group === 'today' && target.group === 'today') {
            event.preventDefault();
            const { state: s, chordId: c, drag: d } = latest.current;
            const ids = d.order?.chordId === c ? d.order.ids : todayIds(s, c);
            const next = moveId(ids, String(source.id), String(target.id));
            if (next !== ids) {
              const order = { chordId: c, ids: next };
              // A second move before React draws the first builds on it.
              latest.current = { ...latest.current, drag: { ...d, order } };
              setDrag((dd) => ({ ...dd, order }));
              // As dnd-kit does after its own moves: the dragged row is under the pointer now, until it moves on.
              manager.collisionObserver.disable();
              void manager.renderer.rendering
                .then(() => manager.actions.setDropTarget(source.id))
                .finally(() => manager.collisionObserver.enable());
            }
          }
          // Dragging over a closed folder from the other list springs it open too.
          const node = target ? latest.current.state.nodes[String(target.id)] : undefined;
          if (isSortable(source) && source.group !== 'pinned') springLoad(node?.kind === 'folder' && node.collapsed ? node.id : null);
        }}
        onDragEnd={(event) => {
          const { projected, order } = latest.current.drag;
          if (latest.current.drag.active?.type === 'tab') onLift(false);
          setDrag({ active: null, projected: null, order: null });
          clearSpring();
          if (event.canceled) return;
          const { source, target, position } = event.operation;
          if (!source) return;
          const { state: s, chordId: c, windowId: w } = latest.current;
          const targetId = target ? String(target.id) : '';
          const below = () => {
            const box = target?.shape?.boundingRectangle;
            return box ? position.current.y > box.top + box.height / 2 : false;
          };

          // Favorites: reorder among themselves.
          if (source.type === 'favorite') {
            if (isSortable(source) && source.group === 'favorites') {
              void api.state.dispatch({ t: 'favorite.move', favoriteId: String(source.id).slice(FAVORITE.length), index: source.index });
            }
            return;
          }
          const nodeId = String(source.id);
          const node = s.nodes[nodeId];
          if (!node) return;

          // Onto the page: beside the tab shown there, in a split (or to another place in the split shown).
          if (targetId === SPLIT_DROP) {
            const box = target?.shape?.boundingRectangle;
            const drop = box
              ? splitDropFor(s, w, nodeId, { x: position.current.x - box.left, y: position.current.y - box.top }, { width: box.width, height: box.height })
              : null;
            if (drop) void api.state.dispatch(drop.command);
            return;
          }
          // Onto a chord in the switcher: the tab moves there.
          if (targetId.startsWith(CHORD_DROP)) {
            if (node.kind === 'tab') void api.sidebar.moveToChord(nodeId, targetId.slice(CHORD_DROP.length));
            return;
          }
          // Onto Favorites: a new favorite, where it was dropped.
          if (targetId === FAVORITES_ZONE || (isSortable(target) && target.group === 'favorites')) {
            if (node.kind !== 'tab') return;
            const order = sortedFavorites(s);
            const at = isSortable(target) ? order.findIndex((f) => FAVORITE + f.id === targetId) : order.length;
            const box = target?.shape?.boundingRectangle;
            const after = box ? position.current.x > box.left + box.width / 2 : true;
            void api.state.dispatch({ t: 'favorite.add', favoriteId: uuidv7(), nodeId, index: at < 0 ? order.length : at + (after ? 1 : 0) });
            return;
          }
          if (targetId === PINNED_ZONE) {
            void api.state.dispatch({ t: 'node.move', nodeId, section: 'pinned', index: 0, parentId: null });
            return;
          }
          // A split's tab dragged from under its row isn't one of the list's rows: it lands beside one, leaving
          // its split (DESIGN.md §8.4). Let go away from any row, a row or more from where it started, it leaves
          // its split all the same, landing just after it.
          const from = isSortable(source) ? (source.group as Section) : null;
          if (!from && (node.kind !== 'tab' || source.type !== 'tab')) return;
          const to = isSortable(target) && (target.group === 'pinned' || target.group === 'today') ? (target.group as Section) : null;
          if (!from && !to) {
            const moved = Math.hypot(position.current.x - position.initial.x, position.current.y - position.initial.y);
            if (moved >= size.row) void api.state.dispatch({ t: 'split.remove', nodeId });
            return;
          }

          // Within Pinned: where the projection says, at the depth it showed.
          if (isSortable(source) && from === 'pinned' && (to === 'pinned' || to === null)) {
            const drop = projected ?? projectWithin(nodeId, source.index, position.current.x - position.initial.x);
            if (drop) void api.state.dispatch({ t: 'node.move', nodeId, section: 'pinned', index: drop.index, parentId: drop.parentId });
            return;
          }
          // Within Today: where it made room. The rows stay in that order until main has the move, so nothing jumps back.
          if (isSortable(source) && from === 'today' && (to === 'today' || to === null)) {
            const at = order?.chordId === c ? order.ids.indexOf(nodeId) : -1;
            if (order && at >= 0) setDrag((d) => ({ ...d, order }));
            void api.state
              .dispatch({ t: 'node.move', nodeId, section: 'today', index: at >= 0 ? at : source.index })
              .finally(() => setDrag((d) => (d.order === order ? { ...d, order: null } : d)));
            return;
          }
          // Across: above the row it was dropped on, or below if past its middle. The row's place
          // comes from our own order; dnd-kit's index can lag behind after earlier drops.
          if (to === 'today') {
            const at = children(s, c, 'today', null).findIndex((n) => n.id === targetId);
            if (at >= 0) void api.state.dispatch({ t: 'node.move', nodeId, section: 'today', index: at + (below() ? 1 : 0) });
            return;
          }
          if (to === 'pinned') {
            const rows = flattenPinned(s, c);
            const at = rows.findIndex((r) => r.id === targetId);
            if (at < 0) return;
            const drop = projectDrop(rows, at + (below() ? 1 : 0), 0, levelsFor(position.current.x - position.initial.x));
            void api.state.dispatch({ t: 'node.move', nodeId, section: 'pinned', index: drop.index, parentId: drop.parentId });
          }
        }}
      >
        {content}
        {frame && drag.active?.type === 'tab' && <SplitDropZone state={state} windowId={windowId} host={frame} />}
      </DragDropProvider>
    </DragContext.Provider>
  );
}

/**
 * Split view's drop zones over the page (DESIGN.md §8.4), drawn in `host`
 * (laid over the content frame) while a tab is dragged: where the tab would
 * go fills with the accent at 12%, ringed at 50%.
 */
function SplitDropZone({ state, windowId, host }: { state: State; windowId: string; host: HTMLElement }) {
  const { ref, isDropTarget } = useDroppable({ id: SPLIT_DROP, type: 'frame', accept: FRAME_ACCEPTS });
  const [drop, setDrop] = useState<SplitDrop | null>(null);
  const latest = useRef(state);
  latest.current = state;
  useDragDropMonitor({
    onDragMove(event) {
      const { source, position } = event.operation;
      if (!source) return;
      const box = host.getBoundingClientRect();
      const point = { x: position.current.x - box.left, y: position.current.y - box.top };
      const inside = point.x >= 0 && point.y >= 0 && point.x <= box.width && point.y <= box.height;
      const next = inside ? splitDropFor(latest.current, windowId, String(source.id), point, { width: box.width, height: box.height }) : null;
      setDrop((d) => (JSON.stringify(d?.rect) === JSON.stringify(next?.rect) ? d : next));
    },
  });
  const shown = isDropTarget ? drop : null;
  return createPortal(
    <div ref={ref} className={styles.dropTarget} data-testid="split-drop" data-zone={shown ? JSON.stringify(shown.rect) : undefined}>
      {shown && (
        <span
          className={styles.dropZone}
          style={{ left: shown.rect.x, top: shown.rect.y, width: shown.rect.width, height: shown.rect.height }}
          aria-hidden
        />
      )}
    </div>,
    host,
  );
}

/* ---------- Rows ---------- */

/** A row picked up with Space, and where it was, so Esc can put it back. */
interface Moving {
  id: string;
  section: Section;
  parentId: string | null;
  index: number;
}

/**
 * What every row in a list shares. It's the same object from render to render,
 * so a row only redraws when its own props change (a tab switch redraws two
 * rows, not two hundred).
 */
interface RowContext {
  windowId: string;
  info: SystemInfo;
  appearance: Appearance;
  spring: SpringFor;
  setRenaming(id: string | null): void;
  toggleSplit(id: string, open: boolean): void;
  /** The close button's tooltip, keycap included: the same for every row. */
  closeTitle: { pinned: string; today: string };
  /** The speaker's tooltips, keycap included. */
  muteTitle: { mute: string; unmute: string };
}

/**
 * The props every row has. A row gets what it shows and nothing else, so
 * changes elsewhere don't redraw it. Drags come as props, not from the
 * context: a Pinned row leaving its list keeps animating out with the props
 * it had, and a re-render mid-exit (when the drag ends) would stop its exit for good.
 */
interface RowBase {
  /** Its place in the tree: level from 0, position among its siblings from 1, and how many they are. */
  depth: number;
  pos: number;
  size: number;
  ctx: RowContext;
}

/** What a row's sortable says about it: it's being dragged, or a drag would land on it. */
interface Sorting {
  dragging: boolean;
  target: boolean;
}
const RESTING: Sorting = { dragging: false, target: false };

/**
 * False while a row mounts, true from the next frame: for what can wait that
 * long. It's rendered as a transition, so many rows mounting at once (a chord
 * switch, an Undo, a scroll) share the work out without holding up a frame.
 */
function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => startTransition(() => setSettled(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  return settled;
}

interface RowSortableProps {
  id: string;
  index: number;
  group: Section;
  type: 'tab' | 'folder' | 'split';
  element: RefObject<HTMLElement | null>;
  handle: RefObject<HTMLElement | null>;
  onChange(sorting: Sorting): void;
}

/**
 * A row's part in drag and drop (dnd-kit's sortable): it finds the row and
 * its handle by ref, and says when the row is dragged or would take a drop.
 */
function RowSortable({ id, index, group, type, element, handle, onChange }: RowSortableProps) {
  const { isDragging, isDropTarget } = useSortable({ id, index, group, type, accept: ROW_ACCEPTS, element, handle });
  useLayoutEffect(() => onChange(isDragging || isDropTarget ? { dragging: isDragging, target: isDropTarget } : RESTING), [isDragging, isDropTarget, onChange]);
  return null;
}

/**
 * A row's sortable (`binder`, drawn inside the row), set up a frame after the
 * row mounts: it costs about as much as the rest of the row, and a drag
 * starting measures every one. Until then the row can't be dragged or dropped
 * on, for a frame no hand can drag in. Only rows that show have one
 * (`shows`): Today's rows just past the viewport don't until they scroll in.
 */
function useRowSortable(input: Omit<RowSortableProps, 'element' | 'handle' | 'onChange'>, shows: boolean) {
  const element = useRef<HTMLLIElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<Sorting>(RESTING);
  const settled = useSettled();
  const binder = settled && shows ? <RowSortable {...input} element={element} handle={handle} onChange={setSorting} /> : null;
  return { element, handle, isDragging: sorting.dragging, isDropTarget: sorting.target, binder };
}

/**
 * What makes a row a tree item (DESIGN.md §10: the sidebar is an ARIA tree).
 * The rows are drawn flat, indented by depth, so the tree's shape is told by
 * level, position and size. A row is named by its text. Its own buttons (×,
 * ↩, Stop sharing) are for the pointer: the keyboard has Delete, and the
 * row's menu (Shift+F10 or the menu key) has the rest.
 */
function treeItem({ depth, pos, size: count }: Pick<RowBase, 'depth' | 'pos' | 'size'>, tooltip: string) {
  return {
    role: 'treeitem',
    title: tooltip,
    // Focusable from the moment it mounts (the trees' roving Tab stop then makes one of them 0): a windowed
    // list mounts a row the keyboard asks for and focuses it in the same frame.
    tabIndex: -1,
    'aria-level': depth + 1,
    'aria-setsize': count,
    'aria-posinset': pos,
  } as const;
}


/** Where a row's menu opens: at the pointer, or under the row when the keyboard asked for it. */
function menuPoint(e: MouseEvent): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom };
}

/** A pinned tab is "away" once it has left its pinned site; ↩ takes it back. */
function awayFromHome(tab: TabNode): boolean {
  if (!tab.pinnedUrl) return false;
  try {
    return new URL(tab.url).origin !== new URL(tab.pinnedUrl).origin;
  } catch {
    return false;
  }
}

/** Indent for a row (DESIGN.md §3.2: 12 px per level, visually capped at 4). */
const indent = (depth: number) => ({ '--depth': Math.min(depth, MAX_VISUAL_DEPTH) }) as CSSProperties;

/** A tab's icon (Chord's own pages wear Chord's glyphs, DESIGN.md §7.3: a box for the archive) and title. */
function TabFace({ tab, live, appearance }: { tab: TabNode; live: LiveTab | undefined; appearance: Appearance }) {
  return (
    <>
      {isInternalUrl(tab.url) ? (
        <Archive className={styles.rowGlyph} size={16} strokeWidth={1.75} aria-hidden />
      ) : (
        <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} loading={Boolean(live?.loading) && !tab.favicon} appearance={appearance} />
      )}
      <span className={styles.ellipsis}>{pageTitle(tab) || displayHost(tab.url) || 'New tab'}</span>
    </>
  );
}

/** A split's tabs' icons in a line, and their titles joined ("Docs + Figma"). */
function SplitFace({ panes, appearance }: { panes: readonly TabNode[]; appearance: Appearance }) {
  return (
    <>
      <span className={styles.splitIcons} aria-hidden>
        {panes.slice(0, 4).map((p) =>
          isInternalUrl(p.url) ? (
            <Archive key={p.id} className={styles.rowGlyph} size={16} strokeWidth={1.75} />
          ) : (
            <Favicon key={p.id} url={p.url} title={p.title} favicon={p.favicon} loading={false} appearance={appearance} />
          ),
        )}
      </span>
      <span className={styles.ellipsis}>
        <span className="sr-only">Split: </span>
        {splitTitle(panes)}
      </span>
    </>
  );
}

const splitTitle = (panes: readonly TabNode[]) => panes.map((p) => pageTitle(p) || displayHost(p.url) || 'New tab').join(' + ');

/**
 * A tab making sound (muted, it still is, silently) shows a speaker in the
 * slot just before × (DESIGN.md §7.2); clicking it mutes or unmutes the tab.
 * For the pointer, like the row's other buttons: the keyboard has the row's
 * menu and Mute or unmute tab's keys. The row's description says what it shows.
 */
function Speaker({ tab, ctx }: { tab: TabNode; ctx: RowContext }) {
  const muted = Boolean(tab.muted);
  const Glyph = muted ? VolumeX : Volume2;
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className={`${styles.pip} ${styles.speaker}`}
        aria-label={muted ? 'Unmute tab' : 'Mute tab'}
        title={muted ? ctx.muteTitle.unmute : ctx.muteTitle.mute}
        onClick={() => void api.state.dispatch({ t: 'tab.mute', nodeId: tab.id, muted: !muted })}
      >
        <Glyph size={14} strokeWidth={2} />
      </button>
      <span id={`audio-${tab.id}`} hidden>
        {muted ? 'Muted' : 'Playing sound'}
      </span>
    </>
  );
}

interface TabRowProps extends RowBase {
  tab: TabNode;
  live: LiveTab | undefined;
  index: number;
  /** It shows (in Pinned, or in Today's viewport), or it's being moved: it takes part in drag and drop. */
  shows: boolean;
  section: Section;
  isActive: boolean;
  /** Duet read it (DESIGN.md §7.8). */
  duetRead: boolean;
  /** Picked up with the keyboard (Space). */
  moving: boolean;
  /** Where it would land while it's dragged in Pinned. */
  projected: Drop | null;
}

const TabRow = memo(function TabRow({ tab, live, index, shows, section, depth, pos, size: count, isActive, duetRead, moving, projected, ctx }: TabRowProps) {
  // The row's surface is the drag handle; the <li> is the tree item that takes focus.
  const { element, handle, isDragging, isDropTarget, binder } = useRowSortable({ id: tab.id, index, group: section, type: 'tab' }, shows);
  const { windowId, appearance, spring } = ctx;
  const lifted = isDragging || moving;
  const pinned = section === 'pinned';
  const away = pinned && awayFromHome(tab);
  // A tab whose page isn't loaded (asleep, or not opened since launch) shows a faded icon (DESIGN.md §7.2).
  const asleep = !live && !isActive;
  // An unloaded pinned tab has nothing to close, so it shows no ×.
  const unloaded = pinned && asleep;
  // Its video popped out when you switched away (auto picture-in-picture).
  const popped = Boolean(live?.pip);
  // It's sharing your screen: the slot shows a Stop button instead, which matters more.
  const sharing = Boolean(live?.sharing);
  // It's making sound (muted, it still is, silently): the slot shows a speaker, unless one of those is there.
  const audible = Boolean(live?.audible) && !sharing && !popped;
  const dispatch = api.state.dispatch;
  const close = () => void dispatch({ t: 'tab.close', windowId, nodeId: tab.id });
  const shownDepth = isDragging && projected ? projected.depth : depth;
  return (
    <li
      ref={element}
      {...treeItem({ depth, pos, size: count }, pageTitle(tab) || tab.url)}
      aria-selected={isActive}
      aria-current={isActive ? 'page' : undefined}
      aria-describedby={sharing ? `sharing-${tab.id}` : popped ? `pip-${tab.id}` : audible ? `audio-${tab.id}` : undefined}
      className={styles.item}
      style={indent(shownDepth)}
      data-row="tab"
      data-id={tab.id}
      data-parent={tab.parentId ?? undefined}
      // Pinned tabs get a hover preview (DESIGN.md §7.6).
      data-preview={pinned || undefined}
      // A pinned tab that hasn't been opened yet reads quieter (DESIGN.md §7.2).
      data-unloaded={unloaded || undefined}
      data-asleep={asleep || undefined}
      data-slot={popped || sharing || audible || undefined}
      data-dragging={lifted || undefined}
      data-drop-target={(isDropTarget && !isDragging) || undefined}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll
      }}
      onAuxClick={(e: MouseEvent) => {
        if (e.button === 1) close();
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(tab.id, menuPoint(e));
      }}
    >
      {binder}
      {isActive && <motion.span layoutId={`active-pill-${tab.chordId}`} className={styles.activePill} transition={spring('snappy', 'tabMoves')} />}
      <div
        ref={handle}
        className={`${styles.row} ${isActive ? styles.active : ''}`}
        data-activate
        onClick={() => void dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
      >
        <TabFace tab={tab} live={live} appearance={appearance} />
        {duetRead && <DuetIcon className={styles.duetRead} size={12} strokeWidth={2} role="img" aria-label="Duet read this tab" />}
      </div>
      {sharing ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className={`${styles.pip} ${styles.sharing}`}
          aria-label="Stop sharing your screen"
          title="Stop sharing your screen"
          onClick={() => void api.share.stop(tab.id)}
        >
          <ScreenShare size={14} strokeWidth={2} />
        </button>
      ) : popped && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className={styles.pip}
          aria-label="Back to the tab"
          title="Back to the tab"
          onClick={() => void dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
        >
          <PictureInPicture size={14} strokeWidth={2} />
        </button>
      )}
      {sharing && (
        <span id={`sharing-${tab.id}`} hidden>
          Sharing your screen
        </span>
      )}
      {popped && !sharing && (
        <span id={`pip-${tab.id}`} hidden>
          Its video plays in a small window
        </span>
      )}
      {audible && <Speaker tab={tab} ctx={ctx} />}
      {away ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className={styles.close}
          aria-label="Back to pinned page"
          title={`Back to ${displayHost(tab.pinnedUrl!)}`}
          onClick={() => void dispatch({ t: 'tab.navigate', nodeId: tab.id, url: tab.pinnedUrl! })}
        >
          <Undo2 size={14} strokeWidth={2} />
        </button>
      ) : unloaded ? null : (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className={styles.close}
          aria-label={`Close ${tab.title || 'tab'}`}
          title={pinned ? ctx.closeTitle.pinned : ctx.closeTitle.today}
          onClick={close}
        >
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </li>
  );
});

interface FolderRowProps extends RowBase {
  folder: FolderNode;
  index: number;
  moving: boolean;
  projected: Drop | null;
  renaming: boolean;
}

const FolderRow = memo(function FolderRow({ folder, index, depth, pos, size: count, moving, projected, renaming, ctx }: FolderRowProps) {
  const { element, handle, isDragging, isDropTarget, binder } = useRowSortable({ id: folder.id, index, group: 'pinned', type: 'folder' }, true);
  const { setRenaming } = ctx;
  // A folder being dragged travels closed.
  const open = !folder.collapsed && !isDragging;
  const shownDepth = isDragging && projected ? projected.depth : depth;
  const toggle = () => void api.state.dispatch({ t: 'folder.toggle', nodeId: folder.id, collapsed: !folder.collapsed });
  const commit = (title: string) => {
    if (title.trim() && title.trim() !== folder.title) void api.state.dispatch({ t: 'folder.rename', nodeId: folder.id, title });
    setRenaming(null);
  };
  const Glyph = open ? FolderOpen : Folder;
  return (
    <li
      ref={element}
      {...treeItem({ depth, pos, size: count }, folder.title)}
      aria-expanded={open}
      className={styles.item}
      style={indent(shownDepth)}
      data-row="folder"
      data-id={folder.id}
      data-parent={folder.parentId ?? undefined}
      data-preview
      data-dragging={(isDragging || moving) || undefined}
      data-drop-target={(isDropTarget && !isDragging) || undefined}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(folder.id, menuPoint(e));
      }}
    >
      {binder}
      {/* The row's surface is always there: it's the drag handle, and dnd-kit keeps whatever it first found. */}
      <div ref={handle} className={styles.row} data-activate onClick={toggle} onDoubleClick={() => setRenaming(folder.id)}>
        <ChevronRight className={styles.chevron} data-open={open || undefined} size={12} strokeWidth={2} aria-hidden />
        <Glyph className={styles.rowGlyph} size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>{folder.title}</span>
      </div>
      {renaming && (
        // Over the title, where the name is typed.
        <input
          className={styles.folderInput}
          defaultValue={folder.title}
          aria-label="Folder name"
          maxLength={64}
          spellCheck={false}
          // Focus and select on mount, so typing replaces the name.
          ref={(el) => {
            if (el && document.activeElement !== el) {
              el.focus();
              el.select();
            }
          }}
          onKeyDown={(e) => {
            // The tree's keys stay out of the name being typed.
            e.stopPropagation();
            if (e.key === 'Enter') commit(e.currentTarget.value);
            else if (e.key === 'Escape') setRenaming(null);
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.closest<HTMLElement>('[data-row]')?.focus();
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      )}
    </li>
  );
});

interface SplitRowProps extends RowBase {
  split: SplitNode;
  /** As TabRowProps.shows. */
  shows: boolean;
  /** Its tabs, left to right. */
  panes: readonly TabNode[];
  index: number;
  section: Section;
  /** One of its tabs is the one on screen. */
  isActive: boolean;
  /** Opened, to list its tabs under it. */
  open: boolean;
  moving: boolean;
  projected: Drop | null;
}

/**
 * A split (DESIGN.md §7.9): one row, its tabs' icons in a line and their
 * titles joined ("Docs + Figma"). Clicking shows the split, focused where it
 * was last; the chevron (or →) opens it to list its tabs.
 */
const SplitRow = memo(function SplitRow({ split, panes, index, shows, section, depth, pos, size: count, isActive, open, moving, projected, ctx }: SplitRowProps) {
  const { element, handle, isDragging, isDropTarget, binder } = useRowSortable({ id: split.id, index, group: section, type: 'split' }, shows);
  const { windowId, appearance, spring, toggleSplit } = ctx;
  const shownDepth = isDragging && projected ? projected.depth : depth;
  // The pane used last is the one focused again.
  const show = () => {
    const recent = [...panes].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (recent && !isActive) void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: recent.id });
  };
  return (
    <li
      ref={element}
      {...treeItem({ depth, pos, size: count }, splitTitle(panes))}
      aria-expanded={open}
      aria-selected={isActive}
      aria-current={isActive ? 'page' : undefined}
      className={styles.item}
      style={indent(shownDepth)}
      data-row="split"
      data-id={split.id}
      data-parent={split.parentId ?? undefined}
      data-dragging={(isDragging || moving) || undefined}
      data-drop-target={(isDropTarget && !isDragging) || undefined}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(split.id, menuPoint(e));
      }}
    >
      {binder}
      {isActive && <motion.span layoutId={`active-pill-${split.chordId}`} className={styles.activePill} transition={spring('snappy', 'tabMoves')} />}
      <div ref={handle} className={`${styles.row} ${isActive ? styles.active : ''}`} data-activate onClick={show}>
        <SplitFace panes={panes} appearance={appearance} />
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className={styles.close}
        data-split-toggle
        aria-label={open ? 'Hide the tabs in this split' : 'Show the tabs in this split'}
        title={open ? 'Hide tabs' : 'Show tabs'}
        onClick={() => toggleSplit(split.id, !open)}
      >
        <ChevronRight className={styles.chevron} data-open={open || undefined} size={14} strokeWidth={2} />
      </button>
    </li>
  );
});

interface SplitMemberRowProps extends RowBase {
  tab: TabNode;
  live: LiveTab | undefined;
  /** Its pane has the focus. */
  focused: boolean;
}

/**
 * One of a split's tabs, listed under its opened row. Click focuses its pane;
 * drag it to a place in the sidebar to take it out of the split, or onto the
 * page to move its pane.
 */
const SplitMemberRow = memo(function SplitMemberRow({ tab, live, depth, pos, size: count, focused, ctx }: SplitMemberRowProps) {
  const { ref, handleRef, isDragging } = useDraggable({ id: tab.id, type: 'tab' });
  const { windowId, appearance } = ctx;
  const close = () => void api.state.dispatch({ t: 'tab.close', windowId, nodeId: tab.id });
  const audible = Boolean(live?.audible);
  return (
    <li
      ref={ref}
      {...treeItem({ depth, pos, size: count }, pageTitle(tab) || tab.url)}
      aria-selected={focused}
      aria-current={focused ? 'true' : undefined}
      aria-describedby={audible ? `audio-${tab.id}` : undefined}
      className={styles.item}
      style={indent(depth)}
      data-row="tab"
      data-id={tab.id}
      data-parent={tab.parentId ?? undefined}
      data-focused-pane={focused || undefined}
      data-slot={audible || undefined}
      data-dragging={isDragging || undefined}
      onAuxClick={(e: MouseEvent) => {
        if (e.button === 1) close();
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(tab.id, menuPoint(e));
      }}
    >
      <div
        ref={handleRef}
        className={styles.row}
        data-activate
        onClick={() => void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
      >
        <TabFace tab={tab} live={live} appearance={appearance} />
      </div>
      {audible && <Speaker tab={tab} ctx={ctx} />}
      <button type="button" tabIndex={-1} aria-hidden className={styles.close} aria-label={`Close ${tab.title || 'tab'}`} title={ctx.closeTitle.today} onClick={close}>
        <X size={14} strokeWidth={2} />
      </button>
    </li>
  );
});

/* ---------- How the lists' rows move ---------- */

/** Rows dnd-kit is dragging or dropping: it moves those itself. */
const DND_BUSY = '[data-dnd-dragging], [data-dnd-dropping], [data-dnd-placeholder]';

/** Every row is one height (DESIGN.md §7.2), so a row's place in its list is its index times this. */
const ROW = size.row;

/** A list's rows in the DOM, in order, by ID (not dnd-kit's stand-in for a dragged one). */
function rowsIn(list: HTMLElement): [string, HTMLElement][] {
  const rows: [string, HTMLElement][] = [];
  for (const el of list.children)
    if (el instanceof HTMLElement && el.dataset['row'] && !el.hasAttribute('data-dnd-placeholder')) rows.push([el.dataset['id']!, el]);
  return rows;
}

const busy = (el: HTMLElement) => el.matches(DND_BUSY);

/* ---------- Leaving a list ---------- */

/**
 * A row that left its list for good goes its own way where it was (rows that
 * scroll out of Today's window aren't these): its element, which React has
 * just taken out of the list, is put back over the list in `layer` while it
 * animates out, then dropped. Nothing is drawn again. Closed rows drift left,
 * pinned ones lift toward Pinned, archived ones shrink and fade while their
 * favicon flies to the Archive button (DESIGN.md §6.5, today-motion.ts).
 */
function playExit(layer: HTMLElement, el: HTMLElement, top: number, kind: Leaving, flight: number | null): void {
  const icon = flight === null ? null : el.querySelector(`.${styles.row} > :first-child`);
  // No longer a row: out of the tree, out of the keyboard's way, and not what anything looking for rows finds.
  for (const name of ['data-row', 'data-id', 'role', 'tabindex']) el.removeAttribute(name);
  el.classList.add(styles.exitRow!);
  el.dataset['exit'] = kind;
  // Its favicon flies from where it shows; the row's own copy is hidden, so it seems to leave.
  if (icon) el.dataset['flying'] = '';
  el.style.top = `${top}px`;
  layer.append(el);
  if (icon) flyToArchive(icon, flight!);
  const done = () => el.remove();
  leave(el, kind).finished.then(done, done);
}

/**
 * Where to drop a tab to pin it while nothing is pinned yet: laid over the
 * Today divider, so the rows don't jump down when a drag begins (with the
 * keyboard they'd land somewhere else).
 */
function PinnedDropZone() {
  const { ref, isDropTarget } = useDroppable({ id: PINNED_ZONE, type: 'section', accept: ROW_ACCEPTS, collisionPriority: CollisionPriority.Low });
  return (
    <div ref={ref} className={`${styles.pinZone} ${styles.pinZoneOver}`} data-over={isDropTarget || undefined}>
      Drop here to pin
    </div>
  );
}

/* ---------- Favorites ---------- */

/** What a favorite's tab is doing with sound: playing it, playing it muted, or neither. */
type TileSound = 'playing' | 'muted' | null;

function FavoriteTile({
  favorite,
  index,
  active,
  sound,
  appearance,
  windowId,
}: {
  favorite: Favorite;
  index: number;
  active: boolean;
  sound: TileSound;
  appearance: Appearance;
  windowId: string;
}) {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: FAVORITE + favorite.id, index, group: 'favorites', type: 'favorite', accept: FAVORITE_ACCEPTS });
  const { active: dragged } = useDrag();
  const label = favorite.title || displayHost(favorite.url);
  const Glyph = sound === 'muted' ? VolumeX : Volume2;
  return (
    <li ref={ref} className={styles.favoriteItem} data-dragging={isDragging || undefined} data-drop-target={(dragged && isDropTarget && !isDragging) || undefined}>
      <button
        ref={handleRef}
        type="button"
        className={styles.favorite}
        aria-label={sound ? `${label}, ${sound === 'muted' ? 'muted' : 'playing sound'}` : label}
        aria-current={active ? 'page' : undefined}
        title={label}
        onClick={() => void api.state.dispatch({ t: 'favorite.open', windowId, favoriteId: favorite.id })}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          void api.menu.favorite(favorite.id, { x: e.clientX, y: e.clientY });
        }}
      >
        <Favicon url={favorite.url} title={favorite.title} favicon={favorite.favicon} appearance={appearance} />
        {/* Its tab makes sound: a small speaker on the tile's corner (its row, in the list, mutes it). */}
        {sound && (
          <span className={styles.favoriteSound} aria-hidden>
            <Glyph size={10} strokeWidth={2.25} />
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Where a tab goes to become the first favorite: laid over the address while
 * a tab is dragged, so nothing below shifts when the drag begins.
 */
function FavoritesDropZone() {
  const { ref, isDropTarget } = useDroppable({ id: FAVORITES_ZONE, type: 'favorites', accept: 'tab', collisionPriority: CollisionPriority.Low });
  return (
    <div ref={ref} className={`${styles.pinZone} ${styles.favoritesZone}`} data-over={isDropTarget || undefined}>
      Drop here for Favorites
    </div>
  );
}

/**
 * Favorites (ROADMAP.md Q5): sites every chord shares, as tiles at the top of
 * the sidebar. A tile switches to this chord's tab on that site, or opens it.
 */
export function FavoritesRow({ state, windowId, activeId, appearance }: { state: State; windowId: string; activeId: string | null; appearance: Appearance }) {
  const { active } = useDrag();
  const favorites = sortedFavorites(state);
  const chordId = state.windows[windowId]?.activeChordId;
  if (favorites.length === 0) return active?.type === 'tab' ? <FavoritesDropZone /> : null;
  return (
    <FavoritesList>
      {favorites.map((favorite, index) => {
        const tab = chordId ? tabForFavorite(state, chordId, favorite.url) : undefined;
        const sound: TileSound = tab && state.live[tab.id]?.audible ? (tab.muted ? 'muted' : 'playing') : null;
        return (
          <FavoriteTile
            key={favorite.id}
            favorite={favorite}
            index={index}
            active={Boolean(activeId && tab?.id === activeId)}
            sound={sound}
            appearance={appearance}
            windowId={windowId}
          />
        );
      })}
    </FavoritesList>
  );
}

/** The row of tiles. A tab dropped anywhere on it, not just on a tile, becomes a favorite at the end. */
function FavoritesList({ children: tiles }: { children: ReactNode }) {
  const { ref } = useDroppable({ id: FAVORITES_ZONE, type: 'favorites', accept: 'tab', collisionPriority: CollisionPriority.Low });
  return (
    <ul ref={ref} className={styles.favorites} aria-label="Favorites">
      {tiles}
    </ul>
  );
}

/* ---------- Keyboard: the sidebar as a tree (DESIGN.md §14.3) ---------- */

/** A row as the keyboard walks the trees: Pinned's, then Today's, whether or not it's mounted. */
interface TreeRow {
  id: string;
  /** The folder or split it's listed under. */
  parent: string | null;
}

interface TreeKeys {
  state: State;
  windowId: string;
  info: SystemInfo;
  /** A pointer drag is under way. */
  dragging: boolean;
  moving: Moving | null;
  setMoving(moving: Moving | null): void;
  setRenaming(id: string): void;
  openSplits: ReadonlySet<string>;
  toggleSplit(id: string, open: boolean): void;
  /** Every row in order, from the state: a windowed list doesn't have them all in the DOM. */
  rows(): readonly TreeRow[];
  /** Puts the keyboard on a row, scrolling it into view first (and mounting it, in a windowed list). */
  focus(id: string): void;
}

/**
 * With a row picked up (Space), ↑ ↓ move it among its siblings, committed as
 * it goes; Space or Enter drops it, Esc puts it back where it was (DESIGN.md §14.3).
 */
function moveKeys(event: KeyboardEvent<HTMLElement>, ctx: TreeKeys, moving: Moving): void {
  const node = ctx.state.nodes[moving.id];
  if (!node) return ctx.setMoving(null);
  const siblings = children(ctx.state, node.chordId, node.section, node.parentId);
  // React may move the row's element to reorder the list, which takes the focus away: give it back.
  const move = (index: number, parentId = node.parentId, section = node.section) =>
    void api.state.dispatch({ t: 'node.move', nodeId: node.id, section, index, parentId }).then(() => ctx.focus(node.id));
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      event.preventDefault();
      const at = siblings.findIndex((s) => s.id === node.id);
      const to = at + (event.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < siblings.length) {
        move(to);
        announce(`${to + 1} of ${siblings.length}`);
      }
      return;
    }
    case ' ':
    case 'Enter': {
      event.preventDefault();
      const at = siblings.findIndex((s) => s.id === node.id);
      announce(`Dropped ${nameOf(ctx.state, node.id)}, ${at + 1} of ${siblings.length}`);
      return ctx.setMoving(null);
    }
    case 'Escape':
      event.preventDefault();
      move(moving.index, moving.parentId, moving.section);
      announce(`Put ${nameOf(ctx.state, node.id)} back`);
      return ctx.setMoving(null);
    case 'Tab':
      return ctx.setMoving(null);
  }
}

/** What a row is called, for announcements. */
function nameOf(state: State, id: string): string {
  const node = state.nodes[id];
  if (!node) return '';
  if (node.kind === 'folder') return node.title;
  if (node.kind === 'split') return splitTitle(splitMembers(state, id));
  return pageTitle(node) || displayHost(node.url) || 'New tab';
}

function treeKeys(event: KeyboardEvent<HTMLElement>, ctx: TreeKeys) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
  if (!row || event.altKey || ctx.dragging) return;
  const id = row.dataset['id']!;
  if (ctx.moving) return moveKeys(event, ctx, ctx.moving);
  // Rows in order from the state, not the DOM: a windowed list mounts only the rows near the viewport.
  const rows = ctx.rows();
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0) return;
  const next = rows[at + 1];
  const node = ctx.state.nodes[id];
  const go = (to: TreeRow | undefined) => {
    if (!to) return;
    event.preventDefault();
    ctx.focus(to.id);
  };
  const mod = ctx.info.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  switch (event.key) {
    case 'ArrowDown':
      return go(next);
    case 'ArrowUp':
      return go(rows[at - 1]);
    case 'Home':
      return go(rows[0]);
    case 'End':
      return go(rows.at(-1));
    case 'ArrowRight':
      if (node?.kind === 'split') {
        event.preventDefault();
        if (!ctx.openSplits.has(id)) ctx.toggleSplit(id, true);
        else if (next?.parent === id) ctx.focus(next.id);
        return;
      }
      if (node?.kind !== 'folder') return;
      event.preventDefault();
      if (node.collapsed) void api.state.dispatch({ t: 'folder.toggle', nodeId: id, collapsed: false });
      else if (next?.parent === id) ctx.focus(next.id);
      return;
    case 'ArrowLeft': {
      event.preventDefault();
      const parent = rows[at]!.parent;
      if (node?.kind === 'folder' && !node.collapsed) void api.state.dispatch({ t: 'folder.toggle', nodeId: id, collapsed: true });
      else if (node?.kind === 'split' && ctx.openSplits.has(id)) ctx.toggleSplit(id, false);
      else if (parent) ctx.focus(parent);
      return;
    }
    case 'Enter':
      // Open the tab (or the split), or open and close the folder: what a click on the row does.
      event.preventDefault();
      row.querySelector<HTMLElement>('[data-activate]')?.click();
      return;
    case ' ': {
      // Pick the row up.
      if (!node) return;
      event.preventDefault();
      const index = children(ctx.state, node.chordId, node.section, node.parentId).findIndex((s) => s.id === id);
      ctx.setMoving({ id, section: node.section, parentId: node.parentId, index });
      announce(`Picked up ${nameOf(ctx.state, id)}. Up and down arrows move it, Space drops it, Escape puts it back.`);
      return;
    }
    case 'F2':
      if (node?.kind === 'folder') {
        event.preventDefault();
        ctx.setRenaming(id);
      }
      return;
    case 'Delete':
    case 'Backspace': {
      if (event.key === 'Backspace' && !mod) return;
      event.preventDefault();
      if (node?.kind === 'folder') void api.sidebar.deleteFolder(id);
      else if (node?.kind === 'tab') {
        // Keep the keyboard in the list: focus moves to the neighbor that takes its place.
        const neighbor = next ?? rows[at - 1];
        if (neighbor) ctx.focus(neighbor.id);
        void api.state.dispatch({ t: 'tab.close', windowId: ctx.windowId, nodeId: id });
      }
      return;
    }
  }
}

/* ---------- The lists ---------- */

/** A row as drawn: a node, where it sits in the tree, and its place in the list dnd-kit sorts. */
interface Entry {
  id: string;
  node: SidebarNode;
  depth: number;
  /** The folder or split it's listed under. */
  parent: string | null;
  /** Its index among its list's sortable rows; -1 for a split's tab, which isn't one of them. */
  index: number;
  /** Its place among its siblings, from 1, and how many they are (for screen readers). */
  pos: number;
  size: number;
  /** One of a split's tabs, listed under its opened row. */
  member: boolean;
}

/** `rows` as drawn, each opened split followed by its tabs (unless a drag is moving rows around them). */
function withMembers(state: State, rows: readonly Omit<Entry, 'member'>[], openSplits: ReadonlySet<string>, showMembers: boolean): Entry[] {
  const out: Entry[] = [];
  for (const row of rows) {
    out.push({ ...row, member: false });
    if (row.node.kind !== 'split' || !showMembers || !openSplits.has(row.id)) continue;
    const members = splitMembers(state, row.id);
    members.forEach((m, i) => out.push({ id: m.id, node: m, depth: row.depth + 1, parent: row.id, index: -1, pos: i + 1, size: members.length, member: true }));
  }
  return out;
}

/** Pinned's rows: each one's place among its siblings in the tree. */
function pinnedEntries(state: State, rows: readonly FlatRow[]): Omit<Entry, 'member'>[] {
  const sizes = new Map<string | null, number>();
  for (const r of rows) sizes.set(r.parentId, (sizes.get(r.parentId) ?? 0) + 1);
  const seen = new Map<string | null, number>();
  return rows.flatMap((r, index) => {
    const node = state.nodes[r.id];
    if (!node) return [];
    const pos = (seen.get(r.parentId) ?? 0) + 1;
    seen.set(r.parentId, pos);
    return [{ id: r.id, node, depth: r.depth, parent: r.parentId, index, pos, size: sizes.get(r.parentId)! }];
  });
}

/** The trees' one Tab stop: the tab on screen, or the row last focused (shared/a11y.ts), placed on the next frame. */
const TREE_ROVING = { items: '[role="treeitem"]', current: '[aria-selected="true"]', deferred: true } as const;

const rowSelector = (id: string) => `[data-row][data-id="${CSS.escape(id)}"]`;

export function SidebarTabs({
  chordId,
  state,
  windowId,
  activeId,
  info,
  appearance,
  spring,
  tabMotion,
}: {
  chordId: ChordId;
  state: State;
  windowId: string;
  activeId: string | null;
  info: SystemInfo;
  appearance: Appearance;
  spring: SpringFor;
  /** How tab moves animate (DESIGN.md §6.8 "Animate tab moves", and reduced motion, §6.6). */
  tabMotion: MotionMode;
}) {
  const { active, projected, order } = useDrag();
  const dragging = active !== null;
  const [moving, setMoving] = useState<Moving | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => api.sidebar.onRename(({ nodeId }) => setRenaming(nodeId)), []);
  const [openSplits, setOpenSplits] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSplit = useCallback(
    (id: string, open: boolean) =>
      setOpenSplits((s) => {
        const next = new Set(s);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const readTabs = useContext(DuetReadTabs);
  const { keycap, withKeys } = useKeys(info);
  const pinnedTree = useRoving<HTMLUListElement>(TREE_ROVING);
  const todayTree = useRoving<HTMLUListElement>(TREE_ROVING);
  const tree = useRef<HTMLDivElement>(null);
  const help = `tree-help-${chordId}`;
  // A split's tabs list under its opened row, except while a row is dragged (dnd-kit then moves rows around them).
  const showMembers = !active || active.member;

  // The rows, as drawn: Pinned's tree flattened, and Today in the order a drag has it so far.
  const pinned = withMembers(state, pinnedEntries(state, flattenPinned(state, chordId, active?.type === 'folder' ? active.id : null)), openSplits, showMembers);
  const todayNodes = inOrder(
    children(state, chordId, 'today', null).filter((n) => n.kind !== 'folder'),
    order?.chordId === chordId ? order.ids : null,
  );
  const today = withMembers(
    state,
    todayNodes.map((node, index) => ({ id: node.id, node, depth: 0, parent: null, index, pos: index + 1, size: todayNodes.length })),
    openSplits,
    showMembers,
  );
  const todayAt = new Map(today.map((e, i) => [e.id, i]));

  // Today's window (DESIGN.md §6.7): above 150 rows, only the rows near the viewport are mounted. The rows past
  // its edges come a frame after the list mounts (a chord switch): they don't show, so they needn't hold up that frame.
  const win = useListWindow(ROW);
  const overscan = useSettled() ? OVERSCAN : 0;
  const inView = visibleSpan(win.view.top, win.view.height, ROW, today.length);
  const near = grow(inView, overscan, today.length);
  const windowed = today.length > WINDOW_ABOVE;
  const [focused, setFocused] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // Mounted wherever they are: the tab on screen (its pill glides from there, and it's the trees' Tab stop), a row
  // being dragged or moved with the keyboard, and the row with the keyboard (or about to get it).
  const keep = [activeId, activeId ? (state.nodes[activeId]?.parentId ?? null) : null, active?.id, moving?.id, focused, pendingFocus].flatMap((id) => {
    const at = id ? todayAt.get(id) : undefined;
    return at === undefined ? [] : [at];
  });
  const drawn = pieces(today.length, windowed ? near : null, keep);

  // Where each list's rows were at the last commit (by index, mounted or not) and their elements then (a row that
  // leaves goes out in its own), where Today sat on screen, and whether a row was dragged: what the rows animate
  // from (today-motion.ts).
  const [presence] = useState(() => ({
    today: { slots: todayAt, shown: new Map() } as Placed<HTMLElement>,
    pinned: { slots: new Map(pinned.map((e, i) => [e.id, i])), shown: new Map() } as Placed<HTMLElement>,
    offset: null as number | null,
    pinnedRows: pinned.length,
    dragging,
  }));
  const pinnedList = useRef<HTMLUListElement>(null);
  const todayExits = useRef<HTMLDivElement>(null);
  const pinnedExits = useRef<HTMLDivElement>(null);

  const closeToday = withKeys('Close tab', 'tab.close');
  const closePinned = withKeys('Close (stays pinned)', 'tab.close');
  const mute = withKeys('Mute tab', 'tab.mute');
  const unmute = withKeys('Unmute tab', 'tab.mute');
  const ctx = useMemo<RowContext>(
    () => ({ windowId, info, appearance, spring, setRenaming, toggleSplit, closeTitle: { today: closeToday, pinned: closePinned }, muteTitle: { mute, unmute } }),
    [windowId, info, appearance, spring, toggleSplit, closeToday, closePinned, mute, unmute],
  );

  useLayoutEffect(() => {
    const list = win.list;
    const before = { ...presence };
    // How far Today moved on screen since (Pinned grew or shrank above it): rows that move with it slide too. Only
    // Pinned moves it, so it's measured only when Pinned's rows change; the first time, on the next frame, with the
    // rest of that frame's layout (measuring now would lay out a pane that just mounted, mid-commit).
    const measure = () => list?.getBoundingClientRect().top ?? null;
    let offset: number | null = null;
    if (tabMotion === 'on' && before.offset !== null) offset = before.pinnedRows === pinned.length ? before.offset : measure();
    else if (tabMotion === 'on')
      requestAnimationFrame(() => {
        if (presence.offset === null && presence.pinnedRows === pinned.length) presence.offset = measure();
      });
    const shift = offset !== null && before.offset !== null ? before.offset - offset : 0;
    const pinnedAt = new Map(pinned.map((e, i) => [e.id, i]));
    presence.offset = offset;
    presence.pinnedRows = pinned.length;
    presence.dragging = dragging;
    presence.today = { slots: todayAt, shown: new Map() };
    presence.pinned = { slots: pinnedAt, shown: new Map() };
    // Which of the rows that left Today went to the archive.
    const archived = new Set<string>();
    for (const id of before.today.slots.keys()) if (!todayAt.has(id) && takeArchived(id)) archived.add(id);
    // "Animate tab moves" off: rows just change place.
    if (tabMotion === 'off' || !list) return;
    const { top, height } = win.last.current;
    // Today: near the viewport only (DESIGN.md §6.7), and while a row is dragged, dnd-kit moves them.
    const inToday = rowChanges(rowsIn(list), before.today, todayAt, {
      rowHeight: ROW,
      near: (slot) => inSpan(near, slot),
      shows: (slot) => (slot + 1) * ROW > top && slot * ROW < top + height,
      shift,
      still: dragging,
      busy,
    });
    // Pinned (its list is gone with its last row): while a row is dragged, and as it drops, dnd-kit moves Pinned's
    // rows itself (in the DOM): after that, they're where it left them.
    const dndMoved = dragging || before.dragging;
    const pinnedRows = pinnedList.current ? rowsIn(pinnedList.current) : [];
    const inPinned = rowChanges(pinnedRows, before.pinned, pinnedAt, { rowHeight: ROW, near: () => true, shows: () => true, shift: 0, still: dndMoved, busy });
    presence.today = { slots: todayAt, shown: inToday.shown };
    presence.pinned = { slots: dndMoved ? slotsInOrder(pinnedRows.map(([id]) => id)) : pinnedAt, shown: inPinned.shown };
    const quiet = (c: RowChanges<HTMLElement>) => c.gone.length === 0 && c.arrived.length === 0 && c.moved.length === 0;
    // Nothing to show, or a hidden sidebar (minimal mode): nothing animates.
    if ((quiet(inToday) && quiet(inPinned)) || !list.checkVisibility({ visibilityProperty: true })) return;
    if (tabMotion === 'reduced') {
      // Reduced motion: rows go and move at once, and the Archive button's highlight fades (DESIGN.md §6.6).
      if (inToday.gone.some((g) => archived.has(g.id))) flashArchive();
      return;
    }
    let flights = 0;
    const fly = inToday.gone.length > 0 && canFly();
    const todayLayer = todayExits.current;
    for (const { id, el, slot } of todayLayer ? inToday.gone : []) {
      const kind: Leaving = archived.has(id) ? 'archive' : state.nodes[id]?.section === 'pinned' ? 'pin' : 'close';
      const flight = kind === 'archive' && fly && el.dataset['row'] === 'tab' && flights < MAX_FLIGHTS ? flights++ : null;
      playExit(todayLayer!, el, slot * ROW - top + shift, kind, flight);
    }
    const pinnedLayer = pinnedExits.current;
    for (const { el, slot } of pinnedLayer ? inPinned.gone : []) playExit(pinnedLayer!, el, slot * ROW, 'close', null);
    for (const [order, el] of inToday.arrived.entries()) enter(el, false, order);
    // A row that came from Today lands in Pinned with a little give (DESIGN.md §6.5, Pin).
    for (const [order, el] of inPinned.arrived.entries()) enter(el, before.today.slots.has(el.dataset['id']!), order);
    for (const { el, dy } of [...inToday.moved, ...inPinned.moved]) slideFrom(el, dy);
  });

  // The keyboard asked for a row that wasn't mounted: now it is.
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    win.list?.querySelector<HTMLElement>(rowSelector(pendingFocus))?.focus({ preventScroll: true });
    setPendingFocus(null);
  }, [pendingFocus, win.list]);

  /** Puts the keyboard on a row: in Today, scrolled into view (and mounted) first. */
  const focusRow = (id: string) => {
    const at = todayAt.get(id);
    if (at === undefined) {
      tree.current?.querySelector<HTMLElement>(rowSelector(id))?.focus();
      return;
    }
    win.reveal(at);
    const el = win.list?.querySelector<HTMLElement>(rowSelector(id));
    if (el) el.focus({ preventScroll: true });
    else setPendingFocus(id);
  };
  // Keys whose work finishes later (a move committed by main) focus with the rows as they are then.
  const focusLatest = useRef(focusRow);
  useLayoutEffect(() => {
    focusLatest.current = focusRow;
  });

  const todayRef = useCallback(
    (el: HTMLUListElement | null) => {
      win.ref(el);
      return todayTree.ref(el);
    },
    [win.ref, todayTree.ref],
  );
  const pinnedRef = useCallback(
    (el: HTMLUListElement | null) => {
      pinnedList.current = el;
      return pinnedTree.ref(el);
    },
    [pinnedTree.ref],
  );

  const rowFor = (e: Entry, section: Section, at = 0) => {
    const node = e.node;
    const base = { depth: e.depth, pos: e.pos, size: e.size, ctx };
    if (e.member && node.kind === 'tab') return <SplitMemberRow key={e.id} tab={node} live={state.live[e.id]} focused={e.id === activeId} {...base} />;
    const drag = { moving: moving?.id === e.id, projected: active?.id === e.id ? projected : null };
    const shows = section === 'pinned' || inSpan(inView, at) || drag.moving || active?.id === e.id;
    switch (node.kind) {
      case 'tab':
        return <TabRow key={e.id} tab={node} live={state.live[e.id]} index={e.index} shows={shows} section={section} isActive={e.id === activeId} duetRead={readTabs.has(e.id)} {...drag} {...base} />;
      case 'folder':
        return <FolderRow key={e.id} folder={node} index={e.index} renaming={renaming === e.id} {...drag} {...base} />;
      case 'split': {
        const panes = splitMembers(state, e.id);
        return (
          <SplitRow
            key={e.id}
            split={node}
            panes={panes}
            index={e.index}
            shows={shows}
            section={section}
            isActive={panes.some((p) => p.id === activeId)}
            open={openSplits.has(e.id)}
            {...drag}
            {...base}
          />
        );
      }
    }
  };

  return (
    <div
      ref={tree}
      className={styles.tree}
      onKeyDown={(e) =>
        treeKeys(e, {
          state,
          windowId,
          info,
          dragging,
          moving,
          setMoving,
          setRenaming,
          openSplits,
          toggleSplit,
          rows: () => [...pinned, ...today],
          focus: (id) => focusLatest.current(id),
        })
      }
      // A click drops a row picked up with the keyboard.
      onPointerDown={() => moving && setMoving(null)}
    >
      {/*
        The rows' one Motion element, the active pill, comes and goes with its row, not with the chord pane around
        the lists: outside the pane's presence.
      */}
      <PresenceContext.Provider value={null}>
      <div className={styles.pinnedBox}>
        {pinned.length > 0 && (
          <ul ref={pinnedRef} className={styles.pinnedList} role="tree" aria-label="Pinned" aria-describedby={help}>
            {pinned.map((e) => rowFor(e, 'pinned'))}
          </ul>
        )}
        {/* Rows leaving Pinned go out here, where they were (playExit). */}
        <div ref={pinnedExits} className={styles.pinnedExits} aria-hidden inert />
      </div>

      <div className={styles.divider}>
        {pinned.length === 0 && active && active.type !== 'favorite' && !state.windows[windowId]?.private && <PinnedDropZone />}
        <span className={styles.hairline} role="separator" />
        {todayNodes.some((n) => n.kind === 'tab') && (
          <button type="button" className={styles.clear} title="Archive every Today tab (splits stay)" onClick={() => void api.action.run('today.clear')}>
            Clear
          </button>
        )}
      </div>

      <button type="button" className={`${styles.row} ${styles.newTab}`} onClick={() => void api.overlay.open('new')}>
        <Plus size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>New tab</span>
        <kbd className={styles.rowKeycap}>{keycap('tab.new')}</kbd>
      </button>

      <div className={styles.todayBox}>
        <ul
          ref={todayRef}
          className={styles.list}
          data-edge-scroll
          role="tree"
          aria-label="Today"
          aria-describedby={help}
          data-windowed={windowed || undefined}
          onFocus={(e) => setFocused((e.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset['id'] ?? null)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
          }}
        >
          {/* One flat list of keyed children, so rows keep their elements as the window moves. */}
          {drawn.flatMap((piece, i) =>
            piece.kind === 'gap'
              ? [<li key={`gap-${i}`} className={styles.gap} role="none" aria-hidden style={{ blockSize: (piece.last - piece.first + 1) * ROW }} />]
              : today.slice(piece.first, piece.last + 1).map((e, i) => rowFor(e, 'today', piece.first + i)),
          )}
        </ul>
        {/* Rows leaving Today go out here, where they were (playExit). */}
        <div ref={todayExits} className={styles.exits} aria-hidden inert />
      </div>
      </PresenceContext.Provider>
      <span id={help} hidden>
        Arrow keys move between rows; right and left open and close folders. Enter opens a tab. Space picks a row up to move it. Delete closes a tab.
      </span>
    </div>
  );
}
