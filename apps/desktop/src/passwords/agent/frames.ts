/**
 * Same-origin frames (S17 §4, phase 3C; M0 §2): the preload runs in a tab's top frame only, so the top frame's agent
 * reaches into its frames' documents from its own world and runs an agent on each (`startAgent` with a FrameContext).
 *
 * **Which frames.** `<iframe>` and `<frame>` in the document and its open roots, 3 levels deep at most, and 20 used at
 * once: a frame keeps its slot while it's used, and one found past 20 is skipped quietly (review round 1 of #67). One is
 * used only while all of these hold, checked at every use (each event, the focus box, a fill), never cached:
 * - it has no `sandbox` attribute at all, `allow-same-origin` included (S17 §5; Bitwarden refuses them too), and its
 *   document was never seen with one (the flags last until the frame's next navigation);
 * - its document is reachable (`contentDocument`, through the top realm's getter: another site's is null);
 * - that document's address is http(s): never `about:blank`, `about:srcdoc`, `data:` or `blob:`, which inherit or hide
 *   an origin; and a navigation made it (its window has a navigation timing entry of the top's origin): an
 *   `about:blank` frame written with `document.open()` takes its parent's address, and gets nothing;
 * - its origin is the top's, exactly (`location.origin` as the address gives it), and not opaque;
 * - every frame above it holds the same.
 *
 * A frame's agent is released when its frame goes (removed, navigated, sandboxed, another origin): its listeners, its
 * forms, its fill and its slot. Its window's `pagehide` starts a look at the frames, as a frame's `load` does.
 *
 * Main is unchanged: every message comes from the top frame, whose origin main checks, and a frame's agent only ever
 * touches a document of that same origin. So a password for an origin only reaches a document of that origin.
 *
 * **One bridge.** The agents share the top's bridge through a hub: form ids from one counter, the `forms` of all of them
 * as one report (main's reappeared-form check reads the page's whole set), a fill routed to the agent whose form it
 * names, and a `blur` dropped when another agent has sent `focus` since (focus moved into another frame).
 */
import type { PasswordsAgentChannel, PasswordsAgentMessage } from '@chord/ipc';
import { FORMS_JSON_MAX, startAgent, type AgentOptions, type AgentStop, type FrameContext, type PasswordsBridge } from './agent';
import { framesIn, MAX_REPORTED_FORMS } from './scan';

/** How deep frames go, and how many are used at once. */
export const MAX_FRAME_DEPTH = 3;
export const MAX_FRAMES = 20;
/** How many frame elements one look goes through: a page of hundreds of ads costs a bounded pass. */
const MAX_FRAMES_SEEN = 100;

const getter = (proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get!;
const iframeDocument = getter(HTMLIFrameElement.prototype, 'contentDocument');
const frameDocument = getter(HTMLFrameElement.prototype, 'contentDocument');
const iframeWindow = getter(HTMLIFrameElement.prototype, 'contentWindow');
const frameWindow = getter(HTMLFrameElement.prototype, 'contentWindow');
const urlOf = getter(Document.prototype, 'URL');
const viewOf = getter(Document.prototype, 'defaultView');
const tagOf = getter(Element.prototype, 'tagName');
const connected = getter(Node.prototype, 'isConnected');
const clientLeft = getter(Element.prototype, 'clientLeft');
const clientTop = getter(Element.prototype, 'clientTop');
const offsetWidth = getter(HTMLElement.prototype, 'offsetWidth');
const entriesByType = Performance.prototype.getEntriesByType;

/** Documents seen in a frame with a `sandbox` attribute: refused for good, the attribute removed or not (round 1 of #67). */
const sandboxed = new WeakSet<Document>();

/** Whether a navigation of the top's origin made `doc`: its window's navigation timing entry (none for a written about:blank). */
function navigated(doc: Document, origin: string): boolean {
  const view = viewOf.call(doc) as (Window & { performance: Performance }) | null;
  if (!view) return false;
  const entries = entriesByType.call(view.performance, 'navigation') as PerformanceEntry[];
  return entries.some((e) => {
    try {
      const u = new URL(e.name);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin;
    } catch {
      return false;
    }
  });
}

/** The document of `el` (an iframe or frame) when it may be used, else null: see the rules above. */
export function frameDocumentOf(el: Element, origin: string): Document | null {
  const r = frameCheck(el, origin);
  return typeof r === 'object' ? r : null;
}
/**
 * `frameDocumentOf`, saying why not: `unnavigated` is a document of the top's origin with no navigation timing entry
 * yet (just loaded: the entry can come after its `load`), which a later look may find; `null` is a no for good.
 */
function frameCheck(el: Element, origin: string): Document | 'unnavigated' | null {
  try {
    const tag = String(tagOf.call(el));
    const doc = (tag === 'IFRAME' ? iframeDocument : tag === 'FRAME' ? frameDocument : null)?.call(el) as Document | null;
    if (Element.prototype.getAttribute.call(el, 'sandbox') !== null) {
      if (doc) sandboxed.add(doc);
      return null;
    }
    if (!doc || sandboxed.has(doc)) return null;
    const url = String(urlOf.call(doc));
    if (!/^https?:/i.test(url)) return null;
    const own = new URL(url).origin;
    if (own === 'null' || own !== origin) return null;
    return navigated(doc, origin) ? doc : 'unnavigated';
  } catch {
    return null;
  }
}
const windowOf = (el: Element): Window | null => {
  const tag = String(tagOf.call(el));
  return ((tag === 'IFRAME' ? iframeWindow : frameWindow).call(el) as Window | null) ?? null;
};

/** A frame the agents run in: its element, its document as it was taken, and the frame above it. */
interface FrameNode {
  readonly el: WeakRef<Element>;
  readonly doc: WeakRef<Document>;
  readonly parent: FrameNode | null;
}
/** Whether `node` and every frame above it is still the same document of the top's origin. */
const stillAllowed = (node: FrameNode | null, origin: string): boolean => {
  for (let n = node; n; n = n.parent) {
    const el = n.el.deref();
    const doc = n.doc.deref();
    if (!el || !doc || !connected.call(el) || frameDocumentOf(el, origin) !== doc) return false;
  }
  return true;
};
/**
 * Where the frame's content is in the tab's CSS pixels, and its scale: each frame's box, border and padding, from the
 * top down, with the scale a CSS transform or zoom gives it (its drawn width over its layout width; round 1 of #67).
 */
const offsetOf = (node: FrameNode, top: Window): { x: number; y: number; scale: number } | null => {
  const chain: Element[] = [];
  for (let n: FrameNode | null = node; n; n = n.parent) {
    const el = n.el.deref();
    if (!el) return null;
    chain.unshift(el);
  }
  let x = 0;
  let y = 0;
  let scale = 1;
  for (const el of chain) {
    const r = Element.prototype.getBoundingClientRect.call(el);
    const style = top.getComputedStyle(el);
    const width = Number(offsetWidth.call(el));
    const own = width > 0 && r.width > 0 ? r.width / width : 1;
    x += scale * (r.left + (Number(clientLeft.call(el)) + (parseFloat(style.paddingLeft) || 0)) * own);
    y += scale * (r.top + (Number(clientTop.call(el)) + (parseFloat(style.paddingTop) || 0)) * own);
    scale *= own;
  }
  return { x, y, scale };
};

type Forms = PasswordsAgentMessage<'forms'>['forms'];
/** A frame's agent, as the hub keeps it. */
interface Running {
  readonly node: FrameNode;
  readonly stop: AgentStop;
  /** Its window's `pagehide` and its document's frame `load` listeners, taken off. */
  readonly unlisten: () => void;
}
/** What `startAgents` returns: its stop, and (tests) what the hub holds. */
export type AgentsStop = (() => void) & { stats(): { agents: number; forms: number; fills: number; owners: number } };

/** Starts the top document's agent and one for each allowed same-origin frame. */
export function startAgents(bridge: PasswordsBridge, options: Pick<AgentOptions, 'document' | 'window'> = {}): AgentsStop {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const origin = new URL(String(urlOf.call(doc))).origin;
  const ids = { value: 1 };
  /** Each agent's last forms, in the order they started (the top's first). */
  const formsOf = new Map<object, Forms>();
  const owners = new Map<string, object>();
  const fills = new Map<object, (payload: unknown) => void>();
  /** The frames' agents, by token, and by the document each runs on (a navigated frame's new document gets its own). */
  const agents = new Map<object, Running>();
  const running = new WeakMap<Document, object>();
  const listened = new WeakSet<Document>();
  let sentForms = '';
  let focusedBy: { token: object; formId: string } | null = null;
  const sendForms = () => {
    const forms: Forms = [];
    let size = 2;
    outer: for (const list of formsOf.values()) {
      for (const f of list) {
        if (forms.length >= MAX_REPORTED_FORMS) break outer;
        size += JSON.stringify(f).length + 1;
        if (size > FORMS_JSON_MAX) break outer;
        forms.push(f);
      }
    }
    const json = JSON.stringify(forms);
    if (json === sentForms) return;
    sentForms = json;
    bridge.send('forms', { forms });
  };
  const topToken = {};
  bridge.onFill?.((payload) => {
    const formId = (payload as { formId?: unknown } | null)?.formId;
    const to = (typeof formId === 'string' && owners.get(formId)) || topToken;
    fills.get(to)?.(payload);
  });
  /** One agent's view of the bridge. */
  const hub = (token: object): PasswordsBridge => ({
    send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>) {
      if (channel === 'forms') {
        // A released agent's last report isn't the page's.
        if (token !== topToken && !agents.has(token)) return;
        const forms = (payload as PasswordsAgentMessage<'forms'>).forms;
        formsOf.set(token, forms);
        for (const f of forms) owners.set(f.formId, token);
        return sendForms();
      }
      if (channel === 'focus') focusedBy = { token, formId: (payload as PasswordsAgentMessage<'focus'>).formId };
      else if (channel === 'blur') {
        // Focus went into another frame's field, whose `focus` came first: this blur is the old one's.
        if (focusedBy?.token !== token) return;
        focusedBy = null;
      }
      bridge.send(channel, payload);
    },
    onFill: (listener) => void fills.set(token, listener),
  });

  const stopTop = startAgent(hub(topToken), { document: doc, window: win, ids });

  /** A frame's agent, released: its listeners, forms, fill and slot go; a watch it was running ends on its own. */
  const release = (token: object, a: Running) => {
    a.stop.release();
    a.unlisten();
    agents.delete(token);
    formsOf.delete(token);
    fills.delete(token);
    for (const [formId, t] of owners) if (t === token) owners.delete(formId);
    // Its field had focus: main hears it went, as the agent itself can't say so now.
    if (focusedBy?.token === token) {
      bridge.send('blur', { formId: focusedBy.formId });
      focusedBy = null;
    }
  };

  /** The frames as they are now: new allowed documents get an agent while a slot's free; one that went is released. */
  const discover = () => {
    for (const [token, a] of agents) if (!stillAllowed(a.node, origin)) release(token, a);
    let seen = 0;
    let later = false;
    const walk = (within: Document, parent: FrameNode | null, depth: number, ancestors: FrameContext['ancestors']) => {
      if (depth >= MAX_FRAME_DEPTH) return;
      for (const el of framesIn(within, MAX_FRAMES_SEEN)) {
        if (++seen > MAX_FRAMES_SEEN) return;
        const checked = frameCheck(el, origin);
        // Just loaded, its navigation entry not there yet: looked at again shortly, a few times at most. A document
        // written into about:blank never gets one, and never gets used.
        if (checked === 'unnavigated') {
          const doc = (String(tagOf.call(el)) === 'FRAME' ? frameDocument : iframeDocument).call(el) as Document | null;
          const tries = doc ? (retries.get(doc) ?? 0) : 10;
          if (doc && tries < 10) {
            retries.set(doc, tries + 1);
            later = true;
          }
        }
        const frameDoc = typeof checked === 'object' ? checked : null;
        const frameWin = frameDoc ? windowOf(el) : null;
        if (!frameDoc || !frameWin) continue;
        const up = [{ document: within, window: (viewOf.call(within) as Window | null) ?? win }, ...ancestors];
        const token = running.get(frameDoc);
        let node = token ? agents.get(token)?.node : undefined;
        if (!node) {
          // A frame keeps its slot while it's used; one found past 20 is skipped (round 1 of #67).
          if (agents.size >= MAX_FRAMES) continue;
          const made: FrameNode = { el: new WeakRef(el), doc: new WeakRef(frameDoc), parent };
          node = made;
          const fresh = {};
          running.set(frameDoc, fresh);
          const frame: FrameContext = { allowed: () => stillAllowed(made, origin), offset: () => (stillAllowed(made, origin) ? offsetOf(made, win) : null), ancestors: up };
          const stop = startAgent(hub(fresh), { document: frameDoc, window: frameWin, frame, ids, timers: win });
          agents.set(fresh, { node: made, stop, unlisten: listen(frameDoc, frameWin) });
        }
        walk(frameDoc, node, depth + 1, up);
      }
    };
    walk(doc, null, 0, []);
    sendForms();
    if (later) soon(100);
  };
  /** Looks again at documents that weren't navigated yet, by document: 10 times at most each. */
  const retries = new WeakMap<Document, number>();
  /**
   * Frames that load or go together (a page's 30 ads) are looked at once, 50 ms after the last: a frame's `pagehide`
   * and its next document's `load` are one look, made once that document is there.
   */
  let pending = 0;
  function soon(ms = 50): void {
    if (pending) win.clearTimeout(pending);
    pending = win.setTimeout(() => {
      pending = 0;
      discover();
    }, ms);
  }
  /**
   * A frame's load in `d` (a new frame, or one that navigated), and, for a frame's own window, its `pagehide` (the frame
   * removed or navigated away): both start a look. Returns what takes them off.
   */
  function listen(d: Document, view: Window | null): () => void {
    if (listened.has(d)) return () => {};
    listened.add(d);
    const onLoad = (event: Event) => {
      const t = Event.prototype.composedPath.call(event)[0];
      const tag = t && typeof t === 'object' && 'tagName' in t ? String(tagOf.call(t as Element)) : '';
      if (tag === 'IFRAME' || tag === 'FRAME') soon();
    };
    const onHide = () => soon();
    EventTarget.prototype.addEventListener.call(d, 'load', onLoad, { capture: true, passive: true });
    if (view) EventTarget.prototype.addEventListener.call(view, 'pagehide', onHide, { passive: true });
    return () => {
      EventTarget.prototype.removeEventListener.call(d, 'load', onLoad, { capture: true });
      if (view) EventTarget.prototype.removeEventListener.call(view, 'pagehide', onHide);
      listened.delete(d);
    };
  }
  const unlistenTop = listen(doc, null);
  discover();
  return Object.assign(
    () => {
      if (pending) win.clearTimeout(pending);
      for (const [token, a] of agents) {
        release(token, a);
        a.stop();
      }
      unlistenTop();
      stopTop();
    },
    { stats: () => ({ agents: agents.size, forms: formsOf.size, fills: fills.size, owners: owners.size }) },
  );
}
