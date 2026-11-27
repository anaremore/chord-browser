/**
 * What every session follows in the settings, before anything uses them (#328): its proxy (the proxy for every chord, a
 * chord's own, and which sign-ins each chord has, a chord added or gone included), and ad blocking (its switch, and the
 * sites it's off for; a private window's own list lives on its chord).
 *
 * index.ts runs this as the store's before-effects listener (Store.setBeforeEffects), so it comes before Browser's effects:
 * a tab made again in a session (Undo of a change of sign-ins, a chord restored) waits for that session's proxy, and
 * never loads before it's set.
 *
 * Not `chords/<id>/private`: whether a chord is a private window's is set when it's made, and no reducer changes it on
 * an existing chord (a chord made or gone is a change of `chords/<id>`, which is followed).
 */
import type { Change } from './store';

export interface SessionsFollowDeps {
  proxies: { sync(): void };
  adBlocking: { sync(): void };
  /**
   * After the proxies follow: each chord with a proxy of its own has its session made, as every chord's is at launch,
   * so its proxy is tried now (Carbon's SF1 on #331: never "In use" until a tab of it happens to load).
   */
  makeSessions?(): void;
}

export function followSessions(change: Pick<Change, 'patches'>, deps: SessionsFollowDeps): void {
  if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'proxy') || (p.path[0] === 'chords' && (p.path.length <= 2 || p.path[2] === 'proxy' || p.path[2] === 'profileId')))) {
    deps.proxies.sync();
    deps.makeSessions?.();
  }
  if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'adBlocking') || (p.path[0] === 'chords' && p.path[2] === 'blockingOff'))) deps.adBlocking.sync();
}
