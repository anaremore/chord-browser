/**
 * #325: a proxy that can't be set never lets a page load outside it. When setProxy rejects, the session's `ready`
 * stays pending (the page gate, #323, lets a page load once a wait resolves or rejects, so neither may happen), the
 * config isn't counted as applied, setProxy is tried again, and the failure is said where the proxy is set.
 */
import type { ProxySettings } from '@chord/core';
import type { Session, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Proxies, type ProxyOwner } from '../../src/main/proxy';

const A: ProxySettings = { mode: 'server', server: { scheme: 'http', host: '10.0.0.2', port: 3128, bypass: [] }, pac: null };
const B: ProxySettings = { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.3', port: 1080, bypass: [] }, pac: null };

/** A session whose setProxy fails while `failing` says so, answering a tick later as Electron does. */
function fakeSession() {
  const state = { failing: true, calls: [] as string[], blocking: false };
  const session = {
    setProxy: (config: { mode: string; proxyRules?: string }) => {
      state.calls.push(`setProxy ${config.proxyRules ?? config.mode}`);
      const fail = state.failing;
      return new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('net::ERR_INVALID_ARGUMENT')) : resolve()), 1));
    },
    closeAllConnections: () => Promise.resolve(),
    // requests.ts' one listener: what the session sends while its proxy is failing (#331).
    webRequest: {
      onBeforeRequest: (filter: unknown, listener?: unknown) => {
        state.blocking = typeof filter === 'object' && filter !== null && typeof listener === 'function';
      },
    },
  } as unknown as Session;
  return { session, state };
}

function setup(own: ProxySettings) {
  const settings = { own };
  const contents: WebContents[] = [];
  const changed = vi.fn();
  const proxies = new Proxies();
  proxies.start({ proxyFor: (owner: ProxyOwner) => (owner === 'work' ? settings.own : { mode: 'system', server: null, pac: null }), contents: () => contents, changed });
  return { proxies, settings, contents, changed };
}

/** Whether `p` has settled (resolved or rejected) once the work queued so far has run. */
async function settled(p: Promise<unknown> | null): Promise<boolean> {
  if (!p) return true;
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a proxy that can’t be set (#325)', () => {
  it('its session’s wait neither resolves nor rejects: no page in it loads, direct or otherwise', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    const ready = proxies.ready(work.session);
    expect(ready).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls).toEqual(['setProxy http://10.0.0.2:3128']);
    expect(await settled(ready)).toBe(false);
    // Asked again, it's still the same wait: nothing new resolved in its place.
    expect(proxies.ready(work.session)).toBe(ready);
    expect(await settled(proxies.settled())).toBe(false);
  });

  it('it’s tried again, later and later, and once it takes, the wait resolves and pages load behind it', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    const ready = proxies.ready(work.session);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work.state.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(work.state.calls.length).toBe(3);
    work.state.failing = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(work.state.calls.length).toBe(4);
    expect(await settled(ready)).toBe(true);
    expect(proxies.ready(work.session)).toBeNull();
    // Taken: no more tries.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.state.calls.length).toBe(4);
  });

  it('not counted as applied: the same settings synced again try again at once, and a new proxy replaces the one failing', async () => {
    const { proxies, settings } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    const ready = proxies.ready(work.session);
    await vi.advanceTimersByTimeAsync(5);
    proxies.sync();
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls).toEqual(['setProxy http://10.0.0.2:3128', 'setProxy http://10.0.0.2:3128']);
    // Fixed in Settings: B takes, and the wait pages were held on resolves (never chained behind A's failing one).
    work.state.failing = false;
    settings.own = B;
    proxies.sync();
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.at(-1)).toBe('setProxy socks5://10.0.0.3:1080');
    expect(await settled(ready)).toBe(true);
  });

  it('WebRTC stays held to the proxy while it’s wanted but not in place: a page made meanwhile gets the strict policy', async () => {
    const { proxies, contents } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    const policies: string[] = [];
    const page = { session: work.session, isDestroyed: () => false, setWebRTCIPHandlingPolicy: (p: string) => policies.push(p) } as unknown as WebContents;
    contents.push(page);
    proxies.contentsCreated(page);
    expect(policies).toEqual(['disable_non_proxied_udp']);
  });

  it('said where the proxy is set: which owner’s proxy is failing, and why; cleared once it takes', async () => {
    const { proxies, changed } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    expect(proxies.failing()).toEqual([{ owner: 'work', reason: 'net::ERR_INVALID_ARGUMENT' }]);
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    work.state.failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proxies.failing()).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  it('Try again (Settings): tried at once, not at its next timer; only that owner’s, or with null, every one failing', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.length).toBe(1);
    proxies.retry('someone-else');
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.length).toBe(1);
    work.state.failing = false;
    proxies.retry(null);
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.length).toBe(2);
    expect(proxies.failing()).toEqual([]);
    expect(proxies.ready(work.session)).toBeNull();
  });
});

describe('#331 round 1 (Opus)', () => {
  it('B1: launch waits on each proxy taking or failing, never on one failing for good', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    const launch = proxies.settledOrFailing();
    expect(launch).not.toBeNull();
    expect(await settled(launch)).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(await settled(launch)).toBe(true);
    // The pages' own wait still holds.
    expect(await settled(proxies.ready(work.session))).toBe(false);
  });

  it('B2: while it fails, the session sends nothing on the web (every http(s) and ws(s) request cancelled); once it takes, that goes', async () => {
    const settings = { own: A };
    const proxies = new Proxies();
    proxies.start({ proxyFor: (owner: ProxyOwner) => (owner === 'work' ? settings.own : { mode: 'system', server: null, pac: null }), contents: () => [] });
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    expect(work.state.blocking).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.blocking).toBe(true);
    expect(proxies.blocked(work.session)).toBe(true);
    work.state.failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work.state.blocking).toBe(false);
    expect(proxies.blocked(work.session)).toBe(false);
  });

  it('SF1: a sync or Try again while a try is under way never forks a second chain of tries', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    for (let i = 0; i < 30; i++) {
      proxies.sync();
      proxies.retry(null);
      await vi.advanceTimersByTimeAsync(1);
    }
    const afterBurst = work.state.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    // One chain: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, 30 s… about 8 more in two minutes, not dozens.
    expect(work.state.calls.length - afterBurst).toBeLessThanOrEqual(9);
  });

  it('SF2: setProxy took but closing the old connections failed: what’s in place is known, so going back sets it again', async () => {
    const settings = { own: A as ProxySettings };
    const proxies = new Proxies();
    proxies.start({ proxyFor: (owner: ProxyOwner) => (owner === 'work' ? settings.own : { mode: 'system', server: null, pac: null }), contents: () => [] });
    const calls: string[] = [];
    let closeFails = false;
    const session = {
      setProxy: (c: { proxyRules?: string; mode: string }) => (calls.push(c.proxyRules ?? c.mode), Promise.resolve()),
      closeAllConnections: () => (closeFails ? Promise.reject(new Error('closing failed')) : Promise.resolve()),
      webRequest: { onBeforeRequest: () => {} },
    } as unknown as Session;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(session), session));
    await vi.advanceTimersByTimeAsync(5);
    closeFails = true;
    settings.own = B;
    proxies.sync();
    await vi.advanceTimersByTimeAsync(5);
    closeFails = false;
    settings.own = A;
    proxies.sync();
    await vi.advanceTimersByTimeAsync(5);
    // B was set (it took, its closing failed): going back to A sets A again, never skipped as "already in place".
    expect(calls.at(-1)).toBe('http://10.0.0.2:3128');
  });

  it('N4: the whole backoff: 1, 2, 4, 8, 16 s, then every 30 s', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    const at: number[] = [];
    let last = work.state.calls.length;
    for (let t = 0; t < 130_000; t += 500) {
      await vi.advanceTimersByTimeAsync(500);
      if (work.state.calls.length > last) {
        at.push(t + 500);
        last = work.state.calls.length;
      }
    }
    // Each gap in seconds, sampled every half second (each try takes a moment to answer): within one of the plan.
    const gaps = at.map((t, i) => (t - (i ? at[i - 1]! : 0)) / 1000);
    [1, 2, 4, 8, 16, 30, 30].forEach((want, i) => expect(Math.abs(gaps[i]! - want), `gap ${i}: ${gaps[i]} s`).toBeLessThanOrEqual(1));
  });

  it('N4: closing the old connections rejects: not taken (still held, said, tried again)', async () => {
    const settings = { own: A as ProxySettings };
    const changed = vi.fn();
    const proxies = new Proxies();
    proxies.start({ proxyFor: (owner: ProxyOwner) => (owner === 'work' ? settings.own : { mode: 'system', server: null, pac: null }), contents: () => [], changed });
    let closes = 0;
    const session = {
      setProxy: () => Promise.resolve(),
      closeAllConnections: () => (++closes === 1 ? Promise.reject(new Error('closing failed')) : Promise.resolve()),
      webRequest: { onBeforeRequest: () => {} },
    } as unknown as Session;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Made with no proxy (nothing to set), then A wanted: setProxy takes, closing rejects once.
    settings.own = { mode: 'system', server: null, pac: null };
    proxies.make('work', () => (proxies.created(session), session));
    settings.own = A;
    proxies.sync();
    const ready = proxies.ready(session);
    await vi.advanceTimersByTimeAsync(5);
    expect(await settled(ready)).toBe(false);
    expect(proxies.failing()).toEqual([{ owner: 'work', reason: 'closing failed' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled(ready)).toBe(true);
    expect(proxies.failing()).toEqual([]);
  });

  it('N-SF2: stop() (quitting): no more tries, and no more word of a failure', async () => {
    const { proxies, changed } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    proxies.stop();
    changed.mockClear();
    const calls = work.state.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    // Not even Try again (Neon's nit on #331).
    proxies.retry(null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(work.state.calls.length).toBe(calls);
    expect(changed).not.toHaveBeenCalled();
  });

  it('N-SF6: a new config wanted while one is failing: its failure isn’t said any more (still held until the new one takes)', async () => {
    const { proxies, settings, changed } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    expect(proxies.failing()).toHaveLength(1);
    changed.mockClear();
    work.state.failing = true;
    settings.own = B;
    proxies.sync();
    expect(proxies.failing()).toEqual([]);
    expect(changed).toHaveBeenCalled();
    expect(proxies.blocked(work.session)).toBe(true);
  });

  it('N-SF7: a failing proxy no live chord uses isn’t retried; a chord using it again (sync) picks it up', async () => {
    const settings = { own: A as ProxySettings };
    let used = true;
    const proxies = new Proxies();
    proxies.start({ proxyFor: (owner: ProxyOwner) => (owner === 'work' ? settings.own : { mode: 'system', server: null, pac: null }), contents: () => [], inUse: () => used });
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    used = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const calls = work.state.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(work.state.calls.length).toBe(calls);
    used = true;
    proxies.sync();
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.length).toBe(calls + 1);
  });

  it('SF2-r2: a download from main waits while the proxy is being set, and while it fails; not once it took', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    // Being set: not answered yet.
    expect(proxies.holding(work.session)).toBe(true);
    await vi.advanceTimersByTimeAsync(5);
    // Failing.
    expect(proxies.holding(work.session)).toBe(true);
    work.state.failing = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proxies.holding(work.session)).toBe(false);
  });

  it('nit: after stop(), Try again tries nothing', async () => {
    const { proxies } = setup(A);
    const work = fakeSession();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxies.make('work', () => (proxies.created(work.session), work.session));
    await vi.advanceTimersByTimeAsync(5);
    proxies.stop();
    const calls = work.state.calls.length;
    proxies.retry(null);
    await vi.advanceTimersByTimeAsync(5);
    expect(work.state.calls.length).toBe(calls);
  });

  it('a try queued behind another for a config no longer wanted is skipped: never set over the newer one (Opus’s nit, round 2)', async () => {
    const C: ProxySettings = { mode: 'server', server: { scheme: 'http', host: '10.0.0.4', port: 8080, bypass: [] }, pac: null };
    const { proxies, settings } = setup(A);
    const work = fakeSession();
    work.state.failing = false;
    proxies.make('work', () => (proxies.created(work.session), work.session));
    // A is being set (it answers a tick later); B is wanted, then C, before A answers.
    settings.own = B;
    proxies.sync();
    settings.own = C;
    proxies.sync();
    await vi.advanceTimersByTimeAsync(20);
    expect(work.state.calls).toEqual(['setProxy http://10.0.0.2:3128', 'setProxy http://10.0.0.4:8080']);
    expect(proxies.ready(work.session)).toBeNull();
  });
});

