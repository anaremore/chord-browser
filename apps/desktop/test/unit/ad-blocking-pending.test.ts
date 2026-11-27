/**
 * #189: a page's first load in a chord's session waits until that session's ad-blocking rules are on, whatever launch's
 * 3 s cap did: `pending` is what tabs.ts' whenProxied waits on, beside the proxy. The real service, with a compiled set
 * on disk and Chromium's two steps held by hand: adding the extension (loadExtension) and turning its rules on (apply).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));
vi.mock('../../src/main/launch-timeline', () => ({ mark: vi.fn() }));

const { AdBlocking, RULES_WAIT_MS } = await import('../../src/main/ad-blocking/service');
const { BlockerExtension } = await import('../../src/main/ad-blocking/extension');
const { FILTER_LISTS, setVersion } = await import('../../src/main/ad-blocking/lists');
const { mark } = await import('../../src/main/launch-timeline');

const dirs: string[] = [];
const services: Array<InstanceType<typeof AdBlocking>> = [];
/** What Chromium still holds when a test ends: answered "no" at teardown, so each service's work can finish. */
const unanswered: Array<{ reject: (error: Error) => void }> = [];
afterEach(async () => {
  // A service still writing (its Staging copy, state.json's save) when its folder goes made rmSync throw ENOTEMPTY,
  // or brought the folder back after it (#306). Chromium's held calls fail, the service stops, then the folder goes.
  for (const call of unanswered.splice(0)) call.reject(new Error('test over'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await Promise.all(services.splice(0).map((s) => s.stop()));
  vi.restoreAllMocks();
  vi.mocked(mark).mockClear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const VERSIONS = Object.fromEntries(FILTER_LISTS.map((l) => [l.id, '202611260000'])) as Record<(typeof FILTER_LISTS)[number]['id'], string>;

/** A compiled set as the build makes it (lists.json and each list's rules), and the service over it. */
function service(options: { enabled?: () => boolean; saved?: boolean; rulesWaitMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
  dirs.push(root);
  const bundledDir = join(root, 'bundled');
  mkdirSync(join(bundledDir, 'rules'), { recursive: true });
  writeFileSync(join(bundledDir, 'lists.json'), JSON.stringify({ versions: VERSIONS, refreshMs: {}, stats: {} }));
  for (const l of FILTER_LISTS) writeFileSync(join(bundledDir, 'rules', `${l.id}.json`), '[]');
  if (options.saved) {
    // A warm relaunch: last run applied this set, and the extension's folder has it.
    writeFileSync(join(root, 'state.json'), JSON.stringify({ profiles: { default: { rulesVersion: setVersion(VERSIONS), offSites: [] } } }));
    mkdirSync(join(root, 'Extension', 'default'), { recursive: true });
    writeFileSync(join(root, 'Extension', 'default', 'manifest.json'), '{}');
  }
  const enabled = options.enabled ?? (() => true);
  const blocking = new AdBlocking({ bundledDir, root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000, rulesWaitMs: options.rulesWaitMs }, { enabled: () => enabled(), offSites: () => [] });
  services.push(blocking);
  return blocking;
}

/** A promise Chromium answers when the test says. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  unanswered.push({ reject });
  return { promise, resolve, reject };
}

/** A chord's session whose loadExtension the test answers; apply (the control page) held too. */
function chromium() {
  const loads: Array<ReturnType<typeof held<{ id: string }>>> = [];
  const applies: Array<ReturnType<typeof held<void>>> = [];
  const loaded = new Set<string>();
  const session = {
    extensions: {
      getExtension: (id: string) => (loaded.has(id) ? { id } : null),
      loadExtension: vi.fn(() => {
        const load = held<{ id: string }>();
        loads.push(load);
        return load.promise.then((ext) => (loaded.add(ext.id), ext));
      }),
      removeExtension: (id: string) => void loaded.delete(id),
    },
    webRequest: { onBeforeRequest: () => undefined },
  };
  vi.spyOn(BlockerExtension.prototype, 'apply').mockImplementation(() => {
    const apply = held<void>();
    applies.push(apply);
    return apply.promise;
  });
  return { session: session as never, loads, applies };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
/** Whether `p` has settled, after the work queued so far has run. */
const settled = async (p: Promise<unknown> | null) => {
  if (!p) return true;
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return done;
};
/** `until` without timers (they may be the test's): the event loop's turns, for at most a few seconds. */
const untilTurns = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setImmediate(r));
  }
};
const allMarks = () => vi.mocked(mark).mock.calls.map(([m]) => m).filter((m) => m.startsWith('ad blocking'));
/** The release: rules on, or why its pages stopped waiting without them. */
const marks = () => allMarks().filter((m) => /^ad blocking rules (on|not on)/.test(m));

describe('ad blocking: what a page waits for (#189)', () => {
  it('a fresh profile: past launch’s cap while Chromium adds the extension, and until its rules are on, not just loaded', async () => {
    const blocking = service();
    const { session, loads, applies } = chromium();
    blocking.attach('default', session, false);
    const gate = blocking.pending(session);
    expect(gate).toBeInstanceOf(Promise);
    await until(() => loads.length === 1);
    // Launch gives up at its cap; the page keeps waiting.
    await blocking.loaded(10);
    expect(await settled(gate)).toBe(false);
    loads[0]!.resolve({ id: 'ext' });
    await until(() => applies.length === 1);
    // Loaded, rules not on yet (a fresh profile applies them): still waiting.
    expect(await settled(gate)).toBe(false);
    applies[0]!.resolve();
    expect(await settled(gate)).toBe(true);
    expect(blocking.pending(session)).toBeNull();
    // What the E2E harness hears (#321): its rules came on.
    expect(await blocking.rulesSettled()).toBe('ok');
    expect(marks()).toEqual(['ad blocking rules on (default)']);
    // Each step of a fresh profile's rules, in launch's timeline: which one took the time on a slow disk (#321, #342).
    expect(allMarks()).toEqual([
      'ad blocking rules staged (default)',
      'ad blocking rules written (default)',
      'ad blocking extension loaded (default)',
      'ad blocking rules applied (default)',
      'ad blocking rules on (default)',
    ]);
  });

  it('a warm relaunch (rules and sites as last run): released once the extension is in, no apply to wait for', async () => {
    const blocking = service({ saved: true });
    const { session, loads, applies } = chromium();
    blocking.attach('default', session, false);
    const gate = blocking.pending(session);
    await until(() => loads.length === 1);
    loads[0]!.resolve({ id: 'ext' });
    expect(await settled(gate)).toBe(true);
    expect(applies).toHaveLength(0);
    expect(marks()).toEqual(['ad blocking rules on (default)']);
  });

  it('two tabs in one session wait on one promise', async () => {
    const blocking = service();
    const { session, loads } = chromium();
    blocking.attach('default', session, false);
    expect(blocking.pending(session)).toBe(blocking.pending(session));
    // Its lists read before the test's folder goes (afterEach).
    await until(() => loads.length === 1);
  });

  it('Chromium failing to add it: released, marked failed', async () => {
    const blocking = service();
    const { session, loads } = chromium();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    blocking.attach('default', session, false);
    const gate = blocking.pending(session);
    await until(() => loads.length === 1);
    loads[0]!.reject(new Error('no'));
    expect(await settled(gate)).toBe(true);
    expect(marks()).toEqual(['ad blocking rules not on: failed (default)']);
  });

  it('blocking off: nothing to wait for when attached off, and released at once when turned off mid-wait', async () => {
    let on = false;
    const blocking = service({ enabled: () => on });
    const off = chromium();
    blocking.attach('default', off.session, false);
    expect(await settled(blocking.pending(off.session))).toBe(true);

    on = true;
    const blocking2 = service({ enabled: () => on });
    const mid = chromium();
    blocking2.attach('default', mid.session, false);
    const gate = blocking2.pending(mid.session);
    await until(() => mid.loads.length === 1);
    on = false;
    blocking2.sync();
    // Chromium still hasn't answered: the page doesn't wait for it.
    expect(await settled(gate)).toBe(true);
    expect(marks()).toContain('ad blocking rules not on: off (default)');
  });

  it('Chromium never answering: released at the 15 s cap, not a moment before, marked timeout', async () => {
    // The cap's timer on a clock the test moves (#277: 50 ms on real timers flaked under load); the files are real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The extension's own load gives up at 15 s too (extension.ts' LOAD_TIMEOUT_MS, started a moment later on this
    // clock): that failure is logged, as it is in Chord, after the cap. Kept off the test's output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const blocking = service();
      const { session, loads } = chromium();
      blocking.attach('default', session, false);
      const gate = blocking.pending(session);
      await untilTurns(() => loads.length === 1);
      vi.advanceTimersByTime(RULES_WAIT_MS - 1);
      expect(await settled(gate)).toBe(false);
      expect(marks()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(await settled(gate)).toBe(true);
      // The product's own fallback, not a failure (Carbon's B1 on #343): the harness notes it and goes on.
      expect(await blocking.rulesSettled()).toBe('timeout');
      expect(marks()).toEqual(['ad blocking rules not on: timeout (default)']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Chromium never adding the extension: its load gives up at 15 s, so the profile’s chain goes on (#277)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { session } = chromium();
      const blocker = new BlockerExtension(session, join(tmpdir(), 'chord-never-loaded'));
      let outcome = 'pending';
      blocker.load().then(
        () => (outcome = 'loaded'),
        () => (outcome = 'gave up'),
      );
      vi.advanceTimersByTime(14_999);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(outcome).toBe('pending');
      vi.advanceTimersByTime(1);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(outcome).toBe('gave up');
      expect(blocker.loaded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detached mid-wait (its window gone): released', async () => {
    const blocking = service();
    const { session, loads } = chromium();
    blocking.attach('default', session, false);
    const gate = blocking.pending(session);
    await until(() => loads.length === 1);
    blocking.detach('default');
    expect(await settled(gate)).toBe(true);
  });

  it('a private window’s session (a request handler, no extension) and a session it never saw: nothing to wait for', () => {
    const blocking = service();
    const priv = chromium().session;
    blocking.attach('private-1', priv, true);
    expect(blocking.pending(priv)).toBeNull();
    expect(blocking.pending(chromium().session)).toBeNull();
  });
});
