/**
 * Acting's checks that a page's own script can't make (Neon's review of #110), through Chromium's DevTools protocol on
 * the tab's `webContents.debugger`, attached only while an action presses or types (withDebugger: one client at a
 * time) and let go after:
 *
 * - **What's under the point**, through closed shadow roots, which `elementFromPoint` stops at (a button can hide a
 *   frame in one and let it take the pointer once it moves there): `DOM.getNodeForLocation`. The node found must be
 *   the ref's element or inside it (closed roots too: from inside one, `getRootNode().host` leads out), never a frame,
 *   never what opens a file picker, and for a second click at a point without a fresh move, the very node the last
 *   move was over.
 * - **Closed shadow roots in what takes text or keys**: `document.activeElement` stops at a closed root's host too,
 *   so the focus could be on a password field inside it while the page says it's on the element. An element with a
 *   closed root in it (`DOM.describeNode` with `pierce`) is never typed in or pressed keys in.
 * - **File pickers**: while the session is open, one the page opens is intercepted, never shown
 *   (`Page.setInterceptFileChooserDialog`), and the action's result says so. Agents never choose files.
 *
 * The node checks run in Chord's own isolated world (ASSISTANT_WORLD, found by its snapshots: a page can't reach it or
 * change what its functions do), on nodes CDP hands it. If the debugger can't be had, nothing is pressed or typed.
 */
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { pageCall } from '../page-call';
import { SNAPSHOT_LIB } from './snapshot';

/** At most this long for the whole session (a hung page): then it's let go, and whatever waited is refused. */
const DEEP_SESSION_MS = 20_000;
/** Each command's limit. */
const DEEP_COMMAND_MS = 3000;

export type DeepAnswer = { ok: true } | { ok: false; why: 'stale' | 'covered' | 'no-move' | 'file' | 'closed' | 'no-check'; cover?: { role: string; name: string }; step?: string };

export interface DeepSession {
  /**
   * What's under (x, y), in the document's CSS pixels (the view's point plus the scroll: DOM.getNodeForLocation's),
   * is the element's own; `repeat`: no fresh move was seen, so it must be the node the last one was over.
   */
  hit(x: number, y: number, repeat: boolean): Promise<DeepAnswer>;
  /** The element holds no closed shadow root (what takes text and keys is all to be seen). */
  open(): Promise<DeepAnswer>;
  /** Lets go of the debugger; says whether a file picker was held meanwhile. */
  close(): Promise<{ picker: boolean }>;
}

type Debugger = WebContents['debugger'];
type Node = { shadowRoots?: (Node & { shadowRootType?: string })[]; children?: Node[]; contentDocument?: Node; shadowRootType?: string };

/** A frame's title or what covers a point, as act.ts names it. */
const CHECK_FN = String.raw`function (owner, token, key, repeat) {
  ${SNAPSHOT_LIB}
  const hit = this;
  const read = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(owner);
  if (!read || read.token !== token) return { ok: false, why: 'stale' };
  const entry = read.keep[key];
  const el = entry && entry.ref.deref();
  if (!el || !el.isConnected) return { ok: false, why: 'stale' };
  const FRAMES = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
  const up = (n) => n.parentNode ? (n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode) : null;
  const coverOf = (cover) => {
    for (let n = cover; n && n.nodeType === 1; n = up(n)) {
      if (FRAMES.has(n.localName)) return { role: 'frame', name: clip(n.getAttribute('title') || '', NAME_MAX) };
      const r2 = roleNow(n);
      if (r2) return { role: r2, name: nameOf(n, r2) };
    }
    return { role: cover && cover.localName ? cover.localName : 'element', name: '' };
  };
  // From the node up to the element, through closed roots too; a frame anywhere on the way is never the element's.
  let ours = false;
  for (let n = hit; n; n = up(n)) {
    if (n.nodeType === 1 && FRAMES.has(n.localName)) return { ok: false, why: 'covered', cover: coverOf(n) };
    if (n === el) { ours = true; break; }
  }
  if (!ours) return { ok: false, why: 'covered', cover: coverOf(hit.nodeType === 1 ? hit : up(hit)) };
  if (hit.nodeType === 1 && opensFiles(hit)) return { ok: false, why: 'file' };
  if (repeat) {
    const last = globalThis.__chordRepeat && globalThis.__chordRepeat.deref();
    if (last !== hit && !(hit.nodeType === 3 && last === up(hit))) return { ok: false, why: 'no-move' };
  }
  return { ok: true };
}`;

const hasClosedRoot = (node: Node | undefined): boolean => {
  if (!node) return false;
  for (const root of node.shadowRoots ?? []) if (root.shadowRootType === 'closed' || hasClosedRoot(root)) return true;
  if (node.children?.some(hasClosedRoot)) return true;
  return hasClosedRoot(node.contentDocument);
};

/**
 * Opens a session on the page for one action on `key` of `owner`'s latest snapshot `token`: the debugger attached
 * (or, if someone's DevTools have it, used as it is), Chord's world found, the element in hand. Null if it can't be.
 */
export async function openDeep(contents: WebContents, owner: string, token: string, key: number): Promise<DeepSession | null> {
  if (contents.isDestroyed()) return null;
  let release: (value: void) => void = () => undefined;
  const released = new Promise<void>((done) => (release = done));
  let ready: (session: DeepSession | null) => void = () => undefined;
  const session = new Promise<DeepSession | null>((done) => (ready = done));
  void withDebugger(contents, async () => {
    const debug: Debugger = contents.debugger;
    const mine = !debug.isAttached();
    let picker = false;
    const contexts: { id: number; frameId?: string; type?: string }[] = [];
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
      if (sessionId) return;
      if (method === 'Runtime.executionContextCreated') {
        const c = (params as { context?: { id?: number; auxData?: { frameId?: string; type?: string } } }).context;
        if (typeof c?.id === 'number') contexts.push({ id: c.id, ...(c.auxData?.frameId ? { frameId: c.auxData.frameId } : {}), ...(c.auxData?.type ? { type: c.auxData.type } : {}) });
      }
      if (method === 'Page.fileChooserOpened') picker = true;
    };
    /** Why the last command had no answer (for the refusal's diagnostics). */
    let lastError = '';
    const send = async <T>(method: string, params?: object): Promise<T | null> => {
      if (contents.isDestroyed() || !debug.isAttached()) return null;
      const answer = await pageCall(
        (debug.sendCommand(method, params) as Promise<T>).catch((error: unknown) => {
          lastError = `${method}: ${error instanceof Error ? error.message : String(error)}`;
          return null;
        }),
        null,
        DEEP_COMMAND_MS,
      );
      return answer ?? null;
    };
    let closed = false;
    const close = async (): Promise<{ picker: boolean }> => {
      if (closed) return { picker };
      closed = true;
      debug.off('message', onMessage);
      if (!contents.isDestroyed() && debug.isAttached()) {
        // Letting go cancels a picker held meanwhile. Someone else's client keeps its attachment: what Chord turned on
        // goes off, without waiting on the page.
        if (mine) debug.detach();
        else for (const [method, params] of [['Page.setInterceptFileChooserDialog', { enabled: false }], ['Runtime.disable', undefined]] as const) debug.sendCommand(method, params).catch(() => undefined);
      }
      release();
      return { picker };
    };
    try {
      if (mine) debug.attach('1.3');
    } catch {
      ready(null);
      return;
    }
    debug.on('message', onMessage);
    const timer = setTimeout(() => void close(), DEEP_SESSION_MS);
    timer.unref?.();
    try {
      const tree = await send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
      const main = tree?.frameTree.frame.id;
      // Page's events (the picker opened), and the picker intercepted from now on.
      const intercepted = main && (await send('Page.enable')) && (await send('Page.setInterceptFileChooserDialog', { enabled: true }));
      // Runtime.enable names every context before it answers: Chord's world is the main frame's isolated one with its snapshots.
      const enabled = intercepted && (await send('Runtime.enable'));
      let world: number | null = null;
      if (enabled) {
        for (const c of contexts) {
          if (c.frameId !== main || c.type !== 'isolated') continue;
          const ours = await send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'globalThis.__chordSnapshots instanceof Map', contextId: c.id, returnByValue: true });
          if (ours?.result.value === true) {
            world = c.id;
            break;
          }
        }
      }
      const element = world
        ? await send<{ result: { objectId?: string } }>('Runtime.evaluate', {
            contextId: world,
            expression: `(() => { const r = globalThis.__chordSnapshots.get(${JSON.stringify(owner)}); if (!r || r.token !== ${JSON.stringify(token)}) return null; const e = r.keep[${JSON.stringify(key)}]; return (e && e.ref.deref()) || null; })()`,
          })
        : null;
      const elementId = element?.result.objectId;
      if (!main || !world || !elementId) {
        await close();
        ready(null);
        return;
      }
      const worldId = world;
      const parents = new Map<string, string>();
      const walk = (f: { frame: { id: string }; childFrames?: unknown[] }, parent?: string) => {
        if (parent) parents.set(f.frame.id, parent);
        for (const child of (f.childFrames ?? []) as { frame: { id: string }; childFrames?: unknown[] }[]) walk(child, f.frame.id);
      };
      walk(tree!.frameTree as { frame: { id: string }; childFrames?: unknown[] });
      ready({
        hit: async (x, y, repeat) => {
          const at = await send<{ backendNodeId: number; frameId: string }>('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
          if (!at) return { ok: false, why: 'no-check', step: `location ${lastError}` };
          let backendNodeId = at.backendNodeId;
          // A node in another frame: named by its frame's element in the page (the main frame's child it's under).
          if (at.frameId !== main) {
            let frame = at.frameId;
            while (parents.get(frame) && parents.get(frame) !== main) frame = parents.get(frame)!;
            const owner = await send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame });
            if (!owner) return { ok: false, why: 'covered', cover: { role: 'frame', name: '' } };
            backendNodeId = owner.backendNodeId;
          }
          const resolved = await send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: worldId });
          if (!resolved?.object.objectId) return { ok: false, why: 'no-check', step: `resolve ${lastError}` };
          const checked = await send<{ result: { value?: DeepAnswer } }>('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            functionDeclaration: CHECK_FN,
            arguments: [{ value: owner }, { value: token }, { value: key }, { value: repeat }],
            returnByValue: true,
          });
          const answer = checked?.result.value;
          return answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : { ok: false, why: 'no-check', step: `check ${lastError}` };
        },
        open: async () => {
          const described = await send<{ node: Node }>('DOM.describeNode', { objectId: elementId, depth: -1, pierce: true });
          if (!described) return { ok: false, why: 'no-check' };
          return hasClosedRoot(described.node) ? { ok: false, why: 'closed' } : { ok: true };
        },
        close,
      });
      await released;
    } catch {
      await close();
      ready(null);
    } finally {
      clearTimeout(timer);
    }
  });
  return session;
}
