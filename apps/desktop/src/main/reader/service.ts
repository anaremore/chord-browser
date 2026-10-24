/**
 * Reader view (ARCHITECTURE.md §9, DESIGN.md §7.11): a tab's article in
 * Chord's own typography, in a view of Chord's own that takes the page's
 * place in the frame while it's open. The page waits behind it, detached
 * and untouched, scroll and all, and comes back as it was when it closes.
 *
 * - Whether a page reads as an article is asked once it has loaded, in
 *   Chord's isolated world (scripts.ts); the tab's `readable` says so, and
 *   the address offers reader view.
 * - The article is read in the same world, as JSON text, cleaned by core's
 *   `sanitizeArticle` in a worker thread (worker.ts), and only then handed
 *   to the view: `chord://reader`, on Chord's UI session, whose CSP runs no
 *   script but Chord's own. Main only passes strings along.
 * - Its images load from `chord://reader/image/<key>/<n>`: main fetches the
 *   article's nth image through the tab's own session, so its cookies apply
 *   (a private window's stay in memory), and nothing else can be fetched.
 * - Its links go where a click in the tab would take them (Browser decides).
 */
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { isReaderUrl, placeKey, type Command, type NodeId } from '@chord/core';
import type { ReaderPage } from '@chord/ipc';
import { frameRadius } from '@chord/tokens';
import type { Session, WebContents, WebContentsView } from 'electron';
import { pageCall } from '../page-call';
import { platform } from '../platform';
import { EXTRACT_SCRIPT, READABLE_SCRIPT, READER_WORLD } from './scripts';
import type { CleanReply, CleanRequest } from './worker';

/** Asked this long after a page stops loading, and once more a while later for pages that fill their article in late. */
const CHECK_MS = 300;
const RECHECK_MS = 3000;
/** Readability takes a moment on a long page; a hung one gets no reader view rather than holding anything up. */
const EXTRACT_MS = 8000;
/** The most of the page's answer main takes (more than any article within sanitizeArticle's limits), and how long cleaning it may take. */
const MAX_EXTRACT_CHARS = 32 * 1024 * 1024;
const CLEAN_MS = 5000;
/** The view goes in front once its article is on its page, or after this long regardless. */
const READY_MS = 2000;
const IMAGE_MS = 20_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** What an `<img>` may show. SVG draws without its scripts there; served as a page, the CSP below stops them too. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/apng', 'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8';

export const READER_IMAGE_PATH = /^\/image\/([0-9a-f]{32})\/(\d{1,4})$/;

/** Where a followed link opens: in the tab, or a new tab behind or in front. */
export type ReaderLinkTarget = 'here' | 'background' | 'foreground';

export interface ReaderDeps {
  /** The cleaning worker's script (out/main/reader.js). */
  workerPath: string;
  dispatch(command: Command): void;
  /** The tab's own page (never Peek's or a mini window's, which aren't tabs). */
  page(nodeId: NodeId): WebContents | undefined;
  /** A view of reader view's page (chord://reader) on Chord's UI session. */
  createView(): WebContentsView;
  /** The view a tab shows changed (reader view opened or closed): windows showing the tab put the right one in their frame. */
  changed(nodeId: NodeId): void;
  /** Reader view's page gets what Chord's views get: shortcuts, a right-click menu, focus that follows split panes. */
  wire(contents: WebContents, nodeId: NodeId): void;
  /** A link in the article was followed. */
  follow(nodeId: NodeId, url: string, target: ReaderLinkTarget): void;
  /** No article came out of the page. */
  failed(nodeId: NodeId): void;
}

interface Reader {
  nodeId: NodeId;
  page: WebContents;
  /** The tab's session, where its images are fetched. */
  session: Session;
  view: WebContentsView;
  /** In image addresses: only this reader's images, and only while it's open. */
  key: string;
  /** The cleaned article, as JSON text for the view (core's ReaderArticle without its images). */
  article: string;
  /** Its images' addresses, by the numbers the article's images name. */
  images: string[];
  /** In the frame now (until its article is on its page, the tab's page stays there). */
  shown: boolean;
  /** Resolves `enter`'s wait for the view to be ready. */
  ready?: () => void;
}

const notFound = () => new Response(null, { status: 404 });

/** A body that fails once it passes `max` bytes, so a huge image is never read to its end. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('Image too large'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

export class Readers {
  private readonly open = new Map<NodeId, Reader>();
  /** Tabs whose article is being read: leaving now cancels it. */
  private readonly entering = new Set<NodeId>();
  private readonly checks = new Map<NodeId, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ReaderDeps) {}

  /** Watch a tab's page: whether it reads as an article, and when reader view has to close (it went elsewhere, or away). */
  attach(contents: WebContents, nodeId: NodeId): void {
    const check = (delay: number, again: boolean) => {
      clearTimeout(this.checks.get(nodeId));
      this.checks.set(
        nodeId,
        setTimeout(() => void this.check(nodeId, contents, again), delay),
      );
    };
    contents.on('did-stop-loading', () => check(CHECK_MS, true));
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.leaveFor(contents);
      this.setReadable(nodeId, contents, false);
    });
    // A page that changes its own address (an app moving to another story) has another article now.
    let place = placeKey(contents.getURL());
    contents.on('did-navigate', (_event, url) => {
      place = placeKey(url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || placeKey(url) === place) return;
      place = placeKey(url);
      this.leaveFor(contents);
      check(CHECK_MS, true);
    });
    contents.on('render-process-gone', () => this.leaveFor(contents));
    contents.once('destroyed', () => {
      // Unless the tab has a new page already (Chord's own page and the web's are different views).
      const now = this.deps.page(nodeId);
      if (!now || now === contents) {
        clearTimeout(this.checks.get(nodeId));
        this.checks.delete(nodeId);
      }
      this.leaveFor(contents);
    });
  }

  /** Ask now whether a tab's page reads as an article (Peek's page, just made a tab, was never asked). */
  detect(nodeId: NodeId): void {
    const contents = this.deps.page(nodeId);
    if (contents && !contents.isDestroyed() && !contents.isLoading()) void this.check(nodeId, contents, true);
  }

  private async check(nodeId: NodeId, contents: WebContents, again: boolean): Promise<void> {
    if (contents.isDestroyed() || this.deps.page(nodeId) !== contents) return;
    if (!isReaderUrl(contents.getURL())) return this.setReadable(nodeId, contents, false);
    const readable = (await pageCall(contents.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: READABLE_SCRIPT }]), false)) === true;
    this.setReadable(nodeId, contents, readable);
    if (!readable && again && !contents.isDestroyed()) {
      clearTimeout(this.checks.get(nodeId));
      this.checks.set(
        nodeId,
        setTimeout(() => void this.check(nodeId, contents, false), RECHECK_MS),
      );
    }
  }

  private setReadable(nodeId: NodeId, contents: WebContents, readable: boolean): void {
    if (!contents.isDestroyed() && this.deps.page(nodeId) === contents) this.deps.dispatch({ t: 'tab.live', nodeId, live: { readable } });
  }

  isOpen(nodeId: NodeId): boolean {
    return this.open.has(nodeId) || this.entering.has(nodeId);
  }

  /** Reader view's shortcut, button and menus: open it, or close it. */
  toggle(nodeId: NodeId): Promise<void> {
    if (this.isOpen(nodeId)) {
      this.leave(nodeId);
      return Promise.resolve();
    }
    return this.enter(nodeId);
  }

  /** Read the tab's article and show it in place of its page, once it's ready to be seen. */
  async enter(nodeId: NodeId): Promise<void> {
    const page = this.deps.page(nodeId);
    if (!page || page.isDestroyed() || this.isOpen(nodeId) || !isReaderUrl(page.getURL())) return;
    this.entering.add(nodeId);
    try {
      const url = page.getURL();
      const json: unknown = await pageCall(page.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: EXTRACT_SCRIPT }]), null, EXTRACT_MS);
      const clean = typeof json === 'string' && json.length <= MAX_EXTRACT_CHARS ? await this.clean({ json, url }) : null;
      // Closed, left or gone somewhere else while it was read.
      if (!this.entering.has(nodeId) || page.isDestroyed() || this.deps.page(nodeId) !== page || page.getURL() !== url) return;
      if (!clean) {
        this.deps.failed(nodeId);
        return;
      }
      const view = this.deps.createView();
      view.setBorderRadius(frameRadius[platform]);
      const reader: Reader = { nodeId, page, session: page.session, view, key: randomBytes(16).toString('hex'), article: clean.article, images: clean.images, shown: false };
      this.open.set(nodeId, reader);
      this.wire(reader);
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          reader.ready = undefined;
          done();
        };
        const timer = setTimeout(finish, READY_MS);
        reader.ready = finish;
      });
      if (this.open.get(nodeId) !== reader) return;
      reader.shown = true;
      this.deps.dispatch({ t: 'tab.live', nodeId, live: { reader: true } });
      this.deps.changed(nodeId);
    } finally {
      this.entering.delete(nodeId);
    }
  }

  /** The page's article, cleaned in a worker of its own, which ends with it. Null when there's no article, or it took too long. */
  private clean(request: CleanRequest): Promise<CleanReply> {
    const worker = new Worker(this.deps.workerPath, { name: 'Reader view' });
    worker.unref();
    return new Promise<CleanReply>((resolve) => {
      const timer = setTimeout(() => resolve(null), CLEAN_MS);
      const done = (reply: CleanReply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      worker.once('message', done);
      worker.once('error', () => done(null));
      worker.once('exit', () => done(null));
      worker.postMessage(request);
    }).finally(() => void worker.terminate());
  }

  /** Close the tab's reader view: its page comes back. */
  leave(nodeId: NodeId): void {
    this.entering.delete(nodeId);
    const reader = this.open.get(nodeId);
    if (!reader) return;
    this.open.delete(nodeId);
    reader.ready?.();
    if (reader.shown) {
      this.deps.dispatch({ t: 'tab.live', nodeId, live: { reader: false } });
      this.deps.changed(nodeId);
    }
    if (!reader.view.webContents.isDestroyed()) reader.view.webContents.close();
  }

  /** The page behind a reader view went somewhere else, crashed or closed: so does its reader view. */
  private leaveFor(page: WebContents): void {
    for (const reader of this.open.values()) if (reader.page === page) this.leave(reader.nodeId);
  }

  private wire(reader: Reader): void {
    const contents = reader.view.webContents;
    this.deps.wire(contents, reader.nodeId);
    // The view itself never goes anywhere (its links to places in the article stay on the page): a link
    // is followed from the tab, as a click there would be. Chord's views are already locked to their own
    // pages in will-frame-navigate (security.ts), which then never gets as far as will-navigate.
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) return;
      event.preventDefault();
      if (isReaderUrl(event.url)) this.deps.follow(reader.nodeId, event.url, 'here');
    });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (isReaderUrl(url)) this.deps.follow(reader.nodeId, url, disposition === 'background-tab' ? 'background' : 'foreground');
      return { action: 'deny' };
    });
  }

  /** The reader view a tab shows in its frame, while it has one. */
  viewFor(nodeId: NodeId): WebContentsView | undefined {
    const reader = this.open.get(nodeId);
    return reader?.shown ? reader.view : undefined;
  }

  private readerOf(contents: WebContents | null | undefined): Reader | undefined {
    if (!contents) return undefined;
    for (const reader of this.open.values()) if (reader.view.webContents === contents) return reader;
    return undefined;
  }

  /** The page behind this reader view (undefined when it isn't one). */
  pageOf(contents: WebContents | null | undefined): WebContents | undefined {
    return this.readerOf(contents)?.page;
  }

  /** The tab this reader view belongs to. */
  nodeOf(contents: WebContents): NodeId | undefined {
    return this.readerOf(contents)?.nodeId;
  }

  /** Every open reader view's page. */
  *contents(): IterableIterator<WebContents> {
    for (const reader of this.open.values()) if (!reader.view.webContents.isDestroyed()) yield reader.view.webContents;
  }

  /** What a reader view shows: its own tab's article (never another's), with the address its images load from. */
  pageFor(contents: WebContents): ReaderPage | null {
    const reader = this.readerOf(contents);
    return reader ? { article: reader.article, imageBase: `chord://reader/image/${reader.key}/` } : null;
  }

  /** The reader view's article is on its page: it can go in front. */
  ready(contents: WebContents): void {
    this.readerOf(contents)?.ready?.();
  }

  /** Esc, or its close button. */
  close(contents: WebContents): void {
    const reader = this.readerOf(contents);
    if (reader) this.leave(reader.nodeId);
  }

  /**
   * `chord://reader/image/<key>/<n>`: the nth image of the open reader view
   * with that key, fetched through its tab's session (cookies and cache as
   * the page has them). Only images, only of a set size, and never anything
   * the article didn't name.
   */
  async image(url: string): Promise<Response> {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return notFound();
    }
    const [, key, index] = READER_IMAGE_PATH.exec(path) ?? [];
    const reader = key ? [...this.open.values()].find((r) => r.key === key) : undefined;
    const src = reader?.images[Number(index)];
    if (!reader || !src) return notFound();
    try {
      const response = await reader.session.fetch(src, { credentials: 'include', headers: { accept: IMAGE_ACCEPT }, signal: AbortSignal.timeout(IMAGE_MS) });
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || !response.body || !IMAGE_TYPES.has(type) || length > MAX_IMAGE_BYTES) {
        void response.body?.cancel().catch(() => {});
        return notFound();
      }
      return new Response(capped(response.body, MAX_IMAGE_BYTES), {
        status: 200,
        headers: {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // Opened as a page of its own (an SVG), it runs nothing and can't reach Chord's.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    } catch {
      return notFound();
    }
  }
}
