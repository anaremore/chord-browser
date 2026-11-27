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
 * What a print stub captures as it installs, before the page's code can swap any of it (#336): the agent's tab's
 * (PAGE_LACKS) and a tab of yours' (PAGE_PRINT_ASKS, #338). In scope: `Doc`, the page's Document.
 */
const PRINT_INTRINSICS = String.raw`const apply = Reflect.apply;
    const define = Object.defineProperty;
    const toText = String;
    const lower = String.prototype.toLowerCase;
    const exec = Doc.prototype.execCommand;
    const Told = self.CustomEvent;
    const Plain = self.Event;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const here = self;
    const ownGet = Object.getOwnPropertyDescriptor;
    const protoOf = Object.getPrototypeOf;
    const ignore = function () {};`;

/**
 * Document.prototype.execCommand, wrapped (#336): never configurable, an accessor whose setter ignores what it's given
 * (Opus's S2), native's shape (one declared argument; a Symbol, or no command, throws native's TypeError: Neon's N1,
 * Opus's N5). Its command is made a string once and given on as that string, never the raw argument (a toString that
 * answers "copy", then "print", can't slip by). `onPrint` runs for "print" in any case; it may return, or fall through
 * to the original with "print".
 */
const execCommandAsks = (onPrint: string) => String.raw`if (typeof exec === 'function') {
      const Mistype = TypeError;
      const execNot = function execCommand(command) {
        if (arguments.length < 1) throw new Mistype("Failed to execute 'execCommand' on 'Document': 1 argument required, but only 0 present.");
        if (typeof command === 'symbol') throw new Mistype('Cannot convert a Symbol value to a string');
        const name = toText(command);
        if (apply(lower, name, []) === 'print') { ${onPrint} }
        return apply(exec, this, [name, arguments[1], arguments[2]]);
      };
      try { define(Doc.prototype, 'execCommand', { get: () => execNot, set: ignore, enumerable: true, configurable: false }); } catch { /* left */ }
    }`;

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
  // Print (#115 PR 2, Argon's B3): never in an agent's tab. The native dialog would open for a tab no one sees, and hold
  // its renderer. What it uses is captured now, before the page runs, so a page can't swap it: print is a constant
  // that only reports; execCommand turns its command into a string once, refuses "print" in any case, and gives the
  // original that same string, never the raw argument (a toString that answers "copy", then "print", can't slip by).
  // Workers have no print and no document: nothing to do there.
  const Doc = self.Document;
  if (Doc) {
    ${PRINT_INTRINSICS}
    // The parent's getter, captured (#336, Fable's N3): a page that replaces a frame's parent can't silence its note.
    let parentGet = null;
    for (let o = here; o && !parentGet; o = protoOf(o)) parentGet = (ownGet(o, 'parent') || {}).get || null;
    // Said through the outermost frame of this page's origin above this one (up to 8: #336, Fable's N1), whose preload
    // takes it and tells main. Never this frame first (Neon's NSF1): a blank frame has no preload of its own, so a page
    // listener there could cancel it as if one had; the outermost such frame is the top, or another site's frame, each
    // with its preload's listener first. Another site's parent can't be reached: the climb stops below it. The event's
    // init has no prototype (Fable's N3): a page's getters on Object.prototype never run.
    const tell = (how) => {
      let at = here;
      for (let up = 0; up < 8; up++) {
        let next = null;
        try {
          next = parentGet ? apply(parentGet, at, []) : null;
          // Of this origin: its document can be reached (another site's throws).
          if (next && next !== at) void next.document;
          else next = null;
        } catch {
          next = null;
        }
        if (!next) break;
        at = next;
      }
      try { apply(dispatch, at, [new Told('chord:print-held', { __proto__: null, cancelable: true, detail: how })]); } catch { /* not told */ }
    };
    // As a real print does (#336, Fable's N4): beforeprint, then afterprint, so a page waiting on afterprint goes on.
    // Told first (Neon's NSF1): a frame that removes itself as print begins can't lose its note.
    const printed = (how) => {
      tell(how);
      try { apply(dispatch, here, [new Plain('beforeprint')]); } catch { /* left */ }
      try { apply(dispatch, here, [new Plain('afterprint')]); } catch { /* left */ }
    };
    // Never configurable, so delete and defineProperty fail, and the native print and execCommand stay out of reach.
    // print is a writable value (#336, Opus's NS1): a page may declare its own (function print, var print) or wrap it,
    // and its scripts run, with its own print from then on. execCommand is an accessor whose setter ignores what it's
    // given (Opus's S2): a page that wraps it, in strict code, never throws, and it's still the wrapper.
    const printNot = function print() { printed('print'); };
    try { define(here, 'print', { value: printNot, writable: true, enumerable: true, configurable: false }); } catch { /* left */ }
    ${execCommandAsks("printed('execCommand'); return false;")}
  }
  return true;
})()`;

/** #338: a tab's print token: what names its event and its binding. Main makes it (hex), one a tab, for its life. */
const isToken = (token: string): boolean => /^[0-9a-f]{16,64}$/.test(token);
/** The isolated world each frame of a tab of yours holds its prints in (the lease adds it by CDP, never the page). */
export const PRINT_HOLD_WORLD = 'chord-print-hold';
export const printEvent = (token: string): string => `chord-print-${token}`;
export const printBinding = (token: string): string => `chordPrintHeld_${token}`;

/**
 * #338: a page's print in a tab of yours, in the page's world (the lease adds it to the documents of the page and of
 * each frame, in their own sessions, while it catches). Electron has no event before the print dialog and CDP no print
 * intercept, so the page's own call is where it's caught: print and execCommand('print') dispatch the tab's own event
 * (its name random, the tab's: a page can't know it) on this frame, and the frame's PRINT_HOLD_WORLD listener cancels
 * it while the lease holds prints there (printHold). Held: beforeprint and afterprint, as a print would, and nothing
 * printed. Not held (no lease, or it's over): the page's own print (the one there as this installed, read once: Neon's
 * N1), as itself; and execCommand as ever. Each frame asks itself, never its top: a detached frame (Neon's B1), a page
 * gone to a blob: (Neon's B2) or another site's frame (Fable's B1) holds as the top does, and prints again once the
 * lease is over. print and execCommand are each wrapped once (never configurable after), and each only if the page left
 * it configurable (Neon's SF4): a second lease finds them and leaves them (Argon's B2); a dispatch that throws holds it.
 */
export const printAsks = (token: string): string => {
  if (!isToken(token)) throw new Error('not a print token');
  return String.raw`(() => {
  const Doc = self.Document;
  if (!Doc) return true;
  ${PRINT_INTRINSICS}
  const EVENT = '${printEvent(token)}';
  // The window a document is printed in: the frame's own for print(); for execCommand, the document's (a frame's
  // execCommand called on another document, its frame then removed, prints that document: Neon's B1 on #346).
  const viewGet = (ownGet(Doc.prototype, 'defaultView') || {}).get || null;
  const windowOf = (doc) => {
    try { return viewGet ? apply(viewGet, doc, []) : here; } catch { return null; }
  };
  // Asked in that window; held if its hold cancels, or if it can't be asked (no window, a dispatch that throws).
  const asked = (how, at = here) => {
    if (!at) return true;
    try { return apply(dispatch, at, [new Told(EVENT, { __proto__: null, cancelable: true, detail: how })]) === false; } catch { return true; }
  };
  const quietly = (at = here) => {
    if (!at) return;
    try { apply(dispatch, at, [new Plain('beforeprint')]); } catch { /* left */ }
    try { apply(dispatch, at, [new Plain('afterprint')]); } catch { /* left */ }
  };
  // print's half on its own: a page's print getter that throws leaves print as it is, never execCommand unwrapped (Neon's
  // N1, round 2 of #346).
  try {
    const hadPrint = ownGet(here, 'print');
    if (!hadPrint || hadPrint.configurable !== false) {
      const current = hadPrint && 'value' in hadPrint ? hadPrint.value : here.print;
      const realPrint = typeof current === 'function' ? current : null;
      const printAsks = function print() {
        if (asked('print')) return void quietly();
        if (realPrint) return apply(realPrint, here, []);
      };
      define(here, 'print', { value: printAsks, writable: true, enumerable: true, configurable: false });
    }
  } catch { /* left */ }
  const hadExec = ownGet(Doc.prototype, 'execCommand');
  if (!hadExec || hadExec.configurable !== false) {
    ${execCommandAsks("const at = windowOf(this); if (asked('execCommand', at)) { quietly(at); return false; }")}
  }
  return true;
})()`;
};

/**
 * #338: where the hold's world keeps its state: symbol-keyed, never a name, since the page's named elements (an id, an
 * iframe's name) show on the window in every world, this one too, and would read as installed or as a deadline (Neon's
 * B1, round 2 of #346). The installed flag and the deadline, by the tab's token.
 */
const holdKeys = (token: string): string => `const HELD = Symbol.for('chord.printHold.${token}'); const UNTIL = Symbol.for('chord.printUntil.${token}');`;

/**
 * #338: each frame's hold, in PRINT_HOLD_WORLD (an isolated world: the page sees none of it). While the deadline in
 * that world (printUntil) is ahead, it cancels the tab's print event, before any other listener, and says so through
 * the tab's binding (main says it in the chat, once an action). Once a world: a second lease leaves it, and only moves
 * the deadline. Its listener added through EventTarget's own (the window's addEventListener can be a named element);
 * marked installed only once it is.
 */
export const printHold = (token: string): string => {
  if (!isToken(token)) throw new Error('not a print token');
  return String.raw`(() => {
  ${holdKeys(token)}
  if (self[HELD] === true) return true;
  if (typeof self[UNTIL] !== 'number') self[UNTIL] = 0;
  EventTarget.prototype.addEventListener.call(self, '${printEvent(token)}', (event) => {
    if (!(Date.now() < self[UNTIL])) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { self['${printBinding(token)}']('print'); } catch { /* not said */ }
  }, true);
  self[HELD] = true;
  return true;
})()`;
};

/** #338: the hold's deadline in each frame's PRINT_HOLD_WORLD (a time in ms; 0: over). */
export const printUntil = (token: string, until: number): string => {
  if (!isToken(token)) throw new Error('not a print token');
  return `(() => { ${holdKeys(token)} self[UNTIL] = ${Math.max(0, Math.floor(until))}; return true; })()`;
};
