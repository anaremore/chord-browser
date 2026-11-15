/* global chordPasswords, chordScan, document, window, HTMLInputElement */
// Spike S17 M0: the agent, run in world 4440 (or, as the fallback, in the preload's world).
// main serves it wrapped with scan.js: (function (chordPasswords) { scan; agent })(bridge).
// It answers main's probes; it reads the page and, in the fill test only, writes two
// fields the way §11.6 does. It adds nothing to the page and sends no value to main.
const bridge = chordPasswords;
globalThis.__chordAgent = { version: 'spike' };
const now = () => Date.now();

// ----- Question 7: the page's requests, seen from this world -----
const resources = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
      const u = new URL(e.name);
      resources.push({ at: u.host.split(':')[0] + u.pathname + u.search, initiatorType: e.initiatorType, responseStatus: e.responseStatus, duration: Math.round(e.duration), t: now() });
    }
  }).observe({ type: 'resource', buffered: false });
} catch (error) {
  resources.push({ error: String(error) });
}

// ----- Question 3: where the focused field is, in the tab's own CSS pixels -----
let focused = null;
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  // A same-origin frame's field: add each frame's place in its parent.
  for (let win = el.ownerDocument.defaultView; win && win !== window; win = win.parent) {
    const fe = win.frameElement;
    if (!fe) break;
    const fr = fe.getBoundingClientRect();
    x += fr.left + fe.clientLeft;
    y += fr.top + fe.clientTop;
  }
  return { x, y, w: r.width, h: r.height };
};
const report = (why) => {
  const el = focused && focused.deref();
  if (!el || !el.isConnected) return;
  bridge.send('rect', { why, t: now(), rect: rectOf(el), id: el.id, password: el.type === 'password', viewport: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio });
};
const onFocusIn = (event) => {
  const el = event.composedPath()[0];
  if (!el || el.tagName !== 'INPUT') return;
  focused = new WeakRef(el);
  report('focus');
};
const onFocusOut = (event) => {
  const el = event.composedPath()[0];
  if (el && el.tagName === 'INPUT') bridge.send('blur', { t: now(), id: el.id });
};
const listen = (doc) => {
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('scroll', () => report('scroll'), { capture: true, passive: true });
};
listen(document);
window.addEventListener('resize', () => report('resize'), { passive: true });

// ----- Question 2: frames -----
const reach = (frame) => {
  try {
    return { doc: frame.contentDocument, error: null };
  } catch (error) {
    return { doc: null, error: String(error && error.name) };
  }
};
const frames = () =>
  [...document.querySelectorAll('iframe')].map((f) => {
    const { doc, error } = reach(f);
    const out = { id: f.id, reachable: !!doc, error };
    if (doc) {
      out.readyState = doc.readyState;
      out.fields = chordScan({ document: doc }).flatMap((g) => g.fields.map((x) => `${x.id}:${x.type}:${x.autocomplete}`));
      out.sameRealm = doc.defaultView.HTMLInputElement === HTMLInputElement;
    }
    return out;
  });
// §11.6's fill: the native setter, then input (composed, as typing is) and change.
// realm 'mine' takes the setter and Event from this frame's world; 'own' from the field's frame.
const fill = (doc, values, realm) => {
  const done = [];
  for (const [id, value] of Object.entries(values)) {
    const el = doc.getElementById(id);
    if (!el) {
      done.push(`${id}:missing`);
      continue;
    }
    const view = el.ownerDocument.defaultView;
    const Input = realm === 'own' ? view.HTMLInputElement : HTMLInputElement;
    const Ev = realm === 'own' ? view.Event : Event;
    if (id === 'pass' && el.type !== 'password') {
      done.push(`${id}:not-password`);
      continue;
    }
    Object.getOwnPropertyDescriptor(Input.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Ev('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Ev('change', { bubbles: true }));
    done.push(`${id}:ok`);
  }
  return done;
};

bridge.onMessage((message) => {
  const reply = (result) => bridge.send('reply', { id: message.id, result });
  try {
    switch (message.op) {
      case 'whoami':
        return reply({ world: bridge.world(), agent: typeof globalThis.__chordAgent, bridge: typeof chordPasswords, pageGlobal: typeof window.reactState, pageReact: typeof window.React });
      case 'frames':
        return reply(frames());
      case 'listen-frames':
        for (const f of document.querySelectorAll('iframe')) {
          const { doc } = reach(f);
          if (doc) listen(doc);
        }
        return reply('ok');
      case 'fill': {
        const target = message.frame ? reach(document.getElementById(message.frame)).doc : document;
        return reply(target ? fill(target, message.values, message.realm) : 'unreachable');
      }
      case 'focus': {
        const target = message.frame ? reach(document.getElementById(message.frame)).doc : document;
        target.getElementById(message.field).focus();
        return reply('ok');
      }
      case 'report':
        report('asked');
        return reply('ok');
      case 'resources':
        return reply(resources.slice());
      case 'resources-clear':
        resources.length = 0;
        return reply('ok');
      case 'timeline':
        return reply(performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/')).map((e) => `${new URL(e.name).pathname} ${e.initiatorType} ${e.responseStatus}`));
      case 'scan': {
        const t0 = performance.now();
        const forms = chordScan({});
        return reply({ ms: performance.now() - t0, fields: forms.reduce((a, g) => a + g.fields.length, 0) });
      }
      default:
        return reply({ error: `unknown op ${message.op}` });
    }
  } catch (error) {
    return reply({ error: String(error) });
  }
});
bridge.send('hello', { world: bridge.world(), sinceStart: bridge.since(), pageGlobal: typeof window.reactState });
