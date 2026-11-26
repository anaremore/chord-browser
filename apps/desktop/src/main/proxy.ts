/**
 * Proxies (ARCHITECTURE.md §9, *Proxies*): every session gets the proxy it
 * should before its first request. Electron sets proxies per session, so a
 * chord with a proxy of its own keeps its own sign-ins; every other session
 * (shared sign-ins, private windows, Chord's own requests) takes the proxy for
 * every chord.
 *
 * - **Made with it.** `app`'s session-created fires inside
 *   session.fromPartition, before anything can use the session; it gets its
 *   proxy there. Profiles' sessions are made through `make`, which says whose.
 * - **Nothing loads first.** setProxy hands Chromium the new config before it
 *   returns, and resolves once that's done; until it has (and old connections
 *   are closed), `ready` is pending, and TabManager and Chord's own requests
 *   wait for it. A page already open isn't stopped, but its connections are.
 * - **No work without one.** A session that should use the system's proxy,
 *   as Electron's do already, is never touched: no setProxy, nothing pending.
 * - **WebRTC** sends nothing past a proxy: its pages get `disable_non_proxied_udp`.
 * - **A proxy that can't be set never lets a page through (#325).** The page gate
 *   lets a page load once `ready` resolves or rejects, so a failed setProxy does
 *   neither: the wait resolves only once the config wanted now has taken. It's
 *   not counted as applied, it's tried again (1, 2, 4, 8, 16 s, then every 30 s),
 *   a new config replaces it, and `failing()` says whose and why (Settings).
 *   WebRTC is strict from the moment a proxy is wanted, and back to default
 *   only once a direct config has taken.
 * - **Nothing at all goes out meanwhile (#331).** The gate holds the loads
 *   Chord starts; a page already open (its fetch, a navigation it makes, a
 *   WebSocket, a service worker) would still go out the old way. So while the
 *   proxy is failing, the session cancels every http(s) and ws(s) request
 *   (requests.ts' dispatcher), and its open connections are closed. Offline
 *   network emulation stops none of those in Electron 45 (measured, #331).
 *   Launch waits for each proxy to take or fail, never on one failing.
 *
 * Nothing per request: Chromium applies the proxy in its network service.
 */
import { DEFAULT_PROXY_CONFIG, proxied, proxyConfig, type ProfileId, type ProxySettings } from '@chord/core';
import type { Session, WebContents } from 'electron';
import { requestDispatcher } from './requests';

/** Whose proxy a session takes: a profile's (its chord's own, if it has one), or null for Chord's own sessions. */
export type ProxyOwner = ProfileId | null;

export interface ProxiesDeps {
  /** The proxy an owner's sessions use now. */
  proxyFor(owner: ProxyOwner): ProxySettings;
  /** Every page and view there is, for WebRTC's policy. */
  contents(): Iterable<WebContents>;
  /** What `failing()` says changed (#325): a proxy began failing, or took. */
  changed?(): void;
  /** Whether an owner's sessions are any live chord's (or Chord's own, null): a failing proxy no one uses isn't retried. */
  inUse?(owner: ProxyOwner): boolean;
  /**
   * The session's proxy just began failing (#331): its open pages are held, their documents closed. The block stops
   * what they'd start next, but a page open before it (in a session with extensions) sends around it (measured).
   */
  failed?(ses: Session): void;
}

interface Tracked {
  owner: ProxyOwner;
  /** The config setProxy last took, as JSON: Electron's own (the system's) until Chord sets one. */
  applied: string;
  /** The config wanted now, as JSON: being set while it isn't `applied`. */
  wanted: string;
  /** WebRTC's policy now: strict (`disable_non_proxied_udp`) or not. */
  proxied: boolean;
  /** Whether the config wanted is behind a proxy: WebRTC turns strict at once, and loosens once a direct one took. */
  wantedProxied: boolean;
  /** The wanted config has answered (taken, or failed) since it was wanted: launch waits for no more than that. */
  answered: boolean;
  /** While the proxy is failing: the session's every http(s) and ws(s) request cancelled (removed once it takes). */
  block: (() => void) | null;
  /**
   * Until the config wanted now has taken (setProxy answered, old connections closed): what the session's next
   * request waits for. One promise per change, resolved only by success, never settled by a failure (#325).
   */
  pending: Promise<void> | null;
  resolve: (() => void) | null;
  /** The try under way, if any: a newer config's try waits for it to answer first. */
  attempt: Promise<unknown> | null;
  /** Why the wanted config didn't take, while it hasn't; and the next try. */
  failure: string | null;
  retry: ReturnType<typeof setTimeout> | null;
  tries: number;
  /** Failing for an owner no live chord uses: not retried until a chord does again (make, sync). */
  parked: boolean;
}

const SYSTEM = JSON.stringify(DEFAULT_PROXY_CONFIG);

/** `applied` once setProxy has changed what's in place but closing the old connections hasn't answered: not known. */
const UNKNOWN = 'unknown';

/** After a failed setProxy, the waits before each next try: then the last, for as long as it's wanted. */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** What a session can send while its proxy is failing: nothing on the web (Chord's own pages and extensions' aren't). */
const BLOCKED = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

export class Proxies {
  private deps: ProxiesDeps | null = null;
  private readonly sessions = new Map<Session, Tracked>();
  /** The owner of the session `make` is making, for `created`. */
  private making: ProxyOwner = null;

  /** The saved settings are read: every session made so far gets its proxy, and each one from now on as it's made. */
  start(deps: ProxiesDeps): void {
    this.deps = deps;
    this.sync();
  }

  /** Electron made a session (`app`'s session-created): its proxy is set now, before anything can use it. */
  created(ses: Session): void {
    if (this.sessions.has(ses)) return;
    this.sessions.set(ses, {
      owner: this.making,
      applied: SYSTEM,
      wanted: SYSTEM,
      proxied: false,
      wantedProxied: false,
      answered: true,
      block: null,
      pending: null,
      resolve: null,
      attempt: null,
      failure: null,
      retry: null,
      tries: 0,
      parked: false,
    });
    this.apply(ses, true);
  }

  /** A profile's session (or, with null, one of Chord's own): `create` calls session.fromPartition. */
  make(owner: ProxyOwner, create: () => Session): Session {
    this.making = owner;
    try {
      const ses = create();
      const tracked = this.sessions.get(ses);
      if (!tracked) this.created(ses);
      else if (tracked.parked) this.apply(ses, false);
      else if (tracked.owner !== owner) {
        // fromPartition handed back a session made before, for someone else.
        tracked.owner = owner;
        this.apply(ses, false);
      }
      return ses;
    } finally {
      this.making = null;
    }
  }

  /** What a request in this session waits for first; null (almost always) when its proxy is in place. */
  ready(ses: Session): Promise<void> | null {
    return this.sessions.get(ses)?.pending ?? null;
  }

  /** Every session's proxy is in place; null when none is pending. */
  settled(): Promise<void> | null {
    const pending = [...this.sessions.values()].flatMap((t) => (t.pending ? [t.pending] : []));
    return pending.length > 0 ? Promise.all(pending).then(() => undefined) : null;
  }

  private readonly waiters = new Set<() => void>();

  /**
   * Every session's proxy has taken or failed (#331): what launch waits for. A failing one never takes until fixed,
   * and the window (with Settings, where it's said) must open meanwhile; its pages stay held, nothing goes out.
   */
  settledOrFailing(): Promise<void> | null {
    const waiting = () => [...this.sessions.values()].some((t) => t.pending && !t.answered);
    if (!waiting()) return null;
    return new Promise<void>((resolve) => {
      const check = () => {
        if (waiting()) return;
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  /** A private window's session is gone with it. */
  forget(ses: Session): void {
    const tracked = this.sessions.get(ses);
    if (tracked?.retry) clearTimeout(tracked.retry);
    tracked?.block?.();
    this.sessions.delete(ses);
    if (tracked && tracked.failure !== null && !this.stopped) this.deps?.changed?.();
    this.wake();
  }

  private stopped = false;

  /** Quitting (Neon's N-SF2 on #331): no more tries, no more word of failures; what's in place stays as it is. */
  stop(): void {
    this.stopped = true;
    for (const tracked of this.sessions.values()) {
      if (tracked.retry) clearTimeout(tracked.retry);
      tracked.retry = null;
    }
  }

  /** Whether the session's proxy is failing now, so it sends nothing on the web (#331). */
  blocked(ses: Session): boolean {
    return this.sessions.get(ses)?.block != null;
  }

  /**
   * Whether a request main starts itself must wait (#331, Neon's SF2-r2): the proxy is failing, or still being set.
   * A download from main (downloadURL) goes around the session's requests, so it asks this first, when it's started.
   */
  holding(ses: Session): boolean {
    return this.blocked(ses) || this.ready(ses) !== null;
  }

  /** Try again now (Settings' Try again, #325): the sessions of `owner` whose proxy can't be set, or with null, every one. */
  retry(owner: ProxyOwner | null): void {
    // Quitting: nothing more is tried (Neon's nit on #331).
    if (this.stopped) return;
    for (const [ses, tracked] of this.sessions) {
      // One under way answers by itself: never a second chain beside it (Opus's SF1 on #331).
      if (tracked.failure === null || tracked.attempt || (owner !== null && tracked.owner !== owner)) continue;
      if (tracked.retry) clearTimeout(tracked.retry);
      tracked.retry = null;
      this.attempt(ses, tracked, false);
    }
  }

  /** Whose proxy can't be set now, and why (Settings, #325): one entry per owner. */
  failing(): { owner: ProxyOwner; reason: string }[] {
    const out = new Map<ProxyOwner, string>();
    for (const t of this.sessions.values()) if (t.failure !== null && !out.has(t.owner)) out.set(t.owner, t.failure);
    return [...out].map(([owner, reason]) => ({ owner, reason }));
  }

  /** The proxy for every chord, or a chord's own or its sign-ins, changed: each session that should now use another one gets it. */
  sync(): void {
    for (const ses of this.sessions.keys()) this.apply(ses, false);
  }

  /** A page or view was made: behind a proxy, its WebRTC sends nothing around it. */
  contentsCreated(contents: WebContents): void {
    if (this.sessions.get(contents.session)?.proxied) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  }

  /** `fresh`: made just now, so it has no connections to close. */
  private apply(ses: Session, fresh: boolean): void {
    const tracked = this.sessions.get(ses);
    if (!tracked || !this.deps) return;
    const proxy = this.deps.proxyFor(tracked.owner);
    const key = JSON.stringify(proxyConfig(proxy));
    // WebRTC: strict from the moment a proxy is wanted, before it has taken; a direct one loosens it once it took (#325).
    tracked.wantedProxied = proxied(proxy);
    if (tracked.wantedProxied) this.webrtc(ses, tracked, true);
    if (key === tracked.wanted) {
      // In place: nothing to do. Being set: its try answers. Failing: try it again now (Settings synced, or asked, or
      // a chord using it again after it was parked), unless a try is under way, which answers by itself (#331).
      tracked.parked = false;
      if (!tracked.pending || tracked.failure === null || tracked.attempt || this.stopped) return;
      if (tracked.retry) clearTimeout(tracked.retry);
      tracked.retry = null;
      this.attempt(ses, tracked, fresh);
      return;
    }
    tracked.wanted = key;
    tracked.answered = false;
    tracked.tries = 0;
    tracked.parked = false;
    // A new config: the old one's failure isn't what's said any more (Neon's N-SF6 on #331). Still held meanwhile.
    if (tracked.failure !== null) {
      tracked.failure = null;
      if (!this.stopped) this.deps?.changed?.();
    }
    if (tracked.retry) clearTimeout(tracked.retry);
    tracked.retry = null;
    if (key === tracked.applied && !tracked.attempt) {
      // Back to what's in place, before the other took: nothing to set, and what waited goes on.
      this.settle(ses, tracked, null);
      return;
    }
    // One wait per change, until the config wanted takes; a newer one replaces the one being set, under the same wait.
    tracked.pending ??= new Promise<void>((resolve) => (tracked.resolve = resolve));
    this.attempt(ses, tracked, fresh);
  }

  /**
   * One try at the config wanted now. Connections opened the old way (pooled, or still open) don't carry on:
   * closing them ends what's in flight, so whatever waits for `ready` starts only after. A try waits for the one
   * under way to answer first, so an older one's closing never cuts the newer one's requests.
   */
  private attempt(ses: Session, tracked: Tracked, fresh: boolean): void {
    const key = tracked.wanted;
    const config = JSON.parse(key) as Parameters<Session['setProxy']>[0];
    // What's in place: unknown from the moment setProxy changed it until the old connections are closed too, then
    // the config (Opus's SF2, Neon's B2 on #331). A close that fails leaves it unknown: any config is set again.
    // A try queued behind another for a config no longer wanted: skipped, never set over the newer one (Opus's nit).
    const set = (): Promise<void> =>
      key !== tracked.wanted
        ? Promise.reject(new Error('a newer config is wanted'))
        : ses.setProxy(config).then(() => {
        if (fresh) {
          tracked.applied = key;
          return;
        }
        tracked.applied = UNKNOWN;
        return ses.closeAllConnections().then(() => void (tracked.applied = key));
      });
    const attempt: Promise<unknown> = (tracked.attempt ? tracked.attempt.then(set, set) : set()).then(
      () => {
        if (tracked.attempt === attempt) tracked.attempt = null;
        // Forgotten meanwhile (a private window closed): nothing to say (Neon's N2 on #331).
        if (this.sessions.get(ses) !== tracked) return;
        // A newer config was wanted meanwhile: its own try follows this one, and the wait stays for it.
        if (key === tracked.wanted) this.settle(ses, tracked, null);
      },
      (error: unknown) => {
        if (tracked.attempt === attempt) tracked.attempt = null;
        if (key !== tracked.wanted || this.sessions.get(ses) !== tracked) return;
        console.error('Setting a proxy failed:', error);
        this.settle(ses, tracked, error instanceof Error ? error.message : String(error));
        // One timer at a time: a try started meanwhile (Settings, a sync) never forks a second chain (Opus's SF1 on #331).
        if (tracked.retry) clearTimeout(tracked.retry);
        const wait = RETRY_MS[Math.min(tracked.tries, RETRY_MS.length - 1)]!;
        tracked.tries += 1;
        if (this.stopped) return;
        tracked.retry = setTimeout(() => {
          tracked.retry = null;
          if (this.sessions.get(ses) !== tracked || tracked.wanted !== key || tracked.attempt || this.stopped) return;
          // No live chord uses it: parked until one does (Neon's N-SF7 on #331); make() and sync() pick it up again.
          if (this.deps?.inUse && !this.deps.inUse(tracked.owner)) {
            tracked.parked = true;
            return;
          }
          this.attempt(ses, tracked, false);
        }, wait);
        tracked.retry.unref?.();
      },
    );
    tracked.attempt = attempt;
  }

  /**
   * The config wanted took (`failure` null), or didn't. Took: what waits goes on, the block goes, and WebRTC follows
   * it. Didn't: the session sends nothing on the web until it does (#331). `changed` when the failure differs.
   */
  private settle(ses: Session, tracked: Tracked, failure: string | null): void {
    tracked.answered = true;
    if (failure === null) {
      tracked.tries = 0;
      tracked.resolve?.();
      tracked.resolve = null;
      tracked.pending = null;
      this.webrtc(ses, tracked, tracked.wantedProxied);
      // Ad blocking and extensions apply again to the pages open throughout, with no reload (measured, #331).
      tracked.block?.();
      tracked.block = null;
    } else if (!tracked.block) {
      tracked.block = requestDispatcher(ses).add({ urls: BLOCKED, handle: () => 'cancel' });
      void ses.closeAllConnections().catch(() => {});
      if (!this.stopped) this.deps?.failed?.(ses);
    }
    this.wake();
    if (tracked.failure === failure) return;
    tracked.failure = failure;
    if (!this.stopped) this.deps?.changed?.();
  }

  /** WebRTC's policy for the session's pages: strict or default. */
  private webrtc(ses: Session, tracked: Tracked, strict: boolean): void {
    if (tracked.proxied === strict || !this.deps) return;
    tracked.proxied = strict;
    for (const contents of this.deps.contents()) {
      if (!contents.isDestroyed() && contents.session === ses) contents.setWebRTCIPHandlingPolicy(strict ? 'disable_non_proxied_udp' : 'default');
    }
  }

  private wake(): void {
    for (const check of [...this.waiters]) check();
  }
}

/** The one for the whole app: session-created is the app's event, and Chord's own requests wait on it (updates, lists, suggestions). */
export const proxies = new Proxies();
