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
  STEP_LATE_MS,
  controlAdmits,
  controlKind,
  controlStep,
  grantAfter,
  type ApprovalKind,
  type RiskWhy,
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
  /** A risky step (S18 M2d): why it asks, and what goes with it (a form's fields, by label). */
  step?: {
    why: RiskWhy;
    site: string;
    fields: string[];
    more: number;
    shows?: string;
    typed?: string;
    /** A download the assistant's click started in a tab of yours (S18 M2e-2b): its file's name. */
    download?: string;
    /** What the page is sending, by site (control/sends.ts). */
    sends?: string[];
    /** Sent between actions (the tab's, not an action's: sends.ts). */
    idle?: boolean;
    /** Where the page itself is going (a script sending it to an address that deletes or signs out). */
    going?: string;
    /** Where a form or link goes, when that's another site than the page's (Neon's review 2 of #112). */
    to?: string;
  };
  /** Show me (a step card): the element outlined in its page, the card still up. */
  show?: () => void;
  /** Takes the card itself down (it answers no) when it aborts: what it asked about is gone (sends.ts: you took the tab). */
  takeDown?: AbortSignal;
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
/**
 * A risky step's card is never shared by two calls waiting at once (Neon's review of #112): one Allow runs one action,
 * however many calls ask for the same step together. A retry after *waiting* joins the card still up for that step
 * when no call waits on it any more (Neon's review of M2g-1, B1): never a second card for one step. Its late answer
 * is kept by the step (openKey).
 */
let lastStepCard = 0;
const cardKey = (card: { kind: ApprovalKind; subject: string; tab: string | null }): string => (card.kind === 'step' ? `${openKey(card)}#${++lastStepCard}` : openKey(card));

interface OpenCard {
  id: string;
  /** What it covers (the card's subject): what cancelCards may keep up. */
  subject: string;
  /** The tabs waiting on it: the one it names, and (a site card) any other tab of the agent's asking the same. */
  tabs: Set<string>;
  cancel: AbortController;
  /** Asks still waiting on it. */
  askers: number;
  /** Each tab's asks still waiting, to answer `deny` when that tab alone is let go of (cancelCardsFor). */
  waiting: Map<string, Set<(answer: Grant) => void>>;
  answer: Promise<Grant>;
}

/** The agent-wide slot, for calls that name no tab (list_tabs, searches). */
const NO_TAB = '';

export class ControlAgent {
  private readonly states_ = new Map<string, ControlState>();
  private readonly grants = new Map<string, 'always' | 'deny'>();
  /** Cards up now, one per kind, subject and tab. */
  private readonly open = new Map<string, OpenCard>();
  /** A step's card up now, by its step (openKey): a retry joins it once no call waits on it. */
  private readonly openSteps = new Map<string, OpenCard>();
  /** Cards answered *once* after their asks had gone: the next ask of each takes it. */
  /** Cards answered *once* after their asks had gone: the next ask of each takes it, if it's soon and for the same address. */
  private readonly late = new Map<string, { at: number; url: string; grant: 'once' | 'always' }>();
  /** Who hears when a state changes (an agent's bar). */
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<() => void>();
  /** How many times each tab's cards were let go of (cancelCardsFor): an ask's no after one wasn't the user's. */
  private readonly releases_ = new Map<string, number>();
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
      // Only soon after, and only for the page it was given on: a once answers for one read of what the card named.
      // A step's late Allow counts for 2 minutes, and only for that same step (its key names the tab, page, ref and action).
      // Spent when it answers; gone once it's too old; kept for its own page otherwise (Neon's review of M2g-1, B1).
      if (Date.now() - late.at > (card.kind === 'step' ? STEP_LATE_MS : CONTROL_WAIT_MS)) this.late.delete(key);
      else if (late.url === (card.target[0] ?? '')) {
        this.late.delete(key);
        return late.grant;
      }
    }
    const waitingStep = card.kind === 'step' ? this.openSteps.get(key) : undefined;
    const open = (card.kind === 'step' ? (waitingStep && waitingStep.askers === 0 && !waitingStep.cancel.signal.aborted ? waitingStep : undefined) : this.open.get(key)) ?? this.openCard(card);
    // Another tab waiting on a card up already (a site card is the site's): its bar says it's waiting too.
    const tab = card.tab ?? NO_TAB;
    if (!open.tabs.has(tab)) {
      open.tabs.add(tab);
      this.step(tab, { t: 'ask', card: open.id });
    }
    open.askers++;
    return new Promise<Grant | 'waiting'>((resolve) => {
      let done = false;
      const mine = open.waiting.get(tab) ?? new Set();
      open.waiting.set(tab, mine);
      const finish = (answer: Grant | 'waiting') => {
        if (done) return;
        done = true;
        open.askers--;
        mine.delete(finish);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      mine.add(finish);
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
    // Where it waits (a step's own), and what its late answer is kept by (the step).
    const key = cardKey(card);
    const lateKey = openKey(card);
    const cancel = new AbortController();
    card.takeDown?.addEventListener('abort', () => cancel.abort(), { once: true });
    if (card.takeDown?.aborted) cancel.abort();
    this.step(tab, { t: 'ask', card: id });
    const open: OpenCard = { id, subject: card.subject, tabs: new Set([tab]), cancel, askers: 0, waiting: new Map(), answer: Promise.resolve<Grant>('deny') };
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
        if (grant !== 'deny' && open.askers === 0) this.late.set(lateKey, { at: Date.now(), url: card.target[0] ?? '', grant });
        return grant;
      } catch {
        return 'deny';
      } finally {
        if (this.open.get(key) === open) this.open.delete(key);
        if (this.openSteps.get(lateKey) === open) this.openSteps.delete(lateKey);
        for (const waited of open.tabs) this.step(waited, { t: 'answer', card: id });
      }
    })();
    this.open.set(key, open);
    if (card.kind === 'step') this.openSteps.set(lateKey, open);
    return open;
  }

  /**
   * An action runs on this tab: a step's late Allow given there before is spent (Neon's review of M2g-1, B1). It was
   * for the retry of that step, and the page has moved on since.
   */
  dropLateSteps(tab: string): void {
    for (const key of [...this.late.keys()]) if (key.startsWith('step:') && key.endsWith(`:${tab}`)) this.late.delete(key);
  }

  /** Take down every card waiting (each answers `deny`): the assistant's turn ended. A late *once* goes too. */
  cancelCards(keep?: (subject: string) => boolean): void {
    for (const { cancel, subject } of [...this.open.values()]) if (!keep?.(subject)) cancel.abort();
    this.late.clear();
  }

  /**
   * Let go of a tab's cards (S18 M2e-1): you took the tab over, or it closed. Every ask of that tab answers `deny` now,
   * the tab stops waiting on each card, and a card no tab waits on any more comes down; a card another tab still waits
   * on (a site card is the site's) stays up for that tab alone, so its answer never runs this tab's action (Neon's B3).
   * A late step answer for the tab goes too.
   */
  cancelCardsFor(tab: string): void {
    this.releases_.set(tab, (this.releases_.get(tab) ?? 0) + 1);
    for (const open of [...this.open.values()]) {
      if (!open.tabs.has(tab)) continue;
      for (const finish of [...(open.waiting.get(tab) ?? [])]) finish('deny');
      open.waiting.delete(tab);
      open.tabs.delete(tab);
      this.step(tab, { t: 'answer', card: open.id });
      if (open.tabs.size === 0) {
        // Out of `open` now, before its answer settles: an ask meanwhile gets a card of its own, not this taken-down one.
        for (const [key, value] of this.open) if (value === open) this.open.delete(key);
        for (const [key, value] of this.openSteps) if (value === open) this.openSteps.delete(key);
        open.cancel.abort();
      }
    }
    for (const key of [...this.late.keys()]) if (!key.startsWith('site:') && key.endsWith(`:${tab}`)) this.late.delete(key);
  }

  /** The tab is gone (closed, or yours now): what was kept for it goes too (after cancelCardsFor). */
  forgetTab(tab: string): void {
    this.releases_.delete(tab);
  }

  /** How many times this tab's cards were let go of: taken before an ask, a different count after its no means the no wasn't the user's. */
  releases(tab: string): number {
    return this.releases_.get(tab) ?? 0;
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
