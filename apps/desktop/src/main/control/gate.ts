/**
 * The gate, main's half (S18 M1a; the pure rules are core's control-gate.ts).
 * One ControlAgent per agent: a chat for the assistant, a connection for an
 * outside agent. Every tool call goes through `call`, every approval through
 * `ask`; the front door only shows the cards (its CardPresenter).
 *
 * - **Stop** (`stop`): calls in flight answer at once with the stopped
 *   refusal, cards waiting are taken down, and new calls are refused until
 *   `resume`. A call's own work may finish later; its answer is no longer
 *   waited for, and it adds nothing to what the user sees (`signal`).
 * - **Grants** stay with the agent object, so they last as long as it does.
 * - **Cards**: one open card per kind and subject; every call asking for it waits on that one.
 * - **Pause** (M2) holds a tab's new calls until the user leaves the tab, at
 *   most CONTROL_WAIT_MS.
 */
import {
  CONTROL_IDLE,
  CONTROL_WAIT_MS,
  controlAdmits,
  controlKind,
  controlStep,
  grantAfter,
  type ApprovalKind,
  type ControlEvent,
  type ControlState,
  type ControlStateKind,
  type Grant,
} from '@chord/core';

/** A card for the user: what the agent wants to do, and what the answer covers. */
export interface ControlCard {
  /** The gate's own id for it, unique in the agent. */
  id: string;
  kind: ApprovalKind;
  /** The tool asking. */
  tool: string;
  /** What it will do, in the user's words (*Read “Article”*). */
  description: string;
  /** Addresses it concerns. */
  target: string[];
  /** The tab it's about, or null (a connection, a list of tabs). */
  tab: string | null;
  /** What an `always` covers, with the kind: the tool for a read, the site for an action. */
  subject: string;
}

/** Shows a card and resolves with the answer; resolves `deny` when its signal aborts (Stop, the turn ending). */
export type CardPresenter = (card: ControlCard, signal: AbortSignal) => Promise<Grant>;

/** Why a call didn't run. */
export type CallRefusal = 'stopped' | 'waiting';

const cardKey = (card: { kind: ApprovalKind; subject: string }) => `${card.kind}:${card.subject}`;

/** The agent-wide slot, for calls that name no tab (list_tabs, searches). */
const NO_TAB = '';

export class ControlAgent {
  private readonly states = new Map<string, ControlState>();
  private readonly grants = new Map<string, 'always' | 'deny'>();
  /** Cards up now, one per kind and subject. */
  private readonly open = new Map<string, { cancel: AbortController; answer: Promise<Grant> }>();
  private readonly waiters = new Set<() => void>();
  private stopping = new AbortController();
  private stopped = false;
  private lastCard = 0;

  constructor(
    readonly id: string,
    private readonly present: CardPresenter,
  ) {}

  /** A tab's state (null: the agent-wide slot). */
  state(tab: string | null): ControlState {
    return this.states.get(tab ?? NO_TAB) ?? (this.stopped ? { ...CONTROL_IDLE, stopped: true } : CONTROL_IDLE);
  }

  kind(tab: string | null): ControlStateKind {
    return controlKind(this.state(tab));
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** What the user said for good about this kind and subject, if anything. */
  granted(kind: ApprovalKind, subject: string): 'always' | 'deny' | undefined {
    return this.grants.get(`${kind}:${subject}`);
  }

  private step(tab: string, event: ControlEvent): void {
    const next = controlStep(this.state(tab), event);
    if (!next.stopped && !next.paused && next.calls === 0 && next.cards.length === 0) this.states.delete(tab);
    else this.states.set(tab, next);
  }

  /**
   * One tool call on a tab (null: none). Refused at once while stopped; held
   * while the tab is paused; answers `refused('stopped')` the moment Stop is
   * pressed, whatever `run` is still doing.
   */
  async call<T>(tab: string | null, run: (signal: AbortSignal) => Promise<T>, refused: (why: CallRefusal) => T): Promise<T> {
    const key = tab ?? NO_TAB;
    let admits = controlAdmits(this.state(key));
    if (admits === 'wait') admits = await this.unpaused(key);
    if (admits !== 'go') return refused(admits === 'wait' ? 'waiting' : 'stopped');
    const signal = this.stopping.signal;
    this.step(key, { t: 'call' });
    try {
      return await new Promise<T>((resolve, reject) => {
        const onStop = () => resolve(refused('stopped'));
        signal.addEventListener('abort', onStop, { once: true });
        run(signal)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onStop));
      });
    } finally {
      this.step(key, { t: 'done' });
    }
  }

  /** Waits out a pause: go once the user leaves the tab, stopped on Stop, still waiting after CONTROL_WAIT_MS. */
  private unpaused(key: string): Promise<'go' | 'wait' | 'stopped'> {
    return new Promise((resolve) => {
      const check = () => {
        const now = controlAdmits(this.state(key));
        if (now === 'wait') return;
        finish(now);
      };
      const finish = (result: 'go' | 'wait' | 'stopped') => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(result);
      };
      const timer = setTimeout(() => finish('wait'), CONTROL_WAIT_MS);
      timer.unref?.();
      this.waiters.add(check);
    });
  }

  private wake(): void {
    for (const check of [...this.waiters]) check();
  }

  /**
   * Ask the user. An answer given for good before (`always`, a denied
   * connection) answers at once. Otherwise there's one open card per kind and
   * subject: a second ask for the same thing (two reads at once, or a retry
   * after *waiting*) waits on the card already up instead of opening another.
   * It answers when the user does, `deny` when Stop or cancelCards takes the
   * card down or this call's `signal` aborts (the card stays up for others),
   * and `waiting` after `waitMs` (the card stays up: S18's 45 s rule).
   */
  async ask(card: Omit<ControlCard, 'id'>, signal: AbortSignal, waitMs = Infinity): Promise<Grant | 'waiting'> {
    const remembered = this.granted(card.kind, card.subject);
    if (remembered) return remembered;
    if (signal.aborted || this.stopped) return 'deny';
    const open = this.open.get(cardKey(card)) ?? this.openCard(card);
    return new Promise<Grant | 'waiting'>((resolve) => {
      const finish = (answer: Grant | 'waiting') => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = () => finish('deny');
      const timer = Number.isFinite(waitMs) ? setTimeout(() => finish('waiting'), waitMs) : undefined;
      timer?.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      void open.answer.then(finish);
    });
  }

  /** The card for a kind and subject, shown once until it's answered or taken down. */
  private openCard(card: Omit<ControlCard, 'id'>): { cancel: AbortController; answer: Promise<Grant> } {
    const id = `c${++this.lastCard}`;
    const key = card.tab ?? NO_TAB;
    const subject = cardKey(card);
    const cancel = new AbortController();
    this.step(key, { t: 'ask', card: id });
    const answer = (async (): Promise<Grant> => {
      try {
        const grant = await this.present({ ...card, id }, cancel.signal);
        if (cancel.signal.aborted) return 'deny';
        const keep = grantAfter(card.kind, grant);
        if (keep) this.grants.set(subject, keep);
        return grant;
      } catch {
        return 'deny';
      } finally {
        this.open.delete(subject);
        this.step(key, { t: 'answer', card: id });
      }
    })();
    const open = { cancel, answer };
    this.open.set(subject, open);
    return open;
  }

  /** Take down every card waiting (each answers `deny`): the assistant's turn ended. */
  cancelCards(): void {
    for (const { cancel } of [...this.open.values()]) cancel.abort();
  }

  /** Whether a card for this kind and subject is up now. */
  hasOpenCard(kind: ApprovalKind, subject: string): boolean {
    return this.open.has(`${kind}:${subject}`);
  }

  /** The user said pause on a tab (they're working in it), or let it go. */
  pause(tab: string, paused: boolean): void {
    this.step(tab, { t: paused ? 'pause' : 'unpause' });
    this.wake();
  }

  /** Stop: everything in flight answers now, and nothing new runs until `resume`. */
  stop(): void {
    this.stopped = true;
    for (const key of [...this.states.keys()]) this.step(key, { t: 'stop' });
    this.cancelCards();
    this.stopping.abort();
    this.wake();
  }

  /** Let the agent continue after Stop. */
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = new AbortController();
    for (const key of [...this.states.keys()]) this.step(key, { t: 'resume' });
  }
}
