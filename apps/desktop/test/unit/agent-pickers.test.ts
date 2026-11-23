import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdFilePickers, pickersLost, retryPickers } from '../../src/main/agents/pickers';

// Neon's review of #110: an agent's tab holds file pickers for its whole life, in its page and its frames' targets.
describe('holdFilePickers', () => {
  afterEach(() => vi.useRealTimers());
  const fake = (attachThrows = false) => {
    const events = new EventEmitter();
    const page = new EventEmitter();
    const sent: [string, unknown, string | undefined][] = [];
    const state = { attached: false, attachThrows, attaches: 0, fail: new Set<string>(), hold: null as null | Promise<void> };
    const contents = {
      isDestroyed: () => false,
      on: (e: string, f: (...a: unknown[]) => void) => page.on(e, f),
      debugger: {
        isAttached: () => state.attached,
        attach: () => {
          state.attaches++;
          if (state.attachThrows) throw new Error('Another debugger is already attached');
          state.attached = true;
        },
        on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
        sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
          sent.push([method, params, sessionId]);
          if (state.hold && method === 'Page.setInterceptFileChooserDialog') await state.hold;
          if (state.fail.has(method)) throw new Error(`${method} failed`);
        },
      },
    };
    return { contents: contents as unknown as WebContents, events, page, sent, state };
  };
  const names = (sent: [string, unknown, string | undefined][]) => sent.map(([m, , s]) => `${m}${s ? `@${s}` : ''}`);
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('intercepts in the page, and in each frame before it runs; iframes only; says when a picker was held', async () => {
    const { contents, events, sent } = fake();
    const held: string[] = [];
    holdFilePickers(contents, (d) => void held.push(d));
    await settle();
    expect(names(sent)).toEqual(['Page.enable', 'Page.setInterceptFileChooserDialog', 'Target.setAutoAttach']);
    expect(sent[1]![1]).toEqual({ enabled: true });
    expect(sent[2]![1]).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] });
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    await settle();
    // Its interception on, and only then let go on.
    expect(names(sent.slice(3))).toEqual(['Page.enable@s1', 'Page.setInterceptFileChooserDialog@s1', 'Target.setAutoAttach@s1', 'Runtime.runIfWaitingForDebugger@s1']);
    events.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' }, 's1');
    expect(held).toEqual(['a file picker']);
    expect(pickersLost(contents)).toBe(false);
  });

  it('let go of: the hold is lost (acting refused) until it’s attached and armed again', async () => {
    vi.useFakeTimers();
    const { contents, events, sent, state } = fake();
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    state.attached = false;
    events.emit('detach', {}, 'target closed');
    expect(pickersLost(contents)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.attaches).toBe(2);
    expect(names(sent)).toEqual(['Page.enable', 'Page.setInterceptFileChooserDialog', 'Target.setAutoAttach']);
    expect(pickersLost(contents)).toBe(false);
  });

  it('can’t be had: lost, so nothing is pressed or typed there, and tried again', async () => {
    vi.useFakeTimers();
    const { contents, sent, state } = fake(true);
    holdFilePickers(contents, () => undefined);
    expect(pickersLost(contents)).toBe(true);
    expect(sent).toEqual([]);
    state.attachThrows = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(pickersLost(contents)).toBe(false);
  });

  it('a hold that answered after a detach counts for nothing: still lost, armed again on the new attachment', async () => {
    vi.useFakeTimers();
    const { contents, events, state } = fake();
    let answer = () => undefined as void;
    state.hold = new Promise<void>((r) => (answer = r));
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // Let go of while its interception is in flight.
    state.attached = false;
    events.emit('detach', {}, 'target closed');
    state.hold = null;
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.attaches).toBe(2);
    expect(pickersLost(contents)).toBe(false);
  });

  it('an interception that failed: lost, and a frame held at its start is let go on anyway', async () => {
    vi.useFakeTimers();
    const { contents, events, sent, state } = fake();
    state.fail.add('Page.setInterceptFileChooserDialog');
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(true);
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(names(sent)).toContain('Runtime.runIfWaitingForDebugger@s1');
    // An action tries once more, and it's on once the interception answers.
    state.fail.clear();
    await expect(retryPickers(contents)).resolves.toBe(true);
    expect(pickersLost(contents)).toBe(false);
  });

  it('a debugger that keeps letting go: tried with a growing wait, then only by an action or a load', async () => {
    vi.useFakeTimers();
    const { contents, page, state } = fake(true);
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    const tried = state.attaches;
    expect(tried).toBe(9);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.attaches).toBe(tried);
    state.attachThrows = false;
    page.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(false);
  });
});
