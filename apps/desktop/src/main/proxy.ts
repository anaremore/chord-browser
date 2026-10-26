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
 *
 * Nothing per request: Chromium applies the proxy in its network service.
 */
import { DEFAULT_PROXY_CONFIG, proxied, proxyConfig, type ProfileId, type ProxySettings } from '@chord/core';
import type { Session, WebContents } from 'electron';

/** Whose proxy a session takes: a profile's (its chord's own, if it has one), or null for Chord's own sessions. */
export type ProxyOwner = ProfileId | null;

export interface ProxiesDeps {
  /** The proxy an owner's sessions use now. */
  proxyFor(owner: ProxyOwner): ProxySettings;
  /** Every page and view there is, for WebRTC's policy. */
  contents(): Iterable<WebContents>;
}

interface Tracked {
  owner: ProxyOwner;
  /** The config last given to setProxy, as JSON: Electron's own (the system's) until Chord sets one. */
  applied: string;
  proxied: boolean;
  /** Until setProxy has answered and old connections are closed: what the session's next request waits for. */
  pending: Promise<void> | null;
}

const SYSTEM = JSON.stringify(DEFAULT_PROXY_CONFIG);

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
    this.sessions.set(ses, { owner: this.making, applied: SYSTEM, proxied: false, pending: null });
    this.apply(ses, true);
  }

  /** A profile's session (or, with null, one of Chord's own): `create` calls session.fromPartition. */
  make(owner: ProxyOwner, create: () => Session): Session {
    this.making = owner;
    try {
      const ses = create();
      const tracked = this.sessions.get(ses);
      if (!tracked) this.created(ses);
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

  /** A private window's session is gone with it. */
  forget(ses: Session): void {
    this.sessions.delete(ses);
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
    const config = proxyConfig(proxy);
    const key = JSON.stringify(config);
    if (key === tracked.applied) return;
    tracked.applied = key;
    // Connections opened the old way (pooled, or still open) don't carry on: closing them ends what's in
    // flight, so whatever waits for `ready` starts only after. A change while one is under way follows it,
    // so an older one's closing never cuts the newer one's requests; otherwise setProxy is called right here.
    const set = (): Promise<void> => ses.setProxy(config).then(() => (fresh ? undefined : ses.closeAllConnections()));
    const pending: Promise<void> = (tracked.pending ? tracked.pending.then(set) : set())
      .catch((error: unknown) => console.error('Setting a proxy failed:', error))
      .finally(() => {
        if (tracked.pending === pending) tracked.pending = null;
      });
    tracked.pending = pending;
    const behind = proxied(proxy);
    if (behind === tracked.proxied) return;
    tracked.proxied = behind;
    for (const contents of this.deps.contents()) {
      if (!contents.isDestroyed() && contents.session === ses) contents.setWebRTCIPHandlingPolicy(behind ? 'disable_non_proxied_udp' : 'default');
    }
  }
}

/** The one for the whole app: session-created is the app's event, and Chord's own requests wait on it (updates, lists, suggestions). */
export const proxies = new Proxies();
