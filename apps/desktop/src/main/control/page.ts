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
import type { WebContents } from 'electron';
import { readDiagnostics, type DiagnosticsRead } from './diagnostics';
import { readPage, screenshot, type PageRead } from './extract';
import { fillFormPage, readFormPage, undoFillPage, type FillHighlight, type FillOutcome, type FormPage } from './forms';
import { fetchPdf } from './pdf';
import { ACT_LOAD_MS, type FillWrite, type SnapshotRead } from '@chord/core';
import { actOnPage, settle, type ActAnswer, type ActOp } from './act';
import { sendAgentInput, type AgentInputEvent } from './input';
import { snapshotPage } from './snapshot';

export interface ControlPage {
  /** The page id now (see above). */
  readonly id: string;
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
const followed = new WeakMap<WebContents, { id: string }>();

/** The page id of a WebContents, following its navigations from the first time it's asked. */
export function pageIdOf(contents: WebContents): string {
  let entry = followed.get(contents);
  if (!entry) {
    const made = { id: `p${++lastPageId}` };
    entry = made;
    followed.set(contents, made);
    const next = () => (made.id = `p${++lastPageId}`);
    // did-navigate is the main frame's alone; did-navigate-in-page fires for frames too.
    contents.on('did-navigate', next);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) next();
    });
  }
  return entry.id;
}

/** The adapter for a page Chord holds. */
export function controlPage(contents: WebContents): ControlPage {
  return {
    get id() {
      return contents.isDestroyed() ? '' : pageIdOf(contents);
    },
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
    insertText: (text) => (contents.isDestroyed() ? Promise.resolve() : contents.insertText(text)),
    afterActing: (act) => afterActing(contents, act),
    navigate: (url) => loaded(contents, () => contents.loadURL(url).catch(() => undefined)),
    backEntry: () => {
      if (contents.isDestroyed()) return null;
      const index = contents.navigationHistory.getActiveIndex() - 1;
      const url = index >= 0 ? contents.navigationHistory.getEntryAtIndex(index)?.url : undefined;
      return url ? { index, url } : null;
    },
    back: async (entry) => {
      if (contents.isDestroyed() || contents.navigationHistory.getEntryAtIndex(entry.index)?.url !== entry.url) return null;
      return loaded(contents, () => contents.navigationHistory.goToIndex(entry.index));
    },
    title: () => (contents.isDestroyed() ? '' : contents.getTitle()),
  };
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
  }
}
