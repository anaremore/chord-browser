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
import { composedParentOf, framesIn, MAX_REPORTED_FORMS, rootOf } from './scan';

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
const ownerOf = getter(Node.prototype, 'ownerDocument');
const rootElementOf = getter(Document.prototype, 'documentElement');
/** A window's own `origin`, through the top realm's getter: opaque ("null") for a sandbox without allow-same-origin. */
const windowOrigin = Object.getOwnPropertyDescriptor(window, 'origin')?.get ?? null;
/** The effective CSS zoom on an element (Chromium's `currentCSSZoom`), where there's a getter for it. */
const zoomOf = Object.getOwnPropertyDescriptor(Element.prototype, 'currentCSSZoom')?.get ?? null;

/**
 * Documents refused for good: one seen in a frame with a `sandbox` attribute (the flags last until its next navigation),
 * and one an agent was released from (its frame navigated, or it was rewritten with `document.open()`; round 2 of #67).
 */
const refused = new WeakSet<Document>();

/**
 * Whether a frame element has had a `sandbox` attribute at any time its document's history could have seen: true when
 * that history wasn't watched (round 2 of #67). It fails closed.
 */
export type SandboxRecord = (el: Element) => boolean;

/**
 * Whether a real HTTP navigation of the top's origin made `doc`, as it is now (round 2 of #67):
 * - its window's own origin is the top's (opaque, "null", for a sandbox without allow-same-origin, a CSP header's too);
 * - a navigation timing entry of its window names its address (the hash aside: `document.open()` from another
 *   document changes the address and keeps the entry; a frame's own `history.pushState` does too, and is refused), and
 *   came with a response's content type (a `javascript:` URL's document has an entry under the old address, with none).
 * `unknown`: no entry yet (just loaded: it can come after the `load`), for a later look.
 */
function navigated(doc: Document, origin: string): boolean | 'unknown' {
  const view = viewOf.call(doc) as (Window & { performance: Performance }) | null;
  if (!view || !windowOrigin || String(windowOrigin.call(view)) !== origin) return false;
  // `contentType` is newer than the DOM typings.
  const entries = entriesByType.call(view.performance, 'navigation') as (PerformanceEntry & { contentType?: unknown })[];
  if (!entries.length) return 'unknown';
  const url = String(urlOf.call(doc)).split('#')[0];
  return entries.some((e) => String(e.name).split('#')[0] === url && typeof e.contentType === 'string' && e.contentType !== '');
}

const contentDocumentOf = (el: Element): Document | null => {
  const tag = String(tagOf.call(el));
  return ((tag === 'IFRAME' ? iframeDocument : tag === 'FRAME' ? frameDocument : null)?.call(el) as Document | null) ?? null;
};

/** The document of `el` (an iframe or frame) when it may be used, else null: see the rules above. */
export function frameDocumentOf(el: Element, origin: string, record: SandboxRecord): Document | null {
  const r = frameCheck(el, origin, record);
  return typeof r === 'object' ? r : null;
}
/**
 * `frameDocumentOf`, saying why not: `unnavigated` is a document of the top's origin with no navigation timing entry
 * yet (just loaded: the entry can come after its `load`), which a later look may find; `null` is a no for good.
 */
function frameCheck(el: Element, origin: string, record: SandboxRecord): Document | 'unnavigated' | null {
  try {
    const doc = contentDocumentOf(el);
    if (Element.prototype.getAttribute.call(el, 'sandbox') !== null || record(el)) {
      if (doc) refused.add(doc);
      return null;
    }
    if (!doc || refused.has(doc)) return null;
    const url = String(urlOf.call(doc));
    if (!/^https?:/i.test(url)) return null;
    const own = new URL(url).origin;
    if (own === 'null' || own !== origin) return null;
    const made = navigated(doc, origin);
    return made === true ? doc : made === 'unknown' ? 'unnavigated' : null;
  } catch {
    return null;
  }
}
const windowOf = (el: Element): Window | null => {
  const tag = String(tagOf.call(el));
  return ((tag === 'IFRAME' ? iframeWindow : frameWindow).call(el) as Window | null) ?? null;
};

/** A frame the agents run in: its element, its document as it was taken and that document's root, and the frame above it. */
interface FrameNode {
  readonly el: WeakRef<Element>;
  readonly doc: WeakRef<Document>;
  /** Its `documentElement` when first used: another one means `document.open()` rewrote it (round 2 of #67). */
  readonly root: WeakRef<Element> | null;
  readonly parent: FrameNode | null;
}
/** Whether `node` and every frame above it is still the same document, as it was, of the top's origin. */
const stillAllowed = (node: FrameNode | null, origin: string, record: SandboxRecord): boolean => {
  for (let n = node; n; n = n.parent) {
    const el = n.el.deref();
    const doc = n.doc.deref();
    if (!el || !doc || !connected.call(el) || frameDocumentOf(el, origin, record) !== doc) return false;
    if (n.root && rootElementOf.call(doc) !== n.root.deref()) return false;
  }
  return true;
};
/** A computed transform that's a translation and one scale for both axes (or none): anything else turns the box. */
const plainTransform = (style: CSSStyleDeclaration): boolean => {
  if (style.rotate && style.rotate !== 'none') return false;
  if (style.scale && style.scale !== 'none' && new Set(style.scale.trim().split(/\s+/)).size > 1) return false;
  const t = style.transform;
  if (!t || t === 'none') return true;
  const m = /^matrix\(([^)]*)\)$/.exec(t);
  if (!m) return false;
  const [a, b, c, d] = m[1]!.split(',').map(Number);
  return b === 0 && c === 0 && a === d && a! > 0;
};
/**
 * Where the frame's content is in the tab's CSS pixels, and its scale: each frame's box, border and padding, from the
 * top down, with the scale a CSS transform gives it (its drawn width over its layout width; round 1 of #67). Null under
 * a CSS zoom, a rotation or a skew, on the frame or anything above it: no menu, rather than one in the wrong place
 * (round 2 of #67).
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
    if (zoomOf && Number(zoomOf.call(el)) !== 1) return null;
    for (let a: Element | null = el, depth = 0; a && depth < 64; a = composedParentOf(a), depth++) if (!plainTransform(top.getComputedStyle(a))) return null;
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
/** What `startAgents` returns: its stop, and (tests) what the hub holds and the documents its agents run on. */
export type AgentsStop = (() => void) & { stats(): { agents: number; forms: number; fills: number; owners: number }; documents(): Document[] };

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
  /**
   * What each frame document's agent has seen of its own frames since it started: those with a `sandbox` attribute
   * change, and each frame's document as of its last `load` heard in that document's own tree. A frame's `load` isn't
   * composed, so a frame that loaded inside a shadow root (and moved out, `moveBefore`) was never heard (round 3 of #67).
   */
  const histories = new WeakMap<Document, { seen: WeakSet<Element>; loads: WeakMap<Element, Document | null>; observer: MutationObserver; children: MutationObserver }>();
  /**
   * Whether a frame element may not be used, as far as anyone watched (true: refused). The top document's frames: the
   * sentinel's word (`vouched`), watching from the document's start. A frame document's own: its agent's history since it
   * started, which must hold the frame's current document's `load` and no `sandbox` change. With no cap: a document its
   * watcher didn't see from its start gets nothing, wherever it sits (round 3 of #67). A frame in an open shadow root, or
   * one nobody watched, is refused.
   */
  const record: SandboxRecord = (el) => {
    const owner = ownerOf.call(el) as Document | null;
    if (!owner || rootOf(el) !== owner) return true;
    if (owner === doc) {
      try {
        return !bridge.vouched || bridge.vouched(el) !== true;
      } catch {
        return true;
      }
    }
    const history = histories.get(owner);
    if (!history || history.seen.has(el)) return true;
    const current = contentDocumentOf(el);
    return !current || history.loads.get(el) !== current;
  };
  /**
   * A frame document's own frames, watched from now: their `sandbox` attributes, and (through `listen`'s `load`) their
   * documents. And its own children: `document.open()` replaces its root, and its agent is released at once.
   */
  const watchHistory = (d: Document) => {
    const seen = new WeakSet<Element>();
    const observer = new MutationObserver((records) => {
      for (const r of records) seen.add(r.target as Element);
    });
    observer.observe(d, { attributes: true, attributeFilter: ['sandbox'], subtree: true });
    const children = new MutationObserver(() => prune());
    children.observe(d, { childList: true });
    histories.set(d, { seen, loads: new WeakMap(), observer, children });
  };
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
        // A released agent's last report isn't the page's; and one whose frame went is released now, so its forms go
        // with this report (a frame rewritten by `document.open()` sends no `pagehide`).
        prune();
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
    // Its document is done with: navigated away, rewritten or gone. Never used again.
    const old = a.node.doc.deref();
    if (old) {
      refused.add(old);
      const history = histories.get(old);
      history?.observer.disconnect();
      history?.children.disconnect();
      histories.delete(old);
    }
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
  function prune(): void {
    for (const [token, a] of agents) if (!stillAllowed(a.node, origin, record)) release(token, a);
  }
  const discover = () => {
    prune();
    let seen = 0;
    let later = false;
    const walk = (within: Document, parent: FrameNode | null, depth: number, ancestors: FrameContext['ancestors']) => {
      if (depth >= MAX_FRAME_DEPTH) return;
      for (const el of framesIn(within, MAX_FRAMES_SEEN)) {
        if (++seen > MAX_FRAMES_SEEN) return;
        const checked = frameCheck(el, origin, record);
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
          const rootElement = rootElementOf.call(frameDoc) as Element | null;
          const made: FrameNode = { el: new WeakRef(el), doc: new WeakRef(frameDoc), root: rootElement ? new WeakRef(rootElement) : null, parent };
          node = made;
          const fresh = {};
          running.set(frameDoc, fresh);
          watchHistory(frameDoc);
          const frame: FrameContext = { allowed: () => stillAllowed(made, origin, record), offset: () => (stillAllowed(made, origin, record) ? offsetOf(made, win) : null), ancestors: up };
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
      if (tag !== 'IFRAME' && tag !== 'FRAME') return;
      // Its document, heard loading in this document's own tree: what vouches for it (round 3 of #67).
      histories.get(d)?.loads.set(t as Element, contentDocumentOf(t as Element));
      soon();
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
    {
      stats: () => ({ agents: agents.size, forms: formsOf.size, fills: fills.size, owners: owners.size }),
      documents: () => [doc, ...[...agents.values()].flatMap((a) => (stillAllowed(a.node, origin, record) ? [a.node.doc.deref()!] : []))],
    },
  );
}
