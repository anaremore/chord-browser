/**
 * The page adapter (S18 M1a): what the control layer's tools do to a page,
 * without holding its WebContents. Each tool reads through it, so M2 can add
 * element refs here (from the isolated-world script or the debugger's
 * accessibility tree) without the tools changing.
 *
 * `id` is the document's page id: an opaque id, new with each main-frame
 * navigation (another document, or a same-document one such as pushState).
 * It goes in every read's result as `page_id`. A page starts being followed
 * the first time a tool reads it, so pages no agent reads cost nothing.
 */
import { BaseWindow, webContents as allContents, type WebContents } from 'electron';
import { readDiagnostics, type DiagnosticsRead } from './diagnostics';
import { readPage, screenshot, type PageRead } from './extract';
import { fillFormPage, readFormPage, undoFillPage, type FillHighlight, type FillOutcome, type FormPage } from './forms';
import { fetchPdf } from './pdf';
import { ACT_LOAD_MS, type FillWrite, type SnapshotRead } from '@chord/core';
import { actOnPage, settle, type ActAnswer, type ActOp } from './act';
import { openDeep, type DeepSession } from './deep';
import { pickersUnsecured } from '../agents/pickers';
import { takeDroppedAfter, watchSends, type Allowed, type SendWatch } from './sends';
import { pageCall } from '../page-call';
import { sendAgentInput, type AgentInputEvent } from './input';
import { snapshotPage } from './snapshot';

export interface ControlPage {
  /** The page id now (see above). */
  readonly id: string;
  /** Where its documents are now (another document only, not a pushState), for committedSince. */
  readonly mark: DocumentMark;
  /** Whether it went to another document since `mark`, committed (one on its way is waited for, at most `ms`). */
  committedSince(mark: DocumentMark, ms: number): Promise<boolean>;
  /** Where the page is now, which can be ahead of its tab's saved address. */
  url(): string;
  /** The page went (its tab closed, slept or crashed). */
  gone(): boolean;
  read(): Promise<PageRead | null>;
  screenshot(): Promise<{ data: string; mimeType: string } | null>;
  diagnostics(): Promise<DiagnosticsRead>;
  readForm(token: string): Promise<FormPage | null>;
  /** The page's accessibility outline (S18 M2b), its acted-on elements kept in the page as `owner`'s latest, under `token`. */
  snapshot(owner: string, token: string): Promise<SnapshotRead | null>;
  fillForm(args: { token: string; writes: FillWrite[]; undo: string; highlight: FillHighlight }): Promise<FillOutcome>;
  undoFill(undo: string): Promise<{ restored: number; kept: number } | null>;
  /** A PDF's bytes through the page's own session; `readable` checks each address it ends up at. */
  fetchPdf(url: string, readable: (finalUrl: string) => boolean): Promise<Uint8Array>;

  /* Acting (S18 M2c): for outside agents' own tabs, through the gate. */

  /** One step of an action on an element of `owner`'s latest snapshot (control/act.ts). */
  act(owner: string, token: string, key: number, op: ActOp): Promise<ActAnswer>;
  /** The pointer moved to a point of the view in CSS pixels (scaled by the page's zoom here). */
  pointer(x: number, y: number): void;
  /** The button pressed and let go there (after pointer, and a last hit test). */
  press(x: number, y: number): void;
  /** Keys, as the agent's (control/input.ts refuses anything off its list). */
  keys(events: readonly AgentInputEvent[]): void;
  /**
   * The page preload's guard (preload/agent-guard.ts) up, before text or keys: whatever has the focus now is all
   * input may reach. False if there's no guard to arm (then nothing is sent).
   */
  guard(until: 'keyup' | 'beforeinput'): Promise<boolean>;
  /**
   * The guard down, once the input's last event came (at most 250 ms): what it (or a frame's) stopped. `gone`: no
   * guard was ever up in that document (another document: the page went); `expired`: it was, and ran out or was
   * dropped (the user took the tab); `timeout`: the page didn't answer.
   */
  unguard(): Promise<{ moved: boolean; lost: boolean } | 'gone' | 'expired' | 'timeout'>;
  /** A frame of the page couldn't be held (agents/pickers.ts): no acting here, said at once. */
  unsecured(): boolean;
  /** Watches what one action sends (control/sends.ts): held, or let go for a step already allowed; null if it can't. */
  watchSends(allowed: Allowed | null): SendWatch | null;
  /** What the page sent after the last action, dropped (taken: the count goes back to 0). */
  droppedAfter(): number;
  /** The debugger's checks for one action (control/deep.ts); null if it can't be had. */
  deep(owner: string, token: string, key: number): Promise<DeepSession | null>;
  /** Text put in where the focus is, as one insertion (never as keys). */
  insertText(text: string): Promise<void>;
  /**
   * Runs `act` (the input), then waits for what it set off: a navigation's load (at most ACT_LOAD_MS), or the page
   * quiet for a moment. Says whether the page went somewhere else (its page id changed).
   */
  afterActing(act: () => void | Promise<void>): Promise<{ navigated: boolean; loading: boolean }>;
  /** Goes to an address and waits for the load (at most ACT_LOAD_MS). */
  navigate(url: string): Promise<{ loading: boolean }>;
  /**
   * The entry just before this one in the tab's history, or null. Not goBack's: Chromium's goBack skips entries a page
   * added without a gesture (a pushState), so it can land further back than the entry checked.
   */
  backEntry(): { index: number; url: string } | null;
  /** Goes to exactly that entry, if it's still there (null if not), and waits for the load. */
  back(entry: { index: number; url: string }): Promise<{ loading: boolean } | null>;
  title(): string;
}

let lastPageId = 0;
const followed = new WeakMap<WebContents, { id: string; document: number; starts: number }>();

/** The page id of a WebContents, following its navigations from the first time it's asked. */
export function pageIdOf(contents: WebContents): string {
  let entry = followed.get(contents);
  if (!entry) {
    const made = { id: `p${++lastPageId}`, document: 0, starts: 0 };
    entry = made;
    followed.set(contents, made);
    const next = () => (made.id = `p${++lastPageId}`);
    // did-navigate is the main frame's alone (another document); did-navigate-in-page fires for frames too.
    contents.on('did-navigate', () => {
      made.document++;
      next();
    });
    // Another document on its way (it may not have arrived yet).
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) made.starts++;
    });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) next();
    });
  }
  return entry.id;
}

/** Where the page's documents are: how many it committed, and how many it started to go to (since Chord followed it). */
export type DocumentMark = { document: number; starts: number };

export function documentMark(contents: WebContents): DocumentMark {
  pageIdOf(contents);
  const { document, starts } = followed.get(contents)!;
  return { document, starts };
}

/**
 * Whether the page went to another document since `mark`, committed (a navigation that never commits, a 204, a
 * download, one stopped, doesn't count: Neon's and Claude's review 7 of #110). One started since and not committed
 * yet is waited for, at most `ms`.
 */
export function committedSince(contents: WebContents, mark: DocumentMark, ms: number): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(true);
  const now = documentMark(contents);
  if (now.document !== mark.document) return Promise.resolve(true);
  if (now.starts === mark.starts) return Promise.resolve(false);
  return new Promise((done) => {
    const check = () => {
      if (contents.isDestroyed() || documentMark(contents).document !== mark.document) finish(true);
    };
    const stopped = () => setTimeout(() => finish(!contents.isDestroyed() && documentMark(contents).document !== mark.document), 0);
    const timer = setTimeout(() => finish(false), ms);
    function finish(went: boolean) {
      clearTimeout(timer);
      if (!contents.isDestroyed()) {
        contents.off('did-navigate', check);
        contents.off('did-stop-loading', stopped);
      }
      done(went);
    }
    contents.on('did-navigate', check);
    contents.on('did-stop-loading', stopped);
  });
}

/** Pages whose guard is up now: what a frame's preload is told as it starts (agentGuardUp). */
const guardsUp = new WeakSet<object>();

/** Whether an action's guard is up in the page now (a frame made meanwhile asks, and starts with its own up). */
export function agentGuardUp(contents: object): boolean {
  return guardsUp.has(contents);
}

/**
 * Takes the guard down at once, every frame's too: the user took the tab (their key or click pauses the agent there),
 * and their keys are never stopped. The action itself stops at its next check (the pause).
 */
export function dropAgentGuard(contents: WebContents): void {
  if (!guardsUp.has(contents) || contents.isDestroyed()) return;
  guardsUp.delete(contents);
  toFrames(contents, false);
  void inPreload(contents, 'globalThis.__chordAgentGuard && globalThis.__chordAgentGuard.drop()');
}

/** Tells every frame of the page but the top one whether the guard is up. */
function toFrames(contents: WebContents, up: boolean): void {
  if (up) guardsUp.add(contents);
  else guardsUp.delete(contents);
  if (contents.isDestroyed()) return;
  const main = contents.mainFrame;
  for (const frame of main?.framesInSubtree ?? []) {
    if (frame === main) continue;
    try {
      frame.send('chord:agentGuard', up);
    } catch {
      // A frame that went meanwhile.
    }
  }
}

/** The adapter for a page Chord holds. */
export function controlPage(contents: WebContents): ControlPage {
  /** A frame's guard stopped a key or an insertion while the guard was up. */
  let frameStopped = false;
  const onFrameStopped = () => void (frameStopped = true);
  return {
    get id() {
      return contents.isDestroyed() ? '' : pageIdOf(contents);
    },
    get mark() {
      return contents.isDestroyed() ? { document: -1, starts: -1 } : documentMark(contents);
    },
    committedSince: (mark, ms) => committedSince(contents, mark, ms),
    url: () => (contents.isDestroyed() ? '' : contents.getURL()),
    gone: () => contents.isDestroyed(),
    read: () => readPage(contents),
    screenshot: () => screenshot(contents),
    diagnostics: () => readDiagnostics(contents),
    readForm: (token) => readFormPage(contents, token),
    snapshot: (owner, token) => snapshotPage(contents, owner, token),
    fillForm: (args) => fillFormPage(contents, args),
    undoFill: (undo) => undoFillPage(contents, undo),
    fetchPdf: (url, readable) => fetchPdf(contents, url, readable),
    act: (owner, token, key, op) => actOnPage(contents, owner, token, key, op),
    pointer: (x, y) => sendAgentInput(contents, [{ type: 'mouseMove', ...viewPoint(contents, x, y) }]),
    press: (x, y) => {
      const at = viewPoint(contents, x, y);
      sendAgentInput(contents, [
        { type: 'mouseDown', ...at, button: 'left', clickCount: 1 },
        { type: 'mouseUp', ...at, button: 'left', clickCount: 1 },
      ]);
    },
    keys: (events) => sendAgentInput(contents, events),
    guard: async (until) => {
      // The frames' guards first (agent-guard.ts's installFrameGuard): whatever they stop meanwhile is heard here.
      frameStopped = false;
      contents.ipc?.on('page:agentGuardStopped', onFrameStopped);
      toFrames(contents, true);
      return (await inPreload(contents, `globalThis.__chordAgentGuard ? globalThis.__chordAgentGuard.arm(${JSON.stringify(until)}) : false`)) === true;
    },
    unguard: async () => {
      const answer = await inPreload(contents, 'globalThis.__chordAgentGuard ? globalThis.__chordAgentGuard.disarm(250) : null');
      toFrames(contents, false);
      contents.ipc?.off('page:agentGuardStopped', onFrameStopped);
      if (answer === PRELOAD_TIMEOUT) return 'timeout';
      if (!answer || typeof answer !== 'object') return 'gone';
      if ((answer as { expired?: unknown }).expired === true) return 'expired';
      const { moved, lost } = answer as { moved?: unknown; lost?: unknown };
      return { moved: moved === true || frameStopped, lost: lost === true };
    },
    deep: (owner, token, key) => openDeep(contents, owner, token, key),
    unsecured: () => pickersUnsecured(contents),
    watchSends: (allowed) => watchSends(contents, allowed),
    droppedAfter: () => takeDroppedAfter(contents),
    // Within a moment, as every step: a hung page doesn't hold the action (the guard comes down after it anyway).
    insertText: async (text) => {
      if (!contents.isDestroyed()) await pageCall(contents.insertText(text), undefined, 3000);
    },
    afterActing: (act) => afterActing(contents, act),
    navigate: async (url) => {
      const yours = await focusedPage();
      try {
        return await loaded(contents, () => contents.loadURL(url).catch(() => undefined));
      } finally {
        await giveBackFocus(contents, yours);
      }
    },
    backEntry: () => {
      if (contents.isDestroyed()) return null;
      const index = contents.navigationHistory.getActiveIndex() - 1;
      const url = index >= 0 ? contents.navigationHistory.getEntryAtIndex(index)?.url : undefined;
      return url ? { index, url } : null;
    },
    back: async (entry) => {
      if (contents.isDestroyed() || contents.navigationHistory.getEntryAtIndex(entry.index)?.url !== entry.url) return null;
      const yours = await focusedPage();
      try {
        return await loaded(contents, () => contents.navigationHistory.goToIndex(entry.index));
      } finally {
        await giveBackFocus(contents, yours);
      }
    },
    title: () => (contents.isDestroyed() ? '' : contents.getTitle()),
  };
}

/** Electron's world for the page preload (contextIsolation's): where its agent guard is. */
const PRELOAD_WORLD = 999;

/** What inPreload answers when the page doesn't, in time or at all. */
const PRELOAD_TIMEOUT = Symbol('timeout');

/** A script in the page preload's world, answered within a moment (PRELOAD_TIMEOUT if not). */
function inPreload(contents: WebContents, code: string): Promise<unknown> {
  if (contents.isDestroyed()) return Promise.resolve(PRELOAD_TIMEOUT);
  return pageCall(contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD, [{ code }]), PRELOAD_TIMEOUT, 3000);
}

/** The page's CSS pixels to the view's: sendInputEvent's points are the view's, the page zoomed in them. */
function viewPoint(contents: WebContents, x: number, y: number): { x: number; y: number } {
  const zoom = contents.getZoomFactor();
  return { x: Math.round(x * zoom), y: Math.round(y * zoom) };
}

/** Starts a load and waits for it to stop (at most ACT_LOAD_MS): `loading` if it's still going then. */
function loaded(contents: WebContents, start: () => unknown): Promise<{ loading: boolean }> {
  return new Promise((done) => {
    if (contents.isDestroyed()) return done({ loading: false });
    const timer = setTimeout(() => finish(true), ACT_LOAD_MS);
    const stopped = () => finish(false);
    function finish(loading: boolean) {
      clearTimeout(timer);
      if (!contents.isDestroyed()) contents.off('did-stop-loading', stopped);
      done({ loading });
    }
    contents.on('did-stop-loading', stopped);
    void start();
  });
}

/** How long after an action Chord waits for it to start a navigation before it waits for the page to settle instead. */
const NAVIGATION_START_MS = 150;

/** The input, then a navigation it set off (to its load) or the page settling. */
async function afterActing(contents: WebContents, act: () => void | Promise<void>): Promise<{ navigated: boolean; loading: boolean }> {
  if (contents.isDestroyed()) return { navigated: false, loading: false };
  const before = pageIdOf(contents);
  // Where your focus is: an agent's tab never keeps it after its action (a page it took somewhere can take it).
  const yours = await focusedPage();
  let started = false;
  const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) started = true;
  };
  contents.on('did-start-navigation', onStart);
  try {
    await act();
    await new Promise((r) => setTimeout(r, NAVIGATION_START_MS));
    let loading = false;
    if (started && !contents.isDestroyed() && contents.isLoading()) loading = (await loaded(contents, () => undefined)).loading;
    else await settle(contents);
    return { navigated: contents.isDestroyed() || pageIdOf(contents) !== before, loading };
  } finally {
    if (!contents.isDestroyed()) contents.off('did-start-navigation', onStart);
    await giveBackFocus(contents, yours);
  }
}

/** Which page has the focus, in which window (Electron's): none where there's no Electron (the unit tests). */
type Focus = { page: WebContents | null; window: object | null };

async function focusedPage(): Promise<Focus> {
  try {
    return { page: allContents?.getFocusedWebContents?.() ?? null, window: BaseWindow?.getFocusedWindow?.() ?? null };
  } catch {
    return { page: null, window: null };
  }
}

/**
 * The page to give the focus back to after an agent's action, or null: only to the page that had it, only if the
 * agent's page has it now or no page does, and only while the same Chord window is in front as before (focusing a
 * page brings its window forward, on macOS too: Claude's reviews 7 and 8 of #110). When it isn't in front, coming
 * back to it gives the focus to the page you see (window.ts' keepFocusOffParked), never the agent's.
 */
export function focusToGiveBack<P>(before: { page: P | null; window: object | null }, now: { page: P | null; window: object | null }, agent: P): P | null {
  if (!before.page || before.page === agent || !before.window || now.window !== before.window) return null;
  return now.page === null || now.page === agent ? before.page : null;
}

/**
 * Your focus, after an agent's action (Neon's review of #110, seen in agents.spec): input Chord sends a parked tab can
 * leave no page with the focus, and a navigation it sets off gives the agent's new page the focus. Either way it goes
 * back to the page that had it, never left with the agent's tab, or with nothing, while you use another. A page of
 * yours you went to meanwhile keeps it.
 */
async function giveBackFocus(contents: WebContents, yours: Focus): Promise<void> {
  const back = focusToGiveBack(yours, await focusedPage(), contents);
  if (back && !back.isDestroyed()) back.focus();
}
