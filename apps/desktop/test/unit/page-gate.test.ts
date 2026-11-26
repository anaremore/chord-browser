/**
 * #189 (round 1 of #272): what a page's first load waits for, per session: its proxy being set and its chord's
 * ad-blocking rules being on, as one promise, the same one for every page in the session while neither changes.
 */
import { describe, expect, it } from 'vitest';
import { pageGate, type Wait } from '../../src/main/page-gate';

const gateOf = <S extends object>(proxy: (s: S) => Wait, rules: (s: S) => Wait) => pageGate<S>({ proxy, rules });

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
/** How a wait ended, after a few turns: resolved, rejected, or not yet. */
const outcome = async (p: Promise<void> | null) => {
  let end = 'pending';
  void p?.then(
    () => (end = 'resolved'),
    () => (end = 'rejected'),
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return end;
};
const rejected = () => {
  const p = Promise.reject(new Error('no'));
  p.catch(() => {});
  return p;
};

describe('pageGate: one wait per session for its proxy and its ad-blocking rules', () => {
  it('neither pending: nothing to wait for', () => {
    expect(gateOf(() => null, () => null)({})).toBeNull();
  });

  it('only one pending (the proxy, or the rules): over when that one is', async () => {
    for (const which of ['proxy', 'rules']) {
      const wait = held();
      const ses = {};
      const gate = which === 'proxy' ? gateOf(() => wait.promise, () => null) : gateOf(() => null, () => wait.promise);
      const first = gate(ses);
      expect(await settled(first)).toBe(false);
      wait.resolve();
      expect(await settled(first)).toBe(true);
      expect(gate(ses)).toBeNull();
    }
  });

  it('both: one promise for every page in the session, settled once both are', async () => {
    const proxy = held();
    const rules = held();
    const ses = {};
    const gate = gateOf(() => proxy.promise, () => rules.promise);
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
    const gate = gateOf(() => proxy, () => rules);
    const first = gate(ses);
    proxy = held().promise;
    expect(gate(ses)).not.toBe(first);
  });

  it('the rules’ wait failing while the proxy is still being set (Opus’s B1 on #323): waits for the proxy, never loads around it', async () => {
    const proxy = held();
    const ses = {};
    const gate = gateOf(() => proxy.promise, () => rejected());
    const wait = gate(ses);
    expect(await outcome(wait)).toBe('pending');
    proxy.resolve();
    expect(await outcome(wait)).toBe('resolved');
  });

  it('the rules’ wait failing alone: over, as at their cap (fails open), and never a rejection', async () => {
    const ses = {};
    const failed = rejected();
    const gate = gateOf(() => null, () => failed);
    expect(await outcome(gate(ses))).toBe('resolved');
    // Asked again, the same failed wait is over.
    expect(gate(ses)).toBeNull();
  });

  it('the proxy’s wait failing: never over (fails closed), never a rejection; the rules’ settling doesn’t cut it short', async () => {
    const rules = held();
    const ses = {};
    const gate = gateOf(() => rejected(), () => rules.promise);
    const wait = gate(ses);
    rules.resolve();
    expect(await outcome(wait)).toBe('pending');
    expect(await outcome(gateOf(() => rejected(), () => null)(ses))).toBe('pending');
  });

  it('one wait pending: the same promise for every page while it is (its identity stable)', () => {
    const rules = held();
    const gate = gateOf(() => null, () => rules.promise);
    const ses = {};
    expect(gate(ses)).toBe(gate(ses));
  });

  it('a rules source answering a fresh failed wait each time (Opus’s SF2): asked again and again, it ends', async () => {
    const ses = {};
    const gate = gateOf(() => null, () => rejected());
    let asks = 0;
    for (let wait = gate(ses); wait; wait = gate(ses)) {
      if (++asks > 10) break;
      expect(await outcome(wait)).toBe('resolved');
    }
    expect(asks).toBeLessThanOrEqual(1);
  });
});
