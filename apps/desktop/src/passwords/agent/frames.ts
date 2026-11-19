/**
 * Same-origin frames (S17 §4, phase 3C; M0 §2): the preload runs in a tab's top frame only, so the top frame's agent
 * reaches into its frames' documents from its own world and runs an agent on each (`startAgent` with a FrameContext).
 *
 * **Which frames.** `<iframe>` and `<frame>` in the document and its open roots, 3 levels deep at most and 20 frames in
 * all; past either, the rest are skipped quietly. One is used only while all of these hold, checked at every use (each
 * event, the focus box, a fill), never cached:
 * - it has no `sandbox` attribute at all, `allow-same-origin` included (S17 §5; Bitwarden refuses them too);
 * - its document is reachable (`contentDocument`, through the top realm's getter: another site's is null);
 * - that document's address is http(s): never `about:blank`, `about:srcdoc`, `data:` or `blob:`, which inherit or hide
 *   an origin;
 * - its origin is the top's, exactly (`location.origin` as the address gives it), and not opaque;
 * - every frame above it holds the same.
 *
 * Main is unchanged: every message comes from the top frame, whose origin main checks, and a frame's agent only ever
 * touches a document of that same origin. So a password for an origin only reaches a document of that origin.
 *
 * **One bridge.** The agents share the top's bridge through a hub: form ids from one counter, the `forms` of all of them
 * as one report (main's reappeared-form check reads the page's whole set), a fill routed to the agent whose form it
 * names, and a `blur` dropped when another agent has sent `focus` since (focus moved into another frame).
 */
import type { PasswordsAgentChannel, PasswordsAgentMessage } from '@chord/ipc';
import { FORMS_JSON_MAX, startAgent, type AgentOptions, type FrameContext, type PasswordsBridge } from './agent';
import { framesIn, MAX_REPORTED_FORMS } from './scan';

/** How deep frames go, and how many there may be in all. */
export const MAX_FRAME_DEPTH = 3;
export const MAX_FRAMES = 20;

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

/** The document of `el` (an iframe or frame) when it may be used, else null: see the rules above. */
export function frameDocumentOf(el: Element, origin: string): Document | null {
  try {
    if (Element.prototype.getAttribute.call(el, 'sandbox') !== null) return null;
    const tag = String(tagOf.call(el));
    const doc = (tag === 'IFRAME' ? iframeDocument : tag === 'FRAME' ? frameDocument : null)?.call(el) as Document | null;
    if (!doc) return null;
    const url = String(urlOf.call(doc));
    if (!/^https?:/i.test(url)) return null;
    const own = new URL(url).origin;
    return own !== 'null' && own === origin ? doc : null;
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
/** The frame's content box in the tab's CSS pixels: its box, its border and its padding, through every frame up. */
const offsetOf = (node: FrameNode, top: Window): { x: number; y: number } | null => {
  let x = 0;
  let y = 0;
  for (let n: FrameNode | null = node; n; n = n.parent) {
    const el = n.el.deref();
    if (!el) return null;
    const r = Element.prototype.getBoundingClientRect.call(el);
    const style = top.getComputedStyle(el);
    x += r.left + Number(clientLeft.call(el)) + (parseFloat(style.paddingLeft) || 0);
    y += r.top + Number(clientTop.call(el)) + (parseFloat(style.paddingTop) || 0);
  }
  return { x, y };
};

type Forms = PasswordsAgentMessage<'forms'>['forms'];

/** Starts the top document's agent and one for each allowed same-origin frame. Returns a stop function. */
export function startAgents(bridge: PasswordsBridge, options: Pick<AgentOptions, 'document' | 'window'> = {}): () => void {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const origin = new URL(String(urlOf.call(doc))).origin;
  const ids = { value: 1 };
  /** Each agent's last forms, in the order they started (the top's first). */
  const formsOf = new Map<object, Forms>();
  const owners = new Map<string, object>();
  const fills = new Map<object, (payload: unknown) => void>();
  let sentForms = '';
  let focusedBy: object | null = null;
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
  bridge.onFill?.((payload) => {
    const formId = (payload as { formId?: unknown } | null)?.formId;
    const to = (typeof formId === 'string' && owners.get(formId)) || topToken;
    fills.get(to)?.(payload);
  });
  /** One agent's view of the bridge. */
  const hub = (token: object): PasswordsBridge => ({
    send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>) {
      if (channel === 'forms') {
        const forms = (payload as PasswordsAgentMessage<'forms'>).forms;
        formsOf.set(token, forms);
        for (const f of forms) owners.set(f.formId, token);
        return sendForms();
      }
      if (channel === 'focus') focusedBy = token;
      else if (channel === 'blur') {
        // Focus went into another frame's field, whose `focus` came first: this blur is the old one's.
        if (focusedBy !== token) return;
        focusedBy = null;
      }
      bridge.send(channel, payload);
    },
    onFill: (listener) => void fills.set(token, listener),
  });

  const topToken = {};
  const stops: (() => void)[] = [startAgent(hub(topToken), { document: doc, window: win, ids })];
  /** The agents running, by the frame document each runs on (a navigated frame's new document gets its own). */
  const running = new WeakMap<Document, object>();
  const tokens = new Map<object, FrameNode>();
  const listened = new WeakSet<Document>();

  /** The frames as they are now: new allowed documents get an agent; one that's no longer allowed loses its forms. */
  const discover = () => {
    let count = 0;
    const walk = (within: Document, parent: FrameNode | null, depth: number, ancestors: FrameContext['ancestors']) => {
      if (depth >= MAX_FRAME_DEPTH) return;
      for (const el of framesIn(within, MAX_FRAMES)) {
        if (count >= MAX_FRAMES) return;
        count++;
        const frameDoc = frameDocumentOf(el, origin);
        const frameWin = frameDoc ? windowOf(el) : null;
        if (!frameDoc || !frameWin) continue;
        const node: FrameNode = { el: new WeakRef(el), doc: new WeakRef(frameDoc), parent };
        const up = [{ document: within, window: ((viewOf.call(within) as Window | null) ?? win) }, ...ancestors];
        if (!running.has(frameDoc)) {
          const token = {};
          running.set(frameDoc, token);
          tokens.set(token, node);
          listen(frameDoc);
          const frame: FrameContext = { allowed: () => stillAllowed(node, origin), offset: () => (stillAllowed(node, origin) ? offsetOf(node, win) : null), ancestors: up };
          stops.push(startAgent(hub(token), { document: frameDoc, window: frameWin, frame, ids, timers: win }));
        }
        walk(frameDoc, node, depth + 1, up);
      }
    };
    walk(doc, null, 0, []);
    // A frame no longer allowed (navigated, sandboxed, another origin, gone): its forms aren't the page's any more.
    let dropped = false;
    for (const [token, node] of tokens) {
      if (stillAllowed(node, origin)) continue;
      tokens.delete(token);
      dropped = formsOf.delete(token) || dropped;
    }
    if (dropped) sendForms();
  };
  /** Frames that load together (a page's 30 ads) are looked at once, 50 ms after the first. */
  let pending = 0;
  const soon = () => {
    if (!pending)
      pending = win.setTimeout(() => {
        pending = 0;
        discover();
      }, 50);
  };
  stops.push(() => {
    if (pending) win.clearTimeout(pending);
  });
  /** A frame's load, in this document or a frame's: it may be a new frame, or one that navigated. */
  function listen(d: Document): void {
    if (listened.has(d)) return;
    listened.add(d);
    const onLoad = (event: Event) => {
      const t = event.composedPath()[0];
      const tag = t && typeof t === 'object' && 'tagName' in t ? String(tagOf.call(t as Element)) : '';
      if (tag === 'IFRAME' || tag === 'FRAME') soon();
    };
    EventTarget.prototype.addEventListener.call(d, 'load', onLoad, { capture: true, passive: true });
    stops.push(() => EventTarget.prototype.removeEventListener.call(d, 'load', onLoad, { capture: true }));
  }
  listen(doc);
  discover();
  return () => {
    for (const stop of stops) stop();
  };
}
