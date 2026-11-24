/**
 * Scripts the hold runs in an agent's tab (agents/pickers.ts), each before the code it guards against.
 */

/**
 * Run in a dedicated worker of an agent's tab before it starts: it can read (GET, HEAD), never send (#112 review 3:
 * a dedicated worker's requests never pass through its page's Fetch, and it has none of its own). Its `fetch` and XHR
 * are replaced where they're defined, for good (not writable, not configurable). Every built-in it calls is taken
 * when it installs, before the worker's own code runs, so nothing that code replaces later is ever called (round 4
 * of #112: `Set.prototype.has`, `String.prototype.toUpperCase`, `Function.prototype.call`, `Request`'s method getter,
 * an array's iterator). `fetch` makes its own `Request` (fixed once made) and reads its method through the getter
 * taken at install; XHR keeps the method `open` was given only once the real `open` took it (an `open` that throws
 * leaves the last one), and passes its arguments without spreading them. What it would send, it can hand its page,
 * whose sends are held and asked about. Answers `true` once it's in place.
 */
export const WORKER_READS_ONLY = String.raw`(() => {
  const apply = Reflect.apply;
  const getProto = Object.getPrototypeOf;
  const hasOwn = Object.prototype.hasOwnProperty;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const RealString = String;
  const RealTypeError = TypeError;
  const RealPromise = Promise;
  const reject = Promise.reject;
  const upper = String.prototype.toUpperCase;
  const RealWeakMap = WeakMap;
  const mapGet = WeakMap.prototype.get;
  const mapSet = WeakMap.prototype.set;
  const RealRequest = self.Request;
  const methodOf = RealRequest ? describe(RealRequest.prototype, 'method').get : null;
  const reads = (method) => method === 'GET' || method === 'HEAD';
  const no = () => new RealTypeError('A worker can’t send data from a tab an agent is using.');
  let owner = self;
  while (owner && !apply(hasOwn, owner, ['fetch'])) owner = getProto(owner);
  const realFetch = owner ? owner.fetch : null;
  if (realFetch) {
    if (!RealRequest || !methodOf) return false;
    define(owner, 'fetch', {
      value: function fetch(input, init) {
        let request;
        try {
          request = new RealRequest(input, init);
        } catch (e) {
          return apply(reject, RealPromise, [e]);
        }
        if (!reads(apply(methodOf, request, []))) return apply(reject, RealPromise, [no()]);
        return apply(realFetch, self, [request]);
      },
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
  const X = self.XMLHttpRequest;
  if (X) {
    const P = X.prototype;
    const realOpen = P.open;
    const realSend = P.send;
    const methods = new RealWeakMap();
    define(P, 'open', {
      value: function open(method, url, async, user, password) {
        const m = apply(upper, RealString(method), []);
        const n = arguments.length;
        const args = n <= 2 ? [m, url] : n === 3 ? [m, url, async] : n === 4 ? [m, url, async, user] : [m, url, async, user, password];
        const result = apply(realOpen, this, args);
        apply(mapSet, methods, [this, m]);
        return result;
      },
      writable: false,
      configurable: false,
    });
    define(P, 'send', {
      value: function send() {
        const m = apply(mapGet, methods, [this]);
        if (m !== undefined && !reads(m)) throw no();
        return apply(realSend, this, arguments);
      },
      writable: false,
      configurable: false,
    });
  }
  return true;
})()`;

/**
 * Run in every new document of an agent's tab, its frames' too (a script-made blank frame and a sandboxed one
 * included: the page preload never runs in those, round 4 of #112), before the page's own code: what could send out of
 * the hold's sight is gone. Shared workers (the site's, shared with your own tabs), deferred sends (`fetchLater`: they
 * go after the tab closes), and service workers (the site's, which could send for the page: on `postMessage`, by
 * background or periodic sync, by push). A page that looks for them finds none, as in a browser without them.
 */
export const PAGE_LACKS = String.raw`(() => {
  for (const name of ['SharedWorker', 'fetchLater']) {
    try { delete self[name]; } catch { /* not configurable: left */ }
  }
  try { delete Navigator.prototype.serviceWorker; } catch { /* left */ }
  return true;
})()`;
