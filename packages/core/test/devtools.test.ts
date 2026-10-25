import { describe, expect, it } from 'vitest';
import {
  apply,
  cleanDevtoolsSettings,
  DEFAULT_DEVTOOLS,
  DEVTOOLS,
  devtoolsLayout,
  dragDevtools,
  emptyState,
  fitDevtools,
  restoreState,
  type Context,
  type DevtoolsSettings,
  type DevtoolsSide,
  type PaneRect,
} from '../src';

const ctx: Context = { now: 1, newId: () => 'id' };
const seed = { now: 1, newId: () => 'id', theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'https://home.test/' };
const frame: PaneRect = { x: 0, y: 0, width: 1000, height: 700 };

describe('fitDevtools: how big docked DevTools get in a pane', () => {
  // along: the pane's width (right) or height (bottom). Room is along − the 8 px gap.
  const rows: [string, number, DevtoolsSide, number, number][] = [
    ['what was asked for, when it fits', 1000, 'right', 440, 440],
    ['at least their minimum', 1000, 'right', 100, DEVTOOLS.minWidth],
    ['the page keeps its minimum', 1000, 'right', 900, 1000 - DEVTOOLS.gap - DEVTOOLS.minPage],
    ['bottom: their own minimum', 700, 'bottom', 50, DEVTOOLS.minHeight],
    ['bottom: the page keeps its minimum', 700, 'bottom', 650, 700 - DEVTOOLS.gap - DEVTOOLS.minPage],
    ['a pane too small for both splits in their proportion', 408, 'right', 440, Math.round((400 * 280) / 480)],
    ['nothing to share', 4, 'bottom', 320, 0],
    ['a nonsense size: the minimum', 1000, 'right', Number.NaN, DEVTOOLS.minWidth],
  ];
  it.each(rows)('%s', (_name, along, side, wanted, expected) => {
    expect(fitDevtools(along, side, wanted)).toBe(expected);
  });
});

describe('devtoolsLayout: the page, the edge and DevTools in a pane', () => {
  const rows: [string, PaneRect, DevtoolsSide, number, { page: PaneRect; edge: PaneRect; card: PaneRect; view: PaneRect }][] = [
    [
      'right of a whole frame',
      frame,
      'right',
      440,
      {
        page: { x: 0, y: 0, width: 552, height: 700 },
        edge: { x: 552, y: 0, width: 8, height: 700 },
        card: { x: 560, y: 0, width: 440, height: 700 },
        view: { x: 560, y: 32, width: 440, height: 668 },
      },
    ],
    [
      'under the page',
      frame,
      'bottom',
      320,
      {
        page: { x: 0, y: 0, width: 1000, height: 372 },
        edge: { x: 0, y: 372, width: 1000, height: 8 },
        card: { x: 0, y: 380, width: 1000, height: 320 },
        view: { x: 0, y: 412, width: 1000, height: 288 },
      },
    ],
    [
      'in a split pane away from the corner',
      { x: 508, y: 40, width: 492, height: 600 },
      'right',
      440,
      {
        page: { x: 508, y: 40, width: 200, height: 600 },
        edge: { x: 708, y: 40, width: 8, height: 600 },
        card: { x: 716, y: 40, width: 284, height: 600 },
        view: { x: 716, y: 72, width: 284, height: 568 },
      },
    ],
    [
      'a frame too short for the header: DevTools get none of it',
      { x: 0, y: 0, width: 600, height: 20 },
      'bottom',
      320,
      {
        page: { x: 0, y: 0, width: 600, height: 7 },
        edge: { x: 0, y: 7, width: 600, height: 8 },
        card: { x: 0, y: 15, width: 600, height: 5 },
        view: { x: 0, y: 20, width: 600, height: 0 },
      },
    ],
  ];
  it.each(rows)('%s', (_name, pane, side, size, expected) => {
    const out = devtoolsLayout(pane, side, size);
    expect(out).toEqual(expected);
    // Nothing overlaps or leaks out of the pane: page, edge and DevTools add up to it exactly.
    const along = side === 'right' ? 'width' : 'height';
    expect(out.page[along] + out.edge[along] + out.card[along]).toBe(pane[along]);
  });
});

describe('dragDevtools: the edge follows the pointer', () => {
  const rows: [string, DevtoolsSide, number, number, number][] = [
    ['right: dragging left grows them', 'right', 440, -100, 540],
    ['right: dragging right shrinks them', 'right', 440, 100, 340],
    ['right: not past their minimum', 'right', 440, 400, DEVTOOLS.minWidth],
    ['right: not past the page’s', 'right', 440, -900, 1000 - DEVTOOLS.gap - DEVTOOLS.minPage],
    ['bottom: dragging up grows them', 'bottom', 320, -80, 400],
    ['bottom: dragging down shrinks them', 'bottom', 320, 120, 200],
  ];
  it.each(rows)('%s', (_name, side, from, delta, expected) => {
    expect(dragDevtools(frame, side, from, delta)).toBe(expected);
  });
});

describe('the setting: one for every tab, saved', () => {
  const rows: [string, Record<string, unknown>, Partial<DevtoolsSettings>][] = [
    ['a side and sizes as they are', { side: 'bottom', width: 500, height: 300, window: true }, { side: 'bottom', width: 500, height: 300, window: true }],
    ['sizes rounded, and kept to their side’s minimum', { width: 12.6, height: 99.5 }, { width: DEVTOOLS.minWidth, height: DEVTOOLS.minHeight }],
    ['nothing past the largest', { width: 99_999, height: 4001 }, { width: DEVTOOLS.max, height: DEVTOOLS.max }],
    ['an unknown side, a string size and a non-boolean: what was there', { side: 'left', width: '600', window: 'yes' }, { side: 'right', width: 440, window: false }],
  ];
  it.each(rows)('%s', (_name, saved, expected) => {
    expect(cleanDevtoolsSettings(DEFAULT_DEVTOOLS, saved)).toMatchObject(expected);
    // Restored from chord-data the same way.
    expect(restoreState({ chords: [], nodes: [], windows: [], settings: { devtools: saved } }, seed).settings.devtools).toMatchObject(expected);
    // And set from main (the edge let go, a header button): the same rules.
    expect(apply(emptyState(), { t: 'settings.set', settings: { devtools: saved as Partial<DevtoolsSettings> } }, ctx).state.settings.devtools).toMatchObject(expected);
  });

  it('starts on the right, 440 wide or 320 tall, docked', () => {
    expect(emptyState().settings.devtools).toEqual({ side: 'right', width: 440, height: 320, window: false });
    expect(restoreState(null, seed).settings.devtools).toEqual(DEFAULT_DEVTOOLS);
  });

  it('changes only what a command names, and nothing when it names what’s there', () => {
    const state = apply(emptyState(), { t: 'settings.set', settings: { devtools: { width: 600 } } }, ctx).state;
    expect(state.settings.devtools).toEqual({ ...DEFAULT_DEVTOOLS, width: 600 });
    expect(apply(state, { t: 'settings.set', settings: { devtools: { side: 'right', width: 600 } } }, ctx).patches).toEqual([]);
  });
});
