/**
 * The agent with a fake bridge, for agent.spec.ts: every message it would send main, recorded
 * in the page (as structured clones, as the bridge copies them).
 */
import { startAgents, type AgentsStop } from '../../src/passwords/agent/frames';

const messages: [string, unknown][] = [];
let stop: AgentsStop | null = null;
/** The listener the agent registered for main's fills (the sentinel's `onFill`). */
let onFill: ((payload: unknown) => void) | null = null;

(globalThis as unknown as { chordAgentTest: unknown }).chordAgentTest = {
  start() {
    stop?.();
    onFill = null;
    stop = startAgents({
      send: (channel, payload) => void messages.push([channel, structuredClone(payload)]),
      onFill: (listener) => void (onFill ??= listener),
      // The sentinel's sandbox record (sandbox-recorder.ts, where a spec installed it): without it, no frame is used.
      ...(typeof (globalThis as { chordVouched?: unknown }).chordVouched === 'function'
        ? { vouched: (el: Element) => (globalThis as unknown as { chordVouched: (el: Element) => boolean }).chordVouched(el) }
        : {}),
    });
  },
  /** A fill as main sends it, through the bridge. */
  fill: (payload: unknown) => onFill?.(structuredClone(payload)),
  messages: () => messages.slice(),
  clear: () => void (messages.length = 0),
  /** What the frames' hub holds: agents, forms reports, fill listeners and form owners (phase 3C). */
  frames: () => stop?.stats() ?? null,
};
