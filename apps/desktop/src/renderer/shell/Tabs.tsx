/**
 * The sidebar's tabs (DESIGN.md §3.2, §7.2): pinned above the Today divider,
 * Today below, both reorderable by dragging, and dragging between them pins
 * or unpins. The move is committed to main once, on drop.
 *
 * Within a list, dnd-kit reorders rows live. Across lists it doesn't: moving
 * a DOM node into the other <ul> behind React's back leaves React (and the
 * exit animation) with a node that's no longer where it put it. Instead the
 * row it would land next to shows where, and on drop React moves it, with
 * the row leaving one list and arriving in the other.
 */
import { children, isInternalUrl, type ChordId, type State, type TabNode } from '@chord/core';
import { CollisionPriority } from '@dnd-kit/abstract';
import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDroppable } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { SystemInfo } from '@chord/ipc';
import type { Appearance } from '@chord/tokens';
import { Archive, Plus, Undo2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type MouseEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import type { SpringFor } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { api } from './api';
import styles from './App.module.css';
import { keycap, withKeys } from './keys';

const PINNED_ZONE = 'pinned-zone';

type Section = 'pinned' | 'today';

interface RowContext {
  state: State;
  windowId: string;
  activeId: string | null;
  info: SystemInfo;
  appearance: Appearance;
  spring: SpringFor;
  dragging: boolean;
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

function TabRow({ tab, index, section, ctx }: { tab: TabNode; index: number; section: Section; ctx: RowContext }) {
  // The row's button is the handle, so dnd-kit's drag semantics land on a button and the <li> stays a list item.
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: tab.id, index, group: section, type: 'tab', accept: 'tab' });
  const { state, windowId, activeId, info, appearance, spring, dragging } = ctx;
  const isActive = tab.id === activeId;
  const live = state.live[tab.id];
  const pinned = section === 'pinned';
  const away = pinned && awayFromHome(tab);
  // A tab whose page isn't loaded (asleep, or not opened since launch) shows a faded icon (DESIGN.md §7.2).
  const asleep = !live && !isActive;
  // An unloaded pinned tab has nothing to close, so it shows no ×.
  const unloaded = pinned && asleep;
  const dispatch = api.state.dispatch;
  const close = () => void dispatch({ t: 'tab.close', windowId, nodeId: tab.id });
  return (
    <motion.li
      ref={ref}
      // While dragging, dnd-kit moves rows; motion only animates arrivals and departures.
      layout={dragging ? false : 'position'}
      className={styles.item}
      data-dragging={isDragging || undefined}
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
        // A pinned tab that hasn't been opened yet reads quieter (DESIGN.md §7.2).
        data-unloaded={unloaded || undefined}
        data-asleep={asleep || undefined}
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
      </button>
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
          title={withKeys(pinned ? 'Close (stays pinned)' : 'Close tab', 'tab.close', info)}
          onClick={close}
        >
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </motion.li>
  );
}

/** Where to drop a tab to pin it while nothing is pinned yet. */
function PinnedDropZone() {
  const { ref, isDropTarget } = useDroppable({ id: PINNED_ZONE, type: 'section', accept: 'tab', collisionPriority: CollisionPriority.Low });
  return (
    <div ref={ref} className={styles.pinZone} data-over={isDropTarget || undefined}>
      Drop here to pin
    </div>
  );
}

export function SidebarTabs({ chordId, ...rest }: Omit<RowContext, 'dragging'> & { chordId: ChordId }) {
  const [dragging, setDragging] = useState(false);
  const ctx: RowContext = { ...rest, dragging };
  const { state, info } = rest;
  const tabsIn = (section: Section) => children(state, chordId, section, null).filter((n): n is TabNode => n.kind === 'tab');
  const pinned = tabsIn('pinned');
  const today = tabsIn('today');
  const list = (section: Section, tabs: TabNode[], label: string) => (
    <ul className={section === 'pinned' ? styles.pinnedList : styles.list} aria-label={label}>
      <AnimatePresence initial={false} mode="popLayout">
        {tabs.map((tab, index) => (
          <TabRow key={tab.id} tab={tab} index={index} section={section} ctx={ctx} />
        ))}
      </AnimatePresence>
    </ul>
  );

  return (
    <DragDropProvider
      sensors={(defaults) => [
        ...defaults.filter((sensor) => sensor !== PointerSensor),
        // A few pixels of travel before a drag starts, so clicks stay clicks.
        PointerSensor.configure({ activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 4 })] }),
      ]}
      onDragStart={() => setDragging(true)}
      onDragOver={(event) => {
        // Live reordering stays within a list (see the note at the top).
        const { source, target } = event.operation;
        if (isSortable(source) && isSortable(target) && source.group !== target.group) event.preventDefault();
      }}
      onDragEnd={(event) => {
        setDragging(false);
        if (event.canceled) return;
        const { source, target, position } = event.operation;
        if (!source) return;
        const nodeId = String(source.id);
        if (target?.id === PINNED_ZONE) {
          void api.state.dispatch({ t: 'node.move', nodeId, section: 'pinned', index: 0 });
        } else if (isSortable(source) && isSortable(target) && source.group !== target.group && (target.group === 'pinned' || target.group === 'today')) {
          // Into the other list: above the row it was dropped on, or below if past its middle. The
          // row's place comes from our own order; dnd-kit's index can lag behind after earlier drops.
          const box = target.shape?.boundingRectangle;
          const below = box ? position.current.y > box.top + box.height / 2 : false;
          const at = tabsIn(target.group).findIndex((t) => t.id === target.id);
          if (at >= 0) void api.state.dispatch({ t: 'node.move', nodeId, section: target.group, index: at + (below ? 1 : 0) });
        } else if (isSortable(source) && (source.group === 'pinned' || source.group === 'today')) {
          void api.state.dispatch({ t: 'node.move', nodeId, section: source.group, index: source.index });
        }
      }}
    >
      {pinned.length > 0 ? list('pinned', pinned, 'Pinned') : dragging && <PinnedDropZone />}

      <div className={styles.divider} role="separator" />

      <button type="button" className={`${styles.row} ${styles.newTab}`} onClick={() => void api.overlay.open('new')}>
        <Plus size={16} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>New tab</span>
        <kbd className={styles.rowKeycap}>{keycap('tab.new', info)}</kbd>
      </button>

      {list('today', today, 'Today')}
    </DragDropProvider>
  );
}
