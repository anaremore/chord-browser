import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event?: unknown) => void;

/**
 * A page for shared/frames.ts: its frames come when the test says, and its
 * input events are the test's to send. Loaded afresh each time (the module
 * keeps its queue, and listens for input, as it loads).
 */
async function page({ visible = true } = {}) {
  vi.resetModules();
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const on = { window: new Map<string, Listener[]>(), document: new Map<string, Listener[]>() };
  const listen = (where: Map<string, Listener[]>) => (type: string, listener: Listener) => where.set(type, [...(where.get(type) ?? []), listener]);
  const doc = { visibilityState: visible ? 'visible' : 'hidden', addEventListener: listen(on.document) };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { addEventListener: listen(on.window) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const reported: unknown[] = [];
  vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
  const mod = await import('../../src/renderer/shared/frames');
  return {
    ...mod,
    reported,
    /** The next frame, which began at `time` (now, by default): its requestAnimationFrame callbacks run. */
    frame(time = performance.now()) {
      const waiting = [...frames.values()];
      frames.clear();
      for (const callback of waiting) callback(time);
    },
    framesAsked: () => frames.size,
    /** An input event reaches the window (capture phase first). */
    input: (type: string) => on.window.get(type)?.forEach((l) => l({ type })),
    hide() {
      doc.visibilityState = 'hidden';
      on.document.get('visibilitychange')?.forEach((l) => l());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('one render a frame', () => {
  it("runs a frame's work together, in order, once, at the start of the next frame", async () => {
    const p = await page();
    const batches: string[][] = [];
    let current: string[] | null = null;
    p.batchFrames((run) => {
      current = [];
      run();
      batches.push(current);
      current = null;
    });
    const log = (name: string) => () => current?.push(name);
    p.nextFrame(log('patch 1'));
    p.nextFrame(log('patch 2'));
    p.inNextFrame<string>((v) => current?.push(v))('duet');
    expect(batches).toEqual([]);
    expect(p.framesAsked()).toBe(1);

    p.frame();
    expect(batches).toEqual([['patch 1', 'patch 2', 'duet']]);
    // Nothing left: the no-frame fallback doesn't run it twice.
    vi.advanceTimersByTime(500);
    expect(batches).toHaveLength(1);

    p.nextFrame(log('patch 3'));
    p.frame();
    expect(batches).toEqual([['patch 1', 'patch 2', 'duet'], ['patch 3']]);
  });

  it('renders what waits before a key or a click is handled', async () => {
    const p = await page();
    for (const type of ['keydown', 'pointerdown', 'click']) {
      const ran: string[] = [];
      p.nextFrame(() => ran.push(type));
      p.input(type);
      expect(ran).toEqual([type]);
      // The frame it had asked for has nothing left to do.
      p.frame();
      expect(ran).toEqual([type]);
    }
  });

  it('runs at once in a hidden page, which paints no frames, and when the page goes hidden', async () => {
    const hidden = await page({ visible: false });
    const ran: number[] = [];
    hidden.nextFrame(() => ran.push(1));
    expect(ran).toEqual([1]);
    expect(hidden.framesAsked()).toBe(0);

    const p = await page();
    p.nextFrame(() => ran.push(2));
    p.hide();
    expect(ran).toEqual([1, 2]);
  });

  it("runs after a while in a page that's visible but gets no frame (a covered window)", async () => {
    const p = await page();
    const ran: string[] = [];
    p.nextFrame(() => ran.push('late'));
    vi.advanceTimersByTime(99);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(['late']);
    expect(p.framesAsked()).toBe(0);
  });

  it('leaves the work for the next frame when this one has rendered already, but only once', async () => {
    const p = await page();
    const ran: string[] = [];
    /** A moment after now (the clock is the test's). */
    const later = () => {
      vi.advanceTimersByTime(1);
      return performance.now();
    };

    // The shell rendered in an earlier frame: this one runs the work.
    p.noteRender();
    p.nextFrame(() => ran.push('patch 1'));
    p.frame(later());
    expect(ran).toEqual(['patch 1']);

    // A frame begins, and the shell renders in it (a click's own feedback) before its callbacks run:
    // it has its render, so the work waits for the next frame.
    p.nextFrame(() => ran.push('patch 2'));
    let begins = performance.now();
    p.noteRender();
    p.frame(begins);
    expect(ran).toEqual(['patch 1']);
    expect(p.framesAsked()).toBe(1);
    p.frame(later());
    expect(ran).toEqual(['patch 1', 'patch 2']);

    // Only once: a shell that renders every frame (a drag) can't keep the work waiting.
    p.nextFrame(() => ran.push('patch 3'));
    for (let i = 0; i < 2; i++) {
      begins = performance.now();
      p.noteRender();
      p.frame(begins);
    }
    expect(ran).toEqual(['patch 1', 'patch 2', 'patch 3']);
  });

  it("doesn't let one failure hold back the rest of the frame", async () => {
    const p = await page();
    const ran: string[] = [];
    p.nextFrame(() => {
      throw new Error('broken');
    });
    p.nextFrame(() => ran.push('after'));
    p.frame();
    expect(ran).toEqual(['after']);
    expect(p.reported).toHaveLength(1);
  });
});
