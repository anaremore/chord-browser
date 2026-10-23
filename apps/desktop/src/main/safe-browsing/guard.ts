/**
 * Where Safe Browsing meets pages (ARCHITECTURE.md §14.5): every navigation
 * of a tab, Peek, mini window or popup, in every window (private ones too),
 * is checked as it starts and at each redirect, frames included.
 *
 * Chord can't hold a navigation while it's checked: Electron's only hook
 * that can wait is `session.webRequest`, and using it silently turns off
 * extensions' chrome.webRequest (ARCHITECTURE.md §9). Nothing waits, then.
 * The local check answers in well under a millisecond, long before a page
 * arrives; only an address whose prefix is on a list waits for the service
 * (a fraction of a percent of them), and the page loads meanwhile. When the
 * answer is unsafe, the navigation stops; if the page got there first, the
 * tab goes back to the page before it (or a blank one), and the frame shows
 * the warning either way. "Visit anyway" is remembered for the site until
 * Chord quits, and a private window's only while it's open.
 */
import { hostOf, type Command, type NodeId, type PageThreat, type State } from '@chord/core';
import type { Session, WebContents } from 'electron';
import type { Verdict } from './database';

export interface GuardDeps {
  state(): State;
  dispatch(command: Command): void;
  /** Safe Browsing is on (and available); off, nothing is checked at all. */
  enabled(): boolean;
  check(urls: string[]): Promise<Verdict>;
  /** Whether this is the tab's page right now (not Peek's, a mini window's, or one being replaced). */
  isTab(contents: WebContents, nodeId: NodeId): boolean;
  contentsOf(nodeId: NodeId): WebContents | undefined;
  /** A page that isn't a tab's was flagged: it closes, and `url` opens as a tab (in `nodeId`'s window), where the warning shows. */
  handOver(contents: WebContents, nodeId: NodeId, url: string): void;
  /** "Back to safety" with nothing to go back to. */
  closeTab(nodeId: NodeId): void;
}

interface Watch {
  /** Main-frame navigations so far: an answer about an older one is dropped. */
  seq: number;
  /** The last navigation that committed. */
  committed: number;
  /** The navigation flagged, if any. */
  flagged: number;
  /** The next main-frame navigation is Chord leaving a flagged page: it keeps the warning, and isn't checked. */
  own: boolean;
}

/** Two addresses for the same page (the fragment doesn't count). */
const samePage = (a: string, b: string): boolean => a.split('#')[0] === b.split('#')[0];

export class SafeBrowsingGuard {
  private readonly watches = new WeakMap<WebContents, Watch>();
  /** "Visit anyway": hosts every normal window lets through until Chord quits. */
  private readonly allowed = new Set<string>();
  /** A private window's, kept with its session (in memory, gone with the window). */
  private readonly allowedPrivate = new WeakMap<Session, Set<string>>();

  constructor(private readonly deps: GuardDeps) {}

  /** A tab's page, or a page that may become one (Peek, a mini window), under the tab's id. */
  attach(contents: WebContents, nodeId: NodeId): void {
    this.watch(contents, nodeId, (watch, threat) => {
      if (this.deps.isTab(contents, nodeId)) this.flagTab(contents, nodeId, watch, threat);
      // Peek or a mini window: it closes, and the page opens as a tab, where the warning shows.
      else this.deps.handOver(contents, nodeId, threat.url);
    });
  }

  /** A popup a page opened (sign-in, payment): flagged, it closes and the warning shows in a tab beside its opener. */
  attachPopup(contents: WebContents, openerNodeId: NodeId): void {
    this.watch(contents, null, (_watch, threat) => this.deps.handOver(contents, openerNodeId, threat.url));
  }

  private watch(contents: WebContents, nodeId: NodeId | null, onThreat: (watch: Watch, threat: PageThreat) => void): void {
    const watch: Watch = { seq: 0, committed: -1, flagged: -1, own: false };
    this.watches.set(contents, watch);
    const inspect = (url: string, mainFrame: boolean) => {
      if (!this.deps.enabled() || !/^https?:/i.test(url) || this.isAllowed(contents.session, url)) return;
      const seq = watch.seq;
      void this.deps.check([url]).then((verdict) => {
        if (verdict.verdict !== 'unsafe' || contents.isDestroyed() || watch.seq !== seq) return;
        watch.flagged = seq;
        onThreat(watch, mainFrame ? { kind: verdict.kind, url, frameUrl: null } : { kind: verdict.kind, url: contents.getURL() || url, frameUrl: url });
      });
    };
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && watch.own) {
        watch.own = false;
        // Chord leaving a flagged page. Back within the same document (an entry the page pushed) is still
        // the flagged page: keep going back. Otherwise the warning stays, and the page it lands on was checked.
        if (details.isSameDocument && nodeId) this.leave(contents, watch, nodeId);
        else if (!details.isSameDocument) watch.seq++;
        return;
      }
      if (details.isSameDocument) return;
      if (details.isMainFrame) {
        watch.seq++;
        // You went somewhere else: the warning goes with the page it was about.
        if (nodeId) this.clear(nodeId, contents);
      }
      inspect(details.url, details.isMainFrame);
    });
    contents.on('did-redirect-navigation', (details) => {
      if (!details.isSameDocument) inspect(details.url, details.isMainFrame);
    });
    contents.on('did-navigate', () => {
      watch.committed = watch.seq;
      // The page arrived after all (its answer came just before it did): leave it.
      if (nodeId && watch.flagged === watch.seq && this.deps.isTab(contents, nodeId)) this.leave(contents, watch, nodeId);
    });
  }

  /** The frame shows the warning; the navigation stops, and what got through of it goes. */
  private flagTab(contents: WebContents, nodeId: NodeId, watch: Watch, threat: PageThreat): void {
    this.deps.dispatch({ t: 'tab.live', nodeId, live: { threat, loading: false } });
    contents.stop();
    if (threat.frameUrl || watch.committed === watch.seq) this.leave(contents, watch, nodeId);
  }

  /**
   * Back to the page before, or a blank page when there's none: a flagged
   * page never stays loaded behind its warning. With a blank page, the tab
   * still goes by the flagged address (the warning is about it).
   */
  private leave(contents: WebContents, watch: Watch, nodeId?: NodeId): void {
    watch.own = true;
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
      return;
    }
    const threat = nodeId ? this.deps.state().live[nodeId]?.threat : null;
    void contents.loadURL('about:blank').then(
      () => {
        if (nodeId && threat && this.deps.state().live[nodeId]?.threat?.url === threat.url) this.deps.dispatch({ t: 'tab.updated', nodeId, url: threat.url });
      },
      () => {},
    );
  }

  private clear(nodeId: NodeId, contents?: WebContents): void {
    if (contents && !this.deps.isTab(contents, nodeId)) return;
    if (this.deps.state().live[nodeId]?.threat) this.deps.dispatch({ t: 'tab.live', nodeId, live: { threat: null } });
  }

  private allowList(session: Session): Set<string> {
    if (session.isPersistent()) return this.allowed;
    let list = this.allowedPrivate.get(session);
    if (!list) this.allowedPrivate.set(session, (list = new Set()));
    return list;
  }

  private isAllowed(session: Session, url: string): boolean {
    const host = hostOf(url);
    return host !== null && this.allowList(session).has(host);
  }

  /** The warning's "Back to safety": the page before it, or the tab closes when there's none. */
  back(nodeId: NodeId): void {
    const threat = this.deps.state().live[nodeId]?.threat;
    if (!threat) return;
    const contents = this.deps.contentsOf(nodeId);
    if (!contents || contents.isDestroyed()) {
      this.clear(nodeId);
      return;
    }
    const url = contents.getURL();
    const onFlagged = samePage(url, threat.url) && !threat.frameUrl;
    if (!url || url === 'about:blank' || (onFlagged && !contents.navigationHistory.canGoBack())) {
      this.deps.closeTab(nodeId);
      return;
    }
    // Still on the flagged page itself (its answer came as it arrived): go back now.
    if (onFlagged) this.leave(contents, this.watches.get(contents) ?? { seq: 0, committed: -1, flagged: -1, own: false });
    this.clear(nodeId);
  }

  /** "Visit anyway": the site isn't flagged again this session (in a private window, while it's open). */
  proceed(nodeId: NodeId): void {
    const threat = this.deps.state().live[nodeId]?.threat;
    if (!threat) return;
    const contents = this.deps.contentsOf(nodeId);
    const host = hostOf(threat.frameUrl ?? threat.url);
    if (host && contents && !contents.isDestroyed()) this.allowList(contents.session).add(host);
    this.clear(nodeId);
    if (contents && !contents.isDestroyed()) void contents.loadURL(threat.url).catch(() => {});
    else this.deps.dispatch({ t: 'tab.navigate', nodeId, url: threat.url });
  }
}
