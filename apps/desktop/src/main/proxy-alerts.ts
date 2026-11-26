/**
 * #325: a proxy that can't be set, said where it matters (the owner's pick, 2026-11-26). Settings → Privacy → Proxy
 * lists it (a chord's own by its chord's name, or the one for every chord), and the windows whose pages it holds get
 * one toast when it starts failing, never again while it goes on failing.
 */
import type { ProxyStatus } from '@chord/ipc';
import type { ProxyOwner } from './proxy';

/** A chord as these need it: in switcher order. */
export interface ProxyChord {
  id: string;
  name: string;
  profileId: string;
  /** Its own proxy, if it has one. */
  own: boolean;
}

/**
 * Settings' list: each chord's own proxy failing, by its chord; and the proxy for every chord, once, with the chords
 * that use it (a profile without a chord's own proxy, or Chord's own requests).
 */
export function proxyStatus(failing: readonly { owner: ProxyOwner; reason: string }[], chords: readonly ProxyChord[]): ProxyStatus {
  const out: ProxyStatus['failing'] = [];
  let shared: ProxyStatus['failing'][number] | null = null;
  for (const { owner, reason } of failing) {
    const theirs = chords.filter((c) => c.profileId === owner);
    if (theirs.some((c) => c.own)) {
      out.push({ owner, own: true, chordIds: theirs.filter((c) => c.own).map((c) => c.id), reason });
      continue;
    }
    shared ??= { owner: null, own: false, chordIds: [], reason };
    for (const c of theirs) if (!shared.chordIds.includes(c.id)) shared.chordIds.push(c.id);
  }
  if (shared) {
    // In switcher order.
    const order = new Map(chords.map((c, i) => [c.id, i]));
    shared.chordIds.sort((a, b) => order.get(a)! - order.get(b)!);
    out.unshift(shared);
  }
  return { failing: out };
}

/** The toast for a proxy that's failing: the chords whose windows get it, and where its Settings opens. */
export interface ProxyToast {
  key: string;
  chordIds: string[];
  message: string;
  /** Its Settings: a chord's own proxy (that chord), or the one for every chord (null). */
  chordId: string | null;
  /** The proxy for every chord holds private windows' pages too. */
  privateToo: boolean;
}

/**
 * Each failing proxy's toast, once per window (Neon's N-SF5, Opus's SF3 on #331): counted as shown in a window only
 * once that window got it, so a failure before any window was open toasts in the first one that is.
 */
export class ProxyAlerts {
  private readonly shown = new Map<string, Set<string>>();

  /** Every proxy failing now, with its toast; one that took (or went) is forgotten, so failing again toasts again. */
  due(status: ProxyStatus, chords: readonly ProxyChord[]): ProxyToast[] {
    const out: ProxyToast[] = [];
    for (const f of status.failing) {
      const key = f.own ? `own:${f.owner}` : 'all';
      if (f.chordIds.length === 0 && f.own) continue;
      const chordId = f.own ? f.chordIds[0]! : null;
      const name = chordId ? chords.find((c) => c.id === chordId)?.name : null;
      out.push({
        key,
        chordIds: f.chordIds,
        chordId,
        privateToo: !f.own,
        message: name ? `${name}’s proxy isn’t working. Its pages are waiting.` : 'The proxy isn’t working. Pages are waiting.',
      });
    }
    const now = new Set(out.map((t) => t.key));
    for (const key of [...this.shown.keys()]) if (!now.has(key)) this.shown.delete(key);
    return out;
  }

  /** Whether that window got this toast already. */
  shownIn(key: string, windowId: string): boolean {
    return this.shown.get(key)?.has(windowId) ?? false;
  }

  /** These windows got it. */
  showed(key: string, windowIds: readonly string[]): void {
    if (!windowIds.length) return;
    const set = this.shown.get(key) ?? new Set<string>();
    for (const id of windowIds) set.add(id);
    this.shown.set(key, set);
  }
}
