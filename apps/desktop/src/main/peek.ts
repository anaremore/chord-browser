/**
 * Peek (DESIGN.md §7.9, §8.5): a link you follow from a pinned tab to
 * another site opens over the page in a card instead of replacing the
 * pinned page. It has its own back stack. Esc or a click outside closes it;
 * "Open in Today" (⌘↵ / Ctrl+Enter) keeps it as a tab, page and history intact.
 */
import { hostOf, isPrivateChord, uuidv7, type ChordId, type Command, type LiveTab, type NodeId, type State, type WindowId } from '@chord/core';
import { springCurve, springs } from '@chord/tokens';
import type { Session, WebContents } from 'electron';
import { uiScale } from './platform';
import type { TabManager } from './tabs';
import type { AppWindow } from './window';

export interface PeekDeps {
  state(): State;
  dispatch(command: Command): void;
  tabs: TabManager;
  /** The session of a chord's sign-ins: Peek's page uses its pinned tab's. */
  sessionFor(chordId: ChordId): Session;
  /** Whether Peek animates (Settings → Motion, and the OS's reduced motion). */
  animates(): boolean;
  /** Peek's page became a tab in this window: give it what tabs get once they're shown. */
  adopted(contents: WebContents, nodeId: NodeId, w: AppWindow): void;
  /** Peek opened or closed: the find bar follows the page that's in front. */
  changed(): void;
}

interface OpenPeek {
  nodeId: NodeId;
  /** The pinned tab's chord: "Open in Today" puts the page there. */
  chordId: ChordId;
}

/** What a page's back/forward and loading look like, for the tab it becomes. */
export function liveOf(contents: WebContents): Partial<LiveTab> {
  if (contents.isDestroyed()) return {};
  return { loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
}

export class Peeks {
  private readonly open = new Map<WindowId, OpenPeek>();

  constructor(private readonly deps: PeekDeps) {}

  /** Open `url` in Peek over `w`, which shows the pinned tab `openerNodeId`. `point` is the click, in the page. */
  show(w: AppWindow, openerNodeId: NodeId, url: string, point: { x: number; y: number } | null): void {
    const state = this.deps.state();
    const opener = state.nodes[openerNodeId];
    if (opener?.kind !== 'tab') return;
    this.close(w);
    const nodeId = uuidv7();
    const view = this.deps.tabs.createFloating(nodeId, {
      session: this.deps.sessionFor(opener.chordId),
      url,
      private: isPrivateChord(state, opener.chordId),
    });
    this.open.set(w.id, { nodeId, chordId: opener.chordId });
    const contents = view.webContents;
    // Esc closes, ⌘↵ / Ctrl+Enter keeps it: before the page sees them, as DESIGN.md §7.9's header says.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || this.open.get(w.id)?.nodeId !== nodeId) return;
      const command = process.platform === 'darwin' ? input.meta : input.control;
      if (input.key === 'Escape' && !input.meta && !input.control && !input.alt && !input.shift) {
        event.preventDefault();
        this.close(w);
      } else if (input.key === 'Enter' && command) {
        event.preventDefault();
        this.expand(w);
      }
    });
    const follow = () => {
      if (contents.isDestroyed() || this.open.get(w.id)?.nodeId !== nodeId) return;
      const address = contents.getURL();
      w.updatePeek({ url: address, host: hostOf(address) ?? '', title: contents.getTitle() });
    };
    contents.on('did-navigate', follow);
    contents.on('did-navigate-in-page', follow);
    contents.on('page-title-updated', follow);
    // The card grows from the click: the page's point, in UI units (the overlay's CSS pixels), as the card is.
    const page = this.deps.tabs.get(openerNodeId)?.getBounds();
    const s = uiScale();
    const origin = point && page ? { x: (page.x + point.x) / s, y: (page.y + point.y) / s } : null;
    const delay = this.deps.animates() ? springCurve(springs.overlay).durationMs : 0;
    w.openPeek(view, { url, host: hostOf(url) ?? '', title: '', origin }, delay);
    this.deps.changed();
  }

  /** Peek's page in this window, while one is open. */
  contents(w: AppWindow): WebContents | null {
    return this.open.has(w.id) ? w.peekContents : null;
  }

  isOpen(w: AppWindow): boolean {
    return this.open.has(w.id);
  }

  /** The window whose Peek shows this page (by the id it would have as a tab). */
  windowOf(nodeId: NodeId): WindowId | undefined {
    for (const [windowId, peek] of this.open) if (peek.nodeId === nodeId) return windowId;
    return undefined;
  }

  /** Close Peek: its page goes. */
  close(w: AppWindow): void {
    const peek = this.open.get(w.id);
    if (!peek) return;
    this.open.delete(w.id);
    w.closePeek();
    this.deps.tabs.closeFloating(peek.nodeId);
    this.deps.changed();
  }

  /** The window closed: its Peek goes with it. */
  forget(windowId: WindowId): void {
    const peek = this.open.get(windowId);
    this.open.delete(windowId);
    if (peek) this.deps.tabs.closeFloating(peek.nodeId);
  }

  /** "Open in Today": the page grows into the frame and becomes the top tab of the pinned tab's chord. */
  expand(w: AppWindow): void {
    const peek = this.open.get(w.id);
    if (!peek) return;
    this.open.delete(w.id);
    w.growPeekToFrame(this.deps.animates(), () => {
      w.closePeek();
      const view = this.deps.tabs.adopt(peek.nodeId);
      if (!view) return;
      const contents = view.webContents;
      this.deps.dispatch({
        t: 'tab.adopt',
        windowId: w.id,
        nodeId: peek.nodeId,
        chordId: peek.chordId,
        url: contents.getURL(),
        title: contents.getTitle(),
        live: liveOf(contents),
      });
      this.deps.adopted(contents, peek.nodeId, w);
      this.deps.changed();
    });
  }
}
