/**
 * Peek's card in motion (renderer/overlay/peek-motion.ts): drawn once a frame
 * while it's dragged or glides home, its boxes sent to main latest-wins; and
 * stopped at once, sending nothing more, before Open as tab (#78's review: a
 * glide or drag still running moved the page as it grew) and when Peek closes.
 */
import type { PeekBox } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { CardMotion } from '../../src/renderer/overlay/peek-motion';

const area: PeekBox = { x: 248, y: 44, width: 1000, height: 700 };
const start: PeekBox = { x: 400, y: 150, width: 600, height: 400 };
const home: PeekBox = { x: 308, y: 87, width: 880, height: 616 };

/** A card with its frames, glide and main all in the test's hands. */
function card() {
  const frames = new Map<number, () => void>();
  let id = 0;
  const sent: (PeekBox | null)[] = [];
  const answers: (() => void)[] = [];
  const drawn: PeekBox[] = [];
  const committed: PeekBox[] = [];
  let glide: { update: (k: number) => void; complete: () => void; stopped: boolean } | null = null;
  let motionOn = true;
  const motion = new CardMotion(start, {
    draw: (b) => drawn.push(b),
    commit: (b) => committed.push(b),
    move: (b) => {
      sent.push(b);
      return new Promise((done) => answers.push(() => done(b ?? home)));
    },
    frame: (run) => (frames.set(++id, run), id),
    cancelFrame: (i) => frames.delete(i),
    glide: (update, complete) => {
      if (!motionOn) return null;
      const g = { update, complete, stopped: false };
      glide = g;
      return { stop: () => (g.stopped = true) };
    },
  });
  return {
    motion,
    sent,
    drawn,
    committed,
    get glide() {
      return glide!;
    },
    noMotion: () => (motionOn = false),
    /** The next frame comes. */
    frame: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const run of due) run();
    },
    /** Main answers everything on its way. */
    answer: async () => {
      while (answers.length) {
        answers.shift()!();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe('CardMotion', () => {
  it('a drag: several pointer moves in a frame draw and send one box, the latest', () => {
    const c = card();
    c.motion.press('move', 500, 160, 1);
    for (const dx of [5, 10, 20]) c.motion.drag(1, 500 + dx, 160, area);
    expect(c.sent).toEqual([]);
    c.frame();
    expect(c.drawn).toEqual([{ ...start, x: 420 }]);
    expect(c.sent).toEqual([{ ...start, x: 420 }]);
  });

  it('let go: the last box goes at once, and React gets it', () => {
    const c = card();
    c.motion.press('se', 1002, 552, 1);
    c.motion.drag(1, 1052, 602, area);
    expect(c.motion.release(1)).toBe('se');
    expect(c.sent).toEqual([{ ...start, width: 650, height: 450 }]);
    expect(c.committed.at(-1)).toEqual({ ...start, width: 650, height: 450 });
    expect(c.motion.busy).toBe(false);
  });

  it('home: glides frame by frame, then tells main home (null); with motion off, at once', async () => {
    const c = card();
    c.motion.goHome(home, area);
    c.glide.update(0.5);
    c.glide.update(1);
    c.glide.complete();
    await c.answer();
    expect(c.drawn).toHaveLength(2);
    expect(c.sent.at(-1)).toBeNull();
    expect(c.committed.at(-1)).toEqual(home);

    const off = card();
    off.noMotion();
    off.motion.goHome(home, area);
    expect(off.drawn).toEqual([]);
    expect(off.committed).toEqual([home]);
    expect(off.sent).toEqual([null]);
  });

  it('a press on its way home: the glide stops where it got to, and the drag starts from there', () => {
    const c = card();
    c.motion.goHome(home, area);
    c.glide.update(0.5);
    const there = c.motion.box;
    c.motion.press('move', 600, 100, 1);
    expect(c.glide.stopped).toBe(true);
    c.glide.update(0.8);
    expect(c.motion.box).toEqual(there);
    c.motion.drag(1, 610, 100, area);
    c.frame();
    expect(c.motion.box).toEqual({ ...there, x: there.x + 10 });
  });

  // Open as tab (its button, or Ctrl+Enter / ⌘↵) stops the card first: whatever was moving it sends nothing more.
  it.each<[string, (c: ReturnType<typeof card>) => void]>([
    [
      'mid-drag, a frame waiting',
      (c) => {
        c.motion.press('move', 500, 160, 1);
        c.motion.drag(1, 540, 160, area);
      },
    ],
    [
      'mid-drag, a box waiting behind one on its way',
      (c) => {
        c.motion.press('move', 500, 160, 1);
        c.motion.drag(1, 540, 160, area);
        c.frame();
        c.motion.drag(1, 560, 160, area);
        c.frame();
      },
    ],
    [
      'during the glide home (a double-click, then Open as tab within ~300 ms)',
      (c) => {
        c.motion.goHome(home, area);
        c.glide.update(0.3);
      },
    ],
  ])('Open as tab %s: nothing more is drawn or sent', async (_name, before) => {
    const c = card();
    before(c);
    const sent = c.sent.length;
    const drawn = c.drawn.length;
    c.motion.stop();
    // What would have come next: the frame, more pointer moves, the glide's frames and its end, main's answers.
    c.frame();
    c.motion.drag(1, 700, 300, area);
    c.frame();
    c.glide?.update(0.9);
    c.glide?.complete();
    await c.answer();
    expect(c.sent).toHaveLength(sent);
    expect(c.drawn).toHaveLength(drawn);
    expect(c.motion.busy).toBe(false);
    expect(c.motion.release(1)).toBeNull();
  });
});
