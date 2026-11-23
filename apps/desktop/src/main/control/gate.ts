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
 * - **Cards**: one open card per kind, subject and tab; every call asking for it waits on that one.
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
export type CallRefusal = 'stopped' | 'paused';

/** What an answer for good covers: the kind and subject (*Allow for this chat* covers the tool, on any tab). */
const grantKey = (card: { kind: ApprovalKind; subject: string }) => `${card.kind}:${card.subject}`;
/**
 * Which card an ask waits on: the kind, subject and tab, so a card only ever answers for the tab it names. A site card
 * (M2c) is the agent's for the site, whatever its tab: two tabs of it on one site wait on one card, and one answer
 * settles both (it's for the site, and lasts the agent's life anyway). The card says what the first tab's action was;
 * every tab waiting on it has its bar say so.
 */
const openKey = (card: { kind: ApprovalKind; subject: string; tab: string | null }): string => (card.kind === 'site' ? `site:${card.subject}` : `${card.kind}:${card.subject}:${card.tab ?? ''}`);

interface OpenCard {
  id: string;
  /** The tabs waiting on it: the one it names, and (a site card) any other tab of the agent's asking the same. */
  tabs: Set<string>;
  cancel: AbortController;
  /** Asks still waiting on it. */
  askers: number;
  answer: Promise<Grant>;
}

/** The agent-wide slot, for calls that name no tab (list_tabs, searches). */
const NO_TAB = '';

export class ControlAgent {
  private readonly states_ = new Map<string, ControlState>();
  private readonly grants = new Map<string, 'always' | 'deny'>();
  /** Cards up now, one per kind, subject and tab. */
  private readonly open = new Map<string, OpenCard>();
  /** Cards answered *once* after their asks had gone: the next ask of each takes it. */
  /** Cards answered *once* after their asks had gone: the next ask of each takes it, if it's soon and for the same address. */
  private readonly late = new Map<string, { at: number; url: string; grant: 'once' | 'always' }>();
  /** Who hears when a state changes (an agent's bar). */
  private readonly listeners = new Set<() => void>();
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
    return this.states_.get(tab ?? NO_TAB) ?? (this.stopped ? { ...CONTROL_IDLE, stopped: true } : CONTROL_IDLE);
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

  /** What the user answered, kept as the gate keeps it (grantAfter): a site's yes, once its action runs (see openCard). */
  keep(kind: ApprovalKind, subject: string, grant: Grant): void {
    const keep = grantAfter(kind, grant);
    if (keep) this.grants.set(`${kind}:${subject}`, keep);
  }

  /** The user took back what they said for good about this kind and subject (a site removed in Settings): it asks again. */
  forget(kind: ApprovalKind, subject: string): void {
    this.grants.delete(`${kind}:${subject}`);
  }

  /** Hear of every change of state (calls, cards, pause, Stop); returns how to stop hearing. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every tab with a state other than idle, and the agent-wide slot's under ''. */
  states(): ReadonlyMap<string, ControlState> {
    return this.states_;
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private step(tab: string, event: ControlEvent): void {
    const next = controlStep(this.state(tab), event);
    if (!next.stopped && !next.paused && next.calls === 0 && next.cards.length === 0) this.states_.delete(tab);
    else this.states_.set(tab, next);
    this.changed();
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
    if (admits !== 'go') return refused(admits === 'wait' ? 'paused' : 'stopped');
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
   * connection) answers at once. Otherwise there's one open card per kind,
   * subject and tab (openKey): a second ask for the same thing (a retry after
   * *waiting*) waits on the card already up instead of opening another, while
   * reads of two tabs get a card each, so *once* never covers a tab the card
   * didn't name. It answers when the user does, `deny` when Stop or
   * cancelCards takes the card down or this call's `signal` aborts (the card
   * stays up for others), and `waiting` after `waitMs` (the card stays up:
   * S18's 45 s rule). A *once* given after every asker had its *waiting* is
   * kept for the next ask of that card, which takes it (once).
   */
  async ask(card: Omit<ControlCard, 'id'>, signal: AbortSignal, waitMs = Infinity): Promise<Grant | 'waiting'> {
    const remembered = this.granted(card.kind, card.subject);
    if (remembered) return remembered;
    if (signal.aborted || this.stopped) return 'deny';
    const key = openKey(card);
    const late = this.late.get(key);
    if (late) {
      this.late.delete(key);
      // Only soon after, and only for the page it was given on: a once answers for one read of what the card named.
      if (Date.now() - late.at <= CONTROL_WAIT_MS && late.url === (card.target[0] ?? '')) return late.grant;
    }
    const open = this.open.get(key) ?? this.openCard(card);
    // Another tab waiting on a card up already (a site card is the site's): its bar says it's waiting too.
    const tab = card.tab ?? NO_TAB;
    if (!open.tabs.has(tab)) {
      open.tabs.add(tab);
      this.step(tab, { t: 'ask', card: open.id });
    }
    open.askers++;
    return new Promise<Grant | 'waiting'>((resolve) => {
      let done = false;
      const finish = (answer: Grant | 'waiting') => {
        if (done) return;
        done = true;
        open.askers--;
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

  /** The card for a kind, subject and tab, shown once until it's answered or taken down. */
  private openCard(card: Omit<ControlCard, 'id'>): OpenCard {
    const id = `c${++this.lastCard}`;
    const tab = card.tab ?? NO_TAB;
    const key = openKey(card);
    const cancel = new AbortController();
    this.step(tab, { t: 'ask', card: id });
    const open: OpenCard = { id, tabs: new Set([tab]), cancel, askers: 0, answer: Promise.resolve<Grant>('deny') };
    open.answer = (async (): Promise<Grant> => {
      try {
        const grant = await this.present({ ...card, id }, cancel.signal);
        if (cancel.signal.aborted) return 'deny';
        const keep = grantAfter(card.kind, grant);
        // A yes for a site is kept by the action it was for, once it runs on that page and site (keep): the page may
        // have gone elsewhere while the card was up. A no is kept at once, whatever became of the page.
        if (keep && !(card.kind === 'site' && keep !== 'deny')) this.grants.set(grantKey(card), keep);
        // Answered after everyone asking had gone (*waiting*): the retry gets it, rather than a second card.
        // A site's *Always* too: it isn't kept until its action runs (keep), so the retry carries it, and keeps it if it runs.
        if (grant !== 'deny' && open.askers === 0) this.late.set(key, { at: Date.now(), url: card.target[0] ?? '', grant });
        return grant;
      } catch {
        return 'deny';
      } finally {
        this.open.delete(key);
        for (const waited of open.tabs) this.step(waited, { t: 'answer', card: id });
      }
    })();
    this.open.set(key, open);
    return open;
  }

  /** Take down every card waiting (each answers `deny`): the assistant's turn ended. A late *once* goes too. */
  cancelCards(): void {
    for (const { cancel } of [...this.open.values()]) cancel.abort();
    this.late.clear();
  }

  /** Whether a card for this kind, subject and tab (null: none) is up now. */
  hasOpenCard(kind: ApprovalKind, subject: string, tab: string | null = null): boolean {
    return this.open.has(openKey({ kind, subject, tab }));
  }

  /** The user said pause on a tab (they're working in it), or let it go. */
  pause(tab: string, paused: boolean): void {
    this.step(tab, { t: paused ? 'pause' : 'unpause' });
    this.wake();
  }

  /** Stop: everything in flight answers now, and nothing new runs until `resume`. */
  stop(): void {
    this.stopped = true;
    for (const key of [...this.states_.keys()]) this.step(key, { t: 'stop' });
    this.cancelCards();
    this.stopping.abort();
    this.wake();
    this.changed();
  }

  /** Let the agent continue after Stop. */
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = new AbortController();
    for (const key of [...this.states_.keys()]) this.step(key, { t: 'resume' });
    this.changed();
  }
}
