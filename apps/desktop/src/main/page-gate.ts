/**
 * What a page's first load waits for in its session (#189): each source's wait still pending (the proxy being set,
 * the chord's ad-blocking rules being on), as one promise. The same promise for every page in the session for as long
 * as the waits it was made from don't change. What that orders: loads that wait on that one promise go on in the order
 * they asked to wait (its callbacks run in turn). Not loads across a change: one that asked after the proxy was set
 * again waits on a new promise, which can settle before or after the old one. Within one page, tabs.ts' whenProxied
 * runs only its newest load in any case (#272, #277).
 */
export type Wait = Promise<void> | null;

export function pageGate<S extends object>(sources: ReadonlyArray<(session: S) => Wait>): (session: S) => Wait {
  const combined = new WeakMap<S, { waits: Wait[]; all: Promise<void> }>();
  return (session) => {
    const waits = sources.map((source) => source(session));
    const pending = waits.filter((w): w is Promise<void> => w !== null);
    if (pending.length <= 1) return pending[0] ?? null;
    const kept = combined.get(session);
    if (kept && kept.waits.length === waits.length && kept.waits.every((w, i) => w === waits[i])) return kept.all;
    const all = Promise.all(pending).then(() => undefined);
    combined.set(session, { waits, all });
    return all;
  };
}
