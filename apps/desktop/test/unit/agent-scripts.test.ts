import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PAGE_LACKS, printAsks, printBinding, printEvent, printHold, printUntil, WORKER_READS_ONLY } from '../../src/main/agents/agent-scripts';

/**
 * A dedicated worker's scope, as far as the lock needs one: its own built-ins (a vm context's), a `fetch` that records
 * what it was asked to send, and an XHR that records the method of each send. The lock runs first, as the hold runs it
 * before the worker's code (agents/pickers.ts); then the "worker's code" (each row) tampers, and tries to send.
 */
function workerScope() {
  const sent: string[] = [];
  const context = createContext({ sent, Request });
  runInContext(
    `self = globalThis;
     self.fetch = function fetch(request) { sent.push('fetch ' + request.method); return Promise.resolve('ok'); };
     self.XMLHttpRequest = class XMLHttpRequest {
       open(method, url) { if (url === 'bad') throw new Error('bad'); this.m = method; }
       send() { sent.push('xhr ' + this.m); }
     };`,
    context,
  );
  expect(runInContext(WORKER_READS_ONLY, context)).toBe(true);
  return { sent, run: (code: string) => runInContext(`(async () => { ${code} })()`, context) as Promise<unknown> };
}

describe('a dedicated worker in an agent’s tab reads, never sends (round 4 of #112)', () => {
  it('reads go; sends are refused, by fetch and by XHR', async () => {
    const w = workerScope();
    await w.run(`await fetch('https://a.test/x'); await fetch('https://a.test/x', { method: 'HEAD' });`);
    await expect(w.run(`await fetch('https://a.test/x', { method: 'POST', body: 'x' });`)).rejects.toThrow('A worker can’t send data');
    await expect(w.run(`const x = new XMLHttpRequest(); x.open('POST', 'https://a.test/x'); x.send('x');`)).rejects.toThrow('A worker can’t send data');
    await w.run(`const x = new XMLHttpRequest(); x.open('get', 'https://a.test/x'); x.send();`);
    expect(w.sent).toEqual(['fetch GET', 'fetch HEAD', 'xhr GET']);
  });

  // Each way round it a review found: the worker's own code replaces a built-in, then tries to send.
  it.each([
    ['Set.prototype.has', `Set.prototype.has = () => true;`],
    ['WeakMap.prototype.get and set', `WeakMap.prototype.get = () => 'GET'; WeakMap.prototype.set = function () { return this; };`],
    ['String.prototype.toUpperCase', `String.prototype.toUpperCase = () => 'GET';`],
    ['Function.prototype.call and apply', `Function.prototype.call = function () { return 'GET'; }; Function.prototype.apply = function () { return 'GET'; };`],
    ['Reflect.apply', `Reflect.apply = () => 'GET';`],
    ['Request’s method getter', `Object.defineProperty(Request.prototype, 'method', { get: () => 'GET', configurable: true });`],
    ['the array iterator', `Array.prototype[Symbol.iterator] = function* () { yield 'GET'; };`],
    ['an init whose method changes', `globalThis.__init = { get method() { return (globalThis.__n = (globalThis.__n || 0) + 1) === 1 ? 'GET' : 'POST'; } };`],
  ])('%s replaced: still no send', async (_what, tamper) => {
    const w = workerScope();
    await w.run(tamper);
    const init = `globalThis.__init || { method: 'POST', body: 'x' }`;
    await w.run(`try { await fetch('https://a.test/x', ${init}); } catch {}`);
    await w.run(`try { const x = new XMLHttpRequest(); x.open('POST', 'https://a.test/x'); x.send('x'); } catch {}`);
    expect(w.sent.filter((s) => !s.endsWith('GET') && !s.endsWith('HEAD'))).toEqual([]);
  });

  it('XHR: open(POST), then an open(GET) that throws, then send: the POST is still refused', async () => {
    const w = workerScope();
    await expect(w.run(`const x = new XMLHttpRequest(); x.open('POST', 'https://a.test/x'); try { x.open('GET', 'bad'); } catch {} x.send('x');`)).rejects.toThrow('A worker can’t send data');
    expect(w.sent).toEqual([]);
  });

  // XHR's here; fetch's is checked in a real worker (agents.spec): a vm's global doesn't keep a property fixed as a
  // worker's global does.
  it('can’t be put back: XHR’s open and send are fixed', async () => {
    const w = workerScope();
    await w.run(`try { Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: () => 1 }); } catch {} try { XMLHttpRequest.prototype.open = function () {}; } catch {}`);
    await expect(w.run(`const x = new XMLHttpRequest(); x.open('PUT', 'https://a.test/x'); x.send('x');`)).rejects.toThrow('A worker can’t send data');
    expect(w.sent).toEqual([]);
  });
});

describe('what an agent’s tab never has, in any document (round 4 of #112)', () => {
  it('no shared workers, deferred sends or service workers', () => {
    class Navigator {}
    Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => ({}), configurable: true });
    const context = createContext({ Navigator, navigator: new Navigator() });
    runInContext(`self = globalThis; self.SharedWorker = class {}; self.fetchLater = () => 1;`, context);
    expect(runInContext(PAGE_LACKS, context)).toBe(true);
    expect(runInContext(`[typeof SharedWorker, typeof fetchLater, 'serviceWorker' in navigator].join('/')`, context)).toBe('undefined/undefined/false');
  });
});

const TOKEN = '0123456789abcdef0123456789abcdef';

/**
 * #338: a frame of a tab of yours, as the lease's scripts see one. Its page's world (a vm context): an EventTarget
 * window with its own print (recording `this`), and a Document whose execCommand records. Its hold's world: another vm
 * context with that same window's addEventListener, and the tab's binding (recording what it's told). `hold`: whether
 * the hold's world has its listener at all (a frame the lease never reached has none), and its deadline.
 */
function yourFrame(o: { hold?: 'on' | 'over' | 'none'; pagePrint?: boolean; frozenPrint?: boolean } = {}) {
  const calls: string[] = [];
  const page = createContext({ calls, EventTarget, Event, CustomEvent, pagePrint: Boolean(o.pagePrint), frozenPrint: Boolean(o.frozenPrint) });
  runInContext(
    String.raw`
      self = new EventTarget();
      self.addEventListener('beforeprint', () => calls.push('beforeprint'));
      self.addEventListener('afterprint', () => calls.push('afterprint'));
      if (frozenPrint) Object.defineProperty(self, 'print', { value: function print() { calls.push('frozen print'); }, writable: false, configurable: false });
      else self.print = pagePrint ? function print() { calls.push('page print ' + (this === self)); } : function print() { calls.push('native print ' + (this === self)); };
      self.Document = function Document() {};
      self.Document.prototype.execCommand = function execCommand(name) { calls.push('exec ' + name); return true; };
      // A document's window, as Document.prototype.defaultView reads it (none: a document with no window).
      Object.defineProperty(self.Document.prototype, 'defaultView', { get() { return this.view; }, configurable: true });
      self.CustomEvent = CustomEvent;
      self.Event = Event;
      doc = new self.Document();
      doc.view = self;`,
    page,
  );
  const win = runInContext('self', page) as EventTarget;
  const world = createContext({ addEventListener: (type: string, listener: (event: Event) => void, capture: boolean) => win.addEventListener(type, listener, capture), Date });
  runInContext(`self = globalThis; self['${printBinding(TOKEN)}'] = (what) => calls.push('said ' + what);`, world);
  (world as { calls?: string[] }).calls = calls;
  runInContext(`calls = globalThis.calls;`, world);
  if ((o.hold ?? 'on') !== 'none') {
    expect(runInContext(printHold(TOKEN), world)).toBe(true);
    runInContext(printUntil(o.hold === 'over' ? 0 : Date.now() + 60_000), world);
  }
  expect(runInContext(printAsks(TOKEN), page)).toBe(true);
  return { calls, run: (code: string) => runInContext(code, page) as unknown, world: (code: string) => runInContext(code, world) as unknown };
}

describe('a page’s print in a tab of yours, held in its own frame while the assistant acts (#338)', () => {
  it('held (the lease’s deadline ahead): no print; beforeprint and afterprint, as a print would; said through the tab’s binding; execCommand answers false', () => {
    const f = yourFrame();
    expect(f.run(`self.print(); doc.execCommand('PRINT')`)).toBe(false);
    expect(f.calls).toEqual(['said print', 'beforeprint', 'afterprint', 'said print', 'beforeprint', 'afterprint']);
  });

  it('the lease over (its deadline gone): the page’s print, as itself, and execCommand as ever: nothing changes (Fable’s B1)', () => {
    const f = yourFrame({ hold: 'over' });
    f.run(`self.print(); doc.execCommand('print'); doc.execCommand('copy');`);
    expect(f.calls).toEqual(['native print true', 'exec print', 'exec copy']);
  });

  it('a frame the lease never reached (no hold in its world): prints as ever', () => {
    const f = yourFrame({ hold: 'none' });
    f.run(`self.print();`);
    expect(f.calls).toEqual(['native print true']);
  });

  it('the deadline moved on and back: held, then not', () => {
    const f = yourFrame({ hold: 'over' });
    f.world(printUntil(Date.now() + 60_000));
    f.run(`self.print();`);
    f.world(printUntil(0));
    f.run(`self.print();`);
    expect(f.calls).toEqual(['said print', 'beforeprint', 'afterprint', 'native print true']);
  });

  it('a print the page set before the lease is the one called, as itself', () => {
    const f = yourFrame({ hold: 'over', pagePrint: true });
    f.run(`self.print();`);
    expect(f.calls).toEqual(['page print true']);
  });

  it('a page that froze its own print first: execCommand is still held (Neon’s SF4)', () => {
    const f = yourFrame({ frozenPrint: true });
    expect(f.run(`doc.execCommand('print')`)).toBe(false);
    expect(f.calls).toEqual(['said print', 'beforeprint', 'afterprint']);
  });

  it('installed again (another lease): print and execCommand left as they are, and one hold in the world (Argon’s B2)', () => {
    const f = yourFrame();
    const before = f.run(`[self.print, doc.execCommand]`) as unknown[];
    expect(f.run(printAsks(TOKEN))).toBe(true);
    expect(f.world(printHold(TOKEN))).toBe(true);
    expect(f.run(`[self.print, doc.execCommand]`)).toEqual(before);
    f.run(`self.print();`);
    expect(f.calls).toEqual(['said print', 'beforeprint', 'afterprint']);
  });

  it('another event than the tab’s own: nothing held, nothing said', () => {
    const f = yourFrame();
    expect(f.run(`self.dispatchEvent(new CustomEvent('chord:print-asked', { cancelable: true }))`)).toBe(true);
    expect(f.run(`self.dispatchEvent(new CustomEvent('${printEvent('fedcba9876543210fedcba9876543210')}', { cancelable: true }))`)).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('another frame’s execCommand, called on this frame’s document: asks this frame’s hold (the document’s window), held and said (Neon’s B1 on #346)', () => {
    // The other frame: one the lease never reached, or one removed (its hold's world gone): no hold of its own.
    const gone = yourFrame({ hold: 'none' });
    const top = yourFrame();
    const exec = gone.run('self.Document.prototype.execCommand') as (this: unknown, name: string) => unknown;
    expect(exec.call(top.run('doc'), 'print')).toBe(false);
    expect(top.calls).toEqual(['said print', 'beforeprint', 'afterprint']);
    expect(gone.calls).toEqual([]);
  });

  it('a document with no window: execCommand of print held (nothing to ask), never run', () => {
    const f = yourFrame();
    f.run('doc.view = null;');
    expect(f.run(`doc.execCommand('print')`)).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('only a token main made is baked in', () => {
    expect(() => printAsks('x"; alert(1); "')).toThrow();
    expect(() => printHold('NOT-HEX')).toThrow();
  });
});
