import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PAGE_LACKS, WORKER_READS_ONLY } from '../../src/main/agents/agent-scripts';

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
