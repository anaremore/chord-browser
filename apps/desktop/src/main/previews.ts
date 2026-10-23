/**
 * Hover previews for pinned tabs and folders (DESIGN.md §7.6). Main keeps a
 * small picture of each pinned tab's page (CaptureStore), taken while the tab
 * is on screen, and answers the shell's "the pointer rests on this row" with a
 * card for the window's preview view to draw.
 *
 * Pictures are taken only of a view that's attached to a window: Electron's
 * capturePage on a detached view never settles (checked on Electron 45).
 * Asked just before the view is swapped out, it still returns that frame, so
 * leaving a tab is the main moment to picture it.
 */
import { children, openedAgo, type NodeId, type State, type TabNode } from '@chord/core';
import type { PreviewCard, PreviewRow, PreviewTarget } from '@chord/ipc';
import type { WebContents } from 'electron';
import { CaptureStore } from './captures';
import { send } from './ipc';
import type { AppWindow } from './window';

/** The thumbnail is 280 × 175 (DESIGN.md §7.6), kept at 2× for sharp displays. */
const THUMB_WIDTH = 560;
const THUMB_ASPECT = 280 / 175;
const JPEG_QUALITY = 72;
/** Let a newly shown page settle before picturing it; a page that just loaded, a little less. */
const AFTER_SHOWN_MS = 1200;
const AFTER_LOAD_MS = 600;
/** At most one picture per tab this often, except when you leave it. */
const MIN_INTERVAL_MS = 5000;
const LEAVE_INTERVAL_MS = 1000;
/** A capture that hasn't answered by now is dropped (it shouldn't happen, but it must never hang). */
const CAPTURE_TIMEOUT_MS = 3000;
const FOLDER_ROWS = 6;

export interface PreviewDeps {
  state(): State;
  /** The tab's page, if it's loaded. */
  contentsOf(nodeId: NodeId): WebContents | undefined;
  /** Whether a window shows this page in its frame right now. */
  onScreen(contents: WebContents): boolean;
  /** Whether previews glide between rows (Settings → Motion → Animate the sidebar, and reduced motion). */
  animate(): boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export class Previews {
  private readonly store: CaptureStore;
  private readonly timers = new Map<NodeId, ReturnType<typeof setTimeout>>();
  private readonly lastAt = new Map<NodeId, number>();
  /** Each window's latest hover: an older one finishing late is ignored. */
  private readonly hovers = new WeakMap<AppWindow, number>();

  constructor(
    dir: string,
    private readonly deps: PreviewDeps,
  ) {
    this.store = new CaptureStore(dir);
  }

  /** Index the pictures on disk, dropping those of tabs that aren't pinned any more. */
  open(): Promise<void> {
    return this.store.open(this.keep());
  }

  /** Pinned tabs that may be pictured: none at all with previews off, and never a private window's. */
  private keep(): Set<string> {
    const state = this.deps.state();
    const ids = new Set<string>();
    if (!state.settings.pagePreviews) return ids;
    for (const node of Object.values(state.nodes)) if (this.eligible(state, node.id)) ids.add(node.id);
    return ids;
  }

  private eligible(state: State, nodeId: NodeId): boolean {
    if (!state.settings.pagePreviews) return false;
    const node = state.nodes[nodeId];
    if (node?.kind !== 'tab' || node.section !== 'pinned') return false;
    if (state.chords[node.chordId]?.private) return false;
    return /^(https?|file):/i.test(node.url);
  }

  /** A tab came on screen: picture it once it has settled. */
  shown(nodeId: NodeId): void {
    this.schedule(nodeId, AFTER_SHOWN_MS);
  }

  /** Its page finished loading: picture it if it's on screen. */
  loaded(nodeId: NodeId): void {
    this.schedule(nodeId, AFTER_LOAD_MS);
  }

  /** You're switching away: picture it now, while its view is still attached. */
  leaving(nodeId: NodeId, contents: WebContents): void {
    const timer = this.timers.get(nodeId);
    if (timer) clearTimeout(timer);
    this.timers.delete(nodeId);
    if (!this.eligible(this.deps.state(), nodeId) || Date.now() - (this.lastAt.get(nodeId) ?? 0) < LEAVE_INTERVAL_MS) return;
    void this.capture(nodeId, contents);
  }

  private schedule(nodeId: NodeId, delay: number): void {
    if (!this.eligible(this.deps.state(), nodeId)) return;
    clearTimeout(this.timers.get(nodeId));
    this.timers.set(
      nodeId,
      setTimeout(() => {
        this.timers.delete(nodeId);
        const contents = this.deps.contentsOf(nodeId);
        if (!contents || !this.deps.onScreen(contents)) return;
        if (Date.now() - (this.lastAt.get(nodeId) ?? 0) < MIN_INTERVAL_MS) return;
        void this.capture(nodeId, contents);
      }, delay),
    );
  }

  private async capture(nodeId: NodeId, contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return;
    const live = this.deps.state().live[nodeId];
    // The frame shows an error or a crash instead of this page: nothing worth keeping.
    if (live?.error || live?.crashed) return;
    this.lastAt.set(nodeId, Date.now());
    const image = await withTimeout(contents.capturePage(), CAPTURE_TIMEOUT_MS);
    if (!image || image.isEmpty() || !this.eligible(this.deps.state(), nodeId)) return;
    // The top of the page, at the card's shape, scaled down.
    const { width, height } = image.getSize();
    if (width < 2 || height < 2) return;
    const top = image.crop({ x: 0, y: 0, width, height: Math.min(height, Math.round(width / THUMB_ASPECT)) });
    const small = top.resize({ width: Math.min(THUMB_WIDTH, width), quality: 'good' });
    await this.store.put(nodeId, small.toJPEG(JPEG_QUALITY));
  }

  /** The pointer rests on a row (or left it): show its card in the window's preview view, or hide it. */
  async hover(w: AppWindow, target: PreviewTarget): Promise<void> {
    const seq = (this.hovers.get(w) ?? 0) + 1;
    this.hovers.set(w, seq);
    const card = target ? await this.card(target.nodeId) : null;
    if (this.hovers.get(w) !== seq || w.window.isDestroyed()) return;
    if (!target || !card) {
      w.hidePreview();
      return;
    }
    w.anchorPreview({ top: target.top, bottom: target.bottom }, this.deps.animate());
    send(w.preview.webContents, 'preview:card', card);
  }

  private async card(nodeId: NodeId): Promise<PreviewCard | null> {
    const state = this.deps.state();
    if (!state.settings.pagePreviews) return null;
    const node = state.nodes[nodeId];
    const chord = node ? state.chords[node.chordId] : undefined;
    if (!node || !chord || chord.private || node.section !== 'pinned') return null;
    const look = { theme: chord.theme, interface: state.settings.interface, animate: this.deps.animate() };
    if (node.kind === 'tab') {
      const picture = await this.store.read(nodeId);
      return {
        ...look,
        kind: 'tab',
        id: node.id,
        title: node.customTitle || node.title,
        url: node.url,
        favicon: node.favicon,
        opened: openedAgo(node.lastActiveAt, Date.now()),
        thumbnail: picture ? `data:image/jpeg;base64,${picture.toString('base64')}` : null,
      };
    }
    const tabs = folderTabs(state, node.chordId, node.id);
    return {
      ...look,
      kind: 'folder',
      id: node.id,
      title: node.title,
      rows: tabs.slice(0, FOLDER_ROWS).map((t): PreviewRow => ({ title: t.customTitle || t.title, url: t.url, favicon: t.favicon })),
      more: Math.max(0, tabs.length - FOLDER_ROWS),
    };
  }

  /** After a change: pictures of tabs that were closed, archived, unpinned or made private go (or all of them, with previews off). */
  sync(): void {
    const keep = this.keep();
    for (const id of this.store.ids) if (!keep.has(id)) void this.store.remove(id);
    for (const [id, timer] of this.timers) {
      if (keep.has(id)) continue;
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /** For tests and diagnostics: the tabs with a picture. */
  get pictured(): string[] {
    return this.store.ids;
  }
}

/** A folder's tabs in sidebar order, nested folders flattened. */
function folderTabs(state: State, chordId: string, folderId: string): TabNode[] {
  const out: TabNode[] = [];
  for (const child of children(state, chordId, 'pinned', folderId)) {
    if (child.kind === 'tab') out.push(child);
    else out.push(...folderTabs(state, chordId, child.id));
  }
  return out;
}
