/**
 * The control layer's gate, its pure parts (docs/decisions/S18-agent-mcp.md
 * §5, and the M1 plan): what a tool call may do now, for each (agent, tab).
 * Both front doors go through it: the assistant (Duet), where the agent is a
 * chat, and outside agents (M1's later slices), where it's a connection. Main's
 * half, which holds the calls and shows the cards, is
 * apps/desktop/src/main/control/gate.ts.
 *
 * - **Approvals** come in four kinds: `connection` (an agent's first call),
 *   `read` (a read the scope says needs the user's yes), `site` (the first
 *   action on a site, M2) and `step` (each risky step, M2).
 * - **Grants**: the user answers a card once, always (for this agent), or
 *   deny. What's remembered depends on the kind (grantAfter).
 * - **States**, per (agent, tab): idle, working, waiting (on a card), paused
 *   (the user is typing in the agent's tab, M2) and stopped (the user pressed
 *   Stop). They're derived from a few facts (controlKind), so each event is a
 *   small change and every combination has one answer.
 */

export type ApprovalKind = 'connection' | 'read' | 'site' | 'step';
export const APPROVAL_KINDS = ['connection', 'read', 'site', 'step'] as const satisfies readonly ApprovalKind[];

export type Grant = 'once' | 'always' | 'deny';

/**
 * What a grant leaves behind for the agent's later calls: `always` for this
 * kind and subject, a lasting no (a denied connection stays denied), or
 * nothing (it counted for this call only). A risky step asks every time.
 */
export function grantAfter(kind: ApprovalKind, grant: Grant): 'always' | 'deny' | null {
  if (grant === 'once') return null;
  if (grant === 'deny') return kind === 'connection' ? 'deny' : null;
  return kind === 'step' ? null : 'always';
}

/** One (agent, tab)'s facts. The state the user sees is derived from them (controlKind). */
export interface ControlState {
  /** Stop: every call returns at once, and later ones are refused, until the user lets it continue. */
  stopped: boolean;
  /** The user is working in the tab: calls on it wait until they leave (M2). */
  paused: boolean;
  /** Tool calls under way. */
  calls: number;
  /** Cards waiting for an answer, oldest first: the card queue. */
  cards: readonly string[];
}

export type ControlStateKind = 'idle' | 'working' | 'waiting' | 'paused' | 'stopped';

export const CONTROL_IDLE: ControlState = { stopped: false, paused: false, calls: 0, cards: [] };

/** What the user sees, most telling first: stopped, then paused, then a card waiting, then calls under way. */
export function controlKind(state: ControlState): ControlStateKind {
  if (state.stopped) return 'stopped';
  if (state.paused) return 'paused';
  if (state.cards.length > 0) return 'waiting';
  return state.calls > 0 ? 'working' : 'idle';
}

export type ControlEvent =
  | { t: 'call' }
  | { t: 'done' }
  | { t: 'ask'; card: string }
  | { t: 'answer'; card: string }
  | { t: 'pause' }
  | { t: 'unpause' }
  | { t: 'stop' }
  | { t: 'resume' };

/**
 * One event's change. A call or a card on a stopped agent changes nothing:
 * the gate refuses it before it starts (controlAdmits). Stop drops every card
 * waiting (their calls answer at once); a call that ends after Stop still
 * counts down.
 */
export function controlStep(state: ControlState, event: ControlEvent): ControlState {
  switch (event.t) {
    case 'call':
      return state.stopped ? state : { ...state, calls: state.calls + 1 };
    case 'done':
      return { ...state, calls: Math.max(0, state.calls - 1) };
    case 'ask':
      return state.stopped || state.cards.includes(event.card) ? state : { ...state, cards: [...state.cards, event.card] };
    case 'answer':
      return state.cards.includes(event.card) ? { ...state, cards: state.cards.filter((c) => c !== event.card) } : state;
    case 'pause':
      return state.stopped ? state : { ...state, paused: true };
    case 'unpause':
      return { ...state, paused: false };
    case 'stop':
      return { ...state, stopped: true, paused: false, cards: [] };
    case 'resume':
      return { ...state, stopped: false };
  }
}

/** Whether a new call may start: go, wait (paused), or be refused (stopped). */
export function controlAdmits(state: ControlState): 'go' | 'wait' | 'stopped' {
  if (state.stopped) return 'stopped';
  return state.paused ? 'wait' : 'go';
}

/**
 * How long a call waits on a card or a pause before it answers *waiting*
 * (the card stays up), so a client's own tool timeout never fires (Codex's is 60 s).
 */
export const CONTROL_WAIT_MS = 45_000;

/**
 * What a refused call tells the model: one sentence, as a normal result with
 * `isError`, so it tells the user instead of retrying (S18 §5).
 */
export const CONTROL_REFUSALS = {
  waiting: 'Waiting for the user to allow this in Chord. Ask them to answer the card at the top of the Chord window, then call this tool again.',
  denied: 'The user denied this connection in Chord. Stop using Chord’s tools and tell the user.',
  stopped: 'The user stopped you in Chord. Don’t call Chord’s tools again until the user asks you to.',
  notOpen: 'Chord isn’t open. Ask the user to open Chord, then call this tool again.',
  closed: 'That tab is closed. Use list_tabs for the tabs there are now.',
} as const;
export type ControlRefusal = keyof typeof CONTROL_REFUSALS;
