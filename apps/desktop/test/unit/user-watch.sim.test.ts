/**
 * The lease on a tab of yours (control/user-watch.ts), under seeded interleavings: two chats beginning and ending
 * actions, a chat's Stop, your hands, the debugger let go, the renderer gone, the page sending, the clipboard changed and
 * time passing, in every order a seed picks. After each step, what must always hold (the reviews of #147; M2e-2b):
 *
 * - one owner at most, and `userTabActing` only while it's catching;
 * - nothing the page sends is left unanswered once no lease is on, and nothing sent outside an action's tail is held;
 * - once every lease is over: Chord's own attachment let go, the service worker back, the clipboard as you left it
 *   unless you changed it.
 *
 * A failure names its seed and the steps that led there: `SIM_SEED=<n>` runs that one alone; `SIM_SEEDS=<n>` runs more.
 * Checked against two broken leases: an action's end that reaches a later lease fails here (seed 47). A stale cleanup
 * that tears the next lease down only makes that lease lost (closed, not open), and needs a stop at the very moment of
 * handout, which a step here can't reach: assistant-acting.test.ts covers it (Neon's B4, round 3 of #147).
 */
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendHoldDeps } from '../../src/main/control/sends';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {}, net: {}, nativeImage: {}, ClipboardItem: class {} }));
const watch = await import('../../src/main/control/user-watch');

afterEach(() => vi.useRealTimers());

/** A small seeded generator (mulberry32): the same seed, the same run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tab of yours whose debugger answers at once, keeping what it was asked, and whether Fetch is on. */
function tab() {
  const debug = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://game.example/table', debugger: debug }) as unknown as WebContents;
  const state = { attached: false, fetch: false, bypass: false, answered: new Map<string, string>(), paused: new Set<string>(), failNext: false };
  Object.assign(debug, {
    isAttached: () => state.attached,
    attach: () => {
      if (state.attached) throw new Error('Another debugger is already attached');
      state.attached = true;
    },
    detach: () => {
      if (!state.attached) return;
      state.attached = false;
      state.fetch = false;
      state.bypass = false;
      // Chromium lets go of what it had paused when its debugger detaches (the record's stated limit).
      for (const id of state.paused) if (!state.answered.has(id)) state.answered.set(id, 'detached');
      debug.emit('detach', {}, 'target closed');
    },
    sendCommand: async (method: string, params: { requestId?: string; bypass?: boolean }, sessionId?: string) => {
      if (!state.attached) throw new Error('not attached');
      // A catch that can't be turned on (the next set-up's WebAuthn): the lease fails closed.
      if (state.failNext && method === 'WebAuthn.enable' && !sessionId) {
        state.failNext = false;
        throw new Error('not supported');
      }
      if (sessionId) return;
      if (method === 'Fetch.enable') state.fetch = true;
      if (method === 'Fetch.disable') state.fetch = false;
      if (method === 'Network.setBypassServiceWorker') state.bypass = Boolean(params.bypass);
      if (params?.requestId && method.startsWith('Fetch.')) state.answered.set(params.requestId, method);
    },
  });
  return { contents, debug, state };
}

const ANSWERS: Awaited<ReturnType<SendHoldDeps['ask']>>[] = ['once', 'deny', 'until'];
const flush = () => vi.advanceTimersByTimeAsync(0);

async function run(seed: number, steps: number): Promise<string[]> {
  vi.useFakeTimers();
  const rnd = random(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const t = tab();
  const log: string[] = [];
  /** Actions under way, each with its own end and the lease it began on (by the sim's count of leases). */
  const actions: { owner: string; end: () => void; lease: number }[] = [];
  /** Begins still under way (queued or setting up), resolved by a later step. */
  const inflight: Promise<void>[] = [];
  /** The lease on now, by the sim's own count (a new one each time catching starts again), or null. */
  let current: number | null = null;
  let leasesSeen = 0;
  const took = (owner: string, action: Awaited<ReturnType<typeof watch.beginUserAction>>) => {
    if (action.begun !== 'on') return;
    if (current === null) current = ++leasesSeen;
    actions.push({ owner, end: action.end, lease: current });
  };
  let clip = 'yours';
  /** The clipboard as the lease that's on began, and whether the page changed it during that lease (not you since). */
  let clipAtStart = clip;
  let clipDirty = false;
  let wasCatching = false;
  const deps = (owner: string) => ({
    siteOf: (u: string) => new URL(u).origin,
    // The chat's card: answered after a while, or never.
    ask: (() => {
      const answer = pick(ANSWERS);
      const after = Math.floor(rnd() * 3000);
      return () => new Promise<Awaited<ReturnType<SendHoldDeps['ask']>>>((done) => setTimeout(() => done(answer), after));
    })(),
    note: () => undefined,
    // A download card: answered after a while, or not before the lease would end.
    askDownload: () => new Promise<boolean>((done) => setTimeout(() => done(rnd() < 0.5), Math.floor(rnd() * 50_000))),
    clipboard: { read: () => clip, write: (text: string) => void (clip = text) },
    kept: owner === 'chat:1' ? new Set<string>() : undefined,
  });
  let requests = 0;
  const pending = new Set<string>();

  let lastClipAtBegin = clip;
  const check = (step: string) => {
    const where = `seed ${seed}, after ${log.length} steps (${log.slice(-6).join(' · ')})`;
    const owner = watch.userLeaseOwner(t.contents);
    const catching = watch.userTabCatching(t.contents);
    expect(Boolean(owner), `${where}: an owner iff catching`).toBe(catching);
    if (watch.userTabActing(t.contents)) expect(catching, `${where}: acting only while catching`).toBe(true);
    // No lease, and its cleanup done: nothing left waiting on an answer.
    if (!catching && !t.state.fetch) for (const id of pending) expect(t.state.answered.has(id), `${where}: ${id} left unanswered (${step})`).toBe(true);
    if (!catching) current = null;
    // The page's change to the clipboard during a lease is put back by the time it's over, unless your input ended it.
    if (catching && !wasCatching) clipAtStart = lastClipAtBegin;
    if (!catching && clipDirty) {
      expect(clip, `${where}: the clipboard left as the page made it`).toBe(clipAtStart);
      clipDirty = false;
    }
    wasCatching = catching;
    // An action still under way on the lease that's on: it's acting there (never its tail started early, never let go).
    if (current !== null && actions.some((a) => a.lease === current)) expect(watch.userTabActing(t.contents), `${where}: an action under way, not acting`).toBe(true);
    // A lease that's on holds the tab: attached, Fetch on (else what the page sends would go unheld).
    if (catching) expect(t.state.attached && t.state.fetch, `${where}: a lease on with the tab not held`).toBe(true);
  };

  for (let i = 0; i < steps; i++) {
    const op = pick(['begin', 'begin', 'settle', 'end', 'end', 'stop', 'hands', 'detach', 'gone', 'post', 'post', 'clipboard', 'download', 'frame', 'failing', 'time', 'time'] as const);
    if (op === 'begin') {
      const owner = pick(['chat:1', 'chat:2']);
      log.push(`begin ${owner}`);
      if (!watch.userTabCatching(t.contents)) lastClipAtBegin = clip;
      const begun = watch.beginUserAction(t.contents, owner, deps(owner) as never);
      if (rnd() < 0.3) {
        // Something else happens while it's being had: your key, or the chat's Stop.
        if (rnd() < 0.5) {
          watch.endUserLease(t.contents);
          clipDirty = false;
        } else watch.endUserLease(t.contents, owner);
        log.push('…ended while beginning');
      }
      // Half the time it's left under way, and other steps go on meanwhile.
      if (rnd() < 0.5) took(owner, await begun);
      else inflight.push(begun.then((a) => took(owner, a)));
    } else if (op === 'settle' && inflight.length) {
      log.push('begins settle');
      await Promise.all(inflight.splice(0));
    } else if (op === 'end' && actions.length) {
      const a = actions.splice(Math.floor(rnd() * actions.length), 1)[0]!;
      log.push(`end ${a.owner}`);
      a.end();
      // Ending twice is never a second end.
      if (rnd() < 0.3) a.end();
    } else if (op === 'stop') {
      const owner = pick(['chat:1', 'chat:2']);
      log.push(`stop ${owner}`);
      watch.endUserLease(t.contents, owner);
    } else if (op === 'hands') {
      log.push('your key');
      watch.endUserLease(t.contents);
      // What's on the clipboard as you take the tab is yours from here.
      clipDirty = false;
    } else if (op === 'detach') {
      log.push('detach');
      (t.debug as unknown as { detach(): void }).detach();
    } else if (op === 'gone') {
      log.push('renderer gone');
      (t.contents as unknown as EventEmitter).emit('render-process-gone', {}, { reason: 'crashed' });
    } else if (op === 'post' && t.state.fetch) {
      const id = `r${++requests}`;
      pending.add(id);
      t.state.paused.add(id);
      log.push(`post ${id}`);
      t.debug.emit('message', {}, 'Fetch.requestPaused', { requestId: id, request: { method: 'POST', url: 'https://game.example/move' }, resourceType: 'XHR' });
    } else if (op === 'clipboard') {
      clip = `page-${i}`;
      if (watch.userTabCatching(t.contents)) clipDirty = true;
      log.push('the page wrote the clipboard');
    } else if (op === 'failing') {
      log.push('the next catch fails');
      t.state.failNext = true;
    } else if (op === 'download') {
      log.push('a download');
      void watch.askUserTabDownload(t.contents, { filename: 'file.zip', url: 'https://files.example/file.zip' });
    } else if (op === 'frame' && t.state.attached) {
      log.push('a frame');
      t.debug.emit('message', {}, 'Target.attachedToTarget', { sessionId: `f${i}`, waitingForDebugger: true, targetInfo: { type: 'iframe' } });
    } else if (op === 'time') {
      const ms = pick([10, 300, 1600, 6500, 46_000]);
      log.push(`+${ms} ms`);
      await vi.advanceTimersByTimeAsync(ms);
    }
    await flush();
    check(op);
  }

  // The end: every begin settled, every action ended, the lease let go, time enough for every tail and card.
  await Promise.all(inflight.splice(0));
  for (const a of actions.splice(0)) a.end();
  // Each chat ends (not your input: the clipboard is put back).
  watch.endUserLease(t.contents, 'chat:1');
  watch.endUserLease(t.contents, 'chat:2');
  await vi.advanceTimersByTimeAsync(60_000);
  await flush();
  const where = `seed ${seed}, at the end (${log.slice(-8).join(' · ')})`;
  expect(watch.userTabCatching(t.contents), `${where}: still catching`).toBe(false);
  expect(t.state.attached, `${where}: Chord's attachment not let go`).toBe(false);
  expect(t.state.bypass, `${where}: the service worker not back`).toBe(false);
  for (const id of pending) expect(t.state.answered.has(id), `${where}: ${id} never answered`).toBe(true);
  if (clipDirty) expect(clip, `${where}: the clipboard left as the page made it`).toBe(clipAtStart);
  return log;
}

describe('The lease under seeded interleavings (M2e-2a and 2b)', () => {
  const only = process.env['SIM_SEED'];
  const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env['SIM_SEEDS'] ?? 150) }, (_, i) => i + 1);
  it(`${seeds.length} seeds × 40 steps: one owner, nothing left waiting, everything let go at the end`, async () => {
    for (const seed of seeds) await run(seed, 40);
  }, 120_000);
});
