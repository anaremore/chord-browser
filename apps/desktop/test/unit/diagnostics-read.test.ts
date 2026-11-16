/**
 * page_diagnostics' read against a fake page debugger: a hung page never holds the turn
 * (ARCHITECTURE.md §1, rule 1), a failure says what failed, someone else's client is left
 * attached, and Chord's debugger clients take turns per page (debugger-queue.ts).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readDiagnostics, type DiagnosticsContents } from '../../src/main/assistant/diagnostics';
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

const page = (debug: FakeDebugger, script: () => Promise<unknown> = async () => ({})) =>
  ({ isDestroyed: () => false, executeJavaScriptInIsolatedWorld: script, debugger: debug }) as unknown as DiagnosticsContents;

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
    const started = Date.now();
    const read = await readDiagnostics(page(debug), 50);
    expect(Date.now() - started).toBeLessThan(1000);
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
    const started = Date.now();
    const read = await readDiagnostics(page(debug), 50);
    expect(Date.now() - started).toBeLessThan(1000);
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

  it('a turn that fails doesn’t stop the ones after it', async () => {
    const contents = {};
    const failed = withDebugger(contents, () => Promise.reject(new Error('broke')));
    const next = withDebugger(contents, async () => 'ran');
    await expect(failed).rejects.toThrow('broke');
    await expect(next).resolves.toBe('ran');
  });
});
