import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdFailed, holdFilePickers, pickersLost, pickersUnsecured, retryPickers } from '../../src/main/agents/pickers';

// Neon's review of #110: an agent's tab holds file pickers for its whole life, in its page and its frames' targets.
describe('holdFilePickers', () => {
  afterEach(() => vi.useRealTimers());
  const fake = (attachThrows = false) => {
    const events = new EventEmitter();
    const page = new EventEmitter();
    const sent: [string, unknown, string | undefined][] = [];
    const state = { attached: false, attachThrows, attaches: 0, fail: new Set<string>(), hold: null as null | Promise<void>, existing: [] as string[] };
    const contents = {
      isDestroyed: () => false,
      // A new page: no address, no renderer yet (its service workers are bypassed once it has one: tabs.ts).
      getURL: () => '',
      on: (e: string, f: (...a: unknown[]) => void) => page.on(e, f),
      once: (e: string, f: (...a: unknown[]) => void) => page.once(e, f),
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
          // Frames already there when the page's auto-attach is asked: attached before it answers, running.
          if (method === 'Target.setAutoAttach' && !sessionId) for (const id of state.existing) events.emit('message', {}, 'Target.attachedToTarget', { sessionId: id, targetInfo: { type: 'iframe' }, waitingForDebugger: false });
          if (state.fail.has(method) || state.fail.has(`${method}@${sessionId ?? ''}`)) throw new Error(`${method} failed`);
          // A worker's read-only script: true, unless the page's own threw first.
          if (method === 'Runtime.evaluate') return state.fail.has(`throws@${sessionId ?? ''}`) ? { exceptionDetails: { text: 'x' } } : { result: { value: true } };
          return undefined;
        },
      },
    };
    return { contents: contents as unknown as WebContents, events, page, sent, state };
  };
  const names = (sent: [string, unknown, string | undefined][]) => sent.map(([m, , s]) => `${m}${s ? `@${s}` : ''}`);
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('intercepts in the page, and in each frame before it runs; frames and dedicated workers only, service workers bypassed; says when a picker was held', async () => {
    const { contents, events, sent } = fake();
    const held: string[] = [];
    holdFilePickers(contents, (d) => void held.push(d));
    await settle();
    expect(names(sent)).toEqual(['Target.setAutoAttach', 'Fetch.enable', 'Page.enable', 'Page.setInterceptFileChooserDialog']);
    expect(sent[3]![1]).toEqual({ enabled: true });
    expect(sent[0]![1]).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }, { type: 'worker' }] });
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    await settle();
    // Its interception on, and only then let go on.
    expect(names(sent.slice(4))).toEqual(['Target.setAutoAttach@s1', 'Network.enable@s1', 'Network.setBypassServiceWorker@s1', 'Page.enable@s1', 'Page.addScriptToEvaluateOnNewDocument@s1', 'Page.setInterceptFileChooserDialog@s1', 'Fetch.enable@s1', 'Runtime.runIfWaitingForDebugger@s1']);
    events.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' }, 's1');
    expect(held).toEqual(['a file picker']);
    expect(pickersLost(contents)).toBe(false);
  });

  it('a dedicated worker: its nested workers held, service workers bypassed, made to read only, then it runs (#112 review 3)', async () => {
    const { contents, events, sent, state } = fake();
    holdFilePickers(contents, () => undefined);
    await settle();
    sent.length = 0;
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'w1', targetInfo: { type: 'worker' } });
    await settle();
    expect(names(sent)).toEqual(['Target.setAutoAttach@w1', 'Network.enable@w1', 'Network.setBypassServiceWorker@w1', 'Runtime.evaluate@w1', 'Runtime.runIfWaitingForDebugger@w1']);
    // One whose read-only script threw never runs.
    sent.length = 0;
    state.fail.add('throws@w0');
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'w0', targetInfo: { type: 'worker' } });
    await settle();
    expect(names(sent)).not.toContain('Runtime.runIfWaitingForDebugger@w0');
    // One whose nested workers can't be held never runs.
    sent.length = 0;
    state.fail.add('Target.setAutoAttach@w2');
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'w2', targetInfo: { type: 'worker' } });
    await settle();
    expect(names(sent)).not.toContain('Runtime.runIfWaitingForDebugger@w2');
    expect(pickersUnsecured(contents)).toBe(true);
    // A frame whose sends can't be held stays held too.
    sent.length = 0;
    state.fail.add('Fetch.enable@f3');
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'f3', targetInfo: { type: 'iframe' } });
    await settle();
    expect(names(sent)).not.toContain('Runtime.runIfWaitingForDebugger@f3');
  });

  it('the page loads only once its hold is on: its sends held from the start (#112 review 3, fail closed)', async () => {
    vi.useFakeTimers();
    const { contents, state } = fake();
    state.fail.add('Fetch.enable');
    let loaded = false;
    void holdFilePickers(contents, () => undefined).then(() => (loaded = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded).toBe(false);
    expect(pickersLost(contents)).toBe(true);
    // Armed again once it can be: then it loads.
    state.fail.delete('Fetch.enable');
    await vi.advanceTimersByTimeAsync(300);
    expect(loaded).toBe(true);
    expect(pickersLost(contents)).toBe(false);
  });

  it('a hold that couldn’t be finished (its service workers not bypassed): lost and unsecured, so nothing acts and open_tab refuses (round 4 of #112)', async () => {
    const { contents } = fake();
    holdFilePickers(contents, () => undefined);
    await settle();
    expect(pickersLost(contents)).toBe(false);
    holdFailed(contents);
    expect(pickersLost(contents)).toBe(true);
    expect(pickersUnsecured(contents)).toBe(true);
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
    expect(names(sent)).toEqual(['Target.setAutoAttach', 'Fetch.enable', 'Page.enable', 'Page.setInterceptFileChooserDialog']);
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

  it('an interception that failed: lost; a frame whose own failed (twice) stays held, never run without it', async () => {
    vi.useFakeTimers();
    const { contents, events, sent, state } = fake();
    state.fail.add('Page.setInterceptFileChooserDialog');
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(true);
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(names(sent).filter((n) => n.endsWith('@s1'))).toEqual(['Target.setAutoAttach@s1', 'Network.enable@s1', 'Network.setBypassServiceWorker@s1', 'Page.enable@s1', 'Page.addScriptToEvaluateOnNewDocument@s1', 'Page.setInterceptFileChooserDialog@s1', 'Page.setInterceptFileChooserDialog@s1']);
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

  it('frames already there when it arms: on only once every one is held; one that can’t be: lost, and the page unsecured', async () => {
    vi.useFakeTimers();
    const { contents, page, state } = fake();
    state.existing = ['f1', 'f2'];
    state.fail.add('Page.setInterceptFileChooserDialog@f2');
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(true);
    expect(pickersUnsecured(contents)).toBe(true);
    // The page's next document (its frames its own): armed again, all held.
    state.fail.clear();
    page.emit('did-navigate');
    expect(pickersUnsecured(contents)).toBe(false);
    page.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(false);
  });

  it('an auto-attach that fails: the hold isn’t on (its frames would run unheld)', async () => {
    vi.useFakeTimers();
    const { contents, state } = fake();
    state.fail.add('Target.setAutoAttach@');
    holdFilePickers(contents, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(pickersLost(contents)).toBe(true);
    state.fail.clear();
    await vi.advanceTimersByTimeAsync(300);
    expect(pickersLost(contents)).toBe(false);
  });
});
