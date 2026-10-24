import type { FrameSnapshotEvent, Rect } from '@chord/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameSnapshots, isTyping, offscreen, PREPARE_TIMEOUT_MS, type FrameHost } from '../../src/main/frame-snapshot';

const WINDOW = { width: 1280, height: 820 };
const DOCKED: Rect = { x: 248, y: 40, width: 1028, height: 776 };
const COLLAPSED: Rect = { x: 4, y: 40, width: 1272, height: 776 };

type Capture = 'ok' | 'fail' | 'hang';

/** A page: its bounds, a picture of one BGRA pixel, focus, and its input listeners. */
function fakeView(rect: Rect, capture: { mode: Capture; count: number }) {
  const listeners = new Set<(event: unknown, input: unknown) => void>();
  return {
    bounds: { ...rect },
    listeners,
    webContents: {
      isFocused: () => true,
      on: (_name: string, listener: (event: unknown, input: unknown) => void) => listeners.add(listener),
      off: (_name: string, listener: (event: unknown, input: unknown) => void) => listeners.delete(listener),
      capturePage: () => {
        capture.count++;
        if (capture.mode === 'fail') return Promise.reject(new Error('no picture'));
        if (capture.mode === 'hang') return new Promise(() => {});
        return Promise.resolve({
          isEmpty: () => false,
          getScaleFactors: () => [1],
          getSize: () => ({ width: 1, height: 1 }),
          // Blue 1, green 2, red 3, alpha 255.
          toBitmap: () => Buffer.from([1, 2, 3, 255]),
        });
      },
    },
  };
}

/** A window with one page (or a split's two) whose frame goes where `target` says. */
function setUp({ panes = 1, can = true, capture = 'ok' as Capture } = {}) {
  const events: FrameSnapshotEvent[] = [];
  const captures = { mode: capture, count: 0 };
  const split = (frame: Rect): Rect[] =>
    panes === 1 ? [frame] : [{ ...frame, width: (frame.width - 8) / 2 }, { ...frame, x: frame.x + (frame.width + 8) / 2, width: (frame.width - 8) / 2 }];
  const state = { frame: DOCKED, moves: 0 };
  const views = split(DOCKED).map((r) => fakeView(r, captures));
  const host: FrameHost = {
    tell: (event) => events.push(event),
    panes: () => views.map((v) => ({ view: v as never, rect: { ...v.bounds } })),
    canSnapshot: () => can,
    targets: () => split(state.frame),
    layout: () =>
      views.forEach((v, i) => {
        const rect = split(state.frame)[i]!;
        const to = snapshots.active ? offscreen(rect, WINDOW) : rect;
        if (JSON.stringify(to) === JSON.stringify(v.bounds)) return;
        v.bounds = to;
        state.moves++;
      }),
  };
  const snapshots = new FrameSnapshots(host);
  const collapse = () => (state.frame = COLLAPSED);
  const dock = () => (state.frame = DOCKED);
  const phases = () => events.map((e) => e.phase);
  return { snapshots, events, phases, views, state, captures, collapse, dock };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the frame snapshot', () => {
  it('pictures the pages, waits for the shell to show them, then changes the frame and sends the pictures there', async () => {
    const t = setUp();
    const change = vi.fn(t.collapse);
    t.snapshots.change(change, true);
    await settle();
    // Pictured and shown first; the frame hasn't changed yet.
    expect(t.phases()).toEqual(['show']);
    const show = t.events[0] as Extract<FrameSnapshotEvent, { phase: 'show' }>;
    // The pixels as captured (BGRA): the shell's worker converts them, not main.
    expect(show.panes).toEqual([{ rect: DOCKED, width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) }]);
    expect(change).not.toHaveBeenCalled();

    t.snapshots.ack(show.seq, 'shown');
    await settle();
    // The page waits out of sight at its final size; the pictures go where the frame is now.
    expect(change).toHaveBeenCalledOnce();
    expect(t.snapshots.active).toBe(true);
    expect(t.views[0]!.bounds).toEqual(offscreen(COLLAPSED, WINDOW));
    expect(t.events[1]).toEqual({ seq: show.seq, phase: 'move', rects: [COLLAPSED] });

    t.snapshots.ack(show.seq, 'moved');
    await settle();
    // Into place: two moves in all, and the pictures go.
    expect(t.snapshots.active).toBe(false);
    expect(t.views[0]!.bounds).toEqual(COLLAPSED);
    expect(t.state.moves).toBe(2);
    expect(t.phases()).toEqual(['show', 'move', 'drop']);
  });

  it('pictures every pane of a split and sends each where the pane rects put it', async () => {
    const t = setUp({ panes: 2 });
    t.snapshots.change(t.collapse, true);
    await settle();
    const show = t.events[0] as Extract<FrameSnapshotEvent, { phase: 'show' }>;
    expect(t.captures.count).toBe(2);
    expect(show.panes.map((p) => p.rect.x)).toEqual([248, 248 + (1028 + 8) / 2]);
    t.snapshots.ack(show.seq, 'shown');
    await settle();
    const move = t.events[1] as Extract<FrameSnapshotEvent, { phase: 'move' }>;
    expect(move.rects.map((r) => r.x)).toEqual([4, 4 + (1272 + 8) / 2]);
    t.snapshots.ack(show.seq, 'moved');
    await settle();
    expect(t.state.moves).toBe(4);
  });

  it('sends moving pictures on to the next change without picturing again', async () => {
    const t = setUp();
    t.snapshots.change(t.collapse, true);
    await settle();
    const { seq } = t.events[0]!;
    t.snapshots.ack(seq, 'shown');
    await settle();
    t.snapshots.change(t.dock, true);
    await settle();
    expect(t.captures.count).toBe(1);
    expect(t.events.at(-1)).toEqual({ seq, phase: 'move', rects: [DOCKED] });
    t.snapshots.ack(seq, 'moved');
    await settle();
    expect(t.views[0]!.bounds).toEqual(DOCKED);
    expect(t.phases()).toEqual(['show', 'move', 'move', 'drop']);
  });

  it('changes at once with no motion, or when there is nothing to picture', async () => {
    for (const [animate, can] of [
      [false, true],
      [true, false],
    ] as const) {
      const t = setUp({ can });
      t.snapshots.change(t.collapse, animate);
      await settle();
      expect(t.captures.count).toBe(0);
      expect(t.events).toEqual([]);
      expect(t.views[0]!.bounds).toEqual(COLLAPSED);
      expect(t.state.moves).toBe(1);
    }
  });

  it('changes at once when a picture fails, or the shell takes too long to show it', async () => {
    const failed = setUp({ capture: 'fail' });
    failed.snapshots.change(failed.collapse, true);
    await settle();
    expect(failed.events).toEqual([]);
    expect(failed.views[0]!.bounds).toEqual(COLLAPSED);

    const hung = setUp({ capture: 'hang' });
    hung.snapshots.change(hung.collapse, true);
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS - 1);
    expect(hung.views[0]!.bounds).toEqual(DOCKED);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.views[0]!.bounds).toEqual(COLLAPSED);

    const slow = setUp();
    slow.snapshots.change(slow.collapse, true);
    await settle();
    expect(slow.phases()).toEqual(['show']);
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    // The pictures are taken down again, and the frame just changes.
    expect(slow.phases()).toEqual(['show', 'drop']);
    expect(slow.views[0]!.bounds).toEqual(COLLAPSED);
    expect(slow.state.moves).toBe(1);
  });

  it('brings the page back when a key is typed into it, or the shell never says the pictures arrived', async () => {
    const t = setUp();
    t.snapshots.change(t.collapse, true);
    await settle();
    t.snapshots.ack(t.events[0]!.seq, 'shown');
    await settle();
    expect(t.views[0]!.listeners.size).toBe(1);
    // A held modifier doesn't count; a letter does.
    for (const listener of t.views[0]!.listeners) listener({}, { type: 'rawKeyDown', key: 'Control', isAutoRepeat: false });
    expect(t.snapshots.active).toBe(true);
    for (const listener of [...t.views[0]!.listeners]) listener({}, { type: 'keyDown', key: 'k', isAutoRepeat: false });
    expect(t.snapshots.active).toBe(false);
    expect(t.views[0]!.bounds).toEqual(COLLAPSED);
    expect(t.views[0]!.listeners.size).toBe(0);

    const silent = setUp();
    silent.snapshots.change(silent.collapse, true);
    await settle();
    silent.snapshots.ack(silent.events[0]!.seq, 'shown');
    await settle();
    expect(silent.snapshots.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(silent.snapshots.active).toBe(false);
    expect(silent.views[0]!.bounds).toEqual(COLLAPSED);
  });

  it('runs changes in order, so a second toggle waits for the first', async () => {
    const t = setUp();
    const order: string[] = [];
    t.snapshots.change(() => {
      order.push('collapse');
      t.collapse();
    }, true);
    t.snapshots.change(() => {
      order.push('dock');
      t.dock();
    }, true);
    await settle();
    expect(order).toEqual([]);
    t.snapshots.ack(t.events[0]!.seq, 'shown');
    await settle();
    expect(order).toEqual(['collapse', 'dock']);
    expect(t.events.at(-1)).toMatchObject({ phase: 'move', rects: [DOCKED] });
  });
});

describe('frame snapshot helpers', () => {
  it('keeps one pixel of a waiting page inside the window, in its corner', () => {
    expect(offscreen(COLLAPSED, WINDOW)).toEqual({ x: 1279, y: 819, width: COLLAPSED.width, height: COLLAPSED.height });
  });

  it('counts only keys that type: not modifiers alone, not repeats, not key-ups', () => {
    expect(isTyping({ type: 'keyDown', key: 'a', isAutoRepeat: false })).toBe(true);
    expect(isTyping({ type: 'char', key: 'a', isAutoRepeat: false })).toBe(true);
    expect(isTyping({ type: 'rawKeyDown', key: 'Shift', isAutoRepeat: false })).toBe(false);
    expect(isTyping({ type: 'keyDown', key: 'a', isAutoRepeat: true })).toBe(false);
    expect(isTyping({ type: 'keyUp', key: 'a', isAutoRepeat: false })).toBe(false);
  });
});
