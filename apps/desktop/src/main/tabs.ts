/**
 * TabManager (ARCHITECTURE.md §9): one WebContentsView per live tab, created
 * lazily, wired to report navigation back into the Store. A tab can also
 * sleep: its page closes, and its back/forward history (scroll position
 * included) comes back when it's shown again.
 */
import { countShows, isCrossSite, isInternalUrl, isNeverReadable, pageBadge, placeKey, usableDataIcon, nodeOf, type Command, type LiveTab, type NodeId, type State, type TabCount, type TabNode, type WindowId } from '@chord/core';
import { isAgentInput } from './control/input';
import { noteUserTab, userTabCatching, userTabCopied } from './control/user-watch';
import type { NavState } from '@chord/data';
import { frameRadius } from '@chord/tokens';
import { WebContentsView, type BrowserWindow, type HandlerDetails, type Session, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import { windowIcon } from './app-icon';
import { trimNavState } from './nav';
import { platform } from './platform';
import { pageCall } from './page-call';
import { failHeld } from './control/sends';
import { pickFavicon } from './favicon-pick';
import { pageOf } from './view-page';
import { iconOn, TabIconIndex } from './site-icons';
import { holdFilePickers, bypassServiceWorkers, firstLoadPending, holdFailed, setFirstLoadPending } from './agents/pickers';
import { agentGuardUp } from './control/page';
import { heldFromFrame } from './agents/held';

const MAX_FAVICON_BYTES = 64 * 1024;
/** Sites whose icon each session keeps (TabManager.siteIcons). */
const SITE_ICONS = 256;

/** A web page's site, for its icon: its origin. Null for anything else (Chord's pages, about:, files). */
function siteOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const MAX_CRASH_RELOADS = 2;
/** A navigation this soon after a click (or Enter) in the page counts as you following a link, not the page redirecting itself. */
const LINK_GESTURE_MS = 1500;

export interface TabManagerDeps {
  state(): State;
  dispatch(command: Command): void;
  sessionFor(node: TabNode): Session;
  /**
   * While a session's proxy is being set, what its pages wait for before they load (ARCHITECTURE.md §9,
   * Proxies): a page never starts the old way. Null, almost always, when it's in place.
   */
  proxyReady(session: Session): Promise<void> | null;
  /** A view for one of Chord's own pages (`chord://archive`), on Chord's UI session with its own preload. */
  createInternalView(url: string): WebContentsView;
  /** The window a tab belongs to, for opening links from it. */
  windowFor(nodeId: NodeId): WindowId | undefined;
  /** Hook for keyboard shortcuts and other per-contents wiring. */
  onContentsCreated(contents: WebContents, nodeId: NodeId): void;
  /** A page was visited (or its title arrived): history keeps it. */
  onVisit(url: string, title: string, nodeId: NodeId): void;
  onTitle(url: string, title: string, nodeId: NodeId): void;
  /** A page opened a popup window (sign-in, payment): wire its context menu. */
  onPopupCreated(contents: WebContents, openerNodeId: NodeId): void;
  /** A link in a pinned tab leads to another site: it opens in Peek (DESIGN.md §8.5), from `origin` (in the page) if known. */
  onPeek(openerNodeId: NodeId, url: string, origin: { x: number; y: number } | null): void;
  /**
   * An outside agent's tab (S18): its page gets no dialogs (Electron's `disableDialogs`, so none is ever a native
   * modal and no read hangs on one), its preload knows it (AGENT_TAB_ARG: it holds them, and file pickers), and it
   * opens no popups or tabs.
   */
  agentTab?(nodeId: NodeId): boolean;
  /** Something an agent's tab tried that Chord refused (a popup or a new tab), for the agent's next result. */
  onAgentRefused?(nodeId: NodeId, what: AgentHeld, detail: string): void;
  /** A navigation asked of a tab waits for its session (Safe Browsing's guard: Neon's NSF1b, round 1 of #323). */
  navigationQueued?(contents: WebContents): void;
}

/** What an agent's tab held or refused: a page dialog, a file picker, a popup or new tab, a download. */
export type AgentHeld = 'dialog' | 'file' | 'popup' | 'download' | 'signin';

/** What an agent's tab's preload looks for in its arguments (preload/page.ts has the same). */
const AGENT_TAB_ARG = '--chord-agent-tab';

/** A page that isn't a tab yet: a Peek's or a mini window's (DESIGN.md §7.9). */
interface FloatingPage {
  view: WebContentsView;
  /** Its first page's address: what Reload loads while it has never loaded (Opus's SF1, round 1 of #323). */
  url: string;
  /** A private window's Peek: its visits never reach history. */
  private: boolean;
}

export class TabManager {
  /** Agent tabs loading their blank first page (createView): its navigation is never the tab's. */
  private readonly priming = new WeakSet<WebContents>();
  private readonly views = new Map<NodeId, WebContentsView>();
  private readonly crashReloads = new Map<NodeId, number>();
  /** Tabs playing audio or video right now (muted video counts). */
  private readonly playing = new Set<NodeId>();
  /** History to load instead of the tab's address the next time its view is made: it slept, or came back from the archive. */
  private readonly pendingHistory = new Map<NodeId, NavState>();
  /**
   * The history a tab's page is restoring, from the moment its view is made until its page commits: what `history`
   * says meanwhile, so a page still waiting for its session (held for its proxy, #331) never has its saved history
   * written over with an empty one (Neon's SF1-r2).
   */
  private readonly restoring = new Map<NodeId, { contents: WebContents; nav: NavState }>();
  /** Tabs showing one of Chord's own pages, on Chord's UI session. */
  private readonly internal = new Set<NodeId>();
  /** Pages that aren't tabs yet, by the id they'll have as one. */
  private readonly floating = new Map<NodeId, FloatingPage>();
  /** The count each tab's page gave itself (the Badging API), shown or not: Settings can hide it, then show it again. */
  private readonly badges = new Map<NodeId, Exclude<TabCount, null>>();
  /** The count each service worker gave its site, by its scope, per session: its tabs show it when their page has none. */
  private readonly scopeBadges = new WeakMap<Session, Map<string, Exclude<TabCount, null>>>();
  /**
   * Each site's icon, by origin, per session (a private window's go with it):
   * a tab arriving on a site Chord has an icon for shows it at once, and a
   * page that never names its icon, or whose icon can't be fetched, keeps it.
   */
  private readonly siteIcons = new WeakMap<Session, Map<string, string>>();
  /** Tabs with an icon, by site, kept up to date as tabs change: no pass over every tab to find one. */
  private readonly tabIcons: TabIconIndex;

  /** Each page's newest load waiting for its session (whenProxied): an older one's wait ends without loading. */
  private readonly loadTurns = new WeakMap<WebContents, { overtaken?: () => void; restore?: boolean }>();
  /** Pages whose wait for their session marked their first load pending (whenProxied): unmarked as it loads. */
  private readonly waitMarked = new WeakSet<WebContents>();
  /** Pages with a load waiting for their session now (whenProxied): what Stop drops (stopWaiting). */
  private readonly waiting = new WeakSet<WebContents>();

  constructor(private readonly deps: TabManagerDeps) {
    this.tabIcons = new TabIconIndex(() => deps.state());
  }

  /**
   * Load in `contents` once its session is ready (its proxy in place, its chord's ad-blocking rules on, #189): at once
   * when it is. Only the newest load asked for here runs: one asked for during the wait (a navigation, an upload) is
   * never landed on by an older one, whose `overtaken` is called. The session is asked again before loading (a wait
   * can end while another starts). Meanwhile the tab shows loading, and an agent's tool call waits for the page
   * (agents/pickers.ts' firstLoadPending, which pageLoaded waits on) rather than calling it unloadable. `load` returning
   * false says it didn't load after all (what it was for had gone by then): the loading this wait put on comes off
   * (round 1 of #333).
   */
  whenProxied(contents: WebContents, load: () => boolean | void, overtaken?: () => void, restore = false): () => void {
    this.loadTurns.get(contents)?.overtaken?.();
    // `restore`: this load brings a tab's saved history back (what your Stop leaves waiting: userStop).
    const turn: { overtaken?: () => void; restore?: boolean } = { ...(overtaken ? { overtaken } : {}), ...(restore ? { restore } : {}) };
    this.loadTurns.set(contents, turn);
    // `failed`: a wait that rejected (#299): it's over. Asked again, a source answering that same wait isn't waited on.
    const go = (failed?: Promise<void>) => {
      if (this.loadTurns.get(contents) !== turn) return;
      if (contents.isDestroyed()) {
        if (this.waitMarked.delete(contents)) setFirstLoadPending(contents, false);
        // Gone: its load never runs, and whoever waits on it hears so, never left hanging (Neon's NB1, round 2 of #333).
        return turn.overtaken?.();
      }
      const asked = this.deps.proxyReady(contents.session);
      const pending = asked === failed ? null : asked;
      if (pending) {
        this.waiting.add(contents);
        if (!firstLoadPending(contents)) {
          this.waitMarked.add(contents);
          setFirstLoadPending(contents, true);
          const nodeId = this.nodeFor(contents);
          if (nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: true, waitingForSession: true } });
        }
        pending.then(
          () => go(),
          () => go(pending),
        );
        return;
      }
      this.waiting.delete(contents);
      // A wait put the tab's loading on (this turn's, or one it took over from: Neon's NSF2, round 2 of #333); its
      // spinner over its icon comes off as it loads (Carbon's SF4 on #331).
      const marked = this.waitMarked.delete(contents);
      const nodeId = marked ? this.nodeFor(contents) : undefined;
      if (marked) {
        setFirstLoadPending(contents, false);
        if (nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { waitingForSession: false } });
      }
      if (load() === false && nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: false } });
    };
    go();
    // Its drop: while it still waits, it's no longer the tab's (never run, the tab's loading off), as Stop does but
    // without calling its own `overtaken` (Fable's FN3 on #333: a tool's load it gave up on).
    return () => {
      if (this.loadTurns.get(contents) !== turn || !this.waiting.has(contents)) return;
      this.waiting.delete(contents);
      this.loadTurns.set(contents, {});
      if (this.waitMarked.delete(contents)) {
        setFirstLoadPending(contents, false);
        const nodeId = this.nodeFor(contents);
        if (nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: false, waitingForSession: false } });
      }
    };
  }

  /**
   * A load asked for over a page (not its first): through the gate (whenProxied), and when it waits, Safe Browsing hears
   * of it as of a navigation, so a late answer about the page before can't stop or drop it (#323's NSF1b; round 1 of
   * #333: every one, the agent's and extensions' too).
   */
  queueLoad(contents: WebContents, load: () => boolean | void, overtaken?: () => void): () => void {
    const drop = this.whenProxied(contents, load, overtaken);
    if (this.waiting.has(contents)) this.deps.navigationQueued?.(contents);
    return drop;
  }

  /** `url` in the page, as queueLoad does. */
  load(contents: WebContents, url: string): void {
    this.queueLoad(contents, () => void contents.loadURL(url).catch(() => {}));
  }

  /**
   * Your Stop on a page whose load is still waiting for its session (#277), or on an agent tab still being primed for
   * its first page (round 1 of #282): that load is dropped (as one asked for over it is; an agent tab's first page is
   * overtaken, its hold failed), and the tab stops showing loading. False when no load was waiting and none is being
   * primed: the page's own Stop is all there is, and a first page already loading keeps its hold.
   */
  stopWaiting(contents: WebContents): boolean {
    if (!this.waiting.has(contents) && !this.priming.has(contents)) return false;
    this.waiting.delete(contents);
    this.loadTurns.get(contents)?.overtaken?.();
    this.loadTurns.set(contents, {});
    if (this.waitMarked.delete(contents)) setFirstLoadPending(contents, false);
    const nodeId = this.nodeFor(contents);
    if (nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: false, waitingForSession: false } });
    return true;
  }

  /**
   * Your Stop (the toolbar's, the page's menu, Esc). A tab whose saved history is waiting to come back (held for its
   * proxy, #331, or asleep and woken while its session waits) only stops showing loading: that restore was never your
   * load to drop, and dropping it would leave the tab blank until you reloaded (Carbon's B3); it comes back once the
   * session is ready. Any other load waiting is dropped (stopWaiting, #277).
   */
  userStop(contents: WebContents): void {
    const nodeId = this.nodeFor(contents);
    if (nodeId && this.waiting.has(contents) && this.restoring.get(nodeId)?.contents === contents && this.loadTurns.get(contents)?.restore) {
      this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: false, waitingForSession: false } });
      return;
    }
    this.stopWaiting(contents);
  }

  /**
   * Your Reload (round 1 of #282): a page that never loaded (stopped while it waited for its session) has nothing to
   * reload, so its address loads, as a navigation; any other page reloads. A tab's, and a mini window's or a Peek's
   * (Opus's SF1, round 1 of #323: from its window's Reload, or the page's menu).
   */
  reload(contents: WebContents, options: { ignoreCache?: boolean } = {}): void {
    // A page already gone (its menu can outlive it: Neon's SF3, round 1 of #292).
    if (contents.isDestroyed()) return;
    const nodeId = this.nodeFor(contents);
    const node = nodeId ? nodeOf(this.deps.state(), nodeId) : undefined;
    const floatingId = nodeId ? undefined : this.floatingFor(contents);
    const url = node?.kind === 'tab' ? node.url : floatingId ? this.floating.get(floatingId)?.url : undefined;
    const history = contents.navigationHistory;
    // An agent tab stopped while primed has only its blank page, which is never the tab's (#287); a page made again
    // while its session is held (#331) may have only an empty first entry, never loaded either.
    const first = history.length() === 1 ? history.getEntryAtIndex(0)?.url : undefined;
    const never = history.length() === 0 || first === 'about:blank' || first === '';
    if (url !== undefined && never) {
      // Its own first load still on its way (waiting for its session, an agent tab's hold arming or its blank page
      // primed, or its page asked for and not come): left alone, it loads the address anyway, and an agent tab keeps
      // its hold. Only with nothing in flight (after Stop) does the address load again (Opus's N1, Neon's B1).
      if (this.waiting.has(contents) || this.priming.has(contents) || firstLoadPending(contents)) return;
      // A tab whose saved history never came back (its restore dropped while it waited): that history, never a
      // navigation, which would leave it with only this page (Carbon's B3 on #331).
      const restoring = nodeId ? this.restoring.get(nodeId) : undefined;
      if (restoring?.contents === contents) {
        this.whenProxied(contents, () => this.restoreInto(contents, restoring.nav, url), undefined, true);
        return;
      }
      if (nodeId) return this.navigate(nodeId, url);
      // Load failures show in the page itself, as they would in a tab.
      return this.load(contents, url);
    }
    // Once its session is ready, like any load (Neon's B2): never over the old connection, nor before its rules are on.
    // A load waiting already is overtaken by this one. Hard Reload too (round 1 of #292, SF2).
    this.queueLoad(contents, () => (options.ignoreCache ? contents.reloadIgnoringCache() : contents.reload()));
  }

  /**
   * A page loaded at `url` and then reloaded, once its session is ready (#326): a PDF citation's page, which Chromium's
   * viewer reads from `#page=` only as it loads.
   */
  reopenAt(contents: WebContents, url: string): void {
    if (contents.isDestroyed()) return;
    this.queueLoad(contents, () => {
      const turn = this.loadTurns.get(contents);
      contents.loadURL(url).then(
        // Only after a load that went (not one stopped, or overtaken by yours or another citation's), and only while it's
        // still this turn's; through the gate again, as the session may have changed meanwhile (Neon's B1, round 1 of
        // #333).
        () => {
          if (!contents.isDestroyed() && this.loadTurns.get(contents) === turn) this.queueLoad(contents, () => contents.reload());
        },
        () => {},
      );
    });
  }

  /**
   * Your Back or Forward (#287): a load still waiting for its session is dropped first (stopWaiting), so it never lands
   * over the page you went to.
   */
  go(contents: WebContents, way: 'back' | 'forward'): void {
    if (contents.isDestroyed()) return;
    const can = () => (way === 'back' ? contents.navigationHistory.canGoBack() : contents.navigationHistory.canGoForward());
    // Nowhere to go: nothing, and a load waiting isn't dropped for it (round 2 of #292).
    if (!can()) return;
    // Once its session is ready (Neon's B2, round 1 of #292), and only if there's still somewhere to go then; if not,
    // the tab stops showing loading, put on while it waited (round 2 of #292).
    // Waiting for the session: Safe Browsing hears of it, as of a navigation, so a late answer can't drop it (Neon's
    // round 2 of #323): queueLoad.
    this.queueLoad(contents, () => {
      if (!can()) {
        const nodeId = this.nodeFor(contents);
        if (nodeId) this.deps.dispatch({ t: 'tab.live', nodeId, live: { loading: false } });
        return;
      }
      if (way === 'back') contents.navigationHistory.goBack();
      else contents.navigationHistory.goForward();
    });
  }

  /** Keep a site's icon, the newest first out of `SITE_ICONS` (a few KB each). */
  private rememberIcon(session: Session, url: string, icon: string): void {
    const site = siteOf(url);
    if (!site) return;
    let icons = this.siteIcons.get(session);
    if (!icons) this.siteIcons.set(session, (icons = new Map()));
    icons.delete(site);
    icons.set(site, icon);
    if (icons.size > SITE_ICONS) icons.delete(icons.keys().next().value!);
  }

  /** Read every tab into the icon index (after launch), a slice of buckets a turn, rather than on the first navigation that needs it. */
  warmIcons(): void {
    this.tabIcons.catchUpInSlices();
  }

  /** A site's icon if Chord has one: kept from earlier, or on another of this session's tabs there. */
  private knownIcon(session: Session, site: string): string | null {
    const kept = this.siteIcons.get(session)?.get(site);
    if (kept) return kept;
    // Only a tab that's still the state's own node, in this session (a closed private window's never: site-icons.ts).
    const node = iconOn(this.tabIcons, this.deps.state(), site, (n) => this.deps.sessionFor(n) === session);
    if (!node?.favicon) return null;
    this.rememberIcon(session, node.url, node.favicon);
    return node.favicon;
  }

  get(nodeId: NodeId): WebContentsView | undefined {
    return this.views.get(nodeId);
  }

  /** Every tab that has a page, and its contents. */
  *entries(): IterableIterator<[NodeId, WebContents]> {
    for (const [id, view] of this.views) {
      const contents = pageOf(view);
      if (contents) yield [id, contents];
    }
  }

  nodeFor(contents: WebContents): NodeId | undefined {
    for (const [id, view] of this.views) if (view.webContents === contents) return id;
    return undefined;
  }

  /** The id of a page that isn't a tab (yet): Peek's, or a mini window's. */
  floatingNodeFor(contents: WebContents): NodeId | undefined {
    for (const [id, page] of this.floating) if (page.view.webContents === contents) return id;
    return undefined;
  }

  /** Tabs with a page loaded. */
  loaded(): NodeId[] {
    return [...this.views.keys()];
  }

  isPlaying(nodeId: NodeId): boolean {
    return this.playing.has(nodeId);
  }

  /** Whether the tab's page shows a video in picture-in-picture. */
  async inPictureInPicture(nodeId: NodeId): Promise<boolean> {
    const contents = pageOf(this.views.get(nodeId));
    if (!contents || this.internal.has(nodeId)) return false;
    // An isolated world shares the page's DOM but not its scripts, so a page can't fake this. A hung page
    // answers no (it can go to sleep), rather than holding up every tab after it.
    return Boolean(await pageCall(contents.executeJavaScriptInIsolatedWorld(999, [{ code: 'Boolean(document.pictureInPictureElement)' }]), false));
  }

  /** The tab's back/forward history as it is now (or as it fell asleep), ready to restore later. */
  history(nodeId: NodeId): NavState | null {
    const contents = pageOf(this.views.get(nodeId));
    if (!contents) return this.pendingHistory.get(nodeId) ?? null;
    if (this.internal.has(nodeId)) return null;
    const restoring = this.restoring.get(nodeId);
    if (restoring?.contents === contents) return restoring.nav;
    return trimNavState(contents.navigationHistory.getAllEntries(), contents.navigationHistory.getActiveIndex());
  }

  /** Load this history, rather than the tab's address, the next time the tab's view is made. */
  restoreHistoryOnLoad(nodeId: NodeId, nav: NavState | null): void {
    if (nav) this.pendingHistory.set(nodeId, nav);
  }

  ensure(nodeId: NodeId): WebContentsView | undefined {
    const existing = this.views.get(nodeId);
    if (existing) return existing;
    const node = nodeOf(this.deps.state(), nodeId);
    if (node?.kind !== 'tab') return undefined;

    const internal = isInternalUrl(node.url);
    const view = internal
      ? this.deps.createInternalView(node.url)
      : new WebContentsView({
          webPreferences: {
            session: this.deps.sessionFor(node),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
            // An agent's tab: its preload runs in every frame of it too (sandboxed, as the page is), so its holds and
            // its typing guard are in its frames as well (Neon's review of #110).
            ...(this.deps.agentTab?.(nodeId) ? { disableDialogs: true, additionalArguments: [AGENT_TAB_ARG], nodeIntegrationInSubFrames: true } : {}),
          },
        });
    // And its file pickers held for its whole life, at a layer no page reaches (agents/pickers.ts), armed before its
    // page loads (a frame already on its way when the hold starts would be held without the hold hearing of it).
    // Only an agent's tab waits: any other loads at once, as before (a load asked for right after, an image search's
    // POST, must come after this one, never be overtaken by it).
    const armed = !internal && this.deps.agentTab?.(nodeId) ? holdFilePickers(view.webContents, (detail) => this.deps.onAgentRefused?.(nodeId, 'file', detail)) : null;
    view.setBorderRadius(frameRadius[platform]);
    this.views.set(nodeId, view);
    if (internal) this.internal.add(nodeId);
    this.wire(nodeId, view.webContents, internal);
    this.deps.onContentsCreated(view.webContents, nodeId);
    if (internal) return view;

    const nav = this.pendingHistory.get(nodeId);
    this.pendingHistory.delete(nodeId);
    const contents = view.webContents;
    if (nav) {
      this.restoring.set(nodeId, { contents, nav });
      // Committed (restored, or a page of its own): its own history from then on.
      contents.once('did-navigate', () => {
        if (this.restoring.get(nodeId)?.contents === contents) this.restoring.delete(nodeId);
      });
    }
    // Muted stays muted: after sleeping, a restart, or a move to other sign-ins (a new page each time).
    if (node.muted) contents.setAudioMuted(true);
    const url = node.url;
    const load = () => {
      if (contents.isDestroyed()) return;
      if (nav) {
        this.restoreInto(contents, nav, url);
      } else {
        void contents.loadURL(url).catch(() => {
          // Load failures surface through did-fail-load; nothing to do here.
        });
      }
    };
    // An agent's tab: a blank page first, for a renderer to bypass service workers in (agents/pickers.ts), then its
    // address, only if that answered (fail closed: a service worker would send out of the hold's sight). The blank
    // page is never the tab's: not its address, nor in its back list.
    let overtaken = false;
    /** Its first page's load has started: a load over it from then is only a load, its hold on (#287). */
    let started = false;
    const primed = async () => {
      // Overtaken (or closed) while its hold armed: no blank page asked of it, never a throw from a page gone.
      if (overtaken || contents.isDestroyed()) return void this.priming.delete(contents);
      this.priming.add(contents);
      await contents.loadURL('about:blank').catch(() => undefined);
      // Overtaken while the blank page loaded: no bypass asked for a page that isn't this one's (round 1 of #282).
      if (overtaken) return;
      const bypassed = await bypassServiceWorkers(contents);
      this.priming.delete(contents);
      // Another load came first (whenProxied): it's the page now, never this one over it.
      if (overtaken) return;
      // No bypass, no page (fail closed): the hold is failed (nothing acts there), and what waits on it stops waiting.
      if (!bypassed || contents.isDestroyed()) {
        holdFailed(contents);
        return setFirstLoadPending(contents, false);
      }
      const arrived = () => {
        // A navigation queued behind a new gate meanwhile: a tool call still waits, for that one (Neon's SF5).
        if (this.waiting.has(contents)) this.waitMarked.add(contents);
        else setFirstLoadPending(contents, false);
        contents.off('did-fail-load', arrived);
        const history = contents.navigationHistory;
        if (history.getActiveIndex() > 0 && history.getEntryAtIndex(0)?.url === 'about:blank') history.removeEntryAtIndex(0);
      };
      contents.once('did-navigate', arrived);
      contents.once('did-fail-load', arrived);
      // Through the gate again: the session may have started changing while the hold armed or the page primed (Neon's
      // NB2, round 1 of #323). This turn replaces the one that ran `due` without overtaking it, and a load asked for
      // over it before it starts still overtakes it.
      this.loadTurns.set(contents, {});
      this.whenProxied(
        contents,
        () => {
          started = true;
          load();
        },
        overtake,
      );
    };
    // Its first page is on its way from now (a read or open_tab waits for it, never the blank page before it).
    if (armed) setFirstLoadPending(contents, true);
    // A load asked for over an agent tab's first page before it came (you, in the address bar): its hold is failed (nothing
    // acts there, as a page loaded without its service workers bypassed), and nothing waits for a first page that won't come.
    const overtake = () => {
      if (!firstLoadPending(contents) || started) return;
      overtaken = true;
      // The overtaking page is the tab's: its address, title and history reported, never swallowed as the blank page's
      // (Neon's SF2 on #282).
      this.priming.delete(contents);
      holdFailed(contents);
      setFirstLoadPending(contents, false);
    };
    // An agent's tab is being primed from the moment its load is due, its hold still arming: Stop and Reload see it there
    // (Neon's SF1, round 1 of #292).
    const due = () => {
      if (!armed) return load();
      this.priming.add(contents);
      void armed.then(primed);
    };
    this.whenProxied(contents, due, armed ? overtake : undefined, Boolean(nav) && !armed);
    return view;
  }

  /** Back where it was: same page, same back/forward list, same scroll position; its address if that fails. */
  private restoreInto(contents: WebContents, nav: NavState, url: string): void {
    const turn = this.loadTurns.get(contents);
    contents.navigationHistory.restore({ entries: nav.entries, index: nav.index }).catch(() => {
      // Its address instead, once the session is ready (Neon's NN2, round 1 of #323); never over a load asked for
      // since, waiting or already loading (round 2).
      if (contents.isDestroyed() || contents.navigationHistory.length() > 0 || this.loadTurns.get(contents) !== turn) return;
      this.whenProxied(contents, () => void contents.loadURL(url).catch(() => {}));
    });
  }

  /**
   * A page that isn't a tab yet (Peek, a mini window): a tab's view and
   * wiring, under the id it will have as a tab, so `adopt` can make it one
   * without reloading. Its reports to the store wait until then; its visits
   * still count as history unless it's private.
   */
  createFloating(nodeId: NodeId, { session, url, private: isPrivate }: { session: Session; url: string; private: boolean }): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    this.floating.set(nodeId, { view, private: isPrivate, url });
    // The page as made: the view forgets it once it's destroyed (view-page.ts), and the proxy may take a while.
    const contents = view.webContents;
    this.wire(nodeId, contents, false);
    this.deps.onContentsCreated(contents, nodeId);
    this.whenProxied(contents, () => {
      void contents.loadURL(url).catch(() => {
        // Load failures show in the page itself, as they would in a tab.
      });
    });
    return view;
  }

  /**
   * A floating page's address: where it is, or, before its first page came (waiting for the session), where it's going
   * (Neon's NSF2, round 1 of #323: Open in, or Peek's Open in Today, never opens a blank tab).
   */
  floatingAddress(nodeId: NodeId): string | undefined {
    const page = this.floating.get(nodeId);
    if (!page) return undefined;
    const contents = pageOf(page.view);
    return contents?.getURL() || page.url;
  }

  /** The floating page with this contents, if it is one. */
  floatingFor(contents: WebContents): NodeId | undefined {
    for (const [id, page] of this.floating) if (page.view.webContents === contents) return id;
    return undefined;
  }

  getFloating(nodeId: NodeId): WebContentsView | undefined {
    return this.floating.get(nodeId)?.view;
  }

  /** The floating page becomes the tab `nodeId` (tab.adopt makes the node), keeping its page and history. */
  adopt(nodeId: NodeId): WebContentsView | undefined {
    const page = this.floating.get(nodeId);
    if (!page || !pageOf(page.view)) return undefined;
    this.floating.delete(nodeId);
    this.views.set(nodeId, page.view);
    page.view.setBorderRadius(frameRadius[platform]);
    return page.view;
  }

  /** Every floating page in this session closes (its proxy began failing, #331): none is left sending around it. */
  closeFloatingIn(ses: Session): void {
    for (const [nodeId, page] of [...this.floating]) {
      const contents = pageOf(page.view);
      if (contents && !contents.isDestroyed() && contents.session === ses) this.closeFloating(nodeId);
    }
  }

  /** A floating page that won't become a tab: its page closes. */
  closeFloating(nodeId: NodeId): void {
    const page = this.floating.get(nodeId);
    this.floating.delete(nodeId);
    const contents = pageOf(page?.view);
    // A page's close takes a moment: a load waiting for its session never starts in it (Neon's SF2, round 1 of #292).
    if (contents) this.stopWaiting(contents);
    contents?.close();
  }

  navigate(nodeId: NodeId, url: string): void {
    const view = this.views.get(nodeId);
    if (!view) return;
    // Chord's pages and web pages live in different sessions: crossing over needs a new view.
    if (isInternalUrl(url) !== this.internal.has(nodeId)) {
      this.destroy(nodeId);
      this.ensure(nodeId);
      return;
    }
    const contents = pageOf(view);
    if (!contents || isInternalUrl(url)) return;
    this.load(contents, url);
  }

  /** Silence the tab's page, or let it be heard. A tab without a page is silenced when it gets one (ensure). */
  setMuted(nodeId: NodeId, muted: boolean): void {
    pageOf(this.views.get(nodeId))?.setAudioMuted(muted);
  }

  /** A tab's count as it shows: its page's, else its site's service worker's; hidden when counts are off, or off for its site. */
  private shownBadge(nodeId: NodeId, url: string): TabCount {
    const badge = this.badges.get(nodeId) ?? this.scopeBadge(nodeId, url);
    return badge !== null && countShows(url, this.deps.state().settings.tabCounts) ? badge : null;
  }

  /** The count a service worker gave the tab's site: the one whose scope is the longest start of its address, in its session. */
  private scopeBadge(nodeId: NodeId, url: string): TabCount {
    const node = nodeOf(this.deps.state(), nodeId);
    const scopes = node?.kind === 'tab' ? this.scopeBadges.get(this.deps.sessionFor(node)) : undefined;
    let best: { scope: string; badge: Exclude<TabCount, null> } | null = null;
    for (const [scope, badge] of scopes ?? []) if (url.startsWith(scope) && (!best || scope.length > best.scope.length)) best = { scope, badge };
    return best?.badge ?? null;
  }

  /** A service worker set or cleared its site's count: its tabs under `scope`, in its session, show it now. */
  setScopeBadge(ses: Session, scope: string, raw: unknown): void {
    const badge = pageBadge(raw);
    if (badge === undefined || !/^https?:\/\//.test(scope)) return;
    let scopes = this.scopeBadges.get(ses);
    if (!scopes) this.scopeBadges.set(ses, (scopes = new Map()));
    if (badge === null) scopes.delete(scope);
    else scopes.set(scope, badge);
    this.refreshCounts();
  }

  /** Whether the tab has a count of its own or its site's (its menu offers to hide or show it). */
  hasBadge(nodeId: NodeId): boolean {
    const contents = pageOf(this.views.get(nodeId));
    return this.badges.has(nodeId) || (contents ? this.scopeBadge(nodeId, contents.getURL()) !== null : false);
  }

  /** Counts were turned on or off, hidden for a site, or a service worker's changed: every awake tab shows its own as it is now. */
  refreshCounts(): void {
    const state = this.deps.state();
    for (const [nodeId, view] of this.views) {
      const contents = pageOf(view);
      if (!contents || !state.live[nodeId]) continue;
      const badge = this.shownBadge(nodeId, contents.getURL());
      if (state.live[nodeId]!.badge !== badge) this.deps.dispatch({ t: 'tab.live', nodeId, live: { badge } });
    }
  }

  /** Close the tab's page, keeping its history to load when it's shown again. */
  sleep(nodeId: NodeId): void {
    const nav = this.history(nodeId);
    this.destroy(nodeId);
    this.restoreHistoryOnLoad(nodeId, nav);
  }

  destroy(nodeId: NodeId): void {
    const view = this.views.get(nodeId);
    const contents = pageOf(view);
    // What its hold holds fails first, while the debugger that holds it is still on (#115, SF1: a held send never
    // resumed by the close; the agent's letGo, later, finds no page).
    if (contents && !contents.isDestroyed()) failHeld(contents);
    // A page's close takes a moment: a load waiting for its session never starts in it (Neon's SF2, round 1 of #292).
    if (contents) this.stopWaiting(contents);
    this.views.delete(nodeId);
    this.crashReloads.delete(nodeId);
    this.playing.delete(nodeId);
    this.badges.delete(nodeId);
    this.pendingHistory.delete(nodeId);
    this.restoring.delete(nodeId);
    this.internal.delete(nodeId);
    // removeChildView alone keeps the renderer alive; close() frees it (ARCHITECTURE.md §5).
    contents?.close();
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
    for (const id of [...this.floating.keys()]) this.closeFloating(id);
  }

  private wire(nodeId: NodeId, contents: WebContents, internal: boolean): void {
    // Whether it's an agent's page, decided once (Neon's nits, round 4 and the final pass of #112): an agent's page is
    // never another's (a tab you keep gets a new page).
    const agentPage = Boolean(this.deps.agentTab?.(nodeId));
    // A page being closed (a pinned tab unloading) still fires a few events on its way out.
    // Only the tab's current page may report, or a late event would mark it loaded again.
    const current = () => !contents.isDestroyed() && this.views.get(nodeId)?.webContents === contents;
    // The tab's page, or its floating page's (Peek, a mini window): whose favicon it may still load.
    const ours = () => current() || (!contents.isDestroyed() && this.floating.get(nodeId)?.view.webContents === contents);
    const dispatch = (command: Command) => {
      if (current()) this.deps.dispatch(command);
    };
    // A page being torn down still fires did-stop-loading; its history is gone by then.
    const history = () =>
      contents.isDestroyed() ? {} : { canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
    const live = (patch: Partial<LiveTab>) => dispatch({ t: 'tab.live', nodeId, live: patch });
    // A floating page (Peek, a mini window) isn't in the store yet, but its visits are history (unless private).
    const reportsHistory = () => {
      if (current()) return true;
      const page = this.floating.get(nodeId);
      return Boolean(page && !page.private && page.view.webContents === contents && !contents.isDestroyed());
    };

    contents.on('did-start-loading', () => live({ loading: true, crashed: false }));
    // A load still waiting for the session keeps the tab loading (a navigation stopped for it: Opus's L1 on #323).
    contents.on('did-stop-loading', () => live({ loading: this.waiting.has(contents), ...history() }));
    if (internal) {
      // Chord's own page keeps its chord:// address (in development it's served from elsewhere),
      // isn't history, and has no site icon.
      contents.on('page-title-updated', (_event, title) => dispatch({ t: 'tab.updated', nodeId, title }));
      return;
    }

    // History: one visit per page a tab shows. In-page navigations count when they reach a
    // different place (pushState routing), not when only the fragment changes.
    let visited: string | null = null;
    const visit = (url: string) => {
      const place = placeKey(url);
      if (!place || place === visited || !reportsHistory()) return;
      visited = place;
      // The title arrives with page-title-updated; at this point it may still be the last page's.
      this.deps.onVisit(url, '', nodeId);
    };
    contents.on('did-navigate', (_event, url, code) => {
      // An agent's tab's blank first page (createView): never its address.
      if (this.priming.has(contents)) return;
      // A new page: the last one's count goes with it.
      const had = this.badges.delete(nodeId);
      const shown = this.shownBadge(nodeId, url);
      if (had || shown !== null) live({ badge: shown });
      // Its icon stays while the site does (a page may never name one, or fail to load it). On another
      // site, the icon Chord has for that one, or none until the page's own arrives: never the last site's.
      const before = nodeOf(this.deps.state(), nodeId);
      const site = siteOf(url);
      // The new entry's own title, never the last page's: a page with no <title> gets no page-title-updated, so the last
      // one stayed and named the wrong page in the sidebar and the assistant's cards (the owner's test of the 0.15
      // preview). A reload or Back keeps the entry's title; one with only its address has none, and its host shows.
      const title = committedTitle(contents.getTitle(), url);
      if (before?.kind === 'tab' && siteOf(before.url) !== site) {
        dispatch({ t: 'tab.updated', nodeId, url, title, favicon: site ? this.knownIcon(contents.session, site) : null });
      } else {
        dispatch({ t: 'tab.updated', nodeId, url, title });
      }
      live(history());
      visited = null;
      if (code > 0) visit(url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      dispatch({ t: 'tab.updated', nodeId, url });
      live(history());
      visit(url);
    });
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || this.priming.has(contents)) return;
      // The icon waits for the page to commit (did-navigate): a navigation can still be cancelled, or download.
      live({ error: null });
    });
    // The frame explains failures instead of showing a blank page. -3 is ERR_ABORTED: the
    // user (or the page) stopped it, which isn't an error.
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) live({ loading: false, error: { code, url }, ...history() });
    });
    contents.on('page-title-updated', (_event, title) => {
      dispatch({ t: 'tab.updated', nodeId, title });
      if (reportsHistory()) this.deps.onTitle(contents.getURL(), title, nodeId);
    });
    contents.on('page-favicon-updated', (_event, favicons) => void this.loadFavicon(nodeId, contents, favicons, agentPage, ours));
    contents.on('audio-state-changed', (event) => live({ audible: event.audible }));
    // An agent's tab (S18): a dialog or file picker its preload held, for the agent's next result. Any frame's.
    contents.ipc.on('page:agentHeld', (event, raw: unknown) => {
      if (!agentPage || !raw || typeof raw !== 'object') return;
      const { kind, detail } = raw as { kind?: unknown; detail?: unknown };
      if ((kind !== 'dialog' && kind !== 'file') || typeof detail !== 'string') return;
      this.deps.onAgentRefused?.(nodeId, kind, heldFromFrame(kind, detail, event.senderFrame, contents.mainFrame));
    });
    // A tab of yours copied (its page preload): the assistant's lease there puts it back if its click set it off (S18 M2e-2b).
    contents.ipc.on('page:copied', (event) => {
      if (!agentPage && !event.senderFrame?.parent) userTabCopied(contents);
    });
    // A frame of an agent's tab, as its preload starts: is an action's guard up? (agent-guard.ts' installFrameGuard)
    contents.ipc.on('page:agentGuardState', (event) => {
      event.returnValue = agentPage && agentGuardUp(contents);
    });
    // The count the page gives itself (counts on tabs, ARCHITECTURE.md §9), from Chord's page preload: its top frame's only.
    contents.ipc.on('page:badge', (event, raw: unknown) => {
      const badge = pageBadge(raw);
      if (badge === undefined || event.senderFrame?.parent || !current()) return;
      if (badge === null) this.badges.delete(nodeId);
      else this.badges.set(nodeId, badge);
      live({ badge: this.shownBadge(nodeId, contents.getURL()) });
    });
    // Playing tabs are never slept or archived, even muted (ARCHITECTURE.md §9).
    contents.on('media-started-playing', () => {
      if (current()) this.playing.add(nodeId);
    });
    contents.on('media-paused', () => {
      if (current()) this.playing.delete(nodeId);
    });

    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || !current()) return;
      // Reload automatically at most twice, then show "This page stopped" (borrowed from Crest). Never an agent's tab:
      // reloaded at once, it would load before its hold is armed again (round 4 of #112); it shows "This page stopped",
      // and its hold, lost, refuses acting there until it's armed again.
      const attempts = agentPage ? MAX_CRASH_RELOADS : (this.crashReloads.get(nodeId) ?? 0);
      if (attempts < MAX_CRASH_RELOADS) {
        // Through the gate, as your Reload is (#326): never before the session's proxy is set or its rules are on. Not over
        // a load you asked for that's waiting: it starts a renderer anyway, and it's where the tab is going (Opus's SF1,
        // round 1 of #333); and then not counted, as it didn't run (round 2).
        if (!this.waiting.has(contents)) {
          this.crashReloads.set(nodeId, attempts + 1);
          this.reload(contents);
        }
      } else {
        live({ crashed: true, loading: false });
      }
      if (this.badges.delete(nodeId)) live({ badge: null });
    });

    contents.setWindowOpenHandler((details) => this.openFrom(nodeId, details, agentPage));
    contents.on('did-create-window', (popup) => this.wirePopup(popup, nodeId));

    // Peek (DESIGN.md §8.5): following a link in a pinned tab to another site opens it in Peek, so
    // the pinned page stays put. Only links you follow: a page redirecting itself (sign-in flows)
    // navigates as usual, so a navigation counts only just after a click or Enter in the page.
    let gestureAt = 0;
    let gesturePoint: { x: number; y: number } | null = null;
    contents.on('input-event', (_event, input) => {
      // Only your hands: a click Chord sends for the assistant never opens Peek (S18 M2e-2b; Neon's B5).
      if (isAgentInput(contents)) return;
      if (input.type === 'mouseDown' || input.type === 'mouseUp') {
        gestureAt = Date.now();
        const mouse = input as Electron.MouseInputEvent;
        gesturePoint = { x: mouse.x, y: mouse.y };
      } else if (input.type === 'keyDown' && (input as Electron.KeyboardInputEvent).keyCode === 'Enter') {
        gestureAt = Date.now();
        gesturePoint = null;
      }
    });
    contents.on('will-navigate', (event) => {
      if (!event.isMainFrame || event.isSameDocument || !this.leadsToPeek(nodeId, contents, event.url)) return;
      if (Date.now() - gestureAt > LINK_GESTURE_MS) return;
      event.preventDefault();
      this.deps.onPeek(nodeId, event.url, gesturePoint);
    });
  }

  /** Whether following `url` from this tab's page opens Peek: it's pinned, and the link leaves its site. */
  private leadsToPeek(nodeId: NodeId, contents: WebContents, url: string): boolean {
    const node = nodeOf(this.deps.state(), nodeId);
    return node?.kind === 'tab' && node.section === 'pinned' && this.views.get(nodeId)?.webContents === contents && isCrossSite(contents.getURL(), url);
  }

  /**
   * window.open from a tab, or from a popup it opened. Real popups (window
   * features given: OAuth, payments) stay windows at the size they asked for,
   * keeping window.opener so they can report back. Everything else becomes a
   * tab in the opener's Chord window.
   */
  private openFrom(openerNodeId: NodeId, { url, disposition, features }: HandlerDetails, agentPage = Boolean(this.deps.agentTab?.(openerNodeId))): WindowOpenHandlerResponse {
    // An agent's tab (S18) opens nothing: no window, no tab of yours. The agent hears of it.
    if (agentPage) {
      this.deps.onAgentRefused?.(openerNodeId, 'popup', url);
      return { action: 'deny' };
    }
    // What the assistant's click set off in a tab of yours (S18 M2e-2b, A6; Neon's B5 and B1 on #150): nothing opens. A
    // window would be unwatched; a new tab, in front or behind, would load with no lease of its own (a download saved
    // unasked, a redirect to an address that deletes or signs out). Said in the chat; the assistant can go there itself,
    // and leaving the site asks every time.
    const opener = pageOf(this.views.get(openerNodeId));
    if (opener !== undefined && userTabCatching(opener)) {
      noteUserTab(opener, 'popup', url.slice(0, 120));
      return { action: 'deny' };
    }
    if (disposition === 'new-window' && features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...windowIcon(),
          // The size a page asks for is its own area, as in Chrome, not the window's frame.
          useContentSize: true,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
        },
      };
    }
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    // Peek and mini windows keep to themselves: a link that wants a new tab opens right there.
    const floating = this.floating.get(openerNodeId);
    if (floating) {
      // Once its session is ready, over any load still waiting (#326).
      const page = pageOf(floating.view);
      if (page) this.load(page, url);
      return { action: 'deny' };
    }
    // A pinned tab's link to another site opens in Peek, unless it was asked for in the background (⌘/Ctrl-click).
    if (disposition !== 'background-tab' && opener && this.leadsToPeek(openerNodeId, opener, url)) {
      this.deps.onPeek(openerNodeId, url, null);
      return { action: 'deny' };
    }
    const windowId = this.deps.windowFor(openerNodeId);
    if (windowId) this.deps.dispatch({ t: 'tab.open', windowId, url, background: disposition === 'background-tab' });
    return { action: 'deny' };
  }

  private wirePopup(popup: BrowserWindow, openerNodeId: NodeId): void {
    // Not the app menu: Alt would otherwise reveal it on Windows and Linux.
    popup.removeMenu();
    const contents = popup.webContents;
    // Popups follow the same rules as their opener, so a sign-in window can't spawn unchecked windows.
    contents.setWindowOpenHandler((details) => this.openFrom(openerNodeId, details));
    contents.on('did-create-window', (child) => this.wirePopup(child, openerNodeId));
    this.deps.onPopupCreated(contents, openerNodeId);
  }

  /**
   * Fetch through the tab's own session (its cookies apply), keep small icons
   * as data: URLs, and remember each for its site. An icon that can't be had
   * changes nothing: the tab keeps the one it has (its site's, or the monogram).
   */
  /**
   * `agent` is the page's kind as wire() latched it, never the tab's now (#322's B2: a kept or closing tab is no longer
   * an agent's, but its page's late events are still that page's); `ours` whether the page is still the tab's (or its
   * floating page's).
   */
  private async loadFavicon(nodeId: NodeId, contents: WebContents, favicons: string[], agent: boolean, ours: () => boolean): Promise<void> {
    if (!ours()) return;
    // The page this icon is for: by the time it's fetched, the tab may be on another site.
    const page = contents.getURL();
    // An agent's tab (#115, B1): only a data: or own-origin icon, with no credentials and no redirect; none on a Never
    // site (favicon-pick.ts).
    const never = (url: string) => isNeverReadable(url, this.deps.state().settings?.assistant?.neverSites ?? []);
    const picked = pickFavicon(favicons, page, { agent, never });
    if (!picked) return;
    const { url } = picked;
    const session = contents.session;
    let icon: string | null = null;
    try {
      if (/^data:/i.test(url)) {
        if (usableDataIcon(url, MAX_FAVICON_BYTES)) icon = url;
      } else {
        const response = await contents.session.fetch(url, { ...picked.init, signal: AbortSignal.timeout(8000) });
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        const bytes = response.ok && /^image\//.test(type) ? Buffer.from(await response.arrayBuffer()) : null;
        if (bytes && bytes.length > 0 && bytes.length <= MAX_FAVICON_BYTES) icon = `data:${type};base64,${bytes.toString('base64')}`;
      }
    } catch {
      // Unreachable: the tab keeps the icon it has.
    }
    if (!icon) return;
    // An agent's page closed meanwhile, or gone on to a Never site: never kept (#322's SF2).
    if (agent && (contents.isDestroyed() || never(contents.getURL()))) return;
    this.rememberIcon(session, page, icon);
    if (!ours() || siteOf(contents.getURL()) !== siteOf(page)) return;
    this.deps.dispatch({ t: 'tab.updated', nodeId, favicon: icon });
  }
}

/**
 * A committed page's title as Chromium's entry shows it: its own, or (none set yet, or ever) its address, which is no
 * title: empty, so the host shows.
 */
function committedTitle(shown: string, url: string): string {
  const title = shown.trim();
  const bare = (s: string) => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  // Its address as Chromium shows it: whole, or cut (it may elide a long one), never a word that only appears in it.
  if (!title || bare(url) === bare(title) || (/[./]/.test(title) && bare(url).startsWith(bare(title)))) return '';
  return title;
}
