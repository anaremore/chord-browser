/**
 * What a page's first load waits for in its session (#189): its proxy being set, and its chord's ad-blocking rules
 * being on, as one promise. The gate is the boundary for how either can fail (Opus's B1, round 1 of #323):
 * - The rules failing fails open, as at their 15 s cap: the page loads without them (Settings → Privacy says so,
 *   #284), and from then on they don't hold that session's pages (as after the cap).
 * - The proxy failing fails closed: its pages keep waiting, and never load around it with the real address. One
 *   source failing never cuts the other's wait short.
 *
 * The contract, for tabs.ts' whenProxied, the pop-out window and the toolbar popup:
 * - Null when there's nothing (left) to wait for.
 * - Otherwise the same promise for every page in the session for as long as the waits it was made from don't change,
 *   so loads that wait on it go on in the order they asked (its callbacks run in turn). Not loads across a change: one
 *   that asked after the proxy was set again waits on a new promise, which can settle before or after the old one.
 *   Within one page, whenProxied runs only its newest load in any case (#272, #277).
 * - It never rejects. The consumers' own handling of a rejected wait (#299) is only a backstop.
 */
export type Wait = Promise<void> | null;

export interface GateSources<S> {
  /** The session's proxy being set (proxy.ts' ready). Fails closed. */
  proxy(session: S): Wait;
  /** The session's ad-blocking rules being on (ad-blocking/service.ts' pending). Fails open. */
  rules(session: S): Wait;
}

/** A source's wait as the gate gives it: wrapped once, so its identity is stable while the source's is. */
interface Kept {
  raw: Promise<void>;
  wait: Promise<void>;
  over: boolean;
}

export function pageGate<S extends object>(sources: GateSources<S>): (session: S) => Wait {
  const kept = { proxy: new WeakMap<S, Kept>(), rules: new WeakMap<S, Kept>() };
  // Sessions whose rules failed: like after their cap, they no longer hold the session's pages. Also what keeps a
  // source that answers a fresh failed wait each time from being waited on forever (Opus's SF2).
  const rulesFailed = new WeakSet<S>();
  const combined = new WeakMap<S, { proxy: Promise<void>; rules: Promise<void>; all: Promise<void> }>();

  const waitOf = (which: keyof GateSources<S>, session: S): Promise<void> | null => {
    if (which === 'rules' && rulesFailed.has(session)) return null;
    const raw = sources[which](session);
    if (!raw) return null;
    let k = kept[which].get(session);
    if (k?.raw !== raw) {
      const entry: Kept = { raw, wait: Promise.resolve(), over: false };
      entry.wait = raw.then(
        () => void (entry.over = true),
        (error: unknown) => {
          if (which === 'rules') {
            rulesFailed.add(session);
            entry.over = true;
            return;
          }
          // Never over: a page that loaded now would go out without its proxy.
          console.error('A session’s proxy couldn’t be set; its pages wait for it:', error);
          return new Promise<void>(() => {});
        },
      );
      kept[which].set(session, entry);
      k = entry;
    }
    return k.over ? null : k.wait;
  };

  return (session) => {
    const proxy = waitOf('proxy', session);
    const rules = waitOf('rules', session);
    if (!proxy || !rules) return proxy ?? rules;
    const pair = combined.get(session);
    if (pair?.proxy === proxy && pair.rules === rules) return pair.all;
    // allSettled, though neither rejects: one ending never ends the other's wait.
    const all = Promise.allSettled([proxy, rules]).then(() => undefined);
    combined.set(session, { proxy, rules, all });
    return all;
  };
}
