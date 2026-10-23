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
 */
import {
  children,
  isInternalUrl,
  sortedFavorites,
  tabForFavorite,
  uuidv7,
  type ChordId,
  type Favorite,
  type FolderNode,
  type State,
  type TabNode,
} from '@chord/core';
import { CollisionPriority } from '@dnd-kit/abstract';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDroppable } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { SystemInfo } from '@chord/ipc';
import type { Appearance } from '@chord/tokens';
import { Archive, ChevronRight, Folder, FolderOpen, PictureInPicture2, Plus, ScreenShare, Sparkle, Undo2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Favicon } from '../shared/Favicon';
import type { SpringFor } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { api } from './api';
import styles from './App.module.css';
import { DuetReadTabs } from './duet-context';
import { useKeys } from './keys';
import { CHORD_DROP, flattenPinned, levelsFor, MAX_VISUAL_DEPTH, projectDrop, type Drop, type FlatRow } from './tree';

const PINNED_ZONE = 'pinned-zone';
const FAVORITES_ZONE = 'favorites-zone';
const FAVORITE = 'fav:';
/** What each kind of row takes as a drop (constant, so dnd-kit sees the same options every render). */
const ROW_ACCEPTS = ['tab', 'folder'];
const FAVORITE_ACCEPTS = ['favorite', 'tab'];
/** Hovering a closed folder this long while dragging opens it (DESIGN.md §6.5). */
const SPRING_LOAD_MS = 600;

type Section = 'pinned' | 'today';

/* ---------- Drag state, shared by every list in the sidebar ---------- */

interface DragState {
  /** What's being dragged: a tab, a folder, or a favorite. */
  active: { id: string; type: 'tab' | 'folder' | 'favorite' } | null;
  /** Where a row dragged within Pinned would land, so it can show at that depth. */
  projected: Drop | null;
}

const DragContext = createContext<DragState>({ active: null, projected: null });
const useDrag = () => useContext(DragContext);

/**
 * One drag-and-drop space for the whole sidebar, so a tab can go from its
 * list to Favorites or to another chord in the switcher.
 */
export function SidebarDnd({ state, chordId, children: content }: { state: State; chordId: ChordId; children: ReactNode }) {
  const [drag, setDrag] = useState<DragState>({ active: null, projected: null });
  const springTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Handlers read the latest state, not the one from when the drag began.
  const latest = useRef({ state, chordId, drag });
  latest.current = { state, chordId, drag };

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
        sensors={(defaults) => [
          // The keyboard moves rows its own way (treeKeys below), so dnd-kit's keyboard sensor stays out.
          ...defaults.filter((sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor),
          // A few pixels of travel before a drag starts, so clicks stay clicks.
          PointerSensor.configure({ activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 4 })] }),
        ]}
        onDragStart={(event) => {
          const source = event.operation.source;
          if (!source) return;
          const type = source.type === 'folder' ? 'folder' : source.type === 'favorite' ? 'favorite' : 'tab';
          setDrag({ active: { id: String(source.id), type }, projected: null });
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
        onDragOver={(event) => {
          // Live reordering stays within a list (see the note at the top).
          const { source, target } = event.operation;
          if (isSortable(source) && isSortable(target) && source.group !== target.group) event.preventDefault();
          // Dragging over a closed folder from the other list springs it open too.
          const node = target ? latest.current.state.nodes[String(target.id)] : undefined;
          if (isSortable(source) && source.group !== 'pinned') springLoad(node?.kind === 'folder' && node.collapsed ? node.id : null);
        }}
        onDragEnd={(event) => {
          const projected = latest.current.drag.projected;
          setDrag({ active: null, projected: null });
          clearSpring();
          if (event.canceled) return;
          const { source, target, position } = event.operation;
          if (!source) return;
          const { state: s, chordId: c } = latest.current;
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
          if (!isSortable(source)) return;
          const from = source.group as Section;
          const to = isSortable(target) && (target.group === 'pinned' || target.group === 'today') ? (target.group as Section) : null;

          // Within Pinned: where the projection says, at the depth it showed.
          if (from === 'pinned' && (to === 'pinned' || to === null)) {
            const drop = projected ?? projectWithin(nodeId, source.index, position.current.x - position.initial.x);
            if (drop) void api.state.dispatch({ t: 'node.move', nodeId, section: 'pinned', index: drop.index, parentId: drop.parentId });
            return;
          }
          // Within Today.
          if (from === 'today' && (to === 'today' || to === null)) {
            void api.state.dispatch({ t: 'node.move', nodeId, section: 'today', index: source.index });
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
      </DragDropProvider>
    </DragContext.Provider>
  );
}

/* ---------- Rows ---------- */

/**
 * The drag a row is part of. Rows get it as props, not from the context: a
 * row leaving its list keeps animating out with the props it had, and a
 * re-render mid-exit (when the drag ends) would stop its exit for good.
 */
interface RowDrag {
  dragging: boolean;
  projected: Drop | null;
  /** The row picked up with the keyboard (Space), if any. */
  moving: string | null;
}

/** A row picked up with Space, and where it was, so Esc can put it back. */
interface Moving {
  id: string;
  section: Section;
  parentId: string | null;
  index: number;
}

interface RowContext {
  state: State;
  windowId: string;
  activeId: string | null;
  info: SystemInfo;
  appearance: Appearance;
  spring: SpringFor;
  /** The folder being renamed inline. */
  renaming: string | null;
  setRenaming(id: string | null): void;
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

function TabRow({ tab, index, section, depth, ctx, drag }: { tab: TabNode; index: number; section: Section; depth: number; ctx: RowContext; drag: RowDrag }) {
  const duetRead = useContext(DuetReadTabs).has(tab.id);
  // The row's button is the handle, so dnd-kit's drag semantics land on a button and the <li> stays a list item.
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: tab.id, index, group: section, type: 'tab', accept: ROW_ACCEPTS });
  const { dragging, projected } = drag;
  const { state, windowId, activeId, info, appearance, spring } = ctx;
  const { withKeys } = useKeys(info);
  const isActive = tab.id === activeId;
  const lifted = isDragging || drag.moving === tab.id;
  const live = state.live[tab.id];
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
  const dispatch = api.state.dispatch;
  const close = () => void dispatch({ t: 'tab.close', windowId, nodeId: tab.id });
  const shownDepth = isDragging && projected ? projected.depth : depth;
  return (
    <motion.li
      ref={ref}
      // While dragging, dnd-kit moves rows; motion only animates arrivals and departures.
      layout={dragging ? false : 'position'}
      className={styles.item}
      style={indent(shownDepth)}
      data-dragging={lifted || undefined}
      data-drop-target={(dragging && isDropTarget && !isDragging) || undefined}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: -8 }}
      transition={spring('smooth', 'tabMoves')}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll
      }}
      onAuxClick={(e: MouseEvent) => {
        if (e.button === 1) close();
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(tab.id, { x: e.clientX, y: e.clientY });
      }}
    >
      {isActive && <motion.span layoutId={`active-pill-${tab.chordId}`} className={styles.activePill} transition={spring('snappy', 'tabMoves')} />}
      <button
        ref={handleRef}
        type="button"
        className={`${styles.row} ${isActive ? styles.active : ''}`}
        data-row="tab"
        data-id={tab.id}
        data-parent={tab.parentId ?? undefined}
        // Pinned tabs get a hover preview (DESIGN.md §7.6).
        data-preview={pinned || undefined}
        // A pinned tab that hasn't been opened yet reads quieter (DESIGN.md §7.2).
        data-unloaded={unloaded || undefined}
        data-asleep={asleep || undefined}
        data-pip={popped || sharing || undefined}
        aria-current={isActive ? 'page' : undefined}
        title={pageTitle(tab) || tab.url}
        onClick={() => void dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
      >
        {isInternalUrl(tab.url) ? (
          // Chord's own pages wear Chord's glyphs (DESIGN.md §7.3): a box for the archive.
          <Archive className={styles.rowGlyph} size={16} strokeWidth={1.75} aria-hidden />
        ) : (
          <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} loading={Boolean(live?.loading) && !tab.favicon} appearance={appearance} />
        )}
        <span className={styles.ellipsis}>{pageTitle(tab) || displayHost(tab.url) || 'New tab'}</span>
        {duetRead && <Sparkle className={styles.duetRead} size={12} strokeWidth={2} role="img" aria-label="Duet read this tab" />}
      </button>
      {sharing ? (
        <button
          type="button"
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
          className={styles.pip}
          aria-label="Bring the video back"
          title="Bring the video back"
          onClick={() => void dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
        >
          <PictureInPicture2 size={14} strokeWidth={2} />
        </button>
      )}
      {away ? (
        <button
          type="button"
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
          className={styles.close}
          aria-label={`Close ${tab.title || 'tab'}`}
          title={withKeys(pinned ? 'Close (stays pinned)' : 'Close tab', 'tab.close')}
          onClick={close}
        >
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </motion.li>
  );
}

function FolderRow({ folder, index, depth, ctx, drag }: { folder: FolderNode; index: number; depth: number; ctx: RowContext; drag: RowDrag }) {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: folder.id, index, group: 'pinned', type: 'folder', accept: ROW_ACCEPTS });
  const { dragging, projected } = drag;
  const { spring, renaming, setRenaming } = ctx;
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
    <motion.li
      ref={ref}
      layout={dragging ? false : 'position'}
      className={styles.item}
      style={indent(shownDepth)}
      data-dragging={(isDragging || drag.moving === folder.id) || undefined}
      data-drop-target={(dragging && isDropTarget && !isDragging) || undefined}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: -8 }}
      transition={spring('smooth', 'tabMoves')}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.tab(folder.id, { x: e.clientX, y: e.clientY });
      }}
    >
      {/* The button is always there: it's the drag handle, and dnd-kit keeps whatever it first found. */}
      <button
        ref={handleRef}
        type="button"
        className={styles.row}
        data-row="folder"
        data-id={folder.id}
        data-parent={folder.parentId ?? undefined}
        data-preview
        aria-expanded={open}
        title={folder.title}
        onClick={toggle}
        onDoubleClick={() => setRenaming(folder.id)}
      >
        <ChevronRight className={styles.chevron} data-open={open || undefined} size={12} strokeWidth={2} aria-hidden />
        <Glyph className={styles.rowGlyph} size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>{folder.title}</span>
      </button>
      {renaming === folder.id && (
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
            if (e.key === 'Enter') commit(e.currentTarget.value);
            else if (e.key === 'Escape') setRenaming(null);
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      )}
    </motion.li>
  );
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

function FavoriteTile({ favorite, index, active, appearance, windowId }: { favorite: Favorite; index: number; active: boolean; appearance: Appearance; windowId: string }) {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: FAVORITE + favorite.id, index, group: 'favorites', type: 'favorite', accept: FAVORITE_ACCEPTS });
  const { active: dragged } = useDrag();
  const label = favorite.title || displayHost(favorite.url);
  return (
    <li ref={ref} className={styles.favoriteItem} data-dragging={isDragging || undefined} data-drop-target={(dragged && isDropTarget && !isDragging) || undefined}>
      <button
        ref={handleRef}
        type="button"
        className={styles.favorite}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        title={label}
        onClick={() => void api.state.dispatch({ t: 'favorite.open', windowId, favoriteId: favorite.id })}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          void api.menu.favorite(favorite.id, { x: e.clientX, y: e.clientY });
        }}
      >
        <Favicon url={favorite.url} title={favorite.title} favicon={favorite.favicon} appearance={appearance} />
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
      {favorites.map((favorite, index) => (
        <FavoriteTile
          key={favorite.id}
          favorite={favorite}
          index={index}
          active={Boolean(chordId && activeId && tabForFavorite(state, chordId, favorite.url)?.id === activeId)}
          appearance={appearance}
          windowId={windowId}
        />
      ))}
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

interface TreeKeys {
  state: State;
  windowId: string;
  info: SystemInfo;
  /** A pointer drag is under way. */
  dragging: boolean;
  moving: Moving | null;
  setMoving(moving: Moving | null): void;
  setRenaming(id: string): void;
}

/**
 * With a row picked up (Space), ↑ ↓ move it among its siblings, committed as
 * it goes; Space or Enter drops it, Esc puts it back where it was (DESIGN.md §14.3).
 */
function moveKeys(event: KeyboardEvent<HTMLElement>, ctx: TreeKeys, moving: Moving): void {
  const node = ctx.state.nodes[moving.id];
  if (!node) return ctx.setMoving(null);
  const list = event.currentTarget;
  // React may move the row's element to reorder the list, which takes the focus away: give it back.
  const move = (index: number, parentId = node.parentId, section = node.section) =>
    void api.state
      .dispatch({ t: 'node.move', nodeId: node.id, section, index, parentId })
      .then(() => list.querySelector<HTMLElement>(`[data-row][data-id="${CSS.escape(node.id)}"]`)?.focus());
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      event.preventDefault();
      const siblings = children(ctx.state, node.chordId, node.section, node.parentId);
      const at = siblings.findIndex((s) => s.id === node.id);
      const to = at + (event.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < siblings.length) move(to);
      return;
    }
    case ' ':
    case 'Enter':
      event.preventDefault();
      return ctx.setMoving(null);
    case 'Escape':
      event.preventDefault();
      move(moving.index, moving.parentId, moving.section);
      return ctx.setMoving(null);
    case 'Tab':
      return ctx.setMoving(null);
  }
}

function treeKeys(event: KeyboardEvent<HTMLElement>, ctx: TreeKeys) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
  if (!row || event.altKey || ctx.dragging) return;
  const id = row.dataset['id']!;
  if (ctx.moving) return moveKeys(event, ctx, ctx.moving);
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
  const at = rows.indexOf(row);
  const node = ctx.state.nodes[id];
  const focus = (el: HTMLElement | undefined) => {
    if (!el) return;
    event.preventDefault();
    el.focus();
  };
  const mod = ctx.info.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  switch (event.key) {
    case 'ArrowDown':
      return focus(rows[at + 1]);
    case 'ArrowUp':
      return focus(rows[at - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows.at(-1));
    case 'ArrowRight':
      if (node?.kind !== 'folder') return;
      event.preventDefault();
      if (node.collapsed) void api.state.dispatch({ t: 'folder.toggle', nodeId: id, collapsed: false });
      else if (rows[at + 1]?.dataset['parent'] === id) rows[at + 1]!.focus();
      return;
    case 'ArrowLeft':
      event.preventDefault();
      if (node?.kind === 'folder' && !node.collapsed) void api.state.dispatch({ t: 'folder.toggle', nodeId: id, collapsed: true });
      else if (row.dataset['parent']) rows.find((r) => r.dataset['id'] === row.dataset['parent'])?.focus();
      return;
    case ' ': {
      // Pick the row up (and don't click it when Space comes back up).
      if (!node) return;
      event.preventDefault();
      const index = children(ctx.state, node.chordId, node.section, node.parentId).findIndex((s) => s.id === id);
      ctx.setMoving({ id, section: node.section, parentId: node.parentId, index });
      return;
    }
    case 'F2':
      if (node?.kind === 'folder') {
        event.preventDefault();
        ctx.setRenaming(id);
      }
      return;
    case 'Delete':
    case 'Backspace':
      if (event.key === 'Backspace' && !mod) return;
      event.preventDefault();
      if (node?.kind === 'folder') void api.sidebar.deleteFolder(id);
      else if (node?.kind === 'tab') {
        // Keep the keyboard in the list: focus moves to the neighbor that takes its place.
        (rows[at + 1] ?? rows[at - 1])?.focus();
        void api.state.dispatch({ t: 'tab.close', windowId: ctx.windowId, nodeId: id });
      }
      return;
  }
}

/* ---------- The lists ---------- */

export function SidebarTabs({ chordId, ...rest }: Omit<RowContext, 'renaming' | 'setRenaming'> & { chordId: ChordId }) {
  const { active, projected } = useDrag();
  const [moving, setMoving] = useState<Moving | null>(null);
  const drag: RowDrag = { dragging: active !== null, projected, moving: moving?.id ?? null };
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => api.sidebar.onRename(({ nodeId }) => setRenaming(nodeId)), []);
  const ctx: RowContext = { ...rest, renaming, setRenaming };
  const { state, info } = rest;
  const { keycap } = useKeys(info);
  const pinned = flattenPinned(state, chordId, active?.type === 'folder' ? active.id : null);
  const today = children(state, chordId, 'today', null).filter((n): n is TabNode => n.kind === 'tab');

  const row = (r: FlatRow, index: number) => {
    const node = state.nodes[r.id];
    if (node?.kind === 'folder') return <FolderRow key={r.id} folder={node} index={index} depth={r.depth} ctx={ctx} drag={drag} />;
    if (node?.kind === 'tab') return <TabRow key={r.id} tab={node} index={index} section="pinned" depth={r.depth} ctx={ctx} drag={drag} />;
    return null;
  };

  return (
    <div
      className={styles.tree}
      onKeyDown={(e) => treeKeys(e, { state, windowId: rest.windowId, info, dragging: active !== null, moving, setMoving, setRenaming })}
      // A click drops a row picked up with the keyboard.
      onPointerDown={() => moving && setMoving(null)}
    >
      {pinned.length > 0 && (
        <ul className={styles.pinnedList} aria-label="Pinned">
          <AnimatePresence initial={false} mode="popLayout">
            {pinned.map(row)}
          </AnimatePresence>
        </ul>
      )}

      <div className={styles.divider}>
        {pinned.length === 0 && active && active.type !== 'favorite' && !state.windows[rest.windowId]?.private && <PinnedDropZone />}
        <span className={styles.hairline} role="separator" />
        {today.length > 0 && (
          <button type="button" className={styles.clear} title="Archive every Today tab" onClick={() => void api.action.run('today.clear')}>
            Clear
          </button>
        )}
      </div>

      <button type="button" className={`${styles.row} ${styles.newTab}`} onClick={() => void api.overlay.open('new')}>
        <Plus size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>New tab</span>
        <kbd className={styles.rowKeycap}>{keycap('tab.new')}</kbd>
      </button>

      <ul className={styles.list} aria-label="Today">
        <AnimatePresence initial={false} mode="popLayout">
          {today.map((tab, index) => (
            <TabRow key={tab.id} tab={tab} index={index} section="today" depth={0} ctx={ctx} drag={drag} />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
