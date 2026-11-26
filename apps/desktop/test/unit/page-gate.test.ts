/**
 * #189 (round 1 of #272): what a page's first load waits for, per session: its proxy being set and its chord's
 * ad-blocking rules being on, as one promise, the same one for every page in the session while neither changes.
 */
import { describe, expect, it } from 'vitest';
import { pageGate } from '../../src/main/page-gate';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const settled = async (p: Promise<void> | null) => {
  let done = false;
  void p?.then(() => (done = true));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe('pageGate: one wait per session for its proxy and its ad-blocking rules', () => {
  it('neither pending: nothing to wait for', () => {
    expect(pageGate([() => null, () => null])({})).toBeNull();
  });

  it('only one pending (the proxy, or the rules): that one', () => {
    const p = held().promise;
    expect(pageGate([() => p, () => null])({})).toBe(p);
    expect(pageGate([() => null, () => p])({})).toBe(p);
  });

  it('both: one promise for every page in the session, settled once both are', async () => {
    const proxy = held();
    const rules = held();
    const ses = {};
    const gate = pageGate([() => proxy.promise, () => rules.promise]);
    const first = gate(ses);
    expect(gate(ses)).toBe(first);
    expect(gate({})).not.toBe(first);
    proxy.resolve();
    expect(await settled(first)).toBe(false);
    rules.resolve();
    expect(await settled(first)).toBe(true);
  });

  it('a wait that changes (the proxy set again): a new combined promise', () => {
    let proxy = held().promise;
    const rules = held().promise;
    const ses = {};
    const gate = pageGate([() => proxy, () => rules]);
    const first = gate(ses);
    proxy = held().promise;
    expect(gate(ses)).not.toBe(first);
  });
});
