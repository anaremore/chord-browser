import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PAGE_LACKS, PAGE_PRINT_ASKS, WORKER_READS_ONLY } from '../../src/main/agents/agent-scripts';

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

/**
 * #338: a tab of yours while the assistant acts. Its frame as the print script sees one: an EventTarget window with its
 * own print (recording `this`), a Document whose execCommand records, and, for a frame, a top. `cancels`: the top's
 * preload answers *held* (the lease catching). `top`: 'self' (the top frame), 'reachable' (a frame of the same site),
 * 'unreachable' (another site's, or an opaque one: dispatching on it throws).
 */
function yourFrame(o: { cancels: boolean; top?: 'self' | 'reachable' | 'unreachable'; pagePrint?: boolean }) {
  const calls: string[] = [];
  const context = createContext({ calls, EventTarget, Event, CustomEvent, cancels: o.cancels, where: o.top ?? 'self', pagePrint: Boolean(o.pagePrint) });
  runInContext(
    String.raw`
      const topWin = new EventTarget();
      const answer = (w) => w.addEventListener('chord:print-asked', (e) => { calls.push('asked ' + e.detail); if (cancels) e.preventDefault(); }, true);
      class Frame extends EventTarget {
        get top() {
          if (where === 'self') return this;
          if (where === 'unreachable') return { dispatchEvent() { throw new Error('SecurityError'); } };
          return topWin;
        }
      }
      self = new Frame();
      if (where === 'self') answer(self); else answer(topWin);
      self.addEventListener('beforeprint', () => calls.push('beforeprint'));
      self.addEventListener('afterprint', () => calls.push('afterprint'));
      self.print = pagePrint ? function print() { calls.push('page print ' + (this === self)); } : function print() { calls.push('native print ' + (this === self)); };
      self.Document = function Document() {};
      self.Document.prototype.execCommand = function execCommand(name) { calls.push('exec ' + name); return true; };
      self.CustomEvent = CustomEvent;
      self.Event = Event;
      doc = new self.Document();`,
    context,
  );
  expect(runInContext(PAGE_PRINT_ASKS, context)).toBe(true);
  return { calls, run: (code: string) => runInContext(code, context) as unknown };
}

describe('a page’s print in a tab of yours asks the top frame first (#338)', () => {
  it('not held (the assistant isn’t acting): the page’s print, as itself; execCommand as ever', () => {
    const f = yourFrame({ cancels: false });
    f.run(`self.print(); doc.execCommand('print'); doc.execCommand('copy');`);
    expect(f.calls).toEqual(['asked print', 'native print true', 'asked execCommand', 'exec print', 'exec copy']);
  });

  it('held at the top (the lease catching): no print; beforeprint and afterprint, as a print would; execCommand answers false', () => {
    const f = yourFrame({ cancels: true });
    expect(f.run(`self.print(); doc.execCommand('PRINT')`)).toBe(false);
    expect(f.calls).toEqual(['asked print', 'beforeprint', 'afterprint', 'asked execCommand', 'beforeprint', 'afterprint']);
  });

  it.each([
    ['held at its top', 'reachable', true, false],
    ['not held at its top', 'reachable', false, true],
    ['its top out of reach (another site’s, an opaque frame): held, never printed (Argon’s B1)', 'unreachable', false, false],
  ] as const)('a frame, %s', (_, top, cancels, prints) => {
    const f = yourFrame({ cancels, top });
    f.run(`self.print();`);
    expect(f.calls.some((c) => c.startsWith('native print')), top).toBe(prints);
  });

  it('a print the page set before the lease is the one called, as itself', () => {
    const f = yourFrame({ cancels: false, pagePrint: true });
    f.run(`self.print();`);
    expect(f.calls).toEqual(['asked print', 'page print true']);
  });

  it('installed again (another lease): left as it is, never wrapped twice (Argon’s B2)', () => {
    const f = yourFrame({ cancels: false });
    const first = f.run(`self.print`);
    expect(f.run(PAGE_PRINT_ASKS)).toBe(true);
    expect(f.run(`self.print`)).toBe(first);
    f.run(`self.print();`);
    expect(f.calls).toEqual(['asked print', 'native print true']);
  });
});
