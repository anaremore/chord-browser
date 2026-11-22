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
import type { FillWrite, SnapshotRead } from '@chord/core';
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
  };
}
