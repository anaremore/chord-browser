/**
 * The agent with a fake bridge, for agent.spec.ts: every message it would send main, recorded
 * in the page (as structured clones, as the bridge copies them).
 */
import { startAgent } from '../../src/passwords/agent/agent';

const messages: [string, unknown][] = [];
let stop: (() => void) | null = null;
/** The listener the agent registered for main's fills (the sentinel's `onFill`). */
let onFill: ((payload: unknown) => void) | null = null;

(globalThis as unknown as { chordAgentTest: unknown }).chordAgentTest = {
  start() {
    stop?.();
    onFill = null;
    stop = startAgent({
      send: (channel, payload) => void messages.push([channel, structuredClone(payload)]),
      onFill: (listener) => void (onFill ??= listener),
    });
  },
  /** A fill as main sends it, through the bridge. */
  fill: (payload: unknown) => onFill?.(structuredClone(payload)),
  messages: () => messages.slice(),
  clear: () => void (messages.length = 0),
};
