/**
 * #143: a step's Send data cards past its call's deadline.
 *
 * An outside agent's call answers within its deadline (connection.ts' CALL_WAIT_MS, under every client's own
 * timeout). A step's Send data cards come after its input, and the user takes the time they take (sendWaitMs). So
 * when a card is up at the deadline (or one opens after it), once the step's input is done, the call answers that the
 * step ran and what it sent waits (ACT_SENDS_WAITING), and the step's cards are handed over: one HandedOver, which
 * goes on unchanged for the user until its one exit, `settle`.
 *
 * States: waiting (the tab's in memory.sendsWaiting: no other action there; its cards up as before), then settled
 * (once, for good). Every way out goes through `settle(why)`:
 * - the cards' own end (askHeld): Allow (`allowed`), Allow then a later card's Don't or no answer (some went), Don't
 *   (`no`), no answer (`no-answer`), the page sending to too many sites (`too-many`);
 * - what's live, checked first and against the live store, never a TabNode taken earlier: the tab closed (`closed`),
 *   Stop (`stopped`), the user taking the tab (`took-over`), the hold failed with no other reason (`ended`: the
 *   agent's session over, Keep);
 * - the page leaving its document while something is still held or a card is up (`moved-on`);
 * - anything else (`unchecked`).
 * `settle` drops what wasn't allowed, takes any card still up down, ends the watch (anything held after it is the
 * tab's, asked between actions as before), clears sendsWaiting, and records one entry (sendsLater) for the agent's
 * next result: never the answer of the call that handed over, which says it waits.
 */
import { ACT_REFUSALS, CONTROL_REFUSALS, ELEMENT_REFUSALS, sendsLater, toolResult, type NodeId, type SendsLater, type SendsWhy } from '@chord/core';
import type { ControlAgent } from './gate';
import type { ToolMemory } from './scope';
import type { SendWatch } from './sends';

/**
 * A step's Send data cards, as askHeld asks them: one is up only once the gate really shows it (the tab's cards list
 * it), never while its ask is merely pending (a call already stopped answers at once, with no card: Neon's B5). The
 * gate opens a card synchronously as it's asked, so an ask that opened one says so at once (opened): nothing polls
 * (round 2 of #266, blocker 1).
 */
export class OpenCards {
  private pending = 0;
  /** The ids of the cards its asks opened (the gate lists one on the tab as it opens it). */
  private readonly mine = new Set<string>();
  private readonly waiting = new Set<() => void>();
  constructor(
    private readonly agent: ControlAgent,
    private readonly nodeId: NodeId,
  ) {}
  /** A card's ask, counted while it's pending; a card it opened, told to whoever waits for one. */
  ask<A extends unknown[], R>(ask: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args) => {
      this.pending++;
      const before = new Set(this.agent.state(this.nodeId).cards);
      const asked = ask(...args);
      for (const id of this.agent.state(this.nodeId).cards) if (!before.has(id)) this.mine.add(id);
      if (this.isUp()) for (const wake of [...this.waiting]) wake();
      return asked.finally(() => this.pending--);
    };
  }
  /** A Send data card of this step's is up now: shown by the gate, its ask still waiting. */
  isUp(): boolean {
    if (this.pending === 0) return false;
    const up = this.agent.state(this.nodeId).cards;
    return [...this.mine].some((id) => up.includes(id));
  }
  /** Resolves when one is up (at once if one is); stops waiting, unresolved, when `stop` aborts. */
  opened(stop: AbortSignal): Promise<void> {
    if (this.isUp()) return Promise.resolve();
    return new Promise((done) => {
      const forget = () => this.waiting.delete(wake);
      const wake = () => {
        forget();
        stop.removeEventListener('abort', forget);
        done();
      };
      this.waiting.add(wake);
      stop.addEventListener('abort', forget, { once: true });
    });
  }
}

/**
 * The watch, with its Allows counted where they let requests go (`w.allow`, which askHeld calls only once its `halt`
 * passed): never a card's yes that `halt` then refused (the page moved on, the hold lost, Stop), which sends nothing
 * (round 2 of #266, blocker 2).
 */
export function countAllows(w: SendWatch): { watch: SendWatch; allowed: () => number } {
  let allowed = 0;
  const watch: SendWatch = {
    held: () => w.held(),
    sitesOf: (urls) => w.sitesOf(urls),
    nextHeld: () => w.nextHeld(),
    cancelled: w.cancelled,
    allow: (grant) => {
      const before = w.held().length;
      w.allow(grant);
      if (w.held().length < before) allowed++;
    },
    deny: () => w.deny(),
    end: () => w.end(),
  };
  return { watch, allowed: () => allowed };
}

/**
 * The step's cards (askHeld's `sending`), by the call's deadline. Answered by then: their outcome, as before (`sent`:
 * null, or the refusal). A card up at the deadline or after it: `{ later: true }` once the step's input is done
 * (`inputDone`: never a hand-over mid-input, whose own refusal could follow), and the caller hands over (HandedOver)
 * or, with a refusal of its own after all, takes the cards down. Past the deadline with the input done, no card up and
 * nothing held (`held`): `{ past: true }`, and the caller answers now, never after the page's load (round 2 of #266,
 * should-fix 6); it ends the watch, so what the page sends after is the tab's, asked between actions. Never a hand-over
 * with no card up, and nothing left waiting or looking once it returns.
 */
export async function byDeadline(sending: Promise<string | null>, deadline: number | null, cards: OpenCards, inputDone: Promise<unknown>, held: () => number): Promise<{ later: false; sent: string | null } | { later: true } | { past: true }> {
  if (deadline === null) return { later: false, sent: await sending };
  const answered = sending.then((sent) => ({ sent }));
  const input = inputDone.then(
    () => 'input' as const,
    () => 'input' as const,
  );
  const over = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const due = new Promise<'due'>((done) => {
      timer = setTimeout(() => done('due'), Math.max(0, deadline - Date.now()));
      timer.unref?.();
    });
    const first = await Promise.race([answered, due]);
    if (first !== 'due') return { later: false, sent: first.sent };
    // Past the deadline: the input first (its own refusal comes before any hand-over).
    const after = await Promise.race([answered, input]);
    if (after !== 'input') return { later: false, sent: after.sent };
    for (;;) {
      if (cards.isUp()) return { later: true };
      if (held() === 0) return { past: true };
      // Something held, its card not up yet: until it opens, or the cards end.
      const next = await Promise.race([answered, cards.opened(over.signal).then(() => 'up' as const)]);
      if (next !== 'up') return { later: false, sent: next.sent };
    }
  } finally {
    clearTimeout(timer);
    over.abort();
  }
}

/** What the hand-over needs: the step, its cards, and how to tell what's live. */
export interface HandOverOf {
  nodeId: NodeId;
  /** The agent's handle for the tab (`a1`). */
  tab: string;
  tool: string;
  /** The step in the page's words (`Clicked “Dark mode”`): only ever inside the untrusted envelope. */
  step: string;
  w: SendWatch;
  cards: OpenCards;
  /** How many of its cards' Allows let requests go (countAllows): a partial outcome only with one. */
  allowed(): number;
  /** Aborted by settle: the step's cards still up come down (askSendCard's signal). */
  cardsEnd: AbortController;
  memory: ToolMemory;
  /** The call that handed over (scope.callToken): its own answer never carries the outcome. */
  from: object | undefined;
  /** What's live now, first in every outcome: the tab closed (the live store), Stop, the tab taken; else null. */
  live(): Exclude<SendsWhy, 'allowed'> | null;
  /** The page leaving its document (did-navigate, or its contents gone): the returned function stops listening. */
  onLeave(fn: () => void): () => void;
}

/** A step's sends, handed over past its call's deadline: waiting until `settle`, its one exit. */
export class HandedOver {
  private settled = false;
  /** What settle recorded, for withdraw to take back. */
  private recorded: { from: object | undefined; entry: SendsLater } | null = null;
  private readonly stopListening: () => void;

  constructor(private readonly o: HandOverOf) {
    o.memory.sendsWaiting?.add(o.nodeId);
    // The page went to another document while something's still held or a card's up: what it held was the page
    // before's (Neon's SF3: a GET navigation meanwhile too).
    this.stopListening = o.onLeave(() => {
      if (o.cards.isUp() || o.w.held().length > 0) this.settle(o.live() ?? 'moved-on');
    });
  }

  /** The cards' own end (askHeld's answer): told apart by what's live, never taken to mean allowed on its own. */
  ended(refusal: string | null): void {
    this.settle(this.whyOf(refusal));
  }

  /** The way out, once: one honest outcome for the next result; what wasn't allowed dropped; the watch ended. */
  settle(why: SendsWhy): void {
    if (this.settled) return;
    this.settled = true;
    this.stopListening();
    const { o } = this;
    if (why !== 'allowed') o.w.deny();
    o.cardsEnd.abort();
    o.w.end();
    o.memory.sendsWaiting?.delete(o.nodeId);
    this.recorded = { from: o.from, entry: sendsLater(o.tab, o.tool, o.step, why, o.allowed() > 0) };
    o.memory.later?.push(this.recorded);
  }

  /**
   * The call that handed over refused after all (the page went where it can't be read, the hold lost): its cards come
   * down, what it sent is dropped, and nothing's recorded (its answer is the refusal, never *waits*).
   */
  withdraw(): void {
    // Settled already (the page moved on while the answer was made): its entry goes, for a call that answered an error
    // (round 2 of #266, should-fix 5).
    if (this.settled) {
      const recorded = this.recorded;
      if (recorded && this.o.memory.later) this.o.memory.later = this.o.memory.later.filter((l) => l !== recorded);
      return;
    }
    this.settled = true;
    this.stopListening();
    this.o.w.deny();
    this.o.cardsEnd.abort();
    this.o.w.end();
    this.o.memory.sendsWaiting?.delete(this.o.nodeId);
  }

  private whyOf(refusal: string | null): SendsWhy {
    const live = this.o.live();
    if (live) return live;
    // The hold failed with no other reason live (the agent's session over, Keep): never *allowed* (Neon's B1).
    if (this.o.w.cancelled.aborted) return 'ended';
    if (refusal === null) return 'allowed';
    if (refusal === ACT_REFUSALS.sendsDropped) return 'no-answer';
    if (refusal === ACT_REFUSALS.stepDenied) return 'no';
    if (refusal === ACT_REFUSALS.sendsTooMany) return 'too-many';
    if (refusal === CONTROL_REFUSALS.stopped) return 'stopped';
    if (refusal === CONTROL_REFUSALS.paused || refusal === ACT_REFUSALS.takenOver) return 'took-over';
    if (refusal === CONTROL_REFUSALS.closed) return 'closed';
    if (refusal === ELEMENT_REFUSALS.stale || refusal === ACT_REFUSALS.movedOn) return 'moved-on';
    return 'unchecked';
  }
}

/** The outcomes recorded since, for a call's answer: all but those of `from` (the call answering now), taken. */
export function takeLater(memory: ToolMemory, from: object | undefined): SendsLater[] {
  if (!memory.later) return [];
  const all = memory.later;
  const mine = all.filter((l) => l.from !== from || from === undefined);
  memory.later = all.filter((l) => !mine.includes(l));
  return mine.map((l) => l.entry);
}

/** The next reply's content for those outcomes: inside the untrusted envelope (each step is the page's words). */
export function laterContent(memory: ToolMemory, from: object | undefined): { type: 'text'; text: string }[] {
  const settled = takeLater(memory, from);
  return settled.length ? [{ type: 'text', text: toolResult({ later: settled }) }] : [];
}
