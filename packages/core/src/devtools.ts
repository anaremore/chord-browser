/**
 * Developer tools in the window (DESIGN.md §7.16): a tab's DevTools docked
 * beside its page, right or bottom, inside the page's own frame (or split
 * pane), with an 8 px edge between the two to drag. Pure, so main places the
 * views with exactly the rects the shell draws around them.
 */
import type { PaneRect } from './split';

export type DevtoolsSide = 'right' | 'bottom';

/** Where a tab's DevTools are: docked beside its page, or in a window of their own. */
export type DevtoolsPlace = 'docked' | 'window';

/**
 * One setting for every tab, as Chrome's is: the side docked DevTools take,
 * their width on the right and height at the bottom (UI px), and whether the
 * next ones open in a window of their own (the last choice wins).
 */
export interface DevtoolsSettings {
  side: DevtoolsSide;
  width: number;
  height: number;
  window: boolean;
}

/**
 * The gap between the page and DevTools (the edge you drag), the header
 * Chord draws above them, how small each side may get, and the defaults.
 */
export const DEVTOOLS = {
  gap: 8,
  header: 32,
  minWidth: 280,
  minHeight: 160,
  /** The page keeps at least this much beside them. */
  minPage: 200,
  /** Saved sizes past this are nonsense (a 4K display is 3840 px wide). */
  max: 4000,
  /** A keyboard step on the edge, and a big one with Shift. */
  step: 16,
  bigStep: 64,
} as const;

export const DEFAULT_DEVTOOLS: DevtoolsSettings = { side: 'right', width: 440, height: 320, window: false };

/** What the shell draws and main places for one pane with DevTools docked. */
export interface DevtoolsLayout {
  /** The page's own frame. */
  page: PaneRect;
  /** The edge between them: the gap you drag. */
  edge: PaneRect;
  /** DevTools' frame: Chord's header, then DevTools. */
  card: PaneRect;
  /** The DevTools view itself, under the header. */
  view: PaneRect;
}

const minFor = (side: DevtoolsSide) => (side === 'right' ? DEVTOOLS.minWidth : DEVTOOLS.minHeight);

/** The size along the docked side's axis a setting asks for. */
export const devtoolsSize = (settings: Pick<DevtoolsSettings, 'side' | 'width' | 'height'>): number => (settings.side === 'right' ? settings.width : settings.height);

/**
 * How big DevTools get in a pane `along` px long (its width for the right
 * side, its height for the bottom): what was asked for, within their minimum
 * and the page's. A pane too small for both minimums splits what it has in
 * their proportion, so neither disappears.
 */
export function fitDevtools(along: number, side: DevtoolsSide, wanted: number): number {
  const room = Math.max(0, along - DEVTOOLS.gap);
  const min = minFor(side);
  if (room < min + DEVTOOLS.minPage) return Math.round((room * min) / (min + DEVTOOLS.minPage));
  return Math.round(Math.min(room - DEVTOOLS.minPage, Math.max(min, Number.isFinite(wanted) ? wanted : min)));
}

/** A pane's page, edge and DevTools, for DevTools docked on `side` at `size` (UI px). */
export function devtoolsLayout(pane: PaneRect, side: DevtoolsSide, size: number): DevtoolsLayout {
  const right = side === 'right';
  const devtools = fitDevtools(right ? pane.width : pane.height, side, size);
  const page = Math.max(0, (right ? pane.width : pane.height) - DEVTOOLS.gap - devtools);
  if (right) {
    const card = { x: pane.x + page + DEVTOOLS.gap, y: pane.y, width: devtools, height: pane.height };
    return {
      page: { x: pane.x, y: pane.y, width: page, height: pane.height },
      edge: { x: pane.x + page, y: pane.y, width: DEVTOOLS.gap, height: pane.height },
      card,
      view: below(card),
    };
  }
  const card = { x: pane.x, y: pane.y + page + DEVTOOLS.gap, width: pane.width, height: devtools };
  return {
    page: { x: pane.x, y: pane.y, width: pane.width, height: page },
    edge: { x: pane.x, y: pane.y + page, width: pane.width, height: DEVTOOLS.gap },
    card,
    view: below(card),
  };
}

/** The card under its header. */
function below(card: PaneRect): PaneRect {
  const header = Math.min(DEVTOOLS.header, card.height);
  return { x: card.x, y: card.y + header, width: card.width, height: card.height - header };
}

/**
 * Dragging the edge `delta` px (right or down is positive) from where
 * DevTools were `from` px: they grow as the edge moves toward the page, and
 * stay within what the pane allows. Returns the new size, in whole px.
 */
export function dragDevtools(pane: PaneRect, side: DevtoolsSide, from: number, delta: number): number {
  return fitDevtools(side === 'right' ? pane.width : pane.height, side, from - delta);
}

/** A saved or asked-for size, in range: whole px, at least the side's minimum, at most DEVTOOLS.max. */
export function cleanDevtoolsSize(side: DevtoolsSide, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(DEVTOOLS.max, Math.max(minFor(side), value)));
}

/** Settings as saved (or sent), made sensible: unknown sides and sizes fall back to what's there. */
export function cleanDevtoolsSettings(current: DevtoolsSettings, patch: Partial<Record<keyof DevtoolsSettings, unknown>>): DevtoolsSettings {
  return {
    side: patch.side === 'right' || patch.side === 'bottom' ? patch.side : current.side,
    width: patch.width === undefined ? current.width : cleanDevtoolsSize('right', patch.width, current.width),
    height: patch.height === undefined ? current.height : cleanDevtoolsSize('bottom', patch.height, current.height),
    window: typeof patch.window === 'boolean' ? patch.window : current.window,
  };
}
