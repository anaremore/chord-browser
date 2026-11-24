/**
 * page_diagnostics' read against a fake page debugger: a hung page never holds the turn
 * (ARCHITECTURE.md §1, rule 1), a failure says what failed, someone else's client is left
 * attached, and Chord's debugger clients take turns per page (debugger-queue.ts).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NAVIGATED, readDiagnostics, type DiagnosticsContents } from '../../src/main/assistant/diagnostics';
import { withDebugger } from '../../src/main/debugger-queue';

type Answer = 'replay' | 'hang' | 'reject';

/** A page's debugger: Log.enable and Runtime.enable replay what the page kept, hang (a page stuck in `while (true)`), or fail. */
class FakeDebugger extends EventEmitter {
  attached = false;
  /** Every attach and detach, in order, across clients: two attaches in a row would be clients overlapping. */
  log: string[] = [];
  sent: string[] = [];
  constructor(
    private readonly answer: Answer,
    private readonly shared: string[] = [],
  ) {
    super();
  }
  isAttached() {
    return this.attached;
  }
  attach = vi.fn(() => {
    if (this.attached) throw new Error('Another debugger is already attached');
    this.attached = true;
    this.shared.push('attach');
  });
  detach = vi.fn(() => {
    this.attached = false;
    this.shared.push('detach');
  });
  sendCommand(method: string): Promise<unknown> {
    this.sent.push(method);
    if (this.answer === 'hang') return new Promise(() => undefined);
    if (this.answer === 'reject') return Promise.reject(new Error(`${method} wasn't found`));
    if (method === 'Log.enable') this.emit('message', {}, 'Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: net::ERR_FAILED', url: 'http://h/a?k=1' } });
    if (method === 'Runtime.enable') this.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'x'.repeat(1_000_000) }] });
    return Promise.resolve({});
  }
}

/**
 * What `read` answers, on fake timers: not before `limit` ms, and once that much has passed. A clock, not a stopwatch:
 * no wall-clock budget in the parallel suite (issue #85).
 */
async function byTheLimit<T>(read: () => Promise<T>, limit: number): Promise<T> {
  vi.useFakeTimers();
  try {
    let answer: { value: T } | null = null;
    const reading = read().then((value) => (answer = { value }));
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(answer, `answered before its ${limit} ms`).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer, `still waiting after its ${limit} ms`).not.toBeNull();
    await reading;
    return answer!.value;
  } finally {
    vi.useRealTimers();
  }
}

/** The page itself: its navigation events, as Electron sends them. */
const page = (debug: FakeDebugger, script: () => Promise<unknown> = async () => ({}), events = new EventEmitter()) =>
  Object.assign(events, { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: script, debugger: debug }) as unknown as DiagnosticsContents;

describe('page_diagnostics reads a page once and lets go', () => {
  it('a page that replays: its events, each cut as it arrived, then detached', async () => {
    const debug = new FakeDebugger('replay');
    const read = await readDiagnostics(page(debug));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.map((e) => e.kind)).toEqual(['log', 'console']);
    expect(JSON.stringify(read.events).length).toBeLessThan(5000);
    expect(debug.sent).toEqual(['Log.enable', 'Runtime.enable']);
    expect(debug.detach).toHaveBeenCalledOnce();
    expect(debug.attached).toBe(false);
  });

  it('a hung page: given up on within the limit, and detached at once, without waiting on it again', async () => {
    const debug = new FakeDebugger('hang');
    const read = await byTheLimit(() => readDiagnostics(page(debug), 50), 50);
    expect(read).toEqual({ ok: false, why: 'The page took too long to answer.' });
    expect(debug.detach).toHaveBeenCalledOnce();
    expect(debug.sent).toEqual(['Log.enable']);
  });

  it('a failure says what failed, not that the page was slow', async () => {
    const debug = new FakeDebugger('reject');
    const read = await readDiagnostics(page(debug), 50);
    expect(read).toEqual({ ok: false, why: "The page didn't answer (Log.enable wasn't found)." });
    expect(debug.detach).toHaveBeenCalledOnce();
  });

  it('a debugger Chord can’t attach says so', async () => {
    const debug = new FakeDebugger('replay');
    debug.attach.mockImplementationOnce(() => {
      throw new Error('No target');
    });
    const read = await readDiagnostics(page(debug));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.why).toMatch(/^Chord couldn't attach to the page \(No target\)\./);
  });

  it('someone else’s client, attached already: used, its domains turned off without waiting, and left attached', async () => {
    const debug = new FakeDebugger('hang');
    debug.attached = true;
    const read = await byTheLimit(() => readDiagnostics(page(debug), 50), 50);
    expect(read.ok).toBe(false);
    expect(debug.attach).not.toHaveBeenCalled();
    expect(debug.detach).not.toHaveBeenCalled();
    expect(debug.sent).toEqual(['Log.enable', 'Runtime.disable', 'Log.disable']);
    expect(debug.attached).toBe(true);
  });

  it('two reads and a screenshot at once take turns: never two clients on one page', async () => {
    const shared: string[] = [];
    const debug = new FakeDebugger('replay', shared);
    const contents = page(debug);
    // A screenshot's turn, as screenshots/service.ts takes it: attach, work, detach.
    const screenshot = withDebugger(contents, async () => {
      debug.attach();
      await new Promise((r) => setTimeout(r, 20));
      debug.detach();
    });
    const reads = await Promise.all([readDiagnostics(contents), screenshot, readDiagnostics(contents)]);
    expect(reads[0].ok && reads[2]?.ok).toBe(true);
    expect(shared).toEqual(['attach', 'detach', 'attach', 'detach', 'attach', 'detach']);
  });

  it('names each script context’s origin and frame (the page’s frames, an extension’s in them), from Runtime.enable', async () => {
    const debug = new FakeDebugger('replay');
    const send = debug.sendCommand.bind(debug);
    debug.sendCommand = (method: string) => {
      if (method === 'Runtime.enable') {
        debug.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://www.example.com', auxData: { frameId: 'top', isDefault: true } } });
        debug.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7, origin: 'https://mail.example.com', auxData: { frameId: 'mail', isDefault: true } } });
        debug.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 8, origin: 'chrome-extension://abc', auxData: { frameId: 'mail', isDefault: false } } });
      }
      return send(method);
    };
    const read = await readDiagnostics(page(debug));
    expect(read.ok && read.contexts).toEqual({
      1: { origin: 'https://www.example.com', frameId: 'top' },
      7: { origin: 'https://mail.example.com', frameId: 'mail' },
      8: { origin: 'chrome-extension://abc', frameId: 'mail' },
    });
    // Contexts aren't problems.
    expect(read.ok && read.events.map((e) => e.kind)).toEqual(['log', 'console']);
  });

  // Another document during the read: its events would mix with the old one's, at the same address or not.
  it.each([
    ['a reload, or a link (to the same address or another)', 'did-start-navigation', { isMainFrame: true, isSameDocument: false }, false],
    ['a navigation started before the read, arriving during it', 'did-navigate', {}, false],
    ['the address changing inside the document (pushState): its events are the same page’s', 'did-start-navigation', { isMainFrame: true, isSameDocument: true }, true],
    ['a frame inside the page loading again', 'did-start-navigation', { isMainFrame: false, isSameDocument: false }, true],
    // From the debugger itself, in order with the page's events.
    ['the page’s contexts cleared (its main frame went to another document)', 'Runtime.executionContextsCleared', {}, false],
  ] as const)('%s', async (_, event, details, ok) => {
    const debug = new FakeDebugger('replay');
    const events = new EventEmitter();
    const send = debug.sendCommand.bind(debug);
    debug.sendCommand = (method: string) => {
      if (method === 'Runtime.enable') {
        if (event.startsWith('Runtime.')) debug.emit('message', {}, event, details);
        else events.emit(event, details);
      }
      return send(method);
    };
    const read = await readDiagnostics(page(debug, undefined, events));
    expect(read.ok ? true : read.why).toBe(ok ? true : NAVIGATED);
    expect(debug.attached).toBe(false);
    // Nothing left listening on the page.
    expect(events.listenerCount('did-start-navigation') + events.listenerCount('did-navigate')).toBe(0);
  });

  it('a turn that fails doesn’t stop the ones after it', async () => {
    const contents = {};
    const failed = withDebugger(contents, () => Promise.reject(new Error('broke')));
    const next = withDebugger(contents, async () => 'ran');
    await expect(failed).rejects.toThrow('broke');
    await expect(next).resolves.toBe('ran');
  });
});
