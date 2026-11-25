/**
 * The lease on a tab of yours (control/user-watch.ts, S18 M2e-2a) through 400 random orders of what can happen to it:
 * two chats beginning and ending actions, either chat's acting ended, your hands taking the tab, DevTools taking the
 * debugger, the renderer going, frames attaching (some that can't be held), the tail timer, and a debugger that's
 * slow, fails or never answers. Its invariants are checked after every step, and once it has all settled.
 * The template: sim-kit.ts.
 */
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, it, vi } from 'vitest';
import { forSeeds, invariant, type Sim } from './sim-kit';

/** The send hold, stood in for: how many holds each tab has on (sends.ts' holdSends and unholdSends). */
const hold = vi.hoisted(() => ({ count: new Map<object, number>(), holding: false }));
vi.mock('../../src/main/control/sends', () => ({
  holdSends: (contents: object) => void hold.count.set(contents, (hold.count.get(contents) ?? 0) + 1),
  unholdSends: (contents: object) => void hold.count.set(contents, (hold.count.get(contents) ?? 0) - 1),
  failHeld: () => undefined,
  holding: () => hold.holding,
  sendHoldDeps: () => undefined,
}));

const { beginUserAction, endUserLease, userLeaseOwner, userTabActing, TAIL_MS, COMMAND_MS } = await import('../../src/main/control/user-watch');

/** A tab's debugger: slow, failing or silent as the seed says; frames attach as auto-attach is turned on. */
class FakeDebugger extends EventEmitter {
  /** Whose attachment: Chord's (attach()), someone else's (DevTools, an extension), or none. */
  by: 'chord' | 'other' | null = null;
  /** Sessions with Fetch on ('' is the page's own). */
  fetch = new Set<string>();
  autoAttach = false;
  frames = 0;
  /** Frames attached: whether each was already running (not paused at its start), and whether it's running now. */
  attached = new Map<string, { runningFromStart: boolean; running: boolean }>();
  /** A frame let run (runIfWaitingForDebugger) before its requests were held: never allowed. */
  ranUnheld: string[] = [];
  /** A Fetch.disable that failed or never answered: Fetch may be left on, which the end state allows then. */
  disableFailed = false;
  constructor(private readonly sim: Sim) {
    super();
  }
  isAttached(): boolean {
    return this.by !== null;
  }
  attach(): void {
    if (this.by) throw new Error('Another debugger is already attached');
    if (this.sim.rng.chance(0.03)) throw new Error('No target');
    this.by = 'chord';
  }
  detach(): void {
    this.by = null;
    this.fetch.clear();
    this.autoAttach = false;
    this.attached.clear();
  }
  /** Taken away from outside (DevTools opened): Electron says so with 'detach'. */
  takenAway(): void {
    this.by = 'other';
    this.fetch.clear();
    this.autoAttach = false;
    this.attached.clear();
    this.emit('detach', {}, 'replaced');
  }
  /**
   * A frame in another process, attached while auto-attach is on. A new one is paused at its start
   * (waitForDebuggerOnStart); one already there when auto-attach was turned on may be running already.
   */
  frameArrives(existing = false): void {
    if (!this.isAttached() || !this.autoAttach) return;
    const sessionId = `frame-${++this.frames}`;
    const waiting = existing ? this.sim.rng.chance(0.5) : true;
    this.attached.set(sessionId, { runningFromStart: !waiting, running: !waiting });
    this.emit('message', {}, 'Target.attachedToTarget', { sessionId, waitingForDebugger: waiting });
  }
  /** Each session's commands, answered in the order they were sent, as CDP does: the last one's settling. */
  private tails = new Map<string, Promise<unknown>>();
  /** Sessions whose page stopped answering: everything sent there after waits forever too. */
  private hung = new Set<string>();

  sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const { rng } = this.sim;
    if (!this.isAttached()) return Promise.reject(new Error('Debugger is not attached'));
    const key = sessionId ?? '';
    const fate = rng.next();
    if (fate < 0.03) this.hung.add(key);
    if (this.hung.has(key)) {
      // Never answered (a page stuck in a loop, window.print): the module's own limit (COMMAND_MS) must end it.
      if (method === 'Fetch.disable') this.disableFailed = true;
      return new Promise(() => undefined);
    }
    const before = this.tails.get(key) ?? Promise.resolve();
    const answer = before.then(
      () =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            // A frame's session that's gone (detached with auto-attach, or the debugger let go) answers nothing more.
            if (fate < 0.08 || (sessionId && fate < 0.12) || !this.isAttached() || (sessionId && !this.attached.has(key))) {
              if (method === 'Fetch.disable') this.disableFailed = true;
              return reject(new Error(`${method} failed`));
            }
            if (method === 'Fetch.enable') this.fetch.add(key);
            if (method === 'Runtime.runIfWaitingForDebugger' && sessionId) {
              if (!this.fetch.has(key)) this.ranUnheld.push(key);
              const frame = this.attached.get(key);
              if (frame) frame.running = true;
            }
            if (method === 'Fetch.disable') this.fetch.delete(key);
            if (method === 'Target.setAutoAttach' && !sessionId) {
              this.autoAttach = Boolean(params['autoAttach']);
              // Turned off, the frames it attached are detached (Chromium's TargetHandler drops its auto-attached
              // sessions): the next lease attaches them afresh. (An assumption of this fake, from Chromium's source.)
              if (!this.autoAttach) {
                for (const id of this.attached.keys()) {
                  this.fetch.delete(id);
                  this.emit('message', {}, 'Target.detachedFromTarget', { sessionId: id });
                }
                this.attached.clear();
              }
              // Frames already there are attached before auto-attach answers (Chromium sends their attachedToTarget first).
              if (this.autoAttach) for (let i = rng.int(3); i > 0; i--) this.frameArrives(true);
            }
            resolve({});
          }, rng.latency(2 * COMMAND_MS));
        }),
    );
    this.tails.set(key, answer.catch(() => undefined));
    return answer;
  }
}

class FakeTab extends EventEmitter {
  destroyed = false;
  readonly debugger: FakeDebugger;
  constructor(sim: Sim) {
    super();
    this.debugger = new FakeDebugger(sim);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

type Action = { owner: string; begun: 'on' | 'busy' | 'no'; end(): void; ended: boolean };

const OPS = ['begin A', 'begin A', 'begin B', 'end', 'end', 'stop A', 'stop B', 'your hands', 'DevTools', 'renderer gone', 'frame', 'wait', 'wait', 'wait'] as const;

describe('the lease on a tab of yours, in random orders', () => {
  it('keeps its invariants after every step, and lets go of everything once it settles (400 seeds)', { timeout: 30_000 }, async () => {
    await forSeeds(400, async (sim) => {
      const { rng } = sim;
      hold.count.clear();
      hold.holding = false;
      const tab = new FakeTab(sim);
      const contents = tab as unknown as WebContents;
      const debug = tab.debugger;
      // Sometimes someone else's client is attached already: used as it is, never detached.
      const someoneElse = rng.chance(0.2);
      if (someoneElse) debug.by = 'other';
      const actions: Action[] = [];
      let begins = 0;
      // Ends that cancel begins under way: your hands (anyone's), a chat's Stop (its own).
      const cancels = { hands: 0, A: 0, B: 0 } as Record<string, number>;
      // What a begin's answer broke: noted where it's heard, failed at the next step's check (a throw there would be lost).
      const broken: string[] = [];
      const note = (ok: boolean, what: string) => void (ok || broken.push(what));

      const check = (when: string) => {
        invariant(broken.length === 0, `${when}: ${broken.join('; ')}`);
        const owner = userLeaseOwner(contents);
        invariant(userTabActing(contents) === (owner !== null), `${when}: acting and the owner agree`);
        if (owner === null || tab.destroyed) return;
        invariant(debug.isAttached(), `${when}: a lease on (${owner}'s) has the debugger`);
        invariant(debug.fetch.has(''), `${when}: a lease on has Fetch on in the page`);
        invariant((hold.count.get(contents) ?? 0) > 0, `${when}: a lease on has the send hold`);
        invariant(debug.ranUnheld.length === 0, `${when}: a frame paused at its start was let run before it was held: ${debug.ranUnheld}`);
      };

      for (let step = 0; step < 30; step++) {
        const op = rng.pick(OPS);
        sim.log(`${step}: ${op} (owner ${userLeaseOwner(contents)}, attached ${debug.by}, fetch [${[...debug.fetch]}], holds ${hold.count.get(contents) ?? 0})`);
        if (op === 'begin A' || op === 'begin B') {
          const owner = op.slice(-1);
          const n = ++begins;
          const before = { hands: cancels['hands']!, own: cancels[owner]! };
          void beginUserAction(contents, owner, {} as never).then((action) => {
            const now = userLeaseOwner(contents);
            sim.log(`   begin #${n} (${owner}): ${action.begun}, owner now ${now}`);
            // A begin that says on is its owner's lease, then and there.
            if (action.begun === 'on') note(now === owner, `begin #${n} on for ${owner} while the owner is ${now}`);
            // A begin under way when your hands, or its chat's Stop, ended the lease never comes back on.
            if (action.begun === 'on') note(cancels['hands'] === before.hands && cancels[owner] === before.own, `begin #${n} (${owner}) on after an end that cancels it`);
            // Handed out only with every frame that was already running held: one that couldn't be means no lease.
            if (action.begun === 'on' && begins === n) {
              const unheld = [...debug.attached].filter(([id, f]) => f.runningFromStart && !debug.fetch.has(id)).map(([id]) => id);
              note(unheld.length === 0, `begin #${n} on with frames running unheld: ${unheld}`);
            }
            actions.push({ owner, begun: action.begun, end: action.end, ended: false });
          });
        } else if (op === 'end') {
          const open = actions.filter((a) => !a.ended);
          if (open.length) {
            const action = rng.pick(open);
            action.ended = true;
            action.end();
            // Ending twice does nothing.
            if (rng.chance(0.3)) action.end();
          }
        } else if (op === 'stop A' || op === 'stop B') {
          cancels[op.slice(-1)]!++;
          endUserLease(contents, op.slice(-1));
        } else if (op === 'your hands') {
          cancels['hands']!++;
          endUserLease(contents);
        }
        else if (op === 'DevTools') {
          if (debug.by === 'chord') debug.takenAway();
        } else if (op === 'renderer gone') tab.emit('render-process-gone', {}, { reason: 'crashed' });
        else if (op === 'frame') debug.frameArrives();
        else {
          hold.holding = rng.chance(0.2);
          await sim.advance(rng.chance(0.3) ? TAIL_MS + rng.int(500) : rng.int(400));
        }
        await sim.advance(0);
        check(`after step ${step} (${op})`);
      }

      // Everything ends: every action, then time runs out (the tail, any card's wait, every command's limit).
      hold.holding = false;
      for (const action of actions) if (!action.ended) action.end();
      await sim.settle();
      for (const action of actions) if (!action.ended) action.end();
      await sim.settle();
      check('settled');
      invariant(userLeaseOwner(contents) === null, 'settled: no lease is on');
      invariant((hold.count.get(contents) ?? 0) === 0, `settled: every hold let go of (${hold.count.get(contents) ?? 0} left)`);
      if (someoneElse || debug.by === 'other') invariant(debug.by === 'other', "settled: someone else's attachment is left as it was");
      else invariant(debug.by === null, 'settled: Chord let go of its own attachment');
      if (!debug.disableFailed) invariant(!debug.fetch.has('') || debug.by === null, 'settled: Fetch is off in the page');
      invariant(debug.listenerCount('message') === 0 && debug.listenerCount('detach') === 0, 'settled: no debugger listener left');
      invariant(tab.listenerCount('render-process-gone') === 0, 'settled: no tab listener left');
    });
  });
});
