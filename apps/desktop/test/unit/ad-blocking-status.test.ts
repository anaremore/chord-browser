/**
 * #284: Settings → Privacy says which chords' ad blocking didn't come on (adding the extension failed or never answered
 * in time, or writing or applying the rules failed, or they weren't on by the 15 s cap): their pages load without it.
 * `status().notOn` lists their profiles, each failed or being tried again; a profile leaves the list once its rules are
 * on, and `retry` tries again.
 * The real service, with a compiled set on disk and Chromium's two steps (loadExtension, apply) answered by hand.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));
vi.mock('../../src/main/launch-timeline', () => ({ mark: vi.fn() }));

const { AdBlocking, RULES_WAIT_MS } = await import('../../src/main/ad-blocking/service');
const { BlockerExtension } = await import('../../src/main/ad-blocking/extension');
const { FILTER_LISTS } = await import('../../src/main/ad-blocking/lists');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(enabled: () => boolean = () => true) {
  const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
  dirs.push(root);
  const bundledDir = join(root, 'bundled');
  mkdirSync(join(bundledDir, 'rules'), { recursive: true });
  writeFileSync(join(bundledDir, 'lists.json'), JSON.stringify({ versions: Object.fromEntries(FILTER_LISTS.map((l) => [l.id, '202611260000'])), refreshMs: {}, stats: {} }));
  for (const l of FILTER_LISTS) writeFileSync(join(bundledDir, 'rules', `${l.id}.json`), '[]');
  return new AdBlocking({ bundledDir, root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000 }, { enabled: () => enabled(), offSites: () => [] });
}

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A chord's session whose loadExtension the test answers, each call in turn; apply answers at once. */
function chromium() {
  const loads: Array<ReturnType<typeof held<{ id: string }>>> = [];
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
  vi.spyOn(BlockerExtension.prototype, 'apply').mockResolvedValue(undefined);
  return { session: session as never, loads };
}

/** The event loop's turns (no timers: they may be the test's), until `ok`. */
const until = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setImmediate(r));
  }
};
const turns = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('Settings: the chords whose ad blocking didn’t come on (#284)', () => {
  it('on: nothing listed; still starting (within its wait): nothing listed either', async () => {
    const blocking = service();
    const { session, loads } = chromium();
    blocking.attach('default', session, false);
    await until(() => loads.length === 1);
    expect(blocking.status().notOn).toEqual([]);
    loads[0]!.resolve({ id: 'ext' });
    await blocking.pending(session);
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([]);
  });

  it('Chromium failing to add it: listed as failed, the other chord not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const blocking = service();
    const work = chromium();
    const home = chromium();
    // One after the other: side by side they share one staging folder on main until #281 (#274).
    blocking.attach('home', home.session, false);
    await until(() => home.loads.length === 1);
    home.loads[0]!.resolve({ id: 'ext' });
    await blocking.settled();
    blocking.attach('work', work.session, false);
    await until(() => work.loads.length === 1);
    work.loads[0]!.reject(new Error('no'));
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'failed' }]);
  });

  it('not on by the cap (its pages loaded without it): listed as failed; off the list once its rules come on after all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const blocking = service();
    const { session, loads } = chromium();
    // Added, but turning its rules on takes past the cap.
    const apply = held<void>();
    vi.spyOn(BlockerExtension.prototype, 'apply').mockReturnValue(apply.promise);
    blocking.attach('work', session, false);
    await until(() => loads.length === 1);
    loads[0]!.resolve({ id: 'ext' });
    await turns();
    expect(blocking.status().notOn).toEqual([]);
    vi.advanceTimersByTime(RULES_WAIT_MS);
    await turns();
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'failed' }]);
    apply.resolve();
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([]);
  });

  it('Try again: listed as retrying at once; off the list when it comes on, back to failed when it fails again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const blocking = service();
    const { session, loads } = chromium();
    blocking.attach('work', session, false);
    await until(() => loads.length === 1);
    loads[0]!.reject(new Error('no'));
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'failed' }]);

    blocking.retry('work');
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'retrying' }]);
    await until(() => loads.length === 2);
    loads[1]!.reject(new Error('still no'));
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'failed' }]);

    blocking.retry('work');
    await until(() => loads.length === 3);
    loads[2]!.resolve({ id: 'ext' });
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([]);
    expect(blocking.inspect().profiles['work']?.applied).toBe(true);
  });

  it('blocking turned off: nothing listed (nothing to block); a private window’s session or a closed one never listed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let on = true;
    const blocking = service(() => on);
    const { session, loads } = chromium();
    blocking.attach('work', session, false);
    blocking.attach('private-1', chromium().session, true);
    await until(() => loads.length === 1);
    loads[0]!.reject(new Error('no'));
    await blocking.settled();
    expect(blocking.status().notOn).toEqual([{ profileId: 'work', state: 'failed' }]);
    on = false;
    blocking.sync();
    expect(blocking.status().notOn).toEqual([]);
    on = true;
    blocking.detach('work');
    expect(blocking.status().notOn).toEqual([]);
  });

  it('Try again on a profile that isn’t listed (on, or unknown): nothing happens', async () => {
    const blocking = service();
    const { session, loads } = chromium();
    blocking.attach('work', session, false);
    await until(() => loads.length === 1);
    loads[0]!.resolve({ id: 'ext' });
    await blocking.settled();
    blocking.retry('work');
    blocking.retry('nobody');
    await turns();
    expect(loads).toHaveLength(1);
    expect(blocking.status().notOn).toEqual([]);
  });
});
