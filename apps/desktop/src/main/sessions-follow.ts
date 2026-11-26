/**
 * What every session follows in the settings, before anything uses them (#328): its proxy (the proxy for every chord, a
 * chord's own, and which sign-ins each chord has, a chord added or gone included), and ad blocking (its switch, and the
 * sites it's off for; a private window's own list lives on its chord).
 *
 * index.ts runs this from a store listener subscribed first (Store.subscribeFirst), so it comes before Browser's effects:
 * a tab made again in a session (Undo of a change of sign-ins, a chord restored) waits for that session's proxy, and
 * never loads before it's set.
 */
import type { Change } from './store';

export interface SessionsFollowDeps {
  proxies: { sync(): void };
  adBlocking: { sync(): void };
}

export function followSessions(change: Pick<Change, 'patches'>, deps: SessionsFollowDeps): void {
  if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'proxy') || (p.path[0] === 'chords' && (p.path.length <= 2 || p.path[2] === 'proxy' || p.path[2] === 'profileId')))) {
    deps.proxies.sync();
  }
  if (change.patches.some((p) => (p.path[0] === 'settings' && p.path[1] === 'adBlocking') || (p.path[0] === 'chords' && p.path[2] === 'blockingOff'))) deps.adBlocking.sync();
}
