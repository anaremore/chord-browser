/**
 * Acting's checks that a page's own script can't make (Neon's review of #110), through Chromium's DevTools protocol on
 * the tab's `webContents.debugger`, attached only while an action presses or types (withDebugger: one client at a
 * time) and let go after:
 *
 * - **What's under the point**, through closed shadow roots, which `elementFromPoint` stops at (a button can hide a
 *   frame in one and let it take the pointer once it moves there): `DOM.getNodeForLocation`. The node found must be
 *   the ref's element or inside it (closed roots too: from inside one, `getRootNode().host` leads out), never a frame,
 *   never what opens a file picker (a file input, a label for one).
 * - **Closed shadow roots in what takes text or keys**: `document.activeElement` stops at a closed root's host too,
 *   so the focus could be on a password field inside it while the page says it's on the element. An element with a
 *   closed root in it (`DOM.describeNode` with `pierce`) is never typed in or pressed keys in.
 *
 * An agent's tab has its debugger attached for its whole life (agents/pickers.ts holds its file pickers): the session
 * uses it as it is and never detaches it. One that isn't attached (no agent's tab) is attached for the session.
 *
 * The node checks run in Chord's own isolated world (ASSISTANT_WORLD, found by its snapshots: a page can't reach it or
 * change what its functions do), on nodes CDP hands it. Finding that world's context needs `Runtime.enable` (its
 * contexts are named only to a client that enables it): once per document, disabled again at once, the context kept
 * for the document's later actions, which only `Runtime.evaluate` and `Runtime.callFunctionOn` in it (neither needs
 * Runtime enabled). Enabling replays the page's stored console entries (at most about 1,000): that's paid on a
 * document's first action only, and the entries stay for page_diagnostics and DevTools. Every object the session
 * gets is in its own group, released when it closes (an agent's tab stays attached: nothing is kept alive). If the
 * debugger can't be had, nothing is pressed or typed.
 */
import { userLeaseLost } from './user-watch';
import type { WebContents } from 'electron';
import { pickersLost, retryPickers } from '../agents/pickers';
import { withDebugger } from '../debugger-queue';
import { pageCall } from '../page-call';
import { SNAPSHOT_LIB } from './snapshot';

/** At most this long for the whole session (a hung page): then it's let go, and whatever waited is refused. */
const DEEP_SESSION_MS = 20_000;
/** The group every object a session gets is in, released when it closes. */
const OBJECT_GROUP = 'chord-acting';
/** Each command's limit. */
const DEEP_COMMAND_MS = 3000;

export type DeepAnswer = { ok: true } | { ok: false; why: 'stale' | 'replaced' | 'changed' | 'covered' | 'no-move' | 'file' | 'closed' | 'no-check'; cover?: { role: string; name: string }; step?: string };

export interface DeepSession {
  /** What's under (x, y), in the document's CSS pixels (the view's point plus the scroll: DOM.getNodeForLocation's), is the element's own. */
  hit(x: number, y: number): Promise<DeepAnswer>;
  /** The element holds no closed shadow root (what takes text and keys is all to be seen). */
  open(): Promise<DeepAnswer>;
  /** Whether the tab's file picker hold is still on (an agent's tab's: asked before every input). */
  held(): boolean;
  /** Lets go of the debugger (detached if the session attached it). */
  close(): Promise<void>;
}

type Debugger = WebContents['debugger'];

/** Chord's world's context in each page's current document (its main frame's loader), found once per document. */
const worlds = new WeakMap<WebContents, { document: string; world: number }>();
type Node = { shadowRoots?: (Node & { shadowRootType?: string })[]; children?: Node[]; contentDocument?: Node; shadowRootType?: string };

/** A frame's title or what covers a point, as act.ts names it. */
const CHECK_FN = String.raw`function (owner, token, key) {
  ${SNAPSHOT_LIB}
  const hit = this;
  const read = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(owner);
  if (!read || read.token !== token) return { ok: false, why: 'stale' };
  if (read.finish) read.finish();
  const entry = read.keep[key];
  const el = entry && entry.ref.deref();
  // Replaced since the action pointed at it (a page that re-renders): said so, and the action starts over (tools.ts).
  if (!el || !el.isConnected) return { ok: false, why: entry && entry.path !== undefined ? 'replaced' : 'stale' };
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
  // What opens a file picker on the way too: a file input, or a label for one (its text, an icon in it).
  let ours = false;
  for (let n = hit; n; n = up(n)) {
    if (n.nodeType === 1 && FRAMES.has(n.localName)) return { ok: false, why: 'covered', cover: coverOf(n) };
    if (n.nodeType === 1 && opensFiles(n)) return { ok: false, why: 'file' };
    if (n === el) { ours = true; break; }
    // Inside a closed shadow root (Neon's review of #112): what it is can't be classified there, so it isn't clicked.
    if (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.mode === 'closed') return { ok: false, why: 'closed' };
  }
  if (!ours) return { ok: false, why: 'covered', cover: coverOf(hit.nodeType === 1 ? hit : up(hit)) };
  for (let n = el; n; n = up(n)) if (n.nodeType === 1 && n.localName === 'label' && opensFiles(n)) return { ok: false, why: 'file' };
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
  // An agent's tab whose file picker hold is down (agents/pickers.ts): tried once more for this action; nothing is
  // pressed or typed until it's back.
  if (pickersLost(contents) && !(await retryPickers(contents))) return null;
  let release: (value: void) => void = () => undefined;
  const released = new Promise<void>((done) => (release = done));
  let ready: (session: DeepSession | null) => void = () => undefined;
  const session = new Promise<DeepSession | null>((done) => (ready = done));
  void withDebugger(contents, async () => {
    const debug: Debugger = contents.debugger;
    // An agent's tab: attached for its whole life (agents/pickers.ts), used as it is. Otherwise attached for this.
    const mine = !debug.isAttached();
    const contexts: { id: number; frameId?: string; type?: string }[] = [];
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
      if (sessionId) return;
      if (method !== 'Runtime.executionContextCreated') return;
      const c = (params as { context?: { id?: number; auxData?: { frameId?: string; type?: string } } }).context;
      if (typeof c?.id === 'number') contexts.push({ id: c.id, ...(c.auxData?.frameId ? { frameId: c.auxData.frameId } : {}), ...(c.auxData?.type ? { type: c.auxData.type } : {}) });
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
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      debug.off('message', onMessage);
      // What the session held of the page goes (a node a page since removed would stay alive otherwise).
      if (!contents.isDestroyed() && debug.isAttached()) debug.sendCommand('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
      // Only what the session attached; an agent's tab keeps its own attachment (nothing else was turned on: Runtime
      // was enabled and disabled within the session).
      if (mine && !contents.isDestroyed() && debug.isAttached()) debug.detach();
      release();
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
      const tree = await send<{ frameTree: { frame: { id: string; loaderId?: string } } }>('Page.getFrameTree');
      const main = tree?.frameTree.frame.id;
      const document = tree?.frameTree.frame.loaderId ?? '';
      const isOurs = async (id: number) =>
        (await send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'globalThis.__chordSnapshots instanceof Map', contextId: id, returnByValue: true }))?.result.value === true;
      // Chord's world: the one found before in this document, if it still answers; else found now (see above).
      let world: number | null = null;
      const known = worlds.get(contents);
      if (main && known && known.document === document && (await isOurs(known.world))) world = known.world;
      if (main && world === null && (await send('Runtime.enable'))) {
        await send('Runtime.disable');
        for (const c of contexts) {
          if (c.frameId !== main || c.type !== 'isolated') continue;
          if (await isOurs(c.id)) {
            world = c.id;
            worlds.set(contents, { document, world });
            break;
          }
        }
      }
      const element = world
        ? await send<{ result: { objectId?: string } }>('Runtime.evaluate', {
            contextId: world,
            objectGroup: OBJECT_GROUP,
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
        hit: async (x, y) => {
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
          const resolved = await send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: worldId, objectGroup: OBJECT_GROUP });
          if (!resolved?.object.objectId) return { ok: false, why: 'no-check', step: `resolve ${lastError}` };
          const checked = await send<{ result: { value?: DeepAnswer } }>('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            objectGroup: OBJECT_GROUP,
            functionDeclaration: CHECK_FN,
            arguments: [{ value: owner }, { value: token }, { value: key }],
            returnByValue: true,
          });
          const answer = checked?.result.value;
          return answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : { ok: false, why: 'no-check', step: `check ${lastError}` };
        },
        open: async () => {
          // The ref's element as it is now (the review of #117: the node the hit test found and the one checked here are
          // the same, never one from when this session opened). Not there: the snapshot gone (stale), the node replaced
          // since (replaced, when it could be found again: the action starts over, tools.ts; else changed), or no answer
          // (no-check). Only replaced is tried again (the review of #117, round 3).
          const now = await send<{ result: { objectId?: string; value?: unknown } }>('Runtime.evaluate', {
            contextId: worldId,
            objectGroup: OBJECT_GROUP,
            expression: `(() => { const r = globalThis.__chordSnapshots && globalThis.__chordSnapshots.get(${JSON.stringify(owner)}); if (!r || r.token !== ${JSON.stringify(token)}) return 'stale'; if (r.finish) r.finish(); const e = r.keep[${JSON.stringify(key)}]; if (!e) return 'stale'; const el = e.ref.deref(); if (el && el.isConnected) return el; return e.path !== undefined ? 'replaced' : 'changed'; })()`,
          });
          if (!now) return { ok: false, why: 'no-check', step: `open ${lastError}` };
          const currentId = now.result.objectId;
          if (!currentId) {
            const why = now.result.value;
            return { ok: false, why: why === 'stale' || why === 'replaced' || why === 'changed' ? why : 'no-check' };
          }
          const described = await send<{ node: Node }>('DOM.describeNode', { objectId: currentId, depth: -1, pierce: true });
          if (!described) return { ok: false, why: 'no-check' };
          return hasClosedRoot(described.node) ? { ok: false, why: 'closed' } : { ok: true };
        },
        held: () => !pickersLost(contents) && !userLeaseLost(contents),
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
